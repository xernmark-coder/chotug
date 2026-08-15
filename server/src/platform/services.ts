import { config, type Actor, type Tx } from '../db.js';

/* ===========================================================================
 * Document numbering (§9.1) — delegates to the schema's next_doc_no(), which
 * takes a row lock on the series so concurrent gate entries cannot collide.
 * ======================================================================== */
export async function nextDocNo(
  tx: Tx,
  actor: Actor,
  branchId: string,
  docType:
    | 'REQ' | 'RFQ' | 'IND' | 'PO' | 'GATE' | 'WGT' | 'QC' | 'GRN'
    | 'BATCH' | 'LABEL' | 'INV' | 'DN' | 'CN' | 'PUT',
): Promise<string> {
  const { rows } = await tx.query('SELECT next_doc_no($1,$2,$3,$4) AS no', [
    actor.companyId, branchId, docType, config.fy,
  ]);
  return rows[0].no as string;
}

/* ===========================================================================
 * Transactional outbox (§9.3) — an event row written in the SAME transaction
 * as the state change. Downstream (Pricing, Accounts, notifications) reads it.
 * ======================================================================== */
export async function emit(
  tx: Tx,
  actor: Actor,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO outbox (company_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [actor.companyId, aggregateType, aggregateId, eventType, JSON.stringify(payload)],
  );
}

/* ===========================================================================
 * Work queue (§5.3) — the single read model behind every panel home screen.
 * A task is pushed when a document becomes someone else's problem, and
 * resolved when they deal with it. This is what makes "the person immediately
 * reaches the thing he wants" true rather than aspirational.
 * ======================================================================== */
export type QueueKey =
  | 'REQUIREMENT_REVIEW' | 'AI_SUGGESTION' | 'APPROVAL' | 'EXPECTED_ARRIVAL'
  | 'WEIGH_PENDING' | 'QC_PENDING' | 'GRN_PENDING' | 'PUTAWAY_PENDING'
  | 'INVOICE_MATCH' | 'FINANCE_EXCEPTION' | 'ALERT';

export async function pushTask(
  tx: Tx,
  actor: Actor,
  t: {
    branchId: string;
    warehouseId?: string | null;
    queueKey: QueueKey;
    docType: string;
    docId: string;
    docNo?: string | null;
    title: string;
    subtitle?: string | null;
    severity?: 'normal' | 'warn' | 'critical';
    requiredPermission: string;
    slaMinutes?: number;
    payload?: Record<string, unknown>;
  },
) {
  await tx.query(
    `INSERT INTO work_queue (company_id, branch_id, warehouse_id, queue_key, doc_type, doc_id,
                             doc_no, title, subtitle, severity, required_permission, sla_due_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN $12::int IS NULL THEN NULL ELSE now() + ($12::int || ' minutes')::interval END,
             $13)
     ON CONFLICT (queue_key, doc_type, doc_id) DO UPDATE
        SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle,
            severity = EXCLUDED.severity, payload = EXCLUDED.payload, resolved_at = NULL`,
    [
      actor.companyId, t.branchId, t.warehouseId ?? null, t.queueKey, t.docType, t.docId,
      t.docNo ?? null, t.title, t.subtitle ?? null, t.severity ?? 'normal',
      t.requiredPermission, t.slaMinutes ?? null, JSON.stringify(t.payload ?? {}),
    ],
  );
}

export async function resolveTask(
  tx: Tx, actor: Actor, queueKey: QueueKey, docType: string, docId: string,
) {
  await tx.query(
    `UPDATE work_queue SET resolved_at = now(), resolved_by = $1
      WHERE queue_key = $2 AND doc_type = $3 AND doc_id = $4 AND resolved_at IS NULL`,
    [actor.userId, queueKey, docType, docId],
  );
}

/* ===========================================================================
 * Alerts (§19) — deduplicated so a stuck document does not spam the panel.
 * ======================================================================== */
export async function raiseAlert(
  tx: Tx,
  actor: Actor,
  a: {
    branchId?: string | null;
    alertType: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    entityType?: string;
    entityId?: string;
    title: string;
    message: string;
    meta?: Record<string, unknown>;
  },
) {
  const dedupe = `${a.alertType}:${a.entityType ?? ''}:${a.entityId ?? ''}`;
  await tx.query(
    `INSERT INTO alerts (company_id, branch_id, alert_type, severity, entity_type, entity_id,
                         title, message, dedupe_hash, meta)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      WHERE NOT EXISTS (
        SELECT 1 FROM alerts
         WHERE company_id = $1 AND dedupe_hash = $9 AND status = 'OPEN'
           AND created_at > now() - interval '60 minutes')`,
    [
      actor.companyId, a.branchId ?? null, a.alertType, a.severity,
      a.entityType ?? null, a.entityId ?? null, a.title, a.message, dedupe,
      JSON.stringify(a.meta ?? {}),
    ],
  );
}

/* ===========================================================================
 * Approval engine (§9). Evaluates approval_rules against a document's facts
 * and raises an approvals row per matched rule level. Returns the highest
 * level required; 0 means no approval needed.
 * ======================================================================== */
export type ApprovalFacts = {
  value?: number;
  rateVariancePct?: number;
  qtyVariancePct?: number;
  weightVariancePct?: number;
  newSupplier?: boolean;
  urgent?: boolean;
  backdate?: boolean;
  landingCostJumpPct?: number;
};

const FACT_BY_TRIGGER: Record<string, keyof ApprovalFacts> = {
  VALUE: 'value',
  RATE_VARIANCE: 'rateVariancePct',
  QTY_VARIANCE: 'qtyVariancePct',
  WEIGHT_VARIANCE: 'weightVariancePct',
  LANDING_COST: 'landingCostJumpPct',
  NEW_SUPPLIER: 'newSupplier',
  URGENT: 'urgent',
  BACKDATE: 'backdate',
};

export async function requestApprovals(
  tx: Tx,
  actor: Actor,
  doc: {
    docType: 'REQUIREMENT' | 'PO' | 'GRN' | 'INVOICE' | 'RATE_REVISION'
      | 'GATE_EXCEPTION' | 'WEIGHT_VARIANCE' | 'QC_OVERRIDE' | 'GRN_REVERSAL' | 'SUPPLIER_STATUS';
    docId: string;
    docNo: string | null;
    branchId: string;
  },
  facts: ApprovalFacts,
): Promise<{ level: number; triggers: string[] }> {
  const { rows: rules } = await tx.query(
    `SELECT * FROM approval_rules
      WHERE company_id = $1 AND is_active
        AND doc_type = $2
        AND (branch_id IS NULL OR branch_id = $3)`,
    [actor.companyId, doc.docType, doc.branchId],
  );

  const matched: { level: number; trigger: string; roleId: string | null; sla: number; detail: any }[] = [];

  for (const r of rules) {
    const factKey = FACT_BY_TRIGGER[r.trigger_code];
    if (!factKey) continue;
    const v = facts[factKey];
    if (v === undefined || v === null) continue;

    let hit = false;
    if (typeof v === 'boolean') hit = v === true;
    else hit = r.threshold_numeric === null || Number(v) >= Number(r.threshold_numeric);

    if (hit) {
      matched.push({
        level: r.required_level,
        trigger: r.trigger_code,
        roleId: r.required_role_id,
        sla: r.sla_minutes,
        detail: { observed: v, threshold: r.threshold_numeric },
      });
    }
  }

  if (matched.length === 0) return { level: 0, triggers: [] };

  const level = Math.max(...matched.map((m) => m.level));
  const top = matched.filter((m) => m.level === level);
  const triggers = [...new Set(matched.map((m) => m.trigger))];

  const { rows } = await tx.query(
    `INSERT INTO approvals (company_id, branch_id, doc_type, doc_id, doc_no, level,
                            triggers, trigger_detail, required_role_id, requested_by, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval)
     RETURNING id`,
    [
      actor.companyId, doc.branchId, doc.docType, doc.docId, doc.docNo, level,
      triggers, JSON.stringify(top.map((t) => ({ trigger: t.trigger, ...t.detail }))),
      top[0].roleId, actor.userId, String(Math.min(...top.map((t) => t.sla))),
    ],
  );

  await pushTask(tx, actor, {
    branchId: doc.branchId,
    queueKey: 'APPROVAL',
    docType: doc.docType,
    docId: doc.docId,
    docNo: doc.docNo,
    title: `${doc.docType} ${doc.docNo ?? ''} needs level ${level} approval`,
    subtitle: triggers.join(', '),
    severity: level >= 3 ? 'critical' : 'warn',
    requiredPermission:
      doc.docType === 'PO' ? 'purchase.po.approve'
      : doc.docType === 'INVOICE' ? 'finance.invoice.approve'
      : doc.docType === 'REQUIREMENT' ? 'purchase.requirement.approve'
      : 'receiving.exception.approve',
    slaMinutes: Math.min(...top.map((t) => t.sla)),
    payload: { approvalId: rows[0].id, triggers },
  });

  return { level, triggers };
}

/* ===========================================================================
 * Settings (§27) — company-scoped key/value with a typed getter.
 * ======================================================================== */
export async function getSetting<T = any>(
  tx: Tx, actor: Actor, key: string, fallback: T,
): Promise<T> {
  const { rows } = await tx.query(
    `SELECT value FROM settings
      WHERE company_id = $1 AND key = $2 AND branch_id IS NULL LIMIT 1`,
    [actor.companyId, key],
  );
  return rows[0] ? (rows[0].value as T) : fallback;
}
