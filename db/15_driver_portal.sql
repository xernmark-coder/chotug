-- ===========================================================================
--  15 — DRIVER PORTAL & PICKUPS
--
--  A confirmed order has to be fetched. Until now that happened over the phone
--  and lived in somebody's head: the gate did not know a vehicle was coming
--  until it arrived, and the buyer did not know whether anybody had gone.
--
--  A pickup is that job, written down. It hangs off a purchase order, carries
--  the supplier it collects from and the warehouse it delivers to, and moves
--  through a small state machine that both sides can see.
--
--  Drivers get logins the same way suppliers do — users.driver_id, scoped on
--  the server, refused at the door of every staff router.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES drivers(id);
CREATE INDEX IF NOT EXISTS ix_users_driver ON users (driver_id) WHERE driver_id IS NOT NULL;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
  ('driver.portal.access', 'driver', 'portal', 'view',   'Sign in to the driver app', false, 'NORMAL'),
  ('driver.pickup.view',   'driver', 'pickup', 'view',   'See pickups offered to me', false, 'NORMAL'),
  ('driver.pickup.update', 'driver', 'pickup', 'update', 'Accept a pickup and report progress', false, 'NORMAL'),
  ('logistics.pickup.manage', 'receiving', 'pickup', 'manage', 'Create and assign pickups', false, 'NORMAL')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (company_id, code, name, description, is_system)
SELECT c.id, 'DRIVER', 'Driver (outside)',
       'A driver. Sees only the pickups offered to or assigned to them.', true
  FROM companies c
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
  FROM roles r
  CROSS JOIN (VALUES
      ('driver.portal.access'), ('driver.pickup.view'), ('driver.pickup.update')
  ) AS p(code)
 WHERE r.code = 'DRIVER'
ON CONFLICT DO NOTHING;

INSERT INTO role_limits (role_id, max_approval_level, max_backdate_days)
SELECT r.id, 0, 0 FROM roles r WHERE r.code = 'DRIVER'
ON CONFLICT (role_id) DO NOTHING;

-- Staff who arrange transport can manage pickups.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'logistics.pickup.manage'
  FROM roles r WHERE r.code IN ('OWNER','PURCHASE_MGR','PURCHASE_EXEC','GATE_EXEC','WH_EXEC')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
--  The job itself.
--
--  OFFERED   — published to drivers, nobody has taken it
--  ASSIGNED  — a driver has it (either they accepted, or dispatch named them)
--  EN_ROUTE  — on the way to the supplier
--  LOADED    — goods on board, heading to us
--  DELIVERED — arrived; the gate takes over from here
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickups (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    pickup_no      text NOT NULL,
    po_id          uuid NOT NULL REFERENCES purchase_orders(id),
    supplier_id    uuid NOT NULL REFERENCES suppliers(id),
    warehouse_id   uuid REFERENCES warehouses(id),

    pickup_on      date NOT NULL,
    window_start   time,
    window_end     time,
    pickup_address text,
    notes          text,

    driver_id      uuid REFERENCES drivers(id),
    vehicle_id     uuid REFERENCES vehicles(id),
    assigned_at    timestamptz,
    accepted_at    timestamptz,
    en_route_at    timestamptz,
    loaded_at      timestamptz,
    delivered_at   timestamptz,
    -- What the driver says came on board. The weighbridge is still the
    -- authority; this is the first number anybody has, hours earlier.
    reported_crates integer,
    reported_note  text,

    status         text NOT NULL DEFAULT 'OFFERED'
                   CHECK (status IN ('OFFERED','ASSIGNED','EN_ROUTE','LOADED','DELIVERED','CANCELLED')),
    cancel_reason  text,
    gate_entry_id  uuid REFERENCES gate_entries(id),

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES users(id),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES users(id),
    UNIQUE (company_id, pickup_no)
);
CREATE INDEX IF NOT EXISTS ix_pickups_driver ON pickups (driver_id, status);
CREATE INDEX IF NOT EXISTS ix_pickups_open   ON pickups (company_id, status, pickup_on);

DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['PIC']) AS t UNION SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, 'PIC', fy.fy, 'PIC', 1, 6
  FROM branches b CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

ALTER TABLE pickups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = current_schema() AND tablename = 'pickups'
                      AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON pickups
            USING (company_id IS NULL OR company_id = current_company_id())
            WITH CHECK (company_id IS NULL OR company_id = current_company_id());
    END IF;
END $$;

COMMIT;
