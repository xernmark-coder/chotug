-- ============================================================================
--  ChotuG ERP — PRODUCT IDENTITY  (client update, phase 1)
--
--  Nothing downstream can be tracked honestly until a thing has one name. This
--  gives every product three things it did not have:
--
--    1. A CATEGORY TREE.  product_categories.parent_id already existed and was
--       never used, so "Fruits → Mango → Alphonso" was impossible. Mango
--       becomes a category and each breed becomes a product in its own right,
--       which means stock, batches, pricing, QC and every report work per
--       breed on day one — none of them need to learn a new level.
--
--    2. THE SUPPLIER'S OWN CODE.  The same mango is "MNG-A1" to one aadhti and
--       "AH-04" to the next. Their code is recorded against ours, so a delivery
--       note can be read without translation.
--
--    3. ONE TRACKING CODE.  Generated from supplier + product, printed on the
--       label, and the thing scanned at the gate, at packing and at audit.
--
--  Additive and idempotent.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
--  1. Visual identity — the staff are not technical and asked to recognise a
--     product by sight. One icon key per product, falling back to its category.
-- ---------------------------------------------------------------------------
ALTER TABLE products           ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN products.icon IS
  'Icon key rendered by web/src/components/icons.tsx. Falls back to the category icon.';

-- ---------------------------------------------------------------------------
--  2. The supplier's own number for our product, plus the code we track by.
--
--  tracking_code is generated once and never changes: it is printed on labels
--  and scanned months later, so a code that moved would strand the print.
-- ---------------------------------------------------------------------------
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS supplier_code  text;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS supplier_name_for_product text;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS tracking_code  text;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN supplier_products.supplier_code IS
  'What the SUPPLIER calls this product on their own paperwork.';
COMMENT ON COLUMN supplier_products.tracking_code IS
  'What WE track it by: <supplier code>-<product sku>. Printed on labels; never reissued.';

-- Two suppliers may use the same code for different things, so uniqueness is
-- per supplier — but our tracking code must be unique across the company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_product_code
    ON supplier_products (supplier_id, supplier_code) WHERE supplier_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_tracking_code
    ON supplier_products (company_id, tracking_code) WHERE tracking_code IS NOT NULL;

-- ---------------------------------------------------------------------------
--  Generate the tracking code for any row that lacks one, and keep it filled
--  in for rows added later. Done in the database so a code cannot be missed by
--  whichever screen created the link.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_supplier_product_tracking_code()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sup text; v_sku text;
BEGIN
    IF NEW.tracking_code IS NOT NULL THEN RETURN NEW; END IF;
    SELECT s.code INTO v_sup FROM suppliers s WHERE s.id = NEW.supplier_id;
    SELECT p.sku  INTO v_sku FROM products  p WHERE p.id = NEW.product_id;
    -- Readable on a printed label and unambiguous when typed back in.
    NEW.tracking_code := upper(regexp_replace(
        COALESCE(v_sup, 'SUP') || '-' || COALESCE(v_sku, 'PRD'), '[^A-Z0-9-]', '', 'gi'));
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_supplier_product_code ON supplier_products;
CREATE TRIGGER trg_supplier_product_code
    BEFORE INSERT OR UPDATE OF supplier_id, product_id ON supplier_products
    FOR EACH ROW EXECUTE FUNCTION trg_supplier_product_tracking_code();

UPDATE supplier_products sp
   SET tracking_code = upper(regexp_replace(s.code || '-' || p.sku, '[^A-Z0-9-]', '', 'gi'))
  FROM suppliers s, products p
 WHERE s.id = sp.supplier_id AND p.id = sp.product_id AND sp.tracking_code IS NULL;

-- ---------------------------------------------------------------------------
--  3. Permissions — admin manages the master data; everyone else reads it.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('master.category.manage','master','category','manage','Add and edit product categories and breeds', false,'SENSITIVE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['master.category.manage','master.product.manage']);
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
         WHERE r.company_id = c.id AND r.code = 'OWNER'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

COMMIT;
