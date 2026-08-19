-- ============================================================================
--  ChotuG ERP — narrow each role to its own job
--
--  Two things had leaked:
--
--  1. Farming was granted to the purchase roles. 04_farming.sql gave
--     PURCHASE_EXEC and PURCHASE_MGR `farming.report.view` on the theory that a
--     buyer wants to see what the farm will supply. In practice it put a "Farm
--     Control" item in a buyer's sidebar for a module that is the owner's, and
--     the buy list never consumed the farm figures anyway. Revoked; the owner
--     and the farm roles keep it.
--
--  Additive and idempotent.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

DELETE FROM role_permissions rp
 USING roles r
 WHERE rp.role_id = r.id
   AND r.code IN ('PURCHASE_EXEC', 'PURCHASE_MGR')
   AND rp.permission_code = 'farming.report.view';

--  2. The purchase manager was given receiving.gate.create.
--
--     07_flow_fixes.sql granted PURCHASE_MGR both receiving.weighment.create
--     and receiving.gate.create. The first fixed a real dead end — the only
--     role allowed to approve an over-tolerance weight could not record the
--     weight it was approving. The second was added alongside it without any
--     such need, and it put eight expected-arrival tasks into a purchase
--     manager's work queue plus a whole gate section on their dashboard.
--     Revoked; the weighment grant stays.
DELETE FROM role_permissions rp
 USING roles r
 WHERE rp.role_id = r.id
   AND r.code = 'PURCHASE_MGR'
   AND rp.permission_code = 'receiving.gate.create';

COMMIT;
