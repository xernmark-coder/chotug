-- ============================================================================
--  16 — DEVICE BRIDGE: weighbridges, platform scales, barcode guns
--
--  01_schema already modelled the hardware properly — scale_devices carries the
--  protocol, parser, least count and Legal Metrology stamp date; site_agents
--  carries the on-site program that talks to it; weighments carry
--  capture_mode = SCALE|MANUAL with the raw reading and a constraint that a
--  typed weight may not claim a device reading.
--
--  Nothing connected them. There was no way for a device to send a reading in,
--  so every weight in the system was typed, and the "manual entry" fraud index
--  in 01_schema had nothing to contrast against.
--
--  This adds the one missing piece: a place for readings to land, and the
--  registry rows to make the demo weighbridge real.
--
--  Why an on-site agent rather than the browser: a browser cannot open a
--  serial port (WebSerial is Chrome-desktop, HTTPS-only, and needs a click per
--  session), and a weighbridge indicator is RS-232 or Modbus. A small program
--  on the PC beside the scale reads the port and POSTs — which also means the
--  gate keeps working when the internet does not, because the agent buffers.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS device_readings (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
    scale_device_id uuid REFERENCES scale_devices(id) ON DELETE SET NULL,
    site_agent_id   uuid REFERENCES site_agents(id) ON DELETE SET NULL,
    kind            text NOT NULL DEFAULT 'WEIGHT'
                    CHECK (kind IN ('WEIGHT','SCAN','TEMPERATURE')),
    -- The number the indicator showed, and the exact line it sent. Keeping the
    -- raw line is what lets a disputed weight be re-parsed months later.
    value_kg        weight_kg,
    raw_reading     text,
    -- A scale settles for a second before the reading means anything; an
    -- unstable frame is recorded but never offered as a weight.
    is_stable       boolean NOT NULL DEFAULT false,
    scanned_code    text,
    captured_at     timestamptz NOT NULL DEFAULT now(),
    received_at     timestamptz NOT NULL DEFAULT now(),
    -- Set when a weighment or a scan actually used this reading, so the same
    -- frame cannot silently back two different documents.
    consumed_by     uuid,
    consumed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ix_device_readings_latest
    ON device_readings (company_id, warehouse_id, kind, captured_at DESC)
    WHERE consumed_at IS NULL;

ALTER TABLE device_readings ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
                    AND tablename = 'device_readings' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON device_readings
          USING (company_id IS NULL OR company_id = current_company_id())
          WITH CHECK (company_id IS NULL OR company_id = current_company_id());
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON device_readings TO chotug_app;
GRANT SELECT ON device_readings TO chotug_readonly;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('device.registry.manage','device','registry','manage','Register scales and site agents', false,'SENSITIVE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['device.registry.manage']);
        PERFORM grant_role_perms(c.id, 'GATE_EXEC',    ARRAY['device.registry.manage']);
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
         WHERE r.company_id = c.id AND r.code = 'OWNER'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  A demo weighbridge and the agent that speaks for it, so the integration can
--  be exercised before any hardware is on site. The agent key below is the
--  DEMO one — rotate it before this touches a real scale.
-- ---------------------------------------------------------------------------
INSERT INTO scale_devices (company_id, warehouse_id, code, device_kind, make, model,
                           protocol, baud_rate, parser_key, capacity_kg, least_count_kg,
                           hmac_key_enc, verification_expiry)
SELECT w.company_id, w.id, 'WB-01', 'WEIGHBRIDGE', 'Avery', 'ZM301',
       'SERIAL_ASCII', 9600, 'toledo_continuous', 40000, 10,
       decode('00','hex'), CURRENT_DATE + 300
  FROM warehouses w
 WHERE w.code = 'WH-PUN-01'
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO site_agents (company_id, warehouse_id, agent_code, hostname, agent_version,
                         capabilities, api_key_hash, status)
SELECT w.company_id, w.id, 'AGENT-PUN-01', 'gate-pc-01', '0.1.0',
       ARRAY['SCALE','LABEL'],
       encode(digest('chotug-demo-agent-key', 'sha256'), 'hex'),
       'ACTIVE'
  FROM warehouses w
 WHERE w.code = 'WH-PUN-01'
ON CONFLICT (company_id, agent_code) DO NOTHING;

COMMIT;
