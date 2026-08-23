-- =============================================================================
-- 24 · THE SUPPLIER ANSWERS, THEN ASKS, THEN SENDS
--
-- Until now a confirmed order was a statement, not a conversation: we placed
-- it and then waited for a lorry, with no record of whether the supplier had
-- even agreed to it. The client's sequence is:
--
--     we confirm  →  supplier ACCEPTS  →  supplier asks Finance for the money
--                 →  Finance pays      →  supplier SENDS the load
--
-- Each arrow is a fact somebody is accountable for, so each one is stored.
-- A decline is as important as an acceptance — it is the buyer's cue to place
-- the order elsewhere while there is still time.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS supplier_response       text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS supplier_responded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS supplier_responded_by   uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS supplier_response_note  text;

DO $$ BEGIN
  ALTER TABLE purchase_orders ADD CONSTRAINT ck_po_supplier_response
    CHECK (supplier_response IN ('PENDING','ACCEPTED','DECLINED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Turning work down without saying why leaves the buyer with a hole in the
-- plan and no idea how to fill it.
DO $$ BEGIN
  ALTER TABLE purchase_orders ADD CONSTRAINT ck_po_decline_reason
    CHECK (supplier_response <> 'DECLINED' OR supplier_response_note IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Orders placed before this existed were accepted in practice — the goods came.
-- Leaving them PENDING would put historic orders in the supplier's new
-- "waiting for your answer" list.
UPDATE purchase_orders
   SET supplier_response = 'ACCEPTED',
       supplier_responded_at = COALESCE(updated_at, created_at)
 WHERE supplier_response = 'PENDING'
   AND status IN ('CONFIRMED','PART_RECEIVED','RECEIVED','CLOSED');

CREATE INDEX IF NOT EXISTS ix_po_supplier_response
    ON purchase_orders (company_id, supplier_response)
 WHERE status = 'CONFIRMED';

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('supplier.order.accept','supplier','order','accept',
  'Supplier accepts or declines an order placed with them', false,'NORMAL'),
 ('supplier.payment.request','supplier','payment','request',
  'Supplier asks Finance for payment against an accepted order', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'SUPPLIER',
                ARRAY['supplier.order.accept','supplier.payment.request']);
    END LOOP;
END $$;

COMMIT;
