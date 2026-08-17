import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import {
  emit, getSetting, nextDocNo, pushTask, raiseAlert, requestApprovals, resolveTask,
} from '../platform/services.js';
import {
  assertTransition, money, quoteLandedRate, recommendedQty, round,
} from '../domain/index.js';
import { buySuggestion, forecastDemand, priceSignal } from '../ai/features.js';

export const planningRouter = Router();
planningRouter.use(authenticate);

/** Money the way an approver reads it, for messages and queue subtitles. */
const inrText = (n: number) =>
  `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/* ===========================================================================
 * §2 / §5 — "System khud bataye ki kya aur kitna kharidna hai."
 *
 * This endpoint is the top of the whole module: it looks at stock, sales,
 * open orders, min/max and forecast, and produces a ranked buy list. Nothing
 * is committed — the executive reviews and converts what they agree with.
 * ======================================================================== */
planningRouter.get('/requirement-note', h(async (req) => {
  const branchId = String(req.query.branchId ?? req.actor.branchId ?? '');
  if (!branchId) throw ApiError.badRequest('Choose a branch first');

  const rows = await query(req.actor,
    `SELECT p.id AS product_id, p.sku, p.name, p.name_hi, p.base_uom, p.purchase_uom,
            p.min_stock, p.max_stock, p.reorder_point, p.safety_stock_days,
            p.lead_time_days, p.moq, p.order_multiple, p.default_wastage_pct,
            p.is_perishable, p.shelf_life_days,
            COALESCE(sb.qty, 0)          AS current_stock,
            COALESCE(sb.reserved, 0)     AS reserved_qty,
            COALESCE(po.open_qty, 0)     AS open_po_qty,
            COALESCE(ds.avg_daily, 0)    AS avg_daily_sale,
            COALESCE(ds.std_dev, 0)      AS demand_std_dev,
            COALESCE(adv.qty, 0)         AS advance_order_qty,
            lp.last_rate
       FROM products p
       LEFT JOIN (
            SELECT sb.product_id, SUM(sb.qty) qty, SUM(sb.reserved_qty) reserved
              FROM stock_balances sb
              JOIN warehouses w ON w.id = sb.warehouse_id
             WHERE w.branch_id = $2 GROUP BY sb.product_id) sb ON sb.product_id = p.id
       LEFT JOIN (
            SELECT pl.product_id, SUM(pl.qty - pl.received_qty) open_qty
              FROM po_lines pl JOIN purchase_orders o ON o.id = pl.po_id
             WHERE o.branch_id = $2 AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED')
               AND pl.line_status IN ('OPEN','PART_RECEIVED')
             GROUP BY pl.product_id) po ON po.product_id = p.id
       LEFT JOIN (
            SELECT product_id,
                   AVG(daily) AS avg_daily,
                   COALESCE(STDDEV_SAMP(daily), 0) AS std_dev
              FROM (SELECT product_id, signal_date, SUM(qty) daily
                      FROM demand_signals
                     WHERE branch_id = $2 AND signal_type IN ('SALE','BRANCH_INDENT')
                       AND signal_date >= CURRENT_DATE - 28
                     GROUP BY product_id, signal_date) d
             GROUP BY product_id) ds ON ds.product_id = p.id
       LEFT JOIN (
            SELECT product_id, SUM(qty) qty FROM demand_signals
             WHERE branch_id = $2 AND signal_type = 'ADVANCE_ORDER'
               AND signal_date >= CURRENT_DATE
             GROUP BY product_id) adv ON adv.product_id = p.id
       LEFT JOIN LATERAL (
            SELECT pl.rate AS last_rate FROM po_lines pl
              JOIN purchase_orders o ON o.id = pl.po_id
             WHERE pl.product_id = p.id AND o.status <> 'CANCELLED'
             ORDER BY o.order_date DESC LIMIT 1) lp ON true
      WHERE p.company_id = $1 AND p.is_active
      ORDER BY p.name`,
    [req.actor.companyId, branchId]);

  const serviceLevelZ = Number(await withTx(req.actor, (tx) =>
    getSetting(tx, req.actor, 'planning.service_level_z', 1.65)));

  const items = rows.map((r: any) => {
    const plan = recommendedQty({
      currentStock: Number(r.current_stock),
      reservedQty: Number(r.reserved_qty),
      openPoQty: Number(r.open_po_qty),
      avgDailySale: Number(r.avg_daily_sale),
      demandStdDev: Number(r.demand_std_dev),
      leadTimeDays: Number(r.lead_time_days ?? 1),
      safetyStockDays: Number(r.safety_stock_days ?? 1),
      serviceLevelZ,
      minStock: r.min_stock, maxStock: r.max_stock,
      moq: r.moq, orderMultiple: r.order_multiple,
      wastagePct: Number(r.default_wastage_pct ?? 0),
      advanceOrderQty: Number(r.advance_order_qty),
    });

    // Why this row appeared at all — drives the "source" tag on the requirement.
    const triggers: string[] = [];
    if (r.reorder_point && Number(r.current_stock) <= Number(r.reorder_point)) triggers.push('LOW_STOCK');
    if (r.min_stock && Number(r.current_stock) < Number(r.min_stock)) triggers.push('MIN_MAX');
    if (Number(r.advance_order_qty) > 0) triggers.push('ADVANCE_ORDER');
    if (Number(r.avg_daily_sale) > 0 && plan.daysOfCover < Number(r.lead_time_days ?? 1)) triggers.push('SALES_DEMAND');

    const urgency =
      plan.daysOfCover <= 0 ? 'URGENT'
      : plan.daysOfCover < Number(r.lead_time_days ?? 1) ? 'HIGH'
      : plan.suggestedQty > 0 ? 'NORMAL' : 'LOW';

    return {
      productId: r.product_id, sku: r.sku, name: r.name, nameHi: r.name_hi,
      uom: r.purchase_uom, baseUom: r.base_uom,
      currentStock: Number(r.current_stock), availableStock: plan.availableStock,
      reservedQty: Number(r.reserved_qty), openPoQty: Number(r.open_po_qty),
      avgDailySale: Number(r.avg_daily_sale), leadTimeDays: Number(r.lead_time_days ?? 1),
      minStock: r.min_stock, maxStock: r.max_stock,
      advanceOrderQty: Number(r.advance_order_qty),
      lastRate: r.last_rate,
      suggestedQty: plan.suggestedQty, daysOfCover: plan.daysOfCover,
      safetyStock: plan.safetyStock, reasons: plan.reasons,
      triggers, urgency, source: triggers[0] ?? 'MANUAL',
    };
  });

  const rank = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;
  items.sort((a, b) =>
    rank[a.urgency as keyof typeof rank] - rank[b.urgency as keyof typeof rank] ||
    b.suggestedQty - a.suggestedQty);

  return {
    branchId,
    generatedAt: new Date().toISOString(),
    needsBuying: items.filter((i) => i.suggestedQty > 0).length,
    items,
  };
}));

/** Per-product deep dive: forecast curve + AI narrative + mandi price signal. */
planningRouter.get('/insight/:productId', h(async (req) => {
  const branchId = String(req.query.branchId ?? req.actor.branchId ?? '');
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT p.*, COALESCE(sb.qty,0) AS current_stock
         FROM products p
         LEFT JOIN (SELECT sb.product_id, SUM(sb.qty) qty FROM stock_balances sb
                     JOIN warehouses w ON w.id = sb.warehouse_id
                    WHERE w.branch_id = $3 GROUP BY sb.product_id) sb ON sb.product_id = p.id
        WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.productId, req.actor.companyId, branchId]);
    const p = rows[0];
    if (!p) throw ApiError.notFound('Product not found');

    const forecast = await forecastDemand(tx, req.actor, { branchId, productId: p.id, horizonDays: 7 });

    const { rows: openPo } = await tx.query(
      `SELECT COALESCE(SUM(pl.qty - pl.received_qty),0) q
         FROM po_lines pl JOIN purchase_orders o ON o.id = pl.po_id
        WHERE pl.product_id = $1 AND o.branch_id = $2
          AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED')`,
      [p.id, branchId]);

    const price = await priceSignal(tx, req.actor, { productId: p.id, productName: p.name, branchId });

    const suggestion = await buySuggestion(tx, req.actor, {
      branchId, productId: p.id, productName: p.name,
      marketNote: price.recommendation ?? undefined,
      planning: {
        currentStock: Number(p.current_stock),
        openPoQty: Number(openPo[0].q),
        avgDailySale: forecast.avgDaily,
        demandStdDev: forecast.stdDev,
        leadTimeDays: Number(p.lead_time_days ?? 1),
        safetyStockDays: Number(p.safety_stock_days ?? 1),
        minStock: p.min_stock, maxStock: p.max_stock,
        moq: p.moq, orderMultiple: p.order_multiple,
        wastagePct: Number(p.default_wastage_pct ?? 0),
      },
    });

    return {
      product: { id: p.id, sku: p.sku, name: p.name, uom: p.purchase_uom,
        currentStock: Number(p.current_stock), shelfLifeDays: p.shelf_life_days },
      forecast, price, suggestion,
    };
  });
}));

/* ===========================================================================
 * Requirements (§5)
 * ======================================================================== */
const RequirementLineIn = z.object({
  productId: z.string().uuid(),
  uom: z.string().min(1),
  finalQty: z.number().positive('Quantity must be more than zero'),
  suggestedQty: z.number().nullable().optional(),
  suggestedBy: z.enum(['RULE', 'AI', 'NONE']).default('NONE'),
  suggestionReason: z.any().optional(),
  aiRunId: z.string().uuid().nullable().optional(),
  aiConfidence: z.number().nullable().optional(),
  editReason: z.string().nullable().optional(),
  currentStock: z.number().optional(),
  availableStock: z.number().optional(),
  openPoQty: z.number().optional(),
  avgDailySale: z.number().optional(),
  leadTimeDays: z.number().optional(),
  minStock: z.number().nullable().optional(),
  maxStock: z.number().nullable().optional(),
  advanceOrderQty: z.number().optional(),
  remarks: z.string().optional(),
});

planningRouter.post('/requirements', requires('purchase.requirement.create'), h(async (req) => {
  const input = body(z.object({
    branchId: z.string().uuid(),
    warehouseId: z.string().uuid().nullable().optional(),
    requiredDate: z.string(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    source: z.enum(['MANUAL', 'LOW_STOCK', 'MIN_MAX', 'SALES_DEMAND', 'BRANCH_DEMAND',
      'WAREHOUSE_DEMAND', 'PENDING_ORDER', 'ADVANCE_ORDER', 'SEASONAL', 'AI_FORECAST',
      'SAFETY_STOCK']).default('MANUAL'),
    remarks: z.string().optional(),
    lines: z.array(RequirementLineIn).min(1, 'Add at least one product'),
  }), req.body);

  // §5 — overriding a suggestion without saying why is not allowed.
  for (const l of input.lines) {
    if (l.suggestedQty != null && l.finalQty !== l.suggestedQty && !l.editReason) {
      throw ApiError.rule(
        `You changed the suggested quantity for one product. Please give a short reason.`,
        { productId: l.productId });
    }
  }

  return withTx(req.actor, async (tx) => {
    const reqNo = await nextDocNo(tx, req.actor, input.branchId, 'REQ');
    const { rows } = await tx.query(
      `INSERT INTO requirements (company_id, branch_id, warehouse_id, req_no, required_date,
                                 priority, source, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.actor.companyId, input.branchId, input.warehouseId ?? null, reqNo,
       input.requiredDate, input.priority, input.source, input.remarks ?? null, req.actor.userId]);
    const requirement = rows[0];

    // Duplicate warning (§5): another open requirement for the same product.
    for (const [idx, l] of input.lines.entries()) {
      const { rows: dup } = await tx.query(
        `SELECT r.req_no, rl.final_qty FROM requirement_lines rl
           JOIN requirements r ON r.id = rl.requirement_id
          WHERE rl.product_id = $1 AND r.branch_id = $2
            AND r.status IN ('DRAFT','SUBMITTED','APPROVED')
            AND r.id <> $3 LIMIT 3`,
        [l.productId, input.branchId, requirement.id]);

      await tx.query(
        `INSERT INTO requirement_lines
           (company_id, requirement_id, line_no, product_id, uom,
            current_stock, available_stock, open_po_qty, avg_daily_sale, lead_time_days,
            min_stock, max_stock, suggested_qty, suggested_by, suggestion_reason,
            ai_run_id, ai_confidence, final_qty, edit_reason, duplicate_warning,
            advance_order_qty, remarks, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
        [req.actor.companyId, requirement.id, idx + 1, l.productId, l.uom,
         l.currentStock ?? null, l.availableStock ?? null, l.openPoQty ?? null,
         l.avgDailySale ?? null, l.leadTimeDays ?? null, l.minStock ?? null, l.maxStock ?? null,
         l.suggestedQty ?? null, l.suggestedBy, JSON.stringify(l.suggestionReason ?? null),
         l.aiRunId ?? null, l.aiConfidence ?? null, l.finalQty, l.editReason ?? null,
         dup.length ? JSON.stringify({ openRequirements: dup }) : null,
         l.advanceOrderQty ?? 0, l.remarks ?? null, req.actor.userId]);

      // Close the AI feedback loop (§14.6) — did the human take the advice?
      if (l.aiRunId) {
        await tx.query(
          `UPDATE ai_runs SET accepted = $2, accepted_by = $3, accepted_at = now(),
                  override_value = $4, feedback_note = $5
            WHERE id = $1`,
          [l.aiRunId, l.suggestedQty != null && l.finalQty === l.suggestedQty,
           req.actor.userId, JSON.stringify({ finalQty: l.finalQty }), l.editReason ?? null]);
      }
    }

    await emit(tx, req.actor, 'requirement', requirement.id, 'requirement.created',
      { reqNo, lines: input.lines.length });
    return { ...requirement, lineCount: input.lines.length };
  });
}));

planningRouter.get('/requirements', h(async (req) =>
  query(req.actor,
    `SELECT r.id, r.req_no, r.req_date, r.required_date, r.priority, r.source, r.status,
            r.remarks, b.name AS branch_name,
            (SELECT count(*) FROM requirement_lines l WHERE l.requirement_id = r.id) AS line_count,
            (SELECT COALESCE(SUM(l.final_qty),0) FROM requirement_lines l WHERE l.requirement_id = r.id) AS total_qty,
            u.full_name AS created_by_name
       FROM requirements r
       JOIN branches b ON b.id = r.branch_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.company_id = $1
        AND ($2 = '' OR r.status = $2)
        AND ($3::uuid IS NULL OR r.branch_id = $3)
      ORDER BY r.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? ''), req.query.branchId ?? null])));

planningRouter.get('/requirements/:id', h(async (req) => {
  const [r] = await query(req.actor,
    `SELECT r.*, b.name AS branch_name, u.full_name AS created_by_name
       FROM requirements r JOIN branches b ON b.id = r.branch_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1 AND r.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!r) throw ApiError.notFound('Requirement not found');
  const lines = await query(req.actor,
    `SELECT l.*, p.sku, p.name AS product_name, p.name_hi AS product_name_hi
       FROM requirement_lines l JOIN products p ON p.id = l.product_id
      WHERE l.requirement_id = $1 ORDER BY l.line_no`, [req.params.id]);
  return { ...r, lines };
}));

planningRouter.post('/requirements/:id/submit', requires('purchase.requirement.submit'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM requirements WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const r = rows[0];
    if (!r) throw ApiError.notFound('Requirement not found');
    assertTransition('REQUIREMENT', r.status, 'SUBMITTED');

    await tx.query(
      `UPDATE requirements SET status='SUBMITTED', submitted_at=now(), submitted_by=$2, updated_by=$2
        WHERE id=$1`, [r.id, req.actor.userId]);

    /* A requirement used to stop here forever: no approval was ever raised, so
     * it never reached APPROVED — and the PO step only marks a requirement
     * CONVERTED `WHERE status='APPROVED'`, so that never fired either. Run it
     * through the same authority check as a PO. */
    /* A requirement carries no rate — it says what is needed, not what it will
     * cost. To weigh it against a value threshold we price each line at the
     * best evidence available, newest first: the last agreed PO rate, then the
     * last landed cost, then today's market price. A line we cannot price
     * contributes nothing rather than blocking the submit. */
    const { rows: est } = await tx.query(
      `SELECT count(*)::int AS lines,
              COALESCE(SUM(rl.final_qty * COALESCE(
                (SELECT pl.rate FROM po_lines pl
                   JOIN purchase_orders o ON o.id = pl.po_id
                  WHERE pl.product_id = rl.product_id AND o.company_id = $2
                    AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED','RECEIVED','CLOSED')
                  ORDER BY o.order_date DESC LIMIT 1),
                (SELECT b.landed_rate FROM batches b
                  WHERE b.product_id = rl.product_id AND b.landed_rate IS NOT NULL
                  ORDER BY b.received_date DESC LIMIT 1),
                (SELECT mp.modal_price FROM market_prices mp
                  WHERE mp.product_id = rl.product_id
                  ORDER BY mp.price_date DESC LIMIT 1),
                0)), 0) AS value
         FROM requirement_lines rl WHERE rl.requirement_id = $1`,
      [r.id, req.actor.companyId]);
    const value = Number(est[0].value);

    const { level, triggers, reasons, selfApproved, wouldHaveNeededLevel } =
      await requestApprovals(tx, req.actor,
        {
          docType: 'REQUIREMENT', docId: r.id, docNo: r.req_no, branchId: r.branch_id,
          subject: `${est[0].lines} item(s), about ${inrText(value)}`,
        },
        { value, urgent: r.priority === 'URGENT' });

    if (level === 0) {
      await tx.query(
        `UPDATE requirements
            SET status='APPROVED', approved_at=now(), approved_by=$2,
                self_approved=true, self_approved_reason=$3, updated_by=$2
          WHERE id=$1`,
        [r.id, req.actor.userId, selfApproved
          ? `Approved on own authority; rules fired: ${reasons.join('; ')}`
          : 'No approval rule applied — within every configured threshold.']);
      // Approved means sourceable, so the next person's job goes on the queue.
      await pushTask(tx, req.actor, {
        branchId: r.branch_id, queueKey: 'REQUIREMENT_REVIEW',
        docType: 'REQUIREMENT', docId: r.id, docNo: r.req_no,
        title: `Source ${est[0].lines} item(s) for ${r.req_no}`,
        subtitle: `About ${inrText(value)} · needed by ${r.required_date}`,
        severity: r.priority === 'URGENT' ? 'critical' : 'normal',
        requiredPermission: 'purchase.quote.compare', slaMinutes: 240,
      });
      await emit(tx, req.actor, 'requirement', r.id, 'requirement.approved',
        { reqNo: r.req_no, auto: true, selfApproved, value });
      return {
        ok: true, status: 'APPROVED', approvalLevel: 0, selfApproved,
        message: selfApproved
          ? `Approved on your own authority — ready to source.`
          : 'Within the normal limits — approved and ready to source.',
      };
    }

    await emit(tx, req.actor, 'requirement', r.id, 'requirement.submitted',
      { reqNo: r.req_no, level, triggers, reasons });
    return {
      ok: true, status: 'SUBMITTED', approvalLevel: level, triggers, reasons,
      message: `Sent for level ${level} approval — ${reasons.join('; ')}.`,
    };
  })));

/* ===========================================================================
 * §7 — Source comparison. Landed cost, quality and reliability, not rate.
 * ======================================================================== */
planningRouter.post('/quotes', requires('purchase.quote.compare'), h(async (req) => {
  const input = body(z.object({
    requirementLineId: z.string().uuid().nullable().optional(),
    productId: z.string().uuid(),
    quotes: z.array(z.object({
      supplierId: z.string().uuid(),
      sourceType: z.enum(['FARMER', 'MANDI', 'AADHTI', 'WHOLESALER']),
      quotedRate: z.number().nonnegative(),
      uom: z.string(),
      availableQty: z.number().nonnegative().optional(),
      offeredGrade: z.string().optional(),
      paymentTermsDays: z.number().int().min(0).default(0),
      charges: z.object({
        commission: z.number().optional(), transport: z.number().optional(),
        loading: z.number().optional(), packing: z.number().optional(),
      }).optional(),
      qtyKg: z.number().positive().optional(),
    })).min(1),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const out: any[] = [];
    for (const q of input.quotes) {
      const { rows: hist } = await tx.query(
        `SELECT s.legal_name, s.trade_name, s.status, s.trust_score, s.performance_score,
                sc.rejection_pct, sc.on_time_pct, sc.weight_variance_pct, sc.quality_score_avg,
                (SELECT count(*) FROM purchase_orders o WHERE o.supplier_id = s.id) AS order_count
           FROM suppliers s
           LEFT JOIN LATERAL (SELECT * FROM supplier_scores x WHERE x.supplier_id = s.id
                               AND x.product_id IS NULL ORDER BY period_end DESC LIMIT 1) sc ON true
          WHERE s.id = $1 AND s.company_id = $2`, [q.supplierId, req.actor.companyId]);
      const s = hist[0];
      if (!s) throw ApiError.badRequest('Unknown supplier in the comparison');
      if (s.status === 'BLOCKED') throw ApiError.rule(`${s.legal_name} is blocked and cannot be selected.`);

      const landed = quoteLandedRate({
        quotedRate: q.quotedRate, charges: q.charges,
        expectedRejectionPct: Number(s.rejection_pct ?? 3),
        expectedShortagePct: Number(Math.abs(s.weight_variance_pct ?? 1)),
        paymentTermsDays: q.paymentTermsDays, qtyKg: q.qtyKg,
      });

      const { rows: ins } = await tx.query(
        `INSERT INTO supplier_quotes
           (company_id, requirement_line_id, supplier_id, source_type, product_id, quoted_rate,
            uom, available_qty, offered_grade, payment_terms_days, charges,
            computed_landed_rate, expected_rejection_pct, expected_shortage_pct,
            quality_score_hist, on_time_pct_hist, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         RETURNING id`,
        [req.actor.companyId, input.requirementLineId ?? null, q.supplierId, q.sourceType,
         input.productId, q.quotedRate, q.uom, q.availableQty ?? null, q.offeredGrade ?? null,
         q.paymentTermsDays, JSON.stringify(q.charges ?? {}), landed.landedRate,
         s.rejection_pct ?? null, s.weight_variance_pct ?? null,
         s.quality_score_avg ?? null, s.on_time_pct ?? null, req.actor.userId]);

      out.push({
        quoteId: ins[0].id, supplierId: q.supplierId,
        supplierName: s.trade_name ?? s.legal_name, supplierStatus: s.status,
        sourceType: q.sourceType, quotedRate: q.quotedRate,
        landedRate: landed.landedRate, breakdown: landed.breakdown,
        trustScore: s.trust_score, performanceScore: s.performance_score,
        rejectionPct: s.rejection_pct, onTimePct: s.on_time_pct,
        weightVariancePct: s.weight_variance_pct, orderCount: Number(s.order_count),
        isNewSupplier: Number(s.order_count) === 0,
        paymentTermsDays: q.paymentTermsDays,
      });
    }

    out.sort((a, b) => a.landedRate - b.landedRate);
    out.forEach((o, i) => { o.rank = i + 1; });
    const best = out[0];
    const cheapestByRate = [...out].sort((a, b) => a.quotedRate - b.quotedRate)[0];

    return {
      quotes: out,
      recommendation: {
        quoteId: best.quoteId, supplierName: best.supplierName,
        note: best.quoteId === cheapestByRate.quoteId
          ? `${best.supplierName} is both the lowest rate and the lowest landed cost.`
          : `${best.supplierName} has a higher headline rate than ${cheapestByRate.supplierName} ` +
            `but a lower landed cost of ₹${round(best.landedRate, 2)}/unit after charges, rejection and credit.`,
      },
    };
  });
}));

/* ===========================================================================
 * §8 / §9 — Purchase order and the approval engine.
 * ======================================================================== */
planningRouter.post('/purchase-orders', requires('purchase.po.create'), h(async (req) => {
  const input = body(z.object({
    branchId: z.string().uuid(),
    warehouseId: z.string().uuid().nullable().optional(),
    docType: z.enum(['PO', 'INDENT']).default('PO'),
    requirementId: z.string().uuid().nullable().optional(),
    supplierId: z.string().uuid(),
    sourceType: z.enum(['FARMER', 'MANDI', 'AADHTI', 'WHOLESALER']),
    mandiId: z.string().uuid().nullable().optional(),
    expectedDate: z.string(),
    deliveryLocation: z.string().optional(),
    transportBy: z.enum(['SUPPLIER', 'BUYER', 'THIRD_PARTY']).default('SUPPLIER'),
    paymentTermsDays: z.number().int().min(0).default(0),
    isUrgent: z.boolean().default(false),
    remarks: z.string().optional(),
    lines: z.array(z.object({
      productId: z.string().uuid(),
      requirementLineId: z.string().uuid().nullable().optional(),
      qty: z.number().positive(),
      uom: z.string(),
      rate: z.number().nonnegative(),
      expectedWeightKg: z.number().nonnegative().nullable().optional(),
      expectedGrade: z.string().optional(),
      discountPct: z.number().min(0).max(100).default(0),
    })).min(1, 'Add at least one line'),
    charges: z.array(z.object({
      chargeTypeId: z.string().uuid(),
      amount: z.number().nonnegative(),
      allocationBasis: z.enum(['VALUE', 'WEIGHT', 'QTY', 'EQUAL', 'MANUAL']),
      borneBy: z.enum(['BUYER', 'SUPPLIER', 'SHARED']).default('BUYER'),
    })).default([]),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: sup } = await tx.query(
      `SELECT s.*, (SELECT count(*) FROM purchase_orders o
                     WHERE o.supplier_id = s.id AND o.status <> 'CANCELLED') AS order_count
         FROM suppliers s WHERE s.id = $1 AND s.company_id = $2`,
      [input.supplierId, req.actor.companyId]);
    const supplier = sup[0];
    if (!supplier) throw ApiError.badRequest('Supplier not found');
    if (supplier.status === 'BLOCKED') throw ApiError.rule(`${supplier.legal_name} is blocked. Choose another source.`);
    if (supplier.status === 'ON_HOLD' && !req.actor.permissions.has('admin.override')) {
      throw ApiError.rule(`${supplier.legal_name} is on hold. A manager must release them first.`);
    }

    // Rate variance vs the last purchase of the same product (§9 trigger).
    let maxRateVariance = 0;
    for (const l of input.lines) {
      const { rows: last } = await tx.query(
        `SELECT pl.rate FROM po_lines pl JOIN purchase_orders o ON o.id = pl.po_id
          WHERE pl.product_id = $1 AND o.company_id = $2 AND o.status IN ('APPROVED','CONFIRMED','RECEIVED','PART_RECEIVED')
          ORDER BY o.order_date DESC LIMIT 1`, [l.productId, req.actor.companyId]);
      const prev = last[0]?.rate;
      if (prev && Number(prev) > 0) {
        maxRateVariance = Math.max(maxRateVariance, Math.abs((l.rate - Number(prev)) / Number(prev)) * 100);
      }
    }

    const subtotal = money(input.lines.reduce(
      (a, l) => a + l.qty * l.rate * (1 - l.discountPct / 100), 0));
    const chargeTotal = money(input.charges
      .filter((c) => c.borneBy !== 'SUPPLIER')
      .reduce((a, c) => a + c.amount, 0));
    const grandTotal = money(subtotal + chargeTotal);

    const poNo = await nextDocNo(tx, req.actor, input.branchId, input.docType === 'INDENT' ? 'IND' : 'PO');

    const { rows } = await tx.query(
      `INSERT INTO purchase_orders
         (company_id, branch_id, warehouse_id, po_no, doc_type, requirement_id, supplier_id,
          source_type, mandi_id, expected_date, delivery_location, transport_by,
          payment_terms_days, subtotal, charge_total, grand_total, estimated_landed_total,
          is_urgent, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$19)
       RETURNING *`,
      [req.actor.companyId, input.branchId, input.warehouseId ?? null, poNo, input.docType,
       input.requirementId ?? null, input.supplierId, input.sourceType, input.mandiId ?? null,
       input.expectedDate, input.deliveryLocation ?? null, input.transportBy,
       input.paymentTermsDays, subtotal, chargeTotal, grandTotal,
       input.isUrgent, input.remarks ?? null, req.actor.userId]);
    const po = rows[0];

    for (const [i, l] of input.lines.entries()) {
      const lineTotal = money(l.qty * l.rate * (1 - l.discountPct / 100));
      await tx.query(
        `INSERT INTO po_lines (company_id, po_id, line_no, requirement_line_id, product_id,
            qty, uom, qty_in_base, expected_weight_kg, rate, discount_pct, line_total,
            expected_grade, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12,$13,$13)`,
        [req.actor.companyId, po.id, i + 1, l.requirementLineId ?? null, l.productId,
         l.qty, l.uom, l.expectedWeightKg ?? null, l.rate, l.discountPct, lineTotal,
         l.expectedGrade ?? null, req.actor.userId]);

      if (l.requirementLineId) {
        await tx.query(
          `UPDATE requirement_lines
              SET converted_qty = converted_qty + $2,
                  line_status = CASE WHEN converted_qty + $2 >= final_qty THEN 'CONVERTED'
                                     ELSE 'PART_CONVERTED' END
            WHERE id = $1`, [l.requirementLineId, l.qty]);
      }
    }

    for (const c of input.charges) {
      await tx.query(
        `INSERT INTO po_charges (company_id, po_id, charge_type_id, amount, allocation_basis, borne_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.actor.companyId, po.id, c.chargeTypeId, c.amount, c.allocationBasis, c.borneBy, req.actor.userId]);
    }

    if (input.requirementId) {
      await tx.query(
        `UPDATE requirements SET status = 'CONVERTED', updated_by = $2
          WHERE id = $1 AND status = 'APPROVED'`, [input.requirementId, req.actor.userId]);
      await resolveTask(tx, req.actor, 'REQUIREMENT_REVIEW', 'REQUIREMENT', input.requirementId);
    }

    await emit(tx, req.actor, 'purchase_order', po.id, 'po.created',
      { poNo, grandTotal, supplierId: input.supplierId });

    return { ...po, rateVariancePct: round(maxRateVariance, 3), lineCount: input.lines.length };
  });
}));

planningRouter.get('/purchase-orders', h(async (req) =>
  query(req.actor,
    `SELECT o.id, o.po_no, o.doc_type, o.order_date, o.expected_date, o.status, o.source_type,
            o.grand_total, o.is_urgent, o.revision_no,
            s.trade_name AS supplier_name, s.legal_name AS supplier_legal_name,
            b.name AS branch_name,
            pr.received_qty, pr.ordered_qty, pr.fill_pct,
            (SELECT count(*) FROM approvals a
              WHERE a.doc_id = o.id AND a.doc_type='PO' AND a.status='PENDING') AS pending_approvals
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
       JOIN branches  b ON b.id = o.branch_id
       LEFT JOIN v_po_progress pr ON pr.po_id = o.id
      WHERE o.company_id = $1
        AND ($2 = '' OR o.status = $2)
        AND ($3 = '' OR o.source_type = $3)
      ORDER BY o.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? ''), String(req.query.sourceType ?? '')])));

planningRouter.get('/purchase-orders/:id', h(async (req) => {
  const [po] = await query(req.actor,
    `SELECT o.*, s.trade_name AS supplier_name, s.legal_name AS supplier_legal_name,
            s.source_type AS supplier_source_type, s.phone AS supplier_phone,
            s.trust_score, s.performance_score, b.name AS branch_name,
            u.full_name AS created_by_name, ua.full_name AS approved_by_name
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
       JOIN branches  b ON b.id = o.branch_id
       LEFT JOIN users u  ON u.id  = o.created_by
       LEFT JOIN users ua ON ua.id = o.approved_by
      WHERE o.id = $1 AND o.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!po) throw ApiError.notFound('Purchase order not found');

  const [lines, charges, approvals, revisions] = await Promise.all([
    query(req.actor,
      `SELECT l.*, p.sku, p.name AS product_name, p.is_variable_weight
         FROM po_lines l JOIN products p ON p.id = l.product_id
        WHERE l.po_id = $1 ORDER BY l.line_no`, [po.id]),
    query(req.actor,
      `SELECT c.*, ct.code, ct.name FROM po_charges c
         JOIN charge_types ct ON ct.id = c.charge_type_id WHERE c.po_id = $1`, [po.id]),
    query(req.actor,
      `SELECT a.*, u.full_name AS approver_name, ur.full_name AS requester_name
         FROM approvals a
         LEFT JOIN users u  ON u.id  = a.approver_id
         LEFT JOIN users ur ON ur.id = a.requested_by
        WHERE a.doc_id = $1 AND a.doc_type = 'PO' ORDER BY a.requested_at DESC`, [po.id]),
    query(req.actor,
      `SELECT r.*, u.full_name AS changed_by_name FROM po_revisions r
         LEFT JOIN users u ON u.id = r.changed_by
        WHERE r.po_id = $1 ORDER BY r.revision_no DESC`, [po.id]),
  ]);

  return { ...po, lines, charges, approvals, revisions };
}));

/**
 * An approved order is not a placed order — this panel is internal, and the
 * supplier learns nothing until somebody calls them. Queue that call, so an
 * order raised and then abandoned is picked up by whoever is free rather than
 * sitting in APPROVED where nobody is looking.
 */
async function pushPoConfirmTask(tx: any, actor: any, poId: string) {
  const { rows } = await tx.query(
    `SELECT o.id, o.po_no, o.branch_id, o.expected_date, o.is_urgent, o.grand_total,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name, s.phone
       FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.id = $1`, [poId]);
  const po = rows[0];
  if (!po) return;
  await pushTask(tx, actor, {
    branchId: po.branch_id,
    queueKey: 'PO_CONFIRM', docType: 'PO', docId: po.id, docNo: po.po_no,
    title: `Confirm ${po.po_no} with ${po.supplier_name}`,
    subtitle: `${inrText(Number(po.grand_total))} · expected ${po.expected_date}`
      + (po.phone ? ` · ${po.phone}` : ''),
    severity: po.is_urgent ? 'warn' : 'normal',
    requiredPermission: 'purchase.po.submit',
    slaMinutes: po.is_urgent ? 120 : 480,
  });
}

planningRouter.post('/purchase-orders/:id/submit', requires('purchase.po.submit'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT o.*, (SELECT count(*) FROM purchase_orders x
                     WHERE x.supplier_id = o.supplier_id AND x.status NOT IN ('DRAFT','CANCELLED')
                       AND x.id <> o.id) AS prior_orders
         FROM purchase_orders o WHERE o.id = $1 AND o.company_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const po = rows[0];
    if (!po) throw ApiError.notFound('Purchase order not found');
    assertTransition('PO', po.status, 'SUBMITTED');

    let maxRateVariance = 0;
    const { rows: lines } = await tx.query(
      `SELECT product_id, rate FROM po_lines WHERE po_id = $1`, [po.id]);
    for (const l of lines) {
      const { rows: last } = await tx.query(
        `SELECT pl.rate FROM po_lines pl JOIN purchase_orders o ON o.id = pl.po_id
          WHERE pl.product_id = $1 AND o.company_id = $2 AND o.id <> $3
            AND o.status IN ('APPROVED','CONFIRMED','RECEIVED','PART_RECEIVED')
          ORDER BY o.order_date DESC LIMIT 1`, [l.product_id, req.actor.companyId, po.id]);
      const prev = last[0]?.rate;
      if (prev && Number(prev) > 0) {
        maxRateVariance = Math.max(maxRateVariance, Math.abs((Number(l.rate) - Number(prev)) / Number(prev)) * 100);
      }
    }

    await tx.query(
      `UPDATE purchase_orders SET status='SUBMITTED', submitted_at=now(), submitted_by=$2, updated_by=$2
        WHERE id=$1`, [po.id, req.actor.userId]);

    // §9 — requestApprovals now settles the maker-checker question itself: it
    // returns level 0 when the submitter already outranks every rule that
    // fired, so an Owner (and a manager inside their own limit) is not left
    // waiting on a queue that only they can clear.
    const { rows: sup } = await tx.query(
      `SELECT COALESCE(trade_name, legal_name) AS name FROM suppliers WHERE id=$1`,
      [po.supplier_id]);
    const { level, triggers, reasons, selfApproved, wouldHaveNeededLevel } =
      await requestApprovals(tx, req.actor,
        {
          docType: 'PO', docId: po.id, docNo: po.po_no, branchId: po.branch_id,
          subject: `${inrText(Number(po.grand_total))} for ${sup[0]?.name ?? 'supplier'}`,
        },
        {
          value: Number(po.grand_total),
          rateVariancePct: round(maxRateVariance, 3),
          newSupplier: Number(po.prior_orders) === 0,
          urgent: po.is_urgent,
        });

    if (level === 0) {
      /* Every level-0 path approves the order in the submitter's own name, so
       * approved_by = submitted_by and ck_po_maker_checker applies to all of
       * them — including "no rule fired at all", which had been violating the
       * constraint since the beginning and made a small PO impossible to
       * submit. The constraint permits it when the row says so and gives a
       * reason, so record which of the three cases this was. */
      const selfReason = !selfApproved
        ? 'No approval rule applied — the order is within every configured threshold.'
        : req.actor.permissions.has('admin.override')
        ? `Owner authority; rules fired: ${reasons.join('; ')}`
        : `Level ${req.actor.limits.maxApprovalLevel} authority covers the level `
          + `${wouldHaveNeededLevel} required; rules fired: ${reasons.join('; ')}`;

      await tx.query(
        `UPDATE purchase_orders
            SET status='APPROVED', approved_at=now(), approved_by=$2,
                self_approved=true, self_approved_reason=$3, updated_by=$2
          WHERE id=$1`,
        [po.id, req.actor.userId, selfReason]);
      await pushPoConfirmTask(tx, req.actor, po.id);
      await emit(tx, req.actor, 'purchase_order', po.id, 'po.approved', {
        poNo: po.po_no, auto: true, selfApproved,
        wouldHaveNeededLevel: wouldHaveNeededLevel ?? 0, reasons,
      });
      return {
        status: 'APPROVED', approvalLevel: 0, triggers, reasons, selfApproved,
        message: !selfApproved
          ? 'Within the normal limits — approved automatically.'
          : req.actor.permissions.has('admin.override')
          ? `Approved on your own authority as Owner (${reasons.join('; ')}).`
          : `Approved on your own authority — this needed level ${wouldHaveNeededLevel} `
            + `and you hold level ${req.actor.limits.maxApprovalLevel} (${reasons.join('; ')}).`,
      };
    }

    await emit(tx, req.actor, 'purchase_order', po.id, 'po.submitted',
      { poNo: po.po_no, level, triggers, reasons });
    return { status: 'SUBMITTED', approvalLevel: level, triggers, reasons, selfApproved: false,
      message: `This is above your authority, so it has gone for level ${level} approval — `
        + `${reasons.join('; ')}.` };
  })));

/* ===========================================================================
 * Approval queue (§9) — three decisions only: Approve / Hold / Reject.
 * ======================================================================== */
planningRouter.get('/approvals', h(async (req) =>
  query(req.actor,
    `SELECT a.*, u.full_name AS requester_name, b.name AS branch_name,
            CASE a.doc_type
              WHEN 'PO' THEN (SELECT json_build_object('total', o.grand_total,
                                     'supplier', s.trade_name, 'lines',
                                     (SELECT count(*) FROM po_lines pl WHERE pl.po_id = o.id))
                                FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
                               WHERE o.id = a.doc_id)
              ELSE NULL END AS doc_summary,
            EXTRACT(EPOCH FROM (now() - a.requested_at))/60 AS age_minutes,
            (a.sla_due_at < now()) AS sla_breached
       FROM approvals a
       JOIN users u ON u.id = a.requested_by
       JOIN branches b ON b.id = a.branch_id
      WHERE a.company_id = $1 AND a.status = COALESCE(NULLIF($2,''), 'PENDING')
      ORDER BY (a.sla_due_at < now()) DESC, a.level DESC, a.requested_at`,
    [req.actor.companyId, String(req.query.status ?? '')])));

planningRouter.post('/approvals/:id/decide', h(async (req) => {
  const input = body(z.object({
    decision: z.enum(['APPROVE', 'HOLD', 'REJECT']),
    reasonCode: z.string().optional(),
    reasonText: z.string().optional(),
  }), req.body);

  if (input.decision !== 'APPROVE' && !input.reasonText) {
    throw ApiError.rule('Please give a reason when holding or rejecting.');
  }

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM approvals WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const a = rows[0];
    if (!a) throw ApiError.notFound('Approval request not found');
    if (a.status !== 'PENDING') throw ApiError.conflict('This request has already been decided.');
    if (a.requested_by === req.actor.userId) {
      throw ApiError.rule('You raised this request, so you cannot approve it yourself.');
    }

    const permByDoc: Record<string, string> = {
      PO: 'purchase.po.approve', REQUIREMENT: 'purchase.requirement.approve',
      INVOICE: 'finance.invoice.approve', GRN: 'receiving.grn.submit',
      WEIGHT_VARIANCE: 'receiving.weighment.approve', QC_OVERRIDE: 'quality.inspection.approve',
      GATE_EXCEPTION: 'receiving.exception.approve', GRN_REVERSAL: 'receiving.grn.reverse',
      RATE_REVISION: 'purchase.po.revise', SUPPLIER_STATUS: 'master.supplier.block',
    };
    const needed = permByDoc[a.doc_type] ?? 'admin.override';
    if (!req.actor.permissions.has(needed) && !req.actor.permissions.has('admin.override')) {
      throw ApiError.forbidden('Your role cannot approve this document type.');
    }
    if (a.level > req.actor.limits.maxApprovalLevel && !req.actor.permissions.has('admin.override')) {
      throw ApiError.forbidden(
        `This needs a level ${a.level} approver. Your limit is level ${req.actor.limits.maxApprovalLevel}. It has been escalated.`);
    }

    if (a.doc_type === 'PO' && input.decision === 'APPROVE') {
      const { rows: po } = await tx.query('SELECT grand_total FROM purchase_orders WHERE id = $1', [a.doc_id]);
      const limit = req.actor.limits.maxPoValue;
      if (limit != null && Number(po[0].grand_total) > Number(limit) && !req.actor.permissions.has('admin.override')) {
        throw ApiError.forbidden(
          `This order is ₹${Number(po[0].grand_total).toLocaleString('en-IN')} and your approval limit is ₹${Number(limit).toLocaleString('en-IN')}.`);
      }
    }

    const status = input.decision === 'APPROVE' ? 'APPROVED'
      : input.decision === 'HOLD' ? 'HELD' : 'REJECTED';

    await tx.query(
      `UPDATE approvals SET status=$2, approver_id=$3, decided_at=now(),
              reason_code=$4, reason_text=$5 WHERE id=$1`,
      [a.id, status, req.actor.userId, input.reasonCode ?? null, input.reasonText ?? null]);

    if (a.doc_type === 'PO') {
      if (status === 'APPROVED') {
        const { rows: still } = await tx.query(
          `SELECT count(*)::int c FROM approvals
            WHERE doc_id = $1 AND doc_type='PO' AND status='PENDING'`, [a.doc_id]);
        if (still[0].c === 0) {
          await tx.query(
            `UPDATE purchase_orders SET status='APPROVED', approved_at=now(), approved_by=$2, updated_by=$2
              WHERE id=$1 AND status='SUBMITTED'`, [a.doc_id, req.actor.userId]);
          await pushPoConfirmTask(tx, req.actor, a.doc_id);
          await emit(tx, req.actor, 'purchase_order', a.doc_id, 'po.approved', { docNo: a.doc_no });
        }
      } else if (status === 'REJECTED') {
        await tx.query(
          `UPDATE purchase_orders SET status='DRAFT', updated_by=$2 WHERE id=$1`,
          [a.doc_id, req.actor.userId]);
      }
    }

    await resolveTask(tx, req.actor, 'APPROVAL', a.doc_type, a.doc_id);
    await emit(tx, req.actor, 'approval', a.id, `approval.${status.toLowerCase()}`,
      { docType: a.doc_type, docNo: a.doc_no, reason: input.reasonText });

    return { ok: true, status };
  });
}));

/** §8 — Confirm an approved PO with the supplier and open an arrival slot. */
planningRouter.post('/purchase-orders/:id/confirm', requires('purchase.po.submit'), h(async (req) => {
  const input = body(z.object({
    expectedDate: z.string().optional(),
    windowStart: z.string().nullable().optional(),
    windowEnd: z.string().nullable().optional(),
    vehicleHint: z.string().nullable().optional(),
  }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const po = rows[0];
    if (!po) throw ApiError.notFound('Purchase order not found');
    assertTransition('PO', po.status, 'CONFIRMED');

    await tx.query(
      `UPDATE purchase_orders SET status='CONFIRMED', confirmed_at=now(), updated_by=$2 WHERE id=$1`,
      [po.id, req.actor.userId]);

    const warehouseId = po.warehouse_id ?? (await tx.query(
      `SELECT id FROM warehouses WHERE branch_id=$1 AND is_active LIMIT 1`, [po.branch_id])).rows[0]?.id;
    if (!warehouseId) throw ApiError.badRequest('This branch has no active warehouse to receive into.');

    const { rows: ea } = await tx.query(
      `INSERT INTO expected_arrivals (company_id, branch_id, warehouse_id, po_id, expected_date,
                                      window_start, window_end, vehicle_hint, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [req.actor.companyId, po.branch_id, warehouseId, po.id,
       input.expectedDate ?? po.expected_date, input.windowStart ?? null, input.windowEnd ?? null,
       input.vehicleHint ?? null, req.actor.userId]);

    await pushTask(tx, req.actor, {
      branchId: po.branch_id, warehouseId,
      queueKey: 'EXPECTED_ARRIVAL', docType: 'PO', docId: po.id, docNo: po.po_no,
      title: `${po.po_no} expected`,
      subtitle: `On ${input.expectedDate ?? po.expected_date}`,
      requiredPermission: 'receiving.gate.create',
      payload: { expectedArrivalId: ea[0].id },
    });
    // The call has been made; the job now belongs to the gate.
    await resolveTask(tx, req.actor, 'PO_CONFIRM', 'PO', po.id);
    await emit(tx, req.actor, 'purchase_order', po.id, 'po.confirmed', { poNo: po.po_no });
    return { ok: true, status: 'CONFIRMED', expectedArrivalId: ea[0].id };
  });
}));

/** §8 — Revision with a mandatory reason and a full old/new diff. */
planningRouter.post('/purchase-orders/:id/revise', requires('purchase.po.revise'), h(async (req) => {
  const input = body(z.object({
    reasonText: z.string().min(4, 'Explain why the order is changing'),
    reasonCode: z.string().optional(),
    lines: z.array(z.object({
      lineId: z.string().uuid(), qty: z.number().positive().optional(), rate: z.number().nonnegative().optional(),
    })).min(1),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [req.params.id, req.actor.companyId]);
    const po = rows[0];
    if (!po) throw ApiError.notFound('Purchase order not found');
    if (['RECEIVED', 'CLOSED', 'CANCELLED'].includes(po.status)) {
      throw ApiError.rule('A closed or fully received order cannot be revised.');
    }

    const diff: any[] = [];
    for (const l of input.lines) {
      const { rows: cur } = await tx.query(
        `SELECT * FROM po_lines WHERE id=$1 AND po_id=$2 FOR UPDATE`, [l.lineId, po.id]);
      const line = cur[0];
      if (!line) continue;
      if (Number(line.received_qty) > 0 && l.qty != null && l.qty < Number(line.received_qty)) {
        throw ApiError.rule('You cannot reduce a line below what has already been received.');
      }
      const newQty = l.qty ?? Number(line.qty);
      const newRate = l.rate ?? Number(line.rate);
      diff.push({ lineNo: line.line_no,
        qty: { from: Number(line.qty), to: newQty },
        rate: { from: Number(line.rate), to: newRate } });
      await tx.query(
        `UPDATE po_lines SET qty=$2, qty_in_base=$2, rate=$3,
                line_total=$2*$3*(1-discount_pct/100), updated_by=$4 WHERE id=$1`,
        [l.lineId, newQty, newRate, req.actor.userId]);
    }

    const { rows: tot } = await tx.query(
      `SELECT COALESCE(SUM(line_total),0) s FROM po_lines WHERE po_id=$1`, [po.id]);
    const subtotal = money(Number(tot[0].s));
    const grand = money(subtotal + Number(po.charge_total ?? 0));

    await tx.query(
      `UPDATE purchase_orders SET subtotal=$2, grand_total=$3, revision_no=revision_no+1,
              status = CASE WHEN status IN ('APPROVED','CONFIRMED') THEN 'SUBMITTED' ELSE status END,
              updated_by=$4 WHERE id=$1`,
      [po.id, subtotal, grand, req.actor.userId]);

    await tx.query(
      `INSERT INTO po_revisions (company_id, po_id, revision_no, changed_by, diff, reason_code, reason_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.companyId, po.id, po.revision_no + 1, req.actor.userId,
       JSON.stringify(diff), input.reasonCode ?? 'REVISION', input.reasonText]);

    await requestApprovals(tx, req.actor,
      { docType: 'PO', docId: po.id, docNo: po.po_no, branchId: po.branch_id },
      { value: grand });

    await emit(tx, req.actor, 'purchase_order', po.id, 'po.revised',
      { poNo: po.po_no, revision: po.revision_no + 1 });
    return { ok: true, revisionNo: po.revision_no + 1, grandTotal: grand };
  });
}));

planningRouter.get('/expected-arrivals', h(async (req) =>
  query(req.actor,
    `SELECT e.id, e.expected_date, e.window_start, e.window_end, e.status, e.vehicle_hint,
            o.po_no, o.id AS po_id, o.grand_total, o.source_type,
            s.trade_name AS supplier_name, w.name AS warehouse_name,
            (SELECT count(*) FROM po_lines pl WHERE pl.po_id = o.id) AS line_count,
            (e.expected_date < CURRENT_DATE AND e.status = 'EXPECTED') AS overdue
       FROM expected_arrivals e
       JOIN purchase_orders o ON o.id = e.po_id
       JOIN suppliers s ON s.id = o.supplier_id
       JOIN warehouses w ON w.id = e.warehouse_id
      WHERE e.company_id = $1 AND e.status IN ('EXPECTED','ARRIVED')
      ORDER BY e.expected_date, e.window_start NULLS LAST`,
    [req.actor.companyId])));
