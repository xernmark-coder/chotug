-- =============================================================================
-- 44 · HOW MUCH IS ACTUALLY ON A SHELF
--
-- bins.current_fill_kg is a stored number that nothing maintains. The packing
-- bench puts boxes on a shelf and does not touch it; selling, voiding and
-- transferring take them off and do not touch it either. Of 97 boxes in stock,
-- 8 carry a weight_kg at all — the rest are measured in KG, so their qty IS
-- their weight, and the column read 0.
--
-- That was visible as "0 / 1,500 kg" on a shelf holding 10 kg of bananas, and
-- invisible but worse in receiving.ts, where the bin suggestion picks the
-- emptiest shelf with room: every shelf looked empty, so it always suggested
-- the same one and never noticed a full one.
--
-- Derived, not stored. Six places would have had to remember to update it and
-- five of them would have been missed — which is what happened.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE VIEW v_bin_fill AS
SELECT bn.id                             AS bin_id,
       bn.company_id,
       bn.code,
       bn.capacity_kg,
       COALESCE(SUM(
         -- A measured weight if somebody took one; otherwise the quantity,
         -- which for a box counted in kilos is the same number.
         COALESCE(pk.weight_kg,
                  CASE WHEN pk.uom = 'KG' THEN pk.qty END,
                  0)
       ), 0)                             AS fill_kg,
       count(pk.id)::int                 AS boxes,
       CASE WHEN bn.capacity_kg IS NULL OR bn.capacity_kg = 0 THEN NULL
            ELSE round((COALESCE(SUM(
                   COALESCE(pk.weight_kg, CASE WHEN pk.uom = 'KG' THEN pk.qty END, 0)
                 ), 0) / bn.capacity_kg) * 100, 1) END
                                         AS filled_pct,
       GREATEST(0, COALESCE(bn.capacity_kg, 0) - COALESCE(SUM(
         COALESCE(pk.weight_kg, CASE WHEN pk.uom = 'KG' THEN pk.qty END, 0)
       ), 0))                            AS free_kg
  FROM bins bn
  LEFT JOIN packs pk ON pk.bin_id = bn.id AND pk.status = 'IN_STOCK'
 GROUP BY bn.id, bn.company_id, bn.code, bn.capacity_kg;

COMMENT ON VIEW v_bin_fill IS
  'What is on a shelf right now, derived from the boxes on it. Use this rather '
  'than bins.current_fill_kg, which nothing maintains.';

-- Bring the stored column into line once, so anything still reading it directly
-- is not wildly wrong in the meantime. It will drift again — the view is the
-- answer, this is only a courtesy.
UPDATE bins b
   SET current_fill_kg = f.fill_kg
  FROM v_bin_fill f
 WHERE f.bin_id = b.id AND b.current_fill_kg IS DISTINCT FROM f.fill_kg;

COMMIT;
