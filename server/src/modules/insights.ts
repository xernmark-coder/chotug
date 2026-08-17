import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';
import { emit } from '../platform/services.js';
import { supplierScore, round } from '../domain/index.js';
import { assistantAnswer, forecastDemand, priceSignal } from '../ai/features.js';

export const insightsRouter = Router();
insightsRouter.use(authenticate);
// Outside supplier logins never reach staff data — see staffOnly().
insightsRouter.use(staffOnly);

/* ===========================================================================
 * §5.3 — THE WORK QUEUE. This is the home screen for every role. One list,
 * already filtered to what this person is allowed to act on, sorted so the
 * thing that is late or broken is at the top.
 * ======================================================================== */
insightsRouter.get('/work-queue', h(async (req) => {
  const perms = [...req.actor.permissions];
  const isOwner = req.actor.permissions.has('admin.override');
  return query(req.actor,
    `SELECT q.id, q.queue_key, q.doc_type, q.doc_id, q.doc_no, q.title, q.subtitle,
            q.severity, q.sla_due_at, q.payload, q.created_at,
            (q.sla_due_at IS NOT NULL AND q.sla_due_at < now()) AS sla_breached,
            EXTRACT(EPOCH FROM (now() - q.created_at))/60 AS age_minutes,
            b.name AS branch_name, w.name AS warehouse_name
       FROM work_queue q
       JOIN branches b ON b.id = q.branch_id
       LEFT JOIN warehouses w ON w.id = q.warehouse_id
      WHERE q.company_id = $1 AND q.resolved_at IS NULL
        AND ($2 OR q.required_permission = ANY($3::text[]))
        AND ($4::uuid IS NULL OR q.branch_id = $4)
      ORDER BY (q.sla_due_at IS NOT NULL AND q.sla_due_at < now()) DESC,
               CASE q.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
               q.created_at
      LIMIT 100`,
    [req.actor.companyId, isOwner, perms, req.query.branchId ?? null]);
}));

/* ===========================================================================
 * §21 — Dashboard. Every number here is a link to the list behind it.
 * ======================================================================== */
insightsRouter.get('/dashboard', h(async (req) => {
  const branchId = (req.query.branchId as string) || null;

  const [kpis] = await query(req.actor,
    `SELECT
       (SELECT count(*) FROM requirements r
         WHERE r.company_id=$1 AND r.status IN ('DRAFT','SUBMITTED')
           AND ($2::uuid IS NULL OR r.branch_id=$2))                        AS open_requirements,
       (SELECT count(*) FROM purchase_orders o
         WHERE o.company_id=$1 AND o.status IN ('DRAFT','SUBMITTED')
           AND ($2::uuid IS NULL OR o.branch_id=$2))                        AS pending_pos,
       (SELECT count(*) FROM approvals a
         WHERE a.company_id=$1 AND a.status='PENDING'
           AND ($2::uuid IS NULL OR a.branch_id=$2))                        AS pending_approvals,
       (SELECT count(*) FROM approvals a
         WHERE a.company_id=$1 AND a.status='PENDING' AND a.sla_due_at < now()
           AND ($2::uuid IS NULL OR a.branch_id=$2))                        AS overdue_approvals,
       (SELECT count(*) FROM expected_arrivals e
         WHERE e.company_id=$1 AND e.status='EXPECTED' AND e.expected_date <= CURRENT_DATE
           AND ($2::uuid IS NULL OR e.branch_id=$2))                        AS arrivals_today,
       (SELECT count(*) FROM gate_entries g
         WHERE g.company_id=$1 AND g.status IN ('ARRIVED','WEIGHED')
           AND ($2::uuid IS NULL OR g.branch_id=$2))                        AS awaiting_weighment,
       (SELECT count(*) FROM gate_entries g
         WHERE g.company_id=$1 AND g.status='QC_PENDING'
           AND ($2::uuid IS NULL OR g.branch_id=$2))                        AS awaiting_qc,
       (SELECT count(*) FROM gate_entries g
         WHERE g.company_id=$1 AND g.status IN ('QC_COMPLETE','GRN_PENDING')
           AND ($2::uuid IS NULL OR g.branch_id=$2))                        AS awaiting_grn,
       (SELECT count(*) FROM putaway_tasks t
         WHERE t.company_id=$1 AND t.status IN ('PENDING','IN_PROGRESS'))   AS awaiting_putaway,
       (SELECT count(*) FROM supplier_invoices i
         WHERE i.company_id=$1 AND i.status IN ('PENDING','MISMATCH','HOLD')
           AND ($2::uuid IS NULL OR i.branch_id=$2))                        AS invoices_to_match,
       (SELECT COALESCE(SUM(g.total_value),0) FROM grns g
         WHERE g.company_id=$1 AND g.status='POSTED' AND g.posting_date = CURRENT_DATE
           AND ($2::uuid IS NULL OR g.branch_id=$2))                        AS purchase_value_today,
       (SELECT COALESCE(SUM(g.total_value),0) FROM grns g
         WHERE g.company_id=$1 AND g.status='POSTED'
           AND g.posting_date >= date_trunc('month', CURRENT_DATE)
           AND ($2::uuid IS NULL OR g.branch_id=$2))                        AS purchase_value_mtd,
       (SELECT COALESCE(SUM(ps.balance),0) FROM payment_status ps
         WHERE ps.company_id=$1)                                            AS outstanding_payable,
       (SELECT COALESCE(SUM(ps.balance),0) FROM payment_status ps
         WHERE ps.company_id=$1 AND ps.due_date < CURRENT_DATE AND ps.balance > 0) AS overdue_payable,
       (SELECT count(*) FROM alerts a
         WHERE a.company_id=$1 AND a.status='OPEN' AND a.severity IN ('HIGH','CRITICAL')) AS open_alerts`,
    [req.actor.companyId, branchId]);

  const [quality] = await query(req.actor,
    `SELECT
       COALESCE(round(100.0 * SUM(q.rejected_qty) / NULLIF(SUM(q.received_qty),0), 2), 0) AS rejection_pct_30d,
       COALESCE(round(AVG(q.quality_score), 1), 0)                                        AS avg_quality_score_30d,
       count(*)                                                                            AS inspections_30d
       FROM qc_inspections q
      WHERE q.company_id=$1 AND q.inspected_at >= now() - interval '30 days'
        AND ($2::uuid IS NULL OR q.branch_id=$2)`,
    [req.actor.companyId, branchId]);

  const criticalStock = await query(req.actor,
    `SELECT p.id, p.sku, p.name, p.reorder_point, p.min_stock, p.purchase_uom,
            COALESCE(sb.qty,0) AS current_stock,
            COALESCE(ds.avg_daily,0) AS avg_daily_sale,
            CASE WHEN COALESCE(ds.avg_daily,0) > 0
                 THEN round(COALESCE(sb.qty,0)/ds.avg_daily, 1) END AS days_of_cover
       FROM products p
       LEFT JOIN (SELECT sb.product_id, SUM(sb.qty) qty FROM stock_balances sb
                   JOIN warehouses w ON w.id = sb.warehouse_id
                  WHERE ($2::uuid IS NULL OR w.branch_id = $2) GROUP BY sb.product_id) sb
              ON sb.product_id = p.id
       LEFT JOIN (SELECT product_id, AVG(daily) avg_daily FROM
                    (SELECT product_id, signal_date, SUM(qty) daily FROM demand_signals
                      WHERE signal_type='SALE' AND signal_date >= CURRENT_DATE - 28
                        AND ($2::uuid IS NULL OR branch_id = $2)
                      GROUP BY product_id, signal_date) d GROUP BY product_id) ds
              ON ds.product_id = p.id
      WHERE p.company_id=$1 AND p.is_active
        AND COALESCE(sb.qty,0) <= COALESCE(p.reorder_point, p.min_stock, 0)
      ORDER BY days_of_cover NULLS FIRST LIMIT 12`,
    [req.actor.companyId, branchId]);

  const trend = await query(req.actor,
    `SELECT g.posting_date::text AS date,
            SUM(g.total_value)         AS value,
            SUM(g.total_accepted_qty)  AS accepted_qty,
            SUM(g.total_rejected_qty)  AS rejected_qty
       FROM grns g
      WHERE g.company_id=$1 AND g.status='POSTED'
        AND g.posting_date >= CURRENT_DATE - 29
        AND ($2::uuid IS NULL OR g.branch_id=$2)
      GROUP BY g.posting_date ORDER BY g.posting_date`,
    [req.actor.companyId, branchId]);

  const topSuppliers = await query(req.actor,
    `SELECT s.id, s.trade_name AS name, s.source_type, s.performance_score, s.trust_score,
            COALESCE(SUM(g.total_value),0) AS value_30d,
            count(g.id) AS receipts_30d
       FROM suppliers s
       LEFT JOIN grns g ON g.supplier_id = s.id AND g.status='POSTED'
                       AND g.posting_date >= CURRENT_DATE - 30
      WHERE s.company_id=$1
      GROUP BY s.id HAVING COALESCE(SUM(g.total_value),0) > 0
      ORDER BY value_30d DESC LIMIT 8`,
    [req.actor.companyId]);

  /* Where the money actually goes. Four source types, which is exactly the
   * categorical palette's width — a fifth would fold into "Other". */
  const sourceMix = await query(req.actor,
    `SELECT s.source_type, COALESCE(SUM(g.total_value),0) AS value_30d, count(g.id) AS receipts_30d
       FROM grns g JOIN suppliers s ON s.id = g.supplier_id
      WHERE g.company_id=$1 AND g.status='POSTED'
        AND g.posting_date >= CURRENT_DATE - 30
        AND ($2::uuid IS NULL OR g.branch_id=$2)
      GROUP BY s.source_type ORDER BY value_30d DESC`,
    [req.actor.companyId, branchId]);

  /* The same window, one window back. A number with no comparison is a number
   * nobody can act on. */
  const [prev] = await query(req.actor,
    `SELECT
       COALESCE(SUM(g.total_value) FILTER (
         WHERE g.posting_date >= CURRENT_DATE - 29), 0)                       AS value_30d,
       COALESCE(SUM(g.total_value) FILTER (
         WHERE g.posting_date >= CURRENT_DATE - 59
           AND g.posting_date <  CURRENT_DATE - 29), 0)                       AS value_prev_30d,
       COALESCE(SUM(g.total_rejected_qty) FILTER (
         WHERE g.posting_date >= CURRENT_DATE - 29), 0)                       AS rejected_30d,
       COALESCE(SUM(g.total_accepted_qty) FILTER (
         WHERE g.posting_date >= CURRENT_DATE - 29), 0)                       AS accepted_30d
       FROM grns g
      WHERE g.company_id=$1 AND g.status='POSTED'
        AND g.posting_date >= CURRENT_DATE - 59
        AND ($2::uuid IS NULL OR g.branch_id=$2)`,
    [req.actor.companyId, branchId]);

  return { kpis, quality, criticalStock, trend, topSuppliers, sourceMix, prev };
}));

/* ===========================================================================
 * §19 — Alerts.
 * ======================================================================== */
insightsRouter.get('/alerts', h(async (req) =>
  query(req.actor,
    `SELECT a.*, u.full_name AS acked_by_name
       FROM alerts a LEFT JOIN users u ON u.id = a.acked_by
      WHERE a.company_id=$1
        AND a.status = COALESCE(NULLIF($2,''), a.status)
        AND ($3 = '' OR a.severity = $3)
      ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                               WHEN 'MEDIUM' THEN 2 ELSE 3 END,
               a.created_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? 'OPEN'), String(req.query.severity ?? '')])));

insightsRouter.post('/alerts/:id/ack', h(async (req) => {
  const input = body(z.object({
    action: z.enum(['ACK', 'RESOLVE', 'SNOOZE']),
    note: z.string().optional(),
    snoozeMinutes: z.number().int().positive().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const set = input.action === 'ACK'
      ? `status='ACK', acked_by=$2, acked_at=now()`
      : input.action === 'RESOLVE'
      ? `status='RESOLVED', resolved_by=$2, resolved_at=now()`
      : `status='SNOOZED', snoozed_until = now() + ($3 || ' minutes')::interval, snooze_reason=$4`;
    const { rows } = await tx.query(
      `UPDATE alerts SET ${set} WHERE id=$1 AND company_id=$5 RETURNING *`,
      input.action === 'SNOOZE'
        ? [req.params.id, req.actor.userId, String(input.snoozeMinutes ?? 60), input.note ?? null, req.actor.companyId]
        : [req.params.id, req.actor.userId, null, null, req.actor.companyId]);
    if (!rows[0]) throw ApiError.notFound('Alert not found');
    return rows[0];
  });
}));

/* ===========================================================================
 * §7 / §24 — Supplier performance. Recomputed on demand and nightly.
 * ======================================================================== */
insightsRouter.get('/supplier-performance', requires('reports.supplier.view'), h(async (req) =>
  query(req.actor,
    `SELECT s.id, s.code, s.legal_name, s.trade_name, s.source_type, s.status,
            s.trust_score, s.performance_score, s.scores_updated_at,
            sc.order_count, sc.on_time_pct, sc.fill_rate_pct, sc.rejection_pct,
            sc.weight_variance_pct, sc.quality_score_avg, sc.doc_compliance_pct,
            sc.period_start, sc.period_end, sc.breakdown,
            COALESCE(g.value_90d, 0) AS value_90d, COALESCE(g.receipts_90d, 0) AS receipts_90d
       FROM suppliers s
       LEFT JOIN LATERAL (SELECT * FROM supplier_scores x
                           WHERE x.supplier_id = s.id AND x.product_id IS NULL
                           ORDER BY period_end DESC LIMIT 1) sc ON true
       LEFT JOIN LATERAL (SELECT SUM(total_value) value_90d, count(*) receipts_90d
                            FROM grns WHERE supplier_id = s.id AND status='POSTED'
                             AND posting_date >= CURRENT_DATE - 90) g ON true
      WHERE s.company_id=$1
      ORDER BY s.performance_score DESC NULLS LAST, s.legal_name`,
    [req.actor.companyId])));

insightsRouter.post('/supplier-performance/recompute', requires('reports.supplier.view'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT s.id, s.legal_name,
              count(DISTINCT g.id)                                              AS order_count,
              COALESCE(AVG(CASE WHEN g.posting_date <= o.expected_date THEN 100 ELSE 0 END), 0) AS on_time_pct,
              COALESCE(round(100.0 * SUM(gl.accepted_qty) / NULLIF(SUM(pl.qty),0), 2), 0)       AS fill_rate_pct,
              COALESCE(round(100.0 * SUM(gl.rejected_qty) / NULLIF(SUM(gl.received_qty),0), 2), 0) AS rejection_pct,
              COALESCE(AVG(ABS(w.variance_pct)), 0)                             AS weight_variance_pct,
              COALESCE(AVG(q.quality_score), 0)                                 AS quality_score_avg,
              COALESCE(AVG(CASE WHEN ge.eway_bill_no IS NOT NULL THEN 100 ELSE 60 END), 0) AS doc_compliance_pct
         FROM suppliers s
         LEFT JOIN grns g       ON g.supplier_id = s.id AND g.status='POSTED'
                               AND g.posting_date >= CURRENT_DATE - 90
         LEFT JOIN grn_lines gl ON gl.grn_id = g.id
         LEFT JOIN po_lines pl  ON pl.id = gl.po_line_id
         LEFT JOIN purchase_orders o ON o.id = g.po_id
         LEFT JOIN gate_entries ge   ON ge.id = g.gate_entry_id
         LEFT JOIN weighments w      ON w.gate_entry_id = ge.id AND w.variance_pct IS NOT NULL
         LEFT JOIN qc_inspections q  ON q.gate_entry_id = ge.id
        WHERE s.company_id = $1
        GROUP BY s.id`,
      [req.actor.companyId]);

    let updated = 0;
    for (const r of rows) {
      const metrics = {
        onTimePct: Number(r.on_time_pct), fillRatePct: Number(r.fill_rate_pct),
        rejectionPct: Number(r.rejection_pct), weightVariancePct: Number(r.weight_variance_pct),
        docCompliancePct: Number(r.doc_compliance_pct), qualityScoreAvg: Number(r.quality_score_avg),
        orderCount: Number(r.order_count),
      };
      const score = supplierScore(metrics);

      await tx.query(
        `INSERT INTO supplier_scores (company_id, supplier_id, product_id, period_start, period_end,
              order_count, on_time_pct, fill_rate_pct, rejection_pct, weight_variance_pct,
              doc_compliance_pct, quality_score_avg, trust_score, performance_score, breakdown)
         VALUES ($1,$2,NULL, CURRENT_DATE - 90, CURRENT_DATE, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (supplier_id, product_id, period_start, period_end) DO UPDATE SET
              order_count=EXCLUDED.order_count, on_time_pct=EXCLUDED.on_time_pct,
              fill_rate_pct=EXCLUDED.fill_rate_pct, rejection_pct=EXCLUDED.rejection_pct,
              weight_variance_pct=EXCLUDED.weight_variance_pct,
              doc_compliance_pct=EXCLUDED.doc_compliance_pct,
              quality_score_avg=EXCLUDED.quality_score_avg, trust_score=EXCLUDED.trust_score,
              performance_score=EXCLUDED.performance_score, breakdown=EXCLUDED.breakdown,
              computed_at=now()`,
        [req.actor.companyId, r.id, metrics.orderCount, metrics.onTimePct, metrics.fillRatePct,
         metrics.rejectionPct, metrics.weightVariancePct, metrics.docCompliancePct,
         metrics.qualityScoreAvg, score.trustScore, score.performanceScore,
         JSON.stringify({ metrics, confidence: score.confidence })]);

      await tx.query(
        `UPDATE suppliers SET trust_score=$2, performance_score=$3, scores_updated_at=now() WHERE id=$1`,
        [r.id, score.trustScore, score.performanceScore]);
      updated++;
    }
    return { ok: true, updated };
  })));

/* ===========================================================================
 * §21 — Reports.
 * ======================================================================== */
insightsRouter.get('/reports/:key', requires('reports.purchase.view'), h(async (req) => {
  const from = String(req.query.from ?? '') || null;
  const to = String(req.query.to ?? '') || null;
  const branchId = (req.query.branchId as string) || null;
  const p = [req.actor.companyId, from, to, branchId];

  const REPORTS: Record<string, string> = {
    'purchase-register': `
      SELECT g.grn_no, g.posting_date, s.trade_name AS supplier, s.source_type, o.po_no,
             p.sku, p.name AS product, gl.accepted_qty, gl.rejected_qty, gl.uom,
             gl.net_weight_kg, gl.rate, gl.line_value, gl.grade,
             lcl.landed_rate_per_kg
        FROM grns g
        JOIN grn_lines gl ON gl.grn_id = g.id
        JOIN products p ON p.id = gl.product_id
        JOIN suppliers s ON s.id = g.supplier_id
        LEFT JOIN purchase_orders o ON o.id = g.po_id
        LEFT JOIN landing_cost_lines lcl ON lcl.grn_line_id = gl.id
       WHERE g.company_id=$1 AND g.status='POSTED'
         AND ($2::date IS NULL OR g.posting_date >= $2::date)
         AND ($3::date IS NULL OR g.posting_date <= $3::date)
         AND ($4::uuid IS NULL OR g.branch_id = $4)
       ORDER BY g.posting_date DESC, g.grn_no LIMIT 5000`,

    'quality-rejection': `
      SELECT q.inspection_no, q.inspected_at::date AS date, p.name AS product, p.sku,
             s.trade_name AS supplier, q.received_qty, q.accepted_qty, q.rejected_qty,
             q.hold_qty, q.quality_score, q.assigned_grade, q.expected_grade,
             q.rejection_reason_codes, q.critical_failures, u.full_name AS inspector
        FROM qc_inspections q
        JOIN products p ON p.id = q.product_id
        JOIN gate_entries ge ON ge.id = q.gate_entry_id
        JOIN suppliers s ON s.id = ge.supplier_id
        LEFT JOIN users u ON u.id = q.inspector_id
       WHERE q.company_id=$1
         AND ($2::date IS NULL OR q.inspected_at::date >= $2::date)
         AND ($3::date IS NULL OR q.inspected_at::date <= $3::date)
         AND ($4::uuid IS NULL OR q.branch_id = $4)
       ORDER BY q.inspected_at DESC LIMIT 5000`,

    'weight-variance': `
      SELECT ge.gate_no, ge.vehicle_reg_captured, ge.arrived_at::date AS date,
             s.trade_name AS supplier, o.po_no, w.kind, w.gross_kg, w.tare_kg, w.net_kg,
             w.expected_kg, w.variance_kg, w.variance_pct, w.variance_band,
             w.capture_mode, u.full_name AS weighed_by
        FROM weighments w
        JOIN gate_entries ge ON ge.id = w.gate_entry_id
        JOIN suppliers s ON s.id = ge.supplier_id
        LEFT JOIN purchase_orders o ON o.id = ge.po_id
        LEFT JOIN users u ON u.id = w.weighed_by
       WHERE w.company_id=$1 AND w.net_kg IS NOT NULL
         AND ($2::date IS NULL OR w.weighed_at::date >= $2::date)
         AND ($3::date IS NULL OR w.weighed_at::date <= $3::date)
         AND ($4::uuid IS NULL OR w.branch_id = $4)
       ORDER BY ABS(w.variance_pct) DESC NULLS LAST LIMIT 5000`,

    'landing-cost': `
      SELECT g.grn_no, g.posting_date, s.trade_name AS supplier, p.name AS product, p.sku,
             l.accepted_qty, l.accepted_weight_kg, l.base_rate, l.base_value,
             l.allocated_total, l.wastage_amount, l.landed_value,
             l.landed_rate_per_uom, l.landed_rate_per_kg, l.prev_landed_rate, l.rate_change_pct,
             l.allocated_charges
        FROM landing_cost_lines l
        JOIN landing_costs lc ON lc.id = l.landing_cost_id
        JOIN grns g ON g.id = lc.grn_id
        JOIN products p ON p.id = l.product_id
        JOIN suppliers s ON s.id = g.supplier_id
       WHERE lc.company_id=$1 AND lc.cost_status='ACTUAL'
         AND ($2::date IS NULL OR g.posting_date >= $2::date)
         AND ($3::date IS NULL OR g.posting_date <= $3::date)
         AND ($4::uuid IS NULL OR g.branch_id = $4)
       ORDER BY g.posting_date DESC LIMIT 5000`,

    'pending-po': `
      SELECT o.po_no, o.order_date, o.expected_date, o.status, s.trade_name AS supplier,
             p.name AS product, pl.qty AS ordered, pl.received_qty, pl.accepted_qty,
             (pl.qty - pl.received_qty) AS balance_qty, pl.rate, pl.line_status,
             (CURRENT_DATE - o.expected_date) AS days_overdue
        FROM purchase_orders o
        JOIN po_lines pl ON pl.po_id = o.id
        JOIN products p ON p.id = pl.product_id
        JOIN suppliers s ON s.id = o.supplier_id
       WHERE o.company_id=$1 AND o.status IN ('APPROVED','CONFIRMED','PART_RECEIVED')
         AND pl.line_status IN ('OPEN','PART_RECEIVED')
         AND ($2::date IS NULL OR o.order_date >= $2::date)
         AND ($3::date IS NULL OR o.order_date <= $3::date)
         AND ($4::uuid IS NULL OR o.branch_id = $4)
       ORDER BY (CURRENT_DATE - o.expected_date) DESC LIMIT 5000`,

    'stock-position': `
      SELECT v.sku, v.product_name, v.batch_no, v.grade, v.qty, v.weight_kg,
             v.available_qty, v.effective_expiry, v.days_to_expiry, v.landed_rate, v.status
        FROM v_stock_position v
       WHERE v.company_id=$1
         -- Stock is a position, not a period: the date range reads as
         -- "what expires between these dates", which is the question a
         -- warehouse actually asks of this report.
         AND ($2::date IS NULL OR v.effective_expiry >= $2::date)
         AND ($3::date IS NULL OR v.effective_expiry <= $3::date)
         AND ($4::uuid IS NULL OR v.warehouse_id IN
              (SELECT w.id FROM warehouses w WHERE w.branch_id = $4))
       ORDER BY v.days_to_expiry NULLS LAST, v.product_name LIMIT 5000`,

    'ai-acceptance': `
      SELECT feature_key, week, runs, accepted, overridden, fallbacks,
             acceptance_pct, avg_confidence, avg_latency_ms
        FROM v_ai_acceptance WHERE company_id=$1 ORDER BY week DESC, feature_key LIMIT 500`,
  };

  const sql = REPORTS[req.params.key];
  if (!sql) throw ApiError.notFound(`Unknown report "${req.params.key}"`);
  // Not every report takes a date range or a branch. Pass only as many
  // parameters as the query actually references, so a report that ignores the
  // filters cannot fail with "bind message supplies 4 parameters".
  const maxParam = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const rows = await query(req.actor, sql, p.slice(0, maxParam));
  return { key: req.params.key, count: rows.length, rows };
}));

/* ===========================================================================
 * AI endpoints exposed to the UI.
 * ======================================================================== */
insightsRouter.post('/ai/assistant', h(async (req) => {
  const input = body(z.object({
    question: z.string().min(3, 'Ask a question'),
    branchId: z.string().uuid().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    // The context is assembled under the caller's own permissions, so the
    // assistant physically cannot answer a cost question for someone who is
    // not allowed to see cost.
    const canSeeCost = req.actor.permissions.has('data.cost.view')
      || req.actor.permissions.has('admin.override');

    const { rows: ctx } = await tx.query(
      `SELECT
        (SELECT json_agg(x) FROM (
           SELECT p.name, p.sku, COALESCE(sb.qty,0) AS stock, p.reorder_point, p.purchase_uom
             FROM products p
             LEFT JOIN (SELECT product_id, SUM(qty) qty FROM stock_balances GROUP BY product_id) sb
                    ON sb.product_id = p.id
            WHERE p.company_id=$1 AND p.is_active ORDER BY p.name LIMIT 40) x) AS products,
        (SELECT json_agg(x) FROM (
           SELECT o.po_no, o.status, o.expected_date, s.trade_name AS supplier
                  ${canSeeCost ? ', o.grand_total' : ''}
             FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
            WHERE o.company_id=$1 AND o.status NOT IN ('CLOSED','CANCELLED')
            ORDER BY o.created_at DESC LIMIT 20) x) AS open_orders,
        (SELECT json_agg(x) FROM (
           SELECT g.gate_no, g.status, g.vehicle_reg_captured, s.trade_name AS supplier
             FROM gate_entries g JOIN suppliers s ON s.id = g.supplier_id
            WHERE g.company_id=$1 AND g.status NOT IN ('COMPLETED','CANCELLED','REJECTED_AT_GATE')
            LIMIT 20) x) AS at_gate,
        (SELECT json_agg(x) FROM (
           SELECT a.title, a.severity, a.created_at FROM alerts a
            WHERE a.company_id=$1 AND a.status='OPEN'
            ORDER BY a.created_at DESC LIMIT 15) x) AS open_alerts`,
      [req.actor.companyId]);

    return assistantAnswer(tx, req.actor, {
      question: input.question, branchId: input.branchId ?? req.actor.branchId,
      context: ctx[0],
    });
  });
}));

insightsRouter.get('/ai/forecast/:productId', h(async (req) => {
  const branchId = String(req.query.branchId ?? req.actor.branchId ?? '');
  if (!branchId) throw ApiError.badRequest('Choose a branch');
  return withTx(req.actor, (tx) =>
    forecastDemand(tx, req.actor, {
      branchId, productId: req.params.productId,
      horizonDays: Number(req.query.days ?? 7),
    }));
}));

insightsRouter.get('/ai/price-signal/:productId', h(async (req) => {
  const branchId = String(req.query.branchId ?? req.actor.branchId ?? '');
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(`SELECT name FROM products WHERE id=$1`, [req.params.productId]);
    if (!rows[0]) throw ApiError.notFound('Product not found');
    return priceSignal(tx, req.actor, {
      productId: req.params.productId, productName: rows[0].name, branchId,
    });
  });
}));

insightsRouter.get('/ai/runs', h(async (req) =>
  query(req.actor,
    `SELECT r.id, r.feature_key, r.model_name, r.confidence, r.used_fallback, r.fallback_reason,
            r.accepted, r.latency_ms, r.created_at, r.output, r.reason,
            u.full_name AS accepted_by_name
       FROM ai_runs r LEFT JOIN users u ON u.id = r.accepted_by
      WHERE r.company_id=$1 AND ($2 = '' OR r.feature_key = $2)
      ORDER BY r.created_at DESC LIMIT 100`,
    [req.actor.companyId, String(req.query.featureKey ?? '')])));

insightsRouter.get('/ai/features', h(async (req) =>
  query(req.actor,
    `SELECT feature_key, is_enabled, fallback_mode, min_confidence, updated_at
       FROM ai_feature_flags WHERE company_id=$1 ORDER BY feature_key`,
    [req.actor.companyId])));

insightsRouter.put('/ai/features/:key', requires('ai.feature.manage'), h(async (req) => {
  const input = body(z.object({
    isEnabled: z.boolean(),
    minConfidence: z.number().min(0).max(1).optional(),
  }), req.body);
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE ai_feature_flags SET is_enabled=$3,
              min_confidence=COALESCE($4, min_confidence), updated_by=$5, updated_at=now()
        WHERE company_id=$1 AND feature_key=$2 RETURNING *`,
      [req.actor.companyId, req.params.key, input.isEnabled,
       input.minConfidence ?? null, req.actor.userId]);
    if (!rows[0]) throw ApiError.notFound('Unknown AI feature');
    await emit(tx, req.actor, 'ai_feature', rows[0].id, 'ai.feature.toggled',
      { key: req.params.key, enabled: input.isEnabled });
    return rows[0];
  });
}));

/** Stock position with expiry risk — used by the warehouse panel. */
insightsRouter.get('/stock', h(async (req) =>
  query(req.actor,
    `SELECT * FROM v_stock_position
      WHERE company_id=$1 AND ($2::uuid IS NULL OR warehouse_id=$2)
      ORDER BY days_to_expiry NULLS LAST, product_name LIMIT 500`,
    [req.actor.companyId, req.query.warehouseId ?? null])));
