-- ============================================================================
--  ChotuG ERP — THE MONEY SPINE  (client update, phase 2)
--
--  The client was emphatic: Finance is the centre of this system. Every rupee
--  that leaves or arrives passes through one desk, and that desk can see where
--  it came from and what it was for.
--
--  Before this the system only knew about ONE kind of money — what we owe a
--  supplier for an invoice. There was nowhere to record a wage, an electricity
--  bill, diesel, rent, or cash collected from a shop. Those were the majority
--  of the client's actual cash movements.
--
--  The shape:
--
--      anybody raises          payment_requests     (one inbox for Finance)
--            ↓ verify
--      Finance pays            payments             (cash / UPI / bank, with a
--            ↓                                       transaction reference)
--      money arrives           money_receipts       (collections from centres
--                                                    and customers)
--
--  A request is a claim; a payment is the money moving. They are separate
--  because a claim can be part-paid, rejected, or paid twice by mistake — and
--  only the second of those should ever be impossible.
--
--  Additive and idempotent.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Document numbering for the three new documents.
DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['PAY','PMT','RCP']) AS t
        UNION SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, t.doc_type, fy.fy, t.prefix, 1, 6
  FROM branches b
  CROSS JOIN (VALUES ('PAY','PAY'),('PMT','PMT'),('RCP','RCP')) AS t(doc_type, prefix)
  CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

-- ---------------------------------------------------------------------------
--  What money was spent ON. The client listed wages, electricity, petrol,
--  rent and cleaning by name, so those are seeded rather than left to be
--  invented differently at each branch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code        text NOT NULL,
    name        text NOT NULL,
    name_hi     text,
    icon        text,
    -- Some costs belong in the price of the produce (transport, packing) and
    -- some are simply the cost of being open (rent, electricity). Landed cost
    -- must only absorb the first kind.
    affects_landed_cost boolean NOT NULL DEFAULT false,
    is_active   boolean NOT NULL DEFAULT true,
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    UNIQUE (company_id, code)
);

INSERT INTO expense_categories (company_id, code, name, name_hi, icon, affects_landed_cost, sort_order)
SELECT c.id, v.code, v.name, v.name_hi, v.icon, v.landed, v.ord
  FROM companies c CROSS JOIN (VALUES
    ('WAGES',       'Wages & labour',      'मजदूरी',        'people',   false, 10),
    ('TRANSPORT',   'Transport & freight', 'भाड़ा',          'truck',    true,  20),
    ('FUEL',        'Fuel / petrol',       'ईंधन',          'route',    true,  30),
    ('ELECTRICITY', 'Electricity',         'बिजली',         'bolt',     false, 40),
    ('RENT',        'Rent',                'किराया',        'home',     false, 50),
    ('CLEANING',    'Cleaning',            'सफ़ाई',          'sparkle',  false, 60),
    ('PACKING',     'Packing material',    'पैकिंग',        'tag',      true,  70),
    ('COLD_STORE',  'Cold storage',        'शीत भंडारण',    'crates',   true,  80),
    ('REPAIRS',     'Repairs & upkeep',    'मरम्मत',        'gear',     false, 90),
    ('OTHER',       'Other',               'अन्य',          'receipt',  false, 999)
  ) AS v(code, name, name_hi, icon, landed, ord)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
--  THE INBOX. Everything that wants money raises one of these; nothing is paid
--  that does not have one. Finance is the only role that may verify or pay.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_requests (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    request_no    text NOT NULL,

    kind          text NOT NULL CHECK (kind IN
                  ('SUPPLIER_INVOICE','WAGES','EXPENSE','ADVANCE','REFUND','TRANSPORT')),

    -- Who is being paid. Exactly one of these is meaningful, but a free-text
    -- name is always kept so a printed voucher reads correctly even after a
    -- supplier or worker record is renamed.
    supplier_id   uuid REFERENCES suppliers(id),
    payee_user_id uuid REFERENCES users(id),
    payee_name    text NOT NULL,

    -- What it is for, and where it belongs. warehouse_id doubles as the centre
    -- once centres exist, so a centre's costs need no second column.
    expense_category_id uuid REFERENCES expense_categories(id),
    warehouse_id  uuid REFERENCES warehouses(id),
    -- The document that caused it: a supplier invoice, a farm expense, a
    -- payroll line. Kept loose on purpose so a new source needs no migration.
    source_type   text,
    source_id     uuid,

    amount        money_amt NOT NULL CHECK (amount > 0),
    due_date      date,
    priority      text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    note          text,

    status        text NOT NULL DEFAULT 'REQUESTED'
                  CHECK (status IN ('REQUESTED','VERIFIED','PART_PAID','PAID','REJECTED','CANCELLED')),
    paid_amount   money_amt NOT NULL DEFAULT 0,

    requested_by  uuid REFERENCES users(id),
    requested_at  timestamptz NOT NULL DEFAULT now(),
    verified_by   uuid REFERENCES users(id),
    verified_at   timestamptz,
    rejected_by   uuid REFERENCES users(id),
    rejected_at   timestamptz,
    reject_reason text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,

    UNIQUE (company_id, request_no),
    -- Turning a request down without saying why is how a supplier ends up
    -- ringing the owner instead of reading the screen.
    CONSTRAINT ck_payreq_reject CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL),
    CONSTRAINT ck_payreq_paid   CHECK (paid_amount <= amount + 0.01),
    -- An expense must say what kind of expense it was.
    CONSTRAINT ck_payreq_expense_cat CHECK (kind <> 'EXPENSE' OR expense_category_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_payreq_inbox ON payment_requests (company_id, status, due_date)
    WHERE status IN ('REQUESTED','VERIFIED','PART_PAID');
CREATE INDEX IF NOT EXISTS ix_payreq_source ON payment_requests (source_type, source_id);
-- One request per source document: the same invoice must not be queued twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payreq_source ON payment_requests (company_id, source_type, source_id)
    WHERE source_id IS NOT NULL AND status <> 'CANCELLED';

-- ---------------------------------------------------------------------------
--  THE MONEY MOVING. Append-only in spirit: a mistake is reversed with a
--  second row, never edited away, because a payment is evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    payment_no    text NOT NULL,
    request_id    uuid NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,

    amount        money_amt NOT NULL CHECK (amount > 0),
    mode          text NOT NULL CHECK (mode IN ('CASH','UPI','BANK','CHEQUE','CARD')),
    -- The UPI reference, the UTR, the cheque number. Anything but cash must
    -- carry one, so a disputed payment can be traced to the bank.
    transaction_ref text,
    paid_from     text,                       -- which account or till
    paid_at       timestamptz NOT NULL DEFAULT now(),
    paid_by       uuid REFERENCES users(id),

    status        text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
    reversed_at   timestamptz,
    reversed_by   uuid REFERENCES users(id),
    reverse_reason text,
    note          text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,

    UNIQUE (company_id, payment_no),
    CONSTRAINT ck_payment_ref CHECK (mode = 'CASH' OR transaction_ref IS NOT NULL),
    CONSTRAINT ck_payment_reverse CHECK (status <> 'REVERSED' OR reverse_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_payments_request ON payments (request_id);
CREATE INDEX IF NOT EXISTS ix_payments_day ON payments (company_id, paid_at DESC);
-- The same UPI reference twice is a double payment, not a coincidence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_txn_ref
    ON payments (company_id, transaction_ref)
    WHERE transaction_ref IS NOT NULL AND status = 'POSTED';

-- ---------------------------------------------------------------------------
--  MONEY ARRIVING. Cash and UPI collected at a centre, or from a customer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_receipts (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    receipt_no    text NOT NULL,

    source        text NOT NULL CHECK (source IN ('CENTRE','CUSTOMER','OTHER')),
    warehouse_id  uuid REFERENCES warehouses(id),     -- the centre it came from
    payer_name    text NOT NULL,
    source_type   text,
    source_id     uuid,

    amount        money_amt NOT NULL CHECK (amount > 0),
    mode          text NOT NULL CHECK (mode IN ('CASH','UPI','BANK','CHEQUE','CARD')),
    transaction_ref text,
    received_on   date NOT NULL DEFAULT CURRENT_DATE,

    -- Cash handed over is claimed by the centre and confirmed by Finance; the
    -- gap between the two is exactly what a cash business needs to see.
    status        text NOT NULL DEFAULT 'DECLARED'
                  CHECK (status IN ('DECLARED','CONFIRMED','DISPUTED','CANCELLED')),
    declared_by   uuid REFERENCES users(id),
    confirmed_by  uuid REFERENCES users(id),
    confirmed_at  timestamptz,
    confirmed_amount money_null,
    dispute_note  text,
    note          text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,

    UNIQUE (company_id, receipt_no),
    CONSTRAINT ck_receipt_ref CHECK (mode = 'CASH' OR transaction_ref IS NOT NULL),
    CONSTRAINT ck_receipt_dispute CHECK (status <> 'DISPUTED' OR dispute_note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_receipts_open ON money_receipts (company_id, status, received_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_txn_ref
    ON money_receipts (company_id, transaction_ref)
    WHERE transaction_ref IS NOT NULL AND status <> 'CANCELLED';

-- ---------------------------------------------------------------------------
--  UPI. The admin sets the company code; a centre may print its own instead.
-- ---------------------------------------------------------------------------
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS upi_id text;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS upi_payee_name text;

INSERT INTO settings (company_id, scope, key, value, data_type)
SELECT c.id, 'COMPANY', v.k, v.val::jsonb, v.dt
  FROM companies c CROSS JOIN (VALUES
    ('finance.upi_id',            '""',   'string'),
    ('finance.upi_payee_name',    '""',   'string'),
    ('finance.cash_limit',        '20000','number'),
    ('finance.require_txn_ref',   'true', 'boolean')
  ) AS v(k, val, dt)
ON CONFLICT (company_id, branch_id, key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  Triggers, RLS and grants — the 01_schema DO-blocks never saw these tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['expense_categories','payment_requests','payments','money_receipts'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = format('trg_%s_updated', t)
                        AND tgrelid = t::regclass) THEN
            EXECUTE format(
              'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW
                 EXECUTE FUNCTION %s()', t, t,
              CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t::regclass
                                 AND a.attname='version' AND a.attnum>0 AND NOT a.attisdropped)
                   THEN 'trg_set_updated_at' ELSE 'trg_touch_updated_at' END);
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
                        AND tablename = t AND policyname = 'tenant_isolation') THEN
            EXECUTE format(
              'CREATE POLICY tenant_isolation ON %I
                 USING (company_id IS NULL OR company_id = current_company_id())
                 WITH CHECK (company_id IS NULL OR company_id = current_company_id())', t);
        END IF;
    END LOOP;

    -- Money is the most audited thing in the system.
    FOREACH t IN ARRAY ARRAY['payment_requests','payments','money_receipts'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = format('trg_%s_audit', t)
                        AND tgrelid = t::regclass) THEN
            EXECUTE format(
              'CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                 FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
        END IF;
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    expense_categories, payment_requests, payments, money_receipts TO chotug_app;
GRANT SELECT ON expense_categories, payment_requests, payments, money_receipts TO chotug_readonly;

-- ---------------------------------------------------------------------------
--  Permissions. Raising a request is ordinary; approving and paying are not.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('finance.request.create','finance','payment_request','create','Ask Finance to pay something',        false,'NORMAL'),
 ('finance.request.verify','finance','payment_request','verify','Verify or reject a payment request',  false,'CRITICAL'),
 ('finance.payment.make',  'finance','payment','make',          'Actually pay a verified request',     false,'CRITICAL'),
 ('finance.payment.reverse','finance','payment','reverse',      'Reverse a payment made in error',     false,'CRITICAL'),
 ('finance.receipt.record','finance','receipt','record',        'Record money collected',              false,'NORMAL'),
 ('finance.receipt.confirm','finance','receipt','confirm',      'Confirm collected money has landed',  false,'CRITICAL'),
 ('finance.expense.view',  'finance','expense','view',          'See what the business is spending',   false,'SENSITIVE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        -- Finance holds the whole chain: they verify, they pay, they confirm.
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY[
            'finance.request.create','finance.request.verify','finance.payment.make',
            'finance.payment.reverse','finance.receipt.record','finance.receipt.confirm',
            'finance.expense.view']);
        -- Everyone who spends money may ASK for it. None of them may pay it.
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['finance.request.create','finance.expense.view']);
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['finance.request.create']);
        PERFORM grant_role_perms(c.id, 'FARM_MGR',     ARRAY['finance.request.create']);
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
         WHERE r.company_id = c.id AND r.code = 'OWNER'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

COMMIT;
