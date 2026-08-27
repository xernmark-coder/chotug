import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';
import {
  emit, getSetting, nextDocNo, pushTask, raiseAlert, requestApprovals, resolveTask,
} from '../platform/services.js';
import {
  money, netWeight, qty as Q, round, sampleSize, scoreQc, weightVariance,
  type QcParam,
} from '../domain/index.js';
import { qcPhotoAssist } from '../ai/features.js';
import { checkInvoiceAgainstReceipts } from './costing.js';

export const receivingRouter = Router();
receivingRouter.use(authenticate);
// Outside supplier logins never reach staff data — see staffOnly().
receivingRouter.use(staffOnly);

/* ===========================================================================
 * §10 — GATE ENTRY. The truck is at the gate. This is the first record and
 * the one the whole chain hangs off: grns.gate_entry_id is NOT NULL, so no
 * stock can enter the business without one.
 * ======================================================================== */
receivingRouter.post('/gate-entries', requires('receiving.gate.create'), h(async (req) => {
  const input = body(z.object({
    branchId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    poId: z.string().uuid().nullable().optional(),
    expectedArrivalId: z.string().uuid().nullable().optional(),
    supplierId: z.string().uuid(),
    sourceType: z.enum(['FARMER', 'MANDI', 'AADHTI', 'WHOLESALER']),
    vehicleRegCaptured: z.string().min(4, 'Enter the vehicle number'),
    vehicleId: z.string().uuid().nullable().optional(),
    driverId: z.string().uuid().nullable().optional(),
    driverName: z.string().optional(),
    driverPhone: z.string().optional(),
    transporter: z.string().optional(),
    sealNo: z.string().optional(),
    sealIntact: z.boolean().nullable().optional(),
    ewayBillNo: z.string().optional(),
    supplierInvoiceRef: z.string().optional(),
    lrNo: z.string().optional(),
    mandiPattiNo: z.string().optional(),
    checklistResult: z.record(z.any()).optional(),
    exceptionReason: z.string().optional(),
    remarks: z.string().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const isUnplanned = !input.poId;

    // §10 / §28 — an arrival without a PO is the ONLY documented way to enter
    // the chain off-plan, and the schema's ck_gate_exception constraint will
    // not accept one without both a reason and an approver.
    if (isUnplanned) {
      if (!input.exceptionReason) {
        throw ApiError.rule(
          'This vehicle has no purchase order. Record why it is being allowed in before continuing.');
      }
      if (!req.actor.permissions.has('receiving.exception.approve')
          && !req.actor.permissions.has('admin.override')) {
        throw ApiError.forbidden(
          'An arrival without a purchase order needs a supervisor to approve the exception. ' +
          'Call your manager to the gate — the vehicle details you entered are saved.');
      }
    }

    // Vehicle compliance is checked at every gate entry (§12.2). We warn
    // rather than block — a rotting load at the gate is the bigger loss —
    // but the warning is stored on the record and raises an alert.
    const warnings: string[] = [];
    if (input.vehicleId) {
      const { rows: v } = await tx.query(
        `SELECT reg_no, status, fitness_expiry, insurance_expiry, puc_expiry
           FROM vehicles WHERE id=$1 AND company_id=$2`, [input.vehicleId, req.actor.companyId]);
      const veh = v[0];
      if (veh) {
        if (veh.status === 'BLOCKED') throw ApiError.rule(`Vehicle ${veh.reg_no} is blocked from entry.`);
        // `date` columns come back as 'YYYY-MM-DD' text (see db.ts), which
        // compares correctly as a string against today's calendar day.
        const today = new Date().toISOString().slice(0, 10);
        if (veh.fitness_expiry && veh.fitness_expiry < today) warnings.push('Fitness certificate expired');
        if (veh.insurance_expiry && veh.insurance_expiry < today) warnings.push('Insurance expired');
        if (veh.puc_expiry && veh.puc_expiry < today) warnings.push('PUC expired');
      }
    }

    let criticalFail = false;
    let checklistScore: number | null = null;
    if (input.checklistResult) {
      const vals = Object.values(input.checklistResult);
      const failed = vals.filter((v) => v === false || v === 'FAIL').length;
      checklistScore = vals.length ? round(((vals.length - failed) / vals.length) * 100, 2) : null;
      criticalFail = input.checklistResult.hygiene_ok === false ||
        input.checklistResult.no_contamination === false;
    }

    const gateNo = await nextDocNo(tx, req.actor, input.branchId, 'GATE');
    const { rows } = await tx.query(
      `INSERT INTO gate_entries
         (company_id, branch_id, warehouse_id, gate_no, po_id, expected_arrival_id, supplier_id,
          source_type, vehicle_id, vehicle_reg_captured, driver_id, driver_name, driver_phone,
          transporter, seal_no, seal_intact, eway_bill_no, supplier_invoice_ref, lr_no,
          mandi_patti_no, checklist_result, checklist_score, critical_fail,
          is_unplanned, exception_reason, exception_approved_by, exception_approved_at,
          arrived_at, status, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25, CASE WHEN $24 THEN $27::uuid ELSE NULL END,
               CASE WHEN $24 THEN now() ELSE NULL END,
               now(), 'ARRIVED', $26, $27, $27)
       RETURNING *`,
      [req.actor.companyId, input.branchId, input.warehouseId, gateNo, input.poId ?? null,
       input.expectedArrivalId ?? null, input.supplierId, input.sourceType,
       input.vehicleId ?? null, input.vehicleRegCaptured.toUpperCase().replace(/\s/g, ''),
       input.driverId ?? null, input.driverName ?? null, input.driverPhone ?? null,
       input.transporter ?? null, input.sealNo ?? null, input.sealIntact ?? null,
       input.ewayBillNo ?? null, input.supplierInvoiceRef ?? null, input.lrNo ?? null,
       input.mandiPattiNo ?? null,
       input.checklistResult ? JSON.stringify(input.checklistResult) : null,
       checklistScore, criticalFail, isUnplanned, input.exceptionReason ?? null,
       input.remarks ?? null, req.actor.userId]);

    const gate = rows[0];

    if (warnings.length) {
      await raiseAlert(tx, req.actor, {
        branchId: input.branchId, alertType: 'VEHICLE_COMPLIANCE', severity: 'MEDIUM',
        entityType: 'gate_entry', entityId: gate.id,
        title: `Vehicle ${input.vehicleRegCaptured} has compliance issues`,
        message: warnings.join('; '), meta: { warnings },
      });
    }
    if (criticalFail) {
      await raiseAlert(tx, req.actor, {
        branchId: input.branchId, alertType: 'HYGIENE_FAIL', severity: 'CRITICAL',
        entityType: 'gate_entry', entityId: gate.id,
        title: `Hygiene check failed at gate ${gateNo}`,
        message: 'The vehicle failed a critical hygiene item. QC head must clear it before unloading.',
      });
    }

    return { ...gate, warnings };
  });
}));

/**
 * §10 — Submitting LOCKS the record by stamping locked_at. From then on the
 * schema's trg_gate_lock_guard rejects every UPDATE except the few lifecycle
 * columns (status, timings), so a gate entry cannot be quietly rewritten
 * after the weight turns out inconvenient.
 */
receivingRouter.post('/gate-entries/:id/submit', requires('receiving.gate.submit'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM gate_entries WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const g = rows[0];
    if (!g) throw ApiError.notFound('Gate entry not found');
    if (g.locked_at) throw ApiError.conflict('This gate entry is already submitted and locked.');

    await tx.query(
      `UPDATE gate_entries SET locked_at=now(), docs_verified_at=now(),
              unloading_start_at=now(), updated_by=$2
        WHERE id=$1`, [g.id, req.actor.userId]);

    if (g.expected_arrival_id) {
      await tx.query(`UPDATE expected_arrivals SET status='ARRIVED' WHERE id=$1`, [g.expected_arrival_id]);
    }
    if (g.po_id) await resolveTask(tx, req.actor, 'EXPECTED_ARRIVAL', 'PO', g.po_id);

    await pushTask(tx, req.actor, {
      branchId: g.branch_id, warehouseId: g.warehouse_id,
      queueKey: 'WEIGH_PENDING', docType: 'GATE_ENTRY', docId: g.id, docNo: g.gate_no,
      title: `Weigh vehicle ${g.vehicle_reg_captured}`,
      subtitle: `Gate ${g.gate_no}`,
      severity: g.critical_fail ? 'critical' : 'normal',
      requiredPermission: 'receiving.weighment.create', slaMinutes: 45,
    });
    await emit(tx, req.actor, 'gate_entry', g.id, 'gate.submitted',
      { gateNo: g.gate_no, vehicle: g.vehicle_reg_captured });
    return { ok: true, status: 'ARRIVED', locked: true };
  })));

/* ---------------------------------------------------------------------------
 * "Type the invoice number." — the gate's whole job at the barrier.
 *
 * The clerk stands in the rain copying a lorry number, a driver's name and a
 * phone number off a piece of paper while the driver waits. Every one of those
 * facts was recorded by the supplier days ago, when they accepted the order.
 *
 * So the gate types one number and gets the rest. Nothing here is authoritative
 * — it is a first draft of the entry, and the clerk corrects whatever the
 * paperwork actually says. What matters is that the common case, where the
 * supplier told the truth, takes one field instead of eight.
 * ------------------------------------------------------------------------ */
receivingRouter.get('/lookup/invoice', requires('receiving.gate.create'), h(async (req) => {
  const no = String(req.query.no ?? '').trim();
  if (no.length < 2) throw ApiError.badRequest('Enter the invoice number from the driver\'s papers');

  const [hit] = await query(req.actor,
    `SELECT e.id                AS expected_arrival_id,
            e.expected_date, e.status AS arrival_status,
            e.vehicle_hint      AS vehicle_reg,
            e.driver_name, e.driver_phone, e.transporter, e.lr_no, e.eway_bill_no,
            e.supplier_marked_sent_at, e.supplier_note,
            o.id                AS po_id, o.po_no, o.source_type, o.grand_total,
            o.supplier_response, o.warehouse_id, o.branch_id,
            s.id                AS supplier_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name, s.phone AS supplier_phone,
            w.name              AS warehouse_name,
            i.invoice_no, i.invoice_date, i.total AS invoice_total,
            e.mandi_patti_no,
            i.filed_by_supplier,
            (SELECT count(*) FROM po_lines pl WHERE pl.po_id = o.id)   AS line_count,
            /* The clerk should know, before the lorry is inside, whether this
             * load has been paid for. */
            pay.request_no AS payment_request_no, pay.status AS payment_status,
            /* And whether it is already through the gate, so the same invoice
             * cannot walk in twice. */
            (SELECT g.id FROM gate_entries g
              WHERE g.po_id = o.id AND g.status NOT IN ('CANCELLED','REJECTED')
              ORDER BY g.arrived_at DESC LIMIT 1)                      AS existing_entry_id
       FROM supplier_invoices i
       JOIN purchase_orders o ON o.id = i.po_id
       JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN expected_arrivals e ON e.po_id = o.id AND e.status <> 'CANCELLED'
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       LEFT JOIN LATERAL (
         SELECT x.request_no, x.status FROM payment_requests x
          WHERE x.company_id = o.company_id AND x.status <> 'CANCELLED'
            AND ((x.source_type = 'supplier_invoice' AND x.source_id = i.id)
              OR (x.source_type = 'purchase_order'   AND x.source_id = o.id))
          ORDER BY x.requested_at LIMIT 1) pay ON true
      WHERE i.company_id = $1 AND lower(i.invoice_no) = lower($2)
        AND i.status <> 'CANCELLED'
      ORDER BY i.created_at DESC LIMIT 1`,
    [req.actor.companyId, no]);

  if (!hit) {
    /* A number the system has never seen is not necessarily a mistake — plenty
     * of loads arrive against no invoice at all — so this is an answer, not an
     * error. The gate falls back to typing the details. */
    return { found: false, invoiceNo: no,
      message: 'No invoice with that number. Enter the vehicle details by hand.' };
  }

  return { found: true, ...hit };
}));

/* ===========================================================================
 * EVERY BOX, AS IT COMES OFF THE LORRY
 *
 * The weighbridge weighs the vehicle. One number, for a load carrying mango,
 * tomato and onion together — it can never tell you how much mango arrived. The
 * floor already weighs each box on a platform scale; the number was going onto
 * paper and then into somebody's head.
 *
 * One row per box, and the per-product total is a SUM rather than a figure
 * somebody types at the end of the day.
 * ======================================================================== */

/** What has come off this vehicle so far, against what the order said. */
async function unloadState(actor: any, gateEntryId: string) {
  const [entry] = await query(actor,
    `SELECT g.id, g.gate_no, g.status, g.po_id, g.branch_id, g.warehouse_id,
            g.supplier_id, o.po_no
       FROM gate_entries g
       LEFT JOIN purchase_orders o ON o.id = g.po_id
      WHERE g.id = $1 AND g.company_id = $2`,
    [gateEntryId, actor.companyId]);
  if (!entry) throw ApiError.notFound('That vehicle is not at our gate.');

  /* Ordered and unloaded side by side. A product on the lorry that was never
   * ordered still has to appear — that is exactly the case worth seeing. */
  const lines = await query(actor,
    `WITH ordered AS (
        SELECT pl.id AS po_line_id, pl.product_id, pl.qty, pl.uom,
               pl.expected_weight_kg, pl.rate
          FROM po_lines pl WHERE pl.po_id = $3
     ), unloaded AS (
        SELECT * FROM v_unload_totals
         WHERE gate_entry_id = $1 AND company_id = $2
     ), ids AS (
        SELECT product_id FROM ordered
        UNION
        SELECT product_id FROM unloaded
     )
     SELECT i.product_id,
            p.name AS product_name, p.sku, p.icon, p.base_uom,
            o.po_line_id, o.qty AS ordered_qty, o.uom AS ordered_uom,
            o.expected_weight_kg, o.rate,
            COALESCE(u.boxes, 0)  AS boxes,
            COALESCE(u.net_kg, 0) AS net_kg,
            u.avg_box_kg, u.min_box_kg, u.max_box_kg
       FROM ids i
       LEFT JOIN ordered   o ON o.product_id = i.product_id
       LEFT JOIN unloaded  u ON u.product_id = i.product_id
       LEFT JOIN products  p ON p.id = i.product_id
      ORDER BY p.name`,
    [gateEntryId, actor.companyId, entry.po_id]);

  const boxes = await query(actor,
    `SELECT b.id, b.box_no, b.weight_kg, b.product_id, b.scanned_code,
            b.capture_mode, b.weighed_at, b.voided_at, b.void_reason,
            p.name AS product_name, u.full_name AS weighed_by_name
       FROM unload_boxes b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN users u ON u.id = b.weighed_by
      WHERE b.gate_entry_id = $1
      ORDER BY b.box_no DESC LIMIT 200`,
    [gateEntryId]);

  const totalKg = lines.reduce((a: number, l: any) => a + Number(l.net_kg), 0);
  const totalBoxes = lines.reduce((a: number, l: any) => a + Number(l.boxes), 0);
  return { entry, lines, boxes, totalKg, totalBoxes };
}

receivingRouter.get('/gate-entries/:id/boxes', h(async (req) =>
  unloadState(req.actor, req.params.id)));

receivingRouter.post('/gate-entries/:id/boxes',
  requires('receiving.box.weigh'), h(async (req) => {
    const input = body(z.object({
      productId: z.string().uuid().optional(),
      /* Or the code printed on the box. The floor scans that, not our UUID. */
      scannedCode: z.string().trim().max(60).optional(),
      weightKg: z.coerce.number().positive('What did the box weigh?'),
      /* Ten identical boxes off a lorry are ten identical taps otherwise. The
       * weight is still per box — this repeats it, it does not divide it. */
      count: z.coerce.number().int().min(1).max(200,
        'Record these in smaller runs so a mistake is easy to undo').default(1),
      captureMode: z.enum(['MANUAL', 'DEVICE', 'SCAN']).default('MANUAL'),
      scaleDeviceId: z.string().uuid().nullable().optional(),
    }), req.body);

    if (!input.productId && !input.scannedCode) {
      throw ApiError.badRequest('Which product is in this box?');
    }

    return withTx(req.actor, async (tx) => {
      const { rows: eRows } = await tx.query(
        `SELECT g.id, g.gate_no, g.status, g.po_id, g.branch_id, g.warehouse_id
           FROM gate_entries g
          WHERE g.id = $1 AND g.company_id = $2 FOR UPDATE`,
        [req.params.id, req.actor.companyId]);
      const entry = eRows[0];
      if (!entry) throw ApiError.notFound('That vehicle is not at our gate.');
      if (['CANCELLED', 'REJECTED', 'CLOSED'].includes(entry.status)) {
        throw ApiError.rule(
          `${entry.gate_no} is ${entry.status.toLowerCase()} — nothing more can be unloaded against it.`);
      }

      /* Resolve the supplier's own code for the product, which is what is
       * printed on the box, before falling back to ours. */
      let productId = input.productId ?? null;
      if (!productId && input.scannedCode) {
        const { rows: sp } = await tx.query(
          `SELECT product_id FROM supplier_products
            WHERE company_id = $1
              AND (lower(supplier_code) = lower($2) OR lower(tracking_code) = lower($2))
            LIMIT 1`,
          [req.actor.companyId, input.scannedCode]);
        productId = sp[0]?.product_id ?? null;
        if (!productId) {
          const { rows: bySku } = await tx.query(
            `SELECT id FROM products WHERE company_id=$1 AND lower(sku)=lower($2) LIMIT 1`,
            [req.actor.companyId, input.scannedCode]);
          productId = bySku[0]?.id ?? null;
        }
        if (!productId) {
          throw ApiError.rule(
            `Nothing on file for code "${input.scannedCode}". Pick the product from the list instead.`);
        }
      }

      const { rows: pl } = await tx.query(
        `SELECT id FROM po_lines WHERE po_id = $1 AND product_id = $2 LIMIT 1`,
        [entry.po_id, productId]);
      if (entry.po_id && !pl[0]) {
        throw ApiError.rule(
          'This product is not on the purchase order for this vehicle. Select the same product that arrived.');
      }

      /* Numbered per vehicle so the floor can shout "box 41". Taken under the
       * row lock above, so two tablets weighing at once cannot claim the same
       * number. */
      const { rows: nextNo } = await tx.query(
        `SELECT COALESCE(MAX(box_no), 0) + 1 AS n FROM unload_boxes WHERE gate_entry_id = $1`,
        [entry.id]);

      /* One row per box even when they were entered as a run: each is a
       * separate physical box that can be voided on its own, and "10 boxes"
       * stored as one row of 200 kg cannot be corrected when one of them turns
       * out to be short. generate_series keeps the numbering contiguous under
       * the row lock taken above. */
      const { rows: ins } = await tx.query(
        `INSERT INTO unload_boxes (company_id, branch_id, warehouse_id, gate_entry_id,
                po_line_id, product_id, box_no, weight_kg, capture_mode,
                scale_device_id, scanned_code, weighed_by)
         SELECT $1,$2,$3,$4,$5,$6,$7 + g - 1,$8,$9,$10,$11,$12
           FROM generate_series(1, $13::int) AS g
         RETURNING *`,
        [req.actor.companyId, entry.branch_id, entry.warehouse_id, entry.id,
         pl[0]?.id ?? null, productId, nextNo[0].n, input.weightKg, input.captureMode,
         input.scaleDeviceId ?? null, input.scannedCode ?? null, req.actor.userId,
         input.count]);

      const { rows: tot } = await tx.query(
        `SELECT boxes, net_kg FROM v_unload_totals
          WHERE gate_entry_id = $1 AND product_id = $2`, [entry.id, productId]);
      const { rows: prod } = await tx.query(
        `SELECT name FROM products WHERE id = $1`, [productId]);

      const first = nextNo[0].n;
      const last = first + input.count - 1;
      return {
        ...ins[0],
        boxes: ins,
        productName: prod[0]?.name,
        productBoxes: tot[0]?.boxes ?? input.count,
        productNetKg: tot[0]?.net_kg ?? input.weightKg * input.count,
        message: (input.count === 1
          ? `Box ${first} · ${input.weightKg} kg · ${prod[0]?.name}`
          : `Boxes ${first}–${last} · ${input.count} × ${input.weightKg} kg · ${prod[0]?.name}`)
          + ` (${tot[0]?.boxes ?? input.count} boxes, `
          + `${Number(tot[0]?.net_kg ?? input.weightKg * input.count).toFixed(1)} kg so far)`,
      };
    });
  }));

/* A box is corrected by voiding it, never by editing the weight. A number that
 * can be changed after the fact is a number nobody can be held to. */
receivingRouter.post('/boxes/:id/void', requires('receiving.box.void'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().trim().min(3, 'Why is this box being voided?'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE unload_boxes
          SET voided_at = now(), voided_by = $2, void_reason = $3
        WHERE id = $1 AND company_id = $4 AND voided_at IS NULL
        RETURNING box_no, weight_kg, gate_entry_id, product_id`,
      [req.params.id, req.actor.userId, input.reason, req.actor.companyId]);
    if (!rows[0]) throw ApiError.rule('That box has already been voided.');

    await emit(tx, req.actor, 'unload_box', req.params.id, 'box.voided', {
      boxNo: rows[0].box_no, weightKg: rows[0].weight_kg, reason: input.reason,
    });
    return { ok: true, boxNo: rows[0].box_no,
      message: `Box ${rows[0].box_no} voided. It no longer counts towards the total.` };
  });
}));

receivingRouter.get('/pipeline', h(async (req) =>
  query(req.actor,
    `SELECT * FROM v_receiving_pipeline
      WHERE company_id = $1 AND ($2::uuid IS NULL OR warehouse_id = $2)
      ORDER BY critical_fail DESC, age_minutes DESC`,
    [req.actor.companyId, req.query.warehouseId ?? null])));

receivingRouter.get('/gate-entries/:id', h(async (req) => {
  const [g] = await query(req.actor,
    `SELECT g.*, s.trade_name AS supplier_name, s.legal_name AS supplier_legal_name,
            o.po_no, o.id AS po_id, w.name AS warehouse_name,
            u.full_name AS created_by_name
       FROM gate_entries g
       JOIN suppliers s ON s.id = g.supplier_id
       JOIN warehouses w ON w.id = g.warehouse_id
       LEFT JOIN purchase_orders o ON o.id = g.po_id
       LEFT JOIN users u ON u.id = g.created_by
      WHERE g.id = $1 AND g.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!g) throw ApiError.notFound('Gate entry not found');

  const [weighments, inspections, poLines, grns, boxTotals] = await Promise.all([
    query(req.actor,
      `SELECT w.*, u.full_name AS weighed_by_name, ct.name AS container_type_name
         FROM weighments w LEFT JOIN users u ON u.id = w.weighed_by
         LEFT JOIN container_types ct ON ct.id = w.container_type_id
        WHERE w.gate_entry_id=$1 ORDER BY w.seq`, [g.id]),
    query(req.actor,
      `SELECT q.*, p.name AS product_name, p.sku, u.full_name AS inspector_name
         FROM qc_inspections q JOIN products p ON p.id = q.product_id
         LEFT JOIN users u ON u.id = q.inspector_id
        WHERE q.gate_entry_id=$1 ORDER BY q.inspected_at`, [g.id]),
    g.po_id ? query(req.actor,
      `SELECT l.*, p.name AS product_name, p.sku, p.qc_template_id, p.is_variable_weight,
              p.default_wastage_pct, p.shelf_life_days
         FROM po_lines l JOIN products p ON p.id = l.product_id
        WHERE l.po_id=$1 ORDER BY l.line_no`, [g.po_id]) : Promise.resolve([]),
    query(req.actor, `SELECT id, grn_no, status, posted_at FROM grns WHERE gate_entry_id=$1`, [g.id]),
    /* What was actually weighed off the lorry, box by box. The receipt should
     * be booked against this rather than against a quantity somebody types, or
     * the boxes were weighed for nothing. */
    query(req.actor,
      `SELECT t.product_id, t.po_line_id, t.boxes, t.net_kg, t.avg_box_kg
         FROM v_unload_totals t WHERE t.gate_entry_id = $1`, [g.id]),
  ]);

  return { ...g, weighments, inspections, poLines, grns, boxTotals };
}));

/* ===========================================================================
 * §11 — WEIGHMENT. Append-only: a re-weigh is a NEW row with a reason, never
 * an edit. Net weight subtracts container and packing tare, which is exactly
 * where inflated weights hide.
 * ======================================================================== */
receivingRouter.post('/gate-entries/:id/weighments', requires('receiving.weighment.create'), h(async (req) => {
  const input = body(z.object({
    kind: z.enum(['GROSS', 'TARE', 'REWEIGH', 'SAMPLE']),
    method: z.enum(['TWO_WEIGHMENT', 'ONE_WEIGHMENT', 'CRATE_COUNT']).default('TWO_WEIGHMENT'),
    grossKg: z.number().nonnegative().nullable().optional(),
    tareKg: z.number().nonnegative().nullable().optional(),
    containerTypeId: z.string().uuid().nullable().optional(),
    containerCount: z.number().int().nonnegative().nullable().optional(),
    packingTareKg: z.number().nonnegative().nullable().optional(),
    captureMode: z.enum(['SCALE', 'MANUAL']).default('MANUAL'),
    scaleDeviceId: z.string().uuid().nullable().optional(),
    rawReading: z.string().nullable().optional(),
    reweighReason: z.string().nullable().optional(),
    varianceReasonCode: z.string().nullable().optional(),
    remarks: z.string().optional(),
  }), req.body);

  if (input.kind === 'REWEIGH' && !input.reweighReason) {
    throw ApiError.rule('A re-weighment needs a reason. The earlier reading stays on record.');
  }

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM gate_entries WHERE id=$1 AND company_id=$2`, [req.params.id, req.actor.companyId]);
    const g = rows[0];
    if (!g) throw ApiError.notFound('Gate entry not found');
    if (!g.locked_at) throw ApiError.rule('Submit and lock the gate entry before weighing.');
    if (['COMPLETED', 'REJECTED_AT_GATE', 'CANCELLED'].includes(g.status)) {
      throw ApiError.rule(`This vehicle is already at "${g.status}".`);
    }

    const { rows: seqRow } = await tx.query(
      `SELECT COALESCE(MAX(seq),0)+1 AS s FROM weighments WHERE gate_entry_id=$1`, [g.id]);
    const seq = seqRow[0].s;

    let containerTare: number | null = null;
    if (input.containerTypeId && input.containerCount) {
      const { rows: ct } = await tx.query(`SELECT tare_kg FROM container_types WHERE id=$1`, [input.containerTypeId]);
      containerTare = Number(ct[0]?.tare_kg ?? 0);
    }

    // Combine with the paired reading so a TARE completes the GROSS cycle.
    const { rows: prior } = await tx.query(
      `SELECT kind, gross_kg, tare_kg FROM weighments
        WHERE gate_entry_id=$1 AND kind IN ('GROSS','TARE') ORDER BY seq`, [g.id]);
    const priorGross = prior.find((p: any) => p.kind === 'GROSS')?.gross_kg ?? null;
    const priorTare = prior.find((p: any) => p.kind === 'TARE')?.tare_kg ?? null;

    const effGross = input.grossKg ?? (input.kind === 'TARE' ? Number(priorGross ?? 0) : 0);
    const effTare = input.tareKg ?? (input.kind === 'GROSS' ? Number(priorTare ?? 0) : 0);

    /* A two-weighment cycle is not a measurement until BOTH readings exist.
     * Treating a lone GROSS as one recorded net_kg = the entire loaded lorry:
     * it made every first weighment look like a +472% CRITICAL variance, and
     * the QC sampling plan — which reads net_kg — sized its sample against the
     * truck rather than the produce. Leave net NULL until the cycle closes. */
    const cycleComplete = input.method !== 'TWO_WEIGHMENT'
      || (effGross > 0 && effTare > 0);

    const net = cycleComplete
      ? netWeight({
        grossKg: effGross || null,
        tareKg: effTare || null,
        containerCount: input.containerCount ?? null,
        containerTareKg: containerTare,
        packingTareKg: input.packingTareKg ?? null,
      })
      : null;

    // Expected weight from the PO (§11) — variance is against a commitment.
    let expectedKg: number | null = null;
    if (g.po_id) {
      const { rows: exp } = await tx.query(
        `SELECT COALESCE(SUM(COALESCE(expected_weight_kg, qty_in_base)),0) e
           FROM po_lines WHERE po_id=$1`, [g.po_id]);
      expectedKg = Number(exp[0].e) || null;
    }

    const tolerancePct = Number(await getSetting(tx, req.actor, 'purchase.weight_tolerance_pct', 2));
    // No net yet means nothing to compare: an incomplete cycle has no variance.
    const v = net === null
      ? { varianceKg: 0, variancePct: 0, band: 'GREEN' as const, breached: false }
      : weightVariance(expectedKg, net, tolerancePct);

    /* §11 — ck_weigh_variance_approval: a breached tolerance on anything other
     * than the first gross reading cannot be stored unapproved. If the person
     * weighing does not hold the approval permission, we stop here with an
     * instruction rather than writing a row the database will reject. */
    const needsApprover = v.breached && input.kind !== 'GROSS';
    const canApprove = req.actor.permissions.has('receiving.weighment.approve')
      || req.actor.permissions.has('admin.override');
    if (needsApprover && !canApprove) {
      throw ApiError.forbidden(
        `Net weight ${net} kg is ${v.variancePct}% away from the expected ${expectedKg} kg, ` +
        'which is beyond tolerance. A supervisor must approve this weight before it can be saved.',
        { expectedKg, netKg: net, variancePct: v.variancePct, band: v.band });
    }

    const weighmentNo = await nextDocNo(tx, req.actor, g.branch_id, 'WGT');
    const { rows: ins } = await tx.query(
      `INSERT INTO weighments
         (company_id, branch_id, warehouse_id, gate_entry_id, weighment_no, seq, kind, method,
          gross_kg, tare_kg, container_type_id, container_count, container_tare_kg, packing_tare_kg,
          net_kg, capture_mode, scale_device_id, raw_reading, expected_kg, variance_kg, variance_pct,
          tolerance_pct, tolerance_breached, variance_band, variance_reason_code, reweigh_reason,
          approved_by, approved_at, approval_reason, weighed_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25,$26,
               CASE WHEN $27 THEN $29::uuid ELSE NULL END,
               CASE WHEN $27 THEN now() ELSE NULL END,
               CASE WHEN $27 THEN $28 ELSE NULL END,
               $29,$29)
       RETURNING *`,
      [req.actor.companyId, g.branch_id, g.warehouse_id, g.id, weighmentNo, seq, input.kind, input.method,
       input.grossKg ?? null, input.tareKg ?? null, input.containerTypeId ?? null,
       input.containerCount ?? null, containerTare, input.packingTareKg ?? null,
       net !== null && net > 0 ? net : null, input.captureMode, input.scaleDeviceId ?? null,
       // ck_weigh_manual_reason: a typed weight must not claim a device reading
       input.captureMode === 'MANUAL' ? null : (input.rawReading ?? null),
       expectedKg, v.varianceKg, v.variancePct, tolerancePct,
       v.breached, v.band, input.varianceReasonCode ?? null, input.reweighReason ?? null,
       needsApprover,
       input.varianceReasonCode ?? input.remarks ?? 'Approved at capture by an authorised user',
       req.actor.userId]);

    const w = ins[0];

    // Tolerance breach: alert, and beyond 2× tolerance require an approval
    // before QC can start (§11 "tolerance se adhik variance par approval").
    if (v.breached) {
      await raiseAlert(tx, req.actor, {
        branchId: g.branch_id, alertType: 'WEIGHT_VARIANCE',
        severity: v.band === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        entityType: 'gate_entry', entityId: g.id,
        title: `Weight variance ${v.variancePct}% on ${g.gate_no}`,
        message: `Expected ${expectedKg} kg, weighed ${net ?? 0} kg (${v.band}).`,
        meta: { expectedKg, net, band: v.band },
      });
      if (v.band === 'RED' || v.band === 'CRITICAL') {
        await requestApprovals(tx, req.actor,
          { docType: 'WEIGHT_VARIANCE', docId: w.id, docNo: weighmentNo, branchId: g.branch_id },
          { weightVariancePct: Math.abs(v.variancePct) });
      }
    }

    // Once both halves of the cycle exist, move the vehicle on to QC.
    const hasGross = input.kind === 'GROSS' || priorGross != null;
    const hasTare = input.kind === 'TARE' || priorTare != null;
    const cycleDone = input.method !== 'TWO_WEIGHMENT' ? true : (hasGross && hasTare);

    if (cycleDone && ['ARRIVED', 'WEIGHED'].includes(g.status)) {
      await tx.query(
        `UPDATE gate_entries SET status='QC_PENDING', updated_by=$2 WHERE id=$1`,
        [g.id, req.actor.userId]);
      await resolveTask(tx, req.actor, 'WEIGH_PENDING', 'GATE_ENTRY', g.id);
      await pushTask(tx, req.actor, {
        branchId: g.branch_id, warehouseId: g.warehouse_id,
        queueKey: 'QC_PENDING', docType: 'GATE_ENTRY', docId: g.id, docNo: g.gate_no,
        title: `Quality check ${g.gate_no}`,
        subtitle: `${net ?? 0} kg net from ${g.vehicle_reg_captured}`,
        severity: v.breached ? 'warn' : 'normal',
        requiredPermission: 'quality.inspection.create', slaMinutes: 60,
      });
    }

    await emit(tx, req.actor, 'weighment', w.id, 'weighment.captured',
      { gateNo: g.gate_no, netKg: net, variancePct: v.variancePct });

    return { ...w, cycleComplete: cycleDone, nextStep: cycleDone ? 'QC' : 'AWAIT_SECOND_WEIGHMENT' };
  });
}));

/* ===========================================================================
 * §12 / §13 — QUALITY CHECK. Template driven, weighted score, critical
 * parameters force a hold. AI may pre-fill; the inspector always confirms.
 * ======================================================================== */
receivingRouter.get('/gate-entries/:id/qc-plan/:productId', h(async (req) => {
  const [row] = await query(req.actor,
    `SELECT p.id, p.name, p.sku, p.qc_template_id, p.grades_allowed,
            t.id AS template_id, t.code AS template_code, t.name AS template_name,
            t.version AS template_version, t.sampling_rule, t.scoring_rule
       FROM products p
       LEFT JOIN qc_templates t ON t.id = p.qc_template_id
      WHERE p.id = $1 AND p.company_id = $2`, [req.params.productId, req.actor.companyId]);
  if (!row) throw ApiError.notFound('Product not found');
  if (!row.template_id) throw ApiError.rule('No QC template is configured for this product.');

  const parameters = await query(req.actor,
    `SELECT id, code, label, label_hi, param_type, unit, min_ok, max_ok, options,
            is_critical, is_mandatory, weight, requires_photo, ai_assisted, help_text
       FROM qc_parameters WHERE template_id = $1 ORDER BY seq`, [row.template_id]);

  /* The LATEST completed net, not a SUM. Weighments are append-only, so a
   * re-weigh adds a row rather than replacing one — summing them counts the
   * same lorry twice and sizes the QC sample against a lot that never
   * existed. The most recent closed cycle is the lot in front of the
   * inspector. */
  const [lot] = await query(req.actor,
    `SELECT COALESCE(w.net_kg, 0) AS net_kg
       FROM weighments w
      WHERE w.gate_entry_id = $1 AND w.net_kg IS NOT NULL
      ORDER BY w.seq DESC LIMIT 1`, [req.params.id]);

  const [supRisk] = await query(req.actor,
    `SELECT COALESCE(sc.rejection_pct,0) AS rejection_pct,
            (SELECT count(*) FROM purchase_orders o WHERE o.supplier_id = g.supplier_id) AS order_count
       FROM gate_entries g
       LEFT JOIN LATERAL (SELECT * FROM supplier_scores x WHERE x.supplier_id = g.supplier_id
                           AND x.product_id IS NULL ORDER BY period_end DESC LIMIT 1) sc ON true
      WHERE g.id = $1`, [req.params.id]);

  const lotQty = Number(lot?.net_kg ?? 0);
  const sample = sampleSize(lotQty, row.sampling_rule, {
    newSupplier: Number(supRisk?.order_count ?? 0) <= 1,
    highRejection: Number(supRisk?.rejection_pct ?? 0) > 8,
  });

  return {
    product: { id: row.id, name: row.name, sku: row.sku, gradesAllowed: row.grades_allowed },
    template: { id: row.template_id, code: row.template_code, name: row.template_name,
      version: row.template_version, scoringRule: row.scoring_rule, samplingRule: row.sampling_rule },
    parameters, lotQty, sampleSize: sample,
    samplingNote: `Inspect ${sample} unit(s) from a lot of ${lotQty}` +
      (Number(supRisk?.order_count ?? 0) <= 1 ? ' — doubled because this is a new supplier' : '') +
      (Number(supRisk?.rejection_pct ?? 0) > 8 ? ' — doubled due to a high recent rejection rate' : ''),
  };
}));

/** F5 — vision pre-fill. Advisory. Never writes an inspection. */
receivingRouter.post('/qc/photo-assist', requires('quality.inspection.create'), h(async (req) => {
  const input = body(z.object({
    branchId: z.string().uuid(),
    productId: z.string().uuid(),
    templateId: z.string().uuid(),
    images: z.array(z.object({ mediaType: z.string(), base64: z.string() })).min(1).max(4),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: p } = await tx.query(`SELECT name FROM products WHERE id=$1`, [input.productId]);
    const { rows: params } = await tx.query(
      `SELECT code, label, param_type AS "paramType", unit, options
         FROM qc_parameters WHERE template_id=$1 AND ai_assisted ORDER BY seq`, [input.templateId]);
    if (params.length === 0) {
      return { suggestions: [], confidence: 0, usedFallback: true,
        message: 'No AI-assisted parameters on this template.' };
    }
    return qcPhotoAssist(tx, req.actor, {
      branchId: input.branchId, productName: p[0]?.name ?? 'produce',
      parameters: params as any, images: input.images,
    });
  });
}));

receivingRouter.post('/gate-entries/:id/inspections', requires('quality.inspection.create'), h(async (req) => {
  const input = body(z.object({
    productId: z.string().uuid(),
    poLineId: z.string().uuid().nullable().optional(),
    templateId: z.string().uuid(),
    receivedQty: z.number().positive('Received quantity is required'),
    lotSize: z.number().nonnegative().optional(),
    sampleSize: z.number().nonnegative().optional(),
    samplingNote: z.string().optional(),
    expectedGrade: z.string().nullable().optional(),
    answers: z.array(z.object({
      code: z.string(),
      valueNum: z.number().nullable().optional(),
      valueBool: z.boolean().nullable().optional(),
      valueText: z.string().nullable().optional(),
      reasonCode: z.string().nullable().optional(),
      aiPrefilled: z.boolean().default(false),
      aiValue: z.number().nullable().optional(),
      inspectorChanged: z.boolean().default(false),
    })).min(1, 'Fill the quality checklist'),
    /** Inspector's final call — may differ from the computed disposition. */
    acceptedQty: z.number().nonnegative(),
    rejectedQty: z.number().nonnegative().default(0),
    holdQty: z.number().nonnegative().default(0),
    assignedGrade: z.string().nullable().optional(),
    rejectionReasonCodes: z.array(z.string()).default([]),
    aiRunId: z.string().uuid().nullable().optional(),
    overrideReason: z.string().nullable().optional(),
    remarks: z.string().optional(),
    /* §17 — one verdict for forty crates is a fiction. Optional groups let the
     * inspector say "25 crates grade A at full price, 10 grade B at 80%, 5
     * rejected", and the totals above must be exactly what these add up to. */
    grades: z.array(z.object({
      label: z.string().trim().optional(),
      grade: z.string().trim().min(1, 'Every group needs a grade'),
      containerCount: z.coerce.number().int().nonnegative().nullable().optional(),
      qty: z.coerce.number().positive('How much is in this group?'),
      weightKg: z.coerce.number().nonnegative().nullable().optional(),
      disposition: z.enum(['ACCEPT', 'REJECT', 'HOLD']).default('ACCEPT'),
      reasonCode: z.string().trim().nullable().optional(),
      priceFactorPct: z.coerce.number().min(0).max(200).default(100),
      note: z.string().trim().optional(),
    })).optional(),
  }), req.body);

  const total = input.acceptedQty + input.rejectedQty + input.holdQty;
  if (total > input.receivedQty + 0.001) {
    throw ApiError.rule('Accepted + rejected + hold cannot be more than the received quantity.');
  }
  if (input.grades?.length) {
    const sumOf = (d: string) => input.grades!
      .filter((x) => x.disposition === d)
      .reduce((a, x) => a + Number(x.qty), 0);
    const checks: [string, number, number][] = [
      ['accepted', sumOf('ACCEPT'), input.acceptedQty],
      ['rejected', sumOf('REJECT'), input.rejectedQty],
      ['held',     sumOf('HOLD'),   input.holdQty],
    ];
    for (const [what, grouped, headline] of checks) {
      if (Math.abs(grouped - headline) > 0.001) {
        throw ApiError.rule(
          `The groups add up to ${round(grouped, 3)} ${what}, but the ${what} quantity says ${headline}. They have to agree.`,
          { field: what, grouped, headline });
      }
    }
    const noReason = input.grades.find(
      (x) => x.disposition === 'REJECT' && !x.reasonCode?.trim());
    if (noReason) {
      throw ApiError.rule(`Give a reason for rejecting the "${noReason.label ?? noReason.grade}" group.`);
    }
  }

  if (input.rejectedQty > 0 && input.rejectionReasonCodes.length === 0) {
    throw ApiError.rule('Choose at least one rejection reason for the rejected quantity.');
  }

  return withTx(req.actor, async (tx) => {
    const { rows: gr } = await tx.query(
      `SELECT * FROM gate_entries WHERE id=$1 AND company_id=$2`, [req.params.id, req.actor.companyId]);
    const g = gr[0];
    if (!g) throw ApiError.notFound('Gate entry not found');
    /* The weighbridge is optional.
     *
     * It used to gate this: a vehicle still at ARRIVED could not be inspected
     * until somebody had put it on the bridge. Plenty of yards have no bridge,
     * and plenty of loads are small enough that weighing every box IS the
     * weight — which is the number the receipt uses anyway. Skipping the bridge
     * loses the gross/tare variance check and nothing else. */
    if (!['ARRIVED', 'QC_PENDING', 'WEIGHED', 'QC_COMPLETE'].includes(g.status)) {
      throw ApiError.rule(
        `This vehicle is ${g.status.replace(/_/g, ' ').toLowerCase()} — it is past the quality check.`);
    }

    // §11 — a red/critical weight variance must be cleared before QC.
    const { rows: pendingW } = await tx.query(
      `SELECT count(*)::int c FROM approvals a
         JOIN weighments w ON w.id = a.doc_id
        WHERE w.gate_entry_id = $1 AND a.doc_type = 'WEIGHT_VARIANCE' AND a.status = 'PENDING'`,
      [g.id]);
    if (pendingW[0].c > 0 && !req.actor.permissions.has('admin.override')) {
      throw ApiError.rule('The weight variance on this vehicle is waiting for approval. Clear that first.');
    }

    const { rows: tpl } = await tx.query(
      `SELECT scoring_rule, version FROM qc_templates WHERE id=$1`, [input.templateId]);
    const { rows: paramRows } = await tx.query(
      `SELECT id, code, label, param_type, min_ok, max_ok, options, is_critical, weight
         FROM qc_parameters WHERE template_id=$1 ORDER BY seq`, [input.templateId]);

    const params: QcParam[] = paramRows.map((p: any) => ({
      code: p.code, label: p.label, paramType: p.param_type,
      minOk: p.min_ok, maxOk: p.max_ok, options: p.options,
      isCritical: p.is_critical, weight: Number(p.weight),
    }));

    const scored = scoreQc(params, input.answers, tpl[0].scoring_rule);

    // If the inspector's disposition contradicts a critical failure, the
    // system requires an explicit override reason (§13.4).
    const computedResult = scored.result;
    const inspectorResult: 'ACCEPT' | 'PARTIAL' | 'REJECT' | 'HOLD' =
      input.holdQty > 0 && input.acceptedQty === 0 ? 'HOLD'
      : input.acceptedQty === 0 ? 'REJECT'
      : input.rejectedQty > 0 || input.holdQty > 0 ? 'PARTIAL' : 'ACCEPT';

    const contradicts = scored.criticalFailures.length > 0 && inspectorResult === 'ACCEPT';
    if (contradicts && !input.overrideReason) {
      throw ApiError.rule(
        `A critical parameter failed (${scored.criticalFailures.join(', ')}). ` +
        'Accepting this lot needs a written reason and QC Head approval.');
    }

    const inspectionNo = await nextDocNo(tx, req.actor, g.branch_id, 'QC');
    const { rows: ins } = await tx.query(
      `INSERT INTO qc_inspections
         (company_id, branch_id, warehouse_id, inspection_no, gate_entry_id, po_line_id, product_id,
          template_id, template_version, inspector_id, lot_size, sample_size, sampling_note,
          overall_result, received_qty, accepted_qty, rejected_qty, hold_qty, expected_grade,
          assigned_grade, downgraded_from, quality_score, critical_failures, rejection_reason_codes,
          ai_run_id, ai_overridden, override_reason, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25,$26,$27,$28,$29,$29)
       RETURNING *`,
      [req.actor.companyId, g.branch_id, g.warehouse_id, inspectionNo, g.id,
       input.poLineId ?? null, input.productId, input.templateId, tpl[0].version, req.actor.userId,
       input.lotSize ?? input.receivedQty, input.sampleSize ?? null, input.samplingNote ?? null,
       inspectorResult, input.receivedQty, input.acceptedQty, input.rejectedQty, input.holdQty,
       input.expectedGrade ?? null, input.assignedGrade ?? scored.grade,
       input.expectedGrade && input.assignedGrade && input.expectedGrade !== input.assignedGrade
         ? input.expectedGrade : null,
       scored.qualityScore, scored.criticalFailures, input.rejectionReasonCodes,
       input.aiRunId ?? null, !!input.overrideReason, input.overrideReason ?? null,
       input.remarks ?? null, req.actor.userId]);

    const inspection = ins[0];

    /* The groups, if the inspector split the load. They are the working shown
     * behind the accepted/rejected/hold totals, so they are written with the
     * inspection and never separately. */
    for (const [i, gr] of (input.grades ?? []).entries()) {
      await tx.query(
        `INSERT INTO qc_lot_grades (company_id, inspection_id, group_no, label, grade,
                container_count, qty, uom, weight_kg, disposition, reason_code,
                price_factor_pct, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [req.actor.companyId, inspection.id, i + 1, gr.label ?? null, gr.grade,
         gr.containerCount ?? null, gr.qty, null, gr.weightKg ?? null,
         gr.disposition, gr.reasonCode ?? null, gr.priceFactorPct, gr.note ?? null,
         req.actor.userId]);
    }

    for (const a of input.answers) {
      const p = paramRows.find((x: any) => x.code === a.code);
      if (!p) continue;
      const detail = scored.perParam.find((x) => x.code === a.code);
      await tx.query(
        `INSERT INTO qc_results (company_id, inspection_id, parameter_id, value_num, value_bool,
                                 value_text, is_pass, is_critical_fail, reason_code,
                                 ai_prefilled, ai_value, inspector_changed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.actor.companyId, inspection.id, p.id, a.valueNum ?? null, a.valueBool ?? null,
         a.valueText ?? null, detail?.pass ?? true,
         !!(p.is_critical && detail && !detail.pass), a.reasonCode ?? null,
         a.aiPrefilled, a.aiValue ?? null, a.inspectorChanged]);
    }

    if (input.aiRunId) {
      const anyChanged = input.answers.some((a) => a.inspectorChanged);
      await tx.query(
        `UPDATE ai_runs SET accepted = $2, accepted_by = $3, accepted_at = now(),
                override_value = $4 WHERE id = $1`,
        [input.aiRunId, !anyChanged, req.actor.userId,
         JSON.stringify({ grade: input.assignedGrade, accepted: input.acceptedQty })]);
    }

    if (contradicts || (input.overrideReason && scored.criticalFailures.length)) {
      await requestApprovals(tx, req.actor,
        { docType: 'QC_OVERRIDE', docId: inspection.id, docNo: inspectionNo, branchId: g.branch_id },
        { value: 1 });
    }

    if (input.rejectedQty > 0) {
      const rejectPct = round((input.rejectedQty / input.receivedQty) * 100, 2);
      await raiseAlert(tx, req.actor, {
        branchId: g.branch_id, alertType: 'QC_REJECTION',
        severity: rejectPct > 20 ? 'CRITICAL' : 'HIGH',
        entityType: 'qc_inspection', entityId: inspection.id,
        title: `${rejectPct}% rejected on ${inspectionNo}`,
        message: `Reasons: ${input.rejectionReasonCodes.join(', ') || 'not specified'}.`,
        meta: { rejectPct, reasons: input.rejectionReasonCodes },
      });
    }

    // All PO lines inspected → the vehicle is ready for GRN.
    const readyForGrn = await isQcComplete(tx, g);
    if (readyForGrn) {
      await tx.query(
        `UPDATE gate_entries SET status='QC_COMPLETE', updated_by=$2 WHERE id=$1 AND status <> 'QC_COMPLETE'`,
        [g.id, req.actor.userId]);
      await resolveTask(tx, req.actor, 'QC_PENDING', 'GATE_ENTRY', g.id);
      await pushTask(tx, req.actor, {
        branchId: g.branch_id, warehouseId: g.warehouse_id,
        queueKey: 'GRN_PENDING', docType: 'GATE_ENTRY', docId: g.id, docNo: g.gate_no,
        title: `Post receipt for ${g.gate_no}`,
        subtitle: 'Quality check complete',
        requiredPermission: 'receiving.grn.submit', slaMinutes: 120,
      });
    }

    await emit(tx, req.actor, 'qc_inspection', inspection.id, 'qc.completed', {
      inspectionNo, result: inspectorResult, score: scored.qualityScore,
      accepted: input.acceptedQty, rejected: input.rejectedQty,
    });

    return {
      ...inspection,
      computed: { result: computedResult, score: scored.qualityScore, grade: scored.grade,
        criticalFailures: scored.criticalFailures, perParam: scored.perParam },
      readyForGrn,
    };
  });
}));

async function isQcComplete(tx: any, g: any): Promise<boolean> {
  if (!g.po_id) {
    const { rows } = await tx.query(
      `SELECT count(*)::int c FROM qc_inspections WHERE gate_entry_id=$1`, [g.id]);
    return rows[0].c > 0;
  }
  const { rows } = await tx.query(
    `SELECT (SELECT count(DISTINCT product_id) FROM po_lines WHERE po_id=$1) AS need,
            (SELECT count(DISTINCT product_id) FROM qc_inspections WHERE gate_entry_id=$2) AS done`,
    [g.po_id, g.id]);
  return Number(rows[0].done) >= Number(rows[0].need);
}

/* ===========================================================================
 * §13 / §25 — GRN. THE critical transaction.
 *
 * Everything below happens in ONE database transaction:
 *   grn header → grn lines → batches → labels → stock_ledger → stock_balances
 *   → po_lines progress → putaway tasks → outbox event
 *
 * The uq_ledger_grn_line unique constraint means a retried request can never
 * post stock twice; the second attempt fails at the database and is reported
 * as "already posted" rather than silently doubling inventory.
 * ======================================================================== */
receivingRouter.post('/gate-entries/:id/grn', requires('receiving.grn.submit'), h(async (req) => {
  const input = body(z.object({
    idempotencyKey: z.string().min(8, 'Missing idempotency key'),
    postingDate: z.string().optional(),
    isPartial: z.boolean().default(false),
    remarks: z.string().optional(),
    lines: z.array(z.object({
      poLineId: z.string().uuid().nullable().optional(),
      qcInspectionId: z.string().uuid().nullable().optional(),
      productId: z.string().uuid(),
      uom: z.string(),
      receivedQty: z.number().nonnegative(),
      acceptedQty: z.number().nonnegative(),
      rejectedQty: z.number().nonnegative().default(0),
      holdQty: z.number().nonnegative().default(0),
      netWeightKg: z.number().nonnegative().nullable().optional(),
      containerTypeId: z.string().uuid().nullable().optional(),
      containerCount: z.number().int().nonnegative().nullable().optional(),
      rate: z.number().nonnegative(),
      grade: z.string().nullable().optional(),
      rejectionReasonCode: z.string().nullable().optional(),
      rejectionAction: z.enum(['RETURN', 'DESTROY', 'SUPPLIER_COLLECT', 'HOLD']).nullable().optional(),
      harvestDate: z.string().nullable().optional(),
      crateLabels: z.number().int().min(0).max(500).default(0),
    })).min(1, 'Nothing to receive'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    /* --- idempotency (§9.2): flaky 4G in a warehouse retries POSTs -------- */
    const { rows: idem } = await tx.query(
      `INSERT INTO idempotency_keys (key, company_id, user_id, endpoint, request_hash, state)
       VALUES ($1,$2,$3,'POST /receiving/grn',$4,'IN_PROGRESS')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [input.idempotencyKey, req.actor.companyId, req.actor.userId,
       Buffer.from(JSON.stringify(input.lines)).toString('base64').slice(0, 64)]);
    if (idem.length === 0) {
      const { rows: prev } = await tx.query(
        `SELECT response_body, state FROM idempotency_keys WHERE key=$1`, [input.idempotencyKey]);
      if (prev[0]?.response_body) return prev[0].response_body;
      throw ApiError.conflict('This receipt is already being posted. Please wait a moment.');
    }

    const { rows: gr } = await tx.query(
      `SELECT * FROM gate_entries WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const g = gr[0];
    if (!g) throw ApiError.notFound('Gate entry not found');

    // §28 — the chain cannot be bypassed without an authorised exception.
    if (!['QC_COMPLETE', 'GRN_PENDING'].includes(g.status)) {
      if (!req.actor.permissions.has('receiving.exception.approve')) {
        throw ApiError.rule(
          `Quality check is not complete for this vehicle (status: ${g.status}). ` +
          'Only an authorised exception can post stock now.');
      }
    }

    const postingDate = input.postingDate ?? new Date().toISOString().slice(0, 10);
    const isBackdated = postingDate < new Date().toISOString().slice(0, 10);
    if (isBackdated) {
      const daysBack = Math.ceil(
        (Date.now() - new Date(postingDate).getTime()) / 86_400_000);
      if (daysBack > req.actor.limits.maxBackdateDays && !req.actor.permissions.has('admin.override')) {
        throw ApiError.forbidden(
          `You can back-date at most ${req.actor.limits.maxBackdateDays} day(s). This is ${daysBack} days back.`);
      }
    }

    const grnNo = await nextDocNo(tx, req.actor, g.branch_id, 'GRN');
    const totals = input.lines.reduce((a, l) => ({
      received: a.received + l.receivedQty,
      accepted: a.accepted + l.acceptedQty,
      rejected: a.rejected + l.rejectedQty,
      weight: a.weight + (l.netWeightKg ?? 0),
      value: a.value + l.acceptedQty * l.rate,
    }), { received: 0, accepted: 0, rejected: 0, weight: 0, value: 0 });

    const { rows: grnRows } = await tx.query(
      `INSERT INTO grns (company_id, branch_id, warehouse_id, grn_no, gate_entry_id, po_id,
                         supplier_id, posting_date, is_backdated, backdate_approved_by,
                         total_received_qty, total_accepted_qty, total_rejected_qty,
                         total_net_weight_kg, total_value,
                         status, submitted_at, submitted_by, posted_at, posted_by,
                         idempotency_key, is_partial, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $9 THEN $15::uuid ELSE NULL END,
               $10,$11,$12,$13,$14,'POSTED',now(),$15,now(),$15,
               $16,$17,$18,$15,$15)
       RETURNING *`,
      [req.actor.companyId, g.branch_id, g.warehouse_id, grnNo, g.id, g.po_id, g.supplier_id,
       postingDate, isBackdated, Q(totals.received), Q(totals.accepted), Q(totals.rejected),
       round(totals.weight, 3), money(totals.value), req.actor.userId,
       input.idempotencyKey, input.isPartial, input.remarks ?? null]);
    const grn = grnRows[0];

    const createdBatches: any[] = [];
    const putawayTasks: any[] = [];

    /* §17 — a receipt is measured against the order it fulfils.
     *
     * Nothing used to check this: the GRN simply added whatever quantity it was
     * given to po_lines.received_qty. A quality check entered as "100" against
     * an order for "10 BOX" — easy to do, because neither screen showed the
     * unit — posted 100 BOX at the PO's own rate, turning a ₹900 order into an
     * ₹8,100 receipt and leaving the order reading 100 received of 10.
     *
     * Over-receipt is a real thing (a supplier sends a spare crate), so it is
     * allowed — but only inside tolerance, or with someone who may approve a
     * quantity variance saying so. */
    const qtyTolPct = Number(await getSetting(tx, req.actor, 'purchase.qty_tolerance_pct', 5));
    const mayOverReceive = req.actor.permissions.has('receiving.exception.approve')
      || req.actor.permissions.has('purchase.po.approve')
      || req.actor.permissions.has('admin.override');

    for (const [i, l] of input.lines.entries()) {
      if (l.rejectedQty > 0 && !l.rejectionReasonCode) {
        throw ApiError.rule('Every rejected quantity needs a reason code.');
      }

      if (l.poLineId) {
        const { rows: po } = await tx.query(
          `SELECT pl.qty, pl.received_qty, pl.uom, pl.product_id, p.name
             FROM po_lines pl JOIN products p ON p.id = pl.product_id
            WHERE pl.id = $1`, [l.poLineId]);
        const pol = po[0];
        if (pol) {
          if (pol.product_id !== l.productId) {
            throw ApiError.rule(
              `The selected order line is for ${pol.name}, not the submitted product. `
              + 'Keep the same product from box weighing through the receipt.');
          }
          const open = round(Number(pol.qty) - Number(pol.received_qty), 3);
          const allowed = round(open * (1 + qtyTolPct / 100), 3);
          if (l.receivedQty > allowed + 0.001 && !mayOverReceive) {
            throw ApiError.rule(
              `The order has ${open} ${pol.uom} of ${pol.name} still to come, and you are `
              + `receiving ${l.receivedQty}. Check the unit — the order is in ${pol.uom}. `
              + `A supervisor can accept more than was ordered.`,
              { orderedUom: pol.uom, openQty: open, receivingQty: l.receivedQty,
                tolerancePct: qtyTolPct });
          }
        }
      }

      const { rows: prod } = await tx.query(
        `SELECT name, sku, base_uom, shelf_life_days, is_batch_tracked, rotation_rule, storage_type,
                is_variable_weight FROM products WHERE id=$1`, [l.productId]);
      const p = prod[0];
      /* PO quantities stay in their commercial unit (for example 10 BOX),
       * but stock for a weight-based product must be the measured kilograms.
       * Otherwise packing sees the box count as kilograms and turns 150 kg
       * received into 10 kg available. */
      const stockQty = p?.base_uom === 'KG' && Number(l.netWeightKg) > 0
        ? Number(l.netWeightKg) : l.acceptedQty;

      const lineValue = money(l.acceptedQty * l.rate);
      const { rows: glRows } = await tx.query(
        `INSERT INTO grn_lines (company_id, grn_id, line_no, po_line_id, qc_inspection_id, product_id,
              uom, received_qty, accepted_qty, rejected_qty, hold_qty, net_weight_kg,
              container_type_id, container_count, rate, grade, line_value,
              rejection_reason_code, rejection_action, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
         RETURNING *`,
        [req.actor.companyId, grn.id, i + 1, l.poLineId ?? null, l.qcInspectionId ?? null,
         l.productId, l.uom, l.receivedQty, l.acceptedQty, l.rejectedQty, l.holdQty,
         l.netWeightKg ?? null, l.containerTypeId ?? null, l.containerCount ?? null,
         l.rate, l.grade ?? null, lineValue, l.rejectionReasonCode ?? null,
         l.rejectionAction ?? null, req.actor.userId]);
      const grnLine = glRows[0];

      /* --- only ACCEPTED quantity becomes stock (§13) -------------------- */
      if (l.acceptedQty > 0) {
        const batchNo = await nextDocNo(tx, req.actor, g.branch_id, 'BATCH');
        const shelfLife = p?.shelf_life_days ?? null;
        const { rows: bRows } = await tx.query(
          `INSERT INTO batches (company_id, branch_id, warehouse_id, batch_no, product_id,
                grn_line_id, supplier_id, received_date, harvest_date, expiry_date, shelf_life_days,
                grade, initial_qty, remaining_qty, net_weight_kg, remaining_weight_kg,
                landed_rate, landed_rate_per_kg, status, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                   CASE WHEN $10::int IS NULL THEN NULL ELSE $8::date + $10::int END,
                   $10,$11,$12,$12,$13,$13,$14,$15,'ACTIVE',$16,$16)
           RETURNING *`,
          [req.actor.companyId, g.branch_id, g.warehouse_id, batchNo, l.productId, grnLine.id,
           g.supplier_id, postingDate, l.harvestDate ?? null, shelfLife, l.grade ?? null,
           stockQty, l.netWeightKg ?? null, l.rate,
           l.netWeightKg && l.netWeightKg > 0 ? round(lineValue / l.netWeightKg, 6) : l.rate,
           req.actor.userId]);
        const batch = bRows[0];
        createdBatches.push(batch);

        await tx.query(`UPDATE grn_lines SET batch_id=$2 WHERE id=$1`, [grnLine.id, batch.id]);

        /* What we actually paid this supplier for this product, recorded at the
         * only moment it is known for certain.
         *
         * supplier_products.last_rate was read in three places and written in
         * none, so "what did we pay them last time" was permanently blank —
         * the buy list, the supplier catalogue and the rate comparison all
         * showed a dash. The same upsert creates the supplier-product link if
         * it is missing, which is what earns the pair its tracking code. */
        await tx.query(
          `INSERT INTO supplier_products
             (company_id, supplier_id, product_id, typical_grade,
              last_rate, last_purchase_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,now(),$6,$6)
           ON CONFLICT (supplier_id, product_id) DO UPDATE
              SET last_rate = EXCLUDED.last_rate,
                  last_purchase_at = EXCLUDED.last_purchase_at,
                  typical_grade = COALESCE(supplier_products.typical_grade, EXCLUDED.typical_grade),
                  is_active = true,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = now()`,
          [req.actor.companyId, g.supplier_id, l.productId, l.grade ?? null,
           l.rate, req.actor.userId]);

        /* --- labels (§14): one lot label plus optional per-crate labels --- */
        const lotCode = await nextDocNo(tx, req.actor, g.branch_id, 'LABEL');
        await tx.query(
          `INSERT INTO labels (company_id, batch_id, label_type, code, qr_payload, created_by)
           VALUES ($1,$2,'LOT',$3,$4,$5)`,
          [req.actor.companyId, batch.id, lotCode.replace(/\//g, '-'),
           JSON.stringify({
             sku: p?.sku, batch: batchNo, product: p?.name, grade: l.grade,
             receivedDate: postingDate, qty: stockQty, weightKg: l.netWeightKg,
             supplier: g.supplier_id, grn: grnNo, expiry: batch.expiry_date,
           }), req.actor.userId]);

        for (let c = 1; c <= (l.crateLabels ?? 0); c++) {
          const crateCode = `${lotCode.replace(/\//g, '-')}-C${String(c).padStart(3, '0')}`;
          await tx.query(
            `INSERT INTO labels (company_id, batch_id, label_type, code, qr_payload,
                                 actual_weight_kg, created_by)
             VALUES ($1,$2,'CRATE',$3,$4,$5,$6)`,
            [req.actor.companyId, batch.id, crateCode,
             JSON.stringify({ sku: p?.sku, batch: batchNo, crate: c, of: l.crateLabels }),
             // §14 — variable-weight crates carry their real weight, not an average
             p?.is_variable_weight && l.netWeightKg
               ? round(l.netWeightKg / (l.crateLabels || 1), 3) : null,
             req.actor.userId]);
        }

        /* --- THE inventory posting. Append-only, once, ever. -------------- */
        await tx.query(
          `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
                direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id,
                ref_line_id, posted_at, posted_by)
           VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,$8,$9,$10,'GRN','grn',$11,$12,now(),$13)`,
          [req.actor.companyId, g.branch_id, g.warehouse_id, l.productId, batch.id,
           stockQty, l.netWeightKg ?? null, p?.base_uom ?? l.uom, l.rate, lineValue,
           grn.id, grnLine.id, req.actor.userId]);

        await tx.query(
          `INSERT INTO stock_balances (company_id, warehouse_id, product_id, batch_id, qty, weight_kg)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (product_id, batch_id, warehouse_id) DO UPDATE
             SET qty = stock_balances.qty + EXCLUDED.qty,
                 weight_kg = stock_balances.weight_kg + EXCLUDED.weight_kg,
                 updated_at = now()`,
          [req.actor.companyId, g.warehouse_id, l.productId, batch.id,
           stockQty, l.netWeightKg ?? 0]);

        /* --- put-away suggestion (§15): FEFO/FIFO + storage type match ---- */
        const { rows: bin } = await tx.query(
          `SELECT b.id AS bin_id, r.id AS rack_id, z.id AS zone_id
             FROM bins b JOIN racks r ON r.id = b.rack_id JOIN zones z ON z.id = r.zone_id
            WHERE z.warehouse_id = $1 AND b.is_active AND z.is_active
              AND z.storage_type = $2
              AND (b.capacity_kg IS NULL OR b.current_fill_kg + $3 <= b.capacity_kg)
            ORDER BY b.is_pickface DESC, b.current_fill_kg ASC LIMIT 1`,
          [g.warehouse_id, p?.storage_type ?? 'AMBIENT', l.netWeightKg ?? 0]);

        /* The next job is the bench, not a put-away.
         *
         * There used to be two ways stock reached a shelf: a put-away task
         * that moved a whole batch to a bin, and the packing bench where each
         * box is graded, labelled and scanned onto a shelf individually. The
         * client uses the second and found the first confusing — reasonably,
         * since doing both means the same crates get placed twice.
         *
         * So no put-away task is raised. The suggested bin above is still
         * computed and handed back, because the bench uses it as its default
         * shelf: the arithmetic about where this product belongs is useful,
         * it was only the second placement step that was not.
         */
        putawayTasks.push({
          batchId: batch.id, batchNo, product: p?.name,
          suggestedBinId: bin[0]?.bin_id ?? null,
        });

        await pushTask(tx, req.actor, {
          branchId: g.branch_id, warehouseId: g.warehouse_id,
          queueKey: 'PUTAWAY_PENDING', docType: 'BATCH', docId: batch.id, docNo: batchNo,
          title: `Grade & pack ${p?.name} — ${l.acceptedQty} ${l.uom}`,
          subtitle: `Batch ${batchNo} · grade each box, label it, put it on a shelf`,
          requiredPermission: 'inventory.pack.grade', slaMinutes: 240,
        });
      }

      /* --- PO progress -------------------------------------------------- */
      if (l.poLineId) {
        await tx.query(
          `UPDATE po_lines
              SET received_qty = received_qty + $2,
                  accepted_qty = accepted_qty + $3,
                  rejected_qty = rejected_qty + $4,
                  line_status = CASE WHEN received_qty + $2 >= qty - 0.001 THEN 'RECEIVED'
                                     ELSE 'PART_RECEIVED' END,
                  updated_by = $5
            WHERE id = $1`,
          [l.poLineId, l.receivedQty, l.acceptedQty, l.rejectedQty, req.actor.userId]);
      }
    }

    /* The invoice may have been filed at supplier acceptance, before this
     * vehicle arrived. Reconcile it now that the receipt is real, so Finance
     * sees received/partial status immediately and only genuine exceptions
     * remain in the invoice-match queue. */
    if (g.po_id) {
      const { rows: invoices } = await tx.query(
        `SELECT id FROM supplier_invoices
          WHERE po_id = $1 AND company_id = $2 AND status <> 'CANCELLED'`,
        [g.po_id, req.actor.companyId]);
      for (const invoice of invoices) {
        await checkInvoiceAgainstReceipts(tx, req.actor, invoice.id);
      }
    }

    if (g.po_id) {
      const { rows: prog } = await tx.query(
        `SELECT bool_and(line_status IN ('RECEIVED','CLOSED','CANCELLED')) AS all_done
           FROM po_lines WHERE po_id=$1`, [g.po_id]);
      await tx.query(
        `UPDATE purchase_orders
            SET status = CASE WHEN $2 THEN 'RECEIVED' ELSE 'PART_RECEIVED' END, updated_by=$3
          WHERE id=$1 AND status IN ('CONFIRMED','APPROVED','PART_RECEIVED')`,
        [g.po_id, prog[0].all_done === true, req.actor.userId]);
    }

    await tx.query(
      `UPDATE gate_entries SET status='COMPLETED', unloading_end_at=now(),
              gate_out_at=now(), updated_by=$2 WHERE id=$1`,
      [g.id, req.actor.userId]);
    await resolveTask(tx, req.actor, 'GRN_PENDING', 'GATE_ENTRY', g.id);

    // Pricing and Accounts learn about this through the outbox, in the same
    // transaction — so a committed receipt can never fail to notify them.
    await emit(tx, req.actor, 'grn', grn.id, 'grn.posted', {
      grnNo, poId: g.po_id, supplierId: g.supplier_id,
      acceptedQty: Q(totals.accepted), value: money(totals.value),
      batches: createdBatches.map((b) => ({ id: b.id, batchNo: b.batch_no })),
    });

    const response = {
      ...grn,
      batches: createdBatches.map((b) => ({
        id: b.id, batchNo: b.batch_no, productId: b.product_id,
        qty: b.initial_qty, expiryDate: b.expiry_date, grade: b.grade,
      })),
      putawayTasks,
      message: `${grnNo} posted. ${Q(totals.accepted)} accepted into stock, ${Q(totals.rejected)} rejected.`,
    };

    await tx.query(
      `UPDATE idempotency_keys SET state='COMPLETED', status_code=200,
              response_body=$2, completed_at=now() WHERE key=$1`,
      [input.idempotencyKey, JSON.stringify(response)]);

    return response;
  });
}));

receivingRouter.get('/grns', h(async (req) =>
  query(req.actor,
    `SELECT g.id, g.grn_no, g.grn_date, g.posting_date, g.status, g.total_accepted_qty,
            g.total_rejected_qty, g.total_net_weight_kg, g.total_value, g.is_partial,
            s.trade_name AS supplier_name, o.po_no, ge.gate_no, ge.vehicle_reg_captured,
            u.full_name AS posted_by_name,
            (SELECT count(*) FROM landing_costs lc WHERE lc.grn_id = g.id AND lc.cost_status='ACTUAL') AS has_landing_cost
       FROM grns g
       JOIN suppliers s ON s.id = g.supplier_id
       JOIN gate_entries ge ON ge.id = g.gate_entry_id
       LEFT JOIN purchase_orders o ON o.id = g.po_id
       LEFT JOIN users u ON u.id = g.posted_by
      WHERE g.company_id = $1 AND ($2 = '' OR g.status = $2)
      ORDER BY g.posted_at DESC NULLS LAST, g.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? '')])));

receivingRouter.get('/grns/:id', h(async (req) => {
  const [g] = await query(req.actor,
    `SELECT g.*, s.trade_name AS supplier_name, s.source_type, o.po_no,
            ge.gate_no, ge.vehicle_reg_captured, u.full_name AS posted_by_name
       FROM grns g JOIN suppliers s ON s.id = g.supplier_id
       JOIN gate_entries ge ON ge.id = g.gate_entry_id
       LEFT JOIN purchase_orders o ON o.id = g.po_id
       LEFT JOIN users u ON u.id = g.posted_by
      WHERE g.id=$1 AND g.company_id=$2`, [req.params.id, req.actor.companyId]);
  if (!g) throw ApiError.notFound('Goods receipt not found');

  const [lines, landing] = await Promise.all([
    query(req.actor,
      `SELECT l.*, p.name AS product_name, p.sku, b.batch_no, b.expiry_date,
              q.quality_score, q.overall_result
         FROM grn_lines l JOIN products p ON p.id = l.product_id
         LEFT JOIN batches b ON b.id = l.batch_id
         LEFT JOIN qc_inspections q ON q.id = l.qc_inspection_id
        WHERE l.grn_id=$1 ORDER BY l.line_no`, [g.id]),
    query(req.actor,
      `SELECT lc.*, (SELECT json_agg(row_to_json(x)) FROM landing_cost_lines x
                      WHERE x.landing_cost_id = lc.id) AS lines
         FROM landing_costs lc WHERE lc.grn_id=$1 ORDER BY cost_status`, [g.id]),
  ]);
  return { ...g, lines, landingCosts: landing };
}));

/** §13 — no direct edits. A correction is a reversal plus a fresh GRN. */
receivingRouter.post('/grns/:id/reverse', requires('receiving.grn.reverse'), h(async (req) => {
  const input = body(z.object({ reason: z.string().min(6, 'Explain why this receipt is being reversed') }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM grns WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const g = rows[0];
    if (!g) throw ApiError.notFound('Goods receipt not found');
    if (g.status !== 'POSTED') throw ApiError.rule('Only a posted receipt can be reversed.');

    const { rows: lines } = await tx.query(
      `SELECT * FROM grn_lines WHERE grn_id=$1`, [g.id]);

    for (const l of lines) {
      if (!l.batch_id || Number(l.accepted_qty) <= 0) continue;
      const { rows: bal } = await tx.query(
        `SELECT qty FROM stock_balances WHERE batch_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [l.batch_id, g.warehouse_id, l.product_id]);
      if (!bal[0] || Number(bal[0].qty) < Number(l.accepted_qty) - 0.001) {
        throw ApiError.rule(
          'Part of this batch has already moved out of the warehouse, so it cannot be reversed. ' +
          'Raise a stock adjustment instead.');
      }

      await tx.query(
        `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
              direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id, ref_line_id,
              posted_by)
         VALUES ($1,$2,$3,$4,$5,'OUT',$6,$7,$8,$9,$10,'GRN_REVERSAL','grn',$11,$12,$13)`,
        [req.actor.companyId, g.branch_id, g.warehouse_id, l.product_id, l.batch_id,
         l.accepted_qty, l.net_weight_kg, l.uom, l.rate, l.line_value, g.id, l.id, req.actor.userId]);

      await tx.query(
        `UPDATE stock_balances SET qty = qty - $4, weight_kg = GREATEST(0, weight_kg - $5), updated_at = now()
          WHERE batch_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [l.batch_id, g.warehouse_id, l.product_id, l.accepted_qty, l.net_weight_kg ?? 0]);

      await tx.query(`UPDATE batches SET status='WRITTEN_OFF', remaining_qty=0 WHERE id=$1`, [l.batch_id]);

      if (l.po_line_id) {
        await tx.query(
          `UPDATE po_lines SET received_qty = GREATEST(0, received_qty - $2),
                  accepted_qty = GREATEST(0, accepted_qty - $3),
                  rejected_qty = GREATEST(0, rejected_qty - $4), line_status='OPEN'
            WHERE id=$1`,
          [l.po_line_id, l.received_qty, l.accepted_qty, l.rejected_qty]);
      }
    }

    await tx.query(
      `UPDATE grns SET status='REVERSED', amend_reason=$2, updated_by=$3 WHERE id=$1`,
      [g.id, input.reason, req.actor.userId]);

    await raiseAlert(tx, req.actor, {
      branchId: g.branch_id, alertType: 'GRN_REVERSED', severity: 'HIGH',
      entityType: 'grn', entityId: g.id,
      title: `${g.grn_no} was reversed`, message: input.reason,
    });
    await emit(tx, req.actor, 'grn', g.id, 'grn.reversed', { grnNo: g.grn_no, reason: input.reason });
    return { ok: true, status: 'REVERSED' };
  });
}));

/* ===========================================================================
 * §15 — PUT-AWAY used to be here: a task list, and a confirm endpoint that
 * moved a whole batch into a bin.
 *
 * Both are gone. The floor places stock box by box at the packing bench —
 * grade it, label it, scan the shelf — so a second placement step meant the
 * same crates were put away twice and the two records disagreed. Posting a
 * receipt now raises "grade & pack" instead; see postGrn() above, and
 * /inventory/pack-bench/* for where the stock actually lands.
 *
 * The endpoints are deleted rather than left behind: an API nothing calls is a
 * second way to do a job that only whoever reads the routes can find.
 * ======================================================================== */
/* ===========================================================================
   PICKUPS — arranging the vehicle

   A confirmed order still has to be fetched. This is the job board: dispatch
   publishes a pickup, drivers see it in their app, and every step after that
   is visible here and on the gate's queue.
   ======================================================================== */

receivingRouter.get('/pickups', h(async (req) =>
  query(req.actor,
    `SELECT p.*, s.trade_name AS supplier_name, s.phone AS supplier_phone,
            o.po_no, o.grand_total, w.name AS warehouse_name,
            d.full_name AS driver_name, d.phone AS driver_phone, v.reg_no AS vehicle_no
       FROM pickups p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN purchase_orders o ON o.id = p.po_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN drivers d ON d.id = p.driver_id
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.company_id = $1
        AND ($2 = '' OR p.status = $2)
      ORDER BY (p.status = 'DELIVERED'), p.pickup_on DESC, p.created_at DESC
      LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? '')])));

/** Orders that are confirmed but have nobody going to fetch them. */
receivingRouter.get('/pickups/candidates', requires('logistics.pickup.manage'), h(async (req) =>
  query(req.actor,
    `SELECT o.id AS po_id, o.po_no, o.expected_date, o.grand_total, o.branch_id,
            o.warehouse_id, o.status, o.supplier_response,
            o.transport_requested_at, o.transport_request_note,
            s.id AS supplier_id, s.trade_name AS supplier_name,
            s.phone AS supplier_phone,
            NULLIF(concat_ws(', ',
              s.address->>'line1', s.address->>'line2',
              s.address->>'city', s.address->>'state'), '') AS pickup_address
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.company_id = $1
        /* From the moment the order is placed, not only once the supplier has
         * answered. A lorry takes arranging, and waiting for the acceptance
         * before you can even think about it loses a day. */
        AND o.status IN ('APPROVED','CONFIRMED')
        AND NOT EXISTS (SELECT 1 FROM pickups p
                         WHERE p.po_id = o.id AND p.status <> 'CANCELLED')
      ORDER BY
        /* A supplier who has asked for a vehicle goes to the top — somebody is
         * standing next to crates waiting for an answer. */
        (o.transport_requested_at IS NOT NULL) DESC,
        o.expected_date LIMIT 100`,
    [req.actor.companyId])));

receivingRouter.post('/pickups', requires('logistics.pickup.manage'), h(async (req) => {
  const input = body(z.object({
    poId: z.string().uuid(),
    pickupOn: z.string(),
    windowStart: z.string().nullable().optional(),
    windowEnd: z.string().nullable().optional(),
    pickupAddress: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    /* Named driver, or leave it empty and let whoever is free take it. The
     * second is what actually happens with a pool of freelance vehicles. */
    driverId: z.string().uuid().nullable().optional(),
    vehicleId: z.string().uuid().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: poRows } = await tx.query(
      `SELECT o.id, o.po_no, o.branch_id, o.warehouse_id, o.supplier_id, o.status,
              NULLIF(concat_ws(', ',
                s.address->>'line1', s.address->>'line2',
                s.address->>'city', s.address->>'state'), '') AS pickup_address
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.id = $1 AND o.company_id = $2`,
      [input.poId, req.actor.companyId]);
    const po = poRows[0];
    if (!po) throw ApiError.notFound('Order not found');
    if (!['APPROVED', 'CONFIRMED'].includes(po.status)) {
      throw ApiError.rule(
        `A vehicle can be arranged once the order is placed. This one is ${po.status.toLowerCase().replace('_', ' ')}.`);
    }
    const { rows: existing } = await tx.query(
      `SELECT pickup_no FROM pickups WHERE po_id = $1 AND status <> 'CANCELLED'`, [po.id]);
    if (existing.length) {
      throw ApiError.conflict(`${existing[0].pickup_no} is already arranged for this order.`);
    }

    const pickupNo = await nextDocNo(tx, req.actor, po.branch_id, 'PIC');
    const assigned = !!input.driverId;
    const { rows } = await tx.query(
      `INSERT INTO pickups (company_id, branch_id, pickup_no, po_id, supplier_id, warehouse_id,
             pickup_on, window_start, window_end, pickup_address, notes,
             driver_id, vehicle_id, assigned_at, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $12::uuid IS NULL THEN NULL ELSE now() END,
               CASE WHEN $12::uuid IS NULL THEN 'OFFERED' ELSE 'ASSIGNED' END,
               $14,$14)
       RETURNING *`,
      [req.actor.companyId, po.branch_id, pickupNo, po.id, po.supplier_id, po.warehouse_id,
       input.pickupOn, input.windowStart || null, input.windowEnd || null,
       input.pickupAddress || po.pickup_address || null,
       input.notes ?? null, input.driverId ?? null, input.vehicleId ?? null, req.actor.userId]);

    /* If the supplier asked for this, the asking is now answered. Leaving the
     * flag up would keep the order at the top of the list forever. */
    await tx.query(
      `UPDATE purchase_orders SET transport_requested_at = NULL WHERE id = $1
         AND transport_requested_at IS NOT NULL`, [po.id]);
    await resolveTask(tx, req.actor, 'TRANSPORT_REQUEST', 'PO', po.id);

    await emit(tx, req.actor, 'pickup', rows[0].id, 'pickup.created',
      { pickupNo, poNo: po.po_no, offered: !assigned });
    return rows[0];
  });
}));

receivingRouter.post('/pickups/:id/cancel', requires('logistics.pickup.manage'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().trim().min(4, 'Say why this pickup is being cancelled'),
  }), req.body);
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE pickups SET status='CANCELLED', cancel_reason=$3, updated_by=$4, updated_at=now()
        WHERE id=$1 AND company_id=$2 AND status NOT IN ('DELIVERED','CANCELLED')
        RETURNING pickup_no`,
      [req.params.id, req.actor.companyId, input.reason, req.actor.userId]);
    if (!rows.length) throw ApiError.rule('That pickup is already delivered or cancelled.');
    await resolveTask(tx, req.actor, 'EXPECTED_ARRIVAL', 'PICKUP', req.params.id);
    await emit(tx, req.actor, 'pickup', req.params.id, 'pickup.cancelled',
      { pickupNo: rows[0].pickup_no, reason: input.reason });
    return { ok: true };
  });
}));
