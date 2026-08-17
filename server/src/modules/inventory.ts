/* ===========================================================================
 * INVENTORY — the way stock LEAVES.
 *
 * Until this existed the system could only take stock in: a GRN, a farm
 * transfer, an opening balance. The only OUT movement in the whole API was a
 * GRN reversal, so a warehouse that sold, transferred, ate or threw away a
 * crate had no way to say so, and the balance drifted from reality forever.
 *
 * The shape deliberately mirrors the GRN posting in receiving.ts, because it
 * is the same act in reverse and should be as hard to get wrong:
 *
 *   one transaction · an idempotency key · FEFO-suggested batches
 *   → stock_issues + lines → stock_ledger (OUT) → stock_balances → batches
 *
 * The ledger's own txn_type vocabulary is reused as the issue reason, so
 * nothing has to translate between the document and the ledger.
 * ======================================================================== */

import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, nextDocNo, raiseAlert } from '../platform/services.js';
import { money, qty as roundQty, round } from '../domain/index.js';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

/** Reasons that remove value without earning any — these need the higher gate. */
const WRITE_OFF_REASONS = new Set(['WASTAGE', 'ADJUSTMENT']);

const inrText = (n: number) =>
  `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/* ---------------------------------------------------------------------------
 * What is available to issue, oldest-expiring first.
 *
 * FEFO is not a nicety on perishables: picking the freshest crate first is how
 * a warehouse ends up throwing away the rest. The list is ordered so the right
 * batch is the first one on screen.
 * ------------------------------------------------------------------------ */
inventoryRouter.get('/issuable', h(async (req) =>
  query(req.actor,
    `SELECT b.id AS batch_id, b.batch_no, b.grade, b.product_id,
            p.name AS product_name, p.sku, p.base_uom,
            sb.warehouse_id, w.name AS warehouse_name,
            sb.qty, sb.reserved_qty, (sb.qty - sb.reserved_qty) AS available_qty,
            sb.weight_kg,
            b.landed_rate, b.landed_rate_per_kg,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_to_expiry,
            b.farm_id IS NOT NULL AS is_own_farm,
            f.name AS farm_name
       FROM stock_balances sb
       JOIN batches b     ON b.id = sb.batch_id
       JOIN products p    ON p.id = sb.product_id
       JOIN warehouses w  ON w.id = sb.warehouse_id
       LEFT JOIN farms f  ON f.id = b.farm_id
      WHERE sb.company_id = $1
        AND sb.qty - sb.reserved_qty > 0
        AND b.status = 'ACTIVE'
        AND ($2::uuid IS NULL OR sb.warehouse_id = $2)
        AND ($3::uuid IS NULL OR sb.product_id = $3)
      ORDER BY COALESCE(b.predicted_expiry_date, b.expiry_date) NULLS LAST,
               p.name, b.batch_no
      LIMIT 500`,
    [req.actor.companyId, req.query.warehouseId ?? null, req.query.productId ?? null])));

/* ---------------------------------------------------------------------------
 * THE issue posting. Everything below happens in one transaction.
 * ------------------------------------------------------------------------ */
inventoryRouter.post('/issues', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(z.object({
    idempotencyKey: z.string().min(8, 'Missing idempotency key'),
    warehouseId: z.string().uuid(),
    issueDate: z.string().optional(),
    reason: z.enum(['SALE', 'TRANSFER_OUT', 'WASTAGE', 'RETURN', 'CONSUMPTION', 'ADJUSTMENT']),
    partyName: z.string().optional(),
    referenceNo: z.string().optional(),
    note: z.string().optional(),
    lines: z.array(z.object({
      batchId: z.string().uuid(),
      qty: z.number().positive('Enter how much is leaving'),
      // The selling rate for a sale. Left blank for anything else, where the
      // batch's own landed cost is the honest value of what left.
      rate: z.number().nonnegative().nullable().optional(),
    })).min(1, 'Nothing to issue'),
  }), req.body);

  // Anything that is not a sale destroys value with nothing coming back, so it
  // needs both a written reason and the higher permission.
  if (WRITE_OFF_REASONS.has(input.reason)) {
    if (!req.actor.permissions.has('inventory.stock.writeoff')
        && !req.actor.permissions.has('admin.override')) {
      throw ApiError.forbidden(
        'Writing stock off as wastage or an adjustment needs a manager. You can still record a sale, transfer, return or consumption.');
    }
  }
  if (input.reason !== 'SALE' && !input.note?.trim()) {
    throw ApiError.rule(
      `Stock leaving as ${input.reason.replace(/_/g, ' ').toLowerCase()} needs a written reason.`);
  }

  return withTx(req.actor, async (tx) => {
    /* --- idempotency: the same retry guarantee a GRN posting has ---------- */
    const { rows: idem } = await tx.query(
      `INSERT INTO idempotency_keys (key, company_id, user_id, endpoint, request_hash, state)
       VALUES ($1,$2,$3,'POST /inventory/issues',$4,'IN_PROGRESS')
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [input.idempotencyKey, req.actor.companyId, req.actor.userId,
       Buffer.from(JSON.stringify(input.lines)).toString('base64').slice(0, 64)]);
    if (idem.length === 0) {
      const { rows: prev } = await tx.query(
        `SELECT response_body FROM idempotency_keys WHERE key=$1`, [input.idempotencyKey]);
      if (prev[0]?.response_body) return prev[0].response_body;
      throw ApiError.conflict('This issue is already being posted. Please wait a moment.');
    }

    const { rows: wh } = await tx.query(
      `SELECT id, branch_id, name FROM warehouses WHERE id=$1 AND company_id=$2`,
      [input.warehouseId, req.actor.companyId]);
    const warehouse = wh[0];
    if (!warehouse) throw ApiError.notFound('Warehouse not found');

    const issueNo = await nextDocNo(tx, req.actor, warehouse.branch_id, 'ISS');
    const { rows: hdr } = await tx.query(
      `INSERT INTO stock_issues (company_id, branch_id, warehouse_id, issue_no, issue_date,
              reason, party_name, reference_no, note, status, idempotency_key,
              posted_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'POSTED',$10,$11,$11,$11) RETURNING *`,
      [req.actor.companyId, warehouse.branch_id, warehouse.id, issueNo,
       input.issueDate ?? new Date().toISOString().slice(0, 10), input.reason,
       input.partyName ?? null, input.referenceNo ?? null, input.note ?? null,
       input.idempotencyKey, req.actor.userId]);
    const issue = hdr[0];

    let totalQty = 0, totalWeight = 0, totalValue = 0, totalCost = 0;
    const posted: any[] = [];

    for (const [i, l] of input.lines.entries()) {
      // FOR UPDATE on the balance is what makes two people selling the last
      // crate at the same time impossible rather than merely unlikely.
      const { rows: sbRows } = await tx.query(
        `SELECT sb.qty, sb.reserved_qty, sb.weight_kg, sb.product_id,
                b.batch_no, b.landed_rate, b.landed_rate_per_kg, b.status AS batch_status,
                b.remaining_qty, b.remaining_weight_kg,
                p.name AS product_name, p.base_uom
           FROM stock_balances sb
           JOIN batches b  ON b.id = sb.batch_id
           JOIN products p ON p.id = sb.product_id
          WHERE sb.batch_id = $1 AND sb.warehouse_id = $2 AND sb.company_id = $3
          FOR UPDATE OF sb`,
        [l.batchId, warehouse.id, req.actor.companyId]);
      const sb = sbRows[0];
      if (!sb) throw ApiError.notFound(`That batch is not in ${warehouse.name}.`);
      if (sb.batch_status !== 'ACTIVE') {
        throw ApiError.rule(`Batch ${sb.batch_no} is ${sb.batch_status.toLowerCase()} and cannot be issued.`);
      }

      const available = round(Number(sb.qty) - Number(sb.reserved_qty), 3);
      if (l.qty > available + 0.001) {
        throw ApiError.rule(
          `Only ${available} ${sb.base_uom} of batch ${sb.batch_no} is available, not ${l.qty}.`);
      }

      // Weight comes off in the same proportion as quantity, so a part-issued
      // batch keeps a weight that still matches what is physically on the rack.
      const weightOut = Number(sb.qty) > 0 && sb.weight_kg != null
        ? round(Number(sb.weight_kg) * (l.qty / Number(sb.qty)), 3)
        : null;

      const costPerUnit = Number(sb.landed_rate ?? 0);
      const rate = l.rate ?? costPerUnit;      // no sale price → value it at cost
      const lineValue = money(l.qty * rate);
      const lineCost = money(l.qty * costPerUnit);

      const { rows: lineRows } = await tx.query(
        `INSERT INTO stock_issue_lines (company_id, issue_id, line_no, product_id, batch_id,
                qty, weight_kg, uom, rate, value, landed_rate_per_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [req.actor.companyId, issue.id, i + 1, sb.product_id, l.batchId,
         l.qty, weightOut, sb.base_uom, rate, lineValue, sb.landed_rate_per_kg]);
      const issueLineId = lineRows[0].id;

      /* --- the ledger. Append-only, OUT, once. ---------------------------
       * ref_line_id was the batch id, and stock_ledger carries
       * UNIQUE (ref_type, ref_line_id, txn_type) — so a batch could be sold
       * exactly once, ever, and the second sale died on a constraint whose
       * error message talks about goods receipts. Selling half a crate today
       * and half tomorrow is the normal case for produce. The issue LINE id is
       * the honest key: one ledger row per line, unique for all time. */
      await tx.query(
        `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
                direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id,
                ref_line_id, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,'OUT',$6,$7,$8,$9,$10,$11,'stock_issue',$12,$13,now(),$14)`,
        [req.actor.companyId, warehouse.branch_id, warehouse.id, sb.product_id, l.batchId,
         l.qty, weightOut, sb.base_uom, rate, lineValue, input.reason, issue.id,
         issueLineId, req.actor.userId]);

      await tx.query(
        `UPDATE stock_balances
            SET qty = qty - $3,
                weight_kg = GREATEST(weight_kg - COALESCE($4, 0), 0),
                updated_at = now()
          WHERE batch_id = $1 AND warehouse_id = $2`,
        [l.batchId, warehouse.id, l.qty, weightOut]);

      // The batch is the physical thing; keep it in step with the balance and
      // retire it when nothing is left, so FEFO stops offering an empty crate.
      await tx.query(
        `UPDATE batches
            SET remaining_qty = GREATEST(remaining_qty - $2, 0),
                remaining_weight_kg = GREATEST(COALESCE(remaining_weight_kg, 0) - COALESCE($3, 0), 0),
                status = CASE WHEN remaining_qty - $2 <= 0.001 THEN 'CONSUMED' ELSE status END,
                updated_by = $4
          WHERE id = $1`,
        [l.batchId, l.qty, weightOut, req.actor.userId]);

      totalQty = roundQty(totalQty + l.qty);
      totalWeight = round(totalWeight + (weightOut ?? 0), 3);
      totalValue = money(totalValue + lineValue);
      totalCost = money(totalCost + lineCost);

      posted.push({
        batchId: l.batchId, batchNo: sb.batch_no, product: sb.product_name,
        qty: l.qty, uom: sb.base_uom, weightKg: weightOut,
        rate, value: lineValue, cost: lineCost,
        remaining: round(available - l.qty, 3),
      });
    }

    await tx.query(
      `UPDATE stock_issues SET total_qty=$2, total_weight_kg=$3, total_value=$4 WHERE id=$1`,
      [issue.id, totalQty, totalWeight, totalValue]);

    // A write-off is money gone. It should be visible without anyone opening a
    // report to look for it.
    if (WRITE_OFF_REASONS.has(input.reason)) {
      await raiseAlert(tx, req.actor, {
        branchId: warehouse.branch_id, alertType: 'STOCK_WRITE_OFF',
        severity: totalCost > 10000 ? 'HIGH' : 'MEDIUM',
        entityType: 'stock_issue', entityId: issue.id,
        title: `${issueNo}: ${totalQty} units written off (${money(totalCost)})`,
        message: input.note ?? 'No reason given.',
        meta: { reason: input.reason, totalQty, totalCost },
      });
    }

    await emit(tx, req.actor, 'stock_issue', issue.id, 'stock.issued', {
      issueNo, reason: input.reason, warehouseId: warehouse.id,
      totalQty, totalValue, totalCost, lines: posted.length,
    });

    const response = {
      ...issue,
      totalQty, totalWeightKg: totalWeight, totalValue, totalCost,
      // For a sale this is the margin; for anything else it is the loss.
      marginValue: input.reason === 'SALE' ? money(totalValue - totalCost) : null,
      lines: posted,
    };
    await tx.query(
      `UPDATE idempotency_keys SET state='COMPLETED', response_body=$2, status_code=200,
              completed_at=now() WHERE key=$1`,
      [input.idempotencyKey, JSON.stringify(response)]);
    return response;
  });
}));

inventoryRouter.get('/issues', h(async (req) =>
  query(req.actor,
    `SELECT si.*, w.name AS warehouse_name, u.full_name AS posted_by_name,
            (SELECT json_agg(json_build_object(
                      'productName', p.name, 'batchNo', b.batch_no, 'grade', b.grade,
                      'qty', sil.qty, 'uom', sil.uom, 'rate', sil.rate, 'value', sil.value)
                      ORDER BY sil.line_no)
               FROM stock_issue_lines sil
               JOIN products p ON p.id = sil.product_id
               JOIN batches  b ON b.id = sil.batch_id
              WHERE sil.issue_id = si.id) AS lines
       FROM stock_issues si
       JOIN warehouses w ON w.id = si.warehouse_id
       LEFT JOIN users u ON u.id = si.posted_by
      WHERE si.company_id = $1
        AND ($2::uuid IS NULL OR si.warehouse_id = $2)
        AND ($3 = '' OR si.reason = $3)
      ORDER BY si.issue_date DESC, si.posted_at DESC
      LIMIT 200`,
    [req.actor.companyId, req.query.warehouseId ?? null, String(req.query.reason ?? '')])));

/* ---------------------------------------------------------------------------
 * Cancelling puts the stock back. The ledger is append-only, so this writes a
 * compensating IN row rather than deleting anything — the same way a GRN is
 * reversed instead of edited.
 * ------------------------------------------------------------------------ */
inventoryRouter.post('/issues/:id/cancel', requires('inventory.stock.cancel'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().min(4, 'Say why this is being cancelled'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: hr } = await tx.query(
      `SELECT * FROM stock_issues WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const issue = hr[0];
    if (!issue) throw ApiError.notFound('Stock issue not found');
    if (issue.status === 'CANCELLED') throw ApiError.rule('This issue is already cancelled.');

    const { rows: lines } = await tx.query(
      `SELECT * FROM stock_issue_lines WHERE issue_id=$1 ORDER BY line_no`, [issue.id]);

    for (const l of lines) {
      await tx.query(
        `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
                direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id,
                ref_line_id, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,$8,$9,$10,'ADJUSTMENT','stock_issue_cancel',$11,$12,now(),$13)`,
        [req.actor.companyId, issue.branch_id, issue.warehouse_id, l.product_id, l.batch_id,
         l.qty, l.weight_kg, l.uom, l.rate, l.value, issue.id, l.id, req.actor.userId]);

      await tx.query(
        `INSERT INTO stock_balances (company_id, warehouse_id, product_id, batch_id, qty, weight_kg)
         VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric)
         ON CONFLICT (product_id, batch_id, warehouse_id) DO UPDATE
           SET qty = stock_balances.qty + EXCLUDED.qty,
               weight_kg = stock_balances.weight_kg + EXCLUDED.weight_kg,
               updated_at = now()`,
        [req.actor.companyId, issue.warehouse_id, l.product_id, l.batch_id,
         l.qty, l.weight_kg ?? 0]);

      await tx.query(
        `UPDATE batches
            SET remaining_qty = remaining_qty + $2,
                remaining_weight_kg = COALESCE(remaining_weight_kg, 0) + COALESCE($3, 0),
                status = CASE WHEN status = 'CONSUMED' THEN 'ACTIVE' ELSE status END,
                updated_by = $4
          WHERE id = $1`,
        [l.batch_id, l.qty, l.weight_kg, req.actor.userId]);
    }

    await tx.query(
      `UPDATE stock_issues SET status='CANCELLED', cancelled_at=now(), cancelled_by=$2,
              cancel_reason=$3, updated_by=$2 WHERE id=$1`,
      [issue.id, req.actor.userId, input.reason]);

    await emit(tx, req.actor, 'stock_issue', issue.id, 'stock.issue.cancelled',
      { issueNo: issue.issue_no, reason: input.reason, linesReturned: lines.length });

    return { ok: true, issueNo: issue.issue_no, linesReturned: lines.length };
  });
}));

/* ===========================================================================
   SELLING — what went out, what it earned, and what to move next

   Stock could already leave as a SALE, and the line already carried both the
   selling rate and the cost it was carrying. What was missing is the reading
   of it: nobody could see whether a sale made money, how much of a purchase
   has actually been sold, or which batch is about to become a write-off.

   Cost basis: a batch prices per its own unit (landed_rate), and weight-priced
   produce prices per kg. Take whichever the batch actually has, so margin is
   never silently zero because the wrong column was read.
   ======================================================================== */

const LINE_COST = `COALESCE(sil.qty * b.landed_rate, sil.weight_kg * sil.landed_rate_per_kg, 0)`;

inventoryRouter.get('/sales-summary', h(async (req) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
  const warehouseId = (req.query.warehouseId as string) || null;
  const p = [req.actor.companyId, warehouseId, String(days)];

  const [totals] = await query(req.actor,
    `SELECT
       COALESCE(SUM(sil.value), 0)                                   AS revenue,
       COALESCE(SUM(${LINE_COST}), 0)                                AS cost,
       COALESCE(SUM(sil.value) - SUM(${LINE_COST}), 0)               AS profit,
       COALESCE(SUM(sil.qty), 0)                                     AS qty_sold,
       count(DISTINCT si.id)                                         AS sales
       FROM stock_issues si
       JOIN stock_issue_lines sil ON sil.issue_id = si.id
       JOIN batches b ON b.id = sil.batch_id
      WHERE si.company_id = $1 AND si.reason = 'SALE' AND si.status = 'POSTED'
        AND si.issue_date >= CURRENT_DATE - ($3 || ' days')::interval
        AND ($2::uuid IS NULL OR si.warehouse_id = $2)`, p);

  /* What the same window destroyed rather than sold. A loss is not the absence
   * of profit — it is stock that went out at no revenue at all. */
  const [writeOffs] = await query(req.actor,
    `SELECT COALESCE(SUM(${LINE_COST}), 0) AS cost, COALESCE(SUM(sil.qty), 0) AS qty,
            count(DISTINCT si.id) AS events
       FROM stock_issues si
       JOIN stock_issue_lines sil ON sil.issue_id = si.id
       JOIN batches b ON b.id = sil.batch_id
      WHERE si.company_id = $1 AND si.status = 'POSTED'
        AND si.reason IN ('WASTAGE', 'ADJUSTMENT')
        AND si.issue_date >= CURRENT_DATE - ($3 || ' days')::interval
        AND ($2::uuid IS NULL OR si.warehouse_id = $2)`, p);

  /* Sold against still-here, per product — the "how much left" question. */
  const byProduct = await query(req.actor,
    `WITH sold AS (
       SELECT sil.product_id,
              SUM(sil.qty) AS qty_sold,
              SUM(sil.value) AS revenue,
              SUM(${LINE_COST}) AS cost
         FROM stock_issues si
         JOIN stock_issue_lines sil ON sil.issue_id = si.id
         JOIN batches b ON b.id = sil.batch_id
        WHERE si.company_id = $1 AND si.reason = 'SALE' AND si.status = 'POSTED'
          AND si.issue_date >= CURRENT_DATE - ($3 || ' days')::interval
          AND ($2::uuid IS NULL OR si.warehouse_id = $2)
        GROUP BY sil.product_id
     ), onhand AS (
       SELECT sb.product_id, SUM(sb.qty) AS qty_left,
              SUM(sb.qty * COALESCE(b.landed_rate, 0)) AS value_left
         FROM stock_balances sb
         JOIN batches b ON b.id = sb.batch_id
        WHERE sb.company_id = $1 AND sb.qty > 0
          AND ($2::uuid IS NULL OR sb.warehouse_id = $2)
        GROUP BY sb.product_id
     )
     SELECT p.id, p.sku, p.name, p.base_uom,
            COALESCE(s.qty_sold, 0)  AS qty_sold,
            COALESCE(s.revenue, 0)   AS revenue,
            COALESCE(s.cost, 0)      AS cost,
            COALESCE(s.revenue, 0) - COALESCE(s.cost, 0) AS profit,
            COALESCE(o.qty_left, 0)  AS qty_left,
            COALESCE(o.value_left, 0) AS value_left
       FROM products p
       LEFT JOIN sold s   ON s.product_id = p.id
       LEFT JOIN onhand o ON o.product_id = p.id
      WHERE p.company_id = $1
        AND (COALESCE(s.qty_sold,0) > 0 OR COALESCE(o.qty_left,0) > 0)
      ORDER BY COALESCE(s.revenue,0) DESC, p.name`, p);

  /* Daily revenue and profit, for the trend. */
  const trend = await query(req.actor,
    `SELECT si.issue_date::text AS date,
            COALESCE(SUM(sil.value), 0) AS revenue,
            COALESCE(SUM(sil.value) - SUM(${LINE_COST}), 0) AS profit
       FROM stock_issues si
       JOIN stock_issue_lines sil ON sil.issue_id = si.id
       JOIN batches b ON b.id = sil.batch_id
      WHERE si.company_id = $1 AND si.reason = 'SALE' AND si.status = 'POSTED'
        AND si.issue_date >= CURRENT_DATE - ($3 || ' days')::interval
        AND ($2::uuid IS NULL OR si.warehouse_id = $2)
      GROUP BY si.issue_date ORDER BY si.issue_date`, p);

  const revenue = Number(totals.revenue);
  return {
    days,
    totals: {
      ...totals,
      marginPct: revenue > 0 ? round((Number(totals.profit) / revenue) * 100, 2) : null,
    },
    writeOffs,
    byProduct,
    trend,
  };
}));

/* ---------------------------------------------------------------------------
 * "Sell this before it turns." Rules, not a language model: the ranking is
 * arithmetic on shelf life, quantity and money, so it is explainable, it works
 * offline, and it cannot hallucinate a batch. §14 — advice is advisory, and
 * every row shows the numbers it was derived from.
 * ------------------------------------------------------------------------ */
inventoryRouter.get('/sell-suggestions', h(async (req) => {
  const rows = await query(req.actor,
    `SELECT b.id AS batch_id, b.batch_no, b.grade,
            p.id AS product_id, p.name AS product_name, p.sku, p.base_uom,
            sb.warehouse_id, w.name AS warehouse_name,
            (sb.qty - sb.reserved_qty) AS available_qty,
            b.landed_rate, b.landed_rate_per_kg, b.initial_qty, b.received_date,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_left,
            (CURRENT_DATE - b.received_date) AS age_days,
            (sb.qty - sb.reserved_qty) * COALESCE(b.landed_rate, 0) AS value_at_risk,
            -- What this product has actually been fetching lately, so the
            -- suggested price is evidence rather than a guess.
            (SELECT round(AVG(sil.rate), 2) FROM stock_issue_lines sil
               JOIN stock_issues si2 ON si2.id = sil.issue_id
              WHERE sil.product_id = p.id AND si2.reason = 'SALE'
                AND si2.status = 'POSTED'
                AND si2.issue_date >= CURRENT_DATE - 30
                AND sil.rate IS NOT NULL) AS recent_sale_rate
       FROM stock_balances sb
       JOIN batches b    ON b.id = sb.batch_id
       JOIN products p   ON p.id = sb.product_id
       JOIN warehouses w ON w.id = sb.warehouse_id
      WHERE sb.company_id = $1
        AND sb.qty - sb.reserved_qty > 0
        AND b.status = 'ACTIVE'
        AND ($2::uuid IS NULL OR sb.warehouse_id = $2)
      ORDER BY COALESCE(b.predicted_expiry_date, b.expiry_date) NULLS LAST
      LIMIT 200`,
    [req.actor.companyId, req.query.warehouseId ?? null]);

  const scored = rows.map((r: any) => {
    const daysLeft = r.days_left == null ? null : Number(r.days_left);
    const value = Number(r.value_at_risk);
    const cost = Number(r.landed_rate ?? 0);
    const market = r.recent_sale_rate == null ? null : Number(r.recent_sale_rate);

    // Urgency is shelf life; the money only decides the order within a band.
    const urgency =
      daysLeft == null ? 'NONE'
      : daysLeft <= 0 ? 'CRITICAL'
      : daysLeft <= 2 ? 'CRITICAL'
      : daysLeft <= 5 ? 'HIGH'
      : daysLeft <= 10 ? 'MEDIUM'
      : 'NONE';

    const reasons: string[] = [];
    if (daysLeft != null) {
      reasons.push(daysLeft <= 0 ? 'Past its expected date'
        : `${daysLeft} day(s) of shelf life left`);
    }
    if (value > 0) reasons.push(`${inrText(value)} of stock sitting on it`);
    if (r.age_days != null) reasons.push(`in the warehouse ${r.age_days} day(s)`);

    /* A price that recovers cost is the floor. Close to expiry, holding out for
     * the usual rate is how the whole batch becomes a write-off, so the
     * suggestion drops toward cost as the days run out — never below it
     * without saying so. */
    const discount = urgency === 'CRITICAL' ? 0.85 : urgency === 'HIGH' ? 0.93 : 1;
    const suggestedRate = market != null
      ? round(Math.max(market * discount, cost), 2)
      : cost > 0 ? round(cost * 1.15, 2) : null;

    return {
      ...r,
      urgency,
      valueAtRisk: round(value, 2),
      suggestedRate,
      wouldRecoverCost: suggestedRate != null && cost > 0 ? suggestedRate >= cost : null,
      reasons,
      action: urgency === 'CRITICAL' ? 'Sell today, even at a discount'
        : urgency === 'HIGH' ? 'Sell this week'
        : urgency === 'MEDIUM' ? 'Plan a buyer'
        : 'No rush',
    };
  });

  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, NONE: 3 };
  scored.sort((a, b) =>
    rank[a.urgency] - rank[b.urgency] || b.valueAtRisk - a.valueAtRisk);

  return {
    suggestions: scored,
    atRisk: {
      critical: scored.filter((s) => s.urgency === 'CRITICAL').length,
      high: scored.filter((s) => s.urgency === 'HIGH').length,
      value: round(scored
        .filter((s) => s.urgency === 'CRITICAL' || s.urgency === 'HIGH')
        .reduce((a, s) => a + s.valueAtRisk, 0), 2),
    },
  };
}));
