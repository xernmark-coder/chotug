-- ============================================================================
--  ChotuG ERP — ORDER → RECEIVE → QC → STORE flow fixes
--
--  Found by driving the whole chain end to end as each role rather than by
--  reading it. Every change here removes a dead end: a state the system can
--  reach but nobody has the rights to move on from.
--
--  Additive and idempotent.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
--  1. An over-tolerance weight could only be recorded by the Owner.
--
--  ck_weigh_variance_approval demands approved_by on any breached weighment
--  that is not the opening gross. But the roles holding
--  receiving.weighment.approve (PURCHASE_MGR) were never granted
--  receiving.weighment.create, and the roles that can create (GATE_EXEC,
--  WH_EXEC) cannot approve. So the one person allowed to sign the weight off
--  could not enter it, and the one who could enter it was refused — leaving
--  the vehicle stuck at the weighbridge unless the Owner walked over.
--
--  A supervisor authorised to approve a variance must be able to capture the
--  weight they are approving.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        -- Only the weighment grant: see 17_role_scope.sql for why gate.create
        -- was a mistake here.
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY[
            'receiving.weighment.create']);
        -- QC_HEAD approves overrides but could not record the inspection being
        -- overridden — the same shape of gap one step further down the chain.
        PERFORM grant_role_perms(c.id, 'QC_HEAD', ARRAY['quality.inspection.create']);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  2. Landed cost could only be computed by the Owner.
--
--  costing.landing.recompute was granted to no role at all. PURCHASE_MGR and
--  FINANCE_EXEC hold costing.landing.view — they can read a landed cost but
--  never produce one — so the module's headline number was unreachable for
--  everyone except the break-glass Owner override.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY[
            'costing.landing.recompute','costing.charge.manage']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY[
            'costing.landing.recompute','costing.charge.manage']);
        -- The warehouse posts the receipt, so it should be able to price it.
        PERFORM grant_role_perms(c.id, 'WH_EXEC', ARRAY['costing.landing.view']);
    END LOOP;
END $$;

COMMIT;
