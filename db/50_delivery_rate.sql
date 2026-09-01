-- =============================================================================
-- 50 · WHAT IT COSTS TO GET IT TO THAT SHOP, AND WHO SAYS SO
--
-- The leg from the warehouse to a centre was a single company-wide average —
-- ₹3,740 over 414 kg = ₹9.03 — added to EVERY label at the packing bench,
-- before anybody knew where the box was going. Two things wrong with that:
--
--   · 90% of revenue is sold at the warehouse itself. Those boxes carried ₹9 a
--     kilo for a journey they never took — ₹45 on a 5 kg box.
--   · The Kothrud run actually costs ₹22.80 a kilo. Boxes that DID travel were
--     under-recovering by ₹13.77, and the average hid both.
--
-- So the destination is now chosen at the bench, where the boxes are, and the
-- rate for that destination goes into that box's price and no other's.
--
-- The rate is SET, not only derived. History tells you what the last few trips
-- cost; it cannot tell you what the next one will, and a centre opened last
-- week has no history at all. An admin types the number and it stays typed.
-- Where nobody has typed one, the actual trips answer instead — better a
-- measured number than a zero.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ------------------------------------------------------- the settable rate -- */
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS delivery_rate_per_kg numeric(14,4),
  ADD COLUMN IF NOT EXISTS delivery_rate_note   text,
  ADD COLUMN IF NOT EXISTS delivery_rate_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_rate_set_by uuid REFERENCES users(id);

COMMENT ON COLUMN warehouses.delivery_rate_per_kg IS
  'What it costs to move a kilo from the warehouse to this centre. Set by an '
  'admin. NULL means nobody has said, and the actual trips are used instead — '
  'which is not the same as a rate of zero. See db/50.';

DO $$ BEGIN
  ALTER TABLE warehouses ADD CONSTRAINT ck_wh_delivery_rate
    CHECK (delivery_rate_per_kg IS NULL OR delivery_rate_per_kg >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* ------------------------------------------------- what a box was priced on -- */
ALTER TABLE packs
  ADD COLUMN IF NOT EXISTS destination_warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS outbound_rate_used       numeric(14,4);

COMMENT ON COLUMN packs.destination_warehouse_id IS
  'Where this box was priced to go. NULL means it was priced to sell where it '
  'was packed, and carries no delivery cost.';
COMMENT ON COLUMN packs.outbound_rate_used IS
  'The per-kilo delivery rate that went into this label. Kept so a price can be '
  'explained months later, when the rate has moved.';

/* -------------------------------------------------------------------- view --
 * One rate per centre, from the one place that decides it:
 *
 *   what an admin set        →  because they know what the next trip costs
 *   else what trips cost     →  measured, over the same window as the others
 *   else nothing             →  a centre nobody has ever delivered to
 */
CREATE OR REPLACE VIEW v_centre_delivery_rate AS
WITH win AS (
  SELECT c.id AS company_id, GREATEST(c.overhead_window_days, 1) AS days FROM companies c
), actual AS (
  SELECT si.dest_warehouse_id                            AS warehouse_id,
         SUM(si.transport_cost)                          AS spend,
         SUM(si.total_qty)                               AS kg,
         count(*)::int                                   AS trips
    FROM stock_issues si
    JOIN win w ON w.company_id = si.company_id
   WHERE si.dest_warehouse_id IS NOT NULL
     AND si.transport_cost > 0
     AND si.status <> 'CANCELLED'
     AND si.issue_date > CURRENT_DATE - w.days
   GROUP BY si.dest_warehouse_id
)
SELECT w.id                                              AS warehouse_id,
       w.company_id,
       w.name,
       w.is_centre,
       w.delivery_rate_per_kg                            AS set_rate,
       w.delivery_rate_note,
       w.delivery_rate_set_at,
       CASE WHEN COALESCE(a.kg, 0) > 0
            THEN round(a.spend / a.kg, 4) END            AS actual_rate,
       COALESCE(a.trips, 0)                              AS trips,
       COALESCE(a.spend, 0)                              AS spend,
       COALESCE(a.kg, 0)                                 AS kg_moved,
       /* The one anybody should use. */
       COALESCE(w.delivery_rate_per_kg,
                CASE WHEN COALESCE(a.kg, 0) > 0 THEN round(a.spend / a.kg, 4) END,
                0)                                       AS rate_per_kg,
       CASE WHEN w.delivery_rate_per_kg IS NOT NULL THEN 'set by an admin'
            WHEN COALESCE(a.kg, 0) > 0                 THEN 'from what the trips cost'
            ELSE 'nobody has delivered here yet' END     AS rate_source
  FROM warehouses w
  LEFT JOIN actual a ON a.warehouse_id = w.id;

COMMENT ON VIEW v_centre_delivery_rate IS
  'The delivery rate per kilo for each centre — what an admin set, or what the '
  'trips actually cost. Use rate_per_kg; the rest is there so a screen can say '
  'where the number came from.';

GRANT SELECT ON v_centre_delivery_rate TO chotug_app;
GRANT SELECT ON v_centre_delivery_rate TO chotug_readonly;

/* Seed each centre from its own history, once, so the admin screen opens with
 * a real number to correct rather than an empty box. */
UPDATE warehouses w
   SET delivery_rate_per_kg = r.actual_rate,
       delivery_rate_note   = 'from ' || r.trips || ' trip(s) before this rate was settable'
  FROM v_centre_delivery_rate r
 WHERE r.warehouse_id = w.id
   AND w.delivery_rate_per_kg IS NULL
   AND r.actual_rate IS NOT NULL;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES ('master.delivery_rate.manage','master','delivery_rate','manage',
        'Set what it costs to deliver a kilo to each centre', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER',        ARRAY['master.delivery_rate.manage']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['master.delivery_rate.manage']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['master.delivery_rate.manage']);
    END LOOP;
END $$;

COMMIT;
