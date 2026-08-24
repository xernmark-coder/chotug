-- =============================================================================
-- 37 · A VEHICLE REQUEST IS EVERYBODY'S BUSINESS
--
-- The supplier asks; the office arranges. But "the office" was one permission
-- held by purchase and the gate, and the client's instruction is that Finance
-- or the admin sends the vehicle — Finance being the panel that pays for the
-- transport and therefore the panel that should be able to commit to it.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['logistics.pickup.manage']);
    END LOOP;
END $$;

COMMIT;
