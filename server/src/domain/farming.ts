/* ===========================================================================
 * packages/domain — FARMING.
 *
 * Same rule as domain/index.ts: every number the farm argues about is computed
 * HERE and nowhere else. Pure functions, no I/O, no DB, no clock of their own —
 * `today` is always passed in, so a test can stand on any date it likes.
 *
 * The design constraint the whole module is built around: the person standing
 * in the field types CROP, AREA, ACTUAL WEIGHT, a PROBLEM and the odd BILL.
 * Everything below is the "everything else" the system owes him in return.
 * ======================================================================== */

import { round, qty, money, pct } from './index.js';

export type Colour = 'GREEN' | 'YELLOW' | 'RED';

/* --------------------------------------------------------------- dates ---- */

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/* ---------------------------------------------------------------------------
 * §2 — CROP START. Four answers in, a whole plan out.
 *
 * The staff member picks crop, plot, area and sowing date. Harvest date, crop
 * duration, expected production, the water/fertiliser/inspection schedule and
 * the expected cost are all derived — none of them is ever asked for.
 * ------------------------------------------------------------------------ */
export type CropMaster = {
  code: string;
  name: string;
  nameHi?: string | null;
  durationDays: number;
  harvestWindowDays: number;
  yieldPerAcreKg: number;
  seedCostPerAcre: number;
  inputCostPerAcre: number;
  irrigationIntervalDays: number;
  irrigationIntervalDaysHot?: number | null;
  inspectionIntervalDays: number;
  fertilizerSchedule: { day: number; label: string; input?: string; qtyPerAcre?: number; uom?: string }[];
  spraySchedule: { day: number; label: string }[];
};

export type PlannedTask = {
  taskType: 'IRRIGATION' | 'FERTILIZER' | 'SPRAY' | 'INSPECTION' | 'WEEDING' | 'HARVEST' | 'MACHINE' | 'OTHER';
  title: string;
  dayNumber: number;
  dueDate: string;
  inputName?: string | null;
  plannedQty?: number | null;
  inputUom?: string | null;
  requiresQty: boolean;
};

export type CropPlan = {
  durationDays: number;
  expectedHarvestDate: string;
  expectedHarvestEndDate: string;
  expectedYieldKg: number;
  estimatedCost: number;
  estimatedCostPerKg: number;
  tasks: PlannedTask[];
};

/**
 * The whole calendar is generated ONCE, at sowing, and stored. Generating it
 * lazily every morning would mean a task nobody can see until the day it is
 * due, and an owner who cannot plan labour a week ahead.
 */
export function planCrop(input: {
  crop: CropMaster;
  areaAcre: number;
  sowingDate: string;
  /** A previous cycle's real yield on this crop beats the master estimate. */
  historicalYieldPerAcreKg?: number | null;
}): CropPlan {
  const c = input.crop;
  const area = Math.max(input.areaAcre, 0);

  const yieldPerAcre = input.historicalYieldPerAcreKg && input.historicalYieldPerAcreKg > 0
    // Blend, don't replace: one bad monsoon should not rewrite the agronomy.
    ? c.yieldPerAcreKg * 0.4 + input.historicalYieldPerAcreKg * 0.6
    : c.yieldPerAcreKg;

  const expectedHarvestDate = addDays(input.sowingDate, c.durationDays);
  const expectedHarvestEndDate = addDays(expectedHarvestDate, Math.max(c.harvestWindowDays - 1, 0));
  const expectedYieldKg = qty(yieldPerAcre * area);
  const estimatedCost = money((c.seedCostPerAcre + c.inputCostPerAcre) * area);

  const tasks: PlannedTask[] = [];
  const push = (t: PlannedTask) => {
    if (t.dayNumber < 0) return;
    tasks.push(t);
  };

  // Irrigation — a fixed cadence from sowing to the end of picking. The daily
  // weather pass (see irrigationDecision) is what stops it watering in rain.
  const irrigationEnd = c.durationDays + c.harvestWindowDays;
  for (let day = c.irrigationIntervalDays; day <= irrigationEnd; day += c.irrigationIntervalDays) {
    push({
      taskType: 'IRRIGATION',
      title: 'Irrigation',
      dayNumber: day,
      dueDate: addDays(input.sowingDate, day),
      requiresQty: false,
    });
  }

  for (const f of c.fertilizerSchedule ?? []) {
    push({
      taskType: 'FERTILIZER',
      title: f.label,
      dayNumber: f.day,
      dueDate: addDays(input.sowingDate, f.day),
      inputName: f.input ?? null,
      // §8 — quantity is the one thing the system cannot know, so it is asked
      // for. Date, staff, farm and plot are attached without being asked.
      plannedQty: f.qtyPerAcre != null ? qty(f.qtyPerAcre * area) : null,
      inputUom: f.uom ?? 'KG',
      requiresQty: true,
    });
  }

  for (const s of c.spraySchedule ?? []) {
    push({
      taskType: 'SPRAY',
      title: s.label,
      dayNumber: s.day,
      dueDate: addDays(input.sowingDate, s.day),
      requiresQty: false,
    });
  }

  for (let day = c.inspectionIntervalDays; day < c.durationDays; day += c.inspectionIntervalDays) {
    push({
      taskType: 'INSPECTION',
      title: 'Crop health check',
      dayNumber: day,
      dueDate: addDays(input.sowingDate, day),
      requiresQty: false,
    });
  }

  // The harvest itself is a task, so it appears on FARM TODAY like everything
  // else rather than depending on somebody remembering the date.
  push({
    taskType: 'HARVEST',
    title: `Harvest ${c.name}`,
    dayNumber: c.durationDays,
    dueDate: expectedHarvestDate,
    requiresQty: false,
  });

  tasks.sort((a, b) => a.dayNumber - b.dayNumber || a.taskType.localeCompare(b.taskType));

  return {
    durationDays: c.durationDays,
    expectedHarvestDate,
    expectedHarvestEndDate,
    expectedYieldKg,
    estimatedCost,
    estimatedCostPerKg: expectedYieldKg > 0 ? round(estimatedCost / expectedYieldKg, 2) : 0,
    tasks,
  };
}

/* ---------------------------------------------------------------------------
 * §7 / §9 — IRRIGATION AND WEATHER.
 *
 * Nobody should have to remember when to water, and nobody should water into
 * a rainstorm. The decision reads crop type, crop age, last irrigation and the
 * weather, and returns one of three words.
 * ------------------------------------------------------------------------ */
export type Weather = {
  date: string;
  tempMinC?: number | null;
  tempMaxC?: number | null;
  rainMm?: number | null;
  rainProbPct?: number | null;
  windKmph?: number | null;
  humidityPct?: number | null;
  condition?: string | null;
};

export type WeatherThresholds = {
  rainHoldMm: number;
  rainHoldProbPct: number;
  sprayWindKmph: number;
  heatAlertC: number;
  frostAlertC: number;
};

export const DEFAULT_WEATHER_THRESHOLDS: WeatherThresholds = {
  rainHoldMm: 5,
  rainHoldProbPct: 60,
  sprayWindKmph: 20,
  heatAlertC: 38,
  frostAlertC: 6,
};

export function irrigationDecision(input: {
  crop: Pick<CropMaster, 'irrigationIntervalDays' | 'irrigationIntervalDaysHot'>;
  cropAgeDays: number;
  lastIrrigationDate: string | null;
  today: string;
  weather?: Weather | null;
  thresholds?: WeatherThresholds;
}): { action: 'WATER_TODAY' | 'HOLD' | 'NOT_DUE'; reason: string; reasonHi: string; dueInDays: number } {
  const th = input.thresholds ?? DEFAULT_WEATHER_THRESHOLDS;
  const w = input.weather;
  const hot = (w?.tempMaxC ?? 0) >= th.heatAlertC;
  const interval = hot && input.crop.irrigationIntervalDaysHot
    ? input.crop.irrigationIntervalDaysHot
    : input.crop.irrigationIntervalDays;

  const sinceLast = input.lastIrrigationDate
    ? daysBetween(input.lastIrrigationDate, input.today)
    : input.cropAgeDays;
  const dueInDays = interval - sinceLast;

  const rainComing = (w?.rainMm ?? 0) >= th.rainHoldMm
    || (w?.rainProbPct ?? 0) >= th.rainHoldProbPct;

  if (rainComing) {
    return {
      action: 'HOLD',
      reason: `Rain expected (${w?.rainMm ?? 0} mm, ${w?.rainProbPct ?? 0}% chance) — hold irrigation`,
      reasonHi: 'बारिश आने वाली है — सिंचाई रोकें',
      dueInDays,
    };
  }
  if (dueInDays <= 0) {
    return {
      action: 'WATER_TODAY',
      reason: hot
        ? `${sinceLast} day(s) since last watering and it is hot (${w?.tempMaxC}°C) — water today`
        : `${sinceLast} day(s) since last watering — water today`,
      reasonHi: 'आज पानी देना है',
      dueInDays,
    };
  }
  return {
    action: 'NOT_DUE',
    reason: `Watered ${sinceLast} day(s) ago — next in ${dueInDays} day(s)`,
    reasonHi: `अभी पानी की जरूरत नहीं — ${dueInDays} दिन बाद`,
    dueInDays,
  };
}

export type WeatherAdvice = {
  code: 'RAIN_HOLD_IRRIGATION' | 'WIND_AVOID_SPRAY' | 'HEAT_WATER_CHECK' | 'FROST_INSPECT' | 'RAIN_HARVEST_RISK';
  colour: Colour;
  message: string;
  messageHi: string;
};

/** §9 — the alerts that mean staff do not have to open a weather app. */
export function weatherAdvice(w: Weather | null | undefined, th = DEFAULT_WEATHER_THRESHOLDS): WeatherAdvice[] {
  if (!w) return [];
  const out: WeatherAdvice[] = [];

  if ((w.rainMm ?? 0) >= th.rainHoldMm || (w.rainProbPct ?? 0) >= th.rainHoldProbPct) {
    out.push({
      code: 'RAIN_HOLD_IRRIGATION', colour: 'YELLOW',
      message: 'Rain is expected — hold irrigation today',
      messageHi: 'बारिश आने वाली है — सिंचाई रोकें',
    });
    out.push({
      code: 'RAIN_HARVEST_RISK', colour: 'YELLOW',
      message: 'Wet produce loses weight and grade — harvest before the rain or wait it out',
      messageHi: 'गीली फसल का ग्रेड गिरता है — बारिश से पहले तुड़ाई करें',
    });
  }
  if ((w.windKmph ?? 0) >= th.sprayWindKmph) {
    out.push({
      code: 'WIND_AVOID_SPRAY', colour: 'YELLOW',
      message: `Wind is ${w.windKmph} km/h — spray will drift, avoid it today`,
      messageHi: 'तेज हवा — आज स्प्रे न करें',
    });
  }
  if ((w.tempMaxC ?? 0) >= th.heatAlertC) {
    out.push({
      code: 'HEAT_WATER_CHECK', colour: 'RED',
      message: `Heat risk at ${w.tempMaxC}°C — check water and irrigate early morning or evening`,
      messageHi: 'गर्मी का खतरा — पानी की जाँच करें',
    });
  }
  if (w.tempMinC != null && w.tempMinC <= th.frostAlertC) {
    out.push({
      code: 'FROST_INSPECT', colour: 'RED',
      message: `Cold/frost risk at ${w.tempMinC}°C — inspect the crop this morning`,
      messageHi: 'पाला पड़ने का खतरा — फसल की जाँच करें',
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * §5 — THREE COLOURS. The owner should never have to read a report to know
 * whether the farm is fine.
 * ------------------------------------------------------------------------ */
export function taskColour(t: { dueDate: string; status: string; taskType?: string }, today: string): Colour {
  if (t.status === 'PROBLEM') return 'RED';
  if (t.status !== 'PENDING') return 'GREEN';
  const late = daysBetween(t.dueDate, today);
  if (late >= 2) return 'RED';
  if (late >= 0) return 'YELLOW';
  return 'GREEN';
}

export const worstColour = (colours: Colour[]): Colour =>
  colours.includes('RED') ? 'RED' : colours.includes('YELLOW') ? 'YELLOW' : 'GREEN';

/**
 * A crop's colour is not an opinion — it is the worst of what is actually
 * wrong: an overdue job, an unresolved problem, a bad health check, or a
 * harvest window that has slipped.
 */
export function cropHealthColour(input: {
  overdueTasks: number;
  openProblems: number;
  lastObservation?: Colour | null;
  harvest: HarvestReadiness;
}): { colour: Colour; reasons: string[] } {
  const reasons: string[] = [];
  const colours: Colour[] = ['GREEN'];

  if (input.openProblems > 0) {
    colours.push('RED');
    reasons.push(`${input.openProblems} unresolved problem${input.openProblems === 1 ? '' : 's'}`);
  }
  if (input.overdueTasks >= 3) {
    colours.push('RED');
    reasons.push(`${input.overdueTasks} tasks overdue`);
  } else if (input.overdueTasks > 0) {
    colours.push('YELLOW');
    reasons.push(`${input.overdueTasks} task${input.overdueTasks === 1 ? '' : 's'} overdue`);
  }
  if (input.lastObservation && input.lastObservation !== 'GREEN') {
    colours.push(input.lastObservation);
    reasons.push(`Last crop check was ${input.lastObservation.toLowerCase()}`);
  }
  if (input.harvest.band !== 'GREEN' && input.harvest.code === 'DELAYED') {
    colours.push('RED');
    reasons.push(input.harvest.label);
  }
  if (!reasons.length) reasons.push('Nothing overdue, no open problems');
  return { colour: worstColour(colours), reasons };
}

/* ---------------------------------------------------------------------------
 * §12 — HARVEST READY. Amber three days out, green on the day, red if the
 * window has been missed — because a missed window is money on the ground.
 * ------------------------------------------------------------------------ */
export type HarvestReadiness = {
  code: 'GROWING' | 'SOON' | 'READY' | 'DELAYED' | 'DONE';
  band: Colour;
  label: string;
  labelHi: string;
  daysToHarvest: number;
};

export function harvestReadiness(input: {
  status: string;
  expectedHarvestDate: string;
  expectedHarvestEndDate: string;
  today: string;
  harvestedKg: number;
  expectedYieldKg: number;
  alertDays?: number;
  graceDays?: number;
}): HarvestReadiness {
  const alertDays = input.alertDays ?? 3;
  const graceDays = input.graceDays ?? 2;
  const daysToHarvest = daysBetween(input.today, input.expectedHarvestDate);
  const pastWindow = daysBetween(input.expectedHarvestEndDate, input.today);

  if (input.status === 'CLOSED' || input.status === 'FAILED') {
    return { code: 'DONE', band: 'GREEN', label: 'Crop closed', labelHi: 'फसल पूरी', daysToHarvest };
  }
  // "Enough has come off the field" — the window is allowed to close quietly.
  if (input.expectedYieldKg > 0 && input.harvestedKg >= input.expectedYieldKg * 0.95) {
    return { code: 'DONE', band: 'GREEN', label: 'Harvest complete', labelHi: 'तुड़ाई पूरी', daysToHarvest };
  }
  if (pastWindow > graceDays) {
    return {
      code: 'DELAYED', band: 'RED',
      label: `Harvest delayed by ${pastWindow} day(s)`,
      labelHi: `तुड़ाई ${pastWindow} दिन देर से`,
      daysToHarvest,
    };
  }
  if (daysToHarvest <= 0) {
    return { code: 'READY', band: 'GREEN', label: 'Ready to harvest', labelHi: 'तुड़ाई के लिए तैयार', daysToHarvest };
  }
  if (daysToHarvest <= alertDays) {
    return {
      code: 'SOON', band: 'YELLOW',
      label: `Harvest in ${daysToHarvest} day(s)`,
      labelHi: `${daysToHarvest} दिन में तुड़ाई`,
      daysToHarvest,
    };
  }
  return {
    code: 'GROWING', band: 'GREEN',
    label: `${daysToHarvest} day(s) to harvest`,
    labelHi: `तुड़ाई में ${daysToHarvest} दिन`,
    daysToHarvest,
  };
}

/* ---------------------------------------------------------------------------
 * §15 — GRADES. Four, and each one already knows where it should go, so the
 * grader never has to also decide the destination.
 * ------------------------------------------------------------------------ */
export const GRADES = [
  { grade: 'A', colour: 'GREEN', label: 'Retail quality', destination: 'RETAIL' },
  { grade: 'B', colour: 'YELLOW', label: 'Hotel / B2B', destination: 'B2B' },
  { grade: 'C', colour: 'AMBER', label: 'Discount / processing', destination: 'PROCESSING' },
  { grade: 'WASTE', colour: 'RED', label: 'Waste', destination: 'WASTE' },
] as const;

export const destinationForGrade = (grade: string) =>
  GRADES.find((g) => g.grade === grade)?.destination ?? 'RETAIL';

/* ---------------------------------------------------------------------------
 * §16 — FARM DISPATCH VS WAREHOUSE RECEIPT. The variance is the whole point:
 * 500 kg left, 497 kg arrived, and somebody has to see the 3 kg.
 * ------------------------------------------------------------------------ */
export function dispatchVariance(dispatchKg: number, receivedKg: number, warnPct = 1, critPct = 3) {
  const varianceKg = round(receivedKg - dispatchKg, 3);
  const variancePct = dispatchKg > 0 ? pct((varianceKg / dispatchKg) * 100) : 0;
  const abs = Math.abs(variancePct);
  const band: 'GREEN' | 'AMBER' | 'RED' | 'CRITICAL' =
    abs <= warnPct ? 'GREEN'
    : abs <= critPct ? 'AMBER'
    : abs <= critPct * 2 ? 'RED'
    : 'CRITICAL';
  return { varianceKg, variancePct, band, breached: abs > critPct };
}

/* ---------------------------------------------------------------------------
 * §19 / §29 — COST PER KG, AND THEN PROFIT.
 *
 * Every expense charged to the cycle plus the seed the system already knows
 * about, divided by what actually came off the field. Not by what was hoped
 * for — hoping is not a denominator.
 * ------------------------------------------------------------------------ */
export type ExpenseRow = { expenseType: string; amount: number };

export function cropCost(input: {
  expenses: ExpenseRow[];
  estimatedCost: number;
  harvestedKg: number;
  wasteKg?: number;
}) {
  const byType: Record<string, number> = {};
  for (const e of input.expenses) {
    byType[e.expenseType] = money((byType[e.expenseType] ?? 0) + e.amount);
  }
  const totalCost = money(input.expenses.reduce((a, e) => a + e.amount, 0));
  // Waste has already been paid for; it must not cheapen the good produce.
  const sellableKg = qty(Math.max(input.harvestedKg - (input.wasteKg ?? 0), 0));

  return {
    byType,
    totalCost,
    // Before the first harvest there is no cost per kg — showing one would be
    // a lie of arithmetic, so it stays null until produce exists.
    costPerKg: sellableKg > 0 ? round(totalCost / sellableKg, 2) : null,
    costPerKgAgainstEstimate: input.estimatedCost > 0 && sellableKg > 0
      ? round(input.estimatedCost / sellableKg, 2) : null,
    sellableKg,
    budgetUsedPct: input.estimatedCost > 0 ? pct((totalCost / input.estimatedCost) * 100) : null,
  };
}

/** §20 — expected vs actual, and the colour that goes with the gap. */
export function yieldVariance(expectedKg: number, actualKg: number, warnPct = 10) {
  const diffKg = qty(actualKg - expectedKg);
  const diffPct = expectedKg > 0 ? pct((diffKg / expectedKg) * 100) : 0;
  const colour: Colour =
    diffPct >= -warnPct ? 'GREEN'
    : diffPct >= -warnPct * 2.5 ? 'YELLOW'
    : 'RED';
  const label = diffKg >= 0
    ? `${qty(Math.abs(diffKg))} kg above expected`
    : `${qty(Math.abs(diffKg))} kg below expected`;
  return { diffKg, diffPct, colour, label };
}

/** §29 — the owner's number, without an accountant in the middle. */
export function cropProfit(input: {
  revenue: number;
  farmingCost: number;
  packingCost?: number;
  transportCost?: number;
  wastageValue?: number;
}) {
  const packing = money(input.packingCost ?? 0);
  const transport = money(input.transportCost ?? 0);
  const wastage = money(input.wastageValue ?? 0);
  const totalCost = money(input.farmingCost + packing + transport + wastage);
  const profit = money(input.revenue - totalCost);
  return {
    revenue: money(input.revenue),
    farmingCost: money(input.farmingCost),
    packingCost: packing,
    transportCost: transport,
    wastageValue: wastage,
    totalCost,
    profit,
    marginPct: input.revenue > 0 ? pct((profit / input.revenue) * 100) : null,
  };
}

/* ---------------------------------------------------------------------------
 * §27 — BUY VS GROW. The comparison an owner actually makes, stated plainly
 * enough that he can disagree with it.
 * ------------------------------------------------------------------------ */
export function buyVsGrow(input: {
  ownCostPerKg: number | null;
  marketRatePerKg: number | null;
  /** Growing carries risk the market rate does not. Weather, disease, theft. */
  riskPremiumPct?: number;
}) {
  const own = input.ownCostPerKg;
  const market = input.marketRatePerKg;
  if (own == null || market == null || own <= 0 || market <= 0) {
    return {
      verdict: 'UNKNOWN' as const, colour: 'YELLOW' as Colour,
      ownCostPerKg: own, marketRatePerKg: market, gapPerKg: null, gapPct: null,
      message: 'Not enough history yet — finish one crop cycle to compare.',
    };
  }
  const riskAdjustedOwn = round(own * (1 + (input.riskPremiumPct ?? 0) / 100), 2);
  const gapPerKg = round(market - riskAdjustedOwn, 2);
  const gapPct = pct((gapPerKg / market) * 100);

  // Inside ±5% the two are the same answer, and pretending otherwise sends
  // somebody chasing a rupee that is inside the noise.
  const verdict = gapPct > 5 ? 'GROW' : gapPct < -5 ? 'BUY' : 'EITHER';
  return {
    verdict,
    colour: (verdict === 'GROW' ? 'GREEN' : verdict === 'BUY' ? 'YELLOW' : 'GREEN') as Colour,
    ownCostPerKg: riskAdjustedOwn,
    marketRatePerKg: round(market, 2),
    gapPerKg,
    gapPct,
    message:
      verdict === 'GROW'
        ? `Growing costs ₹${riskAdjustedOwn}/kg against ₹${round(market, 2)}/kg in the market — keep growing.`
        : verdict === 'BUY'
        ? `Growing costs ₹${riskAdjustedOwn}/kg but the market is ₹${round(market, 2)}/kg — buying may be cheaper this season.`
        : `Growing and buying are within ₹${Math.abs(gapPerKg)}/kg of each other — either works.`,
  };
}

/* ---------------------------------------------------------------------------
 * §22 — STAFF PERFORMANCE, computed, never typed. A manager's memory is not
 * an appraisal system.
 * ------------------------------------------------------------------------ */
export function staffScore(m: {
  tasksAssigned: number;
  tasksDone: number;
  tasksOnTime: number;
  redIssues: number;
  gradeAPct?: number | null;
  wastePct?: number | null;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const completion = m.tasksAssigned > 0 ? (m.tasksDone / m.tasksAssigned) * 100 : 0;
  const punctuality = m.tasksDone > 0 ? (m.tasksOnTime / m.tasksDone) * 100 : 0;
  const quality = m.gradeAPct != null ? clamp(m.gradeAPct) : 70;
  const wastePenalty = clamp((m.wastePct ?? 0) * 4);
  const issuePenalty = clamp(m.redIssues * 8);

  const raw =
    clamp(completion) * 0.40 +
    clamp(punctuality) * 0.30 +
    quality * 0.30 -
    wastePenalty * 0.10 -
    issuePenalty * 0.15;

  // Thin history must not read as a great worker — same guard as supplierScore.
  const confidence = Math.min(1, m.tasksAssigned / 15);
  const score = round(clamp(raw) * confidence + 50 * (1 - confidence), 2);

  return {
    score,
    rating: (score >= 75 ? 'GREEN' : score >= 55 ? 'YELLOW' : 'RED') as Colour,
    confidence: round(confidence, 2),
    breakdown: {
      completionPct: round(completion, 2),
      punctualityPct: round(punctuality, 2),
      qualityPct: round(quality, 2),
      wastePenalty: round(wastePenalty, 2),
      issuePenalty: round(issuePenalty, 2),
    },
  };
}

/* ---------------------------------------------------------------------------
 * §26 / §30 — WHAT TO PLANT NEXT.
 *
 * Demand the business already has, against production it already expects, at
 * a margin it has already measured — with rotation and season as vetoes.
 * ------------------------------------------------------------------------ */
export type CropCandidate = {
  cropId: string;
  cropCode: string;
  cropName: string;
  productId: string | null;
  /** 60-day forward demand for this product, from sales history. */
  demandKg: number;
  /** What the farm already expects to produce in that window. */
  expectedSupplyKg: number;
  marketRatePerKg: number | null;
  historicalCostPerKg: number | null;
  durationDays: number;
  waterNeed: 'LOW' | 'MEDIUM' | 'HIGH';
  seasons: string[];
  avoidAfterCropCodes: string[];
};

export function suggestNextCrop(input: {
  candidates: CropCandidate[];
  previousCropCode?: string | null;
  season?: string | null;
  waterAvailability?: 'LOW' | 'MEDIUM' | 'HIGH';
}) {
  const waterRank = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
  const available = waterRank[input.waterAvailability ?? 'MEDIUM'];

  const scored = input.candidates.map((c) => {
    const shortageKg = Math.max(c.demandKg - c.expectedSupplyKg, 0);
    const reasons: string[] = [];
    const blockers: string[] = [];

    // Demand shortage is the loudest signal: it is money the business is
    // already spending in the market.
    const demandScore = c.demandKg > 0
      ? Math.min(100, (shortageKg / c.demandKg) * 100)
      : 0;
    if (shortageKg > 0) {
      reasons.push(`${qty(shortageKg)} kg short of the next 60 days' demand`);
    }

    const marginPerKg = c.marketRatePerKg != null && c.historicalCostPerKg != null
      ? round(c.marketRatePerKg - c.historicalCostPerKg, 2)
      : null;
    const marginScore = marginPerKg != null && c.marketRatePerKg
      ? Math.max(0, Math.min(100, (marginPerKg / c.marketRatePerKg) * 250))
      : 40;
    if (marginPerKg != null) reasons.push(`₹${marginPerKg}/kg margin at today's market rate`);

    // A short crop turns the plot over faster, which is worth something.
    const speedScore = Math.max(0, 100 - c.durationDays * 0.6);

    if (input.previousCropCode && c.avoidAfterCropCodes.includes(input.previousCropCode)) {
      blockers.push(`Should not follow ${input.previousCropCode} on the same plot`);
    }
    if (input.season && c.seasons.length && !c.seasons.includes('ALL')
        && !c.seasons.includes(input.season)) {
      blockers.push(`Not a ${input.season.toLowerCase()} crop`);
    }
    if (waterRank[c.waterNeed] > available) {
      blockers.push(`Needs ${c.waterNeed.toLowerCase()} water, farm has ${(input.waterAvailability ?? 'MEDIUM').toLowerCase()}`);
    }

    const score = round(
      demandScore * 0.45 + marginScore * 0.35 + speedScore * 0.20
      - blockers.length * 30, 2);

    return {
      ...c, shortageKg: qty(shortageKg), marginPerKg,
      score: Math.max(0, score), reasons, blockers,
      recommended: blockers.length === 0 && score >= 45,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ---------------------------------------------------------------------------
 * §25 — WAREHOUSE DEMAND MET FROM THE FARM FIRST.
 *
 * The purchase module should never buy in the market what the field is about
 * to deliver. This is the join between the two.
 * ------------------------------------------------------------------------ */
export function supplyPlan(input: {
  demandKg: number;
  farmToday: number;
  farmTomorrow: number;
  farmNext7: number;
}) {
  const today = qty(Math.min(input.demandKg, input.farmToday));
  const afterToday = qty(Math.max(input.demandKg - today, 0));
  const tomorrow = qty(Math.min(afterToday, input.farmTomorrow));
  const shortfall = qty(Math.max(afterToday - tomorrow, 0));

  return {
    demandKg: qty(input.demandKg),
    farmSupplyToday: today,
    farmSupplyTomorrow: tomorrow,
    marketPurchaseNeeded: shortfall,
    farmCoverPct: input.demandKg > 0 ? pct(((today + tomorrow) / input.demandKg) * 100) : 100,
    colour: (shortfall <= 0 ? 'GREEN'
      : shortfall < input.demandKg * 0.4 ? 'YELLOW' : 'RED') as Colour,
  };
}
