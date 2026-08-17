import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';
import { emit, getSetting, nextDocNo, pushTask, raiseAlert, requestApprovals, resolveTask } from '../platform/services.js';
import {
  computeLandingCost, money, round, threeWayMatch,
  type Charge, type CostLine, type MatchLine,
} from '../domain/index.js';
import { robustAnomaly } from '../ai/features.js';

export const costingRouter = Router();
costingRouter.use(authenticate);
// Outside supplier logins never reach staff data — see staffOnly().
costingRouter.use(staffOnly);

/* ===========================================================================
 * §16 — LANDING COST ENGINE.
 *
 * Base rate is what the supplier charged. Landed cost is what the produce
 * actually costs you on the rack. Everything downstream — pricing, margin,
 * supplier comparison — is wrong if this is wrong.
 * ======================================================================== */
costingRouter.post('/landing-cost/:grnId/compute', requires('costing.landing.recompute'), h(async (req) => {
  const input = body(z.object({
    costStatus: z.enum(['ESTIMATED', 'ACTUAL']).default('ACTUAL'),
    charges: z.array(z.object({
      chargeTypeId: z.string().uuid(),
      amount: z.number().nonnegative(),
      allocationBasis: z.enum(['VALUE', 'WEIGHT', 'QTY', 'EQUAL', 'MANUAL']).optional(),
      supplierId: z.string().uuid().nullable().optional(),
      referenceNo: z.string().nullable().optional(),
    })).default([]),
    discountTotal: z.number().nonnegative().default(0),
    replaceCharges: z.boolean().default(true),
  }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    const { rows: grnRows } = await tx.query(
      `SELECT g.*, s.trade_name AS supplier_name FROM grns g
         JOIN suppliers s ON s.id = g.supplier_id
        WHERE g.id=$1 AND g.company_id=$2`, [req.params.grnId, req.actor.companyId]);
    const grn = grnRows[0];
    if (!grn) throw ApiError.notFound('Goods receipt not found');
    if (grn.status !== 'POSTED') throw ApiError.rule('Landing cost can only be computed for a posted receipt.');

    if (input.replaceCharges) {
      await tx.query(`DELETE FROM purchase_charges WHERE doc_type='GRN' AND doc_id=$1 AND source='MANUAL'`, [grn.id]);
    }
    for (const c of input.charges) {
      const { rows: ct } = await tx.query(
        `SELECT allocation_basis, is_creditable, affects_landing_cost FROM charge_types WHERE id=$1`,
        [c.chargeTypeId]);
      if (!ct[0]) throw ApiError.badRequest('Unknown charge type');
      await tx.query(
        `INSERT INTO purchase_charges (company_id, doc_type, doc_id, charge_type_id, amount,
              allocation_basis, is_creditable, affects_landing_cost, supplier_id, reference_no,
              source, created_by)
         VALUES ($1,'GRN',$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10)`,
        [req.actor.companyId, grn.id, c.chargeTypeId, c.amount,
         c.allocationBasis ?? ct[0].allocation_basis, ct[0].is_creditable,
         ct[0].affects_landing_cost, c.supplierId ?? null, c.referenceNo ?? null, req.actor.userId]);
    }

    // Charges can come from the PO as well as be added at receipt.
    const { rows: chargeRows } = await tx.query(
      `SELECT ct.code, pc.amount, pc.allocation_basis, pc.is_creditable, pc.affects_landing_cost
         FROM purchase_charges pc JOIN charge_types ct ON ct.id = pc.charge_type_id
        WHERE pc.doc_type='GRN' AND pc.doc_id=$1
        UNION ALL
       SELECT ct.code, poc.amount, poc.allocation_basis, poc.is_creditable, true
         FROM po_charges poc JOIN charge_types ct ON ct.id = poc.charge_type_id
        WHERE poc.po_id = $2 AND poc.borne_by <> 'SUPPLIER'`,
      [grn.id, grn.po_id]);

    const charges: Charge[] = chargeRows.map((c: any) => ({
      code: c.code, amount: Number(c.amount), basis: c.allocation_basis,
      isCreditable: c.is_creditable, affectsLandingCost: c.affects_landing_cost,
    }));

    const { rows: lineRows } = await tx.query(
      `SELECT l.id, l.product_id, l.batch_id, l.accepted_qty, l.net_weight_kg, l.rate,
              p.default_wastage_pct, p.name AS product_name, p.sku,
              (SELECT b2.landed_rate_per_kg FROM batches b2
                 JOIN grn_lines gl2 ON gl2.id = b2.grn_line_id
                 JOIN grns g2 ON g2.id = gl2.grn_id
                WHERE b2.product_id = l.product_id AND g2.id <> $2 AND b2.landed_rate_per_kg IS NOT NULL
                ORDER BY g2.posting_date DESC LIMIT 1) AS prev_landed_rate_per_kg
         FROM grn_lines l JOIN products p ON p.id = l.product_id
        WHERE l.grn_id=$1 AND l.accepted_qty > 0 ORDER BY l.line_no`, [grn.id, grn.id]);

    if (lineRows.length === 0) throw ApiError.rule('This receipt has no accepted quantity to cost.');

    const costLines: CostLine[] = lineRows.map((l: any) => ({
      grnLineId: l.id, productId: l.product_id, batchId: l.batch_id,
      acceptedQty: Number(l.accepted_qty),
      acceptedWeightKg: Number(l.net_weight_kg ?? l.accepted_qty),
      baseRate: Number(l.rate), wastagePct: Number(l.default_wastage_pct ?? 0),
      prevLandedRatePerKg: l.prev_landed_rate_per_kg ? Number(l.prev_landed_rate_per_kg) : null,
    }));

    const result = computeLandingCost(costLines, charges, input.discountTotal);

    const { rows: est } = await tx.query(
      `SELECT total_landed FROM landing_costs WHERE grn_id=$1 AND cost_status='ESTIMATED'`, [grn.id]);
    const estimated = est[0] ? Number(est[0].total_landed) : Number(grn.total_value ?? 0);
    const varianceVsEstimate = money(result.totals.totalLanded - estimated);
    const varianceVsEstimatePct = estimated > 0
      ? round((varianceVsEstimate / estimated) * 100, 4) : null;

    // §16 — abnormal jump detection against this product's own history.
    const jumpLimit = Number(await getSetting(tx, req.actor, 'costing.abnormal_jump_pct', 15));
    let isAbnormal = false;
    const abnormalProducts: string[] = [];
    for (const [i, l] of result.lines.entries()) {
      if (l.rateChangePct != null && Math.abs(l.rateChangePct) > jumpLimit) {
        isAbnormal = true;
        abnormalProducts.push(`${lineRows[i].product_name} (${l.rateChangePct > 0 ? '+' : ''}${l.rateChangePct}%)`);
      }
    }

    const { rows: lc } = await tx.query(
      `INSERT INTO landing_costs (company_id, branch_id, grn_id, cost_status, base_amount,
            discount_amount, total_charges, non_creditable_tax, wastage_provision, total_landed,
            estimated_total, variance_vs_estimate, variance_vs_estimate_pct, is_abnormal,
            margin_risk_flag, snapshot, rule_version, computed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'1.0',$17)
       ON CONFLICT (grn_id, cost_status) DO UPDATE SET
            base_amount=EXCLUDED.base_amount, discount_amount=EXCLUDED.discount_amount,
            total_charges=EXCLUDED.total_charges, non_creditable_tax=EXCLUDED.non_creditable_tax,
            wastage_provision=EXCLUDED.wastage_provision, total_landed=EXCLUDED.total_landed,
            estimated_total=EXCLUDED.estimated_total,
            variance_vs_estimate=EXCLUDED.variance_vs_estimate,
            variance_vs_estimate_pct=EXCLUDED.variance_vs_estimate_pct,
            is_abnormal=EXCLUDED.is_abnormal, snapshot=EXCLUDED.snapshot,
            computed_at=now(), computed_by=EXCLUDED.computed_by
       RETURNING *`,
      [req.actor.companyId, grn.branch_id, grn.id, input.costStatus,
       result.totals.baseAmount, result.totals.discountAmount, result.totals.totalCharges,
       result.totals.nonCreditableTax, result.totals.wastageProvision, result.totals.totalLanded,
       estimated, varianceVsEstimate, varianceVsEstimatePct, isAbnormal, isAbnormal,
       JSON.stringify({ charges, lines: result.lines, jumpLimit }), req.actor.userId]);

    await tx.query(`DELETE FROM landing_cost_lines WHERE landing_cost_id=$1`, [lc[0].id]);
    for (const l of result.lines) {
      await tx.query(
        `INSERT INTO landing_cost_lines (company_id, landing_cost_id, grn_line_id, product_id,
              batch_id, accepted_qty, accepted_weight_kg, base_rate, base_value, allocated_charges,
              allocated_total, non_creditable_tax, wastage_pct, wastage_amount, landed_value,
              landed_rate_per_uom, landed_rate_per_kg, prev_landed_rate, rate_change_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [req.actor.companyId, lc[0].id, l.grnLineId, l.productId, l.batchId,
         l.acceptedQty, l.acceptedWeightKg, l.baseRate, l.baseValue,
         JSON.stringify(l.allocatedCharges), l.allocatedTotal, l.nonCreditableTax,
         l.wastagePct, l.wastageAmount, l.landedValue, l.landedRatePerUom, l.landedRatePerKg,
         l.prevLandedRatePerKg, l.rateChangePct]);

      if (input.costStatus === 'ACTUAL' && l.batchId) {
        await tx.query(
          `UPDATE batches SET landed_rate=$2, landed_rate_per_kg=$3 WHERE id=$1`,
          [l.batchId, l.landedRatePerUom, l.landedRatePerKg]);
      }
    }

    if (isAbnormal) {
      await raiseAlert(tx, req.actor, {
        branchId: grn.branch_id, alertType: 'LANDING_COST_ABNORMAL', severity: 'CRITICAL',
        entityType: 'grn', entityId: grn.id,
        title: `Landed cost moved sharply on ${grn.grn_no}`,
        message: `${abnormalProducts.join(', ')}. Check the selling price before this stock goes out.`,
        meta: { abnormalProducts },
      });
    }

    // §16 — landing cost change triggers the Pricing engine downstream.
    if (input.costStatus === 'ACTUAL') {
      await emit(tx, req.actor, 'landing_cost', lc[0].id, 'landing_cost.updated', {
        grnId: grn.id, grnNo: grn.grn_no,
        lines: result.lines.map((l) => ({
          productId: l.productId, batchId: l.batchId,
          landedRatePerKg: l.landedRatePerKg, rateChangePct: l.rateChangePct,
        })),
        isAbnormal,
      });
    }

    return {
      ...lc[0],
      lines: result.lines.map((l, i) => ({
        ...l, productName: lineRows[i].product_name, sku: lineRows[i].sku,
      })),
      chargesUsed: charges, isAbnormal, abnormalProducts,
    };
  });
}));

costingRouter.get('/landing-cost/:grnId', h(async (req) => {
  const rows = await query(req.actor,
    `SELECT lc.*, (SELECT json_agg(json_build_object(
                     'grnLineId', x.grn_line_id, 'productName', p.name, 'sku', p.sku,
                     'acceptedQty', x.accepted_qty, 'acceptedWeightKg', x.accepted_weight_kg,
                     'baseRate', x.base_rate, 'baseValue', x.base_value,
                     'allocatedCharges', x.allocated_charges, 'allocatedTotal', x.allocated_total,
                     'wastagePct', x.wastage_pct, 'wastageAmount', x.wastage_amount,
                     'landedValue', x.landed_value, 'landedRatePerUom', x.landed_rate_per_uom,
                     'landedRatePerKg', x.landed_rate_per_kg, 'prevLandedRate', x.prev_landed_rate,
                     'rateChangePct', x.rate_change_pct))
                    FROM landing_cost_lines x JOIN products p ON p.id = x.product_id
                   WHERE x.landing_cost_id = lc.id) AS lines
       FROM landing_costs lc WHERE lc.grn_id=$1 AND lc.company_id=$2
      ORDER BY lc.cost_status`, [req.params.grnId, req.actor.companyId]);
  return rows;
}));

/* ===========================================================================
 * §17 — SUPPLIER INVOICE & 3-WAY MATCH.
 * ======================================================================== */
costingRouter.post('/invoices', requires('finance.invoice.create'), h(async (req) => {
  const input = body(z.object({
    branchId: z.string().uuid(),
    supplierId: z.string().uuid(),
    invoiceNo: z.string().min(1, 'Invoice number is required'),
    invoiceDate: z.string(),
    dueDate: z.string().nullable().optional(),
    poId: z.string().uuid().nullable().optional(),
    supplierGstin: z.string().nullable().optional(),
    isRcm: z.boolean().default(false),
    subtotal: z.number().nonnegative().default(0),
    discount: z.number().nonnegative().default(0),
    charges: z.number().nonnegative().default(0),
    taxAmount: z.number().nonnegative().default(0),
    total: z.number().positive('Invoice total is required'),
    lines: z.array(z.object({
      rawDescription: z.string().optional(),
      productId: z.string().uuid().nullable().optional(),
      matchedGrnLineId: z.string().uuid().nullable().optional(),
      matchedPoLineId: z.string().uuid().nullable().optional(),
      qty: z.number().positive(),
      uom: z.string().nullable().optional(),
      rate: z.number().nonnegative(),
      taxRate: z.number().nonnegative().default(0),
      taxAmount: z.number().nonnegative().default(0),
      amount: z.number().nonnegative(),
    })).min(1, 'Add the invoice lines'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    // §17 — duplicate invoice detection before anything else.
    const { rows: dup } = await tx.query(
      `SELECT id, invoice_no, invoice_date, total FROM supplier_invoices
        WHERE company_id=$1 AND supplier_id=$2
          AND (lower(invoice_no) = lower($3)
               OR (abs(total - $4) < 1 AND invoice_date = $5))
          AND status <> 'CANCELLED' LIMIT 1`,
      [req.actor.companyId, input.supplierId, input.invoiceNo, input.total, input.invoiceDate]);

    /* Two different situations wear the same word.
     *
     * The SAME invoice number from the same supplier is not a suspicion, it is
     * a re-submission — and the unique index on (company, supplier, invoice_no)
     * would reject it anyway, with a message naming a database constraint. Say
     * what happened and which document it already is, especially now that
     * suppliers file their own invoices and will re-send one.
     *
     * A DIFFERENT number that happens to carry the same total on the same day
     * is a suspicion, and that is what duplicate_of_id/duplicate_score exist
     * for: it is recorded, flagged and left for a human to clear. */
    const exact = dup.find(
      (d: any) => String(d.invoice_no).toLowerCase() === input.invoiceNo.toLowerCase());
    if (exact) {
      throw ApiError.conflict(
        `Invoice ${exact.invoice_no} from this supplier is already recorded (${
          new Date(exact.invoice_date).toISOString().slice(0, 10)}, ${
          Number(exact.total).toLocaleString('en-IN')}). Nothing was filed twice.`,
        { existingInvoiceId: exact.id, invoiceNo: exact.invoice_no },
      );
    }

    const arithmeticOk = Math.abs(
      input.lines.reduce((a, l) => a + l.amount, 0) - input.subtotal) < 1;

    const { rows } = await tx.query(
      `INSERT INTO supplier_invoices (company_id, branch_id, supplier_id, invoice_no, invoice_date,
            due_date, po_id, subtotal, discount, charges, tax_amount, total, supplier_gstin,
            is_rcm, ocr_arithmetic_ok, status, duplicate_of_id, duplicate_score,
            created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING',$16,$17,$18,$18)
       RETURNING *`,
      [req.actor.companyId, input.branchId, input.supplierId, input.invoiceNo, input.invoiceDate,
       input.dueDate ?? null, input.poId ?? null, input.subtotal, input.discount, input.charges,
       input.taxAmount, input.total, input.supplierGstin ?? null, input.isRcm, arithmeticOk,
       dup[0]?.id ?? null, dup[0] ? 0.9 : null, req.actor.userId]);
    const inv = rows[0];

    /* §17 — pair each line to the receipt it is billing.
     *
     * The 3-way match reads invoice_lines.matched_grn_line_id, and nothing was
     * setting it: the capture screen never asked, so every invoice matched
     * against nothing, reported "Invoice line has no matching goods receipt"
     * and went to HOLD. The match could not return MATCH for any invoice.
     *
     * So when the caller has not paired a line explicitly, pair it by product
     * against this supplier's posted receipts — narrowed to the invoice's own
     * PO when it names one, newest first, skipping receipt lines another
     * invoice has already claimed. An explicit pairing always wins, and a line
     * we cannot pair stays NULL so the match still reports it honestly. */
    const claimed = new Set<string>();
    for (const [i, l] of input.lines.entries()) {
      let grnLineId: string | null = l.matchedGrnLineId ?? null;

      if (!grnLineId && l.productId) {
        const { rows: cand } = await tx.query(
          `SELECT gl.id
             FROM grn_lines gl
             JOIN grns g ON g.id = gl.grn_id
            WHERE g.company_id = $1 AND g.status = 'POSTED'
              AND g.supplier_id = $2
              AND gl.product_id = $3
              AND ($4::uuid IS NULL OR g.po_id = $4)
              AND NOT (gl.id = ANY($5::uuid[]))
              AND NOT EXISTS (SELECT 1 FROM invoice_lines x
                               WHERE x.matched_grn_line_id = gl.id)
            ORDER BY g.posting_date DESC, gl.line_no
            LIMIT 1`,
          [req.actor.companyId, input.supplierId, l.productId, input.poId ?? null,
           [...claimed]]);
        grnLineId = cand[0]?.id ?? null;
      }
      if (grnLineId) claimed.add(grnLineId);

      await tx.query(
        `INSERT INTO invoice_lines (company_id, invoice_id, line_no, raw_description, product_id,
              matched_grn_line_id, matched_po_line_id, qty, uom, rate, tax_rate, tax_amount, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [req.actor.companyId, inv.id, i + 1, l.rawDescription ?? null, l.productId ?? null,
         grnLineId, l.matchedPoLineId ?? null, l.qty, l.uom ?? null,
         l.rate, l.taxRate, l.taxAmount, l.amount]);
    }

    if (dup[0]) {
      await raiseAlert(tx, req.actor, {
        branchId: input.branchId, alertType: 'DUPLICATE_INVOICE', severity: 'CRITICAL',
        entityType: 'supplier_invoice', entityId: inv.id,
        title: `Possible duplicate of invoice ${dup[0].invoice_no}`,
        message: `Same supplier, matching number or same date and amount. Verify before paying.`,
        meta: { duplicateOf: dup[0].id },
      });
    }

    await pushTask(tx, req.actor, {
      branchId: input.branchId, queueKey: 'INVOICE_MATCH',
      docType: 'INVOICE', docId: inv.id, docNo: input.invoiceNo,
      title: `Match invoice ${input.invoiceNo}`,
      subtitle: `₹${Number(input.total).toLocaleString('en-IN')}`,
      severity: dup[0] ? 'critical' : 'normal',
      requiredPermission: 'finance.invoice.match', slaMinutes: 480,
    });

    return { ...inv, possibleDuplicate: dup[0] ?? null, arithmeticOk };
  });
}));

costingRouter.post('/invoices/:id/match', requires('finance.invoice.match'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows: iRows } = await tx.query(
      `SELECT * FROM supplier_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const inv = iRows[0];
    if (!inv) throw ApiError.notFound('Invoice not found');

    const { rows: lines } = await tx.query(
      `SELECT il.*, gl.accepted_qty AS grn_qty, pl.rate AS po_rate,
              p.name AS product_name
         FROM invoice_lines il
         LEFT JOIN grn_lines gl ON gl.id = il.matched_grn_line_id
         LEFT JOIN po_lines  pl ON pl.id = COALESCE(il.matched_po_line_id, gl.po_line_id)
         LEFT JOIN products  p  ON p.id  = il.product_id
        WHERE il.invoice_id=$1 ORDER BY il.line_no`, [inv.id]);

    const { rows: tolRows } = await tx.query(
      `SELECT * FROM tolerance_profiles WHERE company_id=$1 AND is_default LIMIT 1`,
      [req.actor.companyId]);
    const t = tolRows[0];
    if (!t) throw ApiError.rule('No default tolerance profile is configured.');

    const matchLines: MatchLine[] = lines.map((l: any) => ({
      lineNo: l.line_no,
      description: l.product_name ?? l.raw_description ?? `Line ${l.line_no}`,
      invoiceQty: Number(l.qty), invoiceRate: Number(l.rate),
      invoiceAmount: Number(l.amount), invoiceTax: Number(l.tax_amount ?? 0),
      grnQty: l.grn_qty != null ? Number(l.grn_qty) : null,
      poRate: l.po_rate != null ? Number(l.po_rate) : null,
    }));

    const { rows: poCharge } = await tx.query(
      `SELECT COALESCE(SUM(amount),0) s FROM po_charges
        WHERE po_id=$1 AND borne_by <> 'SUPPLIER'`, [inv.po_id]);

    const result = threeWayMatch(matchLines, {
      qtyTolPct: Number(t.qty_tol_pct), rateTolPct: Number(t.rate_tol_pct),
      taxTolAbs: Number(t.tax_tol_abs), chargeTolPct: Number(t.charge_tol_pct),
      criticalQtyPct: Number(t.critical_qty_pct), criticalRatePct: Number(t.critical_rate_pct),
    }, Number(inv.charges ?? 0), Number(poCharge[0].s));

    await tx.query(`UPDATE match_results SET is_latest=false WHERE invoice_id=$1`, [inv.id]);
    const { rows: mr } = await tx.query(
      `INSERT INTO match_results (company_id, invoice_id, run_by, tolerance_profile_id, overall,
            qty_result, rate_result, tax_result, charge_result, qty_variance, rate_variance_pct,
            findings, is_latest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true) RETURNING *`,
      [req.actor.companyId, inv.id, req.actor.userId, t.id, result.overall,
       result.qtyResult, result.rateResult, result.taxResult, result.chargeResult,
       result.qtyVariance, result.rateVariancePct, JSON.stringify(result.findings)]);

    const newStatus = result.overall === 'MATCH' ? 'MATCHED'
      : result.overall === 'CRITICAL_MISMATCH' ? 'HOLD' : 'MISMATCH';

    await tx.query(
      `UPDATE supplier_invoices SET status=$2,
              hold_reason = CASE WHEN $2 = 'HOLD' THEN $3 ELSE hold_reason END, updated_by=$4
        WHERE id=$1`,
      [inv.id, newStatus,
       result.findings.filter((f) => f.severity === 'FAIL').map((f) => f.message).join('; ') || null,
       req.actor.userId]);

    if (newStatus === 'MATCHED') {
      await tx.query(
        `UPDATE supplier_invoices SET status='PAYABLE', approved_by=$2, approved_at=now() WHERE id=$1`,
        [inv.id, req.actor.userId]);
      await tx.query(
        `INSERT INTO payment_status (invoice_id, company_id, supplier_id, payable_amount,
              balance, due_date, sync_source)
         VALUES ($1,$2,$3,$4,$4,$5,'PURCHASE_MODULE')
         ON CONFLICT (invoice_id) DO UPDATE SET payable_amount=EXCLUDED.payable_amount,
              balance=EXCLUDED.balance, due_date=EXCLUDED.due_date, last_synced_at=now()`,
        [inv.id, req.actor.companyId, inv.supplier_id, inv.total, inv.due_date]);
      await resolveTask(tx, req.actor, 'INVOICE_MATCH', 'INVOICE', inv.id);
      await emit(tx, req.actor, 'supplier_invoice', inv.id, 'invoice.payable',
        { invoiceNo: inv.invoice_no, total: inv.total });
    } else {
      await raiseAlert(tx, req.actor, {
        branchId: inv.branch_id, alertType: 'INVOICE_MISMATCH',
        severity: newStatus === 'HOLD' ? 'CRITICAL' : 'HIGH',
        entityType: 'supplier_invoice', entityId: inv.id,
        title: `Invoice ${inv.invoice_no} did not match`,
        message: result.findings.slice(0, 3).map((f) => f.message).join('; '),
        meta: { overall: result.overall },
      });
      await requestApprovals(tx, req.actor,
        { docType: 'INVOICE', docId: inv.id, docNo: inv.invoice_no, branchId: inv.branch_id },
        { value: Number(inv.total) });

      // §17 — a short-supply or quality mismatch drafts the debit note that
      // recovers the money, rather than leaving it to be forgotten.
      const shortLines = result.findings.filter(
        (f) => f.field === 'qty' && f.expected != null && f.actual > f.expected);
      if (shortLines.length > 0) {
        const noteNo = await nextDocNo(tx, req.actor, inv.branch_id, 'DN');
        const amount = money(shortLines.reduce((a, f) => {
          const l = matchLines.find((m) => m.lineNo === f.lineNo);
          return a + ((f.actual - (f.expected ?? 0)) * (l?.invoiceRate ?? 0));
        }, 0));
        if (amount > 0) {
          await tx.query(
            `INSERT INTO credit_debit_notes (company_id, branch_id, note_no, note_type, supplier_id,
                  invoice_id, reason_code, amount, total, status, auto_drafted, remarks, created_by)
             VALUES ($1,$2,$3,'DEBIT',$4,$5,'SHORT_SUPPLY',$6,$6,'DRAFT',true,$7,$8)`,
            [req.actor.companyId, inv.branch_id, noteNo, inv.supplier_id, inv.id, amount,
             'Auto-drafted from 3-way match: billed more than received.', req.actor.userId]);
        }
      }
    }

    return { ...mr[0], invoiceStatus: newStatus, findings: result.findings };
  })));

costingRouter.get('/invoices', h(async (req) =>
  query(req.actor,
    `SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.total, i.status, i.is_rcm,
            i.duplicate_of_id, s.trade_name AS supplier_name, o.po_no,
            m.overall AS match_result, m.findings,
            ps.paid_amount, ps.balance,
            CASE WHEN ps.due_date IS NOT NULL AND ps.balance > 0
                 THEN GREATEST(0, CURRENT_DATE - ps.due_date) END AS overdue_days
       FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN purchase_orders o ON o.id = i.po_id
       LEFT JOIN match_results m ON m.invoice_id = i.id AND m.is_latest
       LEFT JOIN payment_status ps ON ps.invoice_id = i.id
      WHERE i.company_id=$1 AND ($2 = '' OR i.status = $2)
      ORDER BY i.received_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? '')])));

costingRouter.get('/invoices/:id', h(async (req) => {
  const [inv] = await query(req.actor,
    `SELECT i.*, s.trade_name AS supplier_name, s.legal_name, s.gstin AS supplier_master_gstin,
            o.po_no FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN purchase_orders o ON o.id = i.po_id
      WHERE i.id=$1 AND i.company_id=$2`, [req.params.id, req.actor.companyId]);
  if (!inv) throw ApiError.notFound('Invoice not found');
  const [lines, match, notes, payment] = await Promise.all([
    query(req.actor,
      `SELECT il.*, p.name AS product_name, gl.accepted_qty AS grn_qty, pl.rate AS po_rate
         FROM invoice_lines il
         LEFT JOIN products p ON p.id = il.product_id
         LEFT JOIN grn_lines gl ON gl.id = il.matched_grn_line_id
         LEFT JOIN po_lines pl ON pl.id = COALESCE(il.matched_po_line_id, gl.po_line_id)
        WHERE il.invoice_id=$1 ORDER BY il.line_no`, [inv.id]),
    query(req.actor,
      `SELECT * FROM match_results WHERE invoice_id=$1 ORDER BY run_at DESC LIMIT 5`, [inv.id]),
    query(req.actor,
      `SELECT * FROM credit_debit_notes WHERE invoice_id=$1 ORDER BY created_at DESC`, [inv.id]),
    query(req.actor,
      `SELECT ps.*, CASE WHEN ps.due_date IS NOT NULL AND ps.balance > 0
                          THEN GREATEST(0, CURRENT_DATE - ps.due_date) END AS overdue_days
         FROM payment_status ps WHERE ps.invoice_id=$1`, [inv.id]),
  ]);
  return { ...inv, lines, matchResults: match, notes, payment: payment[0] ?? null };
}));

/** Candidate GRN lines to match an invoice line against. */
costingRouter.get('/invoices/:id/candidates', h(async (req) =>
  query(req.actor,
    `SELECT gl.id AS grn_line_id, gl.po_line_id, gl.product_id, gl.accepted_qty, gl.rate,
            gl.uom, p.name AS product_name, p.sku, g.grn_no, g.posting_date, pl.rate AS po_rate
       FROM grn_lines gl
       JOIN grns g ON g.id = gl.grn_id
       JOIN products p ON p.id = gl.product_id
       LEFT JOIN po_lines pl ON pl.id = gl.po_line_id
      WHERE g.company_id = $1 AND g.status='POSTED'
        AND g.supplier_id = (SELECT supplier_id FROM supplier_invoices WHERE id=$2)
        AND (SELECT po_id FROM supplier_invoices WHERE id=$2) IS NULL
             OR g.po_id = (SELECT po_id FROM supplier_invoices WHERE id=$2)
      ORDER BY g.posting_date DESC LIMIT 100`,
    [req.actor.companyId, req.params.id])));

/* ===========================================================================
 * §18 — PAYMENT STATUS. This module READS payment state; it never pays.
 * Finance (or Tally) pushes updates in through this endpoint.
 * ======================================================================== */
costingRouter.get('/payments', requires('finance.payment.view'), h(async (req) =>
  query(req.actor,
    `SELECT ps.*, CASE WHEN ps.due_date IS NOT NULL AND ps.balance > 0
                       THEN GREATEST(0, CURRENT_DATE - ps.due_date) END AS overdue_days,
            i.invoice_no, i.invoice_date, i.status AS invoice_status,
            s.trade_name AS supplier_name, s.code AS supplier_code
       FROM payment_status ps
       JOIN supplier_invoices i ON i.id = ps.invoice_id
       JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.company_id=$1 AND ($2 = '' OR (($2='OVERDUE' AND ps.due_date < CURRENT_DATE AND ps.balance > 0)
                                           OR ($2='OPEN' AND ps.balance > 0)))
      ORDER BY (CASE WHEN ps.due_date IS NOT NULL AND ps.balance > 0
                     THEN GREATEST(0, CURRENT_DATE - ps.due_date) END) DESC NULLS LAST, ps.due_date`,
    [req.actor.companyId, String(req.query.filter ?? '')])));

costingRouter.post('/payments/sync', requires('finance.payment.view'), h(async (req) => {
  const input = body(z.object({
    invoiceId: z.string().uuid(),
    paidAmount: z.number().nonnegative(),
    lastPaymentAt: z.string().nullable().optional(),
    externalRef: z.string().nullable().optional(),
    isBlocked: z.boolean().default(false),
    blockedReason: z.string().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE payment_status
          SET paid_amount = $2, balance = GREATEST(0, payable_amount - $2),
              last_payment_at = $3, external_ref = $4, is_blocked = $5, blocked_reason = $6,
              last_synced_at = now(), sync_source = 'FINANCE'
        WHERE invoice_id = $1 AND company_id = $7
        RETURNING *, CASE WHEN due_date IS NOT NULL AND balance > 0
                          THEN GREATEST(0, CURRENT_DATE - due_date) END AS overdue_days`,
      [input.invoiceId, input.paidAmount, input.lastPaymentAt ?? null, input.externalRef ?? null,
       input.isBlocked, input.blockedReason ?? null, req.actor.companyId]);
    if (!rows[0]) throw ApiError.notFound('No payable record for that invoice');

    const fullyPaid = Number(rows[0].balance) <= 0.01;
    await tx.query(
      `UPDATE supplier_invoices SET status = $2 WHERE id = $1 AND status IN ('PAYABLE','PART_PAID')`,
      [input.invoiceId, fullyPaid ? 'PAID' : 'PART_PAID']);
    return rows[0];
  });
}));

/** Rate anomaly check, used by the PO screen before submitting. */
costingRouter.get('/rate-check', h(async (req) => {
  const productId = String(req.query.productId ?? '');
  const rate = Number(req.query.rate ?? 0);
  if (!productId || !rate) throw ApiError.badRequest('Product and rate are required');

  const rows = await query(req.actor,
    `SELECT pl.rate FROM po_lines pl JOIN purchase_orders o ON o.id = pl.po_id
      WHERE pl.product_id=$1 AND o.company_id=$2
        AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED','RECEIVED')
        AND o.order_date >= CURRENT_DATE - 90
      ORDER BY o.order_date DESC LIMIT 30`, [productId, req.actor.companyId]);

  const series = rows.map((r: any) => Number(r.rate));
  const a = robustAnomaly(series, rate);
  return {
    ...a, sampleSize: series.length,
    message: a.isAnomaly
      ? `This rate is unusual — recent purchases have been around ₹${a.median}. Confirm before submitting.`
      : null,
  };
}));

/* ===========================================================================
   CREDIT & DEBIT NOTES — the money that comes back

   The match engine already drafts a debit note when a supplier bills for more
   than we received. Until now that draft had nowhere to go: no way to issue
   it, no way to record that the supplier accepted it, and no effect on what we
   owe. A claim nobody can settle is a claim nobody makes.

   Direction, stated once so the arithmetic is never guessed at:
     DEBIT  — we are claiming money back. It REDUCES what we owe.
     CREDIT — a correction in the supplier's favour. It INCREASES what we owe.
   ======================================================================== */

const NOTE_FLOW: Record<string, string[]> = {
  DRAFT:    ['ISSUED', 'CANCELLED'],
  ISSUED:   ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['SETTLED'],
  SETTLED:  [],
  CANCELLED: [],
};

costingRouter.get('/notes', h(async (req) =>
  query(req.actor,
    `SELECT n.*, s.trade_name AS supplier_name, i.invoice_no, g.grn_no,
            u.full_name AS created_by_name
       FROM credit_debit_notes n
       JOIN suppliers s ON s.id = n.supplier_id
       LEFT JOIN supplier_invoices i ON i.id = n.invoice_id
       LEFT JOIN grns g ON g.id = n.grn_id
       LEFT JOIN users u ON u.id = n.created_by
      WHERE n.company_id = $1
        AND ($2 = '' OR n.status = $2)
        AND ($3 = '' OR n.note_type = $3)
      ORDER BY n.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? ''), String(req.query.type ?? '')])));

/** Raise one by hand — a rate correction, damage found later, a tax fix. */
costingRouter.post('/notes', requires('finance.invoice.match'), h(async (req) => {
  const input = body(z.object({
    supplierId: z.string().uuid(),
    branchId: z.string().uuid(),
    noteType: z.enum(['CREDIT', 'DEBIT']),
    reasonCode: z.enum(['QC_REJECTION', 'SHORT_SUPPLY', 'RATE_DIFFERENCE',
      'WEIGHT_SHORTAGE', 'DAMAGE', 'TAX_CORRECTION', 'OTHER']),
    invoiceId: z.string().uuid().nullable().optional(),
    grnId: z.string().uuid().nullable().optional(),
    amount: z.coerce.number().positive('How much is being claimed?'),
    taxAmount: z.coerce.number().nonnegative().default(0),
    remarks: z.string().trim().min(4, 'Say what this is for'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    if (input.invoiceId) {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM supplier_invoices WHERE id=$1 AND company_id=$2 AND supplier_id=$3`,
        [input.invoiceId, req.actor.companyId, input.supplierId]);
      if (!rowCount) throw ApiError.badRequest('That invoice does not belong to this supplier.');
    }
    const noteNo = await nextDocNo(tx, req.actor, input.branchId,
      input.noteType === 'DEBIT' ? 'DN' : 'CN');
    const total = money(input.amount + input.taxAmount);
    const { rows } = await tx.query(
      `INSERT INTO credit_debit_notes (company_id, branch_id, note_no, note_type, supplier_id,
             invoice_id, grn_id, reason_code, amount, tax_amount, total, status,
             auto_drafted, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',false,$12,$13,$13) RETURNING *`,
      [req.actor.companyId, input.branchId, noteNo, input.noteType, input.supplierId,
       input.invoiceId ?? null, input.grnId ?? null, input.reasonCode, money(input.amount),
       money(input.taxAmount), total, input.remarks, req.actor.userId]);
    await emit(tx, req.actor, 'credit_debit_note', rows[0].id, 'note.drafted',
      { noteNo, type: input.noteType, total });
    return rows[0];
  });
}));

/**
 * Move a note along. Settling is the only step that touches money: it adjusts
 * what we still owe on the linked invoice, in the direction the note's type
 * dictates — which is why a note with no invoice cannot be settled.
 */
costingRouter.post('/notes/:id/:action', requires('finance.invoice.match'), h(async (req) => {
  const action = String(req.params.action).toUpperCase();
  const target = ({ ISSUE: 'ISSUED', ACCEPT: 'ACCEPTED', SETTLE: 'SETTLED', CANCEL: 'CANCELLED' } as any)[action];
  if (!target) throw ApiError.notFound('No such action');

  const input = body(z.object({
    reason: z.string().trim().optional(),
  }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM credit_debit_notes WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const n = rows[0];
    if (!n) throw ApiError.notFound('Note not found');

    const allowed = NOTE_FLOW[n.status] ?? [];
    if (!allowed.includes(target)) {
      throw ApiError.rule(
        `A note that is ${n.status.toLowerCase()} cannot be ${action.toLowerCase()}d.`
        + (allowed.length ? ` Allowed: ${allowed.join(', ').toLowerCase()}.` : ''));
    }
    if (target === 'CANCELLED' && !input.reason) {
      throw ApiError.rule('Say why this note is being cancelled.');
    }

    await tx.query(
      `UPDATE credit_debit_notes SET status=$2, updated_by=$3,
              remarks = CASE WHEN $4::text IS NULL THEN remarks
                             ELSE remarks || ' · ' || $4 END
        WHERE id=$1`,
      [n.id, target, req.actor.userId, input.reason ?? null]);

    let balanceAfter: number | null = null;
    if (target === 'SETTLED') {
      if (!n.invoice_id) {
        throw ApiError.rule(
          'This note is not linked to an invoice, so there is nothing to settle it against.');
      }
      // DEBIT claws money back; CREDIT gives it. Never below zero — a note
      // bigger than the balance settles the balance, not into a negative.
      const delta = n.note_type === 'DEBIT' ? -Number(n.total) : Number(n.total);
      const { rows: ps } = await tx.query(
        `UPDATE payment_status
            SET balance = GREATEST(balance + $2, 0), last_synced_at = now()
          WHERE invoice_id = $1 RETURNING balance`,
        [n.invoice_id, delta]);
      if (!ps.length) {
        throw ApiError.rule('That invoice is not payable yet, so it has no balance to adjust.');
      }
      balanceAfter = Number(ps[0].balance);
    }

    await emit(tx, req.actor, 'credit_debit_note', n.id, `note.${target.toLowerCase()}`,
      { noteNo: n.note_no, type: n.note_type, total: n.total, balanceAfter });

    return { ok: true, status: target, noteNo: n.note_no, balanceAfter };
  });
}));
