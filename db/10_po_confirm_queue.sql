-- ===========================================================================
--  10 — "CONFIRM WITH THE SUPPLIER" QUEUE
--
--  An approved purchase order is not a placed order. This panel is internal —
--  the supplier has no idea anything happened until somebody actually calls
--  them. Between APPROVED and CONFIRMED there was no task anywhere, so an
--  order raised and then left alone was invisible: not on anyone's queue, and
--  only findable by scrolling the purchase order list.
--
--  PO_CONFIRM closes that gap, which is also what lets somebody abandon the
--  guided flow half way and have a colleague finish the job.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_queue_key_check;
ALTER TABLE work_queue ADD  CONSTRAINT work_queue_queue_key_check
      CHECK (queue_key IN ('REQUIREMENT_REVIEW','AI_SUGGESTION','APPROVAL',
                           'EXPECTED_ARRIVAL','WEIGH_PENDING','QC_PENDING',
                           'GRN_PENDING','PUTAWAY_PENDING','INVOICE_MATCH',
                           'FINANCE_EXCEPTION','ALERT',
                           'FARM_TASK','FARM_HARVEST','FARM_RECEIVE',
                           'PO_CONFIRM'));

-- Back-fill: orders already sitting in APPROVED were raised before this queue
-- existed and are exactly the ones nobody is looking at.
INSERT INTO work_queue (company_id, branch_id, queue_key, doc_type, doc_id, doc_no,
                        title, subtitle, severity, required_permission, created_at)
SELECT o.company_id, o.branch_id, 'PO_CONFIRM', 'PO', o.id, o.po_no,
       'Confirm ' || o.po_no || ' with the supplier',
       COALESCE(s.trade_name, s.legal_name) || ' · expected ' || o.expected_date,
       CASE WHEN o.is_urgent THEN 'warn' ELSE 'normal' END,
       'purchase.po.submit', o.approved_at
  FROM purchase_orders o
  JOIN suppliers s ON s.id = o.supplier_id
 WHERE o.status = 'APPROVED'
   AND NOT EXISTS (SELECT 1 FROM work_queue w
                    WHERE w.doc_id = o.id AND w.queue_key = 'PO_CONFIRM');

COMMIT;
