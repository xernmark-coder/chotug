-- =============================================================================
-- 53 · PRICE FROM WHAT WAS BOOKED, NOT FROM WHAT THE UNIT IS CALLED
--
-- db/52 fixed how stock is VALUED. The label price still worked off
-- landed_rate_per_kg, which is the same guess db/52 threw away:
--
--   Apple · 219 boxes · 50 kg weighed · paid ₹6,789 · booked as 219
--     the truth                       ₹31.00 for one of what we hold
--     v_batch_pricing was using       ₹135.78
--     a 5 kg box would have been      four times its price
--
-- Two numbers are needed and both are recorded, so neither has to be guessed:
--
--   cost of one held unit  = landed value ÷ initial_qty     (db/52)
--   kilos in one held unit = net weight   ÷ initial_qty
--
-- The second matters because handling and both freight legs are quoted PER
-- KILO. A held unit that is a 0.23 kg box must carry 0.23 of them, not one.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* CASCADE: db/54 builds v_product_pricing on top of this one, so once that
 * exists a bare DROP fails and every migration after this point stops. Both are
 * recreated further down the chain. */
DROP VIEW IF EXISTS v_batch_pricing CASCADE;
CREATE VIEW v_batch_pricing AS
WITH factor AS (
  SELECT b.id AS batch_id,
         CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
              THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
              ELSE 1 END AS kg_per_unit
    FROM batches b
), held AS (
  SELECT b.id AS batch_id,
         /* Kilos in one unit of stock. Where a weighbridge reading exists this
          * is exact; where none does, stock was booked in the accepted quantity
          * and the per-kilo figures apply to it one for one. */
         CASE WHEN COALESCE(b.initial_qty, 0) > 0
                   AND COALESCE(gl.net_weight_kg, 0) > 0
              THEN gl.net_weight_kg / b.initial_qty
              ELSE 1 END                                              AS kg_per_held_unit
    FROM batches b
    LEFT JOIN grn_lines gl ON gl.id = b.grn_line_id
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
       h.kg_per_held_unit,
       p.base_uom,
       /* Everything below is per unit of what we HOLD — the unit the packing
        * bench types its box size in, and the one stock is counted in. */
       round(uc.landed_per_held_unit
             + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ob.outbound_per_kg, 0) * h.kg_per_held_unit, 4)  AS true_cost_per_held_unit,
       round((uc.landed_per_held_unit
              + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
              + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit
              + COALESCE(ob.outbound_per_kg, 0) * h.kg_per_held_unit)
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 4)
                                                                         AS min_sell_per_held_unit,
       /* Before it goes anywhere. The bench adds the chosen shop's leg. */
       round(uc.landed_per_held_unit
             + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit, 4)  AS cost_before_delivery
  FROM batches b
  JOIN products  p ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN factor    f ON f.batch_id = b.id
  JOIN held      h ON h.batch_id = b.id
  JOIN v_batch_unit_cost uc ON uc.batch_id = b.id
  LEFT JOIN v_overhead_per_kg        o  ON o.company_id  = b.company_id
  LEFT JOIN v_inbound_freight_per_kg ib ON ib.company_id = b.company_id
  LEFT JOIN v_outbound_cost_per_kg   ob ON ob.company_id = b.company_id;

GRANT SELECT ON v_batch_pricing TO chotug_app;
GRANT SELECT ON v_batch_pricing TO chotug_readonly;

COMMIT;
