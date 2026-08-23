import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, nextDocNo, pushTask, resolveTask, raiseAlert } from '../platform/services.js';

export const mapRouter = Router();
mapRouter.use(authenticate);

/* ===========================================================================
 * THE WAREHOUSE MAP, AND THE AUDIT TEAM THAT WALKS IT
 *
 *   floor → section → rack → shelf
 *
 * Every one of them carries a printed QR. Scanning any of them answers the same
 * question — "what is here, and what has happened to it" — which is exactly
 * what an auditor standing in front of a shelf needs, and exactly what a picker
 * sent to fetch something needs.
 *
 * Nothing in this module moves stock. An audit reports; correcting the books is
 * a deliberate, separate act by somebody with that right. An audit that quietly
 * rewrote the ledger would be the easiest theft in the building.
 * ======================================================================== */

/* ------------------------------------------------------------- the map ---- */

mapRouter.get('/layout', h(async (req) => {
  const wh = req.query.warehouseId ? String(req.query.warehouseId) : null;

  const [floors, sections, racks, shelves] = await Promise.all([
    query(req.actor,
      `SELECT f.*, w.name AS warehouse_name,
              (SELECT count(*)::int FROM zones z WHERE z.floor_id = f.id) AS sections
         FROM warehouse_floors f JOIN warehouses w ON w.id = f.warehouse_id
        WHERE f.company_id = $1 AND ($2::uuid IS NULL OR f.warehouse_id = $2)
        ORDER BY w.name, f.sort_order, f.code`,
      [req.actor.companyId, wh]),
    query(req.actor,
      `SELECT z.*, w.name AS warehouse_name, f.name AS floor_name,
              (SELECT count(*)::int FROM racks r WHERE r.zone_id = z.id) AS racks
         FROM zones z
         JOIN warehouses w ON w.id = z.warehouse_id
         LEFT JOIN warehouse_floors f ON f.id = z.floor_id
        WHERE z.company_id = $1 AND ($2::uuid IS NULL OR z.warehouse_id = $2)
        ORDER BY w.name, f.sort_order NULLS FIRST, z.code`,
      [req.actor.companyId, wh]),
    query(req.actor,
      `SELECT r.*, z.name AS section_name, z.warehouse_id,
              (SELECT count(*)::int FROM bins b WHERE b.rack_id = r.id) AS shelves
         FROM racks r JOIN zones z ON z.id = r.zone_id
        WHERE r.company_id = $1 AND ($2::uuid IS NULL OR z.warehouse_id = $2)
        ORDER BY z.code, r.code`,
      [req.actor.companyId, wh]),
    query(req.actor,
      `SELECT b.*, r.code AS rack_code, z.name AS section_name, z.warehouse_id,
              COALESCE(c.packs, 0) AS packs, COALESCE(c.qty, 0) AS qty,
              COALESCE(c.weight_kg, 0) AS weight_kg
         FROM bins b
         JOIN racks r ON r.id = b.rack_id
         JOIN zones z ON z.id = r.zone_id
         LEFT JOIN (SELECT bin_id, SUM(packs)::int AS packs, SUM(qty) AS qty,
                           SUM(weight_kg) AS weight_kg
                      FROM v_bin_contents GROUP BY bin_id) c ON c.bin_id = b.id
        WHERE b.company_id = $1 AND ($2::uuid IS NULL OR z.warehouse_id = $2)
        ORDER BY z.code, r.code, b.code`,
      [req.actor.companyId, wh]),
  ]);

  return { floors, sections, racks, shelves };
}));

const upsert = z.object({
  warehouseId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  code: z.string().trim().min(1, 'Give it a short code').max(20),
  name: z.string().trim().max(80).optional(),
  capacityKg: z.coerce.number().nonnegative().optional(),
  /* "Make me shelves 1 to 12 on this rack." Laying out a warehouse one row at
   * a time is how it never gets laid out at all. */
  count: z.coerce.number().int().min(1).max(60).default(1),
});

mapRouter.post('/floors', requires('master.location.manage'), h(async (req) => {
  const i = body(upsert, req.body);
  if (!i.warehouseId) throw ApiError.badRequest('Which warehouse is this floor in?');
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO warehouse_floors (company_id, warehouse_id, code, name, qr_code,
              sort_order, created_by, updated_by)
       VALUES ($1,$2,$3,$4,loc_code('FL'),
               (SELECT COALESCE(MAX(sort_order),0)+1 FROM warehouse_floors WHERE warehouse_id=$2),
               $5,$5)
       RETURNING *`,
      [req.actor.companyId, i.warehouseId, i.code.toUpperCase(), i.name ?? i.code, req.actor.userId]);
    return rows[0];
  });
}));

mapRouter.post('/sections', requires('master.location.manage'), h(async (req) => {
  const i = body(upsert, req.body);
  if (!i.warehouseId) throw ApiError.badRequest('Which warehouse is this section in?');
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO zones (company_id, warehouse_id, floor_id, code, name, storage_type,
              qr_code, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'AMBIENT',loc_code('SE'),$6,$6)
       RETURNING *`,
      [req.actor.companyId, i.warehouseId, i.parentId ?? null,
       i.code.toUpperCase(), i.name ?? i.code, req.actor.userId]);
    return rows[0];
  });
}));

mapRouter.post('/racks', requires('master.location.manage'), h(async (req) => {
  const i = body(upsert, req.body);
  if (!i.parentId) throw ApiError.badRequest('Which section is this rack in?');
  return withTx(req.actor, async (tx) => {
    const made = [];
    for (let n = 0; n < i.count; n++) {
      const code = i.count === 1 ? i.code.toUpperCase() : `${i.code.toUpperCase()}${n + 1}`;
      const { rows } = await tx.query(
        `INSERT INTO racks (company_id, zone_id, code, qr_code, created_by, updated_by)
         VALUES ($1,$2,$3,loc_code('RK'),$4,$4) RETURNING *`,
        [req.actor.companyId, i.parentId, code, req.actor.userId]);
      made.push(rows[0]);
    }
    return { made: made.length, racks: made };
  });
}));

mapRouter.post('/shelves', requires('master.location.manage'), h(async (req) => {
  const i = body(upsert, req.body);
  if (!i.parentId) throw ApiError.badRequest('Which rack is this shelf on?');
  return withTx(req.actor, async (tx) => {
    const made = [];
    for (let n = 0; n < i.count; n++) {
      const code = i.count === 1 ? i.code.toUpperCase() : `${i.code.toUpperCase()}-${n + 1}`;
      const { rows } = await tx.query(
        `INSERT INTO bins (company_id, rack_id, code, capacity_kg, qr_code, created_by, updated_by)
         VALUES ($1,$2,$3,$4,loc_code('SH'),$5,$5) RETURNING *`,
        [req.actor.companyId, i.parentId, code, i.capacityKg ?? null, req.actor.userId]);
      made.push(rows[0]);
    }
    return { made: made.length, shelves: made };
  });
}));

/* --------------------------------------------------------------- the scan -- */

/**
 * One code, one answer. Scan a shelf and you get what is on it; scan a rack and
 * you get its shelves; scan a section and you get its racks.
 *
 * The auditor, the picker and the packer all point their camera at the same
 * sticker and this is what comes back. Building a second lookup for each of
 * them is how the three of them end up disagreeing.
 */
mapRouter.get('/scan/:qr', h(async (req) => {
  const code = String(req.params.qr).trim().toUpperCase();
  const [loc] = await query(req.actor,
    `SELECT * FROM v_locations WHERE company_id = $1 AND upper(qr_code) = $2`,
    [req.actor.companyId, code]);

  if (!loc) {
    /* Somebody may have scanned a pack label instead — an easy mistake with two
     * stickers on one box, and answerable rather than an error. */
    const [pack] = await query(req.actor,
      `SELECT pk.code, pk.grade, pk.qty, pk.uom, pk.status, p.name AS product_name,
              bn.code AS bin_code, bn.qr_code AS bin_qr
         FROM packs pk JOIN products p ON p.id = pk.product_id
         LEFT JOIN bins bn ON bn.id = pk.bin_id
        WHERE pk.company_id = $1 AND upper(pk.code) = $2`,
      [req.actor.companyId, code]);
    if (pack) return { found: true, kind: 'PACK', pack };
    return { found: false, code,
      message: 'Nothing with that code. Check the label, or type the shelf code by hand.' };
  }

  /* What is on it, and what has happened to it. Both, because "6 crates" with
   * no idea when they arrived is not information an auditor can use. */
  const [contents, children, lastAudits] = await Promise.all([
    loc.level === 'SHELF'
      ? query(req.actor,
        /* product_id and batch_id are what the auditor's count is filed
         * against, so they have to come back with the contents — without them
         * the screen can show what is here but not let anybody record it. */
        `SELECT p.id AS product_id, p.name AS product_name, p.sku, p.icon,
                b.id AS batch_id, b.batch_no, pk.grade,
                count(*)::int AS packs, SUM(pk.qty) AS qty, pk.uom,
                SUM(COALESCE(pk.weight_kg,0)) AS weight_kg,
                MIN(pk.stored_at) AS oldest,
                COALESCE(b.predicted_expiry_date, b.expiry_date) AS expiry_date
           FROM packs pk
           JOIN products p ON p.id = pk.product_id
           JOIN batches  b ON b.id = pk.batch_id
          WHERE pk.bin_id = $1 AND pk.status = 'IN_STOCK'
          GROUP BY p.id, p.name, p.sku, p.icon, b.id, b.batch_no, pk.grade, pk.uom,
                   COALESCE(b.predicted_expiry_date, b.expiry_date)
          ORDER BY p.name, pk.grade`, [loc.id])
      : Promise.resolve([]),
    query(req.actor,
      `SELECT level, id, qr_code, code, name FROM v_locations
        WHERE company_id = $1 AND parent_id = $2 AND is_active
        ORDER BY code`, [req.actor.companyId, loc.id]),
    loc.level === 'SHELF'
      ? query(req.actor,
        `SELECT ac.counted_at, ac.counted_qty, ac.expected_qty, ac.variance_qty,
                ac.condition, ac.loss_qty, ac.note,
                p.name AS product_name, u.full_name AS counted_by_name
           FROM audit_counts ac
           JOIN products p ON p.id = ac.product_id
           LEFT JOIN users u ON u.id = ac.counted_by
          WHERE ac.bin_id = $1 ORDER BY ac.counted_at DESC LIMIT 10`, [loc.id])
      : Promise.resolve([]),
  ]);

  return { found: true, kind: 'LOCATION', location: loc, contents, children, lastAudits };
}));

/* ------------------------------------------------------------- the audit -- */

mapRouter.get('/audits', requires('audit.report.view'), h(async (req) =>
  query(req.actor,
    `SELECT t.*, w.name AS warehouse_name, p.name AS product_name,
            ru.full_name AS raised_by_name, au.full_name AS assigned_to_name,
            (SELECT count(*)::int FROM audit_counts c WHERE c.task_id = t.id) AS counts,
            (SELECT COALESCE(SUM(c.loss_qty),0) FROM audit_counts c WHERE c.task_id = t.id) AS loss_qty,
            (SELECT COALESCE(SUM(c.loss_value),0) FROM audit_counts c WHERE c.task_id = t.id) AS loss_value,
            (t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE
             AND t.status IN ('OPEN','IN_PROGRESS')) AS overdue,
            l.path AS scope_path
       FROM audit_tasks t
       LEFT JOIN warehouses w ON w.id = t.warehouse_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN users ru ON ru.id = t.raised_by
       LEFT JOIN users au ON au.id = t.assigned_to
       LEFT JOIN v_locations l ON l.id = t.scope_id
      WHERE t.company_id = $1
        AND ($2 = '' OR t.status = $2)
      ORDER BY CASE t.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END,
               CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                               WHEN 'NORMAL' THEN 2 ELSE 3 END,
               t.due_date NULLS LAST, t.raised_at DESC
      LIMIT 200`,
    [req.actor.companyId, String(req.query.status ?? '')])));

mapRouter.post('/audits', requires('audit.task.raise'), h(async (req) => {
  const i = body(z.object({
    branchId: z.string().uuid().optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    scope: z.enum(['WAREHOUSE', 'FLOOR', 'SECTION', 'RACK', 'SHELF', 'PRODUCT', 'BATCH'])
      .default('WAREHOUSE'),
    scopeId: z.string().uuid().nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(3, 'Why does this need auditing?'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    dueDate: z.string().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const branchId = i.branchId ?? req.actor.branchId;
    if (!branchId) throw ApiError.badRequest('Which branch is this for?');
    const taskNo = await nextDocNo(tx, req.actor, branchId, 'AUD');

    const { rows } = await tx.query(
      `INSERT INTO audit_tasks (company_id, branch_id, warehouse_id, task_no, scope,
              scope_id, product_id, reason, priority, due_date, assigned_to,
              raised_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
      [req.actor.companyId, branchId, i.warehouseId ?? null, taskNo, i.scope,
       i.scopeId ?? null, i.productId ?? null, i.reason, i.priority,
       i.dueDate ?? null, i.assignedTo ?? null, req.actor.userId]);
    const task = rows[0];

    /* "this audit team will get message to audit particular stock or product" —
     * their message is the work queue, the same one every other role works
     * from, rather than a notification in a corner nobody opens. */
    await pushTask(tx, req.actor, {
      branchId, warehouseId: i.warehouseId ?? undefined,
      queueKey: 'ALERT', docType: 'AUDIT', docId: task.id, docNo: taskNo,
      title: `Audit: ${i.reason}`,
      subtitle: i.scope === 'WAREHOUSE' ? 'Whole warehouse' : `${i.scope.toLowerCase()} check`,
      requiredPermission: 'audit.count.record',
      severity: i.priority === 'URGENT' ? 'critical' : i.priority === 'HIGH' ? 'warn' : 'normal',
      slaMinutes: i.priority === 'URGENT' ? 240 : 1440,
    });

    await emit(tx, req.actor, 'audit_task', task.id, 'audit.raised',
      { taskNo, scope: i.scope, reason: i.reason });

    return { ...task, message: `${taskNo} sent to the audit team.` };
  });
}));

mapRouter.get('/audits/:id', requires('audit.report.view'), h(async (req) => {
  const [t] = await query(req.actor,
    `SELECT t.*, w.name AS warehouse_name, p.name AS product_name,
            ru.full_name AS raised_by_name, au.full_name AS assigned_to_name,
            l.path AS scope_path
       FROM audit_tasks t
       LEFT JOIN warehouses w ON w.id = t.warehouse_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN users ru ON ru.id = t.raised_by
       LEFT JOIN users au ON au.id = t.assigned_to
       LEFT JOIN v_locations l ON l.id = t.scope_id
      WHERE t.id = $1 AND t.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!t) throw ApiError.notFound('No such audit.');

  const counts = await query(req.actor,
    `SELECT ac.*, p.name AS product_name, p.sku, b.batch_no,
            bn.code AS bin_code, r.code AS rack_code,
            u.full_name AS counted_by_name
       FROM audit_counts ac
       JOIN products p ON p.id = ac.product_id
       LEFT JOIN batches b ON b.id = ac.batch_id
       LEFT JOIN bins bn ON bn.id = ac.bin_id
       LEFT JOIN racks r ON r.id = bn.rack_id
       LEFT JOIN users u ON u.id = ac.counted_by
      WHERE ac.task_id = $1 ORDER BY ac.counted_at`, [t.id]);

  return { ...t, counts };
}));

/**
 * What was found on one shelf.
 *
 * The book figure is captured HERE, at the moment of counting, and stored. Any
 * variance computed later from live stock would change every time somebody
 * moved a crate, and last Tuesday's audit would quietly rewrite itself.
 */
mapRouter.post('/audits/counts', requires('audit.count.record'), h(async (req) => {
  const i = body(z.object({
    taskId: z.string().uuid().nullable().optional(),
    scannedQr: z.string().trim().optional(),
    binId: z.string().uuid().nullable().optional(),
    productId: z.string().uuid(),
    batchId: z.string().uuid().nullable().optional(),
    countedQty: z.coerce.number().nonnegative('How much is actually there?'),
    condition: z.enum(['GOOD', 'DAMAGED', 'SPOILED', 'EXPIRED', 'MISSING', 'MISPLACED'])
      .default('GOOD'),
    lossQty: z.coerce.number().nonnegative().default(0),
    note: z.string().trim().max(500).optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    let binId = i.binId ?? null;
    if (!binId && i.scannedQr) {
      const { rows } = await tx.query(
        `SELECT id FROM bins WHERE company_id=$1 AND upper(qr_code)=upper($2)`,
        [req.actor.companyId, i.scannedQr]);
      binId = rows[0]?.id ?? null;
    }

    const { rows: wh } = await tx.query(
      binId
        ? `SELECT z.warehouse_id FROM bins b JOIN racks r ON r.id=b.rack_id
             JOIN zones z ON z.id=r.zone_id WHERE b.id=$1`
        : `SELECT id AS warehouse_id FROM warehouses WHERE company_id=$1 LIMIT 1`,
      binId ? [binId] : [req.actor.companyId]);
    const warehouseId = wh[0]?.warehouse_id;
    if (!warehouseId) throw ApiError.rule('Which warehouse is this shelf in?');

    /* The book figure. On a shelf it is what the packs say is there; with no
     * shelf it is the warehouse balance for that product. */
    const { rows: exp } = await tx.query(
      binId
        ? `SELECT COALESCE(SUM(qty),0) AS q FROM packs
            WHERE bin_id=$1 AND product_id=$2 AND status='IN_STOCK'`
        : `SELECT COALESCE(SUM(qty),0) AS q FROM stock_balances
            WHERE warehouse_id=$1 AND product_id=$2`,
      binId ? [binId, i.productId] : [warehouseId, i.productId]);
    const expected = Number(exp[0].q);

    /* Costing the loss at the batch's landed rate, because "3 crates missing"
     * and "₹4,200 missing" get very different attention. */
    let lossValue: number | null = null;
    if (i.lossQty > 0) {
      const { rows: rate } = await tx.query(
        i.batchId
          ? `SELECT landed_rate FROM batches WHERE id = $1`
          : `SELECT AVG(b.landed_rate) AS landed_rate FROM batches b
              WHERE b.product_id = $1 AND b.status = 'ACTIVE'`,
        [i.batchId ?? i.productId]);
      const r = Number(rate[0]?.landed_rate ?? 0);
      lossValue = r > 0 ? Math.round(r * i.lossQty * 100) / 100 : null;
    }

    const { rows } = await tx.query(
      `INSERT INTO audit_counts (company_id, task_id, warehouse_id, bin_id, scanned_qr,
              product_id, batch_id, expected_qty, counted_qty, condition,
              loss_qty, loss_value, note, counted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.actor.companyId, i.taskId ?? null, warehouseId, binId, i.scannedQr ?? null,
       i.productId, i.batchId ?? null, expected, i.countedQty, i.condition,
       i.lossQty, lossValue, i.note ?? null, req.actor.userId]);
    const count = rows[0];

    if (i.taskId) {
      await tx.query(
        `UPDATE audit_tasks SET status='IN_PROGRESS', started_at=COALESCE(started_at, now()),
                updated_by=$2, updated_at=now()
          WHERE id=$1 AND status='OPEN'`, [i.taskId, req.actor.userId]);
    }

    /* A gap nobody is told about is a gap nobody fixes. The threshold is
     * deliberately low — this is stock, not an estimate. */
    const variance = Number(count.variance_qty);
    if (Math.abs(variance) > 0.001 || i.lossQty > 0) {
      const { rows: p } = await tx.query(`SELECT name FROM products WHERE id=$1`, [i.productId]);
      await raiseAlert(tx, req.actor, {
        alertType: 'AUDIT_VARIANCE',
        severity: i.lossQty > 0 || Math.abs(variance) > expected * 0.1 ? 'HIGH' : 'MEDIUM',
        branchId: req.actor.branchId ?? null,
        entityType: 'audit_count', entityId: count.id,
        title: `${p[0]?.name}: counted ${i.countedQty}, books say ${expected}`,
        message: [
          `${variance >= 0 ? 'More' : 'Less'} than the books by ${Math.abs(variance)}.`,
          i.lossQty > 0 ? `${i.lossQty} written off as ${i.condition.toLowerCase()}.` : null,
          i.note,
        ].filter(Boolean).join(' '),
      });
    }

    return {
      ...count,
      message: Math.abs(variance) < 0.001
        ? `Counted ${i.countedQty} — matches the books.`
        : `Counted ${i.countedQty}, books say ${expected} (${variance > 0 ? '+' : ''}${variance}).`,
    };
  });
}));

mapRouter.post('/audits/:id/complete', requires('audit.count.record'), h(async (req) => {
  const i = body(z.object({
    findings: z.string().trim().min(3, 'What did you find?'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE audit_tasks
          SET status='DONE', findings=$2, completed_at=now(), completed_by=$3,
              updated_by=$3, updated_at=now()
        WHERE id=$1 AND company_id=$4 AND status IN ('OPEN','IN_PROGRESS')
        RETURNING task_no,
          (SELECT count(*)::int FROM audit_counts c WHERE c.task_id = audit_tasks.id) AS counts,
          (SELECT COALESCE(SUM(c.loss_qty),0) FROM audit_counts c WHERE c.task_id = audit_tasks.id) AS loss`,
      [req.params.id, i.findings, req.actor.userId, req.actor.companyId]);
    if (!rows[0]) throw ApiError.rule('That audit is already closed.');

    await resolveTask(tx, req.actor, 'ALERT', 'AUDIT', req.params.id);
    await emit(tx, req.actor, 'audit_task', req.params.id, 'audit.completed',
      { taskNo: rows[0].task_no, counts: rows[0].counts, loss: rows[0].loss });

    return { ok: true, ...rows[0],
      message: `${rows[0].task_no} closed — ${rows[0].counts} shelves counted.` };
  });
}));

/** The picture the owner wants: what the audits have been finding. */
mapRouter.get('/audits-summary', requires('audit.report.view'), h(async (req) => {
  const [k] = await query(req.actor,
    `SELECT
       (SELECT count(*)::int FROM audit_tasks WHERE company_id=$1 AND status='OPEN')        AS open,
       (SELECT count(*)::int FROM audit_tasks WHERE company_id=$1 AND status='IN_PROGRESS') AS in_progress,
       (SELECT count(*)::int FROM audit_tasks WHERE company_id=$1
          AND status IN ('OPEN','IN_PROGRESS') AND due_date < CURRENT_DATE)                 AS overdue,
       (SELECT count(*)::int FROM audit_counts WHERE company_id=$1
          AND counted_at > now() - interval '30 days')                                      AS counts_30d,
       COALESCE((SELECT SUM(loss_value) FROM audit_counts WHERE company_id=$1
          AND counted_at > now() - interval '30 days'),0)                                   AS loss_value_30d,
       (SELECT count(*)::int FROM audit_counts WHERE company_id=$1
          AND counted_at > now() - interval '30 days' AND abs(variance_qty) > 0.001)        AS mismatches_30d`,
    [req.actor.companyId]);

  const byCondition = await query(req.actor,
    `SELECT condition, count(*)::int AS n, SUM(loss_qty) AS loss_qty,
            COALESCE(SUM(loss_value),0) AS loss_value
       FROM audit_counts
      WHERE company_id=$1 AND counted_at > now() - interval '90 days'
      GROUP BY condition ORDER BY loss_value DESC`, [req.actor.companyId]);

  const worst = await query(req.actor,
    `SELECT p.name AS product_name, count(*)::int AS counts,
            SUM(ac.loss_qty) AS loss_qty, COALESCE(SUM(ac.loss_value),0) AS loss_value,
            SUM(ac.variance_qty) AS variance_qty
       FROM audit_counts ac JOIN products p ON p.id = ac.product_id
      WHERE ac.company_id=$1 AND ac.counted_at > now() - interval '90 days'
      GROUP BY p.name HAVING SUM(ac.loss_qty) > 0 OR SUM(abs(ac.variance_qty)) > 0
      ORDER BY COALESCE(SUM(ac.loss_value),0) DESC, SUM(ac.loss_qty) DESC LIMIT 10`,
    [req.actor.companyId]);

  return { kpis: k, byCondition, worst };
}));
