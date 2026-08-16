/* ===========================================================================
 * FARMING MODULE
 *
 * The rule this file is written to, and the reason it is as long as it is:
 *
 *     THE USER TYPES  crop, area, actual quantity, a problem, an expense.
 *     THE SYSTEM DOES date, task, reminder, crop age, harvest date, stock,
 *                     cost, profit, colour, staff rating, forecast, next crop.
 *
 * So every endpoint here takes the smallest possible input and derives the
 * rest. Nothing that can be looked up is ever asked for.
 *
 * It reuses, rather than duplicates, what the purchase module already built:
 *   · nextDocNo / pushTask / resolveTask / raiseAlert / emit  (platform)
 *   · work_queue, alerts, settings, audit, RLS                 (schema)
 *   · batches → stock_ledger → stock_balances                  (inventory)
 * A farm-grown crate ends up as the same batch a bought crate does, which is
 * what makes §28 seed-to-sale traceability work without a second system.
 * ======================================================================== */

import { Router } from 'express';
import { z } from 'zod';
import { query, withTx, type Tx, type Actor } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, getSetting, nextDocNo, pushTask, raiseAlert, resolveTask } from '../platform/services.js';
import { money, qty, round } from '../domain/index.js';
import {
  DEFAULT_WEATHER_THRESHOLDS, addDays, buyVsGrow, cropCost, cropHealthColour, cropProfit,
  daysBetween, destinationForGrade, dispatchVariance, harvestReadiness, irrigationDecision,
  planCrop, staffScore, suggestNextCrop, supplyPlan, taskColour, weatherAdvice, yieldVariance,
  type Colour, type CropMaster, type WeatherThresholds,
} from '../domain/farming.js';

export const farmingRouter = Router();
farmingRouter.use(authenticate);

const todayIso = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- helpers - */

/** Owner-editable thresholds, loaded once per request that needs them. */
async function farmSettings(tx: Tx, actor: Actor): Promise<WeatherThresholds & {
  harvestAlertDays: number; harvestGraceDays: number;
  varianceWarnPct: number; varianceCritPct: number;
  yieldShortfallWarnPct: number; taskSlaMinutes: number;
}> {
  const n = async (key: string, fallback: number) =>
    Number(await getSetting(tx, actor, key, fallback));
  return {
    rainHoldMm: await n('farming.rain_hold_mm', DEFAULT_WEATHER_THRESHOLDS.rainHoldMm),
    rainHoldProbPct: await n('farming.rain_hold_prob_pct', DEFAULT_WEATHER_THRESHOLDS.rainHoldProbPct),
    sprayWindKmph: await n('farming.spray_wind_kmph', DEFAULT_WEATHER_THRESHOLDS.sprayWindKmph),
    heatAlertC: await n('farming.heat_alert_c', DEFAULT_WEATHER_THRESHOLDS.heatAlertC),
    frostAlertC: await n('farming.frost_alert_c', DEFAULT_WEATHER_THRESHOLDS.frostAlertC),
    harvestAlertDays: await n('farming.harvest_alert_days', 3),
    harvestGraceDays: await n('farming.harvest_delay_grace_days', 2),
    varianceWarnPct: await n('farming.dispatch_variance_warn_pct', 1),
    varianceCritPct: await n('farming.dispatch_variance_crit_pct', 3),
    yieldShortfallWarnPct: await n('farming.yield_shortfall_warn_pct', 10),
    taskSlaMinutes: await n('farming.task_sla_minutes', 600),
  };
}

function toCropMaster(row: any): CropMaster {
  return {
    code: row.code,
    name: row.name,
    nameHi: row.name_hi,
    durationDays: Number(row.duration_days),
    harvestWindowDays: Number(row.harvest_window_days),
    yieldPerAcreKg: Number(row.yield_per_acre_kg),
    seedCostPerAcre: Number(row.seed_cost_per_acre),
    inputCostPerAcre: Number(row.input_cost_per_acre),
    irrigationIntervalDays: Number(row.irrigation_interval_days),
    irrigationIntervalDaysHot: row.irrigation_interval_days_hot != null
      ? Number(row.irrigation_interval_days_hot) : null,
    inspectionIntervalDays: Number(row.inspection_interval_days),
    fertilizerSchedule: row.fertilizer_schedule ?? [],
    spraySchedule: row.spray_schedule ?? [],
  };
}

/** Insert a task, silently ignoring a repeat: dedupe_key is the guard. */
async function insertTask(tx: Tx, actor: Actor, t: {
  branchId: string; farmId: string; plotId?: string | null; cycleId?: string | null;
  taskType: string; title: string; titleHi?: string | null; dueDate: string;
  dayNumber?: number | null; inputName?: string | null; plannedQty?: number | null;
  inputUom?: string | null; requiresQty?: boolean; source?: string; dedupeKey: string;
  severity?: Colour;
}) {
  const { rows } = await tx.query(
    `INSERT INTO farm_tasks (company_id, branch_id, farm_id, plot_id, cycle_id, task_type,
            title, title_hi, due_date, day_number, input_name, planned_qty, input_uom,
            requires_qty, source, dedupe_key, severity, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
     ON CONFLICT (company_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [actor.companyId, t.branchId, t.farmId, t.plotId ?? null, t.cycleId ?? null, t.taskType,
     t.title, t.titleHi ?? null, t.dueDate, t.dayNumber ?? null, t.inputName ?? null,
     t.plannedQty ?? null, t.inputUom ?? null, t.requiresQty ?? false,
     t.source ?? 'CALENDAR', t.dedupeKey, t.severity ?? 'GREEN', actor.userId]);
  return rows[0]?.id ?? null;
}

/* Note on optimistic locking: nothing in this module accepts a client-supplied
 * row `version`. Every write here is server-computed inside a transaction that
 * already holds SELECT ... FOR UPDATE on the row, so sending a version back
 * could only ever produce a false stale_write — as it did when the daily pass
 * read a cycle, refreshed its totals, and then tried to save the version it had
 * read before its own update. The schema trigger still bumps `version` on every
 * UPDATE, so external callers keep their concurrency guarantee. */

/** Roll every derived number on a cycle forward from what actually happened. */
async function refreshCycleTotals(tx: Tx, cycleId: string) {
  await tx.query(
    `UPDATE farm_crop_cycles c SET
       harvested_kg  = COALESCE(hv.net, 0),
       waste_kg      = COALESCE(hv.waste, 0),
       dispatched_kg = COALESCE(dp.sent, 0),
       received_kg   = COALESCE(dp.got, 0),
       loss_kg       = COALESCE(ls.kg, 0),
       actual_cost   = COALESCE(ex.amt, 0),
       first_harvest_at = COALESCE(c.first_harvest_at, hv.first_at)
      FROM (SELECT 1) _
      LEFT JOIN LATERAL (
        SELECT SUM(h.net_weight_kg) AS net, MIN(h.created_at) AS first_at,
               SUM(COALESCE(hl.waste, 0)) AS waste
          FROM farm_harvests h
          LEFT JOIN LATERAL (SELECT SUM(weight_kg) waste FROM farm_harvest_lines
                              WHERE harvest_id = h.id AND grade = 'WASTE') hl ON true
         WHERE h.cycle_id = $1 AND h.status <> 'CANCELLED') hv ON true
      LEFT JOIN LATERAL (
        SELECT SUM(dl.dispatch_weight_kg) AS sent, SUM(dl.received_weight_kg) AS got
          FROM farm_dispatch_lines dl JOIN farm_dispatches d ON d.id = dl.dispatch_id
         WHERE dl.cycle_id = $1 AND d.status <> 'CANCELLED') dp ON true
      LEFT JOIN LATERAL (
        SELECT SUM(qty_kg) AS kg FROM farm_losses WHERE cycle_id = $1) ls ON true
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS amt FROM farm_expenses WHERE cycle_id = $1) ex ON true
     WHERE c.id = $1`,
    [cycleId]);
}

/* ===========================================================================
 * THE DAILY PASS.
 *
 * Everything the module promises to do "by itself" happens here: colour the
 * crops, hold irrigation when rain is coming, wake the harvest alert, and put
 * one line — not fifty — into the shared work queue.
 *
 * It is idempotent (dedupe keys + alert dedupe), so it can safely run on every
 * open of FARM TODAY. That is deliberate: a farm laptop that is off for three
 * days should not miss three days of automation waiting for a cron.
 * ======================================================================== */
async function runDailyPass(tx: Tx, actor: Actor, farmId: string) {
  const s = await farmSettings(tx, actor);
  const today = todayIso();

  const { rows: farms } = await tx.query(
    `SELECT id, branch_id, name, code FROM farms
      WHERE id = $1 AND company_id = $2 AND is_own`, [farmId, actor.companyId]);
  const farm = farms[0];
  if (!farm) throw ApiError.notFound('Farm not found');

  const { rows: wx } = await tx.query(
    `SELECT * FROM farm_weather WHERE farm_id = $1 AND weather_date = $2`, [farmId, today]);
  const weather = wx[0] ? {
    date: today,
    tempMinC: wx[0].temp_min_c, tempMaxC: wx[0].temp_max_c,
    rainMm: wx[0].rain_mm, rainProbPct: wx[0].rain_prob_pct,
    windKmph: wx[0].wind_kmph, humidityPct: wx[0].humidity_pct,
    condition: wx[0].condition,
  } : null;
  const advice = weatherAdvice(weather, s);

  /* --- §9: rain means hold irrigation, and the next slot is set for you --- */
  const holdIrrigation = advice.some((a) => a.code === 'RAIN_HOLD_IRRIGATION');
  if (holdIrrigation) {
    const { rows: held } = await tx.query(
      `UPDATE farm_tasks
          SET status = 'SKIPPED',
              auto_skipped_reason = 'Rain expected — irrigation held by the system',
              updated_by = $3
        WHERE farm_id = $1 AND due_date = $2 AND status = 'PENDING'
          AND task_type = 'IRRIGATION'
        RETURNING id, plot_id, cycle_id, day_number, title`,
      [farmId, today, actor.userId]);
    for (const t of held) {
      await insertTask(tx, actor, {
        branchId: farm.branch_id, farmId, plotId: t.plot_id, cycleId: t.cycle_id,
        taskType: 'IRRIGATION', title: 'Irrigation (rescheduled after rain)',
        titleHi: 'सिंचाई (बारिश के बाद)',
        dueDate: addDays(today, 2), dayNumber: t.day_number != null ? Number(t.day_number) + 2 : null,
        source: 'WEATHER', dedupeKey: `${t.id}:rain-reschedule`,
      });
    }
  }
  if (advice.some((a) => a.code === 'WIND_AVOID_SPRAY')) {
    await tx.query(
      `UPDATE farm_tasks
          SET status = 'SKIPPED',
              auto_skipped_reason = 'High wind — spray would drift, moved to tomorrow',
              updated_by = $3
        WHERE farm_id = $1 AND due_date = $2 AND status = 'PENDING' AND task_type = 'SPRAY'`,
      [farmId, today, actor.userId]);
  }
  for (const a of advice.filter((x) => x.colour === 'RED')) {
    await raiseAlert(tx, actor, {
      branchId: farm.branch_id, alertType: 'FARM_WEATHER_RISK', severity: 'HIGH',
      entityType: 'farm', entityId: farmId,
      title: `${farm.name}: ${a.message}`, message: a.messageHi, meta: { code: a.code, weather },
    });
  }

  /* --- colour every live crop, and wake the harvest when it is due -------- */
  const { rows: cycles } = await tx.query(
    `SELECT c.*, pl.code AS plot_code, fc.name AS crop_name, fc.code AS crop_code,
            (SELECT count(*) FROM farm_tasks t
              WHERE t.cycle_id = c.id AND t.status='PENDING' AND t.due_date < CURRENT_DATE)::int AS overdue_tasks,
            (SELECT count(*) FROM farm_tasks t
              WHERE t.cycle_id = c.id AND t.status='PROBLEM')::int AS open_problems,
            (SELECT o.health FROM farm_observations o
              WHERE o.cycle_id = c.id ORDER BY o.observed_at DESC LIMIT 1) AS last_health
       FROM farm_crop_cycles c
       JOIN farm_plots pl ON pl.id = c.plot_id
       JOIN farm_crops fc ON fc.id = c.crop_id
      WHERE c.farm_id = $1 AND c.status IN ('PLANNED','GROWING','HARVESTING')
      FOR UPDATE OF c`,
    [farmId]);

  for (const c of cycles) {
    // Derived totals are re-rolled from the source rows rather than trusted to
    // have been incremented correctly by every writer that ever touched them.
    await refreshCycleTotals(tx, c.id);

    const ready = harvestReadiness({
      status: c.status,
      expectedHarvestDate: c.expected_harvest_date,
      expectedHarvestEndDate: c.expected_harvest_end_date,
      today,
      harvestedKg: Number(c.harvested_kg),
      expectedYieldKg: Number(c.expected_yield_kg),
      alertDays: s.harvestAlertDays,
      graceDays: s.harvestGraceDays,
    });

    const health = cropHealthColour({
      overdueTasks: Number(c.overdue_tasks),
      openProblems: Number(c.open_problems),
      lastObservation: (c.last_health as Colour | null) ?? null,
      harvest: ready,
    });

    const nextStatus = c.status === 'PLANNED' && c.sowing_date <= today
      ? 'GROWING'
      : (ready.code === 'READY' || ready.code === 'DELAYED') && c.status === 'GROWING'
      ? 'HARVESTING'
      : c.status;

    if (c.health !== health.colour || c.status !== nextStatus
        || c.health_note !== health.reasons.join(' · ')) {
      await tx.query(
        `UPDATE farm_crop_cycles SET health=$2, health_note=$3, status=$4, updated_by=$5
          WHERE id=$1`,
        [c.id, health.colour, health.reasons.join(' · '), nextStatus, actor.userId]);
    }

    if (health.colour !== 'GREEN') {
      await raiseAlert(tx, actor, {
        branchId: c.branch_id,
        alertType: health.colour === 'RED' ? 'CROP_HEALTH_RED' : 'CROP_HEALTH_YELLOW',
        severity: health.colour === 'RED' ? 'CRITICAL' : 'MEDIUM',
        entityType: 'farm_crop_cycle', entityId: c.id,
        title: `Plot-${c.plot_code} ${c.crop_name} is ${health.colour.toLowerCase()}`,
        message: health.reasons.join(' · '),
        meta: { cycleNo: c.cycle_no, reasons: health.reasons },
      });
    }

    if (ready.code === 'SOON' || ready.code === 'READY' || ready.code === 'DELAYED') {
      const title = `Harvest ${c.crop_name} — Plot-${c.plot_code}`;
      // The calendar already put a harvest task on the list at sowing time.
      // Re-colour that one rather than adding a second: two reminders for one
      // job is how a task list stops being believed.
      const { rowCount } = await tx.query(
        `UPDATE farm_tasks SET severity=$2, title=$3, title_hi=$4, updated_by=$5
          WHERE cycle_id=$1 AND task_type='HARVEST' AND status='PENDING'`,
        [c.id, ready.band, title, `${c.crop_name} की तुड़ाई — प्लॉट-${c.plot_code}`, actor.userId]);
      // Nothing pending — a multi-pick crop whose last reminder was completed.
      if (!rowCount) {
        await insertTask(tx, actor, {
          branchId: c.branch_id, farmId, plotId: c.plot_id, cycleId: c.id,
          taskType: 'HARVEST', title,
          titleHi: `${c.crop_name} की तुड़ाई — प्लॉट-${c.plot_code}`,
          dueDate: today, source: 'SYSTEM', severity: ready.band,
          dedupeKey: `${c.id}:HARVEST:${today}:repick`,
        });
      }
    }
    if (ready.code === 'DELAYED') {
      await raiseAlert(tx, actor, {
        branchId: c.branch_id, alertType: 'HARVEST_DELAYED', severity: 'HIGH',
        entityType: 'farm_crop_cycle', entityId: c.id,
        title: `${c.crop_name} on Plot-${c.plot_code}: ${ready.label}`,
        message: 'Produce left in the field loses grade every day.',
        meta: { cycleNo: c.cycle_no, daysToHarvest: ready.daysToHarvest },
      });
    }
  }

  /* --- one work-queue line per farm, not one per task -------------------- */
  const { rows: counts } = await tx.query(
    `SELECT count(*) FILTER (WHERE due_date <= CURRENT_DATE)::int AS due_today,
            count(*) FILTER (WHERE due_date <  CURRENT_DATE)::int AS overdue
       FROM farm_tasks
      WHERE farm_id = $1 AND status = 'PENDING'`, [farmId]);
  const due = Number(counts[0]?.due_today ?? 0);
  const overdue = Number(counts[0]?.overdue ?? 0);

  if (due > 0) {
    await pushTask(tx, actor, {
      branchId: farm.branch_id, queueKey: 'FARM_TASK',
      docType: 'FARM', docId: farmId, docNo: farm.code,
      title: `${farm.name} — ${due} task${due === 1 ? '' : 's'} due today`,
      subtitle: overdue > 0 ? `${overdue} already overdue` : 'Open FARM TODAY',
      severity: overdue >= 3 ? 'critical' : overdue > 0 ? 'warn' : 'normal',
      requiredPermission: 'farming.task.complete',
      slaMinutes: s.taskSlaMinutes,
      payload: { farmId, due, overdue },
    });
  } else {
    await resolveTask(tx, actor, 'FARM_TASK', 'FARM', farmId);
  }

  return { weather, advice, cycles: cycles.length, dueToday: due, overdue };
}

/* ===========================================================================
 * §1 — FARM SETUP. Filled in once.
 * ======================================================================== */

farmingRouter.get('/farms', h(async (req) =>
  query(req.actor,
    `SELECT f.id, f.code, f.name, f.village, f.area_acre, f.water_source, f.soil_type,
            f.status, f.branch_id, f.default_warehouse_id, f.geo_lat, f.geo_lng,
            b.name AS branch_name, w.name AS warehouse_name, u.full_name AS manager_name,
            (SELECT count(*) FROM farm_plots p WHERE p.farm_id=f.id AND p.is_active)::int AS plot_count,
            (SELECT count(*) FROM farm_crop_cycles c
              WHERE c.farm_id=f.id AND c.status IN ('PLANNED','GROWING','HARVESTING'))::int AS live_crops,
            (SELECT count(*) FROM farm_tasks t
              WHERE t.farm_id=f.id AND t.status='PENDING' AND t.due_date <= CURRENT_DATE)::int AS tasks_due,
            COALESCE((SELECT CASE WHEN bool_or(c.health='RED') THEN 'RED'
                                  WHEN bool_or(c.health='YELLOW') THEN 'YELLOW' ELSE 'GREEN' END
                        FROM farm_crop_cycles c
                       WHERE c.farm_id=f.id AND c.status IN ('PLANNED','GROWING','HARVESTING')),
                     'GREEN') AS health
       FROM farms f
       LEFT JOIN branches b   ON b.id = f.branch_id
       LEFT JOIN warehouses w ON w.id = f.default_warehouse_id
       LEFT JOIN users u      ON u.id = f.manager_id
      WHERE f.company_id = $1 AND f.is_own
      ORDER BY f.code`,
    [req.actor.companyId])));

farmingRouter.post('/farms', requires('farming.farm.manage'), h(async (req) => {
  const input = body(z.object({
    code: z.string().min(2, 'Give the farm a short code'),
    name: z.string().min(2, 'Name the farm'),
    branchId: z.string().uuid(),
    village: z.string().optional(),
    areaAcre: z.number().positive('Area must be more than zero'),
    waterSource: z.enum(['TUBE_WELL', 'CANAL', 'RIVER', 'POND', 'RAIN_FED', 'DRIP', 'BOREWELL', 'OTHER'])
      .default('TUBE_WELL'),
    soilType: z.string().optional(),
    defaultWarehouseId: z.string().uuid().nullable().optional(),
    managerId: z.string().uuid().nullable().optional(),
    geoLat: z.number().nullable().optional(),
    geoLng: z.number().nullable().optional(),
    // Creating "A, B, C, D" here is the difference between a one-minute setup
    // and four more forms nobody fills in.
    plots: z.array(z.object({
      code: z.string().min(1),
      name: z.string().optional(),
      areaAcre: z.number().nonnegative().default(0),
      irrigationType: z.enum(['DRIP', 'SPRINKLER', 'FLOOD', 'FURROW', 'MANUAL']).optional(),
    })).default([]),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO farms (company_id, branch_id, code, name, is_own, village, area_acre,
              water_source, soil_type, default_warehouse_id, manager_id, geo_lat, geo_lng,
              status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12,'ACTIVE',$13,$13) RETURNING *`,
      [req.actor.companyId, input.branchId, input.code.toUpperCase(), input.name,
       input.village ?? null, input.areaAcre, input.waterSource, input.soilType ?? null,
       input.defaultWarehouseId ?? null, input.managerId ?? null,
       input.geoLat ?? null, input.geoLng ?? null, req.actor.userId]);
    const farm = rows[0];

    for (const p of input.plots) {
      await tx.query(
        `INSERT INTO farm_plots (company_id, farm_id, code, name, area_acre, irrigation_type,
                qr_code, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [req.actor.companyId, farm.id, p.code.toUpperCase(), p.name ?? null, p.areaAcre,
         p.irrigationType ?? null, `PLOT-${farm.code}-${p.code.toUpperCase()}`, req.actor.userId]);
    }

    await emit(tx, req.actor, 'farm', farm.id, 'farm.created',
      { code: farm.code, plots: input.plots.length });
    return farm;
  });
}));

farmingRouter.get('/farms/:id', h(async (req) => {
  const [farm] = await query(req.actor,
    `SELECT f.*, b.name AS branch_name, w.name AS warehouse_name, u.full_name AS manager_name
       FROM farms f
       LEFT JOIN branches b ON b.id = f.branch_id
       LEFT JOIN warehouses w ON w.id = f.default_warehouse_id
       LEFT JOIN users u ON u.id = f.manager_id
      WHERE f.id = $1 AND f.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!farm) throw ApiError.notFound('Farm not found');

  const plots = await query(req.actor,
    `SELECT p.*, c.id AS cycle_id, c.cycle_no, c.status AS cycle_status, c.health,
            c.sowing_date, c.expected_harvest_date, c.expected_yield_kg, c.harvested_kg,
            (CURRENT_DATE - c.sowing_date) AS crop_age_days,
            fc.name AS crop_name, fc.name_hi AS crop_name_hi
       FROM farm_plots p
       LEFT JOIN farm_crop_cycles c ON c.plot_id = p.id
                                   AND c.status IN ('PLANNED','GROWING','HARVESTING')
       LEFT JOIN farm_crops fc ON fc.id = c.crop_id
      WHERE p.farm_id = $1 AND p.is_active
      ORDER BY p.code`, [req.params.id]);

  const machines = await query(req.actor,
    `SELECT * FROM farm_machines WHERE farm_id = $1 AND is_active ORDER BY code`,
    [req.params.id]);

  return { farm, plots, machines };
}));

farmingRouter.post('/farms/:id/plots', requires('farming.farm.manage'), h(async (req) => {
  const input = body(z.object({
    code: z.string().min(1),
    name: z.string().optional(),
    areaAcre: z.number().nonnegative().default(0),
    soilType: z.string().optional(),
    irrigationType: z.enum(['DRIP', 'SPRINKLER', 'FLOOD', 'FURROW', 'MANUAL']).optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: f } = await tx.query(
      `SELECT code FROM farms WHERE id=$1 AND company_id=$2 AND is_own`,
      [req.params.id, req.actor.companyId]);
    if (!f[0]) throw ApiError.notFound('Farm not found');
    const { rows } = await tx.query(
      `INSERT INTO farm_plots (company_id, farm_id, code, name, area_acre, soil_type,
              irrigation_type, qr_code, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.actor.companyId, req.params.id, input.code.toUpperCase(), input.name ?? null,
       input.areaAcre, input.soilType ?? null, input.irrigationType ?? null,
       `PLOT-${f[0].code}-${input.code.toUpperCase()}`, req.actor.userId]);
    return rows[0];
  });
}));

/* ---------------------------------------------------------------------------
 * §6 — THE PLOT QR. Scan the code on the gate and the phone opens exactly this
 * plot: crop, today's job, last watering, last spray, next harvest.
 * Wrong-plot entries mostly stop happening once this exists.
 * ------------------------------------------------------------------------ */
farmingRouter.get('/scan/:qr', h(async (req) => {
  const [plot] = await query(req.actor,
    `SELECT p.id, p.code, p.name, p.area_acre, p.status, p.qr_code, p.irrigation_type,
            f.id AS farm_id, f.name AS farm_name, f.code AS farm_code, f.branch_id
       FROM farm_plots p JOIN farms f ON f.id = p.farm_id
      WHERE p.company_id = $1 AND p.qr_code = $2`,
    [req.actor.companyId, req.params.qr]);
  if (!plot) throw ApiError.notFound('That QR does not match any plot. Check the label.');

  const [cycle] = await query(req.actor,
    `SELECT c.*, fc.name AS crop_name, fc.name_hi AS crop_name_hi, fc.code AS crop_code,
            fc.irrigation_interval_days, fc.irrigation_interval_days_hot,
            (CURRENT_DATE - c.sowing_date) AS crop_age_days,
            p.name AS product_name
       FROM farm_crop_cycles c
       JOIN farm_crops fc ON fc.id = c.crop_id
       LEFT JOIN products p ON p.id = c.product_id
      WHERE c.plot_id = $1 AND c.status IN ('PLANNED','GROWING','HARVESTING')`, [plot.id]);

  const tasks = cycle ? await query(req.actor,
    `SELECT * FROM farm_tasks
      WHERE cycle_id = $1 AND status = 'PENDING' AND due_date <= CURRENT_DATE + 1
      ORDER BY due_date, task_type`, [cycle.id]) : [];

  const [last] = await query(req.actor,
    `SELECT
       (SELECT max(done_at) FROM farm_tasks t
         WHERE t.plot_id=$1 AND t.task_type='IRRIGATION' AND t.status='DONE') AS last_irrigation,
       (SELECT max(done_at) FROM farm_tasks t
         WHERE t.plot_id=$1 AND t.task_type='SPRAY' AND t.status='DONE')      AS last_spray,
       (SELECT max(done_at) FROM farm_tasks t
         WHERE t.plot_id=$1 AND t.task_type='FERTILIZER' AND t.status='DONE') AS last_fertilizer,
       (SELECT max(harvest_date) FROM farm_harvests hh WHERE hh.plot_id=$1)   AS last_harvest`,
    [plot.id]);

  return {
    plot,
    cycle: cycle ?? null,
    tasks,
    last,
    harvest: cycle ? harvestReadiness({
      status: cycle.status,
      expectedHarvestDate: cycle.expected_harvest_date,
      expectedHarvestEndDate: cycle.expected_harvest_end_date,
      today: todayIso(),
      harvestedKg: Number(cycle.harvested_kg),
      expectedYieldKg: Number(cycle.expected_yield_kg),
    }) : null,
  };
}));

/* ---------------------------------------------------- crop & machine master */

farmingRouter.get('/crops', h(async (req) =>
  query(req.actor,
    `SELECT fc.*, p.name AS product_name, p.sku
       FROM farm_crops fc LEFT JOIN products p ON p.id = fc.product_id
      WHERE fc.company_id = $1 AND fc.is_active ORDER BY fc.name`,
    [req.actor.companyId])));

farmingRouter.get('/machines', h(async (req) =>
  query(req.actor,
    `SELECT m.*, f.name AS farm_name,
            (m.next_service_date IS NOT NULL AND m.next_service_date <= CURRENT_DATE) AS service_overdue,
            (SELECT count(*) FROM farm_expenses e WHERE e.machine_id = m.id
              AND e.expense_date >= CURRENT_DATE - 30)::int AS uses_30d
       FROM farm_machines m LEFT JOIN farms f ON f.id = m.farm_id
      WHERE m.company_id = $1 AND m.is_active ORDER BY m.code`,
    [req.actor.companyId])));

farmingRouter.post('/machines/:id/status', requires('farming.farm.manage', 'farming.task.complete'),
  h(async (req) => {
    const input = body(z.object({
      status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE_DUE', 'BREAKDOWN']),
      note: z.string().optional(),
      serviceDone: z.boolean().default(false),
    }), req.body);

    return withTx(req.actor, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE farm_machines
            SET status = $2, status_note = $3,
                last_service_date = CASE WHEN $4 THEN CURRENT_DATE ELSE last_service_date END,
                next_service_date = CASE WHEN $4
                     THEN CURRENT_DATE + service_interval_days ELSE next_service_date END,
                updated_by = $5
          WHERE id = $1 AND company_id = $6 RETURNING *`,
        [req.params.id, input.status, input.note ?? null, input.serviceDone,
         req.actor.userId, req.actor.companyId]);
      const m = rows[0];
      if (!m) throw ApiError.notFound('Machine not found');

      if (input.status === 'BREAKDOWN') {
        const { rows: f } = await tx.query(`SELECT branch_id FROM farms WHERE id = $1`, [m.farm_id]);
        await raiseAlert(tx, req.actor, {
          branchId: f[0]?.branch_id ?? null, alertType: 'MACHINE_BREAKDOWN', severity: 'HIGH',
          entityType: 'farm_machine', entityId: m.id,
          title: `${m.name} is broken down`,
          message: input.note ?? 'Field work that needs this machine will stall.',
        });
      }
      return m;
    });
  }));

/* ===========================================================================
 * §2 — CROP START. Crop, plot, area, sowing date. Then the system takes over.
 * ======================================================================== */

/** What WILL happen if you start this crop — shown before anything is saved. */
farmingRouter.post('/crop-cycles/preview', h(async (req) => {
  const input = body(z.object({
    cropId: z.string().uuid(),
    areaAcre: z.number().positive(),
    sowingDate: z.string().default(todayIso()),
  }), req.body);

  const [crop] = await query(req.actor,
    `SELECT * FROM farm_crops WHERE id=$1 AND company_id=$2`,
    [input.cropId, req.actor.companyId]);
  if (!crop) throw ApiError.notFound('Crop not found');

  // Last season's real yield on this crop beats the master estimate.
  const [hist] = await query(req.actor,
    `SELECT CASE WHEN SUM(area_acre) > 0
                 THEN SUM(harvested_kg) / SUM(area_acre) END AS yield_per_acre
       FROM farm_crop_cycles
      WHERE company_id=$1 AND crop_id=$2 AND status='CLOSED' AND harvested_kg > 0`,
    [req.actor.companyId, input.cropId]);

  const plan = planCrop({
    crop: toCropMaster(crop),
    areaAcre: input.areaAcre,
    sowingDate: input.sowingDate,
    historicalYieldPerAcreKg: hist?.yield_per_acre ? Number(hist.yield_per_acre) : null,
  });

  return {
    crop: { id: crop.id, code: crop.code, name: crop.name, nameHi: crop.name_hi },
    usedHistory: !!hist?.yield_per_acre,
    ...plan,
    taskSummary: {
      irrigation: plan.tasks.filter((t) => t.taskType === 'IRRIGATION').length,
      fertilizer: plan.tasks.filter((t) => t.taskType === 'FERTILIZER').length,
      spray: plan.tasks.filter((t) => t.taskType === 'SPRAY').length,
      inspection: plan.tasks.filter((t) => t.taskType === 'INSPECTION').length,
      total: plan.tasks.length,
    },
  };
}));

farmingRouter.post('/crop-cycles', requires('farming.crop.start'), h(async (req) => {
  const input = body(z.object({
    farmId: z.string().uuid(),
    plotId: z.string().uuid(),
    cropId: z.string().uuid(),
    areaAcre: z.number().positive('How much area was sown?'),
    sowingDate: z.string().default(todayIso()),
    remarks: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: fr } = await tx.query(
      `SELECT f.id, f.branch_id, f.name FROM farms f
        WHERE f.id=$1 AND f.company_id=$2 AND f.is_own`, [input.farmId, req.actor.companyId]);
    const farm = fr[0];
    if (!farm) throw ApiError.notFound('Farm not found');

    const { rows: pr } = await tx.query(
      `SELECT * FROM farm_plots WHERE id=$1 AND farm_id=$2 FOR UPDATE`,
      [input.plotId, input.farmId]);
    const plot = pr[0];
    if (!plot) throw ApiError.notFound('Plot not found on this farm');
    if (Number(input.areaAcre) > Number(plot.area_acre) + 0.001 && Number(plot.area_acre) > 0) {
      throw ApiError.rule(
        `Plot-${plot.code} is ${plot.area_acre} acre. You cannot sow ${input.areaAcre} acre on it.`);
    }

    const { rows: cr } = await tx.query(
      `SELECT * FROM farm_crops WHERE id=$1 AND company_id=$2`,
      [input.cropId, req.actor.companyId]);
    const crop = cr[0];
    if (!crop) throw ApiError.notFound('Crop not found');

    const { rows: hist } = await tx.query(
      `SELECT CASE WHEN SUM(area_acre) > 0 THEN SUM(harvested_kg)/SUM(area_acre) END AS y
         FROM farm_crop_cycles
        WHERE company_id=$1 AND crop_id=$2 AND status='CLOSED' AND harvested_kg > 0`,
      [req.actor.companyId, input.cropId]);

    const plan = planCrop({
      crop: toCropMaster(crop),
      areaAcre: input.areaAcre,
      sowingDate: input.sowingDate,
      historicalYieldPerAcreKg: hist[0]?.y ? Number(hist[0].y) : null,
    });

    const cycleNo = await nextDocNo(tx, req.actor, farm.branch_id, 'CROP');
    const { rows: cyc } = await tx.query(
      `INSERT INTO farm_crop_cycles (company_id, branch_id, farm_id, plot_id, crop_id, product_id,
              cycle_no, area_acre, sowing_date, duration_days, expected_harvest_date,
              expected_harvest_end_date, expected_yield_kg, estimated_cost, status, remarks,
              created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN $9::date > CURRENT_DATE THEN 'PLANNED' ELSE 'GROWING' END,$15,$16,$16)
       RETURNING *`,
      [req.actor.companyId, farm.branch_id, input.farmId, input.plotId, input.cropId,
       crop.product_id, cycleNo, input.areaAcre, input.sowingDate, plan.durationDays,
       plan.expectedHarvestDate, plan.expectedHarvestEndDate, plan.expectedYieldKg,
       plan.estimatedCost, input.remarks ?? null, req.actor.userId]);
    const cycle = cyc[0];

    /* --- THE point of the module: the whole calendar, generated once ------ */
    for (const t of plan.tasks) {
      await insertTask(tx, req.actor, {
        branchId: farm.branch_id, farmId: input.farmId, plotId: input.plotId, cycleId: cycle.id,
        taskType: t.taskType, title: t.title, dueDate: t.dueDate, dayNumber: t.dayNumber,
        inputName: t.inputName, plannedQty: t.plannedQty, inputUom: t.inputUom,
        requiresQty: t.requiresQty,
        dedupeKey: `${cycle.id}:${t.taskType}:${t.dueDate}:${t.dayNumber}`,
      });
    }

    // The seed is a real cost from day one; leaving it out makes every early
    // cost-per-kg reading flattering and wrong.
    const seedCost = money(Number(crop.seed_cost_per_acre) * input.areaAcre);
    if (seedCost > 0) {
      await tx.query(
        `INSERT INTO farm_expenses (company_id, branch_id, farm_id, plot_id, cycle_id,
                expense_date, expense_type, amount, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'SEED',$7,'Seed / planting material (system estimate)',$8,$8)`,
        [req.actor.companyId, farm.branch_id, input.farmId, input.plotId, cycle.id,
         input.sowingDate, seedCost, req.actor.userId]);
    }

    await tx.query(
      `UPDATE farm_plots SET status='CROPPED', last_crop_id=$2, updated_by=$3 WHERE id=$1`,
      [input.plotId, input.cropId, req.actor.userId]);

    await refreshCycleTotals(tx, cycle.id);
    await emit(tx, req.actor, 'farm_crop_cycle', cycle.id, 'farm.crop.started', {
      cycleNo, crop: crop.code, plot: plot.code, areaAcre: input.areaAcre,
      expectedHarvestDate: plan.expectedHarvestDate, expectedYieldKg: plan.expectedYieldKg,
    });

    return { ...cycle, plan, tasksCreated: plan.tasks.length };
  });
}));

farmingRouter.get('/crop-cycles', h(async (req) =>
  query(req.actor,
    `SELECT * FROM v_farm_crop_status
      WHERE company_id = $1
        AND ($2::uuid IS NULL OR farm_id = $2)
        AND ($3 = '' OR status = $3)
      ORDER BY CASE health WHEN 'RED' THEN 0 WHEN 'YELLOW' THEN 1 ELSE 2 END,
               days_to_harvest NULLS LAST`,
    [req.actor.companyId, req.query.farmId ?? null, String(req.query.status ?? '')])));

/** Everything about one crop, on one screen — including the diary and the money. */
farmingRouter.get('/crop-cycles/:id', h(async (req) => {
  const [c] = await query(req.actor,
    `SELECT c.*, f.name AS farm_name, f.code AS farm_code, pl.code AS plot_code,
            fc.name AS crop_name, fc.name_hi AS crop_name_hi, fc.code AS crop_code,
            fc.irrigation_interval_days, fc.irrigation_interval_days_hot,
            p.name AS product_name, p.sku AS product_sku,
            (CURRENT_DATE - c.sowing_date) AS crop_age_days
       FROM farm_crop_cycles c
       JOIN farms f ON f.id = c.farm_id
       JOIN farm_plots pl ON pl.id = c.plot_id
       JOIN farm_crops fc ON fc.id = c.crop_id
       LEFT JOIN products p ON p.id = c.product_id
      WHERE c.id = $1 AND c.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!c) throw ApiError.notFound('Crop cycle not found');

  const [tasks, observations, harvests, expenses, losses] = await Promise.all([
    query(req.actor,
      `SELECT t.*, u.full_name AS done_by_name FROM farm_tasks t
         LEFT JOIN users u ON u.id = t.done_by
        WHERE t.cycle_id = $1 ORDER BY t.due_date, t.task_type`, [req.params.id]),
    query(req.actor,
      `SELECT o.id, o.observed_at, o.day_number, o.health, o.stage, o.issue_code, o.note,
              o.photo_data, o.photo_mime, u.full_name AS observed_by_name
         FROM farm_observations o LEFT JOIN users u ON u.id = o.observed_by
        WHERE o.cycle_id = $1 ORDER BY o.observed_at DESC`, [req.params.id]),
    query(req.actor,
      `SELECT h.*, u.full_name AS harvested_by_name,
              (SELECT json_agg(json_build_object('grade',l.grade,'weightKg',l.weight_kg,
                        'crateCount',l.crate_count,'destination',l.destination,
                        'dispatchedKg',l.dispatched_kg) ORDER BY l.grade)
                 FROM farm_harvest_lines l WHERE l.harvest_id = h.id) AS lines
         FROM farm_harvests h LEFT JOIN users u ON u.id = h.harvested_by
        WHERE h.cycle_id = $1 ORDER BY h.harvest_date DESC, h.created_at DESC`, [req.params.id]),
    query(req.actor,
      `SELECT e.*, u.full_name AS by_name FROM farm_expenses e
         LEFT JOIN users u ON u.id = e.created_by
        WHERE e.cycle_id = $1 ORDER BY e.expense_date DESC`, [req.params.id]),
    query(req.actor,
      `SELECT * FROM farm_losses WHERE cycle_id = $1 ORDER BY loss_date DESC`, [req.params.id]),
  ]);

  const today = todayIso();
  const cost = cropCost({
    expenses: expenses.map((e: any) => ({ expenseType: e.expense_type, amount: Number(e.amount) })),
    estimatedCost: Number(c.estimated_cost),
    harvestedKg: Number(c.harvested_kg),
    wasteKg: Number(c.waste_kg),
  });
  const harvest = harvestReadiness({
    status: c.status,
    expectedHarvestDate: c.expected_harvest_date,
    expectedHarvestEndDate: c.expected_harvest_end_date,
    today,
    harvestedKg: Number(c.harvested_kg),
    expectedYieldKg: Number(c.expected_yield_kg),
  });

  // §11 — the photo diary: one line per real event, in the order they happened.
  const diary = [
    { day: 0, at: c.sowing_date, kind: 'SOWING', label: `Sowing — ${c.crop_name}`, health: 'GREEN' },
    ...observations.map((o: any) => ({
      day: o.day_number, at: o.observed_at, kind: 'CHECK',
      label: o.note || `Crop check — ${o.health.toLowerCase()}`,
      health: o.health, photo: o.photo_data, stage: o.stage,
    })),
    ...harvests.map((hv: any) => ({
      day: hv.crop_age_days, at: hv.harvest_date, kind: 'HARVEST',
      label: `Harvest ${qty(Number(hv.net_weight_kg))} kg`, health: 'GREEN',
    })),
  ].sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const canSeeCost = req.actor.permissions.has('farming.cost.view')
    || req.actor.permissions.has('data.cost.view')
    || req.actor.permissions.has('admin.override');

  return {
    cycle: c,
    tasks: tasks.map((t: any) => ({ ...t, colour: taskColour(
      { dueDate: t.due_date, status: t.status }, today) })),
    observations, harvests, losses, diary,
    // §20 — the estimate is kept and measured against, not quietly forgotten.
    // But it is only a *verdict* once picking has finished: a multi-pick crop
    // one day into a two-week window is not "3,000 kg short", it is early.
    yieldVariance: yieldVariance(Number(c.expected_yield_kg), Number(c.harvested_kg)),
    yieldWindowClosed: c.expected_harvest_end_date <= today
      || ['CLOSED', 'FAILED'].includes(c.status),
    harvest,
    // §6.1: cost is stripped server-side, never CSS-hidden.
    expenses: canSeeCost ? expenses : [],
    cost: canSeeCost ? cost : null,
    profit: canSeeCost ? cropProfit({
      revenue: Number(c.revenue), farmingCost: cost.totalCost,
    }) : null,
  };
}));

/* ===========================================================================
 * §3 / §4 — FARM TODAY. The only screen a field worker ever needs to open.
 * ======================================================================== */

farmingRouter.get('/today', h(async (req) => {
  const farmId = String(req.query.farmId ?? '');
  if (!farmId) {
    // No farm chosen: send back the list so the UI can pick the only one.
    const farms = await query(req.actor,
      `SELECT id, code, name FROM farms WHERE company_id=$1 AND is_own AND status='ACTIVE' ORDER BY code`,
      [req.actor.companyId]);
    if (farms.length !== 1) return { needsFarm: true, farms };
    return farmToday(req.actor, farms[0].id);
  }
  return farmToday(req.actor, farmId);
}));

async function farmToday(actor: Actor, farmId: string) {
  // The daily pass runs on open, so automation never waits for a scheduler.
  const pass = await withTx(actor, (tx) => runDailyPass(tx, actor, farmId));
  const today = todayIso();

  const [farm] = await query(actor,
    `SELECT f.*, w.name AS warehouse_name FROM farms f
       LEFT JOIN warehouses w ON w.id = f.default_warehouse_id
      WHERE f.id=$1 AND f.company_id=$2`, [farmId, actor.companyId]);

  const tasks = await query(actor,
    `SELECT t.*, pl.code AS plot_code, fc.name AS crop_name, fc.name_hi AS crop_name_hi,
            c.cycle_no, c.health AS crop_health, (CURRENT_DATE - c.sowing_date) AS crop_age_days
       FROM farm_tasks t
       LEFT JOIN farm_plots pl ON pl.id = t.plot_id
       LEFT JOIN farm_crop_cycles c ON c.id = t.cycle_id
       LEFT JOIN farm_crops fc ON fc.id = c.crop_id
      WHERE t.farm_id = $1 AND t.status = 'PENDING' AND t.due_date <= CURRENT_DATE + 1
      ORDER BY t.due_date, CASE t.task_type WHEN 'HARVEST' THEN 0 WHEN 'IRRIGATION' THEN 1
                                            WHEN 'SPRAY' THEN 2 WHEN 'FERTILIZER' THEN 3 ELSE 4 END,
               pl.code`,
    [farmId]);

  /* --- §7: the irrigation answer, not the irrigation data ---------------- */
  const cycles = await query(actor,
    `SELECT c.id, c.plot_id, c.status, c.health, c.sowing_date, c.expected_harvest_date,
            c.expected_harvest_end_date, c.harvested_kg, c.expected_yield_kg,
            (CURRENT_DATE - c.sowing_date) AS crop_age_days,
            pl.code AS plot_code, fc.name AS crop_name, fc.name_hi AS crop_name_hi,
            fc.irrigation_interval_days, fc.irrigation_interval_days_hot,
            (SELECT max(t.done_at)::date FROM farm_tasks t
              WHERE t.cycle_id = c.id AND t.task_type='IRRIGATION' AND t.status='DONE') AS last_irrigation
       FROM farm_crop_cycles c
       JOIN farm_plots pl ON pl.id = c.plot_id
       JOIN farm_crops fc ON fc.id = c.crop_id
      WHERE c.farm_id=$1 AND c.status IN ('PLANNED','GROWING','HARVESTING')
      ORDER BY pl.code`, [farmId]);

  const plots = cycles.map((c: any) => ({
    cycleId: c.id, plotId: c.plot_id, plotCode: c.plot_code,
    cropName: c.crop_name, cropNameHi: c.crop_name_hi,
    cropAgeDays: Number(c.crop_age_days), health: c.health,
    irrigation: irrigationDecision({
      crop: {
        irrigationIntervalDays: Number(c.irrigation_interval_days),
        irrigationIntervalDaysHot: c.irrigation_interval_days_hot != null
          ? Number(c.irrigation_interval_days_hot) : null,
      },
      cropAgeDays: Number(c.crop_age_days),
      lastIrrigationDate: c.last_irrigation ?? null,
      today,
      weather: pass.weather,
    }),
    harvest: harvestReadiness({
      status: c.status,
      expectedHarvestDate: c.expected_harvest_date,
      expectedHarvestEndDate: c.expected_harvest_end_date,
      today,
      harvestedKg: Number(c.harvested_kg),
      expectedYieldKg: Number(c.expected_yield_kg),
    }),
  }));

  const [progress] = await query(actor,
    `SELECT count(*) FILTER (WHERE due_date = CURRENT_DATE)::int                       AS today_total,
            count(*) FILTER (WHERE due_date = CURRENT_DATE AND status='DONE')::int     AS today_done,
            count(*) FILTER (WHERE due_date = CURRENT_DATE AND status='PROBLEM')::int  AS today_problem,
            count(*) FILTER (WHERE status='PENDING' AND due_date < CURRENT_DATE)::int  AS overdue,
            COALESCE(SUM(CASE WHEN due_date = CURRENT_DATE AND status='SKIPPED' THEN 1 ELSE 0 END),0)::int AS today_skipped
       FROM farm_tasks WHERE farm_id=$1`, [farmId]);

  const [dayClose] = await query(actor,
    `SELECT * FROM farm_day_closes WHERE farm_id=$1 AND close_date=CURRENT_DATE`, [farmId]);

  return {
    farm, date: today,
    weather: pass.weather, advice: pass.advice,
    tasks: tasks.map((t: any) => ({
      ...t,
      colour: taskColour({ dueDate: t.due_date, status: t.status }, today),
      isOverdue: t.due_date < today,
      isTomorrow: t.due_date > today,
    })),
    plots, progress, dayClosed: !!dayClose, dayClose: dayClose ?? null,
  };
}

/* --- §3: DONE | PROBLEM | SKIP. Three buttons, no form. ------------------ */
farmingRouter.post('/tasks/:id/action', requires('farming.task.complete'), h(async (req) => {
  const input = body(z.object({
    action: z.enum(['DONE', 'PROBLEM', 'SKIP']),
    // Only asked for when the task genuinely needs it (a fertiliser dose).
    actualQty: z.number().nonnegative().nullable().optional(),
    note: z.string().optional(),
    problemCode: z.enum(['DISEASE', 'PEST', 'WEATHER', 'WATER', 'MACHINE',
      'LABOUR', 'INPUT_MISSING', 'OTHER']).nullable().optional(),
    // A problem is worth a photo; a completed irrigation is not.
    photoData: z.string().max(8_000_000).nullable().optional(),
    photoMime: z.string().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: tr } = await tx.query(
      `SELECT t.*, fc.irrigation_interval_days, fc.irrigation_interval_days_hot,
              c.sowing_date, c.status AS cycle_status, pl.code AS plot_code, fc.name AS crop_name
         FROM farm_tasks t
         LEFT JOIN farm_crop_cycles c ON c.id = t.cycle_id
         LEFT JOIN farm_crops fc ON fc.id = c.crop_id
         LEFT JOIN farm_plots pl ON pl.id = t.plot_id
        WHERE t.id=$1 AND t.company_id=$2 FOR UPDATE OF t`,
      [req.params.id, req.actor.companyId]);
    const t = tr[0];
    if (!t) throw ApiError.notFound('Task not found');
    if (t.status !== 'PENDING') {
      throw ApiError.rule(`This task is already marked ${t.status.toLowerCase()}.`);
    }
    if (input.action === 'PROBLEM' && !input.problemCode) {
      throw ApiError.rule('Choose what the problem is, so the manager knows what to send.');
    }
    if (input.action === 'DONE' && t.requires_qty && input.actualQty == null) {
      throw ApiError.rule(`How much ${t.input_name ?? 'input'} was actually used?`);
    }

    const status = input.action === 'DONE' ? 'DONE' : input.action === 'PROBLEM' ? 'PROBLEM' : 'SKIPPED';
    const { rows: up } = await tx.query(
      `UPDATE farm_tasks
          SET status=$2, actual_qty=$3, note=$4, problem_code=$5,
              done_at=now(), done_by=$6, severity=$7, updated_by=$6
        WHERE id=$1 RETURNING *`,
      [t.id, status, input.actualQty ?? null, input.note ?? null,
       input.problemCode ?? null, req.actor.userId,
       status === 'PROBLEM' ? 'RED' : 'GREEN']);
    const task = up[0];

    /* --- §4: finishing a job sets the next one's date automatically ------- */
    if (input.action === 'DONE' && t.task_type === 'IRRIGATION' && t.cycle_id
        && t.cycle_status !== 'CLOSED') {
      const interval = Number(t.irrigation_interval_days ?? 4);
      const next = addDays(todayIso(), interval);
      await insertTask(tx, req.actor, {
        branchId: t.branch_id, farmId: t.farm_id, plotId: t.plot_id, cycleId: t.cycle_id,
        taskType: 'IRRIGATION', title: 'Irrigation', titleHi: 'सिंचाई',
        dueDate: next,
        dayNumber: t.sowing_date ? daysBetween(t.sowing_date, next) : null,
        source: 'SYSTEM', dedupeKey: `${t.cycle_id}:IRRIGATION:${next}:auto`,
      });
    }

    // A problem is a crop-health event too — one action, both records.
    if (input.action === 'PROBLEM' && t.cycle_id) {
      await tx.query(
        `INSERT INTO farm_observations (company_id, farm_id, plot_id, cycle_id, task_id,
                day_number, health, issue_code, note, photo_data, photo_mime, observed_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'RED',$7,$8,$9,$10,$11,$11)`,
        [req.actor.companyId, t.farm_id, t.plot_id, t.cycle_id, t.id, t.day_number,
         input.problemCode, input.note ?? null, input.photoData ?? null,
         input.photoMime ?? null, req.actor.userId]);

      await raiseAlert(tx, req.actor, {
        branchId: t.branch_id, alertType: 'CROP_HEALTH_RED', severity: 'CRITICAL',
        entityType: 'farm_task', entityId: t.id,
        title: `Problem on Plot-${t.plot_code ?? '?'}: ${t.title}`,
        message: `${input.problemCode}${input.note ? ` — ${input.note}` : ''}`,
        meta: { taskId: t.id, cycleId: t.cycle_id, problemCode: input.problemCode },
      });
    }

    if (t.farm_id) await runDailyPass(tx, req.actor, t.farm_id);
    await emit(tx, req.actor, 'farm_task', t.id, 'farm.task.actioned',
      { action: input.action, taskType: t.task_type, cycleId: t.cycle_id });

    return task;
  });
}));

/** An ad-hoc job the calendar could not have known about. */
farmingRouter.post('/tasks', requires('farming.task.complete'), h(async (req) => {
  const input = body(z.object({
    farmId: z.string().uuid(),
    plotId: z.string().uuid().nullable().optional(),
    cycleId: z.string().uuid().nullable().optional(),
    taskType: z.enum(['IRRIGATION', 'FERTILIZER', 'SPRAY', 'INSPECTION', 'WEEDING', 'HARVEST', 'MACHINE', 'OTHER']),
    title: z.string().min(2),
    dueDate: z.string().default(todayIso()),
    requiresQty: z.boolean().default(false),
    inputName: z.string().nullable().optional(),
    inputUom: z.string().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: f } = await tx.query(
      `SELECT branch_id FROM farms WHERE id=$1 AND company_id=$2`,
      [input.farmId, req.actor.companyId]);
    if (!f[0]) throw ApiError.notFound('Farm not found');
    const id = await insertTask(tx, req.actor, {
      branchId: f[0].branch_id, farmId: input.farmId, plotId: input.plotId,
      cycleId: input.cycleId, taskType: input.taskType, title: input.title,
      dueDate: input.dueDate, inputName: input.inputName, inputUom: input.inputUom,
      requiresQty: input.requiresQty, source: 'MANUAL',
      dedupeKey: `manual:${req.actor.userId}:${input.title}:${input.dueDate}:${input.plotId ?? 'farm'}`,
    });
    if (!id) throw ApiError.conflict('That task is already on the list for that day.');
    const { rows } = await tx.query(`SELECT * FROM farm_tasks WHERE id=$1`, [id]);
    return rows[0];
  });
}));

/* --- §10 / §11: crop health in one tap, plus a photo for the diary ------- */
farmingRouter.post('/observations', requires('farming.task.complete'), h(async (req) => {
  const input = body(z.object({
    cycleId: z.string().uuid(),
    health: z.enum(['GREEN', 'YELLOW', 'RED']),
    stage: z.enum(['SOWING', 'GERMINATION', 'VEGETATIVE', 'FLOWERING', 'FRUITING', 'HARVEST'])
      .nullable().optional(),
    issueCode: z.string().nullable().optional(),
    note: z.string().optional(),
    photoData: z.string().max(8_000_000).nullable().optional(),
    photoMime: z.string().nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: cr } = await tx.query(
      `SELECT c.*, pl.code AS plot_code, fc.name AS crop_name
         FROM farm_crop_cycles c
         JOIN farm_plots pl ON pl.id = c.plot_id
         JOIN farm_crops fc ON fc.id = c.crop_id
        WHERE c.id=$1 AND c.company_id=$2`, [input.cycleId, req.actor.companyId]);
    const c = cr[0];
    if (!c) throw ApiError.notFound('Crop cycle not found');

    const dayNumber = daysBetween(c.sowing_date, todayIso());
    const { rows } = await tx.query(
      `INSERT INTO farm_observations (company_id, farm_id, plot_id, cycle_id, task_id,
              day_number, health, stage, issue_code, note, photo_data, photo_mime,
              observed_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
      [req.actor.companyId, c.farm_id, c.plot_id, c.id, input.taskId ?? null, dayNumber,
       input.health, input.stage ?? null, input.issueCode ?? null, input.note ?? null,
       input.photoData ?? null, input.photoMime ?? null, req.actor.userId]);

    // §10 — yellow or red goes to the manager without anyone forwarding it.
    if (input.health !== 'GREEN') {
      await raiseAlert(tx, req.actor, {
        branchId: c.branch_id,
        alertType: input.health === 'RED' ? 'CROP_HEALTH_RED' : 'CROP_HEALTH_YELLOW',
        severity: input.health === 'RED' ? 'CRITICAL' : 'MEDIUM',
        entityType: 'farm_crop_cycle', entityId: c.id,
        title: `Plot-${c.plot_code} ${c.crop_name}: crop check is ${input.health.toLowerCase()}`,
        message: input.note || `Day ${dayNumber} health check flagged ${input.health.toLowerCase()}.`,
        meta: { cycleNo: c.cycle_no, dayNumber, issueCode: input.issueCode },
      });
    }
    if (input.taskId) {
      await tx.query(
        `UPDATE farm_tasks SET status='DONE', done_at=now(), done_by=$2, updated_by=$2
          WHERE id=$1 AND status='PENDING'`, [input.taskId, req.actor.userId]);
    }
    await runDailyPass(tx, req.actor, c.farm_id);
    return rows[0];
  });
}));

/* --- §9: weather in, so the advice can come out ------------------------- */
farmingRouter.post('/weather', h(async (req) => {
  const input = body(z.object({
    farmId: z.string().uuid(),
    weatherDate: z.string().default(todayIso()),
    tempMinC: z.number().nullable().optional(),
    tempMaxC: z.number().nullable().optional(),
    rainMm: z.number().nonnegative().default(0),
    rainProbPct: z.number().min(0).max(100).nullable().optional(),
    windKmph: z.number().nonnegative().nullable().optional(),
    humidityPct: z.number().min(0).max(100).nullable().optional(),
    condition: z.string().nullable().optional(),
    source: z.enum(['MANUAL', 'FORECAST', 'API']).default('MANUAL'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO farm_weather (company_id, farm_id, weather_date, temp_min_c, temp_max_c,
              rain_mm, rain_prob_pct, wind_kmph, humidity_pct, condition, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (farm_id, weather_date) DO UPDATE SET
         temp_min_c=EXCLUDED.temp_min_c, temp_max_c=EXCLUDED.temp_max_c,
         rain_mm=EXCLUDED.rain_mm, rain_prob_pct=EXCLUDED.rain_prob_pct,
         wind_kmph=EXCLUDED.wind_kmph, humidity_pct=EXCLUDED.humidity_pct,
         condition=EXCLUDED.condition, source=EXCLUDED.source, fetched_at=now()
       RETURNING *`,
      [req.actor.companyId, input.farmId, input.weatherDate, input.tempMinC ?? null,
       input.tempMaxC ?? null, input.rainMm, input.rainProbPct ?? null,
       input.windKmph ?? null, input.humidityPct ?? null, input.condition ?? null, input.source]);
    if (input.weatherDate === todayIso()) await runDailyPass(tx, req.actor, input.farmId);
    return rows[0];
  });
}));

/* ===========================================================================
 * §13 §14 §15 — HARVEST. Scan, weigh, grade, print. Everything else is ours.
 * ======================================================================== */

farmingRouter.post('/harvests', requires('farming.harvest.record'), h(async (req) => {
  const input = body(z.object({
    cycleId: z.string().uuid(),
    harvestDate: z.string().optional(),
    // A connected scale sends grossWeightKg itself; typing it is the fallback.
    grossWeightKg: z.number().positive('Weigh the crates'),
    crateCount: z.number().int().nonnegative().default(0),
    containerTypeId: z.string().uuid().nullable().optional(),
    captureMode: z.enum(['MANUAL', 'SCALE']).default('MANUAL'),
    scaleDeviceId: z.string().uuid().nullable().optional(),
    // Only four grades exist. Anything not listed is assumed to be grade A.
    grades: z.array(z.object({
      grade: z.enum(['A', 'B', 'C', 'WASTE']),
      weightKg: z.number().nonnegative(),
      crateCount: z.number().int().nonnegative().default(0),
    })).default([]),
    remarks: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: cr } = await tx.query(
      `SELECT c.*, f.name AS farm_name, pl.code AS plot_code, fc.name AS crop_name
         FROM farm_crop_cycles c
         JOIN farms f ON f.id = c.farm_id
         JOIN farm_plots pl ON pl.id = c.plot_id
         JOIN farm_crops fc ON fc.id = c.crop_id
        WHERE c.id=$1 AND c.company_id=$2 FOR UPDATE OF c`,
      [input.cycleId, req.actor.companyId]);
    const c = cr[0];
    if (!c) throw ApiError.notFound('Crop cycle not found');
    if (['CLOSED', 'FAILED'].includes(c.status)) {
      throw ApiError.rule('This crop is closed. Start a new cycle to harvest again.');
    }

    const harvestDate = input.harvestDate ?? todayIso();
    // §13 — the tare comes from the crate master. Nobody types it.
    let tare = 0;
    if (input.containerTypeId && input.crateCount > 0) {
      const { rows: ct } = await tx.query(
        `SELECT tare_kg FROM container_types WHERE id=$1 AND company_id=$2`,
        [input.containerTypeId, req.actor.companyId]);
      tare = round(Number(ct[0]?.tare_kg ?? 0) * input.crateCount, 3);
    }
    const net = round(Math.max(input.grossWeightKg - tare, 0), 3);

    const graded = input.grades.filter((g) => g.weightKg > 0);
    const gradedTotal = round(graded.reduce((a, g) => a + g.weightKg, 0), 3);
    if (graded.length && Math.abs(gradedTotal - net) > Math.max(net * 0.02, 0.5)) {
      throw ApiError.rule(
        `The grades add up to ${gradedTotal} kg but the net weight is ${net} kg. They must match.`);
    }
    const lines = graded.length ? graded
      : [{ grade: 'A' as const, weightKg: net, crateCount: input.crateCount }];

    const harvestNo = await nextDocNo(tx, req.actor, c.branch_id, 'HARV');
    const cropAge = daysBetween(c.sowing_date, harvestDate);
    // The crate QR is printed here; the warehouse scan resolves it back to
    // this harvest, this plot and this sowing (§28).
    const labelCode = `${harvestNo.replace(/\//g, '-')}`;

    const { rows: hr } = await tx.query(
      `INSERT INTO farm_harvests (company_id, branch_id, farm_id, plot_id, cycle_id, product_id,
              harvest_no, harvest_date, crop_age_days, gross_weight_kg, tare_weight_kg,
              net_weight_kg, crate_count, container_type_id, capture_mode, scale_device_id,
              label_code, status, harvested_by, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'READY',$18,$19,$18,$18)
       RETURNING *`,
      [req.actor.companyId, c.branch_id, c.farm_id, c.plot_id, c.id, c.product_id,
       harvestNo, harvestDate, cropAge, input.grossWeightKg, tare, net, input.crateCount,
       input.containerTypeId ?? null, input.captureMode, input.scaleDeviceId ?? null,
       labelCode, req.actor.userId, input.remarks ?? null]);
    const harvest = hr[0];

    for (const l of lines) {
      await tx.query(
        `INSERT INTO farm_harvest_lines (company_id, harvest_id, grade, weight_kg, crate_count,
                destination, label_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.actor.companyId, harvest.id, l.grade, l.weightKg, l.crateCount ?? 0,
         destinationForGrade(l.grade), `${labelCode}-${l.grade}`]);
    }

    // §21 — waste is a loss with a reason, not a rounding difference.
    const waste = lines.find((l) => l.grade === 'WASTE');
    if (waste && waste.weightKg > 0) {
      await tx.query(
        `INSERT INTO farm_losses (company_id, farm_id, plot_id, cycle_id, loss_date, reason,
                qty_kg, note, reported_by, created_by)
         VALUES ($1,$2,$3,$4,$5,'HARVEST_DAMAGE',$6,'Graded as waste at harvest',$7,$7)`,
        [req.actor.companyId, c.farm_id, c.plot_id, c.id, harvestDate, waste.weightKg,
         req.actor.userId]);
    }

    await tx.query(
      `UPDATE farm_crop_cycles SET status='HARVESTING', updated_by=$2
        WHERE id=$1 AND status IN ('PLANNED','GROWING')`,
      [c.id, req.actor.userId]);
    await refreshCycleTotals(tx, c.id);

    // Close the harvest task for the day rather than leaving it nagging.
    await tx.query(
      `UPDATE farm_tasks SET status='DONE', done_at=now(), done_by=$2, updated_by=$2
        WHERE cycle_id=$1 AND task_type='HARVEST' AND status='PENDING'
          AND due_date <= CURRENT_DATE`, [c.id, req.actor.userId]);

    // §20 — measure the estimate the moment the window closes.
    const { rows: after } = await tx.query(
      `SELECT harvested_kg, expected_yield_kg, expected_harvest_end_date
         FROM farm_crop_cycles WHERE id=$1`, [c.id]);
    const yv = yieldVariance(Number(after[0].expected_yield_kg), Number(after[0].harvested_kg));
    // Mid-window, "91% below expected" is arithmetic, not information — a
    // multi-pick crop is *supposed* to be short after its first pick. The
    // estimate is only judged once the picking window has closed.
    const windowClosed = after[0].expected_harvest_end_date <= harvestDate;
    if (yv.colour !== 'GREEN' && windowClosed) {
      await raiseAlert(tx, req.actor, {
        branchId: c.branch_id, alertType: 'YIELD_BELOW_EXPECTED',
        severity: yv.colour === 'RED' ? 'HIGH' : 'MEDIUM',
        entityType: 'farm_crop_cycle', entityId: c.id,
        title: `${c.crop_name} on Plot-${c.plot_code}: ${yv.label}`,
        message: 'Next season\'s plan for this crop will use this result.',
        meta: { expected: after[0].expected_yield_kg, actual: after[0].harvested_kg, diffPct: yv.diffPct },
      });
    }

    // The warehouse can start preparing before the lorry leaves.
    await pushTask(tx, req.actor, {
      branchId: c.branch_id, queueKey: 'FARM_HARVEST',
      docType: 'FARM_HARVEST', docId: harvest.id, docNo: harvestNo,
      title: `Send ${qty(net)} kg ${c.crop_name} to the warehouse`,
      subtitle: `Plot-${c.plot_code} · ${input.crateCount} crate(s)`,
      requiredPermission: 'farming.dispatch.create', slaMinutes: 240,
      payload: { harvestId: harvest.id, netKg: net },
    });

    await emit(tx, req.actor, 'farm_harvest', harvest.id, 'farm.harvest.recorded', {
      harvestNo, cycleId: c.id, netKg: net, grades: lines,
    });

    return {
      ...harvest,
      lines: lines.map((l) => ({ ...l, destination: destinationForGrade(l.grade),
        labelCode: `${labelCode}-${l.grade}` })),
      // Everything the crate label needs, so the print dialog asks nothing.
      label: {
        code: labelCode,
        farm: c.farm_name, plot: c.plot_code, crop: c.crop_name,
        harvestNo, harvestDate, cropAgeDays: cropAge, netKg: net, crates: input.crateCount,
      },
      yieldVariance: windowClosed ? yv : null,
      harvestProgress: {
        harvestedKg: Number(after[0].harvested_kg),
        expectedYieldKg: Number(after[0].expected_yield_kg),
        pctOfExpected: Number(after[0].expected_yield_kg) > 0
          ? round(100 * Number(after[0].harvested_kg) / Number(after[0].expected_yield_kg), 1) : null,
        windowEnds: after[0].expected_harvest_end_date,
      },
    };
  });
}));

farmingRouter.get('/harvests', h(async (req) =>
  query(req.actor,
    `SELECT h.*, pl.code AS plot_code, fc.name AS crop_name, c.cycle_no,
            p.name AS product_name, u.full_name AS harvested_by_name,
            (SELECT json_agg(json_build_object('grade',l.grade,'weightKg',l.weight_kg,
                      'crateCount',l.crate_count,'dispatchedKg',l.dispatched_kg,
                      'destination',l.destination) ORDER BY l.grade)
               FROM farm_harvest_lines l WHERE l.harvest_id=h.id) AS lines
       FROM farm_harvests h
       JOIN farm_crop_cycles c ON c.id = h.cycle_id
       JOIN farm_plots pl ON pl.id = h.plot_id
       JOIN farm_crops fc ON fc.id = c.crop_id
       LEFT JOIN products p ON p.id = h.product_id
       LEFT JOIN users u ON u.id = h.harvested_by
      WHERE h.company_id=$1
        AND ($2::uuid IS NULL OR h.farm_id=$2)
        AND ($3 = '' OR h.status = $3)
      ORDER BY h.harvest_date DESC, h.created_at DESC LIMIT 200`,
    [req.actor.companyId, req.query.farmId ?? null, String(req.query.status ?? '')])));

/* ===========================================================================
 * §16 — FARM → WAREHOUSE. Dispatch, then receive, and the difference between
 * the two is the number that matters.
 * ======================================================================== */

farmingRouter.post('/dispatches', requires('farming.dispatch.create'), h(async (req) => {
  const input = body(z.object({
    farmId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    dispatchDate: z.string().optional(),
    vehicleId: z.string().uuid().nullable().optional(),
    vehicleReg: z.string().nullable().optional(),
    driverName: z.string().nullable().optional(),
    lines: z.array(z.object({
      harvestId: z.string().uuid(),
      grade: z.enum(['A', 'B', 'C', 'WASTE']),
      weightKg: z.number().positive(),
      crateCount: z.number().int().nonnegative().default(0),
    })).min(1, 'Nothing to send'),
    remarks: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: f } = await tx.query(
      `SELECT branch_id, name FROM farms WHERE id=$1 AND company_id=$2 AND is_own`,
      [input.farmId, req.actor.companyId]);
    if (!f[0]) throw ApiError.notFound('Farm not found');

    const dispatchNo = await nextDocNo(tx, req.actor, f[0].branch_id, 'FDN');
    const total = round(input.lines.reduce((a, l) => a + l.weightKg, 0), 3);

    const { rows: dr } = await tx.query(
      `INSERT INTO farm_dispatches (company_id, branch_id, farm_id, warehouse_id, dispatch_no,
              dispatch_date, vehicle_id, vehicle_reg, driver_name, dispatch_weight_kg,
              status, dispatched_by, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DISPATCHED',$11,$12,$11,$11) RETURNING *`,
      [req.actor.companyId, f[0].branch_id, input.farmId, input.warehouseId, dispatchNo,
       input.dispatchDate ?? todayIso(), input.vehicleId ?? null, input.vehicleReg ?? null,
       input.driverName ?? null, total, req.actor.userId, input.remarks ?? null]);
    const dispatch = dr[0];

    for (const l of input.lines) {
      const { rows: hr } = await tx.query(
        `SELECT h.*, hl.weight_kg AS grade_weight, hl.dispatched_kg, c.product_id AS cycle_product
           FROM farm_harvests h
           JOIN farm_harvest_lines hl ON hl.harvest_id = h.id AND hl.grade = $2
           JOIN farm_crop_cycles c ON c.id = h.cycle_id
          WHERE h.id=$1 AND h.company_id=$3 FOR UPDATE OF h`,
        [l.harvestId, l.grade, req.actor.companyId]);
      const hv = hr[0];
      if (!hv) throw ApiError.notFound(`Harvest line ${l.grade} not found`);

      const available = round(Number(hv.grade_weight) - Number(hv.dispatched_kg), 3);
      if (l.weightKg > available + 0.001) {
        throw ApiError.rule(
          `Only ${available} kg of grade ${l.grade} is left on ${hv.harvest_no}, not ${l.weightKg} kg.`);
      }
      const productId = hv.product_id ?? hv.cycle_product;
      if (!productId) {
        throw ApiError.rule(
          `The crop on ${hv.harvest_no} is not linked to a product, so it cannot enter stock. ` +
          'Set the product on the crop master first.');
      }

      // §19 — the crate carries the farm's own cost per kg into inventory, so
      // the warehouse values home-grown stock at what it really cost to grow.
      const { rows: cost } = await tx.query(
        `SELECT c.harvested_kg, c.waste_kg,
                COALESCE((SELECT SUM(amount) FROM farm_expenses e WHERE e.cycle_id=c.id),0) AS spent
           FROM farm_crop_cycles c WHERE c.id=$1`, [hv.cycle_id]);
      const sellable = Math.max(Number(cost[0].harvested_kg) - Number(cost[0].waste_kg), 0);
      const ratePerKg = sellable > 0 ? round(Number(cost[0].spent) / sellable, 6) : null;

      await tx.query(
        `INSERT INTO farm_dispatch_lines (company_id, dispatch_id, harvest_id, cycle_id,
                product_id, grade, dispatch_weight_kg, crate_count, rate_per_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.actor.companyId, dispatch.id, l.harvestId, hv.cycle_id, productId, l.grade,
         l.weightKg, l.crateCount, ratePerKg]);

      await tx.query(
        `UPDATE farm_harvest_lines SET dispatched_kg = dispatched_kg + $3
          WHERE harvest_id=$1 AND grade=$2`, [l.harvestId, l.grade, l.weightKg]);
    }

    // Mark each harvest fully or partly sent, from the lines rather than a flag.
    await tx.query(
      `UPDATE farm_harvests h SET status = CASE
              WHEN t.remaining <= 0.001 THEN 'DISPATCHED' ELSE 'PART_DISPATCHED' END,
              updated_by = $2
         FROM (SELECT hl.harvest_id, SUM(hl.weight_kg - hl.dispatched_kg) AS remaining
                 FROM farm_harvest_lines hl
                WHERE hl.harvest_id IN (SELECT DISTINCT harvest_id FROM farm_dispatch_lines
                                         WHERE dispatch_id = $1)
                GROUP BY hl.harvest_id) t
        WHERE h.id = t.harvest_id`, [dispatch.id, req.actor.userId]);

    await tx.query(
      `UPDATE work_queue SET resolved_at=now(), resolved_by=$1
        WHERE queue_key='FARM_HARVEST' AND doc_type='FARM_HARVEST' AND resolved_at IS NULL
          AND doc_id IN (SELECT harvest_id FROM farm_dispatch_lines WHERE dispatch_id=$2)`,
      [req.actor.userId, dispatch.id]);

    await pushTask(tx, req.actor, {
      branchId: f[0].branch_id, warehouseId: input.warehouseId, queueKey: 'FARM_RECEIVE',
      docType: 'FARM_DISPATCH', docId: dispatch.id, docNo: dispatchNo,
      title: `Receive ${qty(total)} kg from ${f[0].name}`,
      subtitle: input.vehicleReg ? `Vehicle ${input.vehicleReg}` : 'Farm dispatch',
      requiredPermission: 'farming.dispatch.receive', slaMinutes: 180,
      payload: { dispatchId: dispatch.id, dispatchKg: total },
    });

    for (const l of input.lines) await refreshCycleTotals(tx, (await tx.query(
      `SELECT cycle_id FROM farm_harvests WHERE id=$1`, [l.harvestId])).rows[0].cycle_id);

    await emit(tx, req.actor, 'farm_dispatch', dispatch.id, 'farm.dispatch.created',
      { dispatchNo, warehouseId: input.warehouseId, totalKg: total });

    return dispatch;
  });
}));

farmingRouter.get('/dispatches', h(async (req) =>
  query(req.actor,
    `SELECT d.*, f.name AS farm_name, w.name AS warehouse_name,
            du.full_name AS dispatched_by_name, ru.full_name AS received_by_name,
            (SELECT json_agg(json_build_object('id',dl.id,'grade',dl.grade,
                      'productName',p.name,'harvestNo',h.harvest_no,
                      'dispatchWeightKg',dl.dispatch_weight_kg,
                      'receivedWeightKg',dl.received_weight_kg,
                      'crateCount',dl.crate_count,'batchId',dl.batch_id) ORDER BY dl.grade)
               FROM farm_dispatch_lines dl
               JOIN products p ON p.id = dl.product_id
               JOIN farm_harvests h ON h.id = dl.harvest_id
              WHERE dl.dispatch_id = d.id) AS lines
       FROM farm_dispatches d
       JOIN farms f ON f.id = d.farm_id
       JOIN warehouses w ON w.id = d.warehouse_id
       LEFT JOIN users du ON du.id = d.dispatched_by
       LEFT JOIN users ru ON ru.id = d.received_by
      WHERE d.company_id=$1
        AND ($2 = '' OR d.status = $2)
        AND ($3::uuid IS NULL OR d.warehouse_id = $3)
      ORDER BY d.dispatch_date DESC, d.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? ''), req.query.warehouseId ?? null])));

/* ---------------------------------------------------------------------------
 * RECEIVING — the moment farm produce becomes ordinary stock.
 *
 * This is the farming module's equivalent of posting a GRN, and it obeys the
 * same three rules: one transaction, idempotent, and the ledger is written
 * exactly once. uq_ledger_grn_line covers (ref_type, ref_line_id, txn_type),
 * so a retried receive collides at the database rather than doubling stock.
 * ------------------------------------------------------------------------ */
farmingRouter.post('/dispatches/:id/receive', requires('farming.dispatch.receive'), h(async (req) => {
  const input = body(z.object({
    idempotencyKey: z.string().min(8, 'Missing idempotency key'),
    lines: z.array(z.object({
      lineId: z.string().uuid(),
      receivedWeightKg: z.number().nonnegative(),
    })).min(1, 'Weigh what arrived'),
    varianceReason: z.string().optional(),
    remarks: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: idem } = await tx.query(
      `INSERT INTO idempotency_keys (key, company_id, user_id, endpoint, request_hash, state)
       VALUES ($1,$2,$3,'POST /farming/dispatch/receive',$4,'IN_PROGRESS')
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [input.idempotencyKey, req.actor.companyId, req.actor.userId,
       Buffer.from(JSON.stringify(input.lines)).toString('base64').slice(0, 64)]);
    if (idem.length === 0) {
      const { rows: prev } = await tx.query(
        `SELECT response_body FROM idempotency_keys WHERE key=$1`, [input.idempotencyKey]);
      if (prev[0]?.response_body) return prev[0].response_body;
      throw ApiError.conflict('This dispatch is already being received. Please wait a moment.');
    }

    const s = await farmSettings(tx, req.actor);
    const { rows: dr } = await tx.query(
      `SELECT d.*, f.name AS farm_name FROM farm_dispatches d
         JOIN farms f ON f.id = d.farm_id
        WHERE d.id=$1 AND d.company_id=$2 FOR UPDATE OF d`,
      [req.params.id, req.actor.companyId]);
    const d = dr[0];
    if (!d) throw ApiError.notFound('Dispatch not found');
    if (d.status !== 'DISPATCHED') {
      throw ApiError.rule(`This dispatch is already ${d.status.toLowerCase()}.`);
    }

    const byId = new Map(input.lines.map((l) => [l.lineId, l.receivedWeightKg]));
    const { rows: lines } = await tx.query(
      `SELECT dl.*, p.name AS product_name, p.sku, p.shelf_life_days, p.is_batch_tracked,
              p.rotation_rule, p.base_uom, c.cycle_no, c.sowing_date, h.harvest_date,
              h.harvest_no, pl.code AS plot_code
         FROM farm_dispatch_lines dl
         JOIN products p ON p.id = dl.product_id
         JOIN farm_crop_cycles c ON c.id = dl.cycle_id
         JOIN farm_harvests h ON h.id = dl.harvest_id
         JOIN farm_plots pl ON pl.id = h.plot_id
        WHERE dl.dispatch_id = $1 ORDER BY dl.grade`, [req.params.id]);

    let receivedTotal = 0;
    const batches: any[] = [];

    for (const l of lines) {
      const received = byId.get(l.id);
      if (received === undefined) {
        throw ApiError.badRequest(`Grade ${l.grade} was on the lorry but has no received weight.`);
      }
      receivedTotal = round(receivedTotal + received, 3);

      await tx.query(
        `UPDATE farm_dispatch_lines SET received_weight_kg=$2 WHERE id=$1`, [l.id, received]);
      // Waste never becomes sellable stock, and neither does a zero line.
      if (received <= 0 || l.grade === 'WASTE') continue;

      const batchNo = await nextDocNo(tx, req.actor, d.branch_id, 'BATCH');
      const { rows: br } = await tx.query(
        `INSERT INTO batches (company_id, branch_id, warehouse_id, batch_no, product_id,
                farm_id, received_date, harvest_date, expiry_date, shelf_life_days, grade,
                initial_qty, remaining_qty, net_weight_kg, remaining_weight_kg,
                landed_rate, landed_rate_per_kg, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 CASE WHEN $9::int IS NULL THEN NULL ELSE $8::date + $9::int END,
                 $9,$10,
                 -- Produce is weighed, so quantity and weight are the same
                 -- number in two different domains. Cast, or Postgres cannot
                 -- deduce one type for the shared parameter.
                 $11::numeric,$11::numeric,$11::numeric,$11::numeric,
                 $12::numeric,$12::numeric,'ACTIVE',$13,$13)
         RETURNING *`,
        [req.actor.companyId, d.branch_id, d.warehouse_id, batchNo, l.product_id,
         d.farm_id, d.dispatch_date, l.harvest_date, l.shelf_life_days, l.grade,
         received, l.rate_per_kg ?? 0, req.actor.userId]);
      const batch = br[0];

      // §28 — the label is the whole story: plot, sowing, harvest, crate.
      const lotCode = await nextDocNo(tx, req.actor, d.branch_id, 'LABEL');
      await tx.query(
        `INSERT INTO labels (company_id, batch_id, label_type, code, qr_payload, created_by)
         VALUES ($1,$2,'LOT',$3,$4,$5)`,
        [req.actor.companyId, batch.id, lotCode.replace(/\//g, '-'),
         JSON.stringify({
           sku: l.sku, product: l.product_name, batch: batchNo, grade: l.grade,
           source: 'OWN_FARM', farm: d.farm_name, plot: l.plot_code,
           cycle: l.cycle_no, sowingDate: l.sowing_date, harvestNo: l.harvest_no,
           harvestDate: l.harvest_date, dispatch: d.dispatch_no, weightKg: received,
           expiry: batch.expiry_date,
         }), req.actor.userId]);

      // THE inventory posting. TRANSFER_IN, because nothing was purchased —
      // this produce moved between two places the company already owns.
      await tx.query(
        `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
                direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id,
                ref_line_id, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,'IN',$6::numeric,$6::numeric,$7,$8,$9,
                 'TRANSFER_IN','farm_dispatch',$10,$11,now(),$12)`,
        [req.actor.companyId, d.branch_id, d.warehouse_id, l.product_id, batch.id,
         received, l.base_uom ?? 'KG', l.rate_per_kg ?? 0,
         money(received * Number(l.rate_per_kg ?? 0)), d.id, l.id, req.actor.userId]);

      await tx.query(
        `INSERT INTO stock_balances (company_id, warehouse_id, product_id, batch_id, qty, weight_kg)
         VALUES ($1,$2,$3,$4,$5::numeric,$5::numeric)
         ON CONFLICT (product_id, batch_id, warehouse_id) DO UPDATE
           SET qty = stock_balances.qty + EXCLUDED.qty,
               weight_kg = stock_balances.weight_kg + EXCLUDED.weight_kg,
               updated_at = now()`,
        [req.actor.companyId, d.warehouse_id, l.product_id, batch.id, received]);

      await tx.query(`UPDATE farm_dispatch_lines SET batch_id=$2 WHERE id=$1`, [l.id, batch.id]);
      batches.push({ ...batch, productName: l.product_name, grade: l.grade, weightKg: received });
    }

    /* --- the number this whole flow exists for --------------------------- */
    const v = dispatchVariance(Number(d.dispatch_weight_kg), receivedTotal,
      s.varianceWarnPct, s.varianceCritPct);
    if (v.breached && !input.varianceReason) {
      throw ApiError.rule(
        `${Math.abs(v.varianceKg)} kg is missing between the farm and the warehouse ` +
        `(${v.variancePct}%). Give a reason before this can be received.`);
    }

    await tx.query(
      `UPDATE farm_dispatches
          SET received_weight_kg=$2, variance_kg=$3, variance_pct=$4, variance_band=$5,
              variance_reason=$6, status='RECEIVED', received_by=$7, received_at=now(),
              idempotency_key=$8, remarks=COALESCE($9, remarks), updated_by=$7
        WHERE id=$1`,
      [d.id, receivedTotal, v.varianceKg, v.variancePct, v.band, input.varianceReason ?? null,
       req.actor.userId, input.idempotencyKey, input.remarks ?? null]);

    if (v.band === 'RED' || v.band === 'CRITICAL') {
      await raiseAlert(tx, req.actor, {
        branchId: d.branch_id, alertType: 'FARM_DISPATCH_VARIANCE',
        severity: v.band === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        entityType: 'farm_dispatch', entityId: d.id,
        title: `${d.dispatch_no}: ${Math.abs(v.varianceKg)} kg short on arrival`,
        message: `Farm sent ${d.dispatch_weight_kg} kg, warehouse received ${receivedTotal} kg ` +
                 `(${v.variancePct}%). Reason given: ${input.varianceReason ?? 'none'}.`,
        meta: { dispatchNo: d.dispatch_no, ...v },
      });
      // §21 — an unexplained gap is a loss, and it belongs on the crop.
      for (const l of lines) {
        await tx.query(
          `INSERT INTO farm_losses (company_id, farm_id, plot_id, cycle_id, loss_date, reason,
                  qty_kg, note, reported_by, created_by)
           SELECT $1,$2,h.plot_id,$3,CURRENT_DATE,'OTHER',$4,$5,$6,$6
             FROM farm_harvests h WHERE h.id=$7`,
          [req.actor.companyId, d.farm_id, l.cycle_id,
           round(Math.abs(v.varianceKg) * (Number(l.dispatch_weight_kg) / Math.max(Number(d.dispatch_weight_kg), 1)), 3),
           `Transit variance on ${d.dispatch_no}: ${input.varianceReason ?? 'unexplained'}`,
           req.actor.userId, l.harvest_id]);
      }
    }

    for (const cycleId of [...new Set(lines.map((l: any) => l.cycle_id))]) {
      await refreshCycleTotals(tx, cycleId as string);
    }

    await resolveTask(tx, req.actor, 'FARM_RECEIVE', 'FARM_DISPATCH', d.id);
    await emit(tx, req.actor, 'farm_dispatch', d.id, 'farm.dispatch.received', {
      dispatchNo: d.dispatch_no, dispatchKg: Number(d.dispatch_weight_kg),
      receivedKg: receivedTotal, variance: v, batches: batches.map((b) => b.batch_no),
    });

    const response = { dispatchId: d.id, dispatchNo: d.dispatch_no, receivedTotal, variance: v, batches };
    await tx.query(
      `UPDATE idempotency_keys SET state='COMPLETED', response_body=$2, status_code=200,
              completed_at=now() WHERE key=$1`,
      [input.idempotencyKey, JSON.stringify(response)]);
    return response;
  });
}));

/* ===========================================================================
 * §18 §21 — MONEY IN, LOSS OUT. Both as short as they can possibly be.
 * ======================================================================== */

farmingRouter.post('/expenses', requires('farming.expense.create'), h(async (req) => {
  // Expense type, amount, save. Farm, plot, crop, date and user are attached
  // by the system from the context the user is already standing in.
  const input = body(z.object({
    farmId: z.string().uuid(),
    expenseType: z.enum(['SEED', 'FERTILIZER', 'PESTICIDE', 'LABOUR', 'WATER', 'ELECTRICITY',
      'MACHINE', 'FUEL', 'HARVEST', 'PACKING', 'TRANSPORT', 'RENT', 'OTHER']),
    amount: z.number().positive('Enter the amount'),
    cycleId: z.string().uuid().nullable().optional(),
    plotId: z.string().uuid().nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
    machineId: z.string().uuid().nullable().optional(),
    expenseDate: z.string().optional(),
    qty: z.number().nonnegative().nullable().optional(),
    uom: z.string().nullable().optional(),
    note: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: f } = await tx.query(
      `SELECT branch_id FROM farms WHERE id=$1 AND company_id=$2`,
      [input.farmId, req.actor.companyId]);
    if (!f[0]) throw ApiError.notFound('Farm not found');

    // If a plot has one live crop, the expense belongs to it. Asking would be
    // asking the user to repeat something the system already knows.
    let cycleId = input.cycleId ?? null;
    let plotId = input.plotId ?? null;
    if (!cycleId && plotId) {
      const { rows } = await tx.query(
        `SELECT id FROM farm_crop_cycles WHERE plot_id=$1
          AND status IN ('PLANNED','GROWING','HARVESTING') LIMIT 1`, [plotId]);
      cycleId = rows[0]?.id ?? null;
    }
    if (cycleId && !plotId) {
      const { rows } = await tx.query(`SELECT plot_id FROM farm_crop_cycles WHERE id=$1`, [cycleId]);
      plotId = rows[0]?.plot_id ?? null;
    }

    const { rows } = await tx.query(
      `INSERT INTO farm_expenses (company_id, branch_id, farm_id, plot_id, cycle_id, task_id,
              machine_id, expense_date, expense_type, amount, qty, uom, note, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
      [req.actor.companyId, f[0].branch_id, input.farmId, plotId, cycleId,
       input.taskId ?? null, input.machineId ?? null, input.expenseDate ?? todayIso(),
       input.expenseType, money(input.amount), input.qty ?? null, input.uom ?? null,
       input.note ?? null, req.actor.userId]);

    if (cycleId) await refreshCycleTotals(tx, cycleId);
    return rows[0];
  });
}));

farmingRouter.get('/expenses', requires('farming.cost.view', 'farming.expense.create'), h(async (req) =>
  query(req.actor,
    `SELECT e.*, f.name AS farm_name, pl.code AS plot_code, c.cycle_no,
            fc.name AS crop_name, u.full_name AS by_name
       FROM farm_expenses e
       JOIN farms f ON f.id = e.farm_id
       LEFT JOIN farm_plots pl ON pl.id = e.plot_id
       LEFT JOIN farm_crop_cycles c ON c.id = e.cycle_id
       LEFT JOIN farm_crops fc ON fc.id = c.crop_id
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.company_id=$1
        AND ($2::uuid IS NULL OR e.farm_id=$2)
        AND ($3::uuid IS NULL OR e.cycle_id=$3)
      ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 300`,
    [req.actor.companyId, req.query.farmId ?? null, req.query.cycleId ?? null])));

farmingRouter.post('/losses', requires('farming.loss.record'), h(async (req) => {
  const input = body(z.object({
    cycleId: z.string().uuid(),
    reason: z.enum(['DISEASE', 'PEST', 'WEATHER', 'WATER', 'QUALITY_REJECT',
      'HARVEST_DAMAGE', 'SUSPECTED_THEFT', 'OTHER']),
    qtyKg: z.number().nonnegative().default(0),
    note: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: cr } = await tx.query(
      `SELECT c.*, COALESCE((SELECT SUM(amount) FROM farm_expenses e WHERE e.cycle_id=c.id),0) AS spent
         FROM farm_crop_cycles c WHERE c.id=$1 AND c.company_id=$2`,
      [input.cycleId, req.actor.companyId]);
    const c = cr[0];
    if (!c) throw ApiError.notFound('Crop cycle not found');

    // §21 — the user chose a reason. The value is ours to work out, from what
    // the crop has actually cost so far.
    const sellable = Math.max(Number(c.harvested_kg) - Number(c.waste_kg), 0);
    const perKg = sellable > 0
      ? Number(c.spent) / sellable
      : Number(c.expected_yield_kg) > 0 ? Number(c.spent) / Number(c.expected_yield_kg) : 0;

    const { rows } = await tx.query(
      `INSERT INTO farm_losses (company_id, farm_id, plot_id, cycle_id, loss_date, reason,
              qty_kg, estimated_value, note, reported_by, created_by)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.actor.companyId, c.farm_id, c.plot_id, c.id, input.reason, input.qtyKg,
       money(input.qtyKg * perKg), input.note ?? null, req.actor.userId]);

    if (input.reason === 'SUSPECTED_THEFT' || input.qtyKg > Number(c.expected_yield_kg) * 0.05) {
      await raiseAlert(tx, req.actor, {
        branchId: c.branch_id, alertType: 'CROP_HEALTH_RED', severity: 'CRITICAL',
        entityType: 'farm_crop_cycle', entityId: c.id,
        title: `${input.qtyKg} kg lost on ${c.cycle_no} — ${input.reason.replace(/_/g, ' ').toLowerCase()}`,
        message: input.note ?? 'Reported from the field.',
        meta: { reason: input.reason, qtyKg: input.qtyKg, estimatedValue: money(input.qtyKg * perKg) },
      });
    }
    await refreshCycleTotals(tx, c.id);
    return rows[0];
  });
}));

/* ===========================================================================
 * §31 — DAY CLOSE. One button. The system reads the day and writes the report.
 * ======================================================================== */

farmingRouter.post('/day-close', requires('farming.task.complete'), h(async (req) => {
  const input = body(z.object({
    farmId: z.string().uuid(),
    closeDate: z.string().optional(),
    note: z.string().optional(),
  }), req.body);
  const closeDate = input.closeDate ?? todayIso();

  return withTx(req.actor, async (tx) => {
    await runDailyPass(tx, req.actor, input.farmId);

    const { rows: sum } = await tx.query(
      `SELECT
         (SELECT count(*) FROM farm_tasks t WHERE t.farm_id=$1 AND t.due_date=$2)::int          AS tasks_total,
         (SELECT count(*) FROM farm_tasks t WHERE t.farm_id=$1 AND t.due_date=$2
            AND t.status='DONE')::int                                                          AS tasks_done,
         (SELECT count(*) FROM farm_tasks t WHERE t.farm_id=$1 AND t.due_date<=$2
            AND t.status='PENDING')::int                                                       AS tasks_pending,
         (SELECT count(*) FROM farm_tasks t WHERE t.farm_id=$1 AND t.status='PROBLEM'
            AND t.done_at::date=$2)::int                                                       AS tasks_problem,
         COALESCE((SELECT SUM(h.net_weight_kg) FROM farm_harvests h
                    WHERE h.farm_id=$1 AND h.harvest_date=$2),0)                               AS harvest_kg,
         COALESCE((SELECT SUM(d.dispatch_weight_kg) FROM farm_dispatches d
                    WHERE d.farm_id=$1 AND d.dispatch_date=$2 AND d.status<>'CANCELLED'),0)    AS dispatch_kg,
         COALESCE((SELECT SUM(e.amount) FROM farm_expenses e
                    WHERE e.farm_id=$1 AND e.expense_date=$2),0)                               AS expense_amount,
         (SELECT count(*) FROM farm_observations o WHERE o.farm_id=$1
            AND o.observed_at::date=$2 AND o.health<>'GREEN')::int                             AS problems_count,
         COALESCE((SELECT CASE WHEN bool_or(c.health='RED') THEN 'RED'
                               WHEN bool_or(c.health='YELLOW') THEN 'YELLOW' ELSE 'GREEN' END
                     FROM farm_crop_cycles c WHERE c.farm_id=$1
                      AND c.status IN ('PLANNED','GROWING','HARVESTING')),'GREEN')             AS health`,
      [input.farmId, closeDate]);
    const s = sum[0];

    const { rows } = await tx.query(
      `INSERT INTO farm_day_closes (company_id, farm_id, close_date, tasks_total, tasks_done,
              tasks_pending, tasks_problem, harvest_kg, dispatch_kg, expense_amount,
              problems_count, health, summary, closed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (farm_id, close_date) DO UPDATE SET
         tasks_total=EXCLUDED.tasks_total, tasks_done=EXCLUDED.tasks_done,
         tasks_pending=EXCLUDED.tasks_pending, tasks_problem=EXCLUDED.tasks_problem,
         harvest_kg=EXCLUDED.harvest_kg, dispatch_kg=EXCLUDED.dispatch_kg,
         expense_amount=EXCLUDED.expense_amount, problems_count=EXCLUDED.problems_count,
         health=EXCLUDED.health, summary=EXCLUDED.summary,
         closed_by=EXCLUDED.closed_by, closed_at=now()
       RETURNING *`,
      [req.actor.companyId, input.farmId, closeDate, s.tasks_total, s.tasks_done,
       s.tasks_pending, s.tasks_problem, s.harvest_kg, s.dispatch_kg, s.expense_amount,
       s.problems_count, s.health, JSON.stringify({ note: input.note ?? null }), req.actor.userId]);

    await emit(tx, req.actor, 'farm', input.farmId, 'farm.day.closed',
      { date: closeDate, ...s });
    return rows[0];
  });
}));

/* ===========================================================================
 * §24 §25 §26 §27 §30 §32 — WHAT THE OWNER AND THE BUYER ACTUALLY LOOK AT.
 * ======================================================================== */

/** §24 — the seven-day harvest forecast, so sales and the warehouse can plan. */
farmingRouter.get('/harvest-forecast', h(async (req) => {
  const days = Math.min(Number(req.query.days ?? 7), 30);
  const rows = await query(req.actor,
    `SELECT harvest_date::text, product_id, product_name, sku, round(expected_kg, 2) AS expected_kg
       FROM v_farm_harvest_forecast
      WHERE company_id = $1 AND harvest_date <= CURRENT_DATE + $2::int
      ORDER BY harvest_date, product_name`,
    [req.actor.companyId, days]);

  const byDay: Record<string, number> = {};
  const byProduct: Record<string, { productId: string; productName: string; kg: number }> = {};
  for (const r of rows) {
    byDay[r.harvest_date] = round((byDay[r.harvest_date] ?? 0) + Number(r.expected_kg), 2);
    const p = byProduct[r.product_id] ?? { productId: r.product_id, productName: r.product_name, kg: 0 };
    p.kg = round(p.kg + Number(r.expected_kg), 2);
    byProduct[r.product_id] = p;
  }
  const today = todayIso();
  const sumTo = (n: number) => round(Object.entries(byDay)
    .filter(([d]) => daysBetween(today, d) <= n).reduce((a, [, v]) => a + v, 0), 2);

  return {
    rows, byDay, byProduct: Object.values(byProduct).sort((a, b) => b.kg - a.kg),
    summary: {
      today: byDay[today] ?? 0,
      tomorrow: byDay[addDays(today, 1)] ?? 0,
      next3Days: sumTo(3),
      next7Days: sumTo(7),
    },
  };
}));

/**
 * §25 — the join that stops the buyer buying what the field is about to send.
 * Called with a product and a quantity the warehouse needs.
 */
farmingRouter.get('/supply-plan', h(async (req) => {
  const productId = String(req.query.productId ?? '');
  const demandKg = Number(req.query.demandKg ?? 0);
  if (!productId) throw ApiError.badRequest('Which product?');

  const today = todayIso();
  const rows = await query(req.actor,
    `SELECT harvest_date::text, expected_kg FROM v_farm_harvest_forecast
      WHERE company_id=$1 AND product_id=$2 AND harvest_date <= CURRENT_DATE + 7`,
    [req.actor.companyId, productId]);

  const on = (d: string) => round(rows.filter((r: any) => r.harvest_date === d)
    .reduce((a: number, r: any) => a + Number(r.expected_kg), 0), 2);
  const next7 = round(rows.reduce((a: number, r: any) => a + Number(r.expected_kg), 0), 2);

  const plan = supplyPlan({
    demandKg, farmToday: on(today), farmTomorrow: on(addDays(today, 1)), farmNext7: next7,
  });
  const [p] = await query(req.actor,
    `SELECT id, name, sku FROM products WHERE id=$1 AND company_id=$2`,
    [productId, req.actor.companyId]);
  return { product: p ?? null, ...plan, farmNext7Days: next7 };
}));

/**
 * §26 §27 §30 — the planning screen. Sixty days of demand against sixty days
 * of expected production, priced against the market, with a recommendation
 * the owner is free to overrule.
 */
farmingRouter.get('/planning', requires('farming.report.view'), h(async (req) => {
  const candidates = await query(req.actor,
    `SELECT fc.id AS crop_id, fc.code AS crop_code, fc.name AS crop_name, fc.product_id,
            fc.duration_days, fc.water_need, fc.seasons, fc.avoid_after_crop_codes,
            p.name AS product_name, p.sku,
            -- 60 days of demand, projected from the last 60 days of real sales
            COALESCE((SELECT SUM(ds.qty) FROM demand_signals ds
                       WHERE ds.product_id = fc.product_id AND ds.signal_type='SALE'
                         AND ds.signal_date >= CURRENT_DATE - 60), 0)               AS demand_kg,
            COALESCE((SELECT SUM(GREATEST(c.expected_yield_kg - c.harvested_kg, 0))
                        FROM farm_crop_cycles c
                       WHERE c.product_id = fc.product_id
                         AND c.status IN ('PLANNED','GROWING','HARVESTING')
                         AND c.expected_harvest_date <= CURRENT_DATE + 60), 0)      AS expected_supply_kg,
            (SELECT mp.modal_price FROM market_prices mp
               WHERE mp.product_id = fc.product_id ORDER BY mp.price_date DESC LIMIT 1) AS market_rate,
            (SELECT CASE WHEN SUM(c.harvested_kg - c.waste_kg) > 0
                         THEN SUM(c.actual_cost) / SUM(c.harvested_kg - c.waste_kg) END
               FROM farm_crop_cycles c
              WHERE c.crop_id = fc.id AND c.status='CLOSED')                        AS historical_cost_per_kg
       FROM farm_crops fc
       LEFT JOIN products p ON p.id = fc.product_id
      WHERE fc.company_id=$1 AND fc.is_active`,
    [req.actor.companyId]);

  const month = new Date().getUTCMonth() + 1;
  const season = month >= 6 && month <= 10 ? 'KHARIF' : month >= 11 || month <= 3 ? 'RABI' : 'SUMMER';

  const previousCropCode = req.query.plotId
    ? (await query(req.actor,
        `SELECT fc.code FROM farm_crop_cycles c JOIN farm_crops fc ON fc.id=c.crop_id
          WHERE c.plot_id=$1 ORDER BY c.sowing_date DESC LIMIT 1`, [req.query.plotId]))[0]?.code ?? null
    : null;

  /* How much water the farm actually has is a fact we already hold — asking
   * for it, or assuming the pessimistic middle, would veto crops a tube well
   * comfortably supports. A borewell or canal is a year-round supply; a pond
   * or river is seasonal; rain-fed is whatever falls. */
  const WATER_BY_SOURCE: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
    TUBE_WELL: 'HIGH', BOREWELL: 'HIGH', CANAL: 'HIGH', DRIP: 'HIGH',
    RIVER: 'MEDIUM', POND: 'MEDIUM', OTHER: 'MEDIUM', RAIN_FED: 'LOW',
  };
  const [waterRow] = await query(req.actor,
    `SELECT CASE WHEN bool_or(f.water_source IN ('TUBE_WELL','BOREWELL','CANAL','DRIP')) THEN 'HIGH'
                 WHEN bool_or(f.water_source IN ('RIVER','POND','OTHER')) THEN 'MEDIUM'
                 ELSE 'LOW' END AS water
       FROM farms f
      WHERE f.company_id=$1 AND f.is_own AND f.status='ACTIVE'
        AND ($2::uuid IS NULL OR f.id=$2)`,
    [req.actor.companyId, req.query.farmId ?? null]);
  const water = (req.query.water as string) || waterRow?.water
    || WATER_BY_SOURCE.OTHER;

  const suggestions = suggestNextCrop({
    candidates: candidates.map((c: any) => ({
      cropId: c.crop_id, cropCode: c.crop_code, cropName: c.crop_name, productId: c.product_id,
      demandKg: Number(c.demand_kg), expectedSupplyKg: Number(c.expected_supply_kg),
      marketRatePerKg: c.market_rate != null ? Number(c.market_rate) : null,
      historicalCostPerKg: c.historical_cost_per_kg != null ? Number(c.historical_cost_per_kg) : null,
      durationDays: Number(c.duration_days), waterNeed: c.water_need,
      seasons: c.seasons ?? [], avoidAfterCropCodes: c.avoid_after_crop_codes ?? [],
    })),
    previousCropCode,
    season,
    waterAvailability: water as any,
  });

  // §27 — buy vs grow, per crop, using this farm's own measured cost.
  const comparison = candidates.map((c: any) => ({
    cropId: c.crop_id, cropCode: c.crop_code, cropName: c.crop_name,
    productName: c.product_name, sku: c.sku,
    ...buyVsGrow({
      ownCostPerKg: c.historical_cost_per_kg != null ? Number(c.historical_cost_per_kg) : null,
      marketRatePerKg: c.market_rate != null ? Number(c.market_rate) : null,
      riskPremiumPct: 8,
    }),
  }));

  return { season, previousCropCode, waterAvailability: water, suggestions, comparison };
}));

/** §22 — staff performance, from what happened, per period. */
farmingRouter.get('/staff-performance', requires('farming.report.view'), h(async (req) => {
  const days = Math.min(Number(req.query.days ?? 30), 180);
  const rows = await query(req.actor,
    `SELECT u.id, u.full_name,
            count(t.id) FILTER (WHERE t.done_by = u.id)::int                           AS tasks_done,
            count(t.id) FILTER (WHERE t.done_by = u.id
                                 AND t.done_at::date <= t.due_date)::int               AS tasks_on_time,
            count(t.id) FILTER (WHERE t.done_by = u.id AND t.status='PROBLEM')::int    AS problems_raised,
            count(t.id) FILTER (WHERE t.done_by = u.id AND t.severity='RED')::int      AS red_issues,
            COALESCE((SELECT SUM(h.net_weight_kg) FROM farm_harvests h
                       WHERE h.harvested_by = u.id
                         AND h.harvest_date >= CURRENT_DATE - $2::int), 0)             AS harvest_kg,
            (SELECT CASE WHEN SUM(hl.weight_kg) > 0
                         THEN 100.0 * SUM(hl.weight_kg) FILTER (WHERE hl.grade='A') / SUM(hl.weight_kg) END
               FROM farm_harvests h JOIN farm_harvest_lines hl ON hl.harvest_id = h.id
              WHERE h.harvested_by = u.id AND h.harvest_date >= CURRENT_DATE - $2::int) AS grade_a_pct,
            (SELECT CASE WHEN SUM(hl.weight_kg) > 0
                         THEN 100.0 * SUM(hl.weight_kg) FILTER (WHERE hl.grade='WASTE') / SUM(hl.weight_kg) END
               FROM farm_harvests h JOIN farm_harvest_lines hl ON hl.harvest_id = h.id
              WHERE h.harvested_by = u.id AND h.harvest_date >= CURRENT_DATE - $2::int) AS waste_pct
       FROM users u
       LEFT JOIN farm_tasks t ON t.done_by = u.id AND t.done_at >= CURRENT_DATE - $2::int
      WHERE u.company_id = $1 AND u.status='ACTIVE'
      GROUP BY u.id, u.full_name
     HAVING count(t.id) > 0
         OR EXISTS (SELECT 1 FROM farm_harvests h WHERE h.harvested_by = u.id
                     AND h.harvest_date >= CURRENT_DATE - $2::int)
      ORDER BY u.full_name`,
    [req.actor.companyId, days]);

  return rows.map((r: any) => {
    // Assigned = everything that fell due in the window on farms this person
    // works. Simplified here to what they touched plus what is still pending.
    const assigned = Number(r.tasks_done) + Number(r.problems_raised);
    const score = staffScore({
      tasksAssigned: Math.max(assigned, Number(r.tasks_done)),
      tasksDone: Number(r.tasks_done),
      tasksOnTime: Number(r.tasks_on_time),
      redIssues: Number(r.red_issues),
      gradeAPct: r.grade_a_pct != null ? Number(r.grade_a_pct) : null,
      wastePct: r.waste_pct != null ? Number(r.waste_pct) : null,
    });
    return {
      userId: r.id, name: r.full_name,
      tasksDone: Number(r.tasks_done), tasksOnTime: Number(r.tasks_on_time),
      problemsRaised: Number(r.problems_raised), redIssues: Number(r.red_issues),
      harvestKg: Number(r.harvest_kg),
      gradeAPct: r.grade_a_pct != null ? round(Number(r.grade_a_pct), 1) : null,
      wastePct: r.waste_pct != null ? round(Number(r.waste_pct), 1) : null,
      ...score,
    };
  }).sort((a: any, b: any) => b.score - a.score);
}));

/** §28 — one batch, its whole life, from the seed that made it. */
farmingRouter.get('/traceability/:batchId', h(async (req) => {
  const [row] = await query(req.actor,
    `SELECT * FROM v_farm_traceability WHERE batch_id=$1 AND company_id=$2`,
    [req.params.batchId, req.actor.companyId]);
  if (!row) {
    throw ApiError.notFound('That batch did not come from an own farm — check the purchase trail instead.');
  }
  const movements = await query(req.actor,
    `SELECT sl.direction, sl.qty, sl.weight_kg, sl.txn_type, sl.ref_type, sl.posted_at,
            w.name AS warehouse_name
       FROM stock_ledger sl JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.batch_id=$1 ORDER BY sl.posted_at`, [req.params.batchId]);
  const observations = await query(req.actor,
    `SELECT o.observed_at, o.day_number, o.health, o.note, o.photo_data
       FROM farm_observations o
       JOIN farm_crop_cycles c ON c.id = o.cycle_id
       JOIN farm_dispatch_lines dl ON dl.cycle_id = c.id
      WHERE dl.batch_id=$1 ORDER BY o.observed_at`, [req.params.batchId]);
  return { batch: row, movements, observations };
}));

/** §32 — the owner's dashboard. Nine numbers and a colour. */
farmingRouter.get('/dashboard', h(async (req) => {
  const farmId = (req.query.farmId as string) || null;
  const canSeeCost = req.actor.permissions.has('farming.cost.view')
    || req.actor.permissions.has('data.cost.view')
    || req.actor.permissions.has('admin.override');

  const [k] = await query(req.actor,
    `SELECT
       (SELECT count(*) FROM farms WHERE company_id=$1 AND is_own AND status='ACTIVE')::int AS farms,
       (SELECT count(*) FROM farm_crop_cycles c WHERE c.company_id=$1
          AND c.status IN ('PLANNED','GROWING','HARVESTING')
          AND ($2::uuid IS NULL OR c.farm_id=$2))::int                                  AS live_crops,
       (SELECT count(*) FROM farm_tasks t WHERE t.company_id=$1 AND t.due_date=CURRENT_DATE
          AND ($2::uuid IS NULL OR t.farm_id=$2))::int                                  AS tasks_today,
       (SELECT count(*) FROM farm_tasks t WHERE t.company_id=$1 AND t.due_date=CURRENT_DATE
          AND t.status='DONE' AND ($2::uuid IS NULL OR t.farm_id=$2))::int              AS tasks_done,
       (SELECT count(*) FROM farm_tasks t WHERE t.company_id=$1 AND t.status='PENDING'
          AND t.due_date < CURRENT_DATE AND ($2::uuid IS NULL OR t.farm_id=$2))::int    AS tasks_overdue,
       (SELECT count(*) FROM farm_crop_cycles c WHERE c.company_id=$1 AND c.health='RED'
          AND c.status IN ('PLANNED','GROWING','HARVESTING')
          AND ($2::uuid IS NULL OR c.farm_id=$2))::int                                  AS critical_problems,
       COALESCE((SELECT SUM(h.net_weight_kg) FROM farm_harvests h
                  WHERE h.company_id=$1 AND h.harvest_date=CURRENT_DATE
                    AND ($2::uuid IS NULL OR h.farm_id=$2)),0)                          AS harvest_today,
       COALESCE((SELECT SUM(d.dispatch_weight_kg) FROM farm_dispatches d
                  WHERE d.company_id=$1 AND d.dispatch_date=CURRENT_DATE
                    AND d.status<>'CANCELLED' AND ($2::uuid IS NULL OR d.farm_id=$2)),0) AS dispatched_today,
       COALESCE((SELECT SUM(e.amount) FROM farm_expenses e
                  WHERE e.company_id=$1 AND e.expense_date=CURRENT_DATE
                    AND ($2::uuid IS NULL OR e.farm_id=$2)),0)                          AS expense_today,
       COALESCE((SELECT SUM(l.qty_kg) FROM farm_losses l
                  WHERE l.company_id=$1 AND l.loss_date >= CURRENT_DATE - 30
                    AND ($2::uuid IS NULL OR l.farm_id=$2)),0)                          AS loss_30d,
       COALESCE((SELECT CASE WHEN bool_or(c.health='RED') THEN 'RED'
                             WHEN bool_or(c.health='YELLOW') THEN 'YELLOW' ELSE 'GREEN' END
                   FROM farm_crop_cycles c WHERE c.company_id=$1
                    AND c.status IN ('PLANNED','GROWING','HARVESTING')
                    AND ($2::uuid IS NULL OR c.farm_id=$2)),'GREEN')                    AS farm_health`,
    [req.actor.companyId, farmId]);

  // Cost per kg is only a real number once a crop has finished: dividing a
  // growing crop's spend-to-date by the little that has been picked so far
  // produces an alarming figure that means nothing. So the headline comes from
  // FINISHED crops, and money still in the ground is reported separately.
  const [cost] = canSeeCost ? await query(req.actor,
    `SELECT
       COALESCE((SELECT SUM(c.actual_cost) FROM farm_crop_cycles c
                  WHERE c.company_id=$1 AND c.status IN ('PLANNED','GROWING','HARVESTING')
                    AND ($2::uuid IS NULL OR c.farm_id=$2)), 0)            AS cost_open_crops,
       COALESCE((SELECT SUM(c.expected_yield_kg - c.harvested_kg)
                   FROM farm_crop_cycles c
                  WHERE c.company_id=$1 AND c.status IN ('PLANNED','GROWING','HARVESTING')
                    AND ($2::uuid IS NULL OR c.farm_id=$2)), 0)            AS pipeline_kg,
       (SELECT CASE WHEN SUM(c.harvested_kg - c.waste_kg) > 0
                    THEN round(SUM(c.actual_cost) / SUM(c.harvested_kg - c.waste_kg), 2) END
          FROM farm_crop_cycles c
         WHERE c.company_id=$1 AND c.status = 'CLOSED'
           AND c.closed_at >= now() - interval '365 days'
           AND ($2::uuid IS NULL OR c.farm_id=$2))                         AS cost_per_kg,
       (SELECT count(*)::int FROM farm_crop_cycles c
         WHERE c.company_id=$1 AND c.status='CLOSED'
           AND c.closed_at >= now() - interval '365 days'
           AND ($2::uuid IS NULL OR c.farm_id=$2))                         AS closed_cycles`,
    [req.actor.companyId, farmId]) : [null];

  const crops = await query(req.actor,
    `SELECT * FROM v_farm_crop_status
      WHERE company_id=$1 AND status IN ('PLANNED','GROWING','HARVESTING')
        AND ($2::uuid IS NULL OR farm_id=$2)
      ORDER BY CASE health WHEN 'RED' THEN 0 WHEN 'YELLOW' THEN 1 ELSE 2 END,
               days_to_harvest NULLS LAST LIMIT 20`,
    [req.actor.companyId, farmId]);

  const problems = await query(req.actor,
    `SELECT t.id, t.title, t.problem_code, t.note, t.done_at, pl.code AS plot_code,
            fc.name AS crop_name, u.full_name AS by_name
       FROM farm_tasks t
       LEFT JOIN farm_plots pl ON pl.id = t.plot_id
       LEFT JOIN farm_crop_cycles c ON c.id = t.cycle_id
       LEFT JOIN farm_crops fc ON fc.id = c.crop_id
       LEFT JOIN users u ON u.id = t.done_by
      WHERE t.company_id=$1 AND t.status='PROBLEM'
        AND ($2::uuid IS NULL OR t.farm_id=$2)
      ORDER BY t.done_at DESC LIMIT 15`,
    [req.actor.companyId, farmId]);

  // The harvest forecast is the number the warehouse actually plans against.
  const forecast = await query(req.actor,
    `SELECT harvest_date::text, round(SUM(expected_kg),2) AS expected_kg
       FROM v_farm_harvest_forecast
      WHERE company_id=$1 AND harvest_date <= CURRENT_DATE + 7
      GROUP BY harvest_date ORDER BY harvest_date`, [req.actor.companyId]);

  const today = todayIso();
  return {
    kpis: k,
    cost: canSeeCost ? cost : null,
    crops, problems,
    forecast,
    forecastSummary: {
      today: Number(forecast.find((f: any) => f.harvest_date === today)?.expected_kg ?? 0),
      tomorrow: Number(forecast.find((f: any) => f.harvest_date === addDays(today, 1))?.expected_kg ?? 0),
      next7Days: round(forecast.reduce((a: number, f: any) => a + Number(f.expected_kg), 0), 2),
    },
  };
}));

/* --- §30: the crop is finished. What next? ------------------------------- */
farmingRouter.post('/crop-cycles/:id/close', requires('farming.crop.close'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().optional(),
    failed: z.boolean().default(false),
    revenue: z.number().nonnegative().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: cr } = await tx.query(
      `SELECT * FROM farm_crop_cycles WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const c = cr[0];
    if (!c) throw ApiError.notFound('Crop cycle not found');
    if (['CLOSED', 'FAILED'].includes(c.status)) throw ApiError.rule('This crop is already closed.');
    if (input.failed && !input.reason) {
      throw ApiError.rule('A failed crop needs a reason — it feeds next season\'s plan.');
    }

    await refreshCycleTotals(tx, c.id);
    await tx.query(
      `UPDATE farm_crop_cycles
          SET status=$2, closed_at=now(), closed_by=$3, close_reason=$4,
              revenue=COALESCE($5, revenue), updated_by=$3
        WHERE id=$1`,
      [c.id, input.failed ? 'FAILED' : 'CLOSED', req.actor.userId, input.reason ?? null,
       input.revenue ?? null]);

    // Nothing left to do on a closed crop; clear the list rather than let it rot.
    await tx.query(
      `UPDATE farm_tasks SET status='CANCELLED', updated_by=$2
        WHERE cycle_id=$1 AND status='PENDING'`, [c.id, req.actor.userId]);
    await tx.query(
      `UPDATE farm_plots SET status='RESTING', updated_by=$2 WHERE id=$1`,
      [c.plot_id, req.actor.userId]);

    await emit(tx, req.actor, 'farm_crop_cycle', c.id, 'farm.crop.closed', {
      cycleNo: c.cycle_no, harvestedKg: Number(c.harvested_kg),
      expectedKg: Number(c.expected_yield_kg), failed: input.failed,
    });

    const { rows: final } = await tx.query(`SELECT * FROM farm_crop_cycles WHERE id=$1`, [c.id]);
    return {
      cycle: final[0],
      yieldVariance: yieldVariance(Number(c.expected_yield_kg), Number(final[0].harvested_kg)),
      cost: cropCost({
        expenses: (await tx.query(
          `SELECT expense_type, amount FROM farm_expenses WHERE cycle_id=$1`, [c.id]))
          .rows.map((e: any) => ({ expenseType: e.expense_type, amount: Number(e.amount) })),
        estimatedCost: Number(c.estimated_cost),
        harvestedKg: Number(final[0].harvested_kg),
        wasteKg: Number(final[0].waste_kg),
      }),
      // The screen that follows this one asks "next crop?" — give it the answer.
      nextCropUrl: `/api/farming/planning?plotId=${c.plot_id}`,
    };
  });
}));

/** Manual trigger for the daily pass — used by the refresh button and by cron. */
farmingRouter.post('/farms/:id/refresh', h(async (req) =>
  withTx(req.actor, (tx) => runDailyPass(tx, req.actor, req.params.id))));
