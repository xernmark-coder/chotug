-- =============================================================================
-- 51 · THE COST BEFORE IT GOES ANYWHERE
--
-- v_batch_pricing folds the outbound leg into true_cost. That is right for a
-- report written after the fact and wrong for a label written before: at the
-- bench nobody knows yet whether the box travels, so the price cannot already
-- contain an average of everybody else's journeys.
--
-- So the view now also says what a unit costs BEFORE it goes anywhere. The
-- bench takes that, adds the rate for the destination the packer chose, and
-- prices from the sum. Sell it here and no delivery is charged at all.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DROP VIEW IF EXISTS v_batch_pricing;
CREATE VIEW v_batch_pricing AS
WITH factor AS (
  SELECT b.id AS batch_id,
         CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
              THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
              ELSE 1 END AS kg_per_unit
    FROM batches b
), held AS (
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
                                                                         AS min_sell_per_held_unit,
       /* What one held unit cost BEFORE it goes anywhere — bought, handled and
        * carried IN, with no delivery in it. The packing bench adds the rate
        * for the destination the packer picks, and nothing at all when the box
        * is being sold where it stands. */
       round(h.held_rate
             + COALESCE(o.overhead_per_kg, 0)  * h.kg_per_held_unit
             + COALESCE(ib.inbound_per_kg, 0)  * h.kg_per_held_unit, 4)  AS cost_before_delivery
  FROM batches b
  JOIN products  p ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN factor    f ON f.batch_id = b.id
  JOIN held      h ON h.batch_id = b.id
  LEFT JOIN v_overhead_per_kg        o  ON o.company_id  = b.company_id
  LEFT JOIN v_inbound_freight_per_kg ib ON ib.company_id = b.company_id
  LEFT JOIN v_outbound_cost_per_kg   ob ON ob.company_id = b.company_id;

GRANT SELECT ON v_batch_pricing TO chotug_app;
GRANT SELECT ON v_batch_pricing TO chotug_readonly;

COMMIT;
