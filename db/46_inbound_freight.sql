-- =============================================================================
-- 46 · WHO PAID FOR THE LORRY IN
--
-- The leg from the warehouse to a shop already costs the product: a transfer
-- carries transport_cost, v_outbound_cost_per_kg spreads it over the kilos
-- moved, and v_batch_pricing adds it to true_cost before the margin. The leg
-- from the SUPPLIER to the warehouse had nowhere to be recorded at all.
--
-- It arrives one of two ways and the difference matters to Finance:
--
--   the supplier brings it   → it is part of what we owe them, so it belongs
--                              on their payment request, named separately so
--                              nobody is paying "goods" for a lorry
--   we send a vehicle        → it is our own cost, arranged on Dispatch and
--                              paid to whoever drove
--
-- Either way it is freight on the way in, and either way it should reach the
-- price the same way the outbound leg does.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* Both views read the columns below, so on a re-run they hold them fast and
 * nothing can be altered. Dropped first and rebuilt at the foot of the file;
 * nothing outside this file depends on either. */
/* CASCADE: db/54 builds v_product_pricing on top of this one, so once that
 * exists a bare DROP fails and every migration after this point stops. Both are
 * recreated further down the chain. */
DROP VIEW IF EXISTS v_batch_pricing CASCADE;
DROP VIEW IF EXISTS v_inbound_freight_per_kg;

-- What the supplier is charging to bring it, kept apart from the goods.
--
-- numeric, NOT money_amt: that domain is NOT NULL DEFAULT 0, so every request
-- ever raised would claim a freight of zero and there would be no way to say
-- "nobody has priced this". stock_issues.transport_cost is numeric(14,2) for
-- the same reason.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS transport_amount numeric(14,2);

/* Repair, for a database that ran the first cut of this file and got money_amt.
 *
 * The domain is NOT NULL DEFAULT 0, so ADD COLUMN wrote a 0 onto every request
 * ever raised — and Finance would then show "of which ₹0 is transport" against
 * forty claims that have nothing to do with a lorry. Those zeroes are the
 * default, not an answer anybody gave, so they go back to NULL.
 *
 * Guarded on the column still being NOT NULL so it runs exactly once and never
 * touches a fare somebody has since recorded.
 */
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'payment_requests'
                AND column_name = 'transport_amount' AND is_nullable = 'NO') THEN
    ALTER TABLE payment_requests ALTER COLUMN transport_amount TYPE numeric(14,2);
    ALTER TABLE payment_requests ALTER COLUMN transport_amount DROP DEFAULT;
    ALTER TABLE payment_requests ALTER COLUMN transport_amount DROP NOT NULL;
    UPDATE payment_requests SET transport_amount = NULL;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE payment_requests ADD CONSTRAINT ck_payreq_transport
    CHECK (transport_amount IS NULL
           OR (transport_amount >= 0 AND transport_amount <= amount::numeric));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN payment_requests.transport_amount IS
  'The freight inside this request, where the supplier is carrying. Part of '
  'amount, not on top of it — so Finance pays one figure and can still see '
  'what it is made of.';

-- What we are paying somebody to collect it. NULL means nobody has agreed a
-- fare yet, which is different from a trip that cost us nothing — Dispatch
-- shows the two differently and chases only the first.
ALTER TABLE pickups
  ADD COLUMN IF NOT EXISTS transport_cost numeric(14,2),
  ADD COLUMN IF NOT EXISTS cost_note      text;

-- The same repair, and the same reason: a 0 the domain wrote is not a fare of
-- nothing, and Dispatch chases the two differently.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'pickups'
                AND column_name = 'transport_cost' AND is_nullable = 'NO') THEN
    ALTER TABLE pickups ALTER COLUMN transport_cost TYPE numeric(14,2);
    ALTER TABLE pickups ALTER COLUMN transport_cost DROP DEFAULT;
    ALTER TABLE pickups ALTER COLUMN transport_cost DROP NOT NULL;
    UPDATE pickups SET transport_cost = NULL WHERE cost_note IS NULL;
  END IF;
END $$;

COMMENT ON COLUMN pickups.transport_cost IS
  'Our own freight for this collection. Raised with Finance as a TRANSPORT '
  'request, the same way a centre transfer raises one.';

/* ---------------------------------------------------------------- pricing --
 * Freight on the way in, per kilo, over the same window as the other two.
 * Both sources at once: what suppliers charged us for carriage, and what we
 * paid our own vehicles to fetch.
 */
CREATE VIEW v_inbound_freight_per_kg AS
WITH win AS (
  SELECT c.id AS company_id, GREATEST(c.overhead_window_days, 1) AS days FROM companies c
), supplier_carried AS (
  SELECT w.company_id,
         COALESCE(SUM(pr.transport_amount), 0) AS freight
    FROM win w
    LEFT JOIN payment_requests pr
           ON pr.company_id = w.company_id
          AND pr.transport_amount IS NOT NULL
          -- A claim Finance turned down is freight we are not paying, so it
          -- has no business in what the produce cost.
          AND pr.status NOT IN ('CANCELLED', 'REJECTED')
          AND pr.requested_at > now() - ((w.days || ' days')::interval)
   GROUP BY w.company_id
), we_collected AS (
  SELECT w.company_id,
         COALESCE(SUM(pk.transport_cost), 0) AS freight
    FROM win w
    LEFT JOIN pickups pk
           ON pk.company_id = w.company_id
          AND pk.transport_cost IS NOT NULL
          AND pk.status <> 'CANCELLED'
          AND pk.created_at > now() - ((w.days || ' days')::interval)
   GROUP BY w.company_id
), received AS (
  -- The kilos those lorries actually brought in.
  SELECT w.company_id, COALESCE(SUM(g.total_net_weight_kg), 0) AS kg
    FROM win w
    LEFT JOIN grns g ON g.company_id = w.company_id AND g.status = 'POSTED'
                    AND g.posting_date > CURRENT_DATE - w.days
   GROUP BY w.company_id
)
SELECT w.company_id,
       w.days                                   AS window_days,
       COALESCE(sc.freight, 0)                  AS supplier_carried,
       COALESCE(wc.freight, 0)                  AS we_collected,
       COALESCE(sc.freight, 0) + COALESCE(wc.freight, 0) AS inbound_spend,
       COALESCE(r.kg, 0)                        AS kg_received,
       CASE WHEN COALESCE(r.kg, 0) > 0
            THEN round((COALESCE(sc.freight, 0) + COALESCE(wc.freight, 0)) / r.kg, 4)
            ELSE 0 END                          AS inbound_per_kg
  FROM win w
  LEFT JOIN supplier_carried sc ON sc.company_id = w.company_id
  LEFT JOIN we_collected     wc ON wc.company_id = w.company_id
  LEFT JOIN received          r ON r.company_id = w.company_id;

/* v_batch_pricing gains the inbound leg. Same shape as before, one more term:
 *
 *     bought for + overheads + freight IN + freight OUT
 *   ────────────────────────────────────────────────────  × (1 + margin)
 *                    1 − wastage
 */
-- Dropped and recreated rather than replaced: CREATE OR REPLACE cannot insert
-- a column in the middle, and freight_in belongs beside the other two costs
-- rather than tacked on the end where nobody reading the row would find it.
-- Nothing else in the schema depends on this view; the application reads it by
-- name, and every column it read is still here. It is dropped at the head of
-- the file, with the inbound view it now depends on.
CREATE VIEW v_batch_pricing AS
WITH factor AS (
  SELECT b.id AS batch_id,
         CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
              THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
              ELSE 1 END AS kg_per_unit
    FROM batches b
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
                                                                         AS min_sell_price
  FROM batches b
  JOIN products  p ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN factor    f ON f.batch_id = b.id
  LEFT JOIN v_overhead_per_kg        o  ON o.company_id  = b.company_id
  LEFT JOIN v_inbound_freight_per_kg ib ON ib.company_id = b.company_id
  LEFT JOIN v_outbound_cost_per_kg   ob ON ob.company_id = b.company_id;

/* ---------------------------------------------------------------- the same,
 * per product.
 *
 * v_product_pricing carries the identical sum for the Cost & price screen —
 * the one place an admin sets "10% on tomato" and reads back what that means.
 * It computes its own total rather than reading v_batch_pricing, because it
 * averages across the batches in stock. Leaving the inbound leg out of it
 * would put a floor on that screen that disagrees with the floor on the
 * packing bench, and the person pricing the product would never know which
 * one to believe.
 *
 * Dropped and recreated for the same reason as above: freight_in belongs
 * between the two costs it sits between. Nothing depends on this view.
 */
DROP VIEW IF EXISTS v_product_pricing;
CREATE VIEW v_product_pricing AS
WITH live AS (
    SELECT b.company_id, b.product_id,
           SUM(b.landed_rate_per_kg * GREATEST(b.remaining_qty, 0)) AS weighted,
           SUM(GREATEST(b.remaining_qty, 0))                        AS qty
      FROM batches b
     WHERE b.status = 'ACTIVE' AND b.remaining_qty > 0
       AND COALESCE(b.landed_rate_per_kg, 0) > 0
     GROUP BY b.company_id, b.product_id
), latest AS (
    SELECT DISTINCT ON (b.company_id, b.product_id)
           b.company_id, b.product_id, b.landed_rate_per_kg
      FROM batches b
     WHERE COALESCE(b.landed_rate_per_kg, 0) > 0
     ORDER BY b.company_id, b.product_id, b.created_at DESC
), bought AS (
    SELECT p.id AS product_id,
           COALESCE(NULLIF(l.weighted / NULLIF(l.qty, 0), 0), lt.landed_rate_per_kg, 0) AS rate
      FROM products p
      LEFT JOIN live   l  ON l.product_id  = p.id
      LEFT JOIN latest lt ON lt.product_id = p.id
)
SELECT p.id                            AS product_id,
       p.company_id,
       p.sku,
       p.name                          AS product_name,
       p.icon,
       p.base_uom,
       p.category_id,
       COALESCE(l.qty, 0)              AS qty_on_hand,
       ROUND(bt.rate, 2)                                         AS cost_to_warehouse,
       ROUND(COALESCE(o.overhead_per_kg, 0), 2)                  AS overhead_cost,
       ROUND(COALESCE(ib.inbound_per_kg, 0), 2)                  AS freight_in,
       ROUND(COALESCE(ob.outbound_per_kg, 0), 2)                 AS cost_to_centre,
       ROUND(bt.rate
             + COALESCE(o.overhead_per_kg, 0)
             + COALESCE(ib.inbound_per_kg, 0)
             + COALESCE(ob.outbound_per_kg, 0), 2)               AS total_cost,
       COALESCE(p.default_wastage_pct, 0)                        AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)          AS margin_pct,
       (p.min_margin_pct IS NOT NULL)                            AS margin_is_own,
       p.sell_price,
       ROUND((bt.rate
              + COALESCE(o.overhead_per_kg, 0)
              + COALESCE(ib.inbound_per_kg, 0)
              + COALESCE(ob.outbound_per_kg, 0))
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                 AS min_sell_price
  FROM products p
  JOIN companies c ON c.id = p.company_id
  JOIN bought bt ON bt.product_id = p.id
  LEFT JOIN live   l  ON l.product_id  = p.id
  LEFT JOIN v_overhead_per_kg        o  ON o.company_id  = p.company_id
  LEFT JOIN v_inbound_freight_per_kg ib ON ib.company_id = p.company_id
  LEFT JOIN v_outbound_cost_per_kg   ob ON ob.company_id = p.company_id
 WHERE p.is_active;

GRANT SELECT ON v_inbound_freight_per_kg, v_batch_pricing, v_product_pricing
   TO chotug_app;
GRANT SELECT ON v_inbound_freight_per_kg, v_batch_pricing, v_product_pricing
   TO chotug_readonly;

COMMIT;
