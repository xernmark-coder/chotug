-- =============================================================================
-- 27 · QUALITY AND PACKING ARE ONE JOB
--
--   "packing and quality check should be together … they take all product and
--    then while packing them they just give each box a quality and then store
--    it to warehouse … and then packed boxes go to their particular rack by
--    taking qr code on them."
--
-- Today the system inspects a LOT — one grade for everything that came off one
-- lorry — and packs a BATCH into groups that inherit that grade. But the person
-- packing has each individual box in their hands and can see that this one is
-- A and the next one is B. Making them grade the lot first and pack second
-- throws that judgement away, and means the pack label can be wrong about the
-- very thing the label is for.
--
-- So a pack carries its own grade, given by the person who packed it, and then
-- goes to a bin by scanning the bin's code. Lot-level QC still exists and still
-- governs what is accepted off the vehicle; this is the second, finer pass that
-- happens with the box in hand.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE packs
  ADD COLUMN IF NOT EXISTS weight_kg   numeric(12,3),
  ADD COLUMN IF NOT EXISTS graded_by   uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS graded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS qc_note     text,
  -- Where it physically is. A pack with no bin is on the packing bench; a pack
  -- with a bin is on a shelf somebody can be sent to.
  ADD COLUMN IF NOT EXISTS bin_id      uuid REFERENCES bins(id),
  ADD COLUMN IF NOT EXISTS stored_at   timestamptz,
  ADD COLUMN IF NOT EXISTS stored_by   uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS ix_packs_bin ON packs (bin_id) WHERE status = 'IN_STOCK';
CREATE INDEX IF NOT EXISTS ix_packs_unstored
    ON packs (company_id, warehouse_id) WHERE status = 'IN_STOCK' AND bin_id IS NULL;

-- Scanning a bin label means looking it up by its printed code, which must not
-- be a sequential scan and must not care about case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bin_code_ci
    ON bins (company_id, lower(code));

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('inventory.pack.grade','inventory','pack','grade',
  'Grade each box as it is packed', false,'NORMAL'),
 ('inventory.pack.store','inventory','pack','store',
  'Put a packed box on a rack by scanning the bin', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'WH_EXEC',
                ARRAY['inventory.pack.grade','inventory.pack.store']);
        PERFORM grant_role_perms(c.id, 'QC_EXEC',
                ARRAY['inventory.pack.grade','inventory.pack.store']);
        PERFORM grant_role_perms(c.id, 'QC_HEAD',   ARRAY['inventory.pack.grade']);
        PERFORM grant_role_perms(c.id, 'OWNER',
                ARRAY['inventory.pack.grade','inventory.pack.store']);
    END LOOP;
END $$;

-- What is on each shelf right now, so "where is the A-grade mango" has one
-- answer rather than one answer per screen that computes it.
CREATE OR REPLACE VIEW v_bin_contents AS
SELECT pk.company_id,
       pk.bin_id,
       b.code            AS bin_code,
       r.code            AS rack_code,
       pk.warehouse_id,
       pk.product_id,
       pk.grade,
       count(*)::int     AS packs,
       SUM(pk.qty)       AS qty,
       SUM(COALESCE(pk.weight_kg, 0)) AS weight_kg,
       MIN(pk.stored_at) AS first_stored_at
  FROM packs pk
  JOIN bins  b ON b.id = pk.bin_id
  JOIN racks r ON r.id = b.rack_id
 WHERE pk.status = 'IN_STOCK' AND pk.bin_id IS NOT NULL
 GROUP BY pk.company_id, pk.bin_id, b.code, r.code, pk.warehouse_id,
          pk.product_id, pk.grade;

COMMIT;
