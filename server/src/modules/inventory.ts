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
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withTx, type Actor, type Tx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';
import { emit, nextDocNo, raiseAlert } from '../platform/services.js';
import { money, qty as roundQty, round } from '../domain/index.js';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);
// Outside supplier logins never reach staff data — see staffOnly().
inventoryRouter.use(staffOnly);

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
            /* What it really cost and the least it can go for. Computed in one
             * place (v_batch_pricing) so the till, the report and the dashboard
             * cannot each arrive at a different floor price. */
            pr.overhead_per_kg, pr.true_cost, pr.min_sell_price,
            pr.wastage_pct, pr.margin_pct,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_to_expiry,
            b.farm_id IS NOT NULL AS is_own_farm,
            f.name AS farm_name
       FROM stock_balances sb
       JOIN batches b     ON b.id = sb.batch_id
       JOIN products p    ON p.id = sb.product_id
       JOIN warehouses w  ON w.id = sb.warehouse_id
       LEFT JOIN v_batch_pricing pr ON pr.batch_id = b.id
       LEFT JOIN farms f  ON f.id = b.farm_id
      WHERE sb.company_id = $1
        AND (CASE WHEN p.base_uom = 'KG' AND COALESCE(sb.weight_kg, 0) > 0
            THEN sb.weight_kg ELSE sb.qty END - sb.reserved_qty) > 0
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
const IssueIn = z.object({
  idempotencyKey: z.string().min(8, 'Missing idempotency key'),
  warehouseId: z.string().uuid(),
  issueDate: z.string().optional(),
  reason: z.enum(['SALE', 'TRANSFER_OUT', 'WASTAGE', 'RETURN', 'CONSUMPTION', 'ADJUSTMENT']),
  partyName: z.string().optional(),
  /* Who bought it, as a record rather than a spelling. A name typed free-hand
   * is a different name every time, and "who buys from us" stops being an
   * answerable question. */
  customerId: z.string().uuid().nullable().optional(),
  referenceNo: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.object({
    batchId: z.string().uuid(),
    qty: z.number().positive('Enter how much is leaving'),
    // The selling rate for a sale. Left blank for anything else, where the
    // batch's own landed cost is the honest value of what left.
    rate: z.number().nonnegative().nullable().optional(),
  })).min(1, 'Nothing to issue'),
});
export type IssueInput = z.infer<typeof IssueIn>;

/** Gates that are about the REQUEST rather than the posting. */
function assertIssueAllowed(actor: Actor, input: IssueInput) {
  // Anything that is not a sale destroys value with nothing coming back, so it
  // needs both a written reason and the higher permission.
  if (WRITE_OFF_REASONS.has(input.reason)) {
    if (!actor.permissions.has('inventory.stock.writeoff')
        && !actor.permissions.has('admin.override')) {
      throw ApiError.forbidden(
        'Writing stock off as wastage or an adjustment needs a manager. You can still record a sale, transfer, return or consumption.');
    }
  }
  if (input.reason !== 'SALE' && !input.note?.trim()) {
    throw ApiError.rule(
      `Stock leaving as ${input.reason.replace(/_/g, ' ').toLowerCase()} needs a written reason.`);
  }
}

/**
 * THE stock-out posting — extracted from its route so that anything else which
 * moves stock (selling a packed crate, for one) commits the movement and its
 * own bookkeeping in the SAME transaction. Two endpoints writing their own
 * ledger rows is how a stock system starts disagreeing with itself; one
 * function that everybody calls is how it does not.
 *
 * Caller supplies the transaction, so the pack sale can lock the pack, post
 * the issue and mark the pack sold atomically.
 */
export async function postIssue(tx: Tx, actor: Actor, input: IssueInput) {
  /* --- idempotency: the same retry guarantee a GRN posting has ---------- */
  const { rows: idem } = await tx.query(
    `INSERT INTO idempotency_keys (key, company_id, user_id, endpoint, request_hash, state)
     VALUES ($1,$2,$3,'POST /inventory/issues',$4,'IN_PROGRESS')
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [input.idempotencyKey, actor.companyId, actor.userId,
     Buffer.from(JSON.stringify(input.lines)).toString('base64').slice(0, 64)]);
  if (idem.length === 0) {
    const { rows: prev } = await tx.query(
      `SELECT response_body FROM idempotency_keys WHERE key=$1`, [input.idempotencyKey]);
    if (prev[0]?.response_body) return prev[0].response_body;
    throw ApiError.conflict('This issue is already being posted. Please wait a moment.');
  }

  const { rows: wh } = await tx.query(
    `SELECT id, branch_id, name FROM warehouses WHERE id=$1 AND company_id=$2`,
    [input.warehouseId, actor.companyId]);
  const warehouse = wh[0];
  if (!warehouse) throw ApiError.notFound('Warehouse not found');

  const issueNo = await nextDocNo(tx, actor, warehouse.branch_id, 'ISS');
  const { rows: hdr } = await tx.query(
    `INSERT INTO stock_issues (company_id, branch_id, warehouse_id, issue_no, issue_date,
            reason, party_name, customer_id, reference_no, note, status, idempotency_key,
            posted_by, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'POSTED',$11,$12,$12,$12) RETURNING *`,
    [actor.companyId, warehouse.branch_id, warehouse.id, issueNo,
     input.issueDate ?? new Date().toISOString().slice(0, 10), input.reason,
     input.partyName ?? null, input.customerId ?? null, input.referenceNo ?? null,
     input.note ?? null, input.idempotencyKey, actor.userId]);
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
      [l.batchId, warehouse.id, actor.companyId]);
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
      [actor.companyId, issue.id, i + 1, sb.product_id, l.batchId,
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
      [actor.companyId, warehouse.branch_id, warehouse.id, sb.product_id, l.batchId,
       l.qty, weightOut, sb.base_uom, rate, lineValue, input.reason, issue.id,
       issueLineId, actor.userId]);

    /* The casts are not decoration. `COALESCE($4, 0)` leaves Postgres to infer
     * the parameter's type from the literal beside it — and it picks integer,
     * so the first line whose weight was not a whole number (6.667 kg off a
     * part-issued crate) died with "invalid input syntax for type integer".
     * It only bites on fractional weights, which is why it survived this long. */
    await tx.query(
      `UPDATE stock_balances
          SET qty = qty - $3::numeric,
              weight_kg = GREATEST(weight_kg - COALESCE($4::numeric, 0), 0),
              updated_at = now()
        WHERE batch_id = $1 AND warehouse_id = $2`,
      [l.batchId, warehouse.id, l.qty, weightOut]);

    // The batch is the physical thing; keep it in step with the balance and
    // retire it when nothing is left, so FEFO stops offering an empty crate.
    await tx.query(
      `UPDATE batches
          SET remaining_qty = GREATEST(remaining_qty - $2, 0),
              remaining_weight_kg = GREATEST(COALESCE(remaining_weight_kg, 0) - COALESCE($3::numeric, 0), 0),
              status = CASE WHEN remaining_qty - $2 <= 0.001 THEN 'CONSUMED' ELSE status END,
              updated_by = $4
        WHERE id = $1`,
      [l.batchId, l.qty, weightOut, actor.userId]);

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
    await raiseAlert(tx, actor, {
      branchId: warehouse.branch_id, alertType: 'STOCK_WRITE_OFF',
      severity: totalCost > 10000 ? 'HIGH' : 'MEDIUM',
      entityType: 'stock_issue', entityId: issue.id,
      title: `${issueNo}: ${totalQty} units written off (${money(totalCost)})`,
      message: input.note ?? 'No reason given.',
      meta: { reason: input.reason, totalQty, totalCost },
    });
  }

  await emit(tx, actor, 'stock_issue', issue.id, 'stock.issued', {
    issueNo, reason: input.reason, warehouseId: warehouse.id,
    totalQty, totalValue, totalCost, lines: posted.length,
  });

  const response = {
    ...issue,
    /* The header row was read before the lines were priced, so its snake_case
     * totals are all zero. Leaving them in the response next to the correct
     * camelCase ones gives every caller two answers and no way to tell which
     * is stale. */
    total_qty: totalQty, total_weight_kg: totalWeight, total_value: totalValue,
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
}

inventoryRouter.post('/issues', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(IssueIn, req.body);
  assertIssueAllowed(req.actor, input);
  return withTx(req.actor, (tx) => postIssue(tx, req.actor, input));
}));

inventoryRouter.get('/issues', h(async (req) =>
  query(req.actor,
    /* Each line carries its own id. Without it the centre could only ever book
     * a load in whole — the moment somebody said "one crate short" there was
     * no way to name the line they meant, and the request was rejected. */
    `SELECT si.*, w.name AS warehouse_name, u.full_name AS posted_by_name,
            dw.name AS dest_warehouse_name,
            (SELECT json_agg(json_build_object(
                      'id', sil.id, 'productId', sil.product_id, 'batchId', sil.batch_id,
                      'productName', p.name, 'batchNo', b.batch_no, 'grade', b.grade,
                      'qty', sil.qty, 'uom', sil.uom, 'rate', sil.rate, 'value', sil.value)
                      ORDER BY sil.line_no)
               FROM stock_issue_lines sil
               JOIN products p ON p.id = sil.product_id
               JOIN batches  b ON b.id = sil.batch_id
              WHERE sil.issue_id = si.id) AS lines
       FROM stock_issues si
       JOIN warehouses w ON w.id = si.warehouse_id
       LEFT JOIN warehouses dw ON dw.id = si.dest_warehouse_id
       LEFT JOIN users u ON u.id = si.posted_by
      WHERE si.company_id = $1
        AND ($2::uuid IS NULL OR si.warehouse_id = $2)
        AND ($3 = '' OR si.reason = $3)
        /* ?id= asks for one. It used to be accepted and ignored, so a screen
         * that asked for a particular load was handed the newest one instead
         * and showed somebody else's crates. */
        AND ($4::uuid IS NULL OR si.id = $4)
      ORDER BY si.issue_date DESC, si.posted_at DESC
      LIMIT 200`,
    [req.actor.companyId, req.query.warehouseId ?? null, String(req.query.reason ?? ''),
     req.query.id ?? null])));

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
                remaining_weight_kg = COALESCE(remaining_weight_kg, 0) + COALESCE($3::numeric, 0),
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
            (CASE WHEN p.base_uom = 'KG' AND COALESCE(sb.weight_kg, 0) > 0
              THEN sb.weight_kg ELSE sb.qty END - sb.reserved_qty) AS available_qty,
            b.landed_rate, b.landed_rate_per_kg, b.initial_qty, b.received_date,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_left,
            (CURRENT_DATE - b.received_date) AS age_days,
            (sb.qty - sb.reserved_qty) * COALESCE(b.landed_rate, 0) AS value_at_risk,
            pr.overhead_per_kg, pr.true_cost, pr.min_sell_price,
            pr.wastage_pct, pr.margin_pct,
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
       LEFT JOIN v_batch_pricing pr ON pr.batch_id = b.id
      WHERE sb.company_id = $1
        AND (CASE WHEN p.base_uom = 'KG' AND COALESCE(sb.weight_kg, 0) > 0
            THEN sb.weight_kg ELSE sb.qty END - sb.reserved_qty) > 0
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

    /* The floor is not what this crate was bought for — it is what it cost to
     * have it: purchase, plus the wages and power and cold store that keep the
     * place running, plus what gets thrown away. Selling at the purchase price
     * loses money quietly, which is the worst way to lose it.
     *
     * Close to expiry, holding out for the usual rate is how a whole batch
     * becomes a write-off, so the suggestion drops toward the floor as the days
     * run out — and never below it without the screen saying so. */
    const floor = Number(r.min_sell_price ?? 0) || Number(r.true_cost ?? 0) || cost;
    const discount = urgency === 'CRITICAL' ? 0.85 : urgency === 'HIGH' ? 0.93 : 1;
    const suggestedRate = market != null
      ? round(Math.max(market * discount, floor), 2)
      : floor > 0 ? round(floor, 2) : null;

    return {
      ...r,
      urgency,
      valueAtRisk: round(value, 2),
      suggestedRate,
      floorRate: floor > 0 ? round(floor, 2) : null,
      wouldRecoverCost: suggestedRate != null && floor > 0 ? suggestedRate >= floor : null,
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

/* ===========================================================================
   PACKING — loose stock becomes labelled, priced, sellable packs

   A pack does not move stock. The kilos stay on the batch until the pack is
   sold, and that sale goes through POST /inventory/issues like every other
   outward movement. Packing records how the stock has been made up, what each
   pack costs the buyer, and the code printed on it.
   ======================================================================== */

/** Short, unambiguous, unique for all time. No 0/O or 1/I — these get read off
 *  a smudged label under a warehouse light and typed in by hand when the
 *  scanner fails. */
const CODE_ALPHABET = '23456789ACDEFGHJKLMNPQRTUVWXY';
function packCode() {
  const n = randomBytes(8);
  let out = 'PK';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[n[i] % CODE_ALPHABET.length];
  return out;
}

/** What can still be packed: on-hand batches with how much is already packed. */
inventoryRouter.get('/packable', h(async (req) =>
  query(req.actor,
    `SELECT b.id AS batch_id, b.batch_no, b.grade, p.id AS product_id,
            p.name AS product_name, p.sku, p.base_uom,
            sb.warehouse_id, w.name AS warehouse_name,
            (CASE WHEN p.base_uom = 'KG' AND COALESCE(sb.weight_kg, 0) > 0
              THEN sb.weight_kg ELSE sb.qty END - sb.reserved_qty) AS available_qty,
            b.landed_rate, b.landed_rate_per_kg,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_left,
            COALESCE((SELECT SUM(pk.qty) FROM packs pk
                       WHERE pk.batch_id = b.id AND pk.status = 'IN_STOCK'), 0) AS packed_qty
       FROM stock_balances sb
       JOIN batches b    ON b.id = sb.batch_id
       JOIN products p   ON p.id = sb.product_id
       JOIN warehouses w ON w.id = sb.warehouse_id
      WHERE sb.company_id = $1
        AND sb.qty - sb.reserved_qty > 0
        AND b.status = 'ACTIVE'
        AND ($2::uuid IS NULL OR sb.warehouse_id = $2)
      ORDER BY COALESCE(b.predicted_expiry_date, b.expiry_date) NULLS LAST, p.name`,
    [req.actor.companyId, req.query.warehouseId ?? null])));

/* ---------------------------------------------------------------------------
 * POST /pack-runs used to live here — "make me 40 crates of 5 kg", raised from
 * the packing list. It was replaced by POST /pack-bench/:batchId/run, which
 * does the same job and three things it could not: a grade per group set by the
 * person packing rather than inherited from the lot, a weight per box, and a
 * shelf to put them on. It also required inventory.stock.issue, which the QC
 * people who actually pack do not hold.
 *
 * Deleted rather than left in place: an endpoint nothing calls is a second way
 * to do a job, discoverable only by whoever reads the routes, and this one
 * wrote the wrong grade.
 * ------------------------------------------------------------------------ */
/* ===========================================================================
 * PACK AND GRADE, ONE JOB
 *
 * The bulk pack run above answers "make me 40 crates of 5 kg". This answers the
 * job the client actually described: somebody stands at the bench with a box in
 * their hands, sees what is in it, and says A, B or C. One box, one grade, one
 * label — then it goes on a shelf by scanning the shelf.
 *
 * Lot QC still governs what we accept off the vehicle. This is the finer pass
 * that only the person holding the box can make.
 * ======================================================================== */

/** The one run a bench is packing into right now, opened on demand. */
async function openPackRun(tx: any, actor: any, batchId: string, warehouseId: string) {
  const { rows: open } = await tx.query(
    `SELECT * FROM pack_runs
      WHERE company_id = $1 AND batch_id = $2 AND warehouse_id = $3
        AND packed_on = CURRENT_DATE
      ORDER BY created_at DESC LIMIT 1`,
    [actor.companyId, batchId, warehouseId]);
  if (open[0]) return open[0];

  const { rows: sb } = await tx.query(
    `SELECT b.id, sb.product_id, w.branch_id
       FROM stock_balances sb
       JOIN batches b ON b.id = sb.batch_id
       JOIN warehouses w ON w.id = sb.warehouse_id
      WHERE sb.batch_id = $1 AND sb.warehouse_id = $2 AND sb.company_id = $3`,
    [batchId, warehouseId, actor.companyId]);
  if (!sb[0]) throw ApiError.notFound('That batch is not in this warehouse');

  const runNo = await nextDocNo(tx, actor, sb[0].branch_id, 'PCK');
  const { rows } = await tx.query(
    `INSERT INTO pack_runs (company_id, branch_id, warehouse_id, batch_id, product_id,
            run_no, packed_on, pack_count, total_qty, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,0,0,$7,$8) RETURNING *`,
    [actor.companyId, sb[0].branch_id, warehouseId, batchId, sb[0].product_id,
     runNo, 'Graded box by box at the bench', actor.userId]);
  return rows[0];
}

/** What is on the bench: the batch, what is left to pack, and today's boxes. */
inventoryRouter.get('/pack-bench/:batchId', h(async (req) => {
  const [b] = await query(req.actor,
    `SELECT b.id AS batch_id, b.batch_no, b.grade AS lot_grade,
            p.id AS product_id, p.name AS product_name, p.sku, p.icon, p.base_uom,
            sb.warehouse_id, w.name AS warehouse_name,
            (CASE WHEN p.base_uom = 'KG' AND COALESCE(sb.weight_kg, 0) > 0
              THEN sb.weight_kg ELSE sb.qty END - sb.reserved_qty) AS available_qty,
            b.landed_rate, b.landed_rate_per_kg,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            COALESCE((SELECT SUM(pk.qty) FROM packs pk
                       WHERE pk.batch_id = b.id AND pk.status = 'IN_STOCK'), 0) AS packed_qty
       FROM stock_balances sb
       JOIN batches b ON b.id = sb.batch_id
       JOIN products p ON p.id = sb.product_id
       JOIN warehouses w ON w.id = sb.warehouse_id
      WHERE b.id = $1 AND sb.company_id = $2
      LIMIT 1`,
    [req.params.batchId, req.actor.companyId]);
  if (!b) throw ApiError.notFound('That batch is not in stock anywhere.');

  const [byGrade, recent, bins] = await Promise.all([
    query(req.actor,
      `SELECT grade, count(*)::int AS packs, SUM(qty) AS qty,
              SUM(COALESCE(weight_kg,0)) AS weight_kg,
              count(*) FILTER (WHERE bin_id IS NULL)::int AS on_bench
         FROM packs WHERE batch_id = $1 AND status = 'IN_STOCK'
        GROUP BY grade ORDER BY grade`, [b.batch_id]),
    query(req.actor,
      `SELECT pk.id, pk.code, pk.pack_no, pk.qty, pk.uom, pk.weight_kg, pk.grade,
              pk.price, pk.qc_note, pk.created_at, pk.bin_id,
              bn.code AS bin_code, u.full_name AS graded_by_name
         FROM packs pk
         LEFT JOIN bins bn ON bn.id = pk.bin_id
         LEFT JOIN users u ON u.id = pk.graded_by
        WHERE pk.batch_id = $1 AND pk.status = 'IN_STOCK'
        ORDER BY pk.created_at DESC LIMIT 40`, [b.batch_id]),
    query(req.actor,
      `SELECT bn.id, bn.code, r.code AS rack_code, bn.capacity_kg, bn.current_fill_kg,
              (SELECT count(*)::int FROM packs pk
                WHERE pk.bin_id = bn.id AND pk.status='IN_STOCK') AS packs
         FROM bins bn JOIN racks r ON r.id = bn.rack_id
        WHERE bn.company_id = $1 AND bn.is_active
        ORDER BY r.code, bn.code`, [req.actor.companyId]),
  ]);

  /* Packs can outlive the stock they were made from: issuing a batch to a
   * centre takes the produce off the shelf and leaves the labels behind, so
   * "available minus packed" can go negative. It was shown raw, and the bench
   * read "-6.0 KG still loose" — a number that cannot exist, on the one screen
   * whose whole job is deciding how much more can be packed.
   *
   * Report both: nothing loose, and how far the labels overrun the stock, so
   * the floor can void the ones whose boxes have gone. */
  const raw = Number(b.available_qty) - Number(b.packed_qty);
  return {
    ...b,
    unpacked: Math.max(0, raw),
    overPacked: raw < 0 ? Math.abs(raw) : 0,
    byGrade, recent, bins,
  };
}));

/**
 * One box. Weighed, graded and labelled by the person holding it.
 *
 * The grade comes from them, not from the lot — that is the entire point of
 * doing this at the bench rather than on the vehicle.
 */
inventoryRouter.post('/pack-bench/:batchId/box',
  requires('inventory.pack.grade'), h(async (req) => {
    const input = body(z.object({
      warehouseId: z.string().uuid(),
      qty: z.coerce.number().positive('How much is in the box?'),
      weightKg: z.coerce.number().positive().optional(),
      grade: z.string().trim().min(1, 'What grade is this box?').max(12),
      price: z.coerce.number().nonnegative().default(0),
      label: z.string().trim().max(40).optional(),
      note: z.string().trim().max(200).optional(),
      /* Scanned straight after grading, so the box never sits on the bench
       * unaccounted for. Optional — some benches store in a second pass. */
      binCode: z.string().trim().max(40).optional(),
    }), req.body);

    return withTx(req.actor, async (tx) => {
      const { rows: sbRows } = await tx.query(
        `SELECT sb.qty, sb.weight_kg, sb.reserved_qty, sb.product_id, b.batch_no, b.status AS batch_status,
                p.base_uom, p.name AS product_name
           FROM stock_balances sb
           JOIN batches b ON b.id = sb.batch_id
           JOIN products p ON p.id = sb.product_id
          WHERE sb.batch_id = $1 AND sb.warehouse_id = $2 AND sb.company_id = $3
          FOR UPDATE OF sb`,
        [req.params.batchId, input.warehouseId, req.actor.companyId]);
      const sb = sbRows[0];
      if (!sb) throw ApiError.notFound('That batch is not in this warehouse');
      if (sb.batch_status !== 'ACTIVE') throw ApiError.rule('That batch is not active.');

      /* Same guard as the bulk run: packing more than exists is how a shop ends
       * up with a barcode for a crate nobody can find. */
      const { rows: already } = await tx.query(
        `SELECT COALESCE(SUM(qty),0) AS q FROM packs
          WHERE batch_id = $1 AND status = 'IN_STOCK'`, [req.params.batchId]);
      const stockQty = sb.base_uom === 'KG' && Number(sb.weight_kg) > 0
        ? Number(sb.weight_kg) : Number(sb.qty);
      const free = stockQty - Number(sb.reserved_qty) - Number(already[0].q);
      if (Number(input.qty) > free + 0.001) {
        throw ApiError.rule(
          `Only ${roundQty(free)} ${sb.base_uom} of this batch is still unpacked.`,
          { available: free, wanted: input.qty });
      }

      let binId: string | null = null;
      if (input.binCode) {
        const { rows: bin } = await tx.query(
          `SELECT bn.id FROM bins bn
            WHERE bn.company_id = $1 AND lower(bn.code) = lower($2) AND bn.is_active`,
          [req.actor.companyId, input.binCode]);
        if (!bin[0]) throw ApiError.rule(`No shelf with the code "${input.binCode}".`);
        binId = bin[0].id;
      }

      const run = await openPackRun(tx, req.actor, req.params.batchId, input.warehouseId);
      const { rows: seq } = await tx.query(
        `SELECT COALESCE(MAX(pack_no),0) + 1 AS n FROM packs WHERE run_id = $1`, [run.id]);

      const { rows } = await tx.query(
        `INSERT INTO packs (company_id, run_id, batch_id, product_id, warehouse_id,
                code, pack_no, group_label, qty, uom, price, grade, weight_kg,
                graded_by, graded_at, qc_note, bin_id, stored_at, stored_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,
                 CASE WHEN $16::uuid IS NULL THEN NULL ELSE now() END,
                 CASE WHEN $16::uuid IS NULL THEN NULL ELSE $14::uuid END,$14)
         RETURNING *`,
        [req.actor.companyId, run.id, req.params.batchId, sb.product_id, input.warehouseId,
         packCode(), seq[0].n, input.label ?? null, input.qty, sb.base_uom,
         money(input.price), input.grade.toUpperCase(), input.weightKg ?? null,
         req.actor.userId, input.note ?? null, binId]);
      const pack = rows[0];

      await tx.query(
        `UPDATE pack_runs SET pack_count = pack_count + 1, total_qty = total_qty + $2
          WHERE id = $1`, [run.id, input.qty]);

      const { rows: tot } = await tx.query(
        `SELECT count(*)::int AS packs, SUM(qty) AS qty FROM packs
          WHERE batch_id = $1 AND grade = $2 AND status = 'IN_STOCK'`,
        [req.params.batchId, input.grade.toUpperCase()]);

      return {
        ...pack, runNo: run.run_no, productName: sb.product_name,
        gradePacks: tot[0].packs, gradeQty: tot[0].qty,
        message: `${pack.code} · grade ${pack.grade} · ${roundQty(input.qty)} ${sb.base_uom}`
          + (binId ? ` · on ${input.binCode}` : ' · on the bench')
          + ` (${tot[0].packs} boxes of ${pack.grade} so far)`,
      };
    });
  }));

/**
 * THE PACKING PHASE — make a run of boxes out of what came off the vehicle.
 *
 * What arrives is not what gets stored. Two crates holding 50 kg each come off
 * the lorry; the floor turns them into twenty 5 kg boxes, each with its own
 * grade, its own price and its own QR label, and those boxes are what goes on a
 * shelf. Recording that one box at a time meant twenty identical taps.
 *
 * So: how many, how much in each, what grade, what price. Optionally the shelf,
 * because the trolley is usually right there. Every box still gets its own code
 * — they are separate things that will be sold separately, and a shared label
 * would make the second one untraceable the moment the first is sold.
 *
 * Different sizes out of one batch are different groups: 20 × 5 kg of A and
 * 6 × 2 kg of B is one run, one trip to the shelf, two groups.
 */
inventoryRouter.post('/pack-bench/:batchId/run',
  requires('inventory.pack.grade'), h(async (req) => {
    const input = body(z.object({
      warehouseId: z.string().uuid(),
      groups: z.array(z.object({
        count: z.coerce.number().int()
          .min(1, 'How many boxes?').max(500, 'Split this into smaller runs'),
        qtyPerPack: z.coerce.number().positive('How much goes in each box?'),
        weightKgPerPack: z.coerce.number().positive().optional(),
        grade: z.string().trim().min(1, 'What grade are these boxes?').max(12),
        price: z.coerce.number().nonnegative().default(0),
        label: z.string().trim().max(40).optional(),
      })).min(1, 'Nothing to make'),
      /* Straight onto the shelf if the trolley is there; leave it out and the
       * boxes wait on the bench for the store step. */
      binCode: z.string().trim().max(40).optional(),
      note: z.string().trim().max(200).optional(),
    }), req.body);

    return withTx(req.actor, async (tx) => {
      const { rows: sbRows } = await tx.query(
        `SELECT sb.qty, sb.weight_kg, sb.reserved_qty, sb.product_id, b.batch_no,
                b.status AS batch_status, p.base_uom, p.name AS product_name
           FROM stock_balances sb
           JOIN batches b ON b.id = sb.batch_id
           JOIN products p ON p.id = sb.product_id
          WHERE sb.batch_id = $1 AND sb.warehouse_id = $2 AND sb.company_id = $3
          FOR UPDATE OF sb`,
        [req.params.batchId, input.warehouseId, req.actor.companyId]);
      const sb = sbRows[0];
      if (!sb) throw ApiError.notFound('That batch is not in this warehouse');
      if (sb.batch_status !== 'ACTIVE') throw ApiError.rule('That batch is not active.');

      const wanted = input.groups.reduce((a, g) => a + g.count * g.qtyPerPack, 0);
      const { rows: already } = await tx.query(
        `SELECT COALESCE(SUM(qty),0) AS q FROM packs
          WHERE batch_id = $1 AND status = 'IN_STOCK'`, [req.params.batchId]);
      const stockQty = sb.base_uom === 'KG' && Number(sb.weight_kg) > 0
        ? Number(sb.weight_kg) : Number(sb.qty);
      const free = stockQty - Number(sb.reserved_qty) - Number(already[0].q);
      if (wanted > free + 0.001) {
        throw ApiError.rule(
          `That makes ${roundQty(wanted)} ${sb.base_uom} of boxes from `
          + `${roundQty(free)} ${sb.base_uom} still unpacked.`,
          { available: free, wanted });
      }

      let binId: string | null = null;
      if (input.binCode) {
        const { rows: bin } = await tx.query(
          `SELECT bn.id FROM bins bn
             JOIN racks r ON r.id = bn.rack_id
             JOIN zones z ON z.id = r.zone_id
            WHERE bn.company_id = $1 AND lower(bn.code) = lower($2)
              AND bn.is_active AND z.warehouse_id = $3`,
          [req.actor.companyId, input.binCode, input.warehouseId]);
        if (!bin[0]) throw ApiError.rule(`No shelf with the code "${input.binCode}".`);
        binId = bin[0].id;
      }

      const run = await openPackRun(tx, req.actor, req.params.batchId, input.warehouseId);
      const { rows: seq } = await tx.query(
        `SELECT COALESCE(MAX(pack_no),0) AS n FROM packs WHERE run_id = $1`, [run.id]);
      let packNo = Number(seq[0].n);

      const made: any[] = [];
      for (const g of input.groups) {
        for (let i = 0; i < g.count; i++) {
          packNo += 1;
          const { rows } = await tx.query(
            `INSERT INTO packs (company_id, run_id, batch_id, product_id, warehouse_id,
                    code, pack_no, group_label, qty, uom, price, grade, weight_kg,
                    graded_by, graded_at, qc_note, bin_id, stored_at, stored_by, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,
                     CASE WHEN $16::uuid IS NULL THEN NULL ELSE now() END,
                     CASE WHEN $16::uuid IS NULL THEN NULL ELSE $14::uuid END,$14)
             RETURNING id, code, pack_no, group_label, qty, uom, price, grade,
                       weight_kg, bin_id, status`,
            [req.actor.companyId, run.id, req.params.batchId, sb.product_id,
             input.warehouseId, packCode(), packNo,
             g.label ?? `${g.count} × ${roundQty(g.qtyPerPack)} ${sb.base_uom}`,
             g.qtyPerPack, sb.base_uom, money(g.price), g.grade.toUpperCase(),
             g.weightKgPerPack ?? null, req.actor.userId, input.note ?? null, binId]);
          made.push(rows[0]);
        }
      }

      await tx.query(
        `UPDATE pack_runs SET pack_count = pack_count + $2, total_qty = total_qty + $3
          WHERE id = $1`, [run.id, made.length, wanted]);

      await emit(tx, req.actor, 'pack_run', run.id, 'packs.created', {
        runNo: run.run_no, packs: made.length, batchNo: sb.batch_no,
        totalQty: wanted, stored: !!binId,
      });

      const sizes = input.groups
        .map((g) => `${g.count} × ${roundQty(g.qtyPerPack)} ${sb.base_uom} ${g.grade.toUpperCase()}`)
        .join(', ');
      return {
        runNo: run.run_no, packs: made, productName: sb.product_name,
        message: `${sizes} — ${made.length} label(s) ready`
          + (binId ? ` and on ${input.binCode}.` : '. They are on the bench.'),
      };
    });
  }));

/**
 * "Put these on that shelf." — scan the bin, tick the boxes.
 *
 * Storing is separate from grading because both orders happen in real life:
 * some benches scan the shelf as each box is finished, others fill a trolley
 * and walk it over. Doing it in one call either way means a box is never
 * half-stored.
 */
inventoryRouter.post('/packs/store', requires('inventory.pack.store'), h(async (req) => {
  const input = body(z.object({
    binCode: z.string().trim().min(1, 'Scan the shelf'),
    packIds: z.array(z.string().uuid()).min(1, 'Which boxes?').max(200),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: bin } = await tx.query(
      `SELECT bn.id, bn.code, bn.capacity_kg, r.code AS rack_code
         FROM bins bn JOIN racks r ON r.id = bn.rack_id
         JOIN zones z ON z.id = r.zone_id
        WHERE bn.company_id = $1 AND lower(bn.code) = lower($2)
          AND bn.is_active AND z.warehouse_id = (
            SELECT warehouse_id FROM packs WHERE id = ANY($3::uuid[]) LIMIT 1
          )`,
      [req.actor.companyId, input.binCode, input.packIds]);
    if (!bin[0]) throw ApiError.rule(`No shelf with the code "${input.binCode}".`);

    const { rows: moved } = await tx.query(
      `UPDATE packs
          SET bin_id = $1, stored_at = now(), stored_by = $2
        WHERE id = ANY($3::uuid[]) AND company_id = $4 AND status = 'IN_STOCK'
          AND warehouse_id = (
            SELECT z.warehouse_id FROM bins b
            JOIN racks r ON r.id = b.rack_id
            JOIN zones z ON z.id = r.zone_id
            WHERE b.id = $1
          )
        RETURNING id, code, grade, qty, weight_kg`,
      [bin[0].id, req.actor.userId, input.packIds, req.actor.companyId]);

    if (!moved.length) {
      throw ApiError.rule('None of those boxes can be stored — they may be sold or voided.');
    }

    await emit(tx, req.actor, 'bin', bin[0].id, 'packs.stored', {
      binCode: bin[0].code, rackCode: bin[0].rack_code, packs: moved.length,
    });

    return {
      ok: true, binCode: bin[0].code, rackCode: bin[0].rack_code, stored: moved.length,
      message: `${moved.length} box${moved.length === 1 ? '' : 'es'} on ${bin[0].code} `
        + `(rack ${bin[0].rack_code}).`,
    };
  });
}));

/** What is actually on each shelf — the answer to "where is the A-grade mango". */
inventoryRouter.get('/bins', h(async (req) =>
  query(req.actor,
    `SELECT bn.id, bn.code, r.code AS rack_code, z.name AS zone_name,
            bn.capacity_kg, bn.is_pickface,
            COALESCE(c.packs, 0) AS packs, COALESCE(c.qty, 0) AS qty,
            COALESCE(c.weight_kg, 0) AS weight_kg,
            (SELECT string_agg(DISTINCT p.name || ' ' || x.grade, ', ')
               FROM v_bin_contents x JOIN products p ON p.id = x.product_id
              WHERE x.bin_id = bn.id) AS holding
       FROM bins bn
       JOIN racks r ON r.id = bn.rack_id
       LEFT JOIN zones z ON z.id = r.zone_id
       LEFT JOIN (SELECT bin_id, SUM(packs)::int AS packs, SUM(qty) AS qty,
                         SUM(weight_kg) AS weight_kg
                    FROM v_bin_contents GROUP BY bin_id) c ON c.bin_id = bn.id
      WHERE bn.company_id = $1 AND bn.is_active
      ORDER BY r.code, bn.code`,
    [req.actor.companyId])));

inventoryRouter.get('/pack-runs', h(async (req) =>
  query(req.actor,
    `SELECT r.*, p.name AS product_name, p.sku, b.batch_no, u.full_name AS packed_by_name,
            (SELECT count(*) FROM packs k WHERE k.run_id = r.id AND k.status='IN_STOCK') AS in_stock,
            (SELECT count(*) FROM packs k WHERE k.run_id = r.id AND k.status='SOLD')     AS sold
       FROM pack_runs r
       JOIN products p ON p.id = r.product_id
       JOIN batches  b ON b.id = r.batch_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.company_id = $1
        AND ($2::uuid IS NULL OR r.warehouse_id = $2)
      ORDER BY r.created_at DESC LIMIT 100`,
    [req.actor.companyId, req.query.warehouseId ?? null])));

inventoryRouter.get('/packs', h(async (req) =>
  query(req.actor,
    `SELECT k.*, p.name AS product_name, p.sku, b.batch_no, r.run_no, r.packed_on,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date,
            /* Where it physically is, so "fetch me PK7RDG87QD" is a shelf and
             * not a search of the whole warehouse. */
            bn.code AS bin_code, rk.code AS rack_code,
            gu.full_name AS graded_by_name
       FROM packs k
       JOIN products p  ON p.id = k.product_id
       JOIN batches  b  ON b.id = k.batch_id
       JOIN pack_runs r ON r.id = k.run_id
       LEFT JOIN bins  bn ON bn.id = k.bin_id
       LEFT JOIN racks rk ON rk.id = bn.rack_id
       LEFT JOIN users gu ON gu.id = k.graded_by
      WHERE k.company_id = $1
        AND ($2 = '' OR k.status = $2)
        AND ($3::uuid IS NULL OR k.run_id = $3)
        AND ($4::uuid IS NULL OR k.warehouse_id = $4)
      ORDER BY r.packed_on DESC, k.pack_no LIMIT 500`,
    [req.actor.companyId, String(req.query.status ?? ''),
     req.query.runId ?? null, req.query.warehouseId ?? null])));

/** Records that labels went to a printer, so a reprint is visible as a reprint. */
inventoryRouter.post('/packs/print', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(z.object({
    packIds: z.array(z.string().uuid()).min(1),
  }), req.body);
  return withTx(req.actor, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE packs SET printed_at = now(), print_count = print_count + 1
        WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [req.actor.companyId, input.packIds]);
    return { ok: true, printed: rowCount };
  });
}));

/**
 * Marks a pack sold against a stock issue that has already been posted.
 *
 * The issue is what moves the stock; this only attaches the pack to it. The
 * link is verified rather than trusted — same company, same batch, a POSTED
 * SALE — so a pack cannot be marked sold against an unrelated document.
 */
inventoryRouter.post('/packs/:id/sold', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(z.object({ issueId: z.string().uuid() }), req.body);
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM packs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const pack = rows[0];
    if (!pack) throw ApiError.notFound('Pack not found');
    if (pack.status === 'SOLD') return { ok: true, alreadySold: true };
    if (pack.status === 'VOID') throw ApiError.rule('That pack was voided.');

    const { rows: iss } = await tx.query(
      `SELECT si.id FROM stock_issues si
        JOIN stock_issue_lines sil ON sil.issue_id = si.id
       WHERE si.id = $1 AND si.company_id = $2 AND si.reason = 'SALE'
         AND si.status = 'POSTED' AND sil.batch_id = $3
       LIMIT 1`,
      [input.issueId, req.actor.companyId, pack.batch_id]);
    if (!iss.length) {
      throw ApiError.rule('That sale does not cover this pack’s batch, so the pack cannot be marked sold against it.');
    }

    await tx.query(
      `UPDATE packs SET status='SOLD', sold_issue_id=$2, sold_at=now() WHERE id=$1`,
      [pack.id, input.issueId]);
    await emit(tx, req.actor, 'pack', pack.id, 'pack.sold',
      { code: pack.code, issueId: input.issueId });
    return { ok: true };
  });
}));

inventoryRouter.post('/packs/:id/void', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().trim().min(4, 'Say why this label is being voided'),
  }), req.body);
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE packs SET status='VOID', void_reason=$3
        WHERE id=$1 AND company_id=$2 AND status='IN_STOCK' RETURNING code`,
      [req.params.id, req.actor.companyId, input.reason]);
    if (!rows.length) throw ApiError.rule('Only a pack that is still in stock can be voided.');
    await emit(tx, req.actor, 'pack', req.params.id, 'pack.voided',
      { code: rows[0].code, reason: input.reason });
    return { ok: true };
  });
}));

/**
 * Sell packs — the whole point of having made them.
 *
 * One transaction: lock the packs, post ONE stock issue through the shared
 * postIssue() so the ledger, balances and batches move exactly as any other
 * sale, then mark the packs sold against it. A crash at any point rolls back
 * all of it, so a pack can never be sold-but-still-in-stock, or gone from
 * stock but still showing as sellable.
 *
 * The idempotency key is derived from the packs themselves, so a double-tap on
 * a warehouse tablet replays the first sale instead of selling twice.
 */
inventoryRouter.post('/packs/sell', requires('inventory.stock.issue'), h(async (req) => {
  const input = body(z.object({
    packIds: z.array(z.string().uuid()).min(1, 'Choose at least one pack'),
    partyName: z.string().trim().optional(),
    referenceNo: z.string().trim().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: packs } = await tx.query(
      `SELECT k.*, p.name AS product_name, b.batch_no
         FROM packs k
         JOIN products p ON p.id = k.product_id
         JOIN batches  b ON b.id = k.batch_id
        WHERE k.id = ANY($1::uuid[]) AND k.company_id = $2
        ORDER BY k.pack_no
        FOR UPDATE OF k`,
      [input.packIds, req.actor.companyId]);

    if (packs.length !== input.packIds.length) throw ApiError.notFound('One of those packs no longer exists.');
    const bad = packs.find((k: any) => k.status !== 'IN_STOCK');
    if (bad) {
      throw ApiError.rule(bad.status === 'SOLD'
        ? `Pack ${bad.code} has already been sold.`
        : `Pack ${bad.code} was voided.`);
    }
    const warehouses = new Set(packs.map((k: any) => k.warehouse_id));
    if (warehouses.size > 1) throw ApiError.rule('Those packs are in different warehouses — sell them separately.');

    /* One issue line per batch. Several packs off the same batch collapse into
     * one line whose rate is the money actually being charged for them, so the
     * line value equals what the buyer pays and the margin comes out right. */
    const byBatch = new Map<string, { qty: number; price: number }>();
    for (const k of packs) {
      const cur = byBatch.get(k.batch_id) ?? { qty: 0, price: 0 };
      cur.qty += Number(k.qty);
      cur.price += Number(k.price);
      byBatch.set(k.batch_id, cur);
    }

    const issue = await postIssue(tx, req.actor, {
      // Deterministic in the pack ids: the same basket cannot post twice.
      idempotencyKey: `pack-sale-${createHash('sha256')
        .update([...input.packIds].sort().join(','))
        .digest('hex').slice(0, 40)}`,
      warehouseId: packs[0].warehouse_id,
      reason: 'SALE',
      partyName: input.partyName || undefined,
      referenceNo: input.referenceNo || undefined,
      lines: [...byBatch.entries()].map(([batchId, v]) => ({
        batchId,
        qty: roundQty(v.qty),
        rate: v.qty > 0 ? round(v.price / v.qty, 4) : 0,
      })),
    });

    await tx.query(
      `UPDATE packs SET status='SOLD', sold_issue_id=$2, sold_at=now()
        WHERE id = ANY($1::uuid[])`,
      [input.packIds, issue.id]);

    await emit(tx, req.actor, 'stock_issue', issue.id, 'packs.sold', {
      issueNo: issue.issue_no, packs: packs.map((k: any) => k.code),
    });

    return {
      ...issue,
      packsSold: packs.length,
      codes: packs.map((k: any) => k.code),
    };
  });
}));
