-- =============================================================================
-- 48 · THE COST OF ONE OF WHAT WE ACTUALLY HOLD
--
-- v_batch_pricing.true_cost is per PURCHASE unit. Buy ten boxes of apples at
-- ₹500 a box and it is ₹670 — per box. Stock, however, is held in the product's
-- base unit, which for every fruit and vegetable here is the KILOGRAM: that
-- same batch sits in stock_balances as 100 kg, and the packing bench asks for
-- "how much in each box" in kilograms.
--
-- So the bench was multiplying a per-BOX cost by a number of KILOGRAMS:
--
--     mango bought at ₹68 a box, 15 kg to the box  →  ₹4.53 a kilo
--     a 5 kg box of it was priced at             ₹1,979
--     it should have been                          ₹132
--
-- Fifteen times over, and in the direction nobody notices, because a price that
-- is too high does not bounce — it just does not sell, and the produce rots
-- while everyone blames the market.
--
-- The fix is to say the cost per unit HELD, not per unit bought, and to price
-- from that. Both are kept: landed cost per purchase unit is what Finance
-- reconciles against an invoice, and per held unit is what a label is worked
-- out from. They were never the same number and the view only ever had one.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DROP VIEW IF EXISTS v_batch_pricing;
CREATE VIEW v_batch_pricing AS
WITH factor AS (
  SELECT b.id AS batch_id,
         /* Kilograms in one purchase unit, from the two rates the receipt
          * already computed. A batch bought by the kilo has one. */
         CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
              THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
              ELSE 1 END AS kg_per_unit
    FROM batches b
), held AS (
  /* One unit of what we HOLD, and what a kilo of the stuff cost.
   *
   * For anything measured in kilos — every fruit and vegetable here — the held
   * unit IS the kilogram, and landed_rate_per_kg is already the right number.
   * For a product genuinely counted in boxes, the held unit is the box and the
   * per-kilo overheads have to be scaled by its weight. */
  SELECT b.id AS batch_id,
         CASE WHEN p.base_uom = 'KG' THEN 1 ELSE f.kg_per_unit END       AS kg_per_held_unit,
         CASE WHEN p.base_uom = 'KG' THEN COALESCE(b.landed_rate_per_kg, 0)
              ELSE COALESCE(b.landed_rate, 0) END                        AS held_rate
    FROM batches b
    JOIN products p ON p.id = b.product_id
    JOIN factor   f ON f.batch_id = b.id
)
SELECT b.id AS batch_id, b.company_id, b.product_id, p.name AS product_name, b.batch_no,
       b.landed_rate, b.landed_rate_per_kg,
       o.overhead_per_kg,
       ib.inbound_per_kg,
       ob.outbound_per_kg,
       round(COALESCE(b.landed_rate, 0), 2)                              AS cost_to_warehouse,
       round(COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit, 2)         AS overhead_cost,
       round(COALESCE(ib.inbound_per_kg, 0)  * f.kg_per_unit, 2)         AS freight_in,
       round(COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit, 2)         AS cost_to_centre,
       COALESCE(p.default_wastage_pct, 0)                                AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)                  AS margin_pct,
       /* Per PURCHASE unit — what Finance reconciles against the invoice. */
       round(COALESCE(b.landed_rate, 0)
             + COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit
             + COALESCE(ib.inbound_per_kg, 0)  * f.kg_per_unit
             + COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit, 2)       AS true_cost,
       round((COALESCE(b.landed_rate, 0)
              + COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit
              + COALESCE(ib.inbound_per_kg, 0)  * f.kg_per_unit
              + COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit)
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                         AS min_sell_price,
       /* Per unit HELD — what a label on a box is worked out from. This is the
        * one the packing bench must use: it is in the same unit the bench types
        * its box size in, and the one stock is counted in. */
       h.kg_per_held_unit,
       p.base_uom,
       round(h.held_rate
             + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ob.outbound_per_kg, 0) * h.kg_per_held_unit, 4)  AS true_cost_per_held_unit,
       round((h.held_rate
              + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
              + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit
              + COALESCE(ob.outbound_per_kg, 0) * h.kg_per_held_unit)
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 4)
                                                                         AS min_sell_per_held_unit
  FROM batches b
  JOIN products  p ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN factor    f ON f.batch_id = b.id
  JOIN held      h ON h.batch_id = b.id
  LEFT JOIN v_overhead_per_kg        o  ON o.company_id  = b.company_id
  LEFT JOIN v_inbound_freight_per_kg ib ON ib.company_id = b.company_id
  LEFT JOIN v_outbound_cost_per_kg   ob ON ob.company_id = b.company_id;

COMMENT ON COLUMN v_batch_pricing.true_cost_per_held_unit IS
  'What one of what we HOLD cost — a kilo for anything measured in kilos. Price '
  'labels from this. true_cost is per purchase unit and is not the same number '
  'whenever a box holds more than one kilo. See db/48.';

GRANT SELECT ON v_batch_pricing TO chotug_app;
GRANT SELECT ON v_batch_pricing TO chotug_readonly;

COMMIT;
