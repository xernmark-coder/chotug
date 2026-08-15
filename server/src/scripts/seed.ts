import { pool } from '../db.js';
import { hashPassword } from '../platform/auth.js';

const COMPANY = '01919000-0000-7000-8000-000000000001';
const BRANCH = '01919000-0000-7000-8000-000000000011';

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

async function main() {
  console.log('Seeding demo data');
  await seedPasswords();
  await seedDemand();
  await seedMarketPrices();
  await seedOpeningStock();

  console.log(`
Ready. Sign in at http://localhost:5173

  owner@chotug.in    / chotug123   Owner — sees everything
  buyer@chotug.in    / chotug123   Purchase Executive
  manager@chotug.in  / chotug123   Purchase Manager (approves)
  gate@chotug.in     / chotug123   Gate Executive
  qc@chotug.in       / chotug123   QC Executive
  wh@chotug.in       / chotug123   Warehouse Executive
  finance@chotug.in  / chotug123   Finance Executive
`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Seed failed:', e);
  await pool.end();
  process.exit(1);
});
