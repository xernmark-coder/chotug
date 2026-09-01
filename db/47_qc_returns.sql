-- =============================================================================
-- 47 · WHAT WAS REJECTED, IN WHAT, AND WHETHER IT WENT BACK
--
-- Two gaps, one story.
--
-- FIRST, the unit. qc_inspections stores received/accepted/rejected/hold as
-- bare numbers. The entry form knows the unit — it labels every box "Rejected
-- (CRATE)" from the order line — and then throws it away on save. Every screen
-- downstream prints "40" against a supplier's name. Forty kilos and forty
-- crates are an argument, and the record could not settle it.
--
-- SECOND, the send-back. Rejecting produce and returning it are different
-- events: QC decides at the bay, the warehouse puts it on a lorry hours later,
-- and sometimes it never goes back at all — it is dumped, or the buyer takes it
-- at a discount. There was nowhere to record which happened, so a supplier
-- whose goods were turned away learned it from a phone call, if at all.
--
-- The send-back hangs off the inspection rather than becoming its own document:
-- there is exactly one rejection to answer, the quantity can never exceed it,
-- and a separate table would need a foreign key back here for every question
-- anybody actually asks.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ------------------------------------------------------------------ unit -- */
ALTER TABLE qc_inspections
  ADD COLUMN IF NOT EXISTS uom text;

COMMENT ON COLUMN qc_inspections.uom IS
  'What received/accepted/rejected/hold are counted in — taken from the order '
  'line, because that is the unit the supplier is billing in. See db/47.';

-- Every inspection already taken was in the order line's unit; it simply was
-- not written down. Fill it in from there, and fall back to how the product is
-- held where an inspection has no line behind it.
UPDATE qc_inspections q
   SET uom = COALESCE(
         (SELECT l.uom FROM po_lines l WHERE l.id = q.po_line_id),
         (SELECT p.base_uom FROM products p WHERE p.id = q.product_id),
         'KG')
 WHERE q.uom IS NULL;

/* ------------------------------------------------------------- send-back -- */
ALTER TABLE qc_inspections
  ADD COLUMN IF NOT EXISTS returned_qty       qty_amt,
  ADD COLUMN IF NOT EXISTS returned_at        timestamptz,
  ADD COLUMN IF NOT EXISTS returned_by        uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS return_vehicle_reg text,
  ADD COLUMN IF NOT EXISTS return_note        text,
  -- What happened to the rest, where not all of it went back.
  ADD COLUMN IF NOT EXISTS return_outcome     text,
  -- The supplier has seen it. Until then it is news they have not had.
  ADD COLUMN IF NOT EXISTS return_seen_at     timestamptz;

-- qty_amt is NOT NULL DEFAULT 0 like money_amt, and for the same reason that
-- caught us in db/46: "nothing has been sent back yet" is not "nothing was
-- sent back". Only NULL can say the first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'qc_inspections'
                AND column_name = 'returned_qty' AND is_nullable = 'NO') THEN
    ALTER TABLE qc_inspections ALTER COLUMN returned_qty TYPE numeric(14,3);
    ALTER TABLE qc_inspections ALTER COLUMN returned_qty DROP DEFAULT;
    ALTER TABLE qc_inspections ALTER COLUMN returned_qty DROP NOT NULL;
    UPDATE qc_inspections SET returned_qty = NULL;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE qc_inspections ADD CONSTRAINT ck_qc_return_qty
    CHECK (returned_qty IS NULL
           OR (returned_qty >= 0 AND returned_qty <= rejected_qty::numeric + 0.001));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE qc_inspections ADD CONSTRAINT ck_qc_return_outcome
    CHECK (return_outcome IS NULL
           OR return_outcome IN ('SENT_BACK', 'PART_SENT_BACK', 'DESTROYED', 'KEPT_AT_A_DISCOUNT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A send-back has to say who and when, or it is a number nobody stands behind.
DO $$ BEGIN
  ALTER TABLE qc_inspections ADD CONSTRAINT ck_qc_return_recorded
    CHECK (returned_qty IS NULL
           OR (returned_at IS NOT NULL AND returned_by IS NOT NULL
               AND return_outcome IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_qc_returns_unseen
    ON qc_inspections (company_id, returned_at DESC)
 WHERE returned_at IS NOT NULL;

/* ------------------------------------------------------------------ view --
 * One definition of "what we turned away", read by the warehouse screen that
 * records it and by the supplier panel that has to be told. Two queries would
 * be two chances to disagree about the number in an argument about money.
 */
CREATE OR REPLACE VIEW v_qc_rejections AS
SELECT q.id                       AS inspection_id,
       q.company_id,
       q.inspection_no,
       q.inspected_at,
       q.warehouse_id,
       w.name                     AS warehouse_name,
       q.product_id,
       p.name                     AS product_name,
       p.icon                     AS product_icon,
       -- The unit, said once here so no screen has to guess it.
       COALESCE(q.uom, l.uom, p.base_uom, 'KG')  AS uom,
       q.received_qty,
       q.accepted_qty,
       q.rejected_qty,
       q.hold_qty,
       q.overall_result,
       q.rejection_reason_codes,
       q.remarks,
       o.id                       AS po_id,
       o.po_no,
       o.supplier_id,
       COALESCE(s.trade_name, s.legal_name) AS supplier_name,
       l.rate                     AS ordered_rate,
       ROUND(q.rejected_qty::numeric * COALESCE(l.rate, 0), 2) AS rejected_value,
       q.returned_qty,
       q.returned_at,
       q.return_outcome,
       q.return_vehicle_reg,
       q.return_note,
       q.return_seen_at,
       u.full_name                AS returned_by_name,
       /* Still to answer for: rejected, and nobody has said what became of it.
        * This is the warehouse's queue, and the reason the column is nullable. */
       (q.rejected_qty > 0 AND q.returned_qty IS NULL) AS awaiting_decision
  FROM qc_inspections q
  JOIN products   p ON p.id = q.product_id
  JOIN warehouses w ON w.id = q.warehouse_id
  LEFT JOIN po_lines        l ON l.id = q.po_line_id
  LEFT JOIN purchase_orders o ON o.id = l.po_id
  LEFT JOIN suppliers       s ON s.id = o.supplier_id
  LEFT JOIN users           u ON u.id = q.returned_by
 WHERE q.rejected_qty > 0;

COMMENT ON VIEW v_qc_rejections IS
  'Everything QC turned away, with the unit it was measured in and what became '
  'of it. The warehouse records the send-back against it; the supplier reads '
  'the same rows.';

GRANT SELECT ON v_qc_rejections TO chotug_app;
GRANT SELECT ON v_qc_rejections TO chotug_readonly;

/* The warehouse decides and records; the supplier only ever reads. */
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('quality.rejection.return','quality','rejection','return',
  'Say what became of rejected goods — sent back, destroyed, or kept at a discount',
  false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER',        ARRAY['quality.rejection.return']);
        PERFORM grant_role_perms(c.id, 'WH_MGR',       ARRAY['quality.rejection.return']);
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['quality.rejection.return']);
        PERFORM grant_role_perms(c.id, 'QC_EXEC',      ARRAY['quality.rejection.return']);
        PERFORM grant_role_perms(c.id, 'QC_HEAD',      ARRAY['quality.rejection.return']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['quality.rejection.return']);
    END LOOP;
END $$;

COMMIT;
