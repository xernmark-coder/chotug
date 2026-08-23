import { Router } from 'express';
import { z } from 'zod';
import { pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, pushTask, resolveTask, raiseAlert } from '../platform/services.js';
import { createRequest } from './finance.js';

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
                     WHERE i.po_id = o.id AND i.status <> 'CANCELLED') AS invoiced,
            /* CONFIRMED is the moment we placed it with them, so it is the
               moment they may act on it. APPROVED means we have signed it off
               internally but not yet placed it. */
            (o.status <> 'APPROVED')                                   AS placed,
            o.supplier_response, o.supplier_responded_at, o.supplier_response_note,
            /* What the supplier needs to know about their own money: have they
             * asked, and has it been paid. Without this the portal can offer
             * "send it" on an order Finance has not released. */
            pr.request_no  AS payment_request_no,
            pr.status      AS payment_status,
            pr.amount      AS payment_amount,
            pr.paid_amount AS payment_paid,
            pr.reject_reason AS payment_reject_reason,
            ea.supplier_marked_sent_at,
            ea.vehicle_hint,
            ea.expected_date AS arrival_date
       FROM purchase_orders o
       JOIN branches b ON b.id = o.branch_id
       LEFT JOIN expected_arrivals ea ON ea.po_id = o.id AND ea.status <> 'CANCELLED'
       /* One claim per order, whichever document it hangs off — see
        * orderPaymentRequest(). A join on source_type='purchase_order' alone
        * would show "not asked for yet" on an order whose invoice is already
        * with Finance. */
       LEFT JOIN LATERAL (
         SELECT x.request_no, x.status, x.amount, x.paid_amount, x.reject_reason
           FROM payment_requests x
          WHERE x.company_id = o.company_id AND x.status <> 'CANCELLED'
            AND ((x.source_type = 'purchase_order' AND x.source_id = o.id)
              OR (x.source_type = 'supplier_invoice' AND x.source_id IN (
                    SELECT id FROM supplier_invoices
                     WHERE po_id = o.id AND status <> 'CANCELLED')))
          ORDER BY x.requested_at LIMIT 1) pr ON true
      WHERE o.company_id = $1 AND o.supplier_id = $2
        /* Approved and onwards only. NOT IN ('DRAFT','CANCELLED') also showed
           SUBMITTED — an order still inside our own approval that we might
           never place. A supplier should not see an order before we have
           decided to give it to them. */
        AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED','RECEIVED','CLOSED')
      ORDER BY o.order_date DESC, o.po_no DESC LIMIT 200`,
    [req.actor.companyId, supplierId]);
}));

supplierRouter.get('/orders/:id', requires('supplier.order.view'), h(async (req) => {
  const supplierId = await mySupplier(req.actor);
  const [o] = await query(req.actor,
    `SELECT o.*, b.name AS branch_name,
            ea.supplier_invoice_no, ea.vehicle_hint, ea.driver_name, ea.driver_phone,
            ea.transporter, ea.lr_no, ea.eway_bill_no, ea.supplier_marked_sent_at,
            pr.request_no AS payment_request_no, pr.status AS payment_status,
            pr.amount AS payment_amount, pr.paid_amount AS payment_paid,
            pr.reject_reason AS payment_reject_reason
       FROM purchase_orders o
       JOIN branches b ON b.id = o.branch_id
       LEFT JOIN expected_arrivals ea ON ea.po_id = o.id AND ea.status <> 'CANCELLED'
       /* One claim per order, whichever document it hangs off — see
        * orderPaymentRequest(). A join on source_type='purchase_order' alone
        * would show "not asked for yet" on an order whose invoice is already
        * with Finance. */
       LEFT JOIN LATERAL (
         SELECT x.request_no, x.status, x.amount, x.paid_amount, x.reject_reason
           FROM payment_requests x
          WHERE x.company_id = o.company_id AND x.status <> 'CANCELLED'
            AND ((x.source_type = 'purchase_order' AND x.source_id = o.id)
              OR (x.source_type = 'supplier_invoice' AND x.source_id IN (
                    SELECT id FROM supplier_invoices
                     WHERE po_id = o.id AND status <> 'CANCELLED')))
          ORDER BY x.requested_at LIMIT 1) pr ON true
      WHERE o.id = $1 AND o.company_id = $2 AND o.supplier_id = $3
        AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED','RECEIVED','CLOSED')`,
    [req.params.id, req.actor.companyId, supplierId]);
  if (!o) throw ApiError.notFound('Order not found');
  const lines = await query(req.actor,
    `SELECT l.id, l.line_no, l.qty, l.uom, l.rate, l.line_total, p.name AS product_name, p.sku
       FROM po_lines l JOIN products p ON p.id = l.product_id
      WHERE l.po_id = $1 ORDER BY l.line_no`, [o.id]);
  return { ...o, lines };
}));

/**
 * The one live money claim against an order — whether it was raised against the
 * order itself or against the invoice the supplier filed for it.
 *
 * Two source types can point at the same goods, and a claim the code cannot see
 * is a claim it will happily let somebody raise a second time. Every rule about
 * this order's money reads through here.
 */
async function orderPaymentRequest(tx: any, companyId: string, poId: string) {
  const { rows } = await tx.query(
    `SELECT pr.* FROM payment_requests pr
      WHERE pr.company_id = $1 AND pr.status <> 'CANCELLED'
        AND ((pr.source_type = 'purchase_order' AND pr.source_id = $2)
          OR (pr.source_type = 'supplier_invoice' AND pr.source_id IN (
                SELECT id FROM supplier_invoices
                 WHERE po_id = $2 AND status <> 'CANCELLED')))
      ORDER BY pr.requested_at LIMIT 1`,
    [companyId, poId]);
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------------------
 * "Yes, I will supply this." — the answer we never used to record.
 *
 * A confirmed order is an offer. Until the supplier answers it, the buyer is
 * planning against a promise nobody made. Accepting starts the money; declining
 * tells the buyer now, while there is still time to place it elsewhere, rather
 * than at the barrier on Thursday morning.
 * ------------------------------------------------------------------------ */
supplierRouter.post('/orders/:id/respond', requires('supplier.order.accept'), h(async (req) => {
  const input = body(z.object({
    decision: z.enum(['ACCEPT', 'DECLINE']),
    note: z.string().trim().max(500).optional(),
    /* Accepting is the supplier's moment of commitment, so it is the moment
     * they know their own invoice number and which lorry it is going on. Both
     * are optional here — a farmer accepting on a phone at 5am may have
     * neither — but everything downstream is easier when they are given. */
    invoiceNo: z.string().trim().max(60).optional(),
    invoiceDate: z.string().optional(),
    invoiceTotal: z.coerce.number().nonnegative().optional(),
    vehicleReg: z.string().trim().max(20).optional(),
    driverName: z.string().trim().max(80).optional(),
    driverPhone: z.string().trim().max(20).optional(),
    transporter: z.string().trim().max(80).optional(),
    lrNo: z.string().trim().max(40).optional(),
    ewayBillNo: z.string().trim().max(40).optional(),
  }), req.body ?? {});

  const supplierId = await mySupplier(req.actor);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT o.id, o.po_no, o.status, o.branch_id, o.warehouse_id, o.grand_total,
              o.supplier_response, o.created_by, o.expected_date
         FROM purchase_orders o
        WHERE o.id = $1 AND o.company_id = $2 AND o.supplier_id = $3
        FOR UPDATE`,
      [req.params.id, req.actor.companyId, supplierId]);
    const o = rows[0];
    if (!o) throw ApiError.notFound('Order not found');

    if (o.status === 'APPROVED') {
      throw ApiError.rule(
        'This order has not been placed with you yet. It will appear once the buyer sends it.');
    }
    if (o.status !== 'CONFIRMED') {
      throw ApiError.rule(
        `This order is ${o.status.replace(/_/g, ' ').toLowerCase()} — it is past the point of accepting.`);
    }
    if (o.supplier_response !== 'PENDING') {
      throw ApiError.rule(
        o.supplier_response === 'ACCEPTED'
          ? 'You have already accepted this order.'
          : 'You have already declined this order. Ask the buyer to place it again.');
    }
    if (input.decision === 'DECLINE' && !input.note) {
      throw ApiError.rule('Tell the buyer why, so they can place it elsewhere.');
    }

    await tx.query(
      `UPDATE purchase_orders
          SET supplier_response = $2, supplier_responded_at = now(),
              supplier_responded_by = $3, supplier_response_note = $4, updated_by = $3
        WHERE id = $1`,
      [o.id, input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED',
       req.actor.userId, input.note ?? null]);

    let invoiceNo: string | null = null;

    if (input.decision === 'ACCEPT') {
      /* The invoice, filed by the person who wrote it. There is no receipt to
       * match it against yet — the goods have not moved — which is precisely
       * what PENDING means. */
      if (input.invoiceNo) {
        const { rows: dup } = await tx.query(
          `SELECT invoice_no FROM supplier_invoices
            WHERE company_id=$1 AND supplier_id=$2 AND lower(invoice_no)=lower($3)
              AND status <> 'CANCELLED' LIMIT 1`,
          [req.actor.companyId, supplierId, input.invoiceNo]);
        if (dup[0]) {
          throw ApiError.conflict(
            `You have already filed invoice ${dup[0].invoice_no}. Use a different number.`);
        }
        const total = input.invoiceTotal ?? Number(o.grand_total);
        await tx.query(
          `INSERT INTO supplier_invoices (company_id, branch_id, supplier_id, po_id,
                  invoice_no, invoice_date, due_date, subtotal, tax_amount, total,
                  status, filed_by_supplier, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$8,'PENDING',true,$9,$9)`,
          [req.actor.companyId, o.branch_id, supplierId, o.id,
           input.invoiceNo, input.invoiceDate ?? new Date().toISOString().slice(0, 10),
           o.expected_date ?? null, total, req.actor.userId]);
        invoiceNo = input.invoiceNo;
      }

      /* The vehicle, onto the row the gate already reads. Confirming the order
       * created this arrival, so this fills it in rather than making a second
       * one for the gate to reconcile. */
      if (input.vehicleReg || input.driverName || invoiceNo) {
        await tx.query(
          `UPDATE expected_arrivals
              SET vehicle_hint = COALESCE($2, vehicle_hint),
                  driver_name  = COALESCE($3, driver_name),
                  driver_phone = COALESCE($4, driver_phone),
                  transporter  = COALESCE($5, transporter),
                  lr_no        = COALESCE($6, lr_no),
                  eway_bill_no = COALESCE($7, eway_bill_no),
                  supplier_invoice_no = COALESCE($8, supplier_invoice_no),
                  updated_by = $9
            WHERE po_id = $1 AND status <> 'CANCELLED'`,
          [o.id, input.vehicleReg ?? null, input.driverName ?? null,
           input.driverPhone ?? null, input.transporter ?? null, input.lrNo ?? null,
           input.ewayBillNo ?? null, invoiceNo, req.actor.userId]);
      }
    }

    if (input.decision === 'DECLINE') {
      /* Confirming the order told the gate to expect a lorry. Nobody is
       * sending one now, so take it off their list — an arrival that will
       * never come teaches the gate to ignore the whole screen. */
      await tx.query(
        `UPDATE expected_arrivals
            SET status = 'CANCELLED', updated_by = $2
          WHERE po_id = $1 AND status NOT IN ('CANCELLED','ARRIVED')`,
        [o.id, req.actor.userId]);
      await resolveTask(tx, req.actor, 'EXPECTED_ARRIVAL', 'PO', o.id);

      /* The buyer has to act on this, so it goes where they work rather than
       * into a notification nobody opens. */
      await pushTask(tx, req.actor, {
        branchId: o.branch_id, warehouseId: o.warehouse_id,
        queueKey: 'PO_CONFIRM', docType: 'PO', docId: o.id, docNo: o.po_no,
        title: `${o.po_no} was declined by the supplier`,
        subtitle: input.note ?? 'No reason given',
        requiredPermission: 'purchase.po.create', severity: 'critical', slaMinutes: 120,
      });
      await raiseAlert(tx, req.actor, {
        alertType: 'PO_DECLINED', severity: 'HIGH', branchId: o.branch_id,
        title: `${o.po_no} declined`,
        message: `The supplier will not supply this order: ${input.note}`,
        entityType: 'purchase_order', entityId: o.id,
      });
    } else {
      await resolveTask(tx, req.actor, 'PO_CONFIRM', 'PO', o.id);
    }

    await emit(tx, req.actor, 'purchase_order', o.id,
      input.decision === 'ACCEPT' ? 'supplier.accepted' : 'supplier.declined',
      { poNo: o.po_no, note: input.note ?? null });

    return {
      ok: true, poNo: o.po_no, response: input.decision, invoiceNo,
      message: input.decision !== 'ACCEPT'
        ? `${o.po_no} declined. We have told the buyer.`
        : invoiceNo
          ? `${o.po_no} accepted and invoice ${invoiceNo} filed. `
            + 'The gate will find the vehicle by that number.'
          : `${o.po_no} accepted. You can now ask for payment.`,
    };
  });
}));

/* ---------------------------------------------------------------------------
 * "Now pay me." — the supplier's claim goes to the same Finance inbox as
 * everybody else's, because there is only one place money leaves from.
 *
 * They may ask for less than the order is worth (an advance against a part
 * load) but never for more, and only once per order — a second claim for the
 * same goods is how a business pays twice.
 * ------------------------------------------------------------------------ */
supplierRouter.post('/orders/:id/request-payment',
  requires('supplier.payment.request'), h(async (req) => {
    const input = body(z.object({
      amount: z.coerce.number().positive('How much are you asking for?').optional(),
      note: z.string().trim().max(500).optional(),
    }), req.body ?? {});

    const supplierId = await mySupplier(req.actor);

    return withTx(req.actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT o.id, o.po_no, o.status, o.branch_id, o.warehouse_id, o.grand_total,
                o.supplier_response, o.expected_date,
                COALESCE(s.trade_name, s.legal_name) AS supplier_name
           FROM purchase_orders o
           JOIN suppliers s ON s.id = o.supplier_id
          WHERE o.id = $1 AND o.company_id = $2 AND o.supplier_id = $3
          FOR UPDATE OF o`,
        [req.params.id, req.actor.companyId, supplierId]);
      const o = rows[0];
      if (!o) throw ApiError.notFound('Order not found');

      if (o.supplier_response !== 'ACCEPTED') {
        throw ApiError.rule('Accept the order first — then you can ask for payment against it.');
      }
      /* Asking twice is not an error — a supplier refreshing the page should
       * be told what they already asked for, not handed a second claim on the
       * same load. createRequest returns the standing request on conflict, so
       * the only thing missing is knowing which of the two happened. */
      const standing = await orderPaymentRequest(tx, req.actor.companyId, o.id);
      if (standing) {
        const a = standing;
        return {
          ok: true, requestNo: a.request_no, amount: a.amount, status: a.status,
          alreadyAsked: true,
          message: a.status === 'REJECTED'
            ? `Finance turned down ${a.request_no}. Speak to the buyer.`
            : a.status === 'PAID'
              ? `${a.request_no} has been paid in full. You can send the order.`
              : `You have already asked for this order — ${a.request_no}, `
                + `₹${Number(a.paid_amount).toFixed(0)} of ₹${Number(a.amount).toFixed(0)} paid so far.`,
        };
      }

      /* If they filed an invoice when they accepted, the claim belongs to that
       * invoice — it is the document Finance will pay against, and hanging the
       * request off the order instead would leave the invoice looking unpaid
       * for ever. */
      const { rows: inv } = await tx.query(
        `SELECT id, invoice_no, total FROM supplier_invoices
          WHERE company_id=$1 AND po_id=$2 AND status <> 'CANCELLED'
          ORDER BY created_at LIMIT 1`,
        [req.actor.companyId, o.id]);

      /* The invoice, where there is one, is the document being paid — so it
       * sets both the default and the ceiling. An invoice can legitimately
       * exceed the order (loading charges, a heavier load inside tolerance);
       * a claim with no document behind it cannot exceed what we ordered. */
      const ceiling = inv[0] ? Number(inv[0].total) : Number(o.grand_total);
      const amount = input.amount ?? ceiling;
      if (amount > ceiling + 0.01) {
        throw ApiError.rule(inv[0]
          ? `Invoice ${inv[0].invoice_no} is for ₹${ceiling.toFixed(2)}. `
            + 'You cannot ask for more than you billed.'
          : `The order is worth ₹${ceiling.toFixed(2)}. You cannot ask for more than that.`);
      }

      const pr = await createRequest(tx, req.actor, {
        kind: inv[0] ? 'SUPPLIER_INVOICE' : 'ADVANCE',
        amount,
        payeeName: o.supplier_name,
        branchId: o.branch_id,
        supplierId,
        warehouseId: o.warehouse_id,
        dueDate: o.expected_date ?? undefined,
        priority: 'HIGH',
        note: [inv[0] ? `Invoice ${inv[0].invoice_no} for ${o.po_no}` : `Payment against ${o.po_no}`,
               input.note].filter(Boolean).join(' — '),
        sourceType: inv[0] ? 'supplier_invoice' : 'purchase_order',
        sourceId: inv[0] ? inv[0].id : o.id,
      });

      return {
        ok: true, requestNo: pr.request_no, amount: pr.amount, status: pr.status,
        message: `Asked for ₹${Number(pr.amount).toFixed(0)}. `
          + `Finance will check it — ${pr.request_no}.`,
      };
    });
  }));

/* ---------------------------------------------------------------------------
 * "It has left." — the one thing a supplier could not tell us.
 *
 * Until now the gate learned a load was coming when the lorry appeared at the
 * barrier. The supplier marks a confirmed order as sent with a vehicle number
 * and a date, and it lands on the gate's Expected Arrivals list — the screen
 * they already work from — so nobody has to be phoned.
 *
 * Only a CONFIRMED order can be sent: APPROVED means we signed it off but have
 * not yet placed it with them, and dispatching against an order we never gave
 * is exactly the surprise delivery this system exists to prevent.
 * ------------------------------------------------------------------------ */
supplierRouter.post('/orders/:id/dispatch', requires('supplier.order.dispatch'), h(async (req) => {
  const input = body(z.object({
    vehicleReg: z.string().trim().min(4, 'Which vehicle is it on?').optional(),
    expectedDate: z.string().optional(),
    note: z.string().trim().optional(),
  }), req.body ?? {});

  const supplierId = await mySupplier(req.actor);

  return withTx(req.actor, async (tx) => {
    const { rows: po } = await tx.query(
      `SELECT o.id, o.po_no, o.status, o.branch_id, o.warehouse_id, o.expected_date,
              o.supplier_response
         FROM purchase_orders o
        WHERE o.id = $1 AND o.company_id = $2 AND o.supplier_id = $3
        FOR UPDATE`,
      [req.params.id, req.actor.companyId, supplierId]);
    const o = po[0];
    if (!o) throw ApiError.notFound('Order not found');
    const pay = await orderPaymentRequest(tx, req.actor.companyId, o.id);

    /* The client's sequence, enforced at the last possible moment rather than
     * hidden by a greyed-out button: accepted, then paid if payment was asked
     * for, then sent. A supplier on credit terms never raises a request, and
     * for them nothing changes — the gate only bites on money they asked for
     * and have not received. */
    if (o.supplier_response !== 'ACCEPTED') {
      throw ApiError.rule(o.supplier_response === 'DECLINED'
        ? 'You declined this order, so it cannot be sent.'
        : 'Accept the order before sending it.');
    }
    if (pay && pay.status !== 'PAID') {
      throw ApiError.rule(
        pay.status === 'REJECTED'
          ? `Finance turned down ${pay.request_no}. Speak to the buyer before sending anything.`
          : `Finance has not released ${pay.request_no} yet `
            + `(₹${Number(pay.paid_amount).toFixed(0)} of ₹${Number(pay.amount).toFixed(0)} paid). `
            + 'You will be able to send this order once the payment is made.');
    }

    if (o.status === 'APPROVED') {
      throw ApiError.rule(
        'This order has not been placed with you yet. It will appear as confirmed once the buyer sends it.');
    }
    if (!['CONFIRMED', 'PART_RECEIVED'].includes(o.status)) {
      throw ApiError.rule(`This order is ${o.status.replace(/_/g, ' ').toLowerCase()} — nothing left to send.`);
    }

    const when = input.expectedDate ?? o.expected_date;

    /* One arrival per order: confirming the PO already created it, so this
     * updates that row rather than adding a second one the gate would have to
     * reconcile. Where none exists (an older order), create it. */
    const { rows: upd } = await tx.query(
      `UPDATE expected_arrivals
          SET expected_date = $2,
              vehicle_hint = COALESCE($3, vehicle_hint),
              slot_booked_by = 'SUPPLIER',
              supplier_marked_sent_at = now(),
              supplier_note = $4,
              status = 'EXPECTED',
              updated_by = $5
        WHERE po_id = $1 AND status <> 'CANCELLED'
        RETURNING id`,
      [o.id, when, input.vehicleReg ?? null, input.note ?? null, req.actor.userId]);

    if (!upd[0]) {
      await tx.query(
        `INSERT INTO expected_arrivals (company_id, branch_id, warehouse_id, po_id,
                expected_date, vehicle_hint, slot_booked_by, supplier_marked_sent_at,
                supplier_note, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'SUPPLIER',now(),$7,'EXPECTED',$8,$8)`,
        [req.actor.companyId, o.branch_id, o.warehouse_id, o.id, when,
         input.vehicleReg ?? null, input.note ?? null, req.actor.userId]);
    }

    // The gate works from the work queue, so put it there too.
    await pushTask(tx, req.actor, {
      branchId: o.branch_id, warehouseId: o.warehouse_id,
      queueKey: 'EXPECTED_ARRIVAL', docType: 'PO', docId: o.id, docNo: o.po_no,
      title: `${o.po_no} is on its way`,
      subtitle: [input.vehicleReg ? `Vehicle ${input.vehicleReg}` : null,
                 `supplier says arriving ${when}`].filter(Boolean).join(' · '),
      requiredPermission: 'receiving.gate.create', slaMinutes: 720,
    });

    await emit(tx, req.actor, 'purchase_order', o.id, 'supplier.dispatched', {
      poNo: o.po_no, vehicleReg: input.vehicleReg ?? null, expectedDate: when,
    });

    return {
      ok: true, poNo: o.po_no, expectedDate: when,
      vehicleReg: input.vehicleReg ?? null,
      message: `Thank you — we have told the gate to expect ${o.po_no}.`,
    };
  });
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

    /* An invoice the supplier files is a request for money like any other, so
     * it joins the same Finance inbox rather than sitting in a portal nobody
     * on our side opens. Finance still verifies it before paying. */
    const { rows: me } = await tx.query(
      `SELECT COALESCE(trade_name, legal_name) AS name FROM suppliers WHERE id=$1`, [supplierId]);
    await createRequest(tx, req.actor, {
      kind: 'SUPPLIER_INVOICE',
      amount: Number(inv.total),
      payeeName: me[0]?.name ?? 'Supplier',
      branchId: inv.branch_id,
      supplierId,
      dueDate: inv.due_date ?? undefined,
      note: `Invoice ${inv.invoice_no} — filed by the supplier`,
      sourceType: 'supplier_invoice',
      sourceId: inv.id,
      systemRaised: true,
    });


    return {
      id: inv.id, invoiceNo: inv.invoice_no, total, subtotal,
      status: inv.status,
      message: 'Filed. It will be checked against the order and the receipt, and you will see the result here.',
    };
  });
}));
