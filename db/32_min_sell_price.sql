-- =============================================================================
-- 32 · WHAT IT REALLY COST, AND THE LEAST WE CAN SELL IT FOR
--
--   "there should be proper visible pricing of each product such as it bought
--    for this, total expense on this is this much including everything, labour
--    storage transport, so this should be minimum price to sell it for profit."
--
-- The batch already carries `landed_rate` — the purchase price plus the charges
-- booked against that specific load (freight on that lorry, mandi commission on
-- that deal). What it does NOT carry is the cost of simply running the place:
-- the wages, the electricity, the cold storage, the rent. Those are paid
-- monthly against no particular crate, and they are exactly what the client
-- means by "total expense on this including everything".
--
-- So the overhead is derived, not typed:
--
--     overhead per kg  =  operating expenses actually PAID in the window
--                         ÷  kilos actually RECEIVED in the window
--
-- Both sides are facts already in the system. It moves as the business moves,
-- and nobody has to remember to update a number.
--
--     true cost      = landed rate + overhead
--     minimum price  = true cost ÷ (1 − wastage%) × (1 + margin%)
--
-- The wastage division rather than multiplication is the part that gets done
-- wrong: if a tenth of a crate is thrown away, the nine tenths that sell have
-- to carry the whole crate's cost.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS min_margin_pct numeric(6,2),
  ADD COLUMN IF NOT EXISTS sell_price     numeric(14,2);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS default_margin_pct numeric(6,2) NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS overhead_window_days int NOT NULL DEFAULT 30;

/* Only expenses that are genuinely the cost of handling produce. Rent of a
 * centre is; an advance to a supplier is not — that is the purchase price
 * arriving early, and counting it here would charge the same rupee twice. */
UPDATE expense_categories SET affects_landed_cost = true
 WHERE code IN ('WAGES','ELECTRICITY','COLD_STORAGE','CLEANING','PACKING','RENT','REPAIRS')
   AND affects_landed_cost = false;

/* What the business spends to run, per kilo it handles. One definition, in the
 * database, so the sell screen and the performance report cannot each invent
 * their own overhead. */
CREATE OR REPLACE VIEW v_overhead_per_kg AS
WITH win AS (
    SELECT c.id AS company_id,
           GREATEST(c.overhead_window_days, 1) AS days
      FROM companies c
), spend AS (
    SELECT w.company_id,
           COALESCE(SUM(p.amount), 0) AS operating_spend
      FROM win w
      LEFT JOIN payment_requests pr ON pr.company_id = w.company_id
      LEFT JOIN expense_categories ec ON ec.id = pr.expense_category_id
                                     AND ec.affects_landed_cost
      LEFT JOIN payments p ON p.request_id = pr.id AND p.status = 'POSTED'
                          AND p.paid_at > now() - (w.days || ' days')::interval
     WHERE ec.id IS NOT NULL
     GROUP BY w.company_id
), handled AS (
    SELECT w.company_id,
           COALESCE(SUM(g.total_net_weight_kg), 0) AS kg
      FROM win w
      LEFT JOIN grns g ON g.company_id = w.company_id AND g.status = 'POSTED'
                      AND g.posting_date > CURRENT_DATE - w.days
     GROUP BY w.company_id
)
SELECT w.company_id,
       w.days                                   AS window_days,
       COALESCE(s.operating_spend, 0)           AS operating_spend,
       COALESCE(h.kg, 0)                        AS kg_handled,
       CASE WHEN COALESCE(h.kg, 0) > 0
            THEN ROUND(COALESCE(s.operating_spend, 0) / h.kg, 4)
            ELSE 0 END                          AS overhead_per_kg
  FROM win w
  LEFT JOIN spend s   ON s.company_id = w.company_id
  LEFT JOIN handled h ON h.company_id = w.company_id;

/* The number the person at the till needs, per batch, computed once.
 *
 * DROP first rather than CREATE OR REPLACE. 41_dues_costing_and_qc_area
 * rebuilds this view with the outbound freight in it, and Postgres refuses to
 * REPLACE a view with fewer columns than the one already there — so on any
 * database that has reached 41, re-running this file failed and every
 * migration after it was skipped. Nothing in the schema selects from this view;
 * only application queries do. */
/* CASCADE: db/54 builds v_product_pricing on top of this one, so once that
 * exists a bare DROP fails and every migration after this point stops. Both are
 * recreated further down the chain. */
DROP VIEW IF EXISTS v_batch_pricing CASCADE;
CREATE VIEW v_batch_pricing AS
SELECT b.id                       AS batch_id,
       b.company_id,
       b.product_id,
       p.name                     AS product_name,
       b.batch_no,
       b.landed_rate,
       b.landed_rate_per_kg,
       o.overhead_per_kg,
       COALESCE(p.default_wastage_pct, 0)                       AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)         AS margin_pct,
       /* Overhead is priced per kilo; a batch sold by the crate carries it via
        * its own kg-per-unit ratio rather than a guess. */
       ROUND(COALESCE(b.landed_rate, 0)
             + COALESCE(o.overhead_per_kg, 0)
               * CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
                      THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
                      ELSE 1 END, 2)                            AS true_cost,
       ROUND((COALESCE(b.landed_rate, 0)
              + COALESCE(o.overhead_per_kg, 0)
                * CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
                       THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
                       ELSE 1 END)
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                AS min_sell_price
  FROM batches b
  JOIN products p  ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  LEFT JOIN v_overhead_per_kg o ON o.company_id = b.company_id;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES ('master.pricing.manage','master','pricing','manage',
        'Set the margin and selling price for a product', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER',        ARRAY['master.pricing.manage']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['master.pricing.manage']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['master.pricing.manage']);
    END LOOP;
END $$;

COMMIT;
