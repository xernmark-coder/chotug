-- ===========================================================================
--  13 — SUPPLIER PORTAL
--
--  A supplier is currently a row somebody else maintains. This lets a person
--  at that supplier hold a login of their own, see the orders addressed to
--  them, and file their invoice instead of emailing a PDF that somebody then
--  retypes.
--
--  The whole design rests on one column: users.supplier_id. A user carrying it
--  is an OUTSIDE user, and every supplier-facing endpoint filters by it. There
--  is no "supplier can see everything except…" list to get wrong — they can
--  see what belongs to their own supplier_id and nothing else.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

-- NULL for staff, set for an outside contact. The FK is what makes the
-- scoping impossible to fake from the application side.
ALTER TABLE users ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS ix_users_supplier ON users (supplier_id) WHERE supplier_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  Permissions. Deliberately narrow: see my own orders and receipts, file and
--  read my own invoices. Nothing about other suppliers, stock, costs or rates
--  beyond what is on their own documents.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
  ('supplier.portal.access',  'supplier', 'portal',  'view',   'Sign in to the supplier portal', false, 'NORMAL'),
  ('supplier.order.view',     'supplier', 'order',   'view',   'See purchase orders addressed to me', false, 'NORMAL'),
  ('supplier.invoice.submit', 'supplier', 'invoice', 'create', 'File an invoice against a receipt', false, 'NORMAL'),
  ('supplier.invoice.view',   'supplier', 'invoice', 'view',   'See my invoices and their status', false, 'NORMAL')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
--  The SUPPLIER role, per company.
-- ---------------------------------------------------------------------------
INSERT INTO roles (company_id, code, name, description, is_system)
SELECT c.id, 'SUPPLIER', 'Supplier (outside)',
       'A contact at a supplier. Sees only their own orders, receipts and invoices.', true
  FROM companies c
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
  FROM roles r
  CROSS JOIN (VALUES
      ('supplier.portal.access'), ('supplier.order.view'),
      ('supplier.invoice.submit'), ('supplier.invoice.view')
  ) AS p(code)
 WHERE r.code = 'SUPPLIER'
ON CONFLICT DO NOTHING;

-- An outside user gets no approval authority of any kind.
INSERT INTO role_limits (role_id, max_approval_level, max_backdate_days)
SELECT r.id, 0, 0 FROM roles r WHERE r.code = 'SUPPLIER'
ON CONFLICT (role_id) DO NOTHING;

COMMIT;
