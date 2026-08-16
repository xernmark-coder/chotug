import { pool } from '../db.js';
import { hashPassword } from '../platform/auth.js';
import { planCrop } from '../domain/farming.js';

const COMPANY = '01919000-0000-7000-8000-000000000001';
const BRANCH = '01919000-0000-7000-8000-000000000011';
const FARM = '01919000-0000-7000-8000-000000000084';

/* Realistic daily demand per SKU: a base level, a weekend lift, and noise.
 * Without this the forecast and the requirement note have nothing to work
 * with, and the whole planning screen looks broken on a fresh install. */
const DEMAND_PROFILE: Record<string, { base: number; weekendLift: number; noise: number }> = {
  'VEG-POT-01': { base: 180, weekendLift: 1.35, noise: 0.18 },
  'VEG-ONI-01': { base: 220, weekendLift: 1.30, noise: 0.20 },
  'VEG-TOM-01': { base: 120, weekendLift: 1.40, noise: 0.28 },
  'FRU-BAN-01': { base: 95, weekendLift: 1.25, noise: 0.22 },
  'FRU-MAN-01': { base: 60, weekendLift: 1.55, noise: 0.35 },
  'FRU-APP-01': { base: 70, weekendLift: 1.30, noise: 0.20 },
  'VEG-SPI-01': { base: 35, weekendLift: 1.20, noise: 0.30 },
  'VEG-CAU-01': { base: 55, weekendLift: 1.28, noise: 0.25 },
};

const PRICE_BASE: Record<string, number> = {
  'VEG-POT-01': 18, 'VEG-ONI-01': 26, 'VEG-TOM-01': 32, 'FRU-BAN-01': 42,
  'FRU-MAN-01': 145, 'FRU-APP-01': 118, 'VEG-SPI-01': 28, 'VEG-CAU-01': 24,
};

async function seedPasswords() {
  const hash = await hashPassword('chotug123');
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $1, password_changed_at = now()
      WHERE company_id = $2 AND password_hash IS NULL`, [hash, COMPANY]);
  console.log(`  passwords set for ${rowCount} demo user(s) (password: chotug123)`);
}

async function seedDemand() {
  const { rows: products } = await pool.query(
    `SELECT id, sku FROM products WHERE company_id = $1`, [COMPANY]);

  await pool.query(
    `DELETE FROM demand_signals WHERE company_id = $1 AND signal_date >= CURRENT_DATE - 90`,
    [COMPANY]);

  let inserted = 0;
  for (const p of products) {
    const profile = DEMAND_PROFILE[p.sku];
    if (!profile) continue;
    const values: string[] = [];
    const params: any[] = [];
    let i = 1;

    for (let d = 90; d >= 1; d--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - d);
      const dow = date.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      // Slow upward drift so the damped trend has something to find.
      const drift = 1 + (90 - d) * 0.0012;
      const qty = Math.max(0, Math.round(
        profile.base * drift * (isWeekend ? profile.weekendLift : 1) *
        (1 + (Math.random() - 0.5) * 2 * profile.noise)));

      values.push(`($${i++},$${i++},$${i++},$${i++},'SALE',$${i++})`);
      params.push(COMPANY, BRANCH, p.id, date.toISOString().slice(0, 10), qty);
      inserted++;
    }

    // A few forward advance orders so ADVANCE_ORDER triggers show up.
    if (Math.random() > 0.6) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + 2);
      values.push(`($${i++},$${i++},$${i++},$${i++},'ADVANCE_ORDER',$${i++})`);
      params.push(COMPANY, BRANCH, p.id, date.toISOString().slice(0, 10),
        Math.round(profile.base * 0.8));
      inserted++;
    }

    await pool.query(
      `INSERT INTO demand_signals (company_id, branch_id, product_id, signal_date, signal_type, qty)
       VALUES ${values.join(',')}`, params);
  }
  console.log(`  ${inserted} demand signals over the last 90 days`);
}

async function seedMarketPrices() {
  const { rows: products } = await pool.query(
    `SELECT id, sku, name FROM products WHERE company_id = $1`, [COMPANY]);
  const { rows: mandi } = await pool.query(
    `SELECT id, name FROM mandis WHERE company_id = $1 LIMIT 1`, [COMPANY]);

  let inserted = 0;
  for (const p of products) {
    const base = PRICE_BASE[p.sku];
    if (!base) continue;
    // Give a couple of commodities a real trend so the price signal has
    // something honest to say rather than always "stable".
    const trend = ['VEG-TOM-01', 'FRU-MAN-01'].includes(p.sku) ? 0.006
      : ['VEG-ONI-01'].includes(p.sku) ? -0.004 : 0;

    for (let d = 30; d >= 0; d--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - d);
      const modal = base * (1 + trend * (30 - d)) * (1 + (Math.random() - 0.5) * 0.09);
      await pool.query(
        `INSERT INTO market_prices (company_id, product_id, commodity_name, mandi_id, market_name,
              price_date, min_price, max_price, modal_price, arrival_qty, uom, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'KG','MANUAL')
         ON CONFLICT (commodity_name, market_name, price_date, source) DO NOTHING`,
        [COMPANY, p.id, p.name, mandi[0]?.id ?? null, mandi[0]?.name ?? 'Pune APMC',
         date.toISOString().slice(0, 10),
         Math.round(modal * 0.88 * 100) / 100, Math.round(modal * 1.12 * 100) / 100,
         Math.round(modal * 100) / 100, Math.round(2000 + Math.random() * 6000)]);
      inserted++;
    }
  }
  console.log(`  ${inserted} market price rows for the last 30 days`);
}

async function seedOpeningStock() {
  // A little opening stock, deliberately below reorder point for a few SKUs
  // so the requirement note has something urgent to show on day one.
  const { rows: products } = await pool.query(
    `SELECT id, sku, reorder_point, min_stock, shelf_life_days FROM products WHERE company_id=$1`,
    [COMPANY]);
  const { rows: wh } = await pool.query(
    `SELECT id, branch_id FROM warehouses WHERE company_id=$1 LIMIT 1`, [COMPANY]);
  if (!wh[0]) return;

  const short = new Set(['VEG-TOM-01', 'FRU-MAN-01', 'VEG-SPI-01']);
  let created = 0;

  for (const p of products) {
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM batches WHERE product_id=$1 AND batch_no LIKE 'OPEN-%' LIMIT 1`, [p.id]);
    if (exists[0]) continue;

    const target = short.has(p.sku)
      ? Number(p.reorder_point ?? 100) * 0.35
      : Number(p.reorder_point ?? 100) * 1.8;
    const qty = Math.round(target);
    if (qty <= 0) continue;

    const { rows: b } = await pool.query(
      `INSERT INTO batches (company_id, branch_id, warehouse_id, batch_no, product_id,
            received_date, expiry_date, shelf_life_days, grade, initial_qty, remaining_qty,
            net_weight_kg, remaining_weight_kg, landed_rate, landed_rate_per_kg, status)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 1,
               CASE WHEN $6::int IS NULL THEN NULL ELSE CURRENT_DATE - 1 + $6::int END,
               $6,'A',$7,$7,$8,$8,$9,$9,'ACTIVE') RETURNING id`,
      [COMPANY, wh[0].branch_id, wh[0].id, `OPEN-${p.sku}`, p.id,
       p.shelf_life_days, qty, qty, PRICE_BASE[p.sku] ?? 25]);

    await pool.query(
      `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
            direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id)
       VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,'KG',$8,$9,'ADJUSTMENT','opening',$5)`,
      [COMPANY, wh[0].branch_id, wh[0].id, p.id, b[0].id, qty,
       qty, PRICE_BASE[p.sku] ?? 25, qty * (PRICE_BASE[p.sku] ?? 25)]);

    await pool.query(
      `INSERT INTO stock_balances (company_id, warehouse_id, product_id, batch_id, qty, weight_kg)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (product_id, batch_id, warehouse_id) DO NOTHING`,
      [COMPANY, wh[0].id, p.id, b[0].id, qty, qty]);
    created++;
  }
  console.log(`  ${created} opening stock batches`);
}

/* ---------------------------------------------------------------------------
 * Farming demo state.
 *
 * The crops are started through the SAME calendar generator the API uses, so
 * what you see on FARM TODAY on a fresh install is exactly what the system
 * would have produced had somebody sown these plots by hand.
 * ------------------------------------------------------------------------ */
const CYCLES = [
  // plot, crop, area, sown N days ago  → where each crop lands in its life
  { plot: 'A', crop: 'TOMATO',   area: 1.2, ageDays: 62 },  // harvest in ~8 days
  { plot: 'B', crop: 'CUCUMBER', area: 1.0, ageDays: 40 },  // harvest in ~5 days
  { plot: 'C', crop: 'SPINACH',  area: 1.0, ageDays: 30 },  // harvest in ~2 days → amber
];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function seedFarming() {
  const { rows: existing } = await pool.query(
    `SELECT count(*)::int c FROM farm_crop_cycles WHERE company_id = $1`, [COMPANY]);
  if (existing[0].c > 0) {
    console.log('  farming demo already present — left alone');
    return;
  }

  const { rows: plots } = await pool.query(
    `SELECT id, code, area_acre FROM farm_plots WHERE farm_id = $1`, [FARM]);
  const { rows: crops } = await pool.query(
    `SELECT * FROM farm_crops WHERE company_id = $1`, [COMPANY]);
  if (!plots.length || !crops.length) {
    console.log('  no farm master data — run migrate first');
    return;
  }
  const plotBy = new Map(plots.map((p) => [p.code, p]));
  const cropBy = new Map(crops.map((c) => [c.code, c]));

  let cycleCount = 0;
  let taskCount = 0;

  const startCycle = async (
    plotCode: string, cropCode: string, area: number, sowingDate: string, status: string,
  ) => {
    const plot = plotBy.get(plotCode);
    const crop = cropBy.get(cropCode);
    if (!plot || !crop) return null;

    const plan = planCrop({
      crop: {
        code: crop.code, name: crop.name, nameHi: crop.name_hi,
        durationDays: Number(crop.duration_days),
        harvestWindowDays: Number(crop.harvest_window_days),
        yieldPerAcreKg: Number(crop.yield_per_acre_kg),
        seedCostPerAcre: Number(crop.seed_cost_per_acre),
        inputCostPerAcre: Number(crop.input_cost_per_acre),
        irrigationIntervalDays: Number(crop.irrigation_interval_days),
        irrigationIntervalDaysHot: crop.irrigation_interval_days_hot != null
          ? Number(crop.irrigation_interval_days_hot) : null,
        inspectionIntervalDays: Number(crop.inspection_interval_days),
        fertilizerSchedule: crop.fertilizer_schedule ?? [],
        spraySchedule: crop.spray_schedule ?? [],
      },
      areaAcre: area,
      sowingDate,
    });

    const { rows: no } = await pool.query(
      `SELECT next_doc_no($1,$2,'CROP','2026-27') AS n`, [COMPANY, BRANCH]);
    const { rows: cyc } = await pool.query(
      `INSERT INTO farm_crop_cycles (company_id, branch_id, farm_id, plot_id, crop_id, product_id,
              cycle_no, area_acre, sowing_date, duration_days, expected_harvest_date,
              expected_harvest_end_date, expected_yield_kg, estimated_cost, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [COMPANY, BRANCH, FARM, plot.id, crop.id, crop.product_id, no[0].n, area, sowingDate,
       plan.durationDays, plan.expectedHarvestDate, plan.expectedHarvestEndDate,
       plan.expectedYieldKg, plan.estimatedCost, status]);
    const cycle = cyc[0];
    cycleCount++;

    for (const t of plan.tasks) {
      await pool.query(
        `INSERT INTO farm_tasks (company_id, branch_id, farm_id, plot_id, cycle_id, task_type,
                title, due_date, day_number, input_name, planned_qty, input_uom, requires_qty,
                dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (company_id, dedupe_key) DO NOTHING`,
        [COMPANY, BRANCH, FARM, plot.id, cycle.id, t.taskType, t.title, t.dueDate,
         t.dayNumber, t.inputName ?? null, t.plannedQty ?? null, t.inputUom ?? null,
         t.requiresQty, `${cycle.id}:${t.taskType}:${t.dueDate}:${t.dayNumber}`]);
      taskCount++;
    }

    await pool.query(
      `INSERT INTO farm_expenses (company_id, branch_id, farm_id, plot_id, cycle_id,
              expense_date, expense_type, amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,'SEED',$7,'Seed / planting material (system estimate)')`,
      [COMPANY, BRANCH, FARM, plot.id, cycle.id, sowingDate,
       Number(crop.seed_cost_per_acre) * area]);

    await pool.query(
      `UPDATE farm_plots SET status = $2, last_crop_id = $3 WHERE id = $1`,
      [plot.id, status === 'CLOSED' ? 'RESTING' : 'CROPPED', crop.id]);

    return cycle;
  };

  for (const c of CYCLES) {
    const cycle = await startCycle(c.plot, c.crop, c.area, daysAgo(c.ageDays), 'GROWING');
    if (!cycle) continue;

    // Everything older than yesterday was done on the day it was due — except
    // two, deliberately left open so the colours on FARM TODAY are not all
    // green on a fresh install.
    await pool.query(
      `UPDATE farm_tasks
          SET status='DONE', done_at = due_date + time '08:30',
              done_by='01919000-0000-7000-8000-000000000109',
              actual_qty = CASE WHEN requires_qty THEN planned_qty END
        WHERE cycle_id = $1 AND due_date < CURRENT_DATE - 1`, [cycle.id]);

    // Real work: some inputs cost money and somebody recorded it.
    await pool.query(
      `INSERT INTO farm_expenses (company_id, branch_id, farm_id, plot_id, cycle_id,
              expense_date, expense_type, amount, note)
       SELECT $1,$2,$3,t.plot_id,t.cycle_id, t.due_date,
              CASE t.task_type WHEN 'FERTILIZER' THEN 'FERTILIZER'
                               WHEN 'SPRAY' THEN 'PESTICIDE' ELSE 'LABOUR' END,
              CASE t.task_type WHEN 'FERTILIZER' THEN 1400 + random()*900
                               WHEN 'SPRAY' THEN 700 + random()*500
                               ELSE 350 + random()*300 END,
              t.title
         FROM farm_tasks t
        WHERE t.cycle_id = $4 AND t.status = 'DONE'
          AND t.task_type IN ('FERTILIZER','SPRAY','IRRIGATION')`,
      [COMPANY, BRANCH, FARM, cycle.id]);
  }

  // One overdue inspection and one reported problem, so the RED/YELLOW rules
  // have something honest to colour.
  await pool.query(
    `UPDATE farm_tasks SET status='PENDING', done_at=NULL, done_by=NULL
      WHERE id IN (SELECT id FROM farm_tasks
                    WHERE farm_id=$1 AND task_type='INSPECTION' AND due_date < CURRENT_DATE
                    ORDER BY due_date DESC LIMIT 2)`, [FARM]);
  await pool.query(
    `UPDATE farm_tasks SET status='PROBLEM', problem_code='PEST', severity='RED',
            note='White fly seen on the lower leaves — needs a spray decision',
            done_at=now() - interval '5 hours', done_by='01919000-0000-7000-8000-000000000109'
      WHERE id = (SELECT t.id FROM farm_tasks t
                   JOIN farm_crop_cycles c ON c.id = t.cycle_id
                   JOIN farm_plots p ON p.id = c.plot_id
                  WHERE p.code='A' AND t.status='DONE' AND t.task_type='INSPECTION'
                  ORDER BY t.due_date DESC LIMIT 1)`);

  // A finished crop from last season. Without one there is no measured cost
  // per kg, and §27 buy-vs-grow has nothing to compare against.
  const closed = await startCycle('D', 'POTATO', 0.8, daysAgo(140), 'CLOSED');
  if (closed) {
    await pool.query(
      `UPDATE farm_tasks SET status='DONE', done_at = due_date + time '09:00',
              done_by='01919000-0000-7000-8000-000000000109'
        WHERE cycle_id=$1`, [closed.id]);

    const { rows: hno } = await pool.query(
      `SELECT next_doc_no($1,$2,'HARV','2026-27') AS n`, [COMPANY, BRANCH]);
    const netKg = Number(closed.expected_yield_kg) * 0.88;   // §20: below estimate
    const { rows: hv } = await pool.query(
      `INSERT INTO farm_harvests (company_id, branch_id, farm_id, plot_id, cycle_id, product_id,
              harvest_no, harvest_date, crop_age_days, gross_weight_kg, net_weight_kg,
              crate_count, status, harvested_by, label_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'DISPATCHED',
               '01919000-0000-7000-8000-000000000109',$12) RETURNING id`,
      [COMPANY, BRANCH, FARM, closed.plot_id, closed.id, closed.product_id, hno[0].n,
       daysAgo(45), 95, Math.round(netKg), Math.round(netKg / 25),
       String(hno[0].n).replace(/\//g, '-')]);

    for (const [grade, share] of [['A', 0.62], ['B', 0.24], ['C', 0.10], ['WASTE', 0.04]] as const) {
      await pool.query(
        `INSERT INTO farm_harvest_lines (company_id, harvest_id, grade, weight_kg, crate_count,
                destination, dispatched_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$4)`,
        [COMPANY, hv[0].id, grade, Math.round(netKg * share), Math.round(netKg * share / 25),
         grade === 'A' ? 'RETAIL' : grade === 'B' ? 'B2B' : grade === 'C' ? 'PROCESSING' : 'WASTE']);
    }
    await pool.query(
      `INSERT INTO farm_expenses (company_id, branch_id, farm_id, plot_id, cycle_id,
              expense_date, expense_type, amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,'HARVEST',9500,'Harvest labour'),
              ($1,$2,$3,$4,$5,$6,'TRANSPORT',3200,'Farm to warehouse'),
              ($1,$2,$3,$4,$5,$6,'PACKING',2100,'Crates and grading')`,
      [COMPANY, BRANCH, FARM, closed.plot_id, closed.id, daysAgo(45)]);

    await pool.query(
      `UPDATE farm_crop_cycles c SET
          harvested_kg = $2, waste_kg = $3, dispatched_kg = $2,
          actual_cost = COALESCE((SELECT SUM(amount) FROM farm_expenses e WHERE e.cycle_id=c.id),0),
          revenue = $4, status='CLOSED', closed_at = now() - interval '40 days',
          close_reason = 'Season finished'
        WHERE c.id = $1`,
      [closed.id, Math.round(netKg), Math.round(netKg * 0.04), Math.round(netKg * 0.96 * 21)]);
  }

  // Weather for the next few days. Today is hot, which is exactly the case
  // §9 exists for — the heat alert and the shortened irrigation interval.
  await pool.query(
    `INSERT INTO farm_weather (company_id, farm_id, weather_date, temp_min_c, temp_max_c,
            rain_mm, rain_prob_pct, wind_kmph, humidity_pct, condition, source)
     VALUES ($1,$2,CURRENT_DATE,      24, 39, 0,  10, 8,  48,'Hot and clear','FORECAST'),
            ($1,$2,CURRENT_DATE + 1,  25, 36, 12, 80, 22, 74,'Thunderstorms','FORECAST'),
            ($1,$2,CURRENT_DATE + 2,  23, 32, 6,  55, 14, 80,'Cloudy with showers','FORECAST')
     ON CONFLICT (farm_id, weather_date) DO NOTHING`, [COMPANY, FARM]);

  // Roll the derived totals once, so the owner dashboard is right before
  // anybody has opened FARM TODAY (which is what normally refreshes them).
  await pool.query(
    `UPDATE farm_crop_cycles c
        SET actual_cost = COALESCE((SELECT SUM(amount) FROM farm_expenses e
                                     WHERE e.cycle_id = c.id), 0)
      WHERE c.company_id = $1 AND c.status <> 'CLOSED'`, [COMPANY]);

  console.log(`  ${cycleCount} crop cycles, ${taskCount} calendar tasks, 3 days of weather`);
}

async function main() {
  console.log('Seeding demo data');
  await seedPasswords();
  await seedDemand();
  await seedMarketPrices();
  await seedOpeningStock();
  await seedFarming();

  console.log(`
Ready. Sign in at http://localhost:5173

  owner@chotug.in    / chotug123   Owner — sees everything
  buyer@chotug.in    / chotug123   Purchase Executive
  manager@chotug.in  / chotug123   Purchase Manager (approves)
  gate@chotug.in     / chotug123   Gate Executive
  qc@chotug.in       / chotug123   QC Executive
  wh@chotug.in       / chotug123   Warehouse Executive
  finance@chotug.in  / chotug123   Finance Executive
  farm@chotug.in     / chotug123   Farm Manager (crops, harvest, farm cost)
  field@chotug.in    / chotug123   Farm Staff — opens straight onto FARM TODAY
`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Seed failed:', e);
  await pool.end();
  process.exit(1);
});
