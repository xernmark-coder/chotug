import type { Actor, Tx } from '../db.js';
import { askJson, aiEnabled } from './provider.js';
import { round, recommendedQty, type PlanningInput } from '../domain/index.js';

/* ===========================================================================
 * Every AI feature follows the same contract:
 *   1. compute a STATISTICAL answer that is always available
 *   2. optionally ask an LLM to refine / explain it
 *   3. persist an ai_runs row with model, confidence, reason and fallback flag
 *   4. return advisory output — never a committed business record
 * ======================================================================== */

async function logRun(
  tx: Tx, actor: Actor,
  r: {
    featureKey: string; branchId?: string | null; entityType?: string; entityId?: string | null;
    inputRef: any; output: any; reason: any; confidence: number;
    modelName: string; latencyMs: number; usedFallback: boolean; fallbackReason?: string;
  },
): Promise<string> {
  const hash = Buffer.from(JSON.stringify(r.inputRef)).toString('base64').slice(0, 60);
  const { rows } = await tx.query(
    `INSERT INTO ai_runs (company_id, branch_id, feature_key, model_name, model_version,
                          entity_type, entity_id, input_hash, input_ref, output, reason,
                          confidence, latency_ms, used_fallback, fallback_reason)
     VALUES ($1,$2,$3,$4,'1.0',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      actor.companyId, r.branchId ?? null, r.featureKey, r.modelName,
      r.entityType ?? null, r.entityId ?? null, hash,
      JSON.stringify(r.inputRef), JSON.stringify(r.output), JSON.stringify(r.reason),
      r.confidence, r.latencyMs, r.usedFallback, r.fallbackReason ?? null,
    ],
  );
  return rows[0].id as string;
}

async function featureEnabled(tx: Tx, actor: Actor, key: string) {
  const { rows } = await tx.query(
    `SELECT is_enabled, min_confidence FROM ai_feature_flags
      WHERE company_id = $1 AND feature_key = $2`,
    [actor.companyId, key],
  );
  return { enabled: rows[0]?.is_enabled ?? true, minConfidence: rows[0]?.min_confidence ?? 0.6 };
}

/* ===========================================================================
 * F1 — Demand forecast.
 *
 * Statistical core: seasonal-naive + damped trend on the last 8 weeks of
 * demand_signals, with day-of-week seasonality. This is the StatsForecast
 * baseline the blueprint recommends, implemented directly so the system has
 * no Python dependency for the thing it needs every single morning.
 * ======================================================================== */
export type ForecastPoint = { date: string; p50: number; p10: number; p90: number };

export async function forecastDemand(
  tx: Tx, actor: Actor,
  args: { branchId: string; productId: string; horizonDays?: number },
): Promise<{ points: ForecastPoint[]; avgDaily: number; stdDev: number; model: string; history: { date: string; qty: number }[] }> {
  const horizon = args.horizonDays ?? 7;
  const { rows: hist } = await tx.query(
    `SELECT signal_date::text AS date, SUM(qty) AS qty
       FROM demand_signals
      WHERE company_id = $1 AND branch_id = $2 AND product_id = $3
        AND signal_type IN ('SALE','ADVANCE_ORDER','BRANCH_INDENT')
        AND signal_date >= CURRENT_DATE - 56
      GROUP BY signal_date ORDER BY signal_date`,
    [actor.companyId, args.branchId, args.productId],
  );

  const series = hist.map((h: any) => ({ date: h.date as string, qty: Number(h.qty) }));
  const values = series.map((s) => s.qty);

  if (values.length === 0) {
    return { points: [], avgDaily: 0, stdDev: 0, model: 'no-history', history: [] };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(values.length - 1, 1);
  const stdDev = Math.sqrt(variance);

  // Day-of-week index — weekend vegetable demand is a different animal.
  const dow: number[][] = Array.from({ length: 7 }, () => []);
  for (const s of series) dow[new Date(s.date + 'T00:00:00Z').getUTCDay()].push(s.qty);
  const dowFactor = dow.map((arr) => {
    if (arr.length === 0 || mean === 0) return 1;
    return (arr.reduce((a, b) => a + b, 0) / arr.length) / mean;
  });

  // Damped trend from the last 14 days versus the 14 before that.
  const recent = values.slice(-14);
  const prior = values.slice(-28, -14);
  const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : mean;
  const priorMean = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : recentMean;
  const trendPerDay = prior.length ? ((recentMean - priorMean) / 14) * 0.5 : 0;

  const points: ForecastPoint[] = [];
  for (let d = 1; d <= horizon; d++) {
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + d);
    const factor = dowFactor[target.getUTCDay()] || 1;
    const p50 = Math.max(0, round((recentMean + trendPerDay * d) * factor, 3));
    const spread = stdDev * Math.sqrt(d) * 0.8;
    points.push({
      date: target.toISOString().slice(0, 10),
      p50,
      p10: Math.max(0, round(p50 - 1.28 * spread, 3)),
      p90: round(p50 + 1.28 * spread, 3),
    });
  }

  return {
    points, avgDaily: round(recentMean, 3), stdDev: round(stdDev, 3),
    model: 'seasonal-naive+damped-trend', history: series.slice(-28),
  };
}

/* ===========================================================================
 * F2 — Buy suggestion. Statistics decide the NUMBER; the LLM only writes the
 * explanation and flags risk. If the LLM disagrees by more than 25% we keep
 * the statistical number and record the disagreement.
 * ======================================================================== */
export async function buySuggestion(
  tx: Tx, actor: Actor,
  args: {
    branchId: string; productId: string; productName: string;
    planning: PlanningInput; marketNote?: string;
  },
): Promise<{
  aiRunId: string; suggestedQty: number; confidence: number;
  reasons: { code: string; label: string; value: string }[];
  narrative: string | null; risk: string | null; usedFallback: boolean;
}> {
  const flag = await featureEnabled(tx, actor, 'F2_BUY_SUGGESTION');
  const stat = recommendedQty(args.planning);

  let narrative: string | null = null;
  let risk: string | null = null;
  let confidence = 0.72;
  let model = 'rules';
  let latency = 0;
  let usedFallback = true;
  let fallbackReason: string | undefined = 'ai_disabled';

  if (flag.enabled && aiEnabled()) {
    const res = await askJson<{ narrative: string; risk: string | null; confidence: number; adjusted_qty?: number }>({
      system:
        'You are a purchase planner for an Indian fresh fruit and vegetable retailer. ' +
        'You explain buying decisions in plain, short business English a shopkeeper understands. ' +
        'You never invent numbers that were not given to you.',
      user:
        `Product: ${args.productName}\n` +
        `Current stock: ${args.planning.currentStock}\n` +
        `Average daily sale: ${args.planning.avgDailySale}\n` +
        `Lead time (days): ${args.planning.leadTimeDays}\n` +
        `In transit: ${args.planning.inTransitQty ?? 0}, Open PO: ${args.planning.openPoQty ?? 0}\n` +
        `Expected wastage: ${args.planning.wastagePct ?? 0}%\n` +
        `Statistical recommendation: ${stat.suggestedQty}\n` +
        `Days of cover right now: ${stat.daysOfCover}\n` +
        (args.marketNote ? `Market note: ${args.marketNote}\n` : '') +
        `Write a two-sentence explanation of why this quantity, and name the single biggest risk.`,
      shape: '{"narrative": string, "risk": string|null, "confidence": number between 0 and 1, "adjusted_qty": number|null}',
      maxTokens: 350,
    });
    model = res.model; latency = res.latencyMs; usedFallback = res.usedFallback;
    fallbackReason = res.fallbackReason;
    if (res.ok && res.data) {
      narrative = res.data.narrative ?? null;
      risk = res.data.risk ?? null;
      confidence = Math.min(0.95, Math.max(0.3, Number(res.data.confidence) || 0.7));
      const adj = Number(res.data.adjusted_qty);
      if (adj && stat.suggestedQty > 0 && Math.abs(adj - stat.suggestedQty) / stat.suggestedQty > 0.25) {
        risk = `${risk ?? ''} (Model suggested ${round(adj, 2)}; statistical figure kept.)`.trim();
        confidence = Math.min(confidence, 0.55);
      }
    }
  }

  const aiRunId = await logRun(tx, actor, {
    featureKey: 'F2_BUY_SUGGESTION', branchId: args.branchId,
    entityType: 'product', entityId: args.productId,
    inputRef: { planning: args.planning },
    output: { suggestedQty: stat.suggestedQty, daysOfCover: stat.daysOfCover, narrative, risk },
    reason: stat.reasons, confidence, modelName: model, latencyMs: latency,
    usedFallback, fallbackReason,
  });

  return {
    aiRunId, suggestedQty: stat.suggestedQty, confidence,
    reasons: stat.reasons, narrative, risk, usedFallback,
  };
}

/* ===========================================================================
 * F5 — QC photo assist. A vision model pre-fills the parameter values; the
 * inspector still confirms every one. inspector_changed on qc_results is the
 * training signal that tells you whether the model is actually any good.
 * ======================================================================== */
export async function qcPhotoAssist(
  tx: Tx, actor: Actor,
  args: {
    inspectionRef?: string; branchId: string; productName: string;
    parameters: { code: string; label: string; paramType: string; unit?: string | null; options?: any }[];
    images: { mediaType: string; base64: string }[];
  },
): Promise<{
  aiRunId: string; usedFallback: boolean; confidence: number;
  suggestions: { code: string; value: number | boolean | string | null; confidence: number; note?: string }[];
  grade: string | null; score: number | null;
}> {
  const flag = await featureEnabled(tx, actor, 'F5_QC_ASSIST');
  const paramSpec = args.parameters
    .map((p) => `- ${p.code} (${p.paramType}${p.unit ? `, ${p.unit}` : ''}): ${p.label}` +
      (p.options ? ` options=${JSON.stringify((p.options as any[]).map((o) => o.value))}` : ''))
    .join('\n');

  let suggestions: any[] = [];
  let grade: string | null = null;
  let score: number | null = null;
  let confidence = 0;
  let model = 'rules'; let latency = 0; let usedFallback = true;
  let fallbackReason: string | undefined = 'ai_disabled';

  if (flag.enabled && aiEnabled() && args.images.length > 0) {
    const res = await askJson<{ parameters: any[]; overall_grade: string; overall_score: number; confidence: number }>({
      system:
        'You are a produce quality inspector. You look at photographs of a delivered lot of ' +
        'fruit or vegetables and estimate quality parameters. You are conservative: when the ' +
        'photo is unclear you return null and a low confidence rather than guessing.',
      user:
        `Commodity: ${args.productName}\nEstimate these parameters from the photos:\n${paramSpec}\n\n` +
        'For PERCENT parameters give a number 0-100. For BOOLEAN give true/false. ' +
        'For SELECT give one of the listed option values. For NUMERIC give a number.',
      shape:
        '{"parameters":[{"code":string,"value":number|boolean|string|null,"confidence":number,"note":string|null}],' +
        '"overall_grade":"A"|"B"|"C"|"REJECT","overall_score":number,"confidence":number}',
      images: args.images.slice(0, 4),
      maxTokens: 800,
    });
    model = res.model; latency = res.latencyMs; usedFallback = res.usedFallback;
    fallbackReason = res.fallbackReason;
    if (res.ok && res.data) {
      suggestions = (res.data.parameters ?? []).filter((p: any) =>
        args.parameters.some((q) => q.code === p.code));
      grade = res.data.overall_grade ?? null;
      score = Number(res.data.overall_score) || null;
      confidence = Math.min(0.95, Math.max(0, Number(res.data.confidence) || 0));
    }
  }

  // Below the configured confidence floor the suggestion is shown but never
  // pre-selected — §14.6, an unreliable grade must not become the default.
  const trustworthy = confidence >= (flag.minConfidence ?? 0.7);

  const aiRunId = await logRun(tx, actor, {
    featureKey: 'F5_QC_ASSIST', branchId: args.branchId,
    entityType: 'qc_inspection', entityId: null,
    inputRef: { product: args.productName, imageCount: args.images.length },
    output: { suggestions, grade, score, trustworthy },
    reason: { note: trustworthy ? 'Above confidence floor' : 'Below confidence floor — advisory only' },
    confidence, modelName: model, latencyMs: latency, usedFallback, fallbackReason,
  });

  return { aiRunId, usedFallback, confidence, suggestions, grade: trustworthy ? grade : null, score };
}

/* ===========================================================================
 * F4 — Price signal. Linear regression on recent mandi modal prices gives the
 * trend; the LLM turns it into a buy-now / wait recommendation with a reason.
 * ======================================================================== */
export async function priceSignal(
  tx: Tx, actor: Actor,
  args: { productId: string; productName: string; branchId: string },
) {
  const { rows } = await tx.query(
    `SELECT price_date::text AS date, modal_price, arrival_qty
       FROM market_prices
      WHERE (company_id = $1 OR company_id IS NULL) AND product_id = $2
        AND price_date >= CURRENT_DATE - 30
      ORDER BY price_date`,
    [actor.companyId, args.productId],
  );

  if (rows.length < 3) {
    return { trend: 'UNKNOWN' as const, slopePerDay: 0, latest: null, recommendation: null,
      confidence: 0, aiRunId: null, points: [] };
  }

  const pts = rows.map((r: any, i: number) => ({ x: i, y: Number(r.modal_price), date: r.date, arrivals: Number(r.arrival_qty ?? 0) }));
  const n = pts.length;
  const sumX = pts.reduce((a, p) => a + p.x, 0);
  const sumY = pts.reduce((a, p) => a + p.y, 0);
  const sumXY = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = pts.reduce((a, p) => a + p.x * p.x, 0);
  const slope = (n * sumXY - sumX * sumY) / Math.max(n * sumXX - sumX * sumX, 1e-9);
  const meanY = sumY / n;
  const changePct = meanY > 0 ? (slope * 7 / meanY) * 100 : 0;

  const trend = changePct > 3 ? 'RISING' : changePct < -3 ? 'FALLING' : 'STABLE';
  const latest = pts[pts.length - 1];

  let recommendation: string | null =
    trend === 'RISING' ? 'Prices are climbing — buying earlier and larger is likely cheaper.'
    : trend === 'FALLING' ? 'Prices are easing — buy only what you need now and revisit in 2-3 days.'
    : 'Prices are steady — buy to your normal plan.';
  let confidence = 0.6;
  let model = 'linear-regression'; let latency = 0; let usedFallback = true;
  let fallbackReason: string | undefined = 'ai_disabled';

  if (aiEnabled()) {
    const res = await askJson<{ recommendation: string; confidence: number }>({
      system: 'You advise an Indian fresh produce buyer on mandi price timing. Be concise and practical.',
      user:
        `Commodity: ${args.productName}\nLatest modal price: ₹${latest.y}/unit on ${latest.date}\n` +
        `7-day trend: ${round(changePct, 2)}%\nRecent arrivals: ${latest.arrivals}\n` +
        `Give one sentence of buying advice.`,
      shape: '{"recommendation": string, "confidence": number}',
      maxTokens: 200,
    });
    model = res.model; latency = res.latencyMs; usedFallback = res.usedFallback;
    fallbackReason = res.fallbackReason;
    if (res.ok && res.data?.recommendation) {
      recommendation = res.data.recommendation;
      confidence = Math.min(0.9, Math.max(0.3, Number(res.data.confidence) || 0.6));
    }
  }

  const aiRunId = await logRun(tx, actor, {
    featureKey: 'F4_PRICE_SIGNAL', branchId: args.branchId,
    entityType: 'product', entityId: args.productId,
    inputRef: { points: pts.length },
    output: { trend, changePct: round(changePct, 3), latest: latest.y, recommendation },
    reason: { slopePerDay: round(slope, 4), sampleDays: n },
    confidence, modelName: model, latencyMs: latency, usedFallback, fallbackReason,
  });

  return {
    trend, slopePerDay: round(slope, 4), latest: latest.y, changePct: round(changePct, 2),
    recommendation, confidence, aiRunId,
    points: pts.map((p) => ({ date: p.date, price: p.y })),
  };
}

/* ===========================================================================
 * F8 — Anomaly detection. Robust z-score (median + MAD) so one crazy mandi
 * day does not desensitise the detector the way a mean would.
 * ======================================================================== */
export function robustAnomaly(series: number[], value: number) {
  if (series.length < 4) return { isAnomaly: false, z: 0, median: value, mad: 0 };
  const sorted = [...series].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = series.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] || 1e-6;
  const z = (0.6745 * (value - median)) / mad;
  return { isAnomaly: Math.abs(z) > 3.5, z: round(z, 3), median: round(median, 4), mad: round(mad, 4) };
}

/* ===========================================================================
 * F9 — Purchase assistant. Answers questions using ONLY the context rows the
 * caller retrieved under the user's own permissions, so the assistant can
 * never leak a cost figure to someone without data.cost.view.
 * ======================================================================== */
export async function assistantAnswer(
  tx: Tx, actor: Actor,
  args: { question: string; context: Record<string, unknown>; branchId?: string | null },
) {
  if (!aiEnabled()) {
    return {
      answer:
        'The AI assistant is switched off in this deployment. Set AI_PROVIDER and AI_API_KEY ' +
        'in the server environment to enable it. All dashboards and reports work without it.',
      usedFallback: true, aiRunId: null, confidence: 0,
    };
  }
  const res = await askJson<{ answer: string; confidence: number }>({
    system:
      'You are the purchase assistant inside an ERP. Answer ONLY from the JSON context given. ' +
      'If the context does not contain the answer, say so and name the screen where the user ' +
      'would find it. Never invent figures. Keep it under 80 words.',
    user: `Question: ${args.question}\n\nContext:\n${JSON.stringify(args.context).slice(0, 6000)}`,
    shape: '{"answer": string, "confidence": number}',
    maxTokens: 400,
  });

  const aiRunId = await logRun(tx, actor, {
    featureKey: 'F9_ASSISTANT', branchId: args.branchId ?? null,
    inputRef: { question: args.question },
    output: { answer: res.data?.answer ?? null },
    reason: {}, confidence: res.data?.confidence ?? 0,
    modelName: res.model, latencyMs: res.latencyMs,
    usedFallback: res.usedFallback, fallbackReason: res.fallbackReason,
  });

  return {
    answer: res.data?.answer ?? 'I could not reach the model just now. Please try again.',
    usedFallback: res.usedFallback, aiRunId, confidence: res.data?.confidence ?? 0,
  };
}
