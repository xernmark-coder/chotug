-- =============================================================================
-- 38 · PACKED BOXES TRAVEL WITH THE STOCK
--
-- A pack is a physical box with a label on it. Sending stock to a shop used to
-- move the quantity and leave the boxes behind: the warehouse kept labels for
-- produce that was no longer there, and the shop received loose kilos it could
-- not sell as the 5 kg boxes it had actually been given. The packing bench
-- ended up showing "-6.0 KG still loose", a quantity that cannot exist.
--
-- So a box gets a fourth state. IN_STOCK is where it can be sold; SOLD and
-- VOID retire it; IN_TRANSIT is the lorry — it has left one place and has not
-- been counted in at the other, which is exactly the window in which a box
-- goes missing and somebody needs to be able to see it.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE packs
  -- The transfer that is carrying it. Cleared when the shop books it in, so a
  -- box on a shelf never points at a lorry.
  ADD COLUMN IF NOT EXISTS transfer_issue_id uuid REFERENCES stock_issues(id),
  ADD COLUMN IF NOT EXISTS dispatched_at     timestamptz;

DO $$
DECLARE def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
      FROM pg_constraint WHERE conname = 'packs_status_check';
    IF def IS NULL OR def NOT LIKE '%IN_TRANSIT%' THEN
        ALTER TABLE packs DROP CONSTRAINT IF EXISTS packs_status_check;
        ALTER TABLE packs ADD CONSTRAINT packs_status_check
          CHECK (status IN ('IN_STOCK','IN_TRANSIT','SOLD','VOID'));
    END IF;
END $$;

-- A box in transit belongs to exactly one transfer, and one that is not in
-- transit belongs to none. Without this a cancelled transfer could leave a box
-- pointing at it forever and nobody would know which lorry to ask about.
DO $$ BEGIN
  ALTER TABLE packs ADD CONSTRAINT ck_pack_in_transit
    CHECK ((status = 'IN_TRANSIT') = (transfer_issue_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_packs_in_transit
    ON packs (transfer_issue_id) WHERE status = 'IN_TRANSIT';

COMMIT;
