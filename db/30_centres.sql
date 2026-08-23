-- =============================================================================
-- 30 · CENTRES, CUSTOMERS, AND THE DAY'S CLOSE
--
--   "center is basically they sell their product from various centers in the
--    city, so each center will have a panel … to which center how much quantity
--    is sent, how much quantity of product is present at that center, how much
--    selling is being done at that center, who are customers at that center,
--    ranking and comparison of various centers. each center will enter its
--    audit everyday before closing … the person at the center should be able to
--    raise the requirement of particular product along with proper reasoning
--    and this request will come to purchase manager … the vehicle used to send
--    those product to that center, the cost of that transport, every single
--    expense will be recorded."
--
-- A centre IS a warehouse. It holds stock, stock moves in and out of it, it has
-- a balance and a ledger — every one of those already works. Giving it a second
-- table would mean a second stock model, a second balance, and two numbers for
-- how much mango is in Kothrud. So a centre is a warehouse with is_centre set,
-- and everything built over the last month applies to it unchanged.
--
-- What genuinely is new:
--   · a transfer that is IN TRANSIT until the centre says it arrived, with the
--     vehicle and what the trip cost;
--   · customers, who belong to a centre;
--   · the day's close, which is the centre's own daily audit.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ------------------------------------------------------------- centres --- */
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS is_centre       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS city            text,
  ADD COLUMN IF NOT EXISTS address         text,
  ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS opened_on       date,
  ADD COLUMN IF NOT EXISTS monthly_rent    numeric(14,2);

CREATE INDEX IF NOT EXISTS ix_wh_centre ON warehouses (company_id) WHERE is_centre;

/* ------------------------------------------------------------ customers -- */
CREATE TABLE IF NOT EXISTS customers (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    -- Which centre they buy from. Null means they deal with the business
    -- directly rather than through a shop.
    warehouse_id  uuid REFERENCES warehouses(id),
    name          text NOT NULL,
    phone         text,
    kind          text NOT NULL DEFAULT 'WALK_IN'
                  CHECK (kind IN ('WALK_IN','SHOP','HOTEL','WHOLESALER','INSTITUTION','ONLINE')),
    gstin         text,
    address       text,
    credit_limit  numeric(14,2) NOT NULL DEFAULT 0,
    note          text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid REFERENCES users(id),
    version       int NOT NULL DEFAULT 1
);
-- Two "Ramesh"es at one centre is a data-entry slip, not two customers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_name
    ON customers (company_id, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
 WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_customer_phone ON customers (company_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY customers_rls ON customers
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);

/* ------------------------------------------------- transfers to a centre -- */
ALTER TABLE stock_issues
  ADD COLUMN IF NOT EXISTS dest_warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS vehicle_id        uuid REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS vehicle_reg       text,
  ADD COLUMN IF NOT EXISTS driver_name       text,
  ADD COLUMN IF NOT EXISTS transport_cost    numeric(14,2),
  ADD COLUMN IF NOT EXISTS dispatched_at     timestamptz,
  ADD COLUMN IF NOT EXISTS received_at       timestamptz,
  ADD COLUMN IF NOT EXISTS received_by       uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS received_note     text;

/* Stock that has left the warehouse but not yet arrived at the shop is neither
 * place's — it is on a lorry. Before this it silently belonged to the
 * destination the moment somebody pressed send, and a load that never arrived
 * looked exactly like one sitting on the shelf. */
DO $$
DECLARE v text[];
BEGIN
    SELECT array_agg(DISTINCT s ORDER BY s) INTO v FROM (
        SELECT unnest(ARRAY['POSTED','CANCELLED','IN_TRANSIT','RECEIVED']) AS s
        UNION SELECT status FROM stock_issues
    ) x;
    ALTER TABLE stock_issues DROP CONSTRAINT IF EXISTS stock_issues_status_check;
    EXECUTE format('ALTER TABLE stock_issues ADD CONSTRAINT stock_issues_status_check
                      CHECK (status = ANY (%L))', v);
END $$;

CREATE INDEX IF NOT EXISTS ix_issue_in_transit
    ON stock_issues (company_id, dest_warehouse_id) WHERE status = 'IN_TRANSIT';

/* ------------------------------------------------------- the day's close -- */
CREATE TABLE IF NOT EXISTS centre_day_close (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
    close_date     date NOT NULL,

    /* What the system already knows, frozen at closing time. Keeping the
     * system's own figure next to the person's is the entire point: the gap
     * between them is the finding. */
    system_qty     numeric(14,3) NOT NULL DEFAULT 0,
    system_revenue numeric(14,2) NOT NULL DEFAULT 0,

    declared_qty   numeric(14,3) NOT NULL DEFAULT 0,
    declared_revenue numeric(14,2) NOT NULL DEFAULT 0,
    cash_amount    numeric(14,2) NOT NULL DEFAULT 0,
    online_amount  numeric(14,2) NOT NULL DEFAULT 0,
    expenses       numeric(14,2) NOT NULL DEFAULT 0,
    wastage_qty    numeric(14,3) NOT NULL DEFAULT 0,

    variance       numeric(14,2) GENERATED ALWAYS AS (declared_revenue - system_revenue) STORED,
    note           text,
    CONSTRAINT ck_close_variance CHECK (
        abs(declared_revenue - system_revenue) < 0.01 OR note IS NOT NULL),

    closed_by      uuid NOT NULL REFERENCES users(id),
    closed_at      timestamptz NOT NULL DEFAULT now(),
    -- Finance ties the declared cash back to what actually landed.
    receipt_id     uuid REFERENCES money_receipts(id),
    CONSTRAINT uq_close_day UNIQUE (warehouse_id, close_date)
);

ALTER TABLE centre_day_close ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY centre_day_close_rls ON centre_day_close
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* A centre asking for stock is a requirement like any other — the purchase
 * manager's review queue already exists and already works. All it needed was to
 * know which centre asked. */
ALTER TABLE requirements
  ADD COLUMN IF NOT EXISTS raised_for_warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS reasoning text;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('centre.stock.receive','centre','stock','receive',
  'Confirm a transfer has arrived at the centre', false,'NORMAL'),
 ('centre.day.close','centre','day','close',
  'Close the day at a centre and declare the takings', false,'NORMAL'),
 ('centre.performance.view','centre','performance','view',
  'Compare centres on sales, margin and shrinkage', false,'NORMAL'),
 ('master.customer.manage','master','customer','manage',
  'Add and edit customers', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (id, company_id, code, name, description, is_system)
SELECT uuid_generate_v7(), c.id, 'CENTRE_EXEC', 'Centre',
       'Runs one shop: receives stock, sells it, closes the day.', false
  FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.code = 'CENTRE_EXEC');

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'CENTRE_EXEC', ARRAY[
            'centre.stock.receive','centre.day.close','master.customer.manage',
            'inventory.stock.issue','purchase.requirement.create',
            'finance.request.create','finance.receipt.record','reports.purchase.view']);
        PERFORM grant_role_perms(c.id, 'OWNER', ARRAY[
            'centre.stock.receive','centre.day.close','centre.performance.view',
            'master.customer.manage']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['centre.performance.view']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['centre.performance.view']);
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['master.customer.manage']);
    END LOOP;
END $$;

COMMIT;
