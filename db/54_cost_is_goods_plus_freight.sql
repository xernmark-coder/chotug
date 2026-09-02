-- =============================================================================
-- 54 · A UNIT COSTS THE GOODS PLUS THE JOURNEY. NOTHING ELSE.
--
--   "the total cost per product should be calculated as purchase price + price
--    of travel to warehouse, also … the cost to travel to that center optional.
--    no other cost … divide this cost total by the only accepted product so get
--    price per unit. and then margin will come on this unit price per product …
--    no other cost of labour or other should be added."
--
-- Four things were going into the price that this rule does not allow, and one
-- of them was going in twice.
--
--   1. DOUBLE-COUNTED FREIGHT IN. autoFreightCharges() writes the supplier's
--      transport charge and the pickup fare onto the receipt as a TRANSPORT
--      charge, which is allocated across the lines and is therefore already
--      inside landed_rate. v_inbound_freight_per_kg then took those SAME two
--      sources, averaged them over the company's last 30 days, and db/53 added
--      the average on top. Every batch was carrying its own freight plus a
--      share of everybody else's.
--
--   2. COMPANY OVERHEAD — wages, power, rent, cold storage, cleaning, repairs,
--      divided by the month's kilos. Not the goods, and not the journey.
--
--   3. A WASTAGE DIVISION. `÷ (1 − wastage%)` inflated every price by a
--      forecast of produce not yet thrown away — while the divisor upstream is
--      already the ACCEPTED quantity, so what was rejected at the gate is
--      paid for by the units that were kept. The same loss, charged twice.
--
--   4. AN AVERAGED TRIP OUT. The outbound leg was a company-wide rate per kilo.
--      The client asked for the cost of the trip to THAT centre, optionally
--      entered on the transfer that made it — so that is what is used, and a
--      batch that has not been sent anywhere carries nothing for a journey it
--      has not made.
--
-- What is left:
--
--      unit cost = landed_rate (= purchase + freight in, ÷ accepted qty)
--                + the actual freight out, if any
--      floor     = unit cost × (1 + margin%)
--
-- Every column db/53 published survives, so the sell screen, the pack bench and
-- the catalogue keep reading the same names. overhead_per_kg and inbound_per_kg
-- are still there and now read zero — a column that quietly changes meaning is
-- worse than one that plainly reports nought.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ------------------------------------------ only the journey is a charge -- */
/* Hamali is labour, packing is packing, a market fee is a fee. All still
 * recorded against the receipt; they simply stop being allocated into the
 * price of a unit. An admin who disagrees can switch any of them back on —
 * this sets the default the client asked for rather than hard-coding it. */
UPDATE charge_types SET affects_landing_cost = false
 WHERE code NOT IN ('TRANSPORT', 'TOLL') AND affects_landing_cost;
UPDATE charge_types SET affects_landing_cost = true
 WHERE code IN ('TRANSPORT', 'TOLL') AND NOT affects_landing_cost;

/* --------------------------- what the trip to a shop actually cost, if any -- */
/* stock_issues.transport_cost is the optional figure typed on the transfer. It
 * covers the whole lorry, so it is split across that lorry's lines by quantity
 * — in the unit the line is counted in, which is the unit stock is held in, so
 * no kilo conversion is needed or wanted. A batch sent twice carries the
 * quantity-weighted average of the two trips. */
CREATE OR REPLACE VIEW v_batch_outbound_cost AS
WITH trip AS (
    SELECT si.id AS issue_id, si.company_id,
           COALESCE(si.transport_cost, 0) AS freight,
           NULLIF(SUM(sil.qty), 0)        AS trip_qty
      FROM stock_issues si
      JOIN stock_issue_lines sil ON sil.issue_id = si.id
     WHERE si.dest_warehouse_id IS NOT NULL
       AND si.status <> 'CANCELLED'
       AND COALESCE(si.transport_cost, 0) > 0
     GROUP BY si.id, si.company_id, si.transport_cost
)
SELECT sil.batch_id, t.company_id,
       SUM(t.freight * (sil.qty / t.trip_qty))                            AS outbound_spend,
       SUM(sil.qty)                                                       AS qty_moved,
       round(SUM(t.freight * (sil.qty / t.trip_qty)) / NULLIF(SUM(sil.qty), 0), 4)
                                                                          AS outbound_per_unit,
       count(DISTINCT t.issue_id)::int                                    AS trips
  FROM trip t
  JOIN stock_issue_lines sil ON sil.issue_id = t.issue_id
 WHERE sil.batch_id IS NOT NULL
 GROUP BY sil.batch_id, t.company_id;

/* ------------------------------------------------------- the unit price -- */
/* CASCADE: db/54 builds v_product_pricing on top of this one, so once that
 * exists a bare DROP fails and every migration after this point stops. Both are
 * recreated further down the chain. */
DROP VIEW IF EXISTS v_batch_pricing CASCADE;
CREATE VIEW v_batch_pricing AS
WITH held AS (
  SELECT b.id AS batch_id,
         CASE WHEN COALESCE(b.initial_qty, 0) > 0
                   AND COALESCE(gl.net_weight_kg, 0) > 0
              THEN gl.net_weight_kg / b.initial_qty
              ELSE 1 END AS kg_per_held_unit
    FROM batches b
    LEFT JOIN grn_lines gl ON gl.id = b.grn_line_id
)
SELECT b.id AS batch_id, b.company_id, b.product_id, p.name AS product_name, b.batch_no,
       b.landed_rate, b.landed_rate_per_kg,
       /* Kept for every screen that reads them. Zero by rule: neither the cost
        * of being open nor an average of other people's lorries belongs in the
        * price of this crate. The freight that DID bring it is inside
        * landed_rate already — see freight_in below. */
       0::numeric                                                         AS overhead_per_kg,
       0::numeric                                                         AS overhead_cost,
       0::numeric                                                         AS inbound_per_kg,
       COALESCE(ob.outbound_per_unit, 0)                                  AS outbound_per_kg,
       /* What we paid plus the freight that brought it, already divided by the
        * quantity accepted — that division is what landed_rate is. */
       round(COALESCE(b.landed_rate, 0), 2)                               AS cost_to_warehouse,
       /* The freight part of it, split out to be read, NOT to be added again. */
       round(COALESCE(lcl.allocated_total, 0)
             / NULLIF(GREATEST(b.initial_qty, 0), 0), 2)                  AS freight_in,
       round(COALESCE(ob.outbound_per_unit, 0), 2)                        AS cost_to_centre,
       COALESCE(p.default_wastage_pct, 0)                                 AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)                   AS margin_pct,
       round(COALESCE(b.landed_rate, 0) + COALESCE(ob.outbound_per_unit, 0), 2)
                                                                          AS true_cost,
       /* Margin straight onto the unit cost. No wastage division.
        *
        * Applied to the ROUNDED cost, not the raw one, so the two figures on
        * screen reconcile: somebody checking ₹17.43 × 1.15 on a calculator has
        * to get the floor this prints, and off-by-a-paisa is how a person stops
        * trusting a page of money. */
       round(round(COALESCE(b.landed_rate, 0) + COALESCE(ob.outbound_per_unit, 0), 2)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                          AS min_sell_price,
       h.kg_per_held_unit,
       p.base_uom,
       /* Per unit of what we HOLD — the unit the bench types its box size in.
        * db/52 works out the landed cost of one held unit; the trip out is
        * already per held unit, because a transfer line is counted in it. */
       round(uc.landed_per_held_unit + COALESCE(ob.outbound_per_unit, 0), 4)
                                                                          AS true_cost_per_held_unit,
       round((uc.landed_per_held_unit + COALESCE(ob.outbound_per_unit, 0))
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 4)
                                                                          AS min_sell_per_held_unit,
       /* Before it goes anywhere. The bench adds the chosen shop's leg. */
       round(uc.landed_per_held_unit, 4)                                  AS cost_before_delivery
  FROM batches b
  JOIN products  p ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN held      h ON h.batch_id = b.id
  JOIN v_batch_unit_cost uc ON uc.batch_id = b.id
  LEFT JOIN v_batch_outbound_cost ob ON ob.batch_id = b.id
  LEFT JOIN landing_cost_lines lcl ON lcl.batch_id = b.id;

GRANT SELECT ON v_batch_pricing, v_batch_outbound_cost TO chotug_app;
GRANT SELECT ON v_batch_pricing, v_batch_outbound_cost TO chotug_readonly;

/* ------------------------------------------------- the history it wrote --- */
/* Every landed cost already stored carries the wastage provision this file
 * removes, so every batch in the building is still priced with it. New receipts
 * would be costed the new way and old ones the old way, and the two would sit
 * side by side on the same screen with no way to tell them apart.
 *
 * The provision is a recorded number, so undoing it is arithmetic rather than a
 * recompute: take it back off the landed value and divide again by the quantity
 * that was accepted. Guarded on the provision being non-zero, so this runs once
 * and is a no-op ever after.
 */
UPDATE landing_cost_lines lcl
   SET landed_value       = lcl.landed_value - lcl.wastage_amount,
       landed_rate_per_uom = CASE WHEN COALESCE(lcl.accepted_qty, 0) > 0
              THEN round((lcl.landed_value - lcl.wastage_amount) / lcl.accepted_qty, 6)
              ELSE lcl.landed_rate_per_uom END,
       landed_rate_per_kg  = CASE WHEN COALESCE(lcl.accepted_weight_kg, 0) > 0
              THEN round((lcl.landed_value - lcl.wastage_amount) / lcl.accepted_weight_kg, 6)
              ELSE lcl.landed_rate_per_kg END,
       wastage_amount      = 0
 WHERE lcl.wastage_amount <> 0;

UPDATE landing_costs lc
   SET total_landed      = lc.total_landed - lc.wastage_provision,
       wastage_provision = 0
 WHERE lc.wastage_provision <> 0;

/* The batches themselves carry a copy of the rate, and it is the copy every
 * pricing view reads. Re-pointed at the corrected line. */
UPDATE batches b
   SET landed_rate        = lcl.landed_rate_per_uom,
       landed_rate_per_kg = lcl.landed_rate_per_kg
  FROM landing_cost_lines lcl
 WHERE lcl.batch_id = b.id
   AND lcl.landed_rate_per_uom IS NOT NULL
   AND b.landed_rate IS DISTINCT FROM lcl.landed_rate_per_uom;


/* ------------------------------------------ the same sum, per product ---- */
/* Derived FROM v_batch_pricing rather than rebuilt beside it. The catalogue and
 * the sell screen were each doing their own version of this arithmetic and had
 * already drifted apart — this one cannot, because there is only one sum and
 * the product view is a weighted average of it.
 *
 * Weighted by what is actually on hand, so the figure moves as the older,
 * cheaper stock sells through. A product with nothing left falls back to its
 * most recent batch, because a price has to exist before the next lorry does. */
DROP VIEW IF EXISTS v_product_pricing;
CREATE VIEW v_product_pricing AS
WITH live AS (
    SELECT bp.company_id, bp.product_id,
           SUM(bp.cost_to_warehouse * GREATEST(b.remaining_qty, 0)) AS w_in,
           SUM(bp.cost_to_centre    * GREATEST(b.remaining_qty, 0)) AS w_out,
           SUM(GREATEST(b.remaining_qty, 0))                        AS qty
      FROM v_batch_pricing bp
      JOIN batches b ON b.id = bp.batch_id
     WHERE b.status = 'ACTIVE' AND b.remaining_qty > 0 AND bp.cost_to_warehouse > 0
     GROUP BY bp.company_id, bp.product_id
), latest AS (
    SELECT DISTINCT ON (bp.company_id, bp.product_id)
           bp.company_id, bp.product_id, bp.cost_to_warehouse, bp.cost_to_centre
      FROM v_batch_pricing bp
      JOIN batches b ON b.id = bp.batch_id
     WHERE bp.cost_to_warehouse > 0
     ORDER BY bp.company_id, bp.product_id, b.created_at DESC
)
SELECT p.id AS product_id, p.company_id, p.sku, p.name AS product_name, p.icon,
       p.base_uom, p.category_id,
       COALESCE(l.qty, 0)                                            AS qty_on_hand,
       round(COALESCE(l.w_in  / NULLIF(l.qty, 0), lt.cost_to_warehouse, 0), 2) AS cost_to_warehouse,
       0::numeric                                                    AS overhead_cost,
       round(COALESCE(l.w_out / NULLIF(l.qty, 0), lt.cost_to_centre,  0), 2)   AS cost_to_centre,
       round(COALESCE(l.w_in  / NULLIF(l.qty, 0), lt.cost_to_warehouse, 0)
           + COALESCE(l.w_out / NULLIF(l.qty, 0), lt.cost_to_centre,  0), 2)   AS total_cost,
       COALESCE(p.default_wastage_pct, 0)                            AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)              AS margin_pct,
       (p.min_margin_pct IS NOT NULL)                                AS margin_is_own,
       p.sell_price,
       /* Off the rounded total, so cost × margin = floor exactly as printed. */
       round(round(COALESCE(l.w_in  / NULLIF(l.qty, 0), lt.cost_to_warehouse, 0)
                 + COALESCE(l.w_out / NULLIF(l.qty, 0), lt.cost_to_centre,  0), 2)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                     AS min_sell_price
  FROM products p
  JOIN companies c ON c.id = p.company_id
  LEFT JOIN live   l  ON l.product_id  = p.id
  LEFT JOIN latest lt ON lt.product_id = p.id
 WHERE p.is_active;

GRANT SELECT ON v_product_pricing TO chotug_app;
GRANT SELECT ON v_product_pricing TO chotug_readonly;

COMMIT;
