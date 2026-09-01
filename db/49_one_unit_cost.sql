-- =============================================================================
-- 49 · ONE COST PER UNIT OF WHAT WE HOLD
--
-- db/48 fixed the price on a label. The same mistake was in nine other places,
-- and it is the same mistake every time:
--
--     batches.landed_rate        is per PURCHASE unit   (a box, a crate)
--     stock_balances.qty         is in the BASE unit    (a kilogram)
--     stock_issue_lines.qty      is in the BASE unit
--     packs.qty                  is in the BASE unit
--
-- so `SUM(qty * landed_rate)` reads a hundred kilos of apples bought as ten
-- ₹500 boxes as ₹50,000 of stock instead of ₹5,000. Ten times over, in the
-- cost of goods sold on the performance page, in what a centre is holding, in
-- what is on a shelf, in what a sale cost us — every margin in the system.
--
-- Nine sites each writing `qty * landed_rate` is nine chances to get it wrong
-- and nine places to fix it again next time. So: one view, joined by batch,
-- giving the cost of ONE of what we hold. There is nothing to remember.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- DROP first: db/52 widens this view, and CREATE OR REPLACE cannot shrink one
-- back on a re-run. Nothing in the schema depends on it.
DROP VIEW IF EXISTS v_batch_unit_cost CASCADE;
CREATE VIEW v_batch_unit_cost AS
SELECT b.id                                       AS batch_id,
       b.company_id,
       b.product_id,
       p.base_uom,
       /* Kilograms in one purchase unit, from the two rates the receipt already
        * computed against each other. A batch bought by the kilo has one. */
       CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
            THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
            ELSE 1 END                             AS kg_per_purchase_unit,
       /* What one unit of what we HOLD cost us, landed. Multiply this by a
        * quantity out of stock_balances, packs or a stock issue — they are all
        * counted in the base unit — and the answer is money.
        *
        * NEVER multiply landed_rate by one of those quantities. That is the
        * bug this view exists to end. */
       CASE WHEN p.base_uom = 'KG'
            THEN COALESCE(b.landed_rate_per_kg, b.landed_rate, 0)
            ELSE COALESCE(b.landed_rate, 0) END    AS landed_per_held_unit
  FROM batches b
  JOIN products p ON p.id = b.product_id;

COMMENT ON VIEW v_batch_unit_cost IS
  'The landed cost of one unit of what we HOLD. Join this and multiply by any '
  'base-unit quantity. batches.landed_rate is per PURCHASE unit and multiplying '
  'it by kilograms overstates stock by the weight of a box. See db/49.';

GRANT SELECT ON v_batch_unit_cost TO chotug_app;
GRANT SELECT ON v_batch_unit_cost TO chotug_readonly;

COMMIT;
