/* ===========================================================================
 * packages/domain equivalent — every number the business argues about is
 * computed HERE and nowhere else. Pure functions, no I/O, no DB.
 *
 * This is what stops the classic ERP disease of "the dashboard says ₹42.30
 * and the report says ₹42.28".
 * ======================================================================== */

export const round = (n: number, dp = 4) =>
  Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

export const money = (n: number) => round(n, 4);
export const rate = (n: number) => round(n, 6);
export const qty = (n: number) => round(n, 3);
export const pct = (n: number) => round(n, 4);

/* ---------------------------------------------------------------------------
 * §5 — Recommended purchase quantity.
 *
 *   need   = demand over (lead time + review period) + safety stock
 *   cover  = available + in-transit + already-open PO qty
 *   suggest= max(0, need − cover), lifted to MOQ and rounded to order multiple
 *
 * Safety stock uses a service-level z against demand variability, which is
 * what actually prevents the 6 a.m. stock-out, not a flat "minimum stock".
 * ------------------------------------------------------------------------ */
export type PlanningInput = {
  currentStock: number;
  reservedQty?: number;
  inTransitQty?: number;
  openPoQty?: number;
  avgDailySale: number;
  demandStdDev?: number;
  leadTimeDays: number;
  reviewPeriodDays?: number;
  safetyStockDays?: number;
  serviceLevelZ?: number;
  minStock?: number | null;
  maxStock?: number | null;
  /**
   * The level the buyer said to reorder at. Passed in since the buy list was
   * written and never declared here, so TypeScript dropped it and the planner
   * never saw it: a product with a reorder point of 150 and nothing on the
   * shelf suggested buying zero, because it had no sales history to forecast
   * from. A reorder point is not a forecast — it is an instruction.
   */
  reorderPoint?: number | null;
  moq?: number | null;
  orderMultiple?: number | null;
  wastagePct?: number;
  advanceOrderQty?: number;
};

export type PlanningResult = {
  availableStock: number;
  coverQty: number;
  demandQty: number;
  safetyStock: number;
  requiredQty: number;
  suggestedQty: number;
  daysOfCover: number;
  reasons: { code: string; label: string; value: string }[];
};

/** What a buy suggestion rounds up to when the product does not say otherwise. */
export const DEFAULT_ORDER_STEP = 5;

export function recommendedQty(i: PlanningInput): PlanningResult {
  const reserved = i.reservedQty ?? 0;
  const inTransit = i.inTransitQty ?? 0;
  const openPo = i.openPoQty ?? 0;
  const review = i.reviewPeriodDays ?? 1;
  const z = i.serviceLevelZ ?? 1.65;
  const wastage = (i.wastagePct ?? 0) / 100;
  const advance = i.advanceOrderQty ?? 0;

  const available = qty(Math.max(0, i.currentStock - reserved));
  const cover = qty(available + inTransit + openPo);

  const horizon = i.leadTimeDays + review;
  const baseDemand = i.avgDailySale * horizon;

  // Safety stock: statistical if we have variability, else the configured days.
  const sigma = i.demandStdDev ?? i.avgDailySale * 0.35;
  const statSafety = z * sigma * Math.sqrt(Math.max(horizon, 1));
  const daysSafety = i.avgDailySale * (i.safetyStockDays ?? 1);
  const safety = qty(Math.max(statSafety, daysSafety));

  // Perishables shrink between receipt and sale — buy the gross, not the net.
  const grossed = (baseDemand + advance) / Math.max(1 - wastage, 0.5);

  let required = qty(grossed + safety);
  if (i.minStock && required + cover < i.minStock) required = qty(i.minStock - cover + grossed);

  /* The buyer's own floor. Demand forecasting answers "how much will sell";
   * this answers "how little am I willing to have on the shelf", and for a
   * product that has never sold — a new breed, a seasonal line — it is the
   * only signal there is. */
  if (i.reorderPoint && cover <= Number(i.reorderPoint)) {
    required = qty(Math.max(required, Number(i.reorderPoint)));
  }

  let suggested = Math.max(0, qty(required - cover));

  // Never overshoot max stock (§5) — a full chiller is also a loss.
  if (i.maxStock && cover + suggested > i.maxStock) {
    suggested = Math.max(0, qty(i.maxStock - cover));
  }
  if (i.moq && suggested > 0 && suggested < i.moq) suggested = i.moq;

  /* Nobody buys 12.4 crates. The arithmetic above is honest about demand and
   * wastage and lands on a fraction; a buyer standing in a mandi rounds it up.
   * A product may set its own multiple — a pallet of 24, a bag of 50 — and
   * that wins. Everything else rounds up to the next 5, which is what the
   * buyers were doing on paper anyway.
   *
   * Always UP: buying one crate short of a day's demand costs a sale, buying
   * one over costs a little cash for a day. */
  const step = i.orderMultiple && i.orderMultiple > 0 ? i.orderMultiple : DEFAULT_ORDER_STEP;
  if (suggested > 0) {
    suggested = qty(Math.ceil(suggested / step) * step);
    /* Rounding up must not walk through the ceiling that exists two lines
     * above. If the rounded figure no longer fits, take one step back; if that
     * leaves nothing, keep the single step — the product is on the buy list
     * because it needs something, and answering "buy 0" would be a worse lie
     * than being a few over. */
    if (i.maxStock && cover + suggested > i.maxStock) {
      const down = qty(suggested - step);
      if (down > 0) suggested = down;
    }
  }

  const daysOfCover = i.avgDailySale > 0 ? round(cover / i.avgDailySale, 1) : 999;

  const reasons: PlanningResult['reasons'] = [
    { code: 'DEMAND', label: `Demand for ${horizon} day(s) at ${qty(i.avgDailySale)}/day`, value: `${qty(baseDemand)}` },
    { code: 'SAFETY', label: 'Safety stock buffer', value: `${safety}` },
    { code: 'COVER', label: 'Already covered (stock + in-transit + open PO)', value: `${cover}` },
  ];
  if (wastage > 0) reasons.push({ code: 'WASTAGE', label: `Grossed up for ${round(wastage * 100, 2)}% expected wastage`, value: `${qty(grossed - baseDemand - advance)}` });
  if (advance > 0) reasons.push({ code: 'ADVANCE', label: 'Advance customer orders', value: `${advance}` });
  if (daysOfCover < i.leadTimeDays) reasons.push({ code: 'RISK', label: 'Cover is below lead time — stock-out risk', value: `${daysOfCover} days` });
  if (i.reorderPoint && cover <= Number(i.reorderPoint)) {
    reasons.push({ code: 'REORDER', label: 'At or below the reorder point you set', value: `${i.reorderPoint}` });
  }

  return {
    availableStock: available, coverQty: cover, demandQty: qty(baseDemand),
    safetyStock: safety, requiredQty: required, suggestedQty: suggested,
    daysOfCover, reasons,
  };
}

/* ---------------------------------------------------------------------------
 * §11 — Weight variance and its colour band.
 * ------------------------------------------------------------------------ */
export type VarianceBand = 'GREEN' | 'AMBER' | 'RED' | 'CRITICAL';

export function weightVariance(expectedKg: number | null, actualKg: number, tolerancePct: number) {
  if (!expectedKg || expectedKg <= 0) {
    return { varianceKg: 0, variancePct: 0, band: 'GREEN' as VarianceBand, breached: false };
  }
  const varianceKg = round(actualKg - expectedKg, 3);
  const variancePct = pct((varianceKg / expectedKg) * 100);
  const abs = Math.abs(variancePct);
  const band: VarianceBand =
    abs <= tolerancePct ? 'GREEN'
    : abs <= tolerancePct * 2 ? 'AMBER'
    : abs <= tolerancePct * 4 ? 'RED'
    : 'CRITICAL';
  return { varianceKg, variancePct, band, breached: abs > tolerancePct };
}

/** Net weight from a two-weighment cycle, minus container and packing tare. */
export function netWeight(input: {
  grossKg?: number | null;
  tareKg?: number | null;
  containerCount?: number | null;
  containerTareKg?: number | null;
  packingTareKg?: number | null;
}) {
  const gross = input.grossKg ?? 0;
  const vehicleTare = input.tareKg ?? 0;
  const containers = (input.containerCount ?? 0) * (input.containerTareKg ?? 0);
  const packing = input.packingTareKg ?? 0;
  return round(Math.max(0, gross - vehicleTare - containers - packing), 3);
}

/* ---------------------------------------------------------------------------
 * §12 / §13.4 — QC scoring and disposition.
 *
 * Weighted score across parameters; any critical failure forces REJECT/HOLD
 * regardless of the score. Thresholds come from the template's scoring_rule.
 * ------------------------------------------------------------------------ */
export type QcParam = {
  code: string;
  label: string;
  paramType: 'NUMERIC' | 'BOOLEAN' | 'SELECT' | 'PERCENT' | 'COUNT' | 'PHOTO' | 'TEXT';
  minOk: number | null;
  maxOk: number | null;
  options: { value: string; label: string; score: number }[] | null;
  isCritical: boolean;
  weight: number;
};
export type QcAnswer = {
  code: string;
  valueNum?: number | null;
  valueBool?: boolean | null;
  valueText?: string | null;
};
export type QcScoring = { accept_min: number; downgrade_min: number; partial_min: number };

export function scoreQc(params: QcParam[], answers: QcAnswer[], scoring: QcScoring) {
  const byCode = new Map(answers.map((a) => [a.code, a]));
  let totalWeight = 0;
  let earned = 0;
  const criticalFailures: string[] = [];
  const perParam: { code: string; score: number; pass: boolean; critical: boolean }[] = [];

  for (const p of params) {
    const a = byCode.get(p.code);
    if (!a) continue;
    let score = 100;

    if (p.paramType === 'BOOLEAN') {
      // Boolean parameters in this library are all "is the bad thing present?"
      score = a.valueBool ? 0 : 100;
    } else if (p.paramType === 'SELECT') {
      const opt = p.options?.find((o) => o.value === a.valueText);
      score = opt?.score ?? 50;
    } else if (a.valueNum !== null && a.valueNum !== undefined) {
      const v = a.valueNum;
      const min = p.minOk;
      const max = p.maxOk;
      if (min !== null && v < min) {
        const shortfall = (min - v) / Math.max(Math.abs(min), 1);
        score = Math.max(0, 100 - shortfall * 200);
      } else if (max !== null && v > max) {
        const excess = (v - max) / Math.max(Math.abs(max), 1);
        score = Math.max(0, 100 - excess * 200);
      }
    }

    const pass = score >= 50;
    if (p.isCritical && !pass) criticalFailures.push(p.code);
    totalWeight += p.weight;
    earned += score * p.weight;
    perParam.push({ code: p.code, score: round(score, 2), pass, critical: p.isCritical });
  }

  const qualityScore = totalWeight > 0 ? round(earned / totalWeight, 2) : 0;

  let result: 'ACCEPT' | 'PARTIAL' | 'REJECT' | 'HOLD';
  if (criticalFailures.length > 0) result = 'HOLD';
  else if (qualityScore >= scoring.accept_min) result = 'ACCEPT';
  else if (qualityScore >= scoring.downgrade_min) result = 'ACCEPT';
  else if (qualityScore >= scoring.partial_min) result = 'PARTIAL';
  else result = 'REJECT';

  const grade =
    qualityScore >= scoring.accept_min ? 'A'
    : qualityScore >= scoring.downgrade_min ? 'B'
    : qualityScore >= scoring.partial_min ? 'C' : 'REJECT';

  return { qualityScore, result, grade, criticalFailures, perParam };
}

/** §13.2 — how many units to actually inspect. */
export function sampleSize(
  lotQty: number,
  rule: { mode: string; min_units: number; new_supplier_multiplier?: number; high_rejection_multiplier?: number },
  flags: { newSupplier?: boolean; highRejection?: boolean } = {},
) {
  let n = rule.mode === 'SQRT' ? Math.ceil(Math.sqrt(lotQty)) : Math.ceil(lotQty * 0.05);
  n = Math.max(n, rule.min_units ?? 5);
  if (flags.newSupplier) n *= rule.new_supplier_multiplier ?? 2;
  if (flags.highRejection) n *= rule.high_rejection_multiplier ?? 2;
  return Math.min(Math.ceil(n), Math.ceil(lotQty));
}

/* ---------------------------------------------------------------------------
 * §16 — Landing cost engine.
 *
 *   landed = base − discount + allocated charges + non-creditable tax
 *            + wastage provision
 *
 * Charges allocate by VALUE / WEIGHT / QTY / EQUAL. Transport by weight and
 * commission by value is not a detail — allocate transport by value and a
 * heavy cheap crate of potatoes subsidises a light expensive box of mangoes.
 * ------------------------------------------------------------------------ */
export type CostLine = {
  grnLineId: string;
  productId: string;
  batchId?: string | null;
  acceptedQty: number;
  acceptedWeightKg: number;
  baseRate: number;
  wastagePct: number;
  nonCreditableTax?: number;
  prevLandedRatePerKg?: number | null;
};
export type Charge = {
  code: string;
  amount: number;
  basis: 'VALUE' | 'WEIGHT' | 'QTY' | 'EQUAL' | 'MANUAL';
  isCreditable: boolean;
  affectsLandingCost: boolean;
  manualSplit?: Record<string, number>;
};

export function computeLandingCost(lines: CostLine[], charges: Charge[], discountTotal = 0) {
  const baseValues = lines.map((l) => money(l.acceptedQty * l.baseRate));
  const totalValue = money(baseValues.reduce((a, b) => a + b, 0));
  const totalWeight = round(lines.reduce((a, l) => a + l.acceptedWeightKg, 0), 3);
  const totalQty = qty(lines.reduce((a, l) => a + l.acceptedQty, 0));
  const n = lines.length || 1;

  const allocated: Record<string, number>[] = lines.map(() => ({}));

  for (const c of charges) {
    if (!c.affectsLandingCost || c.isCreditable) continue;
    lines.forEach((l, idx) => {
      let share = 0;
      switch (c.basis) {
        case 'VALUE': share = totalValue > 0 ? baseValues[idx] / totalValue : 1 / n; break;
        case 'WEIGHT': share = totalWeight > 0 ? l.acceptedWeightKg / totalWeight : 1 / n; break;
        case 'QTY': share = totalQty > 0 ? l.acceptedQty / totalQty : 1 / n; break;
        case 'EQUAL': share = 1 / n; break;
        case 'MANUAL': share = (c.manualSplit?.[l.grnLineId] ?? 0) / Math.max(c.amount, 1); break;
      }
      allocated[idx][c.code] = money((allocated[idx][c.code] ?? 0) + c.amount * share);
    });
  }

  const discountShare = lines.map((_, idx) =>
    money(discountTotal * (totalValue > 0 ? baseValues[idx] / totalValue : 1 / n)));

  const out = lines.map((l, idx) => {
    const baseValue = baseValues[idx];
    const allocTotal = money(Object.values(allocated[idx]).reduce((a, b) => a + b, 0));
    const nonCredTax = money(l.nonCreditableTax ?? 0);
    const preWastage = money(baseValue - discountShare[idx] + allocTotal + nonCredTax);
    const wastageAmount = money(preWastage * (l.wastagePct / 100));
    const landedValue = money(preWastage + wastageAmount);
    const landedRatePerUom = l.acceptedQty > 0 ? rate(landedValue / l.acceptedQty) : 0;
    const landedRatePerKg = l.acceptedWeightKg > 0 ? rate(landedValue / l.acceptedWeightKg) : landedRatePerUom;
    const prev = l.prevLandedRatePerKg ?? null;
    const rateChangePct = prev && prev > 0 ? pct(((landedRatePerKg - prev) / prev) * 100) : null;

    return {
      grnLineId: l.grnLineId, productId: l.productId, batchId: l.batchId ?? null,
      acceptedQty: l.acceptedQty, acceptedWeightKg: l.acceptedWeightKg,
      baseRate: l.baseRate, baseValue,
      allocatedCharges: allocated[idx], allocatedTotal: allocTotal,
      nonCreditableTax: nonCredTax, wastagePct: l.wastagePct, wastageAmount,
      landedValue, landedRatePerUom, landedRatePerKg,
      prevLandedRatePerKg: prev, rateChangePct,
    };
  });

  const totals = {
    baseAmount: totalValue,
    discountAmount: money(discountTotal),
    totalCharges: money(out.reduce((a, l) => a + l.allocatedTotal, 0)),
    nonCreditableTax: money(out.reduce((a, l) => a + l.nonCreditableTax, 0)),
    wastageProvision: money(out.reduce((a, l) => a + l.wastageAmount, 0)),
    totalLanded: money(out.reduce((a, l) => a + l.landedValue, 0)),
  };

  return { lines: out, totals };
}

/* ---------------------------------------------------------------------------
 * §7 — Landed rate for a quote, so source comparison is not rate-only.
 * ------------------------------------------------------------------------ */
export function quoteLandedRate(q: {
  quotedRate: number;
  charges?: { commission?: number; transport?: number; loading?: number; packing?: number };
  expectedRejectionPct?: number;
  expectedShortagePct?: number;
  paymentTermsDays?: number;
  costOfCapitalPctPa?: number;
  qtyKg?: number;
}) {
  const qtyKg = q.qtyKg && q.qtyKg > 0 ? q.qtyKg : 1;
  const c = q.charges ?? {};
  const perKgCharges =
    ((c.commission ?? 0) + (c.transport ?? 0) + (c.loading ?? 0) + (c.packing ?? 0)) / qtyKg;

  const gross = q.quotedRate + perKgCharges;
  const lossFactor = 1 - ((q.expectedRejectionPct ?? 0) + (q.expectedShortagePct ?? 0)) / 100;
  const afterLoss = gross / Math.max(lossFactor, 0.5);

  // Credit is worth money: 15-day terms at 12% p.a. is ~0.5% off the rate.
  const capital = (q.costOfCapitalPctPa ?? 12) / 100;
  const creditBenefit = afterLoss * capital * ((q.paymentTermsDays ?? 0) / 365);

  return {
    landedRate: rate(afterLoss - creditBenefit),
    breakdown: {
      base: rate(q.quotedRate),
      charges: rate(perKgCharges),
      lossUplift: rate(afterLoss - gross),
      creditBenefit: rate(-creditBenefit),
    },
  };
}

/* ---------------------------------------------------------------------------
 * §7 / §24 — Supplier trust & performance scores.
 * ------------------------------------------------------------------------ */
export function supplierScore(m: {
  onTimePct: number;
  fillRatePct: number;
  rejectionPct: number;
  weightVariancePct: number;
  docCompliancePct: number;
  qualityScoreAvg: number;
  orderCount: number;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const performance = round(
    clamp(m.onTimePct) * 0.25 +
    clamp(m.fillRatePct) * 0.20 +
    clamp(100 - m.rejectionPct * 4) * 0.25 +
    clamp(m.qualityScoreAvg) * 0.30, 2);

  const trust = round(
    clamp(100 - Math.abs(m.weightVariancePct) * 10) * 0.40 +
    clamp(m.docCompliancePct) * 0.25 +
    clamp(100 - m.rejectionPct * 3) * 0.20 +
    clamp(performance) * 0.15, 2);

  // Thin history should not read as a great supplier.
  const confidence = Math.min(1, m.orderCount / 10);
  return {
    performanceScore: round(performance * confidence + 50 * (1 - confidence), 2),
    trustScore: round(trust * confidence + 50 * (1 - confidence), 2),
    confidence: round(confidence, 2),
  };
}

/* ---------------------------------------------------------------------------
 * §17 — 3-way match. PO says the rate, GRN says the quantity, invoice says
 * the total. Anything outside tolerance goes to hold, never to payable.
 * ------------------------------------------------------------------------ */
export type MatchLine = {
  lineNo: number;
  description: string;
  invoiceQty: number; invoiceRate: number; invoiceAmount: number; invoiceTax: number;
  grnQty: number | null; poRate: number | null;
};
export type Tolerance = {
  qtyTolPct: number; rateTolPct: number; taxTolAbs: number; chargeTolPct: number;
  criticalQtyPct: number; criticalRatePct: number;
};

export function threeWayMatch(lines: MatchLine[], tol: Tolerance, invoiceChargeTotal = 0, poChargeTotal = 0) {
  const findings: { lineNo: number; field: string; severity: 'WARN' | 'FAIL'; message: string; expected: number | null; actual: number }[] = [];
  let qtyResult: 'OK' | 'WARN' | 'FAIL' = 'OK';
  let rateResult: 'OK' | 'WARN' | 'FAIL' = 'OK';
  let taxResult: 'OK' | 'WARN' | 'FAIL' = 'OK';
  let chargeResult: 'OK' | 'WARN' | 'FAIL' = 'OK';
  let maxQtyVar = 0, maxRateVar = 0;

  const escalate = (cur: 'OK' | 'WARN' | 'FAIL', next: 'WARN' | 'FAIL') =>
    cur === 'FAIL' ? 'FAIL' : next;

  for (const l of lines) {
    if (l.grnQty === null) {
      qtyResult = 'FAIL';
      findings.push({ lineNo: l.lineNo, field: 'qty', severity: 'FAIL',
        message: 'Invoice line has no matching goods receipt', expected: null, actual: l.invoiceQty });
      continue;
    }
    const qtyVarPct = l.grnQty > 0 ? Math.abs((l.invoiceQty - l.grnQty) / l.grnQty) * 100 : 100;
    maxQtyVar = Math.max(maxQtyVar, qtyVarPct);
    if (qtyVarPct > tol.criticalQtyPct) {
      qtyResult = 'FAIL';
      findings.push({ lineNo: l.lineNo, field: 'qty', severity: 'FAIL',
        message: `Billed quantity is ${round(qtyVarPct, 2)}% away from what was received`,
        expected: l.grnQty, actual: l.invoiceQty });
    } else if (qtyVarPct > tol.qtyTolPct) {
      qtyResult = escalate(qtyResult, 'WARN');
      findings.push({ lineNo: l.lineNo, field: 'qty', severity: 'WARN',
        message: `Billed quantity differs by ${round(qtyVarPct, 2)}%`,
        expected: l.grnQty, actual: l.invoiceQty });
    }

    if (l.poRate !== null && l.poRate > 0) {
      const rateVarPct = Math.abs((l.invoiceRate - l.poRate) / l.poRate) * 100;
      maxRateVar = Math.max(maxRateVar, rateVarPct);
      if (rateVarPct > tol.criticalRatePct) {
        rateResult = 'FAIL';
        findings.push({ lineNo: l.lineNo, field: 'rate', severity: 'FAIL',
          message: `Billed rate is ${round(rateVarPct, 2)}% above/below the agreed PO rate`,
          expected: l.poRate, actual: l.invoiceRate });
      } else if (rateVarPct > tol.rateTolPct) {
        rateResult = escalate(rateResult, 'WARN');
        findings.push({ lineNo: l.lineNo, field: 'rate', severity: 'WARN',
          message: `Billed rate differs by ${round(rateVarPct, 2)}%`,
          expected: l.poRate, actual: l.invoiceRate });
      }
    }

    const arithmetic = money(l.invoiceQty * l.invoiceRate);
    if (Math.abs(arithmetic - l.invoiceAmount) > tol.taxTolAbs) {
      taxResult = 'FAIL';
      findings.push({ lineNo: l.lineNo, field: 'arithmetic', severity: 'FAIL',
        message: 'Line amount does not equal quantity × rate on the invoice itself',
        expected: arithmetic, actual: l.invoiceAmount });
    }
  }

  if (poChargeTotal > 0) {
    const chargeVar = Math.abs((invoiceChargeTotal - poChargeTotal) / poChargeTotal) * 100;
    if (chargeVar > tol.chargeTolPct) {
      chargeResult = 'WARN';
      findings.push({ lineNo: 0, field: 'charges', severity: 'WARN',
        message: `Charges differ from the PO by ${round(chargeVar, 2)}%`,
        expected: poChargeTotal, actual: invoiceChargeTotal });
    }
  }

  const anyFail = [qtyResult, rateResult, taxResult, chargeResult].includes('FAIL');
  const anyWarn = [qtyResult, rateResult, taxResult, chargeResult].includes('WARN');
  const overall: 'MATCH' | 'MISMATCH' | 'CRITICAL_MISMATCH' =
    anyFail ? 'CRITICAL_MISMATCH' : anyWarn ? 'MISMATCH' : 'MATCH';

  return {
    overall, qtyResult, rateResult, taxResult, chargeResult,
    qtyVariance: round(maxQtyVar, 3), rateVariancePct: pct(maxRateVar), findings,
  };
}

/* ---------------------------------------------------------------------------
 * §27 — State machines. Illegal transitions are rejected before they reach
 * the database, with a message the user can act on.
 * ------------------------------------------------------------------------ */
export const TRANSITIONS = {
  REQUIREMENT: {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
    APPROVED: ['CONVERTED', 'CLOSED', 'CANCELLED'],
    CONVERTED: ['CLOSED'],
    CLOSED: [], CANCELLED: [],
  },
  PO: {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
    APPROVED: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['PART_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'],
    PART_RECEIVED: ['PART_RECEIVED', 'RECEIVED', 'CLOSED'],
    RECEIVED: ['CLOSED'],
    CLOSED: [], CANCELLED: [],
  },
  GATE: {
    ARRIVED: ['WEIGHED', 'QC_PENDING', 'REJECTED_AT_GATE', 'CANCELLED'],
    WEIGHED: ['QC_PENDING', 'CANCELLED'],
    QC_PENDING: ['QC_COMPLETE', 'CANCELLED'],
    QC_COMPLETE: ['GRN_PENDING', 'COMPLETED'],
    GRN_PENDING: ['COMPLETED'],
    COMPLETED: [], REJECTED_AT_GATE: [], CANCELLED: [],
  },
  GRN: {
    DRAFT: ['SUBMITTED'],
    SUBMITTED: ['POSTED', 'DRAFT'],
    POSTED: ['AMENDED', 'REVERSED'],
    AMENDED: [], REVERSED: [],
  },
  INVOICE: {
    PENDING: ['MATCHED', 'MISMATCH', 'HOLD', 'CANCELLED'],
    MATCHED: ['APPROVED', 'HOLD'],
    MISMATCH: ['HOLD', 'APPROVED', 'CANCELLED'],
    HOLD: ['APPROVED', 'MISMATCH', 'CANCELLED'],
    APPROVED: ['PAYABLE'],
    PAYABLE: ['PART_PAID', 'PAID'],
    PART_PAID: ['PAID'],
    PAID: [], CANCELLED: [],
  },
} as const;

/**
 * Named so the HTTP layer can recognise it without this file importing from
 * platform/ — the domain stays pure, but an illegal transition still reaches
 * the user as the sentence written here rather than as a generic 500.
 */
export class TransitionError extends Error {
  name = 'TransitionError';
  constructor(message: string, public machine: string, public from: string, public to: string) {
    super(message);
  }
}

export function assertTransition(
  machine: keyof typeof TRANSITIONS, from: string, to: string,
): void {
  const allowed = (TRANSITIONS[machine] as Record<string, readonly string[]>)[from];
  if (!allowed) {
    throw new TransitionError(`Unknown ${machine} status "${from}"`, machine, from, to);
  }
  if (!allowed.includes(to)) {
    throw new TransitionError(
      `A ${machine.toLowerCase()} in "${from}" cannot move to "${to}". Allowed: ${allowed.join(', ') || 'nothing — it is final'}.`,
      machine, from, to,
    );
  }
}
