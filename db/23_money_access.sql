-- =============================================================================
-- 23 · WHO MAY ASK FOR MONEY
--
-- The client's rule is that every rupee leaves through Finance. That only works
-- if everybody who actually spends can raise the claim — otherwise the gate
-- clerk who paid a tempo out of pocket has no way to be reimbursed inside the
-- system, and the money moves outside it. Asking is not approving: verifying
-- and paying stay with Finance and the owner.
-- =============================================================================

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
  FROM roles r
  JOIN (VALUES
        -- people who spend in the field: they may ask, nothing more
        ('PURCHASE_EXEC', 'finance.request.create'),
        ('GATE_EXEC',     'finance.request.create'),
        ('QC_EXEC',       'finance.request.create'),
        ('QC_HEAD',       'finance.request.create'),
        ('FARM_STAFF',    'finance.request.create'),
        -- a centre takes cash over the counter and declares it; Finance
        -- confirms what actually landed
        ('WH_EXEC',       'finance.receipt.record'),
        ('PURCHASE_MGR',  'finance.receipt.record')
       ) AS p(role_code, code) ON p.role_code = r.code
 WHERE EXISTS (SELECT 1 FROM permissions x WHERE x.code = p.code)
ON CONFLICT DO NOTHING;
