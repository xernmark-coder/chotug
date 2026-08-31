-- =============================================================================
-- 42 · STOCK IS SOLD AS BOXES, AND A SHOP MAY ASK FOR THE SIZE IT WANTS
--
--   "they can sell in packed boxes only so remove that issue directly, they
--    will only sell the packed products from the warehouse. also if any center
--    wants boxes of different kg they can make request accordingly to send
--    stock to them like 20 5kg boxes of apples."
--
-- Two halves of one rule.
--
-- The first is a subtraction. Selling loose kilos straight off a batch bypassed
-- the packing bench, and with it the grade given to each box, the label, the
-- shelf it was on and the price printed on it. The same produce could leave the
-- building two ways with two different records, and the pack bench was left
-- holding labels for fruit that had already gone. Selling is now one route:
-- a packed box, scanned or ticked, with the price it was labelled with.
--
-- Enforcement lives in the API, not here, because a check constraint cannot
-- tell a sale posted from the till from the identical row the pack sale writes.
-- What the database DOES do is remember which sales came from boxes, so the
-- rule can be shown to have held.
--
-- The second half is an addition. A shop does not want 100 kg of apples; it
-- wants twenty 5 kg boxes, because that is what fits its shelf and that is the
-- unit its customers buy. Recording only the total threw away the useful half
-- of the request, and the warehouse packed whatever it happened to be packing.
--
-- The total is still stored, and is still the number every report reads. The
-- box size and count sit beside it as what was actually asked for.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ------------------------------------------------ what the shop asked for -- */
ALTER TABLE requirement_lines
  ADD COLUMN IF NOT EXISTS pack_size_kg numeric(10,3),
  ADD COLUMN IF NOT EXISTS pack_count   integer;

COMMENT ON COLUMN requirement_lines.pack_size_kg IS
  'Size of box asked for, in kg. Null means "however you pack it".';
COMMENT ON COLUMN requirement_lines.pack_count IS
  'How many boxes of that size. final_qty stays the total, so every existing report is unaffected.';

/* Asking for boxes means saying both how big and how many — one without the
 * other is not a request anybody can pack against. */
DO $$ BEGIN
  ALTER TABLE requirement_lines ADD CONSTRAINT ck_reqline_packs
    CHECK ((pack_size_kg IS NULL) = (pack_count IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE requirement_lines ADD CONSTRAINT ck_reqline_pack_positive
    CHECK (pack_size_kg IS NULL OR (pack_size_kg > 0 AND pack_count > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* ------------------------------------------- sales come from boxes now ----- */
/* Which sales were posted from packed boxes. Every new one is, and the flag is
 * what lets a report say so rather than assume it. Sales made before this rule
 * existed keep their history and are simply not marked. */
ALTER TABLE stock_issues
  ADD COLUMN IF NOT EXISTS from_packs boolean NOT NULL DEFAULT false;

UPDATE stock_issues si
   SET from_packs = true
 WHERE si.reason = 'SALE'
   AND NOT si.from_packs
   AND EXISTS (SELECT 1 FROM packs k WHERE k.sold_issue_id = si.id);

CREATE INDEX IF NOT EXISTS ix_issue_loose_sales
    ON stock_issues (company_id, issue_date)
 WHERE reason = 'SALE' AND NOT from_packs;

/* What a shop is waiting for, in the unit it asked for it in. The packing bench
 * reads this to know what size to make next — without it, the bench packs
 * whatever it packed last time and the request is answered by accident. */
CREATE OR REPLACE VIEW v_pack_size_demand AS
SELECT r.company_id,
       r.raised_for_warehouse_id           AS warehouse_id,
       w.name                              AS centre_name,
       rl.product_id,
       p.name                              AS product_name,
       p.icon,
       rl.pack_size_kg,
       SUM(rl.pack_count)::int             AS boxes_wanted,
       SUM(rl.final_qty)                   AS qty_wanted,
       MIN(r.required_date)                AS needed_by,
       MAX(r.priority)                     AS priority,
       count(*)::int                       AS requests
  FROM requirement_lines rl
  JOIN requirements r ON r.id = rl.requirement_id
  JOIN products p     ON p.id = rl.product_id
  LEFT JOIN warehouses w ON w.id = r.raised_for_warehouse_id
 WHERE rl.pack_size_kg IS NOT NULL
   AND r.status IN ('DRAFT','SUBMITTED','APPROVED')
   AND rl.line_status IN ('OPEN','PART_CONVERTED')
 GROUP BY r.company_id, r.raised_for_warehouse_id, w.name, rl.product_id,
          p.name, p.icon, rl.pack_size_kg;

GRANT SELECT ON v_pack_size_demand TO chotug_app;
GRANT SELECT ON v_pack_size_demand TO chotug_readonly;

COMMIT;
