-- =============================================================================
-- 52 · THE UNIT COST, DERIVED FROM WHAT WAS ACTUALLY BOOKED
--
-- db/49 decided the cost of one held unit by looking at the product's base_uom:
-- "if it is measured in kilos, use landed_rate_per_kg". That is a guess about
-- what stock_balances.qty contains, and the guess is wrong for six batches.
--
-- Receiving books stock as the NET WEIGHT when one was measured, and as the
-- accepted quantity when none was — so a KG product bought as 219 boxes with no
-- weighbridge reading sits in stock as "219", and one with a reading sits as
-- "50". Both are called kilograms. The rates diverge in exactly that gap:
--
--   Apple · 219 boxes · 50 kg weighed · paid ₹6,789
--     landed_rate         ₹31.00 per box
--     landed_rate_per_kg  ₹135.78 per kilo
--     stock says          219
--     db/49 valued it     219 × 135.78 = ₹29,736      ← four times over
--
-- There is no need to guess. What we paid for the batch and how much of it went
-- into stock are both recorded, and their ratio is the cost of one unit of
-- whatever stock is counted in — boxes, crates or kilos, without asking which:
--
--     landed value ÷ initial_qty
--
-- Exact by construction, for every batch, in every unit. No base_uom anywhere.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Dropped and recreated: landed_value goes in the middle, and CREATE OR
-- REPLACE cannot move a column. Nothing in the schema depends on this view.
DROP VIEW IF EXISTS v_batch_unit_cost;
CREATE VIEW v_batch_unit_cost AS
SELECT b.id                                       AS batch_id,
       b.company_id,
       b.product_id,
       p.base_uom,
       CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
            THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
            ELSE 1 END                             AS kg_per_purchase_unit,
       /* What the whole batch cost, landed: the quantity the receipt accepted
        * at the rate it was landed at. */
       round(COALESCE(gl.accepted_qty, b.initial_qty, 0)
             * COALESCE(b.landed_rate, 0), 4)      AS landed_value,
       /* …over what went into stock. Whatever unit that is, this is the cost of
        * one of them, and it multiplies correctly against stock_balances.qty,
        * packs.qty and stock_issue_lines.qty because those are the same unit.
        *
        * Falls back to the rate itself where a batch has no receipt behind it —
        * an opening balance, or produce off our own farm. */
       CASE WHEN COALESCE(b.initial_qty, 0) > 0 AND gl.accepted_qty IS NOT NULL
            THEN round(gl.accepted_qty * COALESCE(b.landed_rate, 0) / b.initial_qty, 4)
            ELSE COALESCE(b.landed_rate_per_kg, b.landed_rate, 0)
       END                                         AS landed_per_held_unit
  FROM batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN grn_lines gl ON gl.id = b.grn_line_id;

COMMENT ON VIEW v_batch_unit_cost IS
  'The landed cost of one unit of what we HOLD — what the batch cost divided by '
  'what went into stock. Multiplies correctly against stock_balances.qty, '
  'packs.qty and stock_issue_lines.qty without knowing what unit they are in. '
  'See db/52.';

GRANT SELECT ON v_batch_unit_cost TO chotug_app;
GRANT SELECT ON v_batch_unit_cost TO chotug_readonly;

COMMIT;
