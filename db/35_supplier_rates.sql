-- =============================================================================
-- 35 · THE SUPPLIER KEEPS THEIR OWN PRICE LIST
--
-- Rates used to reach the system one way only: the buyer rang round, wrote
-- down what he was told, and typed it into the comparison. Three problems with
-- that — it is the buyer's memory of a price rather than the supplier's word,
-- it is only ever collected when somebody is already buying, and a supplier
-- who dropped his rate this morning has no way of saying so.
--
-- So the supplier posts his own rate per product from his panel, and the
-- office compares. supplier_quotes already holds exactly this shape, so this
-- adds no table: it marks who typed the number, and how long it stands for.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE supplier_quotes
  -- Who put this number in. A price the supplier stands behind and a price the
  -- buyer wrote down after a phone call are not the same fact, and the office
  -- should be able to see which it is looking at.
  ADD COLUMN IF NOT EXISTS quoted_by_supplier boolean NOT NULL DEFAULT false,
  -- A standing price is one the supplier keeps current, as opposed to a quote
  -- given against one particular requirement line.
  ADD COLUMN IF NOT EXISTS is_standing        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS note               text,
  ADD COLUMN IF NOT EXISTS superseded_at      timestamptz;

-- One live standing price per supplier and product. Changing a rate supersedes
-- the old one rather than overwriting it, so "what were they charging last
-- week" stays answerable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_standing_quote
    ON supplier_quotes (company_id, supplier_id, product_id)
 WHERE is_standing AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_standing_quote_product
    ON supplier_quotes (company_id, product_id)
 WHERE is_standing AND superseded_at IS NULL;

-- What the office reads when comparing. One row per supplier and product: the
-- live standing price, whether it has passed its valid-till, and how it sits
-- against what we last actually paid that supplier for it.
CREATE OR REPLACE VIEW v_supplier_rates AS
SELECT q.id                AS quote_id,
       q.company_id,
       q.supplier_id,
       COALESCE(s.trade_name, s.legal_name) AS supplier_name,
       s.source_type,
       s.status            AS supplier_status,
       q.product_id,
       p.name              AS product_name,
       p.sku,
       p.base_uom,
       q.quoted_rate,
       q.uom,
       q.available_qty,
       q.offered_grade,
       q.valid_till,
       q.note,
       q.quoted_by_supplier,
       q.updated_at        AS quoted_at,
       (q.valid_till IS NOT NULL AND q.valid_till < CURRENT_DATE) AS is_stale,
       sp.last_rate        AS last_paid_rate,
       sp.last_purchase_at,
       sp.tracking_code,
       -- Movement against what we last paid them, which is the number a buyer
       -- actually reacts to.
       CASE WHEN sp.last_rate IS NOT NULL AND sp.last_rate <> 0
            THEN round(((q.quoted_rate - sp.last_rate) / sp.last_rate) * 100, 2) END
                           AS change_pct
  FROM supplier_quotes q
  JOIN suppliers s ON s.id = q.supplier_id
  JOIN products  p ON p.id = q.product_id
  LEFT JOIN supplier_products sp
         ON sp.supplier_id = q.supplier_id AND sp.product_id = q.product_id
 WHERE q.is_standing AND q.superseded_at IS NULL;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('supplier.rate.update','supplier','rate','update',
  'Supplier sets their own rate for a product', false,'NORMAL'),
 ('purchase.rate.compare','purchase','rate','compare',
  'See what each supplier is asking for a product', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'SUPPLIER', ARRAY['supplier.rate.update']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_EXEC', ARRAY['purchase.rate.compare']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['purchase.rate.compare']);
        PERFORM grant_role_perms(c.id, 'OWNER',        ARRAY['purchase.rate.compare']);
    END LOOP;
END $$;

COMMIT;
