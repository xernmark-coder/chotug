-- ============================================================================
--  ChotuG ERP — FLEET MASTERS (vehicles & drivers that a person can maintain)
--
--  The gate form offers a "Known vehicle" and a "Driver" dropdown, but nothing
--  in the product could ever add a row to either list: the only vehicles and
--  drivers that existed were the three trucks and two names in 02_seed.sql.
--  A new truck could still be received (the registration is free text), it
--  just never became a master record — so its fitness/insurance/PUC expiry was
--  never checked at the gate, because that check only runs for a linked
--  vehicle_id.
--
--  Removal cannot be a DELETE. gate_entries.vehicle_id and .driver_id point at
--  these rows, and a receipt from two years ago must still say which truck
--  brought the goods. So "remove" retires the row: it leaves the dropdowns and
--  every historical record keeps pointing at it.
--
--  is_active is deliberately NOT the same thing as status:
--    status = 'BLOCKED'  — the truck exists and is barred from entering (§12.2)
--    is_active = false   — the truck is off the roster; sold, or it stopped
--                          coming. Not an accusation, just not on the list.
--
--  Additive and idempotent. Runs after 07_flow_fixes.sql.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
--  1. Roster columns
-- ---------------------------------------------------------------------------
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS retired_at     timestamptz;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS retired_by     uuid;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS retired_reason text;

ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true;
ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS retired_at     timestamptz;
ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS retired_by     uuid;
ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS retired_reason text;

-- A retired row must say when it was retired, so "why is this truck missing
-- from the list" is always answerable from the row itself.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vehicle_retired') THEN
        ALTER TABLE vehicles ADD CONSTRAINT ck_vehicle_retired
            CHECK (is_active OR retired_at IS NOT NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_driver_retired') THEN
        ALTER TABLE drivers ADD CONSTRAINT ck_driver_retired
            CHECK (is_active OR retired_at IS NOT NULL);
    END IF;
END $$;

-- The dropdowns read the active roster on every gate entry.
CREATE INDEX IF NOT EXISTS ix_vehicles_roster ON vehicles (company_id, reg_no)    WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_drivers_roster  ON drivers  (company_id, full_name) WHERE is_active;

-- ---------------------------------------------------------------------------
--  2. Drivers were the one master people can now edit that kept no history.
--     vehicles has carried an audit trigger since 01_schema.sql; drivers did
--     not, because nothing could write to it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_drivers_audit') THEN
        CREATE TRIGGER trg_drivers_audit
            AFTER INSERT OR UPDATE OR DELETE ON drivers
            FOR EACH ROW EXECUTE FUNCTION trg_audit_row();
    END IF;
END $$;

-- ---------------------------------------------------------------------------
--  3. master.vehicle.manage already exists and GATE_EXEC already holds it —
--     the gate is where a new truck actually shows up, so that is where it
--     gets added. The warehouse team receives from the same yard and hits the
--     same unknown vehicles, so grant it there too.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'WH_EXEC', ARRAY['master.vehicle.manage']);
    END LOOP;
END $$;

COMMIT;
