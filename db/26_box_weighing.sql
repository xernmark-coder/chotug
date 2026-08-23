-- =============================================================================
-- 26 · EVERY BOX IS WEIGHED AS IT COMES OFF THE LORRY
--
--   "when taking is down from the vehical to warehouse they will weight each
--    box on small weight and then for that product the total weight is
--    calculated … because in a vehical they buy multiple product then while
--    taking down the boxes they weight each box by selecting its product
--    number, for that product the wieght should be updated in the system."
--
-- The weighbridge weighs the LORRY. That is one number for a load carrying
-- mango, tomato and onion together, and it can never tell you how much mango
-- arrived. The floor already weighs each box on a platform scale — the number
-- was simply going onto paper and then into somebody's head.
--
-- So: one row per box. The per-product total is then a SUM, not a typed figure,
-- and the difference between what was ordered and what came off the lorry
-- stops being an argument.
--
-- Boxes are corrected by VOIDING, never by editing: a weight that can be
-- changed after the fact is a weight nobody can be held to.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS unload_boxes (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    branch_id       uuid NOT NULL REFERENCES branches(id),
    warehouse_id    uuid          REFERENCES warehouses(id),
    gate_entry_id   uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    po_line_id      uuid          REFERENCES po_lines(id),
    product_id      uuid NOT NULL REFERENCES products(id),

    -- Sequential within the vehicle, so the floor can call out "box 41".
    box_no          integer NOT NULL,
    weight_kg       numeric(12,3) NOT NULL CHECK (weight_kg > 0),

    -- How the number arrived. A hand-typed weight and one read off a connected
    -- scale are not equally trustworthy, and an audit needs to tell them apart.
    capture_mode    text NOT NULL DEFAULT 'MANUAL'
                    CHECK (capture_mode IN ('MANUAL','DEVICE','SCAN')),
    scale_device_id uuid,
    -- What the picker actually scanned or chose: the supplier's own code for
    -- the product, which is what is printed on the box.
    scanned_code    text,

    voided_at       timestamptz,
    voided_by       uuid REFERENCES users(id),
    void_reason     text,
    CONSTRAINT ck_box_void CHECK (voided_at IS NULL OR void_reason IS NOT NULL),

    weighed_by      uuid NOT NULL REFERENCES users(id),
    weighed_at      timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_box_no UNIQUE (gate_entry_id, box_no)
);

CREATE INDEX IF NOT EXISTS ix_box_entry   ON unload_boxes (gate_entry_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_box_product ON unload_boxes (company_id, product_id, weighed_at);

ALTER TABLE unload_boxes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY unload_boxes_rls ON unload_boxes
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The per-product truth for one vehicle. Every screen reads this rather than
-- summing boxes itself, so no two screens can disagree about how much mango
-- came off the lorry.
CREATE OR REPLACE VIEW v_unload_totals AS
SELECT b.company_id,
       b.gate_entry_id,
       b.product_id,
       b.po_line_id,
       count(*)::int                        AS boxes,
       SUM(b.weight_kg)                     AS net_kg,
       ROUND(AVG(b.weight_kg), 3)           AS avg_box_kg,
       MIN(b.weight_kg)                     AS min_box_kg,
       MAX(b.weight_kg)                     AS max_box_kg,
       MAX(b.weighed_at)                    AS last_weighed_at
  FROM unload_boxes b
 WHERE b.voided_at IS NULL
 GROUP BY b.company_id, b.gate_entry_id, b.product_id, b.po_line_id;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('receiving.box.weigh','receiving','box','weigh',
  'Weigh each box as it comes off the vehicle', false,'NORMAL'),
 ('receiving.box.void','receiving','box','void',
  'Void a box weight that was recorded wrongly', false,'SENSITIVE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'WH_EXEC',
                ARRAY['receiving.box.weigh','receiving.box.void']);
        PERFORM grant_role_perms(c.id, 'GATE_EXEC',  ARRAY['receiving.box.weigh']);
        PERFORM grant_role_perms(c.id, 'QC_EXEC',    ARRAY['receiving.box.weigh']);
        PERFORM grant_role_perms(c.id, 'OWNER',
                ARRAY['receiving.box.weigh','receiving.box.void']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['receiving.box.void']);
    END LOOP;
END $$;

COMMIT;
