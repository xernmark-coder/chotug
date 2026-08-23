-- =============================================================================
-- 28 · FLOOR → SECTION → RACK → SHELF, AND A QR ON EVERY ONE
--
--   "on the warehouse they want it like to make the sections, shelves, rank,
--    floor such type of structure, each product will be placed in particular
--    place, now each thing will have a qr code … at time of placing product in
--    warehouse the product will also generate a qr code based on the location …
--    this qr will be later used by the audit team, they will scan a qr of
--    shelve they will get all information about that shelve and so on."
--
-- Three of the four levels already exist: zone → rack → bin. What was missing
-- is the floor above them, and a scannable code on each one. So this adds the
-- floor and gives every level a QR, rather than inventing a second hierarchy
-- next to the working one.
--
-- The vocabulary is now the client's: floor, section (zone), rack, shelf (bin).
-- The table names stay as they are, because renaming a live table to change a
-- word on a screen is how migrations break.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_floors (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id   uuid NOT NULL REFERENCES companies(id),
    warehouse_id uuid NOT NULL REFERENCES warehouses(id),
    code         text NOT NULL,
    name         text NOT NULL,
    sort_order   int  NOT NULL DEFAULT 0,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES users(id),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES users(id),
    CONSTRAINT uq_floor_code UNIQUE (warehouse_id, code)
);
ALTER TABLE warehouse_floors ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY warehouse_floors_rls ON warehouse_floors
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE zones ADD COLUMN IF NOT EXISTS floor_id uuid REFERENCES warehouse_floors(id);

-- The scannable code. Short enough to print small, unambiguous enough to read
-- back off a dusty label: no O/0, no I/1.
ALTER TABLE warehouse_floors ADD COLUMN IF NOT EXISTS qr_code text;
ALTER TABLE zones            ADD COLUMN IF NOT EXISTS qr_code text;
ALTER TABLE racks            ADD COLUMN IF NOT EXISTS qr_code text;
ALTER TABLE bins             ADD COLUMN IF NOT EXISTS qr_code text;

CREATE OR REPLACE FUNCTION loc_code(prefix text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT prefix || '-' || string_agg(
           substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                  1 + floor(random() * 32)::int, 1), '')
    FROM generate_series(1, 6);
$$;

UPDATE warehouse_floors SET qr_code = loc_code('FL') WHERE qr_code IS NULL;
UPDATE zones            SET qr_code = loc_code('SE') WHERE qr_code IS NULL;
UPDATE racks            SET qr_code = loc_code('RK') WHERE qr_code IS NULL;
UPDATE bins             SET qr_code = loc_code('SH') WHERE qr_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_floor_qr ON warehouse_floors (qr_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_zone_qr  ON zones (qr_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rack_qr  ON racks (qr_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bin_qr   ON bins  (qr_code);

/* One place that knows what any scanned code is. Without this every screen
 * that reads a QR would have to try four tables in turn and each would pick a
 * different order. */
CREATE OR REPLACE VIEW v_locations AS
SELECT f.company_id, 'FLOOR'::text AS level, f.id, f.qr_code, f.code, f.name,
       f.warehouse_id, NULL::uuid AS parent_id, f.is_active,
       w.name || ' · ' || f.name AS path
  FROM warehouse_floors f JOIN warehouses w ON w.id = f.warehouse_id
UNION ALL
SELECT z.company_id, 'SECTION', z.id, z.qr_code, z.code, z.name,
       z.warehouse_id, z.floor_id, z.is_active,
       w.name || ' · ' || COALESCE(f.name || ' · ', '') || z.name
  FROM zones z
  JOIN warehouses w ON w.id = z.warehouse_id
  LEFT JOIN warehouse_floors f ON f.id = z.floor_id
UNION ALL
SELECT r.company_id, 'RACK', r.id, r.qr_code, r.code, r.code,
       z.warehouse_id, r.zone_id, r.is_active,
       w.name || ' · ' || COALESCE(f.name || ' · ', '') || z.name || ' · rack ' || r.code
  FROM racks r
  JOIN zones z ON z.id = r.zone_id
  JOIN warehouses w ON w.id = z.warehouse_id
  LEFT JOIN warehouse_floors f ON f.id = z.floor_id
UNION ALL
SELECT b.company_id, 'SHELF', b.id, b.qr_code, b.code, b.code,
       z.warehouse_id, b.rack_id, b.is_active,
       w.name || ' · ' || COALESCE(f.name || ' · ', '') || z.name
              || ' · rack ' || r.code || ' · shelf ' || b.code
  FROM bins b
  JOIN racks r ON r.id = b.rack_id
  JOIN zones z ON z.id = r.zone_id
  JOIN warehouses w ON w.id = z.warehouse_id
  LEFT JOIN warehouse_floors f ON f.id = z.floor_id;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('master.location.manage','master','location','manage',
  'Lay out floors, sections, racks and shelves, and print their labels', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER',   ARRAY['master.location.manage']);
        PERFORM grant_role_perms(c.id, 'WH_EXEC', ARRAY['master.location.manage']);
    END LOOP;
END $$;

COMMIT;
