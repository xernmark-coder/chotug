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
    | 'BATCH' | 'LABEL' | 'INV' | 'DN' | 'CN' | 'PUT'
    | 'CROP' | 'HARV' | 'FDN' | 'ISS' | 'PCK' | 'PIC'
    | 'PAY' | 'PMT' | 'RCP' | 'AUD',
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
  | 'INVOICE_MATCH' | 'FINANCE_EXCEPTION' | 'ALERT'
  | 'FARM_TASK' | 'FARM_HARVEST' | 'FARM_RECEIVE'
  // Approved, but the supplier has not been told yet. See db/10.
  | 'PO_CONFIRM'
  // The supplier is standing next to the crates asking for a lorry. See db/36.
  | 'TRANSPORT_REQUEST';

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
     /* The audience and the clock move with the task, not just its words.
      * Without this a row re-pushed for a different job kept whoever the FIRST
      * push was addressed to: "PO/55 accepted by the supplier — arrange
      * payment" inherited purchase.po.approve from the earlier "needs
      * confirming" task, so it went to approvers and the buyer it was written
      * for never saw it. The task existed, looked right in the table, and was
      * invisible to the one person who had to act. */
     ON CONFLICT (queue_key, doc_type, doc_id) DO UPDATE
        SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle,
            severity = EXCLUDED.severity, payload = EXCLUDED.payload,
            required_permission = EXCLUDED.required_permission,
            sla_due_at = EXCLUDED.sla_due_at,
            resolved_at = NULL`,
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
  /* The guard used to be "not raised in the last 60 minutes", but the index
   * behind it — uq_alerts_dedupe — is unique on (company_id, dedupe_hash)
   * WHERE status='OPEN' with no time limit at all. An alert still open after an
   * hour therefore passed the guard and then hit the index, and the whole
   * request 409'd with a raw constraint name. Let the database arbitrate: one
   * open alert per subject, and a re-raise refreshes it instead of failing. */
  await tx.query(
    `INSERT INTO alerts (company_id, branch_id, alert_type, severity, entity_type, entity_id,
                         title, message, dedupe_hash, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (company_id, dedupe_hash) WHERE status = 'OPEN' AND dedupe_hash IS NOT NULL
     DO UPDATE SET severity = EXCLUDED.severity,
                   title    = EXCLUDED.title,
                   message  = EXCLUDED.message,
                   meta     = EXCLUDED.meta`,
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

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Turns a trigger code into the sentence a human would say. "RATE_VARIANCE" is
 * a fact about the database; "rate is 12% above the last purchase" is a fact
 * about the business, and it is the second one that tells someone what to do.
 */
export function explainTrigger(code: string, observed: unknown, threshold: number | null): string {
  const n = Number(observed);
  switch (code) {
    // The amount is already in the subject line, so repeating it here just
    // makes the sentence longer. Say what was breached, not what it was.
    case 'VALUE':
      return threshold ? `over the ${inr(threshold)} approval limit` : `by value`;
    case 'RATE_VARIANCE':
      return `rate is ${Math.round(n * 10) / 10}% away from the last purchase`;
    case 'QTY_VARIANCE':
      return `quantity is ${Math.round(n * 10) / 10}% off what was ordered`;
    case 'WEIGHT_VARIANCE':
      return `weight is ${Math.round(n * 10) / 10}% off the expected load`;
    case 'LANDING_COST':
      return `landed cost jumped ${Math.round(n * 10) / 10}%`;
    case 'NEW_SUPPLIER': return 'first order with this supplier';
    case 'URGENT':       return 'marked urgent';
    case 'BACKDATE':     return 'posted with an earlier date';
    default:             return code.replace(/_/g, ' ').toLowerCase();
  }
}

/**
 * §9 — can this person sign this off themselves?
 *
 * Approval exists to put a *second, more senior* pair of eyes on a document.
 * When the person who raised it already holds the authority the rule is asking
 * for, there is no second pair of eyes to find — the document simply sits in a
 * queue that only they can clear, which is how work stops rather than how
 * control happens.
 *
 * So: within your own level AND your own value limit, it approves on submit and
 * the audit trail records that you approved it yourself. Above either of them,
 * maker–checker still applies and somebody else must look.
 */
export function withinOwnAuthority(
  actor: Actor, requiredLevel: number, value: number | null | undefined, docType: string,
): boolean {
  if (actor.permissions.has('admin.override')) return true;
  if (actor.limits.maxApprovalLevel < requiredLevel) return false;

  // Which ceiling applies depends on the document. An invoice mismatch has its
  // own limit in role_limits; checking it against the PO limit would quietly
  // let finance wave through a mismatch far larger than they are trusted with.
  const ceiling =
    docType === 'INVOICE' ? actor.limits.maxInvoiceMismatchValue
    : docType === 'PO' || docType === 'REQUIREMENT' ? actor.limits.maxPoValue
    : null;   // no money ceiling defined for this document — level alone decides

  if (value != null && ceiling != null && value > ceiling) return false;
  return true;
}

const DOC_LABEL: Record<string, string> = {
  PO: 'purchase order', REQUIREMENT: 'requirement', GRN: 'goods receipt',
  INVOICE: 'invoice', RATE_REVISION: 'rate revision', GATE_EXCEPTION: 'gate exception',
  WEIGHT_VARIANCE: 'weight variance', QC_OVERRIDE: 'quality override',
  GRN_REVERSAL: 'receipt reversal', SUPPLIER_STATUS: 'supplier status change',
};

export async function requestApprovals(
  tx: Tx,
  actor: Actor,
  doc: {
    docType: 'REQUIREMENT' | 'PO' | 'GRN' | 'INVOICE' | 'RATE_REVISION'
      | 'GATE_EXCEPTION' | 'WEIGHT_VARIANCE' | 'QC_OVERRIDE' | 'GRN_REVERSAL' | 'SUPPLIER_STATUS';
    docId: string;
    /** Who and how much, in words — "₹1,24,500 for Sahyadri Wholesale". */
    subject?: string;
    docNo: string | null;
    branchId: string;
  },
  facts: ApprovalFacts,
): Promise<{
  /** 0 means nothing to wait for — either no rule fired, or the submitter
   *  already held the authority the rule was asking for. */
  level: number;
  triggers: string[];
  /** The same triggers, said in words, for the screen and the audit note. */
  reasons: string[];
  selfApproved: boolean;
  /** Set when selfApproved: the level this would have needed from anyone else. */
  wouldHaveNeededLevel?: number;
}> {
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

  if (matched.length === 0) return { level: 0, triggers: [], reasons: [], selfApproved: false };

  const level = Math.max(...matched.map((m) => m.level));
  const top = matched.filter((m) => m.level === level);
  const triggers = [...new Set(matched.map((m) => m.trigger))];
  // Only the rules at the highest level are actually binding — a ₹7L order
  // trips both the ₹1L and the ₹5L threshold, and saying so twice is noise.
  const reasons = [...new Set(
    top.map((m) => explainTrigger(m.trigger, m.detail.observed, m.detail.threshold)))];

  // Rules fired, but this person already outranks every one of them — so there
  // is nobody more senior to route to. Approve it and say why in the audit,
  // rather than parking it in a queue only they can clear.
  if (withinOwnAuthority(actor, level, facts.value, doc.docType)) {
    return { level: 0, triggers, reasons, selfApproved: true, wouldHaveNeededLevel: level };
  }

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
    // Say the action, the thing, and the reason — in that order, in words.
    // "PO PO/2026-27/12 needs level 2 approval / RATE_VARIANCE" told the reader
    // nothing they could act on.
    title: `Approve ${DOC_LABEL[doc.docType] ?? doc.docType.toLowerCase()} ${doc.docNo ?? ''}`.trim(),
    subtitle: [doc.subject, reasons.join(' · ')].filter(Boolean).join(' — ') || undefined,
    severity: level >= 3 ? 'critical' : 'warn',
    requiredPermission:
      doc.docType === 'PO' ? 'purchase.po.approve'
      : doc.docType === 'INVOICE' ? 'finance.invoice.approve'
      : doc.docType === 'REQUIREMENT' ? 'purchase.requirement.approve'
      : 'receiving.exception.approve',
    slaMinutes: Math.min(...top.map((t) => t.sla)),
    payload: { approvalId: rows[0].id, triggers },
  });

  return { level, triggers, reasons, selfApproved: false };
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
