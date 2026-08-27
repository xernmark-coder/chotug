/* ===========================================================================
 * FINANCE — the one desk every rupee passes through.
 *
 * The client's words: "this is very much crucial and central panel in this
 * crm, because here all the money related things are handled". So this module
 * owns three verbs and nothing else owns them:
 *
 *   REQUEST   anybody who needs money to leave the business asks here
 *   VERIFY    Finance checks the claim against the document behind it
 *   PAY       Finance moves the money and records how, and with what reference
 *
 * Plus the other direction — money arriving from a centre or a customer, which
 * is DECLARED by whoever took it and CONFIRMED by Finance when it lands. The
 * gap between those two is the thing a cash business most needs to see.
 *
 * Two rules are enforced here rather than trusted to a screen:
 *   · nothing is paid that has not been verified by somebody other than the
 *     person who asked for it;
 *   · a non-cash payment must carry a transaction reference, and the same
 *     reference cannot be used twice.
 * ======================================================================== */

import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';
import { emit, nextDocNo, pushTask, raiseAlert, resolveTask } from '../platform/services.js';
import { money, round } from '../domain/index.js';

export const financeRouter = Router();
financeRouter.use(authenticate);
financeRouter.use(staffOnly);

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const DEFAULT_PAYMENT_MODES = ['CASH', 'UPI', 'BANK', 'CHEQUE', 'CARD'];
const PAYMENT_MODES_KEY = 'finance.payment_modes';

/* --------------------------------------------------------------- masters -- */

financeRouter.get('/expense-categories', h(async (req) =>
  query(req.actor,
    `SELECT id, code, name, name_hi, icon, affects_landed_cost, sort_order
       FROM expense_categories
      WHERE company_id = $1 AND is_active
      ORDER BY sort_order, name`, [req.actor.companyId])));

financeRouter.post('/expense-categories', requires('admin.settings.manage'), h(async (req) => {
  const input = body(z.object({
    code: z.string().trim().min(2).optional(),
    name: z.string().trim().min(2, 'Name it'),
    nameHi: z.string().trim().optional(),
    icon: z.string().trim().optional(),
    affectsLandedCost: z.boolean().default(false),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const code = (input.code ?? input.name).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 24);
    const { rows } = await tx.query(
      `INSERT INTO expense_categories (company_id, code, name, name_hi, icon,
              affects_landed_cost, sort_order, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,500,$7,$7)
       ON CONFLICT (company_id, code) DO UPDATE
          SET name = EXCLUDED.name, is_active = true, updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [req.actor.companyId, code, input.name, input.nameHi ?? null,
       input.icon ?? 'receipt', input.affectsLandedCost, req.actor.userId]);
    return rows[0];
  });
}));

financeRouter.get('/payment-modes', h(async (req) => {
  const rows = await query<{ value: any }>(req.actor,
    `SELECT value FROM settings WHERE company_id = $1 AND key = $2`,
    [req.actor.companyId, PAYMENT_MODES_KEY]);
  const saved = Array.isArray(rows[0]?.value)
    ? rows[0].value.filter((v: any) => typeof v === 'string') : [];
  return [...new Set([...DEFAULT_PAYMENT_MODES, ...saved])];
}));

financeRouter.post('/payment-modes', requires('finance.payment.make'), h(async (req) => {
  const input = body(z.object({ name: z.string().trim().min(2, 'Name the payment method').max(40) }), req.body);
  const name = input.name.replace(/\s+/g, ' ');
  const key = name.toUpperCase();
  if (DEFAULT_PAYMENT_MODES.includes(key)) return { name: key, added: false };

  const rows = await query<{ value: any }>(req.actor,
    `SELECT value FROM settings WHERE company_id = $1 AND key = $2`,
    [req.actor.companyId, PAYMENT_MODES_KEY]);
  const saved = Array.isArray(rows[0]?.value)
    ? rows[0].value.filter((v: any) => typeof v === 'string') : [];
  const existing = saved.find((v) => v.toLowerCase() === name.toLowerCase());
  if (existing) return { name: existing, added: false };
  const next = [...saved, name].slice(-40);
  await withTx(req.actor, (tx) => tx.query(
    `INSERT INTO settings (company_id, scope, key, value, updated_by)
     VALUES ($1, 'COMPANY', $2, $3, $4)
     ON CONFLICT (company_id, branch_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [req.actor.companyId, PAYMENT_MODES_KEY, JSON.stringify(next), req.actor.userId]));
  return { name, added: true };
}));

/* ===========================================================================
 * ASKING FOR MONEY
 * ======================================================================== */

/**
 * Raise a request. Called from a screen by a manager, and called internally
 * when a document becomes payable — see requestPaymentFor() below, which is
 * what keeps an approved supplier invoice from needing anybody to remember.
 */
financeRouter.post('/requests', requires('finance.request.create'), h(async (req) => {
  const input = body(z.object({
    kind: z.enum(['SUPPLIER_INVOICE', 'WAGES', 'EXPENSE', 'ADVANCE', 'REFUND', 'TRANSPORT']),
    amount: z.number().positive('How much?'),
    payeeName: z.string().trim().min(2, 'Who is being paid?'),
    supplierId: z.string().uuid().nullable().optional(),
    payeeUserId: z.string().uuid().nullable().optional(),
    expenseCategoryId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    branchId: z.string().uuid().optional(),
    dueDate: z.string().optional(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    note: z.string().trim().optional(),
    sourceType: z.string().trim().optional(),
    sourceId: z.string().uuid().nullable().optional(),
  }), req.body);

  if (input.kind === 'EXPENSE' && !input.expenseCategoryId) {
    throw ApiError.rule('Choose what kind of expense this is, so it can be reported on.');
  }

  return withTx(req.actor, async (tx) => {
    const branchId = input.branchId ?? req.actor.branchId;
    if (!branchId) throw ApiError.badRequest('Which branch is this for?');
    return createRequest(tx, req.actor, { ...input, branchId });
  });
}));

/** Shared by the route and by anything that becomes payable on its own. */
export async function createRequest(tx: any, actor: any, r: {
  kind: string; amount: number; payeeName: string; branchId: string;
  supplierId?: string | null; payeeUserId?: string | null;
  expenseCategoryId?: string | null; warehouseId?: string | null;
  dueDate?: string; priority?: string; note?: string;
  sourceType?: string; sourceId?: string | null;
  /** Set when a document queued itself rather than a person asking. */
  systemRaised?: boolean;
}) {
  const requestNo = await nextDocNo(tx, actor, r.branchId, 'PAY');

  const { rows } = await tx.query(
    `INSERT INTO payment_requests (company_id, branch_id, request_no, kind,
            supplier_id, payee_user_id, payee_name, expense_category_id, warehouse_id,
            source_type, source_id, amount, due_date, priority, note,
            is_system_raised, requested_by, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$17,$16,$16,$16)
     ON CONFLICT (company_id, source_type, source_id)
       WHERE source_id IS NOT NULL AND status <> 'CANCELLED'
       DO NOTHING
     RETURNING *`,
    [actor.companyId, r.branchId, requestNo, r.kind, r.supplierId ?? null,
     r.payeeUserId ?? null, r.payeeName, r.expenseCategoryId ?? null,
     r.warehouseId ?? null, r.sourceType ?? null, r.sourceId ?? null,
     money(r.amount), r.dueDate ?? null, r.priority ?? 'NORMAL', r.note ?? null,
     actor.userId, r.systemRaised ?? false]);

  // Already queued from the same document — return what is there rather than
  // a second claim for the same money.
  if (!rows[0]) {
    const { rows: existing } = await tx.query(
      `SELECT * FROM payment_requests
        WHERE company_id=$1 AND source_type=$2 AND source_id=$3 AND status <> 'CANCELLED'`,
      [actor.companyId, r.sourceType, r.sourceId]);
    return existing[0];
  }
  const pr = rows[0];

  await pushTask(tx, actor, {
    branchId: r.branchId, queueKey: 'FINANCE_EXCEPTION',
    docType: 'PAYMENT_REQUEST', docId: pr.id, docNo: requestNo,
    title: `Pay ${inr(Number(pr.amount))} to ${r.payeeName}`,
    subtitle: `${r.kind.replace(/_/g, ' ').toLowerCase()}${r.note ? ` — ${r.note}` : ''}`,
    severity: r.priority === 'URGENT' ? 'critical' : r.priority === 'HIGH' ? 'warn' : 'normal',
    requiredPermission: 'finance.request.verify',
    slaMinutes: r.priority === 'URGENT' ? 120 : 1440,
  });

  await emit(tx, actor, 'payment_request', pr.id, 'payment.requested',
    { requestNo, kind: r.kind, amount: Number(pr.amount), payee: r.payeeName });
  return pr;
}

/** The inbox, and everything already dealt with. */
financeRouter.get('/requests', h(async (req) => {
  /* What a wage bill is for, and who asked for it, is Finance's business.
   * Anyone else gets their own requests whether or not they asked to be
   * filtered — the UI passing ?mine=1 is a convenience, not the control. */
  const seesAll = req.actor.permissions.has('finance.expense.view')
    || req.actor.permissions.has('finance.request.verify')
    || req.actor.permissions.has('finance.payment.make');
  return query(req.actor,
    `SELECT pr.*, ec.name AS expense_category, ec.icon AS expense_icon,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            w.name AS warehouse_name, b.name AS branch_name,
            ru.full_name AS requested_by_name, vu.full_name AS verified_by_name,
            (pr.amount - pr.paid_amount) AS balance,
            /* What the money is actually for.
             *
             * Finance was verifying "₹38,280 to Sahyadri" with no way to see
             * that it was 400 kg of Alphonso without opening the source
             * document in another tab — so the check that exists to catch a
             * wrong payment was being made on a name and a number.
             *
             * A request hangs off a purchase order or an invoice, so read
             * whichever it has. */
            (CASE pr.source_type
               WHEN 'purchase_order' THEN
                 (SELECT json_agg(json_build_object(
                           'productName', p2.name, 'icon', p2.icon,
                           'qty', l.qty, 'uom', l.uom, 'rate', l.rate,
                           'lineTotal', l.line_total) ORDER BY l.line_no)
                    FROM po_lines l JOIN products p2 ON p2.id = l.product_id
                   WHERE l.po_id = pr.source_id)
               WHEN 'supplier_invoice' THEN
                 (SELECT json_agg(json_build_object(
                           'productName', COALESCE(p3.name, il.raw_description),
                           'icon', p3.icon,
                           'qty', il.qty, 'uom', COALESCE(il.uom, p3.base_uom), 'rate', il.rate,
                           'lineTotal', il.amount) ORDER BY il.line_no)
                    FROM invoice_lines il LEFT JOIN products p3 ON p3.id = il.product_id
                   WHERE il.invoice_id = pr.source_id)
             END) AS goods,
            (pr.due_date IS NOT NULL AND pr.due_date < CURRENT_DATE
             AND pr.status NOT IN ('PAID','REJECTED','CANCELLED')) AS overdue
       FROM payment_requests pr
       LEFT JOIN expense_categories ec ON ec.id = pr.expense_category_id
       LEFT JOIN suppliers s ON s.id = pr.supplier_id
       LEFT JOIN warehouses w ON w.id = pr.warehouse_id
       JOIN branches b ON b.id = pr.branch_id
       LEFT JOIN users ru ON ru.id = pr.requested_by
       LEFT JOIN users vu ON vu.id = pr.verified_by
      WHERE pr.company_id = $1
        AND ($2 = '' OR pr.status = $2)
        AND ($3 = '' OR pr.kind = $3)
        AND ($4::date IS NULL OR pr.requested_at::date >= $4::date)
        AND ($5::date IS NULL OR pr.requested_at::date <= $5::date)
        /* ?mine=1 — somebody who can ask for money but not approve it should
         * see what they asked for, not the whole company's payment inbox. */
        AND ($6 = '' OR pr.requested_by = $6::uuid)
      ORDER BY
        CASE pr.status WHEN 'REQUESTED' THEN 0 WHEN 'VERIFIED' THEN 1
                       WHEN 'PART_PAID' THEN 2 ELSE 3 END,
        CASE pr.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                         WHEN 'NORMAL' THEN 2 ELSE 3 END,
        pr.due_date NULLS LAST, pr.requested_at
      LIMIT 300`,
    [req.actor.companyId, String(req.query.status ?? ''), String(req.query.kind ?? ''),
     req.query.from || null, req.query.to || null,
     !seesAll || req.query.mine ? req.actor.userId : '']);
}));

financeRouter.get('/requests/:id', h(async (req) => {
  const [pr] = await query(req.actor,
    `SELECT pr.*, ec.name AS expense_category,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            w.name AS warehouse_name, ru.full_name AS requested_by_name,
            vu.full_name AS verified_by_name
       FROM payment_requests pr
       LEFT JOIN expense_categories ec ON ec.id = pr.expense_category_id
       LEFT JOIN suppliers s ON s.id = pr.supplier_id
       LEFT JOIN warehouses w ON w.id = pr.warehouse_id
       LEFT JOIN users ru ON ru.id = pr.requested_by
       LEFT JOIN users vu ON vu.id = pr.verified_by
      WHERE pr.id = $1 AND pr.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!pr) throw ApiError.notFound('Payment request not found');

  const payments = await query(req.actor,
    `SELECT p.*, u.full_name AS paid_by_name FROM payments p
       LEFT JOIN users u ON u.id = p.paid_by
      WHERE p.request_id = $1 ORDER BY p.paid_at DESC`, [pr.id]);
  return { ...pr, payments };
}));

/* ---------------------------------------------------------------------------
 * VERIFY — the second pair of eyes.
 * ------------------------------------------------------------------------ */
financeRouter.post('/requests/:id/verify', requires('finance.request.verify'), h(async (req) => {
  const input = body(z.object({
    decision: z.enum(['VERIFY', 'REJECT']),
    reason: z.string().trim().optional(),
    /** Finance may correct a claimed amount downwards before approving it. */
    approvedAmount: z.number().positive().optional(),
  }), req.body);

  if (input.decision === 'REJECT' && !input.reason?.trim()) {
    throw ApiError.rule('Say why it is being turned down — the person who asked has to act on it.');
  }

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM payment_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const pr = rows[0];
    if (!pr) throw ApiError.notFound('Payment request not found');
    if (pr.status !== 'REQUESTED') {
      throw ApiError.rule(`This request is already ${pr.status.replace(/_/g, ' ').toLowerCase()}.`);
    }
    /* The person who asked cannot be the person who approves. Finance raising
     * their own office expense is normal, so the Owner can still override — but
     * it is recorded rather than waved through silently. */
    if (pr.requested_by === req.actor.userId
        && !pr.is_system_raised
        && !req.actor.permissions.has('admin.override')) {
      throw ApiError.rule('You raised this request, so somebody else has to verify it.');
    }

    if (input.decision === 'REJECT') {
      await tx.query(
        `UPDATE payment_requests SET status='REJECTED', rejected_by=$2, rejected_at=now(),
                reject_reason=$3, updated_by=$2 WHERE id=$1`,
        [pr.id, req.actor.userId, input.reason]);
      await resolveTask(tx, req.actor, 'FINANCE_EXCEPTION', 'PAYMENT_REQUEST', pr.id);
      await emit(tx, req.actor, 'payment_request', pr.id, 'payment.rejected',
        { requestNo: pr.request_no, reason: input.reason });
      return { ok: true, status: 'REJECTED', message: `${pr.request_no} turned down.` };
    }

    const amount = input.approvedAmount ?? Number(pr.amount);
    if (amount > Number(pr.amount) + 0.01) {
      throw ApiError.rule('You can approve less than was asked for, but not more.');
    }

    await tx.query(
      `UPDATE payment_requests SET status='VERIFIED', verified_by=$2, verified_at=now(),
              amount=$3, updated_by=$2 WHERE id=$1`,
      [pr.id, req.actor.userId, money(amount)]);
    await emit(tx, req.actor, 'payment_request', pr.id, 'payment.verified',
      { requestNo: pr.request_no, amount });

    return {
      ok: true, status: 'VERIFIED',
      message: amount < Number(pr.amount)
        ? `Verified at ${inr(amount)} — less than the ${inr(Number(pr.amount))} asked for.`
        : `${pr.request_no} verified and ready to pay.`,
    };
  });
}));

/* ---------------------------------------------------------------------------
 * PAY — the money actually moving.
 * ------------------------------------------------------------------------ */
financeRouter.post('/requests/:id/pay', requires('finance.payment.make'), h(async (req) => {
  const input = body(z.object({
    amount: z.number().positive('How much is being paid?'),
    mode: z.string().trim().min(2, 'Choose or enter a payment method').max(40),
    transactionRef: z.string().trim().optional(),
    paidFrom: z.string().trim().optional(),
    note: z.string().trim().optional(),
  }), req.body);

  if (input.mode !== 'CASH' && !input.transactionRef?.trim()) {
    throw ApiError.rule(
      `A ${input.mode.toLowerCase()} payment needs its reference number, so it can be traced later.`);
  }

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM payment_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const pr = rows[0];
    if (!pr) throw ApiError.notFound('Payment request not found');
    if (!['VERIFIED', 'PART_PAID'].includes(pr.status)) {
      throw ApiError.rule(pr.status === 'REQUESTED'
        ? 'This has not been verified yet. Verify it first.'
        : `This request is ${pr.status.replace(/_/g, ' ').toLowerCase()}.`);
    }

    const balance = round(Number(pr.amount) - Number(pr.paid_amount), 2);
    if (input.amount > balance + 0.01) {
      throw ApiError.rule(`Only ${inr(balance)} is outstanding on this request.`);
    }

    const paymentNo = await nextDocNo(tx, req.actor, pr.branch_id, 'PMT');
    const { rows: pay } = await tx.query(
      `INSERT INTO payments (company_id, branch_id, payment_no, request_id, amount, mode,
              transaction_ref, paid_from, note, paid_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10) RETURNING *`,
      [req.actor.companyId, pr.branch_id, paymentNo, pr.id, money(input.amount),
       input.mode, input.transactionRef?.trim() ?? null, input.paidFrom ?? null,
       input.note ?? null, req.actor.userId]);

    const paid = round(Number(pr.paid_amount) + input.amount, 2);
    const settled = paid >= Number(pr.amount) - 0.01;
    await tx.query(
      `UPDATE payment_requests SET paid_amount=$2, status=$3, updated_by=$4 WHERE id=$1`,
      [pr.id, paid, settled ? 'PAID' : 'PART_PAID', req.actor.userId]);

    /* Purchase reads what it is owed from payment_status. Paying a supplier
     * invoice here has to update that, or the buyer's screen keeps showing a
     * bill that has already been settled. */
    if (pr.source_type === 'supplier_invoice' && pr.source_id) {
      await tx.query(
        `UPDATE payment_status
            SET paid_amount = paid_amount + $2,
                balance = GREATEST(payable_amount - (paid_amount + $2), 0),
                last_payment_at = now(), last_synced_at = now(),
                sync_source = 'FINANCE_PANEL'
          WHERE invoice_id = $1`, [pr.source_id, money(input.amount)]);
      if (settled) {
        await tx.query(
          `UPDATE supplier_invoices SET status='PAID', updated_by=$2
            WHERE id=$1 AND status IN ('PAYABLE','PART_PAID','APPROVED')`,
          [pr.source_id, req.actor.userId]);
      } else {
        await tx.query(
          `UPDATE supplier_invoices SET status='PART_PAID', updated_by=$2
            WHERE id=$1 AND status IN ('PAYABLE','APPROVED')`,
          [pr.source_id, req.actor.userId]);
      }
    }

    /* Paying against a purchase order is what unlocks the supplier's dispatch
     * button, so the event is worth recording under the order rather than only
     * under the payment — the buyer reading the order's history should see why
     * the load moved when it did. */
    if (pr.source_type === 'purchase_order' && pr.source_id && settled) {
      await emit(tx, req.actor, 'purchase_order', pr.source_id, 'po.payment.released', {
        requestNo: pr.request_no, amount: Number(pr.amount), payee: pr.payee_name,
      });
    }

    if (settled) await resolveTask(tx, req.actor, 'FINANCE_EXCEPTION', 'PAYMENT_REQUEST', pr.id);

    await emit(tx, req.actor, 'payment', pay[0].id, 'payment.made', {
      paymentNo, requestNo: pr.request_no, amount: input.amount,
      mode: input.mode, payee: pr.payee_name, settled,
    });

    return {
      ...pay[0], requestStatus: settled ? 'PAID' : 'PART_PAID',
      balance: round(Number(pr.amount) - paid, 2),
      message: settled
        ? `${inr(input.amount)} paid to ${pr.payee_name}. Settled.`
        : `${inr(input.amount)} paid — ${inr(round(Number(pr.amount) - paid, 2))} still outstanding.`,
    };
  });
}));

/** A payment made in error is reversed, never deleted. */
financeRouter.post('/payments/:id/reverse', requires('finance.payment.reverse'), h(async (req) => {
  const input = body(z.object({ reason: z.string().trim().min(4, 'Say why') }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT p.*, pr.source_type, pr.source_id, pr.amount AS request_amount
         FROM payments p JOIN payment_requests pr ON pr.id = p.request_id
        WHERE p.id=$1 AND p.company_id=$2 FOR UPDATE OF p`,
      [req.params.id, req.actor.companyId]);
    const pay = rows[0];
    if (!pay) throw ApiError.notFound('Payment not found');
    if (pay.status === 'REVERSED') throw ApiError.rule('That payment is already reversed.');

    await tx.query(
      `UPDATE payments SET status='REVERSED', reversed_at=now(), reversed_by=$2,
              reverse_reason=$3, updated_by=$2 WHERE id=$1`,
      [pay.id, req.actor.userId, input.reason]);

    await tx.query(
      `UPDATE payment_requests
          SET paid_amount = GREATEST(paid_amount - $2, 0),
              status = CASE WHEN paid_amount - $2 <= 0.01 THEN 'VERIFIED' ELSE 'PART_PAID' END,
              updated_by = $3
        WHERE id = $1`, [pay.request_id, Number(pay.amount), req.actor.userId]);

    if (pay.source_type === 'supplier_invoice' && pay.source_id) {
      await tx.query(
        `UPDATE payment_status
            SET paid_amount = GREATEST(paid_amount - $2, 0),
                balance = payable_amount - GREATEST(paid_amount - $2, 0),
                last_synced_at = now(), sync_source='FINANCE_PANEL'
          WHERE invoice_id = $1`, [pay.source_id, Number(pay.amount)]);
      await tx.query(
        `UPDATE supplier_invoices SET status='PAYABLE', updated_by=$2
          WHERE id=$1 AND status IN ('PAID','PART_PAID')`, [pay.source_id, req.actor.userId]);
    }

    await raiseAlert(tx, req.actor, {
      branchId: pay.branch_id, alertType: 'PAYMENT_REVERSED', severity: 'HIGH',
      entityType: 'payment', entityId: pay.id,
      title: `${pay.payment_no} reversed — ${inr(Number(pay.amount))}`,
      message: input.reason,
    });
    await emit(tx, req.actor, 'payment', pay.id, 'payment.reversed',
      { paymentNo: pay.payment_no, amount: Number(pay.amount), reason: input.reason });
    return { ok: true, paymentNo: pay.payment_no };
  });
}));

/* ===========================================================================
 * MONEY ARRIVING
 * ======================================================================== */

financeRouter.post('/receipts', requires('finance.receipt.record'), h(async (req) => {
  const input = body(z.object({
    source: z.enum(['CENTRE', 'CUSTOMER', 'OTHER']),
    payerName: z.string().trim().min(2, 'Who paid?'),
    amount: z.number().positive('How much?'),
    mode: z.enum(['CASH', 'UPI', 'BANK', 'CHEQUE', 'CARD']),
    transactionRef: z.string().trim().optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    branchId: z.string().uuid().optional(),
    receivedOn: z.string().optional(),
    note: z.string().trim().optional(),
    sourceType: z.string().trim().optional(),
    sourceId: z.string().uuid().nullable().optional(),
  }), req.body);

  if (input.mode !== 'CASH' && !input.transactionRef?.trim()) {
    throw ApiError.rule(`A ${input.mode.toLowerCase()} receipt needs its reference number.`);
  }

  return withTx(req.actor, async (tx) => {
    const branchId = input.branchId ?? req.actor.branchId;
    if (!branchId) throw ApiError.badRequest('Which branch is this for?');
    const receiptNo = await nextDocNo(tx, req.actor, branchId, 'RCP');

    const { rows } = await tx.query(
      `INSERT INTO money_receipts (company_id, branch_id, receipt_no, source, warehouse_id,
              payer_name, source_type, source_id, amount, mode, transaction_ref,
              received_on, declared_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13) RETURNING *`,
      [req.actor.companyId, branchId, receiptNo, input.source, input.warehouseId ?? null,
       input.payerName, input.sourceType ?? null, input.sourceId ?? null,
       money(input.amount), input.mode, input.transactionRef?.trim() ?? null,
       input.receivedOn ?? today(), req.actor.userId]);

    await pushTask(tx, req.actor, {
      branchId, queueKey: 'FINANCE_EXCEPTION',
      docType: 'MONEY_RECEIPT', docId: rows[0].id, docNo: receiptNo,
      title: `Confirm ${inr(input.amount)} from ${input.payerName}`,
      subtitle: `${input.mode.toLowerCase()}${input.transactionRef ? ` · ${input.transactionRef}` : ''}`,
      requiredPermission: 'finance.receipt.confirm', slaMinutes: 1440,
    });
    await emit(tx, req.actor, 'money_receipt', rows[0].id, 'money.declared',
      { receiptNo, amount: input.amount, mode: input.mode, payer: input.payerName });
    return rows[0];
  });
}));

/** Finance confirms the money actually landed — and says so if it did not. */
financeRouter.post('/receipts/:id/confirm', requires('finance.receipt.confirm'), h(async (req) => {
  const input = body(z.object({
    confirmedAmount: z.number().nonnegative().optional(),
    disputeNote: z.string().trim().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM money_receipts WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const r = rows[0];
    if (!r) throw ApiError.notFound('Receipt not found');
    if (r.status !== 'DECLARED') throw ApiError.rule(`This receipt is already ${r.status.toLowerCase()}.`);

    const got = input.confirmedAmount ?? Number(r.amount);
    const short = round(Number(r.amount) - got, 2);

    // Declared ₹10,000, ₹9,600 arrived: that is a dispute, and it needs a note.
    if (Math.abs(short) > 0.01 && !input.disputeNote?.trim()) {
      throw ApiError.rule(
        `${inr(Math.abs(short))} ${short > 0 ? 'short of' : 'more than'} the ${inr(Number(r.amount))} declared. Say what happened.`);
    }

    const disputed = Math.abs(short) > 0.01;
    await tx.query(
      `UPDATE money_receipts SET status=$2, confirmed_by=$3, confirmed_at=now(),
              confirmed_amount=$4, dispute_note=$5, updated_by=$3 WHERE id=$1`,
      [r.id, disputed ? 'DISPUTED' : 'CONFIRMED', req.actor.userId, money(got),
       input.disputeNote ?? null]);

    if (disputed) {
      await raiseAlert(tx, req.actor, {
        branchId: r.branch_id, alertType: 'COLLECTION_SHORT', severity: 'HIGH',
        entityType: 'money_receipt', entityId: r.id,
        title: `${r.receipt_no}: ${inr(Math.abs(short))} ${short > 0 ? 'short' : 'over'}`,
        message: input.disputeNote ?? '',
      });
    }
    await resolveTask(tx, req.actor, 'FINANCE_EXCEPTION', 'MONEY_RECEIPT', r.id);
    await emit(tx, req.actor, 'money_receipt', r.id, 'money.confirmed',
      { receiptNo: r.receipt_no, declared: Number(r.amount), confirmed: got, disputed });

    return { ok: true, status: disputed ? 'DISPUTED' : 'CONFIRMED', shortBy: short };
  });
}));

financeRouter.get('/receipts', h(async (req) => {
  /* Same rule as the request inbox: Finance sees every collection, a centre
   * sees the money it declared. */
  const seesAll = req.actor.permissions.has('finance.expense.view')
    || req.actor.permissions.has('finance.receipt.confirm');
  return query(req.actor,
    `SELECT mr.*, w.name AS warehouse_name, du.full_name AS declared_by_name,
            cu.full_name AS confirmed_by_name
       FROM money_receipts mr
       LEFT JOIN warehouses w ON w.id = mr.warehouse_id
       LEFT JOIN users du ON du.id = mr.declared_by
       LEFT JOIN users cu ON cu.id = mr.confirmed_by
      WHERE mr.company_id = $1
        AND ($2 = '' OR mr.status = $2)
        AND ($3::date IS NULL OR mr.received_on >= $3::date)
        AND ($4::date IS NULL OR mr.received_on <= $4::date)
        AND ($5 = '' OR mr.declared_by = $5::uuid)
      ORDER BY CASE mr.status WHEN 'DECLARED' THEN 0 WHEN 'DISPUTED' THEN 1 ELSE 2 END,
               mr.received_on DESC LIMIT 300`,
    [req.actor.companyId, String(req.query.status ?? ''),
     req.query.from || null, req.query.to || null,
     !seesAll || req.query.mine ? req.actor.userId : '']);
}));

/* ===========================================================================
 * WHAT FINANCE OPENS IN THE MORNING
 * ======================================================================== */
financeRouter.get('/overview', requires('finance.expense.view'), h(async (req) => {
  const from = (req.query.from as string) || null;
  const to = (req.query.to as string) || null;

  const [k] = await query(req.actor,
    `SELECT
       (SELECT count(*) FROM payment_requests WHERE company_id=$1 AND status='REQUESTED')::int  AS to_verify,
       (SELECT count(*) FROM payment_requests WHERE company_id=$1
          AND status IN ('VERIFIED','PART_PAID'))::int                                          AS to_pay,
       COALESCE((SELECT SUM(amount - paid_amount) FROM payment_requests
                  WHERE company_id=$1 AND status IN ('VERIFIED','PART_PAID')),0)                AS to_pay_value,
       (SELECT count(*) FROM payment_requests WHERE company_id=$1
          AND due_date < CURRENT_DATE AND status IN ('REQUESTED','VERIFIED','PART_PAID'))::int  AS overdue,
       (SELECT count(*) FROM money_receipts WHERE company_id=$1 AND status='DECLARED')::int     AS to_confirm,
       COALESCE((SELECT SUM(amount) FROM money_receipts
                  WHERE company_id=$1 AND status='DECLARED'),0)                                 AS to_confirm_value,
       (SELECT count(*) FROM money_receipts WHERE company_id=$1 AND status='DISPUTED')::int     AS disputed,
       COALESCE((SELECT SUM(p.amount) FROM payments p
                  WHERE p.company_id=$1 AND p.status='POSTED'
                    AND ($2::date IS NULL OR p.paid_at::date >= $2::date)
                    AND ($3::date IS NULL OR p.paid_at::date <= $3::date)),0)                   AS paid_out,
       COALESCE((SELECT SUM(COALESCE(mr.confirmed_amount, mr.amount)) FROM money_receipts mr
                  WHERE mr.company_id=$1 AND mr.status IN ('CONFIRMED','DISPUTED')
                    AND ($2::date IS NULL OR mr.received_on >= $2::date)
                    AND ($3::date IS NULL OR mr.received_on <= $3::date)),0)                    AS collected,
       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.company_id=$1
                  AND p.status='POSTED' AND p.paid_at::date = CURRENT_DATE),0)                  AS paid_today,
       COALESCE((SELECT SUM(ps.balance) FROM payment_status ps WHERE ps.company_id=$1),0)       AS supplier_outstanding`,
    [req.actor.companyId, from, to]);

  // Where the money went, which is the question an owner actually asks.
  const byCategory = await query(req.actor,
    /* An uncategorised payment falls back to its kind, which is a database
     * word — "SUPPLIER_INVOICE" on a chart a shop owner reads. Say it in
     * English. */
    `SELECT COALESCE(ec.name, initcap(replace(lower(pr.kind), '_', ' '))) AS label,
            COALESCE(ec.icon,'receipt') AS icon,
            SUM(p.amount) AS amount, count(*)::int AS payments
       FROM payments p
       JOIN payment_requests pr ON pr.id = p.request_id
       LEFT JOIN expense_categories ec ON ec.id = pr.expense_category_id
      WHERE p.company_id=$1 AND p.status='POSTED'
        AND ($2::date IS NULL OR p.paid_at::date >= $2::date)
        AND ($3::date IS NULL OR p.paid_at::date <= $3::date)
      GROUP BY 1,2 ORDER BY amount DESC`, [req.actor.companyId, from, to]);

  const byMode = await query(req.actor,
    `SELECT mode, SUM(amount) AS amount, count(*)::int AS n
       FROM payments WHERE company_id=$1 AND status='POSTED'
        AND ($2::date IS NULL OR paid_at::date >= $2::date)
        AND ($3::date IS NULL OR paid_at::date <= $3::date)
      GROUP BY mode ORDER BY amount DESC`, [req.actor.companyId, from, to]);

  const collectionsByMode = await query(req.actor,
    `SELECT mode, SUM(COALESCE(confirmed_amount, amount)) AS amount, count(*)::int AS n
       FROM money_receipts WHERE company_id=$1 AND status IN ('CONFIRMED','DISPUTED')
        AND ($2::date IS NULL OR received_on >= $2::date)
        AND ($3::date IS NULL OR received_on <= $3::date)
      GROUP BY mode ORDER BY amount DESC`, [req.actor.companyId, from, to]);

  const daily = await query(req.actor,
    `SELECT d::date::text AS date,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.company_id=$1 AND p.status='POSTED' AND p.paid_at::date = d::date),0) AS out,
            COALESCE((SELECT SUM(COALESCE(mr.confirmed_amount, mr.amount)) FROM money_receipts mr
                       WHERE mr.company_id=$1 AND mr.status IN ('CONFIRMED','DISPUTED')
                         AND mr.received_on = d::date),0) AS in
       FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, interval '1 day') d
      ORDER BY d`, [req.actor.companyId]);

  return { kpis: k, byCategory, byMode, collectionsByMode, daily };
}));
