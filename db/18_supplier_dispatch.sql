-- ============================================================================
--  ChotuG ERP — the supplier can say "it has left"
--
--  The portal showed a supplier every order that was not a draft, which
--  included SUBMITTED — orders still inside OUR approval, that we might never
--  place. A supplier should not learn about an order before we have decided to
--  give it to them.
--
--  It also had no way for them to tell us a load is on its way, so the gate
--  found out when the lorry appeared.
--
--  Additive and idempotent.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES ('supplier.order.dispatch','supplier','order','dispatch',
        'Supplier marks a confirmed order as sent, with vehicle and date', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'SUPPLIER', ARRAY['supplier.order.dispatch']);
    END LOOP;
END $$;

-- What the supplier told us, kept beside what we expected. The gate compares
-- the two at the barrier, so a vehicle that never matches is visible.
ALTER TABLE expected_arrivals ADD COLUMN IF NOT EXISTS supplier_marked_sent_at timestamptz;
ALTER TABLE expected_arrivals ADD COLUMN IF NOT EXISTS supplier_note text;

COMMIT;
