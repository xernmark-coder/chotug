import { Router } from 'express';
import { z } from 'zod';
import { pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';

/* ===========================================================================
 * SUPPLIER PORTAL
 *
 * Outside users. Everything here is scoped by the supplier_id on the signed-in
 * user's own row — not by a parameter they send, and not by a list of things
 * they are forbidden. If a query in this file does not filter by mySupplier(),
 * it is a bug.
 *
 * They can see the orders addressed to them and the receipts booked against
 * those orders, and file an invoice. They cannot see another supplier, our
 * stock, our margins, or what we paid anybody else.
 * ======================================================================== */

export const supplierRouter = Router();
supplierRouter.use(authenticate);
supplierRouter.use(requires('supplier.portal.access'));

/** The one line every query in this file depends on. */
async function mySupplier(actor: any): Promise<string> {
  const { rows } = await pool.query(
    `SELECT supplier_id FROM users WHERE id = $1`, [actor.userId]);
  const id = rows[0]?.supplier_id;
  if (!id) {
    throw ApiError.forbidden(
      'This login is not linked to a supplier. Ask the buyer who invited you to set it up again.');
  }
  return id;
}

supplierRouter.get('/me', h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  const [s] = await query(req.actor,
    `SELECT s.id, s.trade_name, s.legal_name, s.source_type, s.gstin, s.phone,
            s.payment_terms_days, s.status, c.trade_name AS buyer_name
       FROM suppliers s JOIN companies c ON c.id = s.company_id
      WHERE s.id = $1 AND s.company_id = $2`,
    [supplierId, req.actor.companyId]);
  if (!s) throw ApiError.notFound('Supplier not found');
  return s;
}));

/** Orders addressed to me. Draft orders are ours until we confirm them, so
 *  they are not the supplier's business and never appear. */
supplierRouter.get('/orders', requires('supplier.order.view'), h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  return query(req.actor,
    `SELECT o.id, o.po_no, o.order_date, o.expected_date, o.status, o.grand_total,
            o.payment_terms_days, o.is_urgent, b.name AS branch_name,
            (SELECT count(*) FROM po_lines l WHERE l.po_id = o.id) AS line_count,
            (SELECT count(*) FROM grns g WHERE g.po_id = o.id AND g.status = 'POSTED') AS receipts,
            EXISTS (SELECT 1 FROM supplier_invoices i
                     WHERE i.po_id = o.id AND i.status <> 'CANCELLED') AS invoiced
       FROM purchase_orders o
       JOIN branches b ON b.id = o.branch_id
      WHERE o.company_id = $1 AND o.supplier_id = $2
        AND o.status NOT IN ('DRAFT', 'CANCELLED')
      ORDER BY o.order_date DESC, o.po_no DESC LIMIT 200`,
    [req.actor.companyId, supplierId]);
}));

supplierRouter.get('/orders/:id', requires('supplier.order.view'), h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  const [o] = await query(req.actor,
    `SELECT o.*, b.name AS branch_name FROM purchase_orders o
       JOIN branches b ON b.id = o.branch_id
      WHERE o.id = $1 AND o.company_id = $2 AND o.supplier_id = $3
        AND o.status NOT IN ('DRAFT','CANCELLED')`,
    [req.params.id, req.actor.companyId, supplierId]);
  if (!o) throw ApiError.notFound('Order not found');
  const lines = await query(req.actor,
    `SELECT l.id, l.line_no, l.qty, l.uom, l.rate, l.line_total, p.name AS product_name, p.sku
       FROM po_lines l JOIN products p ON p.id = l.product_id
      WHERE l.po_id = $1 ORDER BY l.line_no`, [o.id]);
  return { ...o, lines };
}));

/**
 * What I have delivered and what is still unbilled — the list a supplier
 * actually needs, because an invoice should be raised against what was
 * ACCEPTED, not against what was ordered.
 */
supplierRouter.get('/receipts', requires('supplier.invoice.submit'), h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  return query(req.actor,
    `SELECT g.id, g.grn_no, g.posting_date, g.po_id, o.po_no, g.total_value,
            EXISTS (SELECT 1 FROM invoice_lines il
                      JOIN grn_lines gl2 ON gl2.id = il.matched_grn_line_id
                      JOIN supplier_invoices i2 ON i2.id = il.invoice_id
                     WHERE gl2.grn_id = g.id AND i2.status <> 'CANCELLED') AS already_billed,
            (SELECT json_agg(json_build_object(
                      'grnLineId', gl.id, 'poLineId', gl.po_line_id,
                      'productId', gl.product_id, 'product', p.name, 'sku', p.sku,
                      'acceptedQty', gl.accepted_qty, 'rejectedQty', gl.rejected_qty,
                      'uom', gl.uom, 'rate', gl.rate) ORDER BY gl.line_no)
               FROM grn_lines gl JOIN products p ON p.id = gl.product_id
              WHERE gl.grn_id = g.id AND gl.accepted_qty > 0) AS lines
       FROM grns g
       LEFT JOIN purchase_orders o ON o.id = g.po_id
      WHERE g.company_id = $1 AND g.supplier_id = $2 AND g.status = 'POSTED'
      ORDER BY g.posting_date DESC LIMIT 100`,
    [req.actor.companyId, supplierId]);
}));

supplierRouter.get('/invoices', requires('supplier.invoice.view'), h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  return query(req.actor,
    `SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.total, i.status,
            i.hold_reason, o.po_no,
            COALESCE(ps.paid_amount, 0) AS paid_amount, ps.balance,
            (SELECT json_agg(json_build_object(
                      'noteNo', n.note_no, 'type', n.note_type, 'reason', n.reason_code,
                      'amount', n.total, 'status', n.status))
               FROM credit_debit_notes n WHERE n.invoice_id = i.id) AS notes
       FROM supplier_invoices i
       LEFT JOIN purchase_orders o ON o.id = i.po_id
       LEFT JOIN payment_status ps ON ps.invoice_id = i.id
      WHERE i.company_id = $1 AND i.supplier_id = $2
      ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 200`,
    [req.actor.companyId, supplierId]);
}));

/**
 * File an invoice against one of my own posted receipts.
 *
 * The lines are built on the server from the GRN, not from the browser: the
 * supplier states an invoice number, a date and a rate per line, and the
 * quantities come from what we actually accepted. That removes the single
 * biggest source of mismatch — a hand-typed quantity — while still letting the
 * rate differ, which is the disagreement worth having a match engine for.
 */
supplierRouter.post('/invoices', requires('supplier.invoice.submit'), h(async (req) => {
  const input = body(z.object({
    grnId: z.string().uuid(),
    invoiceNo: z.string().trim().min(1, 'Enter your invoice number'),
    invoiceDate: z.string(),
    lines: z.array(z.object({
      grnLineId: z.string().uuid(),
      rate: z.coerce.number().nonnegative(),
    })).min(1, 'Nothing to bill'),
    taxAmount: z.coerce.number().nonnegative().default(0),
    charges: z.coerce.number().nonnegative().default(0),
    remarks: z.string().trim().optional(),
  }), req.body);

  const supplierId = await mySupplier(req.actor);

  return withTx(req.actor, async (tx) => {
    const { rows: gRows } = await tx.query(
      `SELECT g.id, g.branch_id, g.po_id, o.payment_terms_days
         FROM grns g LEFT JOIN purchase_orders o ON o.id = g.po_id
        WHERE g.id = $1 AND g.company_id = $2 AND g.supplier_id = $3 AND g.status = 'POSTED'`,
      [input.grnId, req.actor.companyId, supplierId]);
    const grn = gRows[0];
    if (!grn) throw ApiError.notFound('That receipt is not one of yours.');

    const { rows: dup } = await tx.query(
      `SELECT invoice_no, invoice_date, total FROM supplier_invoices
        WHERE company_id=$1 AND supplier_id=$2 AND lower(invoice_no)=lower($3)
          AND status <> 'CANCELLED' LIMIT 1`,
      [req.actor.companyId, supplierId, input.invoiceNo]);
    if (dup[0]) {
      throw ApiError.conflict(
        `You have already filed invoice ${dup[0].invoice_no}. Nothing was filed twice.`);
    }

    // Quantities come from the receipt, never from the request.
    const { rows: glines } = await tx.query(
      `SELECT gl.id, gl.product_id, gl.po_line_id, gl.accepted_qty, gl.uom
         FROM grn_lines gl WHERE gl.grn_id = $1 AND gl.accepted_qty > 0`, [grn.id]);
    const byId = new Map(glines.map((g: any) => [g.id, g]));

    let subtotal = 0;
    const lines = input.lines.map((l, i) => {
      const g: any = byId.get(l.grnLineId);
      if (!g) throw ApiError.rule('One of those lines is not on that receipt.');
      const qty = Number(g.accepted_qty);
      const amount = Math.round(qty * l.rate * 100) / 100;
      subtotal += amount;
      return {
        lineNo: i + 1, grnLineId: g.id, poLineId: g.po_line_id, productId: g.product_id,
        qty, uom: g.uom, rate: l.rate, amount,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const total = Math.round((subtotal + input.taxAmount + input.charges) * 100) / 100;

    const terms = Number(grn.payment_terms_days ?? 0);
    const due = new Date(input.invoiceDate);
    due.setDate(due.getDate() + terms);

    const { rows: iRows } = await tx.query(
      `INSERT INTO supplier_invoices (company_id, branch_id, supplier_id, invoice_no, invoice_date,
             due_date, po_id, subtotal, discount, charges, tax_amount, total,
             ocr_arithmetic_ok, status, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,true,'PENDING',$12,$13,$13) RETURNING *`,
      [req.actor.companyId, grn.branch_id, supplierId, input.invoiceNo, input.invoiceDate,
       due.toISOString().slice(0, 10), grn.po_id, subtotal, input.charges, input.taxAmount,
       total, input.remarks ?? null, req.actor.userId]);
    const inv = iRows[0];

    for (const l of lines) {
      await tx.query(
        `INSERT INTO invoice_lines (company_id, invoice_id, line_no, product_id,
               matched_grn_line_id, matched_po_line_id, qty, uom, rate, tax_rate, tax_amount, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10)`,
        [req.actor.companyId, inv.id, l.lineNo, l.productId, l.grnLineId, l.poLineId,
         l.qty, l.uom, l.rate, l.amount]);
    }

    return {
      id: inv.id, invoiceNo: inv.invoice_no, total, subtotal,
      status: inv.status,
      message: 'Filed. It will be checked against the order and the receipt, and you will see the result here.',
    };
  });
}));
