-- ============================================================================
--  ChotuG ERP — PURCHASE MODULE
--  Complete PostgreSQL 16 Schema
-- ============================================================================
--  Companion to: ChotuG_ERP_Purchase_Module_Implementation_Blueprint.md
--
--  Conventions enforced throughout:
--    ids          uuid v7 (time-ordered -> index-friendly, no page splits)
--    money        numeric(18,4)   -- never float, never double precision
--    rate         numeric(18,6)   -- room for mandi paise fractions
--    weight_kg    numeric(14,3)   -- 1 gram resolution
--    quantity     numeric(14,3)
--    percentage   numeric(9,4)
--    timestamps   timestamptz     -- always; app renders in Asia/Kolkata
--    enums        text + CHECK    -- easier to migrate than native PG enums
--    tenancy      company_id on every business table + RLS
--
--  Load order matters. Run this file top to bottom, or split at the
--  "SECTION" banners into numbered migration files 01..10.
--
--  Every business table carries the audit quintet:
--    created_at, created_by, updated_at, updated_by, version
--  `version` is an optimistic-lock counter bumped by trg_set_updated_at.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ============================================================================
--  SECTION 01 — EXTENSIONS, DOMAINS, HELPER FUNCTIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy supplier/product search
CREATE EXTENSION IF NOT EXISTS btree_gist;    -- exclusion constraints
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector, AI retrieval
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
--  uuid v7 — time-ordered UUIDs.
--  PG16 has no native uuidv7() (that arrives in PG18), so we implement it.
--  Layout: 48-bit unix_ts_ms | 4-bit version | 12-bit rand | 2-bit variant | 62-bit rand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    v_ts_ms   bigint;
    v_bytes   bytea;
BEGIN
    v_ts_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

    -- 16 random bytes, then overwrite the first 6 with the timestamp
    v_bytes := gen_random_bytes(16);
    v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
    v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
    v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
    v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
    v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >>  8) & 255)::int);
    v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);

    -- version 7 in the high nibble of byte 6
    v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));
    -- RFC 4122 variant (10xx) in the top bits of byte 8
    v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));

    RETURN encode(v_bytes, 'hex')::uuid;
END $$;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'Time-ordered UUID v7. Use as DEFAULT for all primary keys.';

-- ---------------------------------------------------------------------------
--  Reusable domains — self-documenting column types
-- ---------------------------------------------------------------------------
CREATE DOMAIN money_amt   AS numeric(18,4) DEFAULT 0 NOT NULL;
CREATE DOMAIN money_null  AS numeric(18,4);
CREATE DOMAIN rate_amt    AS numeric(18,6);
CREATE DOMAIN qty_amt     AS numeric(14,3);
CREATE DOMAIN weight_kg   AS numeric(14,3);
CREATE DOMAIN pct         AS numeric(9,4);
CREATE DOMAIN short_code  AS text CHECK (VALUE ~ '^[A-Z0-9_-]{1,32}$');

-- Indian identifier formats, validated at the database edge
CREATE DOMAIN gstin_t AS text
  CHECK (VALUE IS NULL OR VALUE ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$');
CREATE DOMAIN pan_t AS text
  CHECK (VALUE IS NULL OR VALUE ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
CREATE DOMAIN vehicle_reg_t AS text
  CHECK (VALUE IS NULL OR VALUE ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$'      -- standard
                       OR VALUE ~ '^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$');            -- Bharat series
CREATE DOMAIN fssai_t AS text
  CHECK (VALUE IS NULL OR VALUE ~ '^[0-9]{14}$');
CREATE DOMAIN hsn_t AS text
  CHECK (VALUE IS NULL OR VALUE ~ '^[0-9]{4,8}$');

-- ---------------------------------------------------------------------------
--  updated_at + optimistic-lock version bump
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    IF TG_OP = 'UPDATE' THEN
        -- Optimistic concurrency: the app sends the version it read.
        -- A stale write raises here rather than silently clobbering.
        IF NEW.version IS NOT NULL AND OLD.version IS NOT NULL
           AND NEW.version <> OLD.version THEN
            RAISE EXCEPTION
              'stale_write: % id=% expected version % but row is at %',
              TG_TABLE_NAME, OLD.id, NEW.version, OLD.version
              USING ERRCODE = '40001';
        END IF;
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
--  Immutability guard — used on posted financial documents and audit tables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
      'immutable_row: % rows cannot be % once written (use reversal/amendment)',
      TG_TABLE_NAME, lower(TG_OP)
      USING ERRCODE = '0A000';
END $$;

CREATE OR REPLACE FUNCTION trg_forbid_update_when_posted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('POSTED','REVERSED') THEN
        -- Allow only the narrow set of columns that amendment/reversal links use
        IF (NEW.* IS DISTINCT FROM OLD.*) AND
           (NEW.status, NEW.amended_by_grn_id, NEW.reversal_of_grn_id)
           IS NOT DISTINCT FROM
           (OLD.status, OLD.amended_by_grn_id, OLD.reversal_of_grn_id) THEN
            RAISE EXCEPTION
              'posted_document_immutable: GRN % is % and cannot be edited directly',
              OLD.grn_no, OLD.status
              USING ERRCODE = '0A000';
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
--  Document numbering — concurrency-safe. NEVER use MAX(no)+1.
--  Call INSIDE the same transaction that inserts the document.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_doc_no(
    p_company uuid,
    p_branch  uuid,
    p_type    text,
    p_fy      text
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix text;
    v_width  int;
    v_no     bigint;
BEGIN
    -- FOR UPDATE serialises concurrent callers on this one series row
    UPDATE number_series
       SET next_no = next_no + 1
     WHERE company_id = p_company
       AND branch_id  = p_branch
       AND doc_type   = p_type
       AND fy         = p_fy
    RETURNING prefix, width, next_no INTO v_prefix, v_width, v_no;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'number_series_missing: %/%/% for company %',
            p_type, p_fy, p_branch, p_company
            USING ERRCODE = '23503';
    END IF;

    RETURN v_prefix || '/' || p_fy || '/' || lpad(v_no::text, v_width, '0');
END $$;

COMMENT ON FUNCTION next_doc_no IS
  'Returns e.g. PO/2026-27/000123. Row-locked, gapless within a committed tx.';

-- ---------------------------------------------------------------------------
--  Current tenant / actor, read from session GUCs set by the API per request:
--     SET LOCAL app.company_id = '...';  SET LOCAL app.user_id = '...';
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
--  Generic audit trigger — captures before/after/diff for any table.
--  Attached selectively (see SECTION 09); not every table needs it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_audit_row()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_before jsonb;
    v_after  jsonb;
    v_diff   jsonb;
    v_id     uuid;
    v_company uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_before := NULL;  v_after := to_jsonb(NEW);
    ELSIF TG_OP = 'UPDATE' THEN
        v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    ELSE
        v_before := to_jsonb(OLD); v_after := NULL;
    END IF;

    -- Most auditable entities use an `id` UUID.  A few relationship tables
    -- deliberately use composite keys, so read the optional field from JSON
    -- instead of assuming NEW/OLD has an `id` column.
    v_id := NULLIF(COALESCE(v_after, v_before)->>'id', '')::uuid;

    IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(key, jsonb_build_object('old', v_before->key,
                                                        'new', v_after->key))
          INTO v_diff
          FROM jsonb_each(v_after)
         WHERE v_after->key IS DISTINCT FROM v_before->key
           AND key NOT IN ('updated_at','version');
        IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
            RETURN COALESCE(NEW, OLD);   -- nothing meaningful changed
        END IF;
    END IF;

    v_company := COALESCE(v_after->>'company_id', v_before->>'company_id')::uuid;

    INSERT INTO audit_log (
        company_id, actor_id, actor_role, branch_id, session_id,
        ip, device_fingerprint, entity_type, entity_id, action,
        before, after, diff, reason_code, reason_text, request_id, occurred_at)
    VALUES (
        COALESCE(v_company, current_company_id()),
        current_actor_id(),
        nullif(current_setting('app.actor_role', true), ''),
        COALESCE(v_after->>'branch_id', v_before->>'branch_id')::uuid,
        nullif(current_setting('app.session_id', true), '')::uuid,
        nullif(current_setting('app.ip', true), '')::inet,
        nullif(current_setting('app.device', true), ''),
        TG_TABLE_NAME, v_id, TG_OP,
        v_before, v_after, v_diff,
        nullif(current_setting('app.reason_code', true), ''),
        nullif(current_setting('app.reason_text', true), ''),
        nullif(current_setting('app.request_id', true), ''),
        now());

    RETURN COALESCE(NEW, OLD);
END $$;

-- ============================================================================
--  SECTION 02 — ORGANISATION, USERS, RBAC
-- ============================================================================

CREATE TABLE companies (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    code                text NOT NULL UNIQUE,
    legal_name          text NOT NULL,
    trade_name          text,
    gstin               gstin_t,
    pan                 pan_t,
    fssai_lic_no        fssai_t,
    fssai_expiry        date,
    registered_address  jsonb,
    fy_start_month      smallint NOT NULL DEFAULT 4
                        CHECK (fy_start_month BETWEEN 1 AND 12),
    base_currency       char(3) NOT NULL DEFAULT 'INR',
    timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
    default_locale      text NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en','hi')),
    status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1
);

CREATE TABLE branches (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    code          text NOT NULL,
    name          text NOT NULL,
    name_hi       text,
    type          text NOT NULL CHECK (type IN ('BRANCH','WAREHOUSE','BOTH')),
    gstin         gstin_t,
    fssai_lic_no  fssai_t,
    fssai_expiry  date,
    address       jsonb,
    geo_lat       numeric(10,7),
    geo_lng       numeric(10,7),
    contact_phone text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE warehouses (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    branch_id      uuid NOT NULL REFERENCES branches(id)  ON DELETE RESTRICT,
    code           text NOT NULL,
    name           text NOT NULL,
    storage_types  text[] NOT NULL DEFAULT '{AMBIENT}'
                   CHECK (storage_types <@ ARRAY['AMBIENT','CHILLED','COLD','FROZEN','RIPENING']),
    has_weighbridge boolean NOT NULL DEFAULT false,
    weighbridge_capacity_kg weight_kg,
    weighbridge_stamp_expiry date,   -- Legal Metrology verification certificate
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE zones (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    code          text NOT NULL,
    name          text,
    storage_type  text NOT NULL DEFAULT 'AMBIENT'
                  CHECK (storage_type IN ('AMBIENT','CHILLED','COLD','FROZEN','RIPENING','QUARANTINE')),
    temp_min_c    numeric(5,2),
    temp_max_c    numeric(5,2),
    humidity_min  pct,
    humidity_max  pct,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,
    UNIQUE (warehouse_id, code),
    CHECK (temp_min_c IS NULL OR temp_max_c IS NULL OR temp_min_c <= temp_max_c)
);

CREATE TABLE racks (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id uuid NOT NULL REFERENCES companies(id),
    zone_id    uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    code       text NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    version    integer NOT NULL DEFAULT 1,
    UNIQUE (zone_id, code)
);

CREATE TABLE bins (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    rack_id           uuid NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
    code              text NOT NULL,
    capacity_kg       weight_kg,
    capacity_crates   integer,
    current_fill_kg   weight_kg NOT NULL DEFAULT 0,
    is_pickface       boolean NOT NULL DEFAULT false,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (rack_id, code)
);

-- ---------------------------------------------------------------------------
--  Users, roles, permissions, scopes, limits
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    employee_code      text,
    full_name          text NOT NULL,
    email              text,
    phone              text,
    password_hash      text,                    -- argon2id
    mfa_secret_enc     bytea,                   -- app-layer encrypted TOTP secret
    mfa_enabled        boolean NOT NULL DEFAULT false,
    locale             text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','hi')),
    default_branch_id  uuid REFERENCES branches(id),
    status             text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','DISABLED')),
    last_login_at      timestamptz,
    failed_login_count smallint NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    password_changed_at timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid,
    version            integer NOT NULL DEFAULT 1,
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX uq_users_email  ON users (company_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_phone  ON users (company_id, phone)        WHERE phone IS NOT NULL;

-- Global permission catalogue (not tenant-scoped; codes are product-wide)
CREATE TABLE permissions (
    code        text PRIMARY KEY,          -- e.g. purchase.po.approve
    module      text NOT NULL,
    entity      text NOT NULL,
    action      text NOT NULL,
    description text NOT NULL,
    is_data_level boolean NOT NULL DEFAULT false,  -- data.cost.view etc.
    risk_level  text NOT NULL DEFAULT 'NORMAL'
                CHECK (risk_level IN ('NORMAL','SENSITIVE','CRITICAL'))
);

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code        text NOT NULL,
    name        text NOT NULL,
    name_hi     text,
    description text,
    is_system   boolean NOT NULL DEFAULT false,   -- system roles cannot be deleted
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE role_permissions (
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    granted_by      uuid,
    PRIMARY KEY (role_id, permission_code)
);

-- Approval / data limits attached to a role. Re-read at decision time,
-- NEVER cached into the JWT, so revocation takes effect immediately.
CREATE TABLE role_limits (
    role_id                uuid PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
    max_po_value           money_null,
    max_rate_variance_pct  pct,
    max_qty_variance_pct   pct,
    max_weight_variance_pct pct,
    max_backdate_days      smallint NOT NULL DEFAULT 0,
    max_approval_level     smallint NOT NULL DEFAULT 0
                           CHECK (max_approval_level BETWEEN 0 AND 3),
    max_invoice_mismatch_value money_null,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    updated_by             uuid
);

-- A user may hold several roles, each scoped to specific branches/warehouses
CREATE TABLE user_role_assignments (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    branch_ids    uuid[] NOT NULL DEFAULT '{}',   -- empty = all branches in scope
    warehouse_ids uuid[] NOT NULL DEFAULT '{}',
    valid_from    date NOT NULL DEFAULT CURRENT_DATE,
    valid_to      date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX uq_user_role_active
    ON user_role_assignments (user_id, role_id)
    WHERE valid_to IS NULL;

CREATE TABLE sessions (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_role_id     uuid REFERENCES roles(id),
    active_branch_id   uuid REFERENCES branches(id),
    refresh_token_hash text NOT NULL,
    device_fingerprint text,
    user_agent         text,
    ip                 inet,
    panel              text CHECK (panel IN ('OWNER','PURCHASE','GATE','QC','WAREHOUSE','FINANCE','SUPPLIER')),
    issued_at          timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    revoked_reason     text,
    rotated_from       uuid REFERENCES sessions(id)   -- refresh-token reuse detection
);
CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- ============================================================================
--  SECTION 03 — MASTER DATA
--  Spec §25: master data centralised; no duplicate supplier/product/UOM/tax.
-- ============================================================================

CREATE TABLE uoms (
    code           text PRIMARY KEY,             -- KG, QTL, TON, PCS, CRATE, BAG, DOZ
    name           text NOT NULL,
    name_hi        text,
    uom_type       text NOT NULL CHECK (uom_type IN ('WEIGHT','COUNT','VOLUME')),
    base_uom       text REFERENCES uoms(code),
    factor_to_base numeric(18,6) NOT NULL DEFAULT 1
);

CREATE TABLE tax_codes (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    code           text NOT NULL UNIQUE,          -- GST0, GST5, GST12, GST18
    name           text NOT NULL,
    gst_rate       pct NOT NULL DEFAULT 0,
    cess_rate      pct NOT NULL DEFAULT 0,
    is_input_creditable boolean NOT NULL DEFAULT true,
    effective_from date NOT NULL DEFAULT CURRENT_DATE,
    effective_to   date,
    is_active      boolean NOT NULL DEFAULT true
);

-- Charge types drive the landing-cost allocation engine (§16)
CREATE TABLE charge_types (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code                  text NOT NULL,
    name                  text NOT NULL,
    name_hi               text,
    allocation_basis      text NOT NULL DEFAULT 'VALUE'
                          CHECK (allocation_basis IN ('VALUE','WEIGHT','QTY','EQUAL','MANUAL')),
    is_creditable         boolean NOT NULL DEFAULT false,
    affects_landing_cost  boolean NOT NULL DEFAULT true,
    default_amount        money_null,
    default_pct           pct,
    borne_by              text NOT NULL DEFAULT 'BUYER'
                          CHECK (borne_by IN ('BUYER','SUPPLIER','SHARED')),
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid,
    version               integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE product_categories (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    parent_id   uuid REFERENCES product_categories(id),
    code        text NOT NULL,
    name        text NOT NULL,
    name_hi     text,
    segment     text NOT NULL CHECK (segment IN ('FRUIT','VEGETABLE','GROCERY','DAIRY','SPICE','GRAIN','OTHER')),
    default_qc_template_id uuid,   -- FK added after qc_templates exists
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE products (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    sku                 text NOT NULL,
    name                text NOT NULL,
    name_hi             text,
    category_id         uuid NOT NULL REFERENCES product_categories(id),
    variety             text,                     -- Alphonso, Kufri Jyoti, Nashik red
    base_uom            text NOT NULL REFERENCES uoms(code),
    purchase_uom        text NOT NULL REFERENCES uoms(code),
    is_variable_weight  boolean NOT NULL DEFAULT false,  -- §14 variable-weight crates
    is_perishable       boolean NOT NULL DEFAULT true,
    is_batch_tracked    boolean NOT NULL DEFAULT true,
    shelf_life_days     smallint,
    storage_type        text NOT NULL DEFAULT 'AMBIENT'
                        CHECK (storage_type IN ('AMBIENT','CHILLED','COLD','FROZEN','RIPENING')),
    storage_temp_min_c  numeric(5,2),
    storage_temp_max_c  numeric(5,2),
    rotation_rule       text NOT NULL DEFAULT 'FEFO'
                        CHECK (rotation_rule IN ('FEFO','FIFO','LIFO')),
    hsn_code            hsn_t,
    tax_code_id         uuid REFERENCES tax_codes(id),
    -- planning parameters (§5)
    min_stock           qty_amt,
    max_stock           qty_amt,
    reorder_point       qty_amt,
    safety_stock_days   numeric(6,2) DEFAULT 1,
    lead_time_days      numeric(6,2) DEFAULT 1,
    moq                 qty_amt,
    order_multiple      qty_amt,
    abc_class           char(1) CHECK (abc_class IN ('A','B','C')),
    default_wastage_pct pct NOT NULL DEFAULT 0,
    -- quality
    qc_template_id      uuid,                     -- FK added after qc_templates
    agmark_grade_scheme text,
    grades_allowed      text[] DEFAULT ARRAY['A','B','C'],
    -- tolerances (fall back to company settings when null)
    rate_tolerance_pct  pct,
    qty_tolerance_pct   pct,
    weight_tolerance_pct pct,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, sku)
);

CREATE TABLE product_uoms (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    uom               text NOT NULL REFERENCES uoms(code),
    conversion_to_base numeric(18,6) NOT NULL CHECK (conversion_to_base > 0),
    is_purchase_default boolean NOT NULL DEFAULT false,
    UNIQUE (product_id, uom)
);

CREATE TABLE product_aliases (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id uuid NOT NULL REFERENCES companies(id),
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alias      text NOT NULL,       -- how a supplier/mandi/invoice names it
    source     text CHECK (source IN ('SUPPLIER','MANDI','INVOICE','OCR')),
    supplier_id uuid,               -- FK added after suppliers
    UNIQUE (company_id, alias, source)
);

-- ---------------------------------------------------------------------------
--  Suppliers and the four source types (§6)
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    code                text NOT NULL,
    legal_name          text NOT NULL,
    trade_name          text,
    source_type         text NOT NULL
                        CHECK (source_type IN ('FARMER','MANDI','AADHTI','WHOLESALER')),
    gstin               gstin_t,
    pan                 pan_t,
    fssai_lic_no        fssai_t,
    fssai_expiry        date,
    msme_no             text,
    is_composition_dealer boolean NOT NULL DEFAULT false,
    is_unregistered     boolean NOT NULL DEFAULT false,  -- most farmers; RCM implications
    phone               text,
    alt_phone           text,
    email               text,
    address             jsonb,
    district            text,
    state_code          char(2),
    geo_lat             numeric(10,7),
    geo_lng             numeric(10,7),
    -- banking (app-layer encrypted; never rendered unmasked)
    bank_account_enc    bytea,
    bank_ifsc           text,
    bank_masked         text,
    upi_masked          text,
    -- commercial terms
    payment_terms_days  smallint NOT NULL DEFAULT 0,
    credit_limit        money_null,
    default_charge_profile jsonb,
    -- status & scoring (§7)
    status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('DRAFT','ACTIVE','PREFERRED','ON_HOLD','BLOCKED')),
    status_reason       text,
    status_changed_at   timestamptz,
    status_changed_by   uuid,
    trust_score         numeric(5,2) CHECK (trust_score BETWEEN 0 AND 100),
    performance_score   numeric(5,2) CHECK (performance_score BETWEEN 0 AND 100),
    scores_updated_at   timestamptz,
    first_purchase_at   timestamptz,
    last_purchase_at    timestamptz,
    -- DPDP Act 2023
    consent_obtained_at timestamptz,
    consent_purpose     text[],
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);
-- Duplicate-master prevention (§25)
CREATE UNIQUE INDEX uq_supplier_gstin ON suppliers (company_id, gstin) WHERE gstin IS NOT NULL;
CREATE UNIQUE INDEX uq_supplier_pan   ON suppliers (company_id, pan)   WHERE pan   IS NOT NULL;
CREATE UNIQUE INDEX uq_supplier_phone ON suppliers (company_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE product_aliases
    ADD CONSTRAINT fk_alias_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

CREATE TABLE mandis (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id uuid NOT NULL REFERENCES companies(id),
    name       text NOT NULL,
    apmc_code  text,                       -- maps to Agmarknet market code
    district   text,
    state_code char(2),
    geo_lat    numeric(10,7),
    geo_lng    numeric(10,7),
    is_active  boolean NOT NULL DEFAULT true,
    UNIQUE (company_id, name, district)
);

CREATE TABLE aadhtis (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id            uuid NOT NULL REFERENCES companies(id),
    supplier_id           uuid NOT NULL UNIQUE REFERENCES suppliers(id) ON DELETE CASCADE,
    mandi_id              uuid REFERENCES mandis(id),
    licence_no            text,
    commission_pct        pct NOT NULL DEFAULT 0,
    settlement_cycle_days smallint NOT NULL DEFAULT 7,
    market_fee_pct        pct NOT NULL DEFAULT 0,
    hamali_rate           money_null,      -- loading/unloading labour per unit
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid,
    version               integer NOT NULL DEFAULT 1
);

CREATE TABLE farms (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    name            text,
    khasra_no       text,
    village         text,
    area_acre       numeric(10,3),
    crops           text[],
    certifications  text[],                 -- ORGANIC_NPOP, GLOBALGAP, INDGAP
    cert_expiry     date,
    geo_lat         numeric(10,7),
    geo_lng         numeric(10,7),
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    version         integer NOT NULL DEFAULT 1
);

CREATE TABLE supplier_products (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    typical_grade   text,
    moq             qty_amt,
    lead_time_days  numeric(6,2),
    last_rate       rate_amt,
    last_purchase_at timestamptz,
    avg_rejection_pct pct,
    is_preferred    boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    version         integer NOT NULL DEFAULT 1,
    UNIQUE (supplier_id, product_id)
);

-- ---------------------------------------------------------------------------
--  Vehicles, drivers, containers (§10, §11, §14)
-- ---------------------------------------------------------------------------
CREATE TABLE vehicles (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    reg_no              vehicle_reg_t NOT NULL,
    vehicle_type        text NOT NULL DEFAULT 'TRUCK'
                        CHECK (vehicle_type IN ('TRUCK','TEMPO','PICKUP','TRACTOR','REEFER','CONTAINER','TWO_WHEELER')),
    make_model          text,
    capacity_kg         weight_kg,
    is_reefer           boolean NOT NULL DEFAULT false,
    reefer_min_temp_c   numeric(5,2),
    tare_reference_kg   weight_kg,              -- for single-weighment estimates
    tare_verified_at    timestamptz,
    -- compliance expiries, checked at every gate entry (§12.2)
    fitness_expiry      date,
    insurance_expiry    date,
    puc_expiry          date,
    permit_expiry       date,
    owner_supplier_id   uuid REFERENCES suppliers(id),
    transporter_name    text,
    status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','WATCH','BLOCKED')),
    status_reason       text,
    -- rolling behaviour, maintained by a nightly job
    trips_90d           integer NOT NULL DEFAULT 0,
    avg_weight_variance_pct pct,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, reg_no)
);

CREATE TABLE drivers (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id),
    full_name   text NOT NULL,
    phone       text,
    dl_number   text,
    dl_expiry   date,
    photo_key   text,
    status      text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','WATCH','BLOCKED')),
    consent_obtained_at timestamptz,        -- DPDP
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, dl_number)
);

CREATE TABLE container_types (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    code          text NOT NULL,
    name          text NOT NULL,
    container_kind text NOT NULL
                  CHECK (container_kind IN ('CRATE','BAG','BOX','PALLET','DRUM','TRAY')),
    tare_kg       weight_kg NOT NULL,       -- critical for net weight (§11)
    is_returnable boolean NOT NULL DEFAULT true,
    deposit_amount money_null,
    owner         text CHECK (owner IN ('OWN','SUPPLIER','THIRD_PARTY')),
    rfid_enabled  boolean NOT NULL DEFAULT false,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

-- Individually tracked reusable crates/pallets (§14, RFID optional)
CREATE TABLE containers (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    container_type_id uuid NOT NULL REFERENCES container_types(id),
    code              text NOT NULL,
    rfid_tag          text,
    actual_tare_kg    weight_kg,
    current_location  text,
    held_by_supplier_id uuid REFERENCES suppliers(id),
    status            text NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (status IN ('AVAILABLE','IN_USE','WITH_SUPPLIER','DAMAGED','LOST')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX uq_container_rfid ON containers (company_id, rfid_tag) WHERE rfid_tag IS NOT NULL;

-- Weighbridges / platform scales, and the HMAC key used to sign readings (§12.6)
CREATE TABLE scale_devices (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
    code              text NOT NULL,
    device_kind       text NOT NULL CHECK (device_kind IN ('WEIGHBRIDGE','PLATFORM','BENCH')),
    make              text,
    model             text,
    protocol          text CHECK (protocol IN ('SERIAL_ASCII','MODBUS_RTU','TCP','HID','MANUAL')),
    baud_rate         integer,
    parser_key        text,        -- selects the site-agent parser implementation
    capacity_kg       weight_kg,
    least_count_kg    numeric(8,3),
    hmac_key_enc      bytea NOT NULL,
    verification_expiry date,      -- Legal Metrology stamping
    last_seen_at      timestamptz,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE number_series (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id  uuid NOT NULL REFERENCES branches(id)  ON DELETE CASCADE,
    doc_type   text NOT NULL
               CHECK (doc_type IN ('REQ','RFQ','IND','PO','GATE','WGT','QC','GRN',
                                   'BATCH','LABEL','INV','DN','CN','PUT')),
    fy         text NOT NULL,          -- '2026-27'
    prefix     text NOT NULL,
    next_no    bigint NOT NULL DEFAULT 1,
    width      smallint NOT NULL DEFAULT 6,
    UNIQUE (company_id, branch_id, doc_type, fy)
);

-- ============================================================================
--  SECTION 04 — REQUIREMENT, SOURCING, PURCHASE ORDER, APPROVAL
--  Spec §5 §6 §7 §8 §9
-- ============================================================================

CREATE TABLE requirements (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    warehouse_id   uuid REFERENCES warehouses(id),
    req_no         text NOT NULL,
    req_date       date NOT NULL DEFAULT CURRENT_DATE,
    required_date  date NOT NULL,
    priority       text NOT NULL DEFAULT 'NORMAL'
                   CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    -- §2: the eight demand origins
    source         text NOT NULL DEFAULT 'MANUAL'
                   CHECK (source IN ('MANUAL','LOW_STOCK','MIN_MAX','SALES_DEMAND',
                                     'BRANCH_DEMAND','WAREHOUSE_DEMAND','PENDING_ORDER',
                                     'ADVANCE_ORDER','SEASONAL','AI_FORECAST','SAFETY_STOCK')),
    status         text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','CONVERTED',
                                     'CLOSED','CANCELLED')),
    submitted_at   timestamptz,
    submitted_by   uuid REFERENCES users(id),
    approved_at    timestamptz,
    approved_by    uuid REFERENCES users(id),
    closed_at      timestamptz,
    cancel_reason  text,
    remarks        text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, req_no)
);

CREATE TABLE requirement_lines (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    requirement_id    uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    line_no           smallint NOT NULL,
    product_id        uuid NOT NULL REFERENCES products(id),
    uom               text NOT NULL REFERENCES uoms(code),
    -- decision context snapshot, frozen at suggestion time (§5)
    current_stock     qty_amt,
    available_stock   qty_amt,
    reserved_qty      qty_amt,
    in_transit_qty    qty_amt,
    open_po_qty       qty_amt,
    avg_daily_sale    qty_amt,
    lead_time_days    numeric(6,2),
    min_stock         qty_amt,
    max_stock         qty_amt,
    -- suggestion vs decision
    suggested_qty     qty_amt,
    suggested_by      text CHECK (suggested_by IN ('RULE','AI','NONE')),
    suggestion_reason jsonb,          -- human-readable drivers, shown in UI
    ai_run_id         uuid,           -- FK added after ai_runs
    ai_confidence     numeric(5,4),
    final_qty         qty_amt NOT NULL,
    edit_reason       text,           -- §5 mandatory when final <> suggested
    -- duplicate / overlap warnings surfaced at entry time
    duplicate_warning jsonb,
    advance_order_qty qty_amt NOT NULL DEFAULT 0,
    converted_qty     qty_amt NOT NULL DEFAULT 0,
    line_status       text NOT NULL DEFAULT 'OPEN'
                      CHECK (line_status IN ('OPEN','PART_CONVERTED','CONVERTED','CANCELLED')),
    remarks           text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (requirement_id, line_no),
    CHECK (final_qty > 0),
    -- If the user overrode the AI/rule suggestion, a reason is mandatory
    CHECK (suggested_qty IS NULL OR final_qty = suggested_qty OR edit_reason IS NOT NULL)
);

-- Raw demand feed from Sales/Branch/Advance orders; input to the forecaster
CREATE TABLE demand_signals (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id),
    branch_id   uuid NOT NULL REFERENCES branches(id),
    product_id  uuid NOT NULL REFERENCES products(id),
    signal_date date NOT NULL,
    signal_type text NOT NULL
                CHECK (signal_type IN ('SALE','ADVANCE_ORDER','BRANCH_INDENT',
                                       'WASTAGE','RETURN','STOCKOUT','FESTIVAL','PROMO')),
    qty         qty_amt NOT NULL,
    meta        jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  RFQ / quotes / source comparison (§7)
-- ---------------------------------------------------------------------------
CREATE TABLE rfqs (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    rfq_no         text NOT NULL,
    requirement_id uuid REFERENCES requirements(id),
    status         text NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('DRAFT','OPEN','CLOSED','CANCELLED')),
    valid_till     date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, rfq_no)
);

CREATE TABLE supplier_quotes (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    rfq_id              uuid REFERENCES rfqs(id) ON DELETE CASCADE,
    requirement_line_id uuid REFERENCES requirement_lines(id),
    supplier_id         uuid NOT NULL REFERENCES suppliers(id),
    source_type         text NOT NULL
                        CHECK (source_type IN ('FARMER','MANDI','AADHTI','WHOLESALER')),
    mandi_id            uuid REFERENCES mandis(id),
    product_id          uuid NOT NULL REFERENCES products(id),
    quoted_rate         rate_amt NOT NULL,
    uom                 text NOT NULL REFERENCES uoms(code),
    available_qty       qty_amt,
    offered_grade       text,
    valid_till          date,
    payment_terms_days  smallint,
    -- §7: rate alone is not the decision. These build the comparison.
    charges             jsonb,               -- {commission, transport, loading, packing}
    computed_landed_rate rate_amt,           -- rate + charges + expected losses
    expected_rejection_pct pct,
    expected_shortage_pct  pct,
    credit_cost         money_null,
    quality_score_hist  numeric(5,2),
    on_time_pct_hist    pct,
    rank                smallint,
    ai_score            numeric(6,3),
    ai_reason           jsonb,
    ai_run_id           uuid,
    is_selected         boolean NOT NULL DEFAULT false,
    selected_by         uuid REFERENCES users(id),
    selection_reason    text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
--  Indent / Purchase Order (§8)
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_orders (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    branch_id           uuid NOT NULL REFERENCES branches(id),
    warehouse_id        uuid REFERENCES warehouses(id),
    po_no               text NOT NULL,
    doc_type            text NOT NULL DEFAULT 'PO' CHECK (doc_type IN ('PO','INDENT')),
    requirement_id      uuid REFERENCES requirements(id),
    supplier_id         uuid NOT NULL REFERENCES suppliers(id),
    source_type         text NOT NULL
                        CHECK (source_type IN ('FARMER','MANDI','AADHTI','WHOLESALER')),
    mandi_id            uuid REFERENCES mandis(id),
    order_date          date NOT NULL DEFAULT CURRENT_DATE,
    expected_date       date NOT NULL,
    expected_window_start timestamptz,
    expected_window_end   timestamptz,
    delivery_location   text,
    delivery_terms      text,
    transport_by        text CHECK (transport_by IN ('SUPPLIER','BUYER','THIRD_PARTY')),
    payment_terms_days  smallint NOT NULL DEFAULT 0,
    currency            char(3) NOT NULL DEFAULT 'INR',
    -- amounts
    subtotal            money_amt,
    discount_total      money_amt,
    charge_total        money_amt,
    tax_total           money_amt,
    grand_total         money_amt,
    estimated_landed_total money_amt,
    -- tolerance rules (§8), fall back to product then company settings
    rate_tolerance_pct  pct,
    qty_tolerance_pct   pct,
    -- lifecycle (§27)
    status              text NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','CONFIRMED',
                                          'PART_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
    revision_no         smallint NOT NULL DEFAULT 0,
    submitted_at        timestamptz,
    submitted_by        uuid REFERENCES users(id),
    approved_at         timestamptz,
    approved_by         uuid REFERENCES users(id),
    confirmed_at        timestamptz,
    closed_at           timestamptz,
    cancel_reason       text,
    is_urgent           boolean NOT NULL DEFAULT false,
    remarks             text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, po_no),
    -- Maker-checker: the submitter can never be the approver (§9)
    CONSTRAINT ck_po_maker_checker CHECK (approved_by IS NULL OR approved_by <> submitted_by)
);

CREATE TABLE po_lines (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    po_id             uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    line_no           smallint NOT NULL,
    requirement_line_id uuid REFERENCES requirement_lines(id),
    product_id        uuid NOT NULL REFERENCES products(id),
    qty               qty_amt NOT NULL CHECK (qty > 0),
    uom               text NOT NULL REFERENCES uoms(code),
    qty_in_base       qty_amt NOT NULL,
    expected_weight_kg weight_kg,
    rate              rate_amt NOT NULL CHECK (rate >= 0),
    discount_pct      pct NOT NULL DEFAULT 0,
    discount_amount   money_amt,
    tax_code_id       uuid REFERENCES tax_codes(id),
    tax_amount        money_amt,
    line_total        money_amt,
    expected_grade    text,
    -- receipt progress, maintained by GRN posting
    received_qty      qty_amt NOT NULL DEFAULT 0,
    accepted_qty      qty_amt NOT NULL DEFAULT 0,
    rejected_qty      qty_amt NOT NULL DEFAULT 0,
    line_status       text NOT NULL DEFAULT 'OPEN'
                      CHECK (line_status IN ('OPEN','PART_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
    remarks           text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (po_id, line_no),
    CHECK (accepted_qty + rejected_qty <= received_qty + 0.001)
);

CREATE TABLE po_charges (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    po_id           uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    charge_type_id  uuid NOT NULL REFERENCES charge_types(id),
    amount          money_amt NOT NULL,
    allocation_basis text NOT NULL
                    CHECK (allocation_basis IN ('VALUE','WEIGHT','QTY','EQUAL','MANUAL')),
    borne_by        text NOT NULL DEFAULT 'BUYER'
                    CHECK (borne_by IN ('BUYER','SUPPLIER','SHARED')),
    is_creditable   boolean NOT NULL DEFAULT false,
    third_party_supplier_id uuid REFERENCES suppliers(id),   -- transporter, hamali
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid
);

-- Full revision history with old/new diff (§8)
CREATE TABLE po_revisions (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id   uuid NOT NULL REFERENCES companies(id),
    po_id        uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    revision_no  smallint NOT NULL,
    changed_by   uuid NOT NULL REFERENCES users(id),
    changed_at   timestamptz NOT NULL DEFAULT now(),
    diff         jsonb NOT NULL,
    reason_code  text,
    reason_text  text NOT NULL,
    UNIQUE (po_id, revision_no)
);

-- ---------------------------------------------------------------------------
--  Approval engine (§9) — generic over document types
-- ---------------------------------------------------------------------------
CREATE TABLE approval_rules (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id          uuid REFERENCES branches(id),        -- null = all branches
    doc_type           text NOT NULL CHECK (doc_type IN ('REQUIREMENT','PO','GRN','INVOICE','RATE_REVISION')),
    trigger_code       text NOT NULL
                       CHECK (trigger_code IN ('VALUE','RATE_VARIANCE','QTY_VARIANCE',
                                               'WEIGHT_VARIANCE','NEW_SUPPLIER','SUPPLIER_RISK',
                                               'MARGIN_RISK','URGENT','LANDING_COST','BACKDATE')),
    threshold_numeric  numeric(18,4),
    required_level     smallint NOT NULL CHECK (required_level BETWEEN 1 AND 3),
    required_role_id   uuid REFERENCES roles(id),
    sla_minutes        integer NOT NULL DEFAULT 240,
    escalate_after_minutes integer,
    escalate_to_role_id uuid REFERENCES roles(id),
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid,
    version            integer NOT NULL DEFAULT 1
);

CREATE TABLE approvals (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    doc_type       text NOT NULL
                   CHECK (doc_type IN ('REQUIREMENT','PO','GRN','INVOICE','RATE_REVISION',
                                       'GATE_EXCEPTION','WEIGHT_VARIANCE','QC_OVERRIDE',
                                       'GRN_REVERSAL','SUPPLIER_STATUS')),
    doc_id         uuid NOT NULL,
    doc_no         text,
    level          smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
    triggers       text[] NOT NULL DEFAULT '{}',
    trigger_detail jsonb,
    required_role_id uuid REFERENCES roles(id),
    requested_by   uuid NOT NULL REFERENCES users(id),
    requested_at   timestamptz NOT NULL DEFAULT now(),
    sla_due_at     timestamptz,
    status         text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','HELD','REJECTED','WITHDRAWN','ESCALATED')),
    approver_id    uuid REFERENCES users(id),
    decided_at     timestamptz,
    reason_code    text,
    reason_text    text,
    escalated_from uuid REFERENCES approvals(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    version        integer NOT NULL DEFAULT 1,
    -- §9: maker cannot be checker; hold/reject need a reason
    CONSTRAINT ck_appr_maker_checker CHECK (approver_id IS NULL OR approver_id <> requested_by),
    CONSTRAINT ck_appr_reason CHECK (status NOT IN ('HELD','REJECTED') OR reason_text IS NOT NULL)
);
CREATE INDEX ix_approvals_pending ON approvals (company_id, branch_id, status, sla_due_at)
    WHERE status = 'PENDING';

-- ============================================================================
--  SECTION 05 — RECEIVING CHAIN
--  Gate -> Weighment -> QC -> GRN -> Batch/Label -> Put-away
--  Spec §10 §11 §12 §13 §14 §15. This chain cannot be bypassed (§28).
-- ============================================================================

CREATE TABLE expected_arrivals (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
    po_id         uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    expected_date date NOT NULL,
    window_start  timestamptz,
    window_end    timestamptz,
    slot_booked_by text,                    -- supplier portal slot booking (P7)
    vehicle_hint  vehicle_reg_t,
    status        text NOT NULL DEFAULT 'EXPECTED'
                  CHECK (status IN ('EXPECTED','ARRIVED','MISSED','CANCELLED')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
--  GATE ENTRY (§10) — record is LOCKED on submit; later changes are amendments
-- ---------------------------------------------------------------------------
CREATE TABLE gate_entries (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    branch_id           uuid NOT NULL REFERENCES branches(id),
    warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
    gate_no             text NOT NULL,
    direction           text NOT NULL DEFAULT 'IN' CHECK (direction IN ('IN','OUT')),
    po_id               uuid REFERENCES purchase_orders(id),
    expected_arrival_id uuid REFERENCES expected_arrivals(id),
    supplier_id         uuid NOT NULL REFERENCES suppliers(id),
    source_type         text NOT NULL
                        CHECK (source_type IN ('FARMER','MANDI','AADHTI','WHOLESALER')),
    -- vehicle & driver
    vehicle_id          uuid REFERENCES vehicles(id),
    vehicle_reg_captured vehicle_reg_t NOT NULL,
    driver_id           uuid REFERENCES drivers(id),
    driver_name         text,
    driver_phone        text,
    transporter         text,
    -- documents (§10)
    seal_no             text,
    seal_intact         boolean,
    eway_bill_no        text,
    eway_generated_at   timestamptz,
    eway_valid_until    timestamptz,
    eway_vehicle_no     vehicle_reg_t,        -- cross-check vs actual + ANPR
    eway_verified       boolean,
    eway_verify_source  text CHECK (eway_verify_source IN ('GSP_API','MANUAL','OCR')),
    supplier_invoice_ref text,
    lr_no               text,
    mandi_patti_no      text,
    -- ANPR (§12.3)
    anpr_reading        text,
    anpr_confidence     numeric(5,4),
    anpr_matched        boolean,
    anpr_frame_key      text,
    -- checklist (§12.4)
    checklist_template_id uuid,
    checklist_result    jsonb,
    checklist_score     numeric(5,2),
    critical_fail       boolean NOT NULL DEFAULT false,
    -- timings (§12.7)
    arrived_at          timestamptz NOT NULL DEFAULT now(),
    docs_verified_at    timestamptz,
    unloading_start_at  timestamptz,
    unloading_end_at    timestamptz,
    gate_out_at         timestamptz,
    turnaround_minutes  integer GENERATED ALWAYS AS
        (CASE WHEN gate_out_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (gate_out_at - arrived_at)) / 60)::integer END) STORED,
    detention_minutes   integer,
    -- exception path (§28): the ONLY way to bypass the chain
    is_unplanned        boolean NOT NULL DEFAULT false,
    exception_reason    text,
    exception_approved_by uuid REFERENCES users(id),
    exception_approved_at timestamptz,
    -- lifecycle (§27)
    status              text NOT NULL DEFAULT 'ARRIVED'
                        CHECK (status IN ('ARRIVED','WEIGHED','QC_PENDING','QC_COMPLETE',
                                          'GRN_PENDING','COMPLETED','REJECTED_AT_GATE','CANCELLED')),
    rejected_reason     text,
    locked_at           timestamptz,          -- §10 immutable after submit
    remarks             text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, gate_no),
    -- An unplanned arrival (no PO) demands an approved exception
    CONSTRAINT ck_gate_exception CHECK (
        po_id IS NOT NULL OR is_unplanned = false
        OR (exception_reason IS NOT NULL AND exception_approved_by IS NOT NULL))
);

CREATE TABLE gate_entry_docs (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    gate_entry_id uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    doc_type      text NOT NULL
                  CHECK (doc_type IN ('INVOICE','EWAY_BILL','LR','MANDI_PATTI','DO',
                                      'WEIGH_SLIP','QUALITY_CERT','PERMIT','OTHER')),
    file_key      text NOT NULL,
    ocr_json      jsonb,
    ocr_confidence numeric(5,4),
    ocr_model     text,
    verified_by   uuid REFERENCES users(id),
    verified_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid
);

CREATE TABLE gate_entry_photos (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    gate_entry_id uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    kind          text NOT NULL
                  CHECK (kind IN ('VEHICLE_FRONT','NUMBER_PLATE','LOAD_OPEN','SEAL',
                                  'DRIVER','CONTAINER_INTERIOR','DAMAGE','OTHER')),
    file_key      text NOT NULL,
    geo_lat       numeric(10,7),
    geo_lng       numeric(10,7),
    captured_at   timestamptz NOT NULL DEFAULT now(),
    captured_by   uuid REFERENCES users(id),
    device_id     text
);

-- Full event log per trip; drives turnaround analytics (§12.7)
CREATE TABLE vehicle_trip_logs (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    gate_entry_id uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    vehicle_id    uuid REFERENCES vehicles(id),
    event         text NOT NULL
                  CHECK (event IN ('ARRIVED','DOCS_VERIFIED','ANPR_CAPTURED','CHECKLIST_DONE',
                                   'GROSS_WEIGHED','BAY_ASSIGNED','UNLOADING_START',
                                   'UNLOADING_END','QC_START','QC_END','TARE_WEIGHED',
                                   'GRN_POSTED','DETENTION_START','DETENTION_END','GATE_OUT')),
    event_at      timestamptz NOT NULL DEFAULT now(),
    actor_id      uuid REFERENCES users(id),
    meta          jsonb
);

-- Cold-chain temperature trail (§12.5)
CREATE TABLE reefer_temp_logs (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    gate_entry_id uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    recorded_at   timestamptz NOT NULL,
    temp_c        numeric(5,2) NOT NULL,
    humidity_pct  pct,
    source        text NOT NULL CHECK (source IN ('MANUAL','IOT','FILE','PROBE')),
    device_id     text,
    probe_point   text,          -- PULP_TOP, PULP_MID, PULP_BOTTOM, AMBIENT
    is_excursion  boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Derived excursion summary per trip; feeds shelf-life prediction (F6)
CREATE TABLE cold_chain_summaries (
    gate_entry_id      uuid PRIMARY KEY REFERENCES gate_entries(id) ON DELETE CASCADE,
    company_id         uuid NOT NULL REFERENCES companies(id),
    min_temp_c         numeric(5,2),
    max_temp_c         numeric(5,2),
    mean_temp_c        numeric(5,2),
    degree_hours_above numeric(10,3),      -- integral of (temp - threshold) dt
    excursion_count    smallint NOT NULL DEFAULT 0,
    longest_excursion_min integer,
    door_open_events   smallint,
    shelf_life_penalty_days numeric(6,2),
    computed_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  WEIGHMENT (§11) — append-only; a re-weigh is a NEW row, never an update
-- ---------------------------------------------------------------------------
CREATE TABLE weighments (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    branch_id         uuid NOT NULL REFERENCES branches(id),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
    gate_entry_id     uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    weighment_no      text,
    seq               smallint NOT NULL DEFAULT 1,
    kind              text NOT NULL CHECK (kind IN ('GROSS','TARE','REWEIGH','SAMPLE')),
    method            text NOT NULL DEFAULT 'TWO_WEIGHMENT'
                      CHECK (method IN ('TWO_WEIGHMENT','ONE_WEIGHMENT','CRATE_COUNT')),
    gross_kg          weight_kg,
    tare_kg           weight_kg,
    container_type_id uuid REFERENCES container_types(id),
    container_count   integer,
    container_tare_kg weight_kg,
    packing_tare_kg   weight_kg,
    net_kg            weight_kg,
    -- capture provenance & tamper evidence (§12.6)
    capture_mode      text NOT NULL CHECK (capture_mode IN ('SCALE','MANUAL')),
    scale_device_id   uuid REFERENCES scale_devices(id),
    raw_reading       text,
    reading_hash      text,          -- HMAC of the raw device string
    hash_verified     boolean,
    stable_ms         integer,
    photo_key         text,
    -- variance vs PO expectation (§11)
    expected_kg       weight_kg,
    variance_kg       weight_kg,
    variance_pct      pct,
    tolerance_pct     pct,
    tolerance_breached boolean NOT NULL DEFAULT false,
    variance_band     text CHECK (variance_band IN ('GREEN','AMBER','RED','CRITICAL')),
    variance_reason_code text,
    approved_by       uuid REFERENCES users(id),
    approved_at       timestamptz,
    approval_reason   text,
    reweigh_reason    text,
    weighed_by        uuid NOT NULL REFERENCES users(id),
    weighed_at        timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    UNIQUE (gate_entry_id, kind, seq),
    -- A breached tolerance cannot sit unapproved (§11)
    CONSTRAINT ck_weigh_variance_approval CHECK (
        tolerance_breached = false OR approved_by IS NOT NULL OR kind = 'GROSS'),
    CONSTRAINT ck_weigh_reweigh_reason CHECK (kind <> 'REWEIGH' OR reweigh_reason IS NOT NULL),
    CONSTRAINT ck_weigh_manual_reason CHECK (capture_mode <> 'MANUAL' OR raw_reading IS NULL)
);

-- ---------------------------------------------------------------------------
--  QUALITY CHECK (§12) — template engine, not a fixed form
-- ---------------------------------------------------------------------------
CREATE TABLE qc_templates (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code          text NOT NULL,
    name          text NOT NULL,
    name_hi       text,
    product_id    uuid REFERENCES products(id),
    category_id   uuid REFERENCES product_categories(id),
    version       smallint NOT NULL DEFAULT 1,
    is_active     boolean NOT NULL DEFAULT true,
    -- §13.2 sampling
    sampling_rule jsonb NOT NULL DEFAULT
        '{"mode":"SQRT","min_units":5,"bulk_points":3,"composite_kg_per_tonne":1,
          "new_supplier_multiplier":2,"high_rejection_multiplier":2,"skip_lot_enabled":false}',
    scoring_rule  jsonb NOT NULL DEFAULT
        '{"accept_min":85,"downgrade_min":70,"partial_min":50}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    UNIQUE (company_id, code, version)
);

ALTER TABLE products
    ADD CONSTRAINT fk_product_qc_template FOREIGN KEY (qc_template_id) REFERENCES qc_templates(id);
ALTER TABLE product_categories
    ADD CONSTRAINT fk_category_qc_template FOREIGN KEY (default_qc_template_id) REFERENCES qc_templates(id);

CREATE TABLE qc_parameters (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    template_id   uuid NOT NULL REFERENCES qc_templates(id) ON DELETE CASCADE,
    seq           smallint NOT NULL,
    code          text NOT NULL,
    label         text NOT NULL,
    label_hi      text,
    param_type    text NOT NULL
                  CHECK (param_type IN ('NUMERIC','BOOLEAN','SELECT','PERCENT','COUNT','PHOTO','TEXT')),
    unit          text,
    min_ok        numeric(12,4),
    max_ok        numeric(12,4),
    options       jsonb,                  -- for SELECT: [{value,label,score}]
    is_critical   boolean NOT NULL DEFAULT false,   -- §13.4 any fail => reject/hold
    is_mandatory  boolean NOT NULL DEFAULT true,
    weight        numeric(6,3) NOT NULL DEFAULT 1,
    requires_photo boolean NOT NULL DEFAULT false,
    ai_assisted   boolean NOT NULL DEFAULT false,
    ai_feature_key text,                   -- e.g. 'ripeness_stage','defect_area_pct'
    help_text     text,
    UNIQUE (template_id, code)
);

CREATE TABLE qc_inspections (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    branch_id         uuid NOT NULL REFERENCES branches(id),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
    inspection_no     text,
    gate_entry_id     uuid NOT NULL REFERENCES gate_entries(id) ON DELETE CASCADE,
    po_line_id        uuid REFERENCES po_lines(id),
    product_id        uuid NOT NULL REFERENCES products(id),
    template_id       uuid NOT NULL REFERENCES qc_templates(id),
    template_version  smallint NOT NULL,
    inspector_id      uuid NOT NULL REFERENCES users(id),
    inspected_at      timestamptz NOT NULL DEFAULT now(),
    -- sampling actually applied
    lot_size          qty_amt,
    sample_size       qty_amt,
    sampling_note     text,
    -- disposition (§12, §13.4)
    overall_result    text NOT NULL
                      CHECK (overall_result IN ('ACCEPT','PARTIAL','REJECT','HOLD')),
    received_qty      qty_amt NOT NULL,
    accepted_qty      qty_amt NOT NULL DEFAULT 0,
    rejected_qty      qty_amt NOT NULL DEFAULT 0,
    hold_qty          qty_amt NOT NULL DEFAULT 0,
    expected_grade    text,
    assigned_grade    text,
    downgraded_from   text,
    downgrade_rate_request_id uuid,        -- auto-drafted rate revision
    quality_score     numeric(5,2) CHECK (quality_score BETWEEN 0 AND 100),
    critical_failures text[],
    rejection_reason_codes text[],
    -- AI assist (F5) — advisory only
    ai_run_id         uuid,
    ai_score          numeric(5,2),
    ai_grade          text,
    ai_confidence     numeric(5,4),
    ai_overridden     boolean NOT NULL DEFAULT false,
    override_reason   text,
    -- cold chain linkage
    cold_chain_breach boolean NOT NULL DEFAULT false,
    approved_by       uuid REFERENCES users(id),   -- QC Head, for override/re-inspect
    approved_at       timestamptz,
    remarks           text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    CONSTRAINT ck_qc_qty_balance CHECK (
        accepted_qty + rejected_qty + hold_qty <= received_qty + 0.001),
    CONSTRAINT ck_qc_ai_override CHECK (ai_overridden = false OR override_reason IS NOT NULL),
    CONSTRAINT ck_qc_downgrade CHECK (downgraded_from IS NULL OR assigned_grade IS NOT NULL)
);

CREATE TABLE qc_results (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    inspection_id uuid NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
    parameter_id  uuid NOT NULL REFERENCES qc_parameters(id),
    value_num     numeric(12,4),
    value_bool    boolean,
    value_text    text,
    defect_pct    pct,
    is_pass       boolean NOT NULL,
    is_critical_fail boolean NOT NULL DEFAULT false,
    reason_code   text,
    ai_prefilled  boolean NOT NULL DEFAULT false,
    ai_value      numeric(12,4),
    ai_confidence numeric(5,4),
    inspector_changed boolean NOT NULL DEFAULT false,   -- training signal for F5
    UNIQUE (inspection_id, parameter_id)
);

CREATE TABLE qc_photos (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    inspection_id uuid NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
    parameter_id  uuid REFERENCES qc_parameters(id),
    file_key      text NOT NULL,
    ai_annotations jsonb,              -- boxes/masks from RF-DETR
    is_training_candidate boolean NOT NULL DEFAULT true,
    labelled_at   timestamptz,
    captured_at   timestamptz NOT NULL DEFAULT now(),
    captured_by   uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
--  GRN (§13) — the single point where stock enters. Posted exactly once.
-- ---------------------------------------------------------------------------
CREATE TABLE grns (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    branch_id           uuid NOT NULL REFERENCES branches(id),
    warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
    grn_no              text NOT NULL,
    gate_entry_id       uuid NOT NULL REFERENCES gate_entries(id),
    po_id               uuid REFERENCES purchase_orders(id),
    supplier_id         uuid NOT NULL REFERENCES suppliers(id),
    grn_date            date NOT NULL DEFAULT CURRENT_DATE,
    posting_date        date NOT NULL DEFAULT CURRENT_DATE,
    is_backdated        boolean NOT NULL DEFAULT false,
    backdate_approved_by uuid REFERENCES users(id),
    -- totals
    total_received_qty  qty_amt NOT NULL DEFAULT 0,
    total_accepted_qty  qty_amt NOT NULL DEFAULT 0,
    total_rejected_qty  qty_amt NOT NULL DEFAULT 0,
    total_net_weight_kg weight_kg,
    total_value         money_amt,
    -- lifecycle (§27) — controlled amendment/reversal only (§13)
    status              text NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','SUBMITTED','POSTED','AMENDED','REVERSED')),
    submitted_at        timestamptz,
    submitted_by        uuid REFERENCES users(id),
    posted_at           timestamptz,
    posted_by           uuid REFERENCES users(id),
    -- §9.3 the guarantee: one posting per key, enforced by the database
    idempotency_key     text,
    amended_by_grn_id   uuid REFERENCES grns(id),
    reversal_of_grn_id  uuid REFERENCES grns(id),
    amend_reason        text,
    is_partial          boolean NOT NULL DEFAULT false,
    remarks             text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, grn_no),
    CONSTRAINT ck_grn_posted_fields CHECK (
        status <> 'POSTED' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL
                               AND idempotency_key IS NOT NULL)),
    CONSTRAINT ck_grn_amend_reason CHECK (
        status NOT IN ('AMENDED','REVERSED') OR amend_reason IS NOT NULL),
    CONSTRAINT ck_grn_backdate CHECK (
        is_backdated = false OR backdate_approved_by IS NOT NULL)
);

-- THE anti-double-post guarantee (§9.3)
CREATE UNIQUE INDEX uq_grn_idempotency ON grns (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
-- One posted GRN per gate entry per PO — a second receipt needs a new gate entry
CREATE UNIQUE INDEX uq_grn_gate_posted ON grns (gate_entry_id)
    WHERE status = 'POSTED';

CREATE TABLE grn_lines (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    grn_id              uuid NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
    line_no             smallint NOT NULL,
    po_line_id          uuid REFERENCES po_lines(id),
    qc_inspection_id    uuid REFERENCES qc_inspections(id),
    product_id          uuid NOT NULL REFERENCES products(id),
    uom                 text NOT NULL REFERENCES uoms(code),
    received_qty        qty_amt NOT NULL,
    accepted_qty        qty_amt NOT NULL DEFAULT 0,
    rejected_qty        qty_amt NOT NULL DEFAULT 0,
    hold_qty            qty_amt NOT NULL DEFAULT 0,
    net_weight_kg       weight_kg,
    container_type_id   uuid REFERENCES container_types(id),
    container_count     integer,
    rate                rate_amt NOT NULL,
    grade               text,
    line_value          money_amt,
    batch_id            uuid,                   -- FK added after batches
    rejection_reason_code text,
    rejection_action    text CHECK (rejection_action IN ('RETURN','DESTROY','SUPPLIER_COLLECT','HOLD')),
    remarks             text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (grn_id, line_no),
    CONSTRAINT ck_grnline_balance CHECK (
        accepted_qty + rejected_qty + hold_qty <= received_qty + 0.001),
    CONSTRAINT ck_grnline_reject_reason CHECK (
        rejected_qty = 0 OR rejection_reason_code IS NOT NULL)
);

-- ---------------------------------------------------------------------------
--  BATCH / LOT & LABELS (§14) — traceability, variable-weight crates
-- ---------------------------------------------------------------------------
CREATE TABLE batches (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    branch_id         uuid NOT NULL REFERENCES branches(id),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
    batch_no          text NOT NULL,
    product_id        uuid NOT NULL REFERENCES products(id),
    grn_line_id       uuid REFERENCES grn_lines(id),
    supplier_id       uuid REFERENCES suppliers(id),
    farm_id           uuid REFERENCES farms(id),        -- one-up traceability
    received_date     date NOT NULL,
    harvest_date      date,
    mfg_date          date,
    expiry_date       date,
    shelf_life_days   smallint,
    predicted_expiry_date date,                          -- from F6, may differ
    shelf_life_model_version text,
    grade             text,
    initial_qty       qty_amt NOT NULL,
    remaining_qty     qty_amt NOT NULL,
    net_weight_kg     weight_kg,
    remaining_weight_kg weight_kg,
    landed_rate       rate_amt,
    landed_rate_per_kg rate_amt,
    status            text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','QUARANTINE','CONSUMED','EXPIRED','WRITTEN_OFF','RETURNED')),
    quarantine_reason text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, batch_no),
    CHECK (remaining_qty >= 0 AND remaining_qty <= initial_qty + 0.001)
);

ALTER TABLE grn_lines
    ADD CONSTRAINT fk_grnline_batch FOREIGN KEY (batch_id) REFERENCES batches(id);

CREATE TABLE labels (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    batch_id        uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    label_type      text NOT NULL CHECK (label_type IN ('LOT','CRATE','BOX','PALLET')),
    code            text NOT NULL,               -- printed barcode/QR value
    qr_payload      jsonb NOT NULL,              -- sku, batch, date, qty, grade, source
    container_id    uuid REFERENCES containers(id),
    actual_weight_kg weight_kg,                  -- §14 variable-weight crate
    printed_at      timestamptz,
    printed_by      uuid REFERENCES users(id),
    printer_device  text,
    reprint_count   smallint NOT NULL DEFAULT 0,
    voided_at       timestamptz,
    void_reason     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    UNIQUE (company_id, code)
);

-- ---------------------------------------------------------------------------
--  PUT-AWAY (§15)
-- ---------------------------------------------------------------------------
CREATE TABLE putaway_tasks (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
    task_no           text,
    grn_line_id       uuid NOT NULL REFERENCES grn_lines(id) ON DELETE CASCADE,
    batch_id          uuid NOT NULL REFERENCES batches(id),
    product_id        uuid NOT NULL REFERENCES products(id),
    qty               qty_amt NOT NULL,
    weight_kg         weight_kg,
    rotation_rule     text NOT NULL DEFAULT 'FEFO' CHECK (rotation_rule IN ('FEFO','FIFO','LIFO')),
    suggested_zone_id uuid REFERENCES zones(id),
    suggested_rack_id uuid REFERENCES racks(id),
    suggested_bin_id  uuid REFERENCES bins(id),
    actual_bin_id     uuid REFERENCES bins(id),
    mismatch_reason   text,                       -- §15 wrong rack/zone alert
    status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','IN_PROGRESS','DONE','EXCEPTION','CANCELLED')),
    scanned_by        uuid REFERENCES users(id),
    started_at        timestamptz,
    done_at           timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    CONSTRAINT ck_putaway_mismatch CHECK (
        actual_bin_id IS NULL OR suggested_bin_id IS NULL
        OR actual_bin_id = suggested_bin_id OR mismatch_reason IS NOT NULL)
);

-- ============================================================================
--  SECTION 06 — INVENTORY LEDGER
--  Owned by the Inventory module; Purchase WRITES here at GRN posting only.
--  Append-only. Balances are derived. Never UPDATE a ledger row.
-- ============================================================================

CREATE TABLE stock_ledger (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
    product_id    uuid NOT NULL REFERENCES products(id),
    batch_id      uuid REFERENCES batches(id),
    bin_id        uuid REFERENCES bins(id),
    direction     text NOT NULL CHECK (direction IN ('IN','OUT')),
    qty           qty_amt NOT NULL CHECK (qty > 0),
    weight_kg     weight_kg,
    uom           text NOT NULL REFERENCES uoms(code),
    rate          rate_amt,
    value         money_null,
    txn_type      text NOT NULL
                  CHECK (txn_type IN ('GRN','GRN_REVERSAL','SALE','TRANSFER_IN','TRANSFER_OUT',
                                      'ADJUSTMENT','WASTAGE','RETURN','CONSUMPTION')),
    ref_type      text NOT NULL,
    ref_id        uuid NOT NULL,
    ref_line_id   uuid,
    posted_at     timestamptz NOT NULL DEFAULT now(),
    posted_by     uuid REFERENCES users(id),
    -- The hard guarantee: one ledger row per GRN line, ever (§9.3)
    CONSTRAINT uq_ledger_grn_line UNIQUE (ref_type, ref_line_id, txn_type)
);

CREATE TABLE stock_balances (
    company_id   uuid NOT NULL REFERENCES companies(id),
    warehouse_id uuid NOT NULL REFERENCES warehouses(id),
    product_id   uuid NOT NULL REFERENCES products(id),
    batch_id     uuid NOT NULL REFERENCES batches(id),
    qty          qty_amt NOT NULL DEFAULT 0,
    weight_kg    weight_kg NOT NULL DEFAULT 0,
    reserved_qty qty_amt NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, batch_id, warehouse_id),
    CHECK (qty >= 0)
);

-- ============================================================================
--  SECTION 07 — LANDING COST, INVOICE MATCH, PAYMENT, SUPPLIER SCORE
--  Spec §16 §17 §18
-- ============================================================================

CREATE TABLE landing_costs (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id            uuid NOT NULL REFERENCES companies(id),
    branch_id             uuid NOT NULL REFERENCES branches(id),
    grn_id                uuid NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
    cost_status           text NOT NULL CHECK (cost_status IN ('ESTIMATED','ACTUAL')),
    base_amount           money_amt,
    discount_amount       money_amt,
    total_charges         money_amt,
    non_creditable_tax    money_amt,
    wastage_provision     money_amt,
    total_landed          money_amt,
    -- comparison (§16)
    estimated_total       money_null,
    variance_vs_estimate  money_null,
    variance_vs_estimate_pct pct,
    is_abnormal           boolean NOT NULL DEFAULT false,
    margin_risk_flag      boolean NOT NULL DEFAULT false,
    -- full reproducibility: inputs + rule versions used
    snapshot              jsonb NOT NULL,
    rule_version          text,
    computed_at           timestamptz NOT NULL DEFAULT now(),
    computed_by           uuid REFERENCES users(id),
    UNIQUE (grn_id, cost_status)
);

CREATE TABLE landing_cost_lines (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id),
    landing_cost_id    uuid NOT NULL REFERENCES landing_costs(id) ON DELETE CASCADE,
    grn_line_id        uuid NOT NULL REFERENCES grn_lines(id),
    product_id         uuid NOT NULL REFERENCES products(id),
    batch_id           uuid REFERENCES batches(id),
    accepted_qty       qty_amt NOT NULL,
    accepted_weight_kg weight_kg,
    base_rate          rate_amt NOT NULL,
    base_value         money_amt,
    allocated_charges  jsonb NOT NULL DEFAULT '{}',   -- {charge_code: amount}
    allocated_total    money_amt,
    non_creditable_tax money_amt,
    wastage_pct        pct NOT NULL DEFAULT 0,
    wastage_amount     money_amt,
    landed_value       money_amt,
    landed_rate_per_uom rate_amt,
    landed_rate_per_kg  rate_amt,
    prev_landed_rate   rate_amt,
    rate_change_pct    pct,
    UNIQUE (landing_cost_id, grn_line_id)
);

-- Charges attached at any stage; the union feeds the allocation engine (§16)
CREATE TABLE purchase_charges (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    doc_type        text NOT NULL CHECK (doc_type IN ('PO','GRN','INVOICE','MANUAL')),
    doc_id          uuid NOT NULL,
    charge_type_id  uuid NOT NULL REFERENCES charge_types(id),
    amount          money_amt NOT NULL,
    allocation_basis text NOT NULL
                    CHECK (allocation_basis IN ('VALUE','WEIGHT','QTY','EQUAL','MANUAL')),
    is_creditable   boolean NOT NULL DEFAULT false,
    affects_landing_cost boolean NOT NULL DEFAULT true,
    supplier_id     uuid REFERENCES suppliers(id),     -- who is paid this charge
    reference_no    text,
    source          text NOT NULL DEFAULT 'MANUAL'
                    CHECK (source IN ('PO','GRN','INVOICE','MANUAL','OCR','AUTO')),
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid
);
CREATE INDEX ix_purchase_charges_doc ON purchase_charges (doc_type, doc_id);

-- ---------------------------------------------------------------------------
--  Supplier invoice & 3-way match (§17)
-- ---------------------------------------------------------------------------
CREATE TABLE supplier_invoices (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id),
    branch_id          uuid NOT NULL REFERENCES branches(id),
    supplier_id        uuid NOT NULL REFERENCES suppliers(id),
    invoice_no         text NOT NULL,
    invoice_date       date NOT NULL,
    received_at        timestamptz NOT NULL DEFAULT now(),
    due_date           date,
    po_id              uuid REFERENCES purchase_orders(id),
    currency           char(3) NOT NULL DEFAULT 'INR',
    subtotal           money_amt,
    discount           money_amt,
    charges            money_amt,
    tax_amount         money_amt,
    total              money_amt NOT NULL,
    -- GST / statutory
    supplier_gstin     gstin_t,
    place_of_supply    char(2),
    irn                text,                  -- e-invoice reference number
    eway_bill_no       text,
    is_rcm             boolean NOT NULL DEFAULT false,
    -- capture & OCR (F3)
    file_key           text,
    file_checksum      text,
    ocr_json           jsonb,
    ocr_confidence     numeric(5,4),
    ocr_model          text,
    ocr_arithmetic_ok  boolean,               -- §14.5 the cross-check that matters
    -- lifecycle (§27)
    status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','MATCHED','MISMATCH','HOLD','APPROVED',
                                         'PAYABLE','PART_PAID','PAID','CANCELLED')),
    hold_reason        text,
    approved_by        uuid REFERENCES users(id),
    approved_at        timestamptz,
    -- duplicate detection (§17)
    duplicate_of_id    uuid REFERENCES supplier_invoices(id),
    duplicate_score    numeric(5,4),
    duplicate_cleared_by uuid REFERENCES users(id),
    duplicate_cleared_reason text,
    remarks            text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid,
    version            integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, supplier_id, invoice_no)
);
CREATE UNIQUE INDEX uq_invoice_irn ON supplier_invoices (company_id, irn) WHERE irn IS NOT NULL;
CREATE INDEX ix_invoice_dupe_probe ON supplier_invoices (company_id, supplier_id, invoice_date, total);

CREATE TABLE invoice_lines (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id         uuid NOT NULL REFERENCES companies(id),
    invoice_id         uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    line_no            smallint NOT NULL,
    raw_description    text,                -- as printed, before matching
    product_id         uuid REFERENCES products(id),
    matched_grn_line_id uuid REFERENCES grn_lines(id),
    matched_po_line_id uuid REFERENCES po_lines(id),
    match_confidence   numeric(5,4),
    qty                qty_amt NOT NULL,
    uom                text REFERENCES uoms(code),
    rate               rate_amt NOT NULL,
    discount           money_amt,
    tax_rate           pct,
    tax_amount         money_amt,
    amount             money_amt NOT NULL,
    hsn_code           hsn_t,
    UNIQUE (invoice_id, line_no)
);

CREATE TABLE tolerance_profiles (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code              text NOT NULL,
    name              text NOT NULL,
    qty_tol_pct       pct NOT NULL DEFAULT 0.5,
    rate_tol_pct      pct NOT NULL DEFAULT 1.0,
    tax_tol_abs       money_amt NOT NULL DEFAULT 1,
    charge_tol_pct    pct NOT NULL DEFAULT 2.0,
    critical_qty_pct  pct NOT NULL DEFAULT 5.0,
    critical_rate_pct pct NOT NULL DEFAULT 10.0,
    applies_to_category_id uuid REFERENCES product_categories(id),
    applies_to_source_type text,
    is_default        boolean NOT NULL DEFAULT false,
    UNIQUE (company_id, code)
);

CREATE TABLE match_results (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    invoice_id          uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    run_at              timestamptz NOT NULL DEFAULT now(),
    run_by              uuid REFERENCES users(id),
    tolerance_profile_id uuid REFERENCES tolerance_profiles(id),
    overall             text NOT NULL CHECK (overall IN ('MATCH','MISMATCH','CRITICAL_MISMATCH')),
    qty_result          text CHECK (qty_result IN ('OK','WARN','FAIL')),
    rate_result         text CHECK (rate_result IN ('OK','WARN','FAIL')),
    tax_result          text CHECK (tax_result IN ('OK','WARN','FAIL')),
    charge_result       text CHECK (charge_result IN ('OK','WARN','FAIL')),
    qty_variance        qty_amt,
    rate_variance_pct   pct,
    tax_variance        money_null,
    charge_variance     money_null,
    findings            jsonb NOT NULL DEFAULT '[]',
    resolved_by         uuid REFERENCES users(id),
    resolved_at         timestamptz,
    resolution_note     text,
    is_latest           boolean NOT NULL DEFAULT true
);
CREATE INDEX ix_match_latest ON match_results (invoice_id) WHERE is_latest;

CREATE TABLE credit_debit_notes (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    note_no        text NOT NULL,
    note_type      text NOT NULL CHECK (note_type IN ('CREDIT','DEBIT')),
    supplier_id    uuid NOT NULL REFERENCES suppliers(id),
    invoice_id     uuid REFERENCES supplier_invoices(id),
    grn_id         uuid REFERENCES grns(id),
    reason_code    text NOT NULL
                   CHECK (reason_code IN ('QC_REJECTION','SHORT_SUPPLY','RATE_DIFFERENCE',
                                          'WEIGHT_SHORTAGE','DAMAGE','TAX_CORRECTION','OTHER')),
    amount         money_amt NOT NULL,
    tax_amount     money_amt,
    total          money_amt NOT NULL,
    status         text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','SETTLED','CANCELLED')),
    auto_drafted   boolean NOT NULL DEFAULT false,   -- from QC rejection / shortage
    remarks        text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, note_no)
);

-- §18: Purchase READS payment state from Finance. It never writes payments.
CREATE TABLE payment_status (
    invoice_id      uuid PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id),
    supplier_id     uuid NOT NULL REFERENCES suppliers(id),
    payable_amount  money_amt NOT NULL DEFAULT 0,
    paid_amount     money_amt NOT NULL DEFAULT 0,
    balance         money_amt NOT NULL DEFAULT 0,
    due_date        date,
    is_blocked      boolean NOT NULL DEFAULT false,
    blocked_reason  text,
    last_payment_at timestamptz,
    external_ref    text,                 -- Tally / Finance voucher reference
    last_synced_at  timestamptz NOT NULL DEFAULT now(),
    sync_source     text
);

-- ---------------------------------------------------------------------------
--  Supplier scoring (§7, §24)
-- ---------------------------------------------------------------------------
CREATE TABLE supplier_scores (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    supplier_id         uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id          uuid REFERENCES products(id),   -- null = overall
    period_start        date NOT NULL,
    period_end          date NOT NULL,
    order_count         integer NOT NULL DEFAULT 0,
    on_time_pct         pct,
    fill_rate_pct       pct,
    rejection_pct       pct,
    weight_variance_pct pct,
    rate_competitiveness pct,        -- vs market/other suppliers
    doc_compliance_pct  pct,
    avg_response_hours  numeric(8,2),
    quality_score_avg   numeric(5,2),
    landed_cost_index   numeric(8,4),
    trust_score         numeric(5,2),
    performance_score   numeric(5,2),
    breakdown           jsonb,
    computed_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (supplier_id, product_id, period_start, period_end)
);

-- Repeat-defect tracking (§12) -> auto ON_HOLD proposal
CREATE TABLE supplier_defect_trends (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id     uuid REFERENCES products(id),
    defect_code    text NOT NULL,
    occurrences_90d integer NOT NULL DEFAULT 0,
    consecutive_lots integer NOT NULL DEFAULT 0,
    last_seen_at   timestamptz,
    alert_raised   boolean NOT NULL DEFAULT false,
    UNIQUE (supplier_id, product_id, defect_code)
);

-- ============================================================================
--  SECTION 08 — PLATFORM: audit, outbox, idempotency, alerts, AI, settings
--  Spec §19 §23 §25
-- ============================================================================

-- ---------------------------------------------------------------------------
--  AUDIT (§23) — append-only, partitioned monthly.
--  The app role gets INSERT + SELECT only (see SECTION 09).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id                 uuid NOT NULL DEFAULT uuid_generate_v7(),
    company_id         uuid,
    actor_id           uuid,
    actor_role         text,
    branch_id          uuid,
    session_id         uuid,
    ip                 inet,
    device_fingerprint text,
    entity_type        text NOT NULL,
    entity_id          uuid,
    action             text NOT NULL,
    before             jsonb,
    after              jsonb,
    diff               jsonb,
    reason_code        text,
    reason_text        text,
    request_id         text,
    occurred_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Create the current and next few partitions; a scheduled job rolls these forward.
CREATE TABLE audit_log_2026m08 PARTITION OF audit_log
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_log_2026m09 PARTITION OF audit_log
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_log_2026m10 PARTITION OF audit_log
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- Helper the scheduler calls monthly
CREATE OR REPLACE FUNCTION ensure_audit_partition(p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_start date := date_trunc('month', p_month)::date;
    v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
    v_name  text := 'audit_log_' || to_char(v_start, 'YYYY"m"MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            v_name, v_start, v_end);
        EXECUTE format('CREATE INDEX ON %I (entity_type, entity_id, occurred_at DESC)', v_name);
        EXECUTE format('CREATE INDEX ON %I (actor_id, occurred_at DESC)', v_name);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
--  TRANSACTIONAL OUTBOX (§9.3) — events written in the same tx as the change
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
    id             bigserial PRIMARY KEY,
    company_id     uuid,
    aggregate_type text NOT NULL,
    aggregate_id   uuid NOT NULL,
    event_type     text NOT NULL,       -- grn.posted, landing_cost.updated, qc.rejected
    payload        jsonb NOT NULL,
    trace_id       text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz,
    attempts       smallint NOT NULL DEFAULT 0,
    last_error     text
);
CREATE INDEX ix_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
--  IDEMPOTENCY (§9.2) — safe retries from flaky 4G and offline replay
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    key           text PRIMARY KEY,
    company_id    uuid,
    user_id       uuid,
    endpoint      text NOT NULL,
    request_hash  text NOT NULL,
    response_body jsonb,
    status_code   smallint,
    state         text NOT NULL DEFAULT 'IN_PROGRESS'
                  CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    expires_at    timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX ix_idem_expiry ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
--  WORK QUEUE (§5.3) — the single read-model behind every panel home screen
-- ---------------------------------------------------------------------------
CREATE TABLE work_queue (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    branch_id           uuid NOT NULL REFERENCES branches(id),
    warehouse_id        uuid REFERENCES warehouses(id),
    queue_key           text NOT NULL
                        CHECK (queue_key IN ('REQUIREMENT_REVIEW','AI_SUGGESTION','APPROVAL',
                                             'EXPECTED_ARRIVAL','WEIGH_PENDING','QC_PENDING',
                                             'GRN_PENDING','PUTAWAY_PENDING','INVOICE_MATCH',
                                             'FINANCE_EXCEPTION','ALERT')),
    doc_type            text NOT NULL,
    doc_id              uuid NOT NULL,
    doc_no              text,
    title               text NOT NULL,
    subtitle            text,
    severity            text NOT NULL DEFAULT 'normal'
                        CHECK (severity IN ('normal','warn','critical')),
    required_permission text NOT NULL REFERENCES permissions(code),
    assigned_role_id    uuid REFERENCES roles(id),
    assigned_user_id    uuid REFERENCES users(id),
    sla_due_at          timestamptz,
    payload             jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES users(id),
    UNIQUE (queue_key, doc_type, doc_id)
);
CREATE INDEX ix_workqueue_open ON work_queue (company_id, branch_id, queue_key, severity, sla_due_at)
    WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
--  ALERTS & NOTIFICATIONS (§19)
-- ---------------------------------------------------------------------------
CREATE TABLE alert_rules (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    alert_type        text NOT NULL,
    is_enabled        boolean NOT NULL DEFAULT true,
    severity          text NOT NULL DEFAULT 'MEDIUM'
                      CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    threshold         jsonb,
    target_role_ids   uuid[],
    channels          text[] NOT NULL DEFAULT ARRAY['IN_APP'],
    sla_minutes       integer,
    escalate_after_minutes integer,
    escalate_to_role_id uuid REFERENCES roles(id),
    digest_window_minutes integer,        -- anti-fatigue: batch non-critical alerts
    dedupe_window_minutes integer NOT NULL DEFAULT 60,
    UNIQUE (company_id, alert_type)
);

CREATE TABLE alerts (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid REFERENCES branches(id),
    alert_type    text NOT NULL,
    severity      text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    entity_type   text,
    entity_id     uuid,
    title         text NOT NULL,
    message       text NOT NULL,
    message_hi    text,
    dedupe_hash   text,
    status        text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','ACK','RESOLVED','SUPPRESSED','SNOOZED')),
    acked_by      uuid REFERENCES users(id),
    acked_at      timestamptz,
    resolved_by   uuid REFERENCES users(id),
    resolved_at   timestamptz,
    snoozed_until timestamptz,
    snooze_reason text,
    meta          jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_alerts_open ON alerts (company_id, branch_id, severity, created_at DESC)
    WHERE status = 'OPEN';
CREATE UNIQUE INDEX uq_alerts_dedupe ON alerts (company_id, dedupe_hash)
    WHERE status = 'OPEN' AND dedupe_hash IS NOT NULL;

CREATE TABLE notifications (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id  uuid NOT NULL REFERENCES companies(id),
    user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
    role_id     uuid REFERENCES roles(id),
    branch_id   uuid REFERENCES branches(id),
    alert_id    uuid REFERENCES alerts(id) ON DELETE CASCADE,
    channel     text NOT NULL CHECK (channel IN ('IN_APP','PUSH','SMS','WHATSAPP','EMAIL')),
    template    text NOT NULL,
    payload     jsonb,
    locale      text NOT NULL DEFAULT 'en',
    send_status text NOT NULL DEFAULT 'QUEUED'
                CHECK (send_status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','SUPPRESSED')),
    provider_ref text,
    error        text,
    queued_at   timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz,
    read_at     timestamptz,
    acted_at    timestamptz
);
CREATE INDEX ix_notif_user_unread ON notifications (user_id, queued_at DESC) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
--  ATTACHMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id   uuid NOT NULL REFERENCES companies(id),
    entity_type  text NOT NULL,
    entity_id    uuid NOT NULL,
    file_key     text NOT NULL,
    file_name    text NOT NULL,
    mime         text NOT NULL,
    size_bytes   bigint NOT NULL,
    checksum     text NOT NULL,
    scan_status  text NOT NULL DEFAULT 'PENDING'
                 CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','ERROR')),
    uploaded_by  uuid REFERENCES users(id),
    uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_attach_entity ON attachments (entity_type, entity_id);

-- ---------------------------------------------------------------------------
--  AI GOVERNANCE (§14.1, §14.6)
--  Every prediction is logged. This is the audit trail, the drift monitor,
--  and the training set, all at once.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_models (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid REFERENCES companies(id),
    feature_key    text NOT NULL,      -- BUY_QTY, SUPPLIER_RANK, OCR_INVOICE, QC_VISION…
    model_name     text NOT NULL,
    model_version  text NOT NULL,
    license        text NOT NULL,      -- Apache-2.0, MIT, custom — reviewed before deploy
    trained_at     timestamptz,
    dataset_hash   text,
    eval_metrics   jsonb,
    approved_by    uuid REFERENCES users(id),
    approved_at    timestamptz,
    is_active      boolean NOT NULL DEFAULT false,
    rollback_to    uuid REFERENCES ai_models(id),
    endpoint       text,
    UNIQUE (feature_key, model_name, model_version)
);

CREATE TABLE ai_feature_flags (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    feature_key   text NOT NULL,
    is_enabled    boolean NOT NULL DEFAULT false,   -- §14.6 the kill switch
    fallback_mode text NOT NULL DEFAULT 'RULE'
                  CHECK (fallback_mode IN ('RULE','STATISTICAL','OFF')),
    min_confidence numeric(5,4) NOT NULL DEFAULT 0.70,
    auto_apply_below_value money_null,   -- auto-buy limit; NULL = never auto-apply
    updated_by    uuid REFERENCES users(id),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, feature_key)
);

CREATE TABLE ai_runs (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    branch_id       uuid REFERENCES branches(id),
    feature_key     text NOT NULL,
    model_id        uuid REFERENCES ai_models(id),
    model_name      text NOT NULL,
    model_version   text NOT NULL,
    entity_type     text,
    entity_id       uuid,
    input_hash      text NOT NULL,
    input_ref       jsonb,
    output          jsonb NOT NULL,
    reason          jsonb,             -- human-readable drivers shown in the UI
    confidence      numeric(5,4),
    latency_ms      integer,
    cost_tokens     integer,
    used_fallback   boolean NOT NULL DEFAULT false,
    fallback_reason text,
    -- the feedback loop
    accepted        boolean,
    accepted_by     uuid REFERENCES users(id),
    accepted_at     timestamptz,
    override_value  jsonb,
    feedback_note   text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ai_runs_feature ON ai_runs (company_id, feature_key, created_at DESC);
CREATE INDEX ix_ai_runs_acceptance ON ai_runs (feature_key, accepted, created_at DESC);

-- late FKs now that ai_runs exists
ALTER TABLE requirement_lines ADD CONSTRAINT fk_reqline_ai_run FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id);
ALTER TABLE supplier_quotes   ADD CONSTRAINT fk_quote_ai_run   FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id);
ALTER TABLE qc_inspections    ADD CONSTRAINT fk_qc_ai_run      FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id);

-- Forecast output store (F1) — one row per product/branch/date/horizon
CREATE TABLE demand_forecasts (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    product_id    uuid NOT NULL REFERENCES products(id),
    forecast_date date NOT NULL,          -- the day being predicted
    run_date      date NOT NULL,          -- when the prediction was made
    horizon_days  smallint NOT NULL,
    p50_qty       qty_amt NOT NULL,
    p90_qty       qty_amt,
    p10_qty       qty_amt,
    model_name    text NOT NULL,
    model_version text,
    features      jsonb,
    actual_qty    qty_amt,                -- backfilled; drives MAPE monitoring
    abs_pct_error pct,
    UNIQUE (branch_id, product_id, forecast_date, run_date, model_name)
);

-- Market price signal (F8) — Agmarknet ingestion
CREATE TABLE market_prices (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid REFERENCES companies(id),
    product_id    uuid REFERENCES products(id),
    commodity_name text NOT NULL,
    mandi_id      uuid REFERENCES mandis(id),
    market_name   text,
    price_date    date NOT NULL,
    min_price     rate_amt,
    max_price     rate_amt,
    modal_price   rate_amt,
    arrival_qty   qty_amt,
    uom           text,
    source        text NOT NULL DEFAULT 'AGMARKNET'
                  CHECK (source IN ('AGMARKNET','MANUAL','SUPPLIER','INTERNAL')),
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (commodity_name, market_name, price_date, source)
);

CREATE TABLE market_signals (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    product_id          uuid NOT NULL REFERENCES products(id),
    signal_date         date NOT NULL,
    trend_7d_pct        pct,
    trend_30d_pct       pct,
    direction           text CHECK (direction IN ('RISING','FALLING','STABLE','VOLATILE')),
    volatility          numeric(8,4),
    demand_score        numeric(5,2),
    supply_score        numeric(5,2),
    buy_score           numeric(5,2),
    risk_score          numeric(5,2),
    market_balance_index numeric(6,3),
    market_health_score numeric(5,2),
    weather_impact      jsonb,
    data_freshness_at   timestamptz,     -- staleness must be visible to staff
    computed_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, product_id, signal_date)
);

-- ---------------------------------------------------------------------------
--  SETTINGS, INTEGRATIONS, OFFLINE SYNC
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id  uuid REFERENCES branches(id),
    scope      text NOT NULL DEFAULT 'COMPANY' CHECK (scope IN ('COMPANY','BRANCH')),
    key        text NOT NULL,
    value      jsonb NOT NULL,
    data_type  text,
    updated_by uuid REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (company_id, branch_id, key)
);

CREATE TABLE integration_log (
    id             bigserial PRIMARY KEY,
    company_id     uuid,
    integration    text NOT NULL,       -- GSP_EWAY, TALLY, WHATSAPP, AGMARKNET, AI_SERVICE
    direction      text NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
    endpoint       text,
    request_summary jsonb,
    response_summary jsonb,
    status_code    smallint,
    success        boolean NOT NULL,
    latency_ms     integer,
    error          text,
    retry_count    smallint NOT NULL DEFAULT 0,
    correlation_id text,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_integration_log_recent ON integration_log (integration, occurred_at DESC);

-- Server-side visibility into device offline queues (§15)
CREATE TABLE sync_state (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    user_id        uuid NOT NULL REFERENCES users(id),
    device_id      text NOT NULL,
    panel          text,
    queued_count   integer NOT NULL DEFAULT 0,
    conflict_count integer NOT NULL DEFAULT 0,
    last_sync_at   timestamptz,
    last_error     text,
    app_version    text,
    UNIQUE (user_id, device_id)
);

-- Site-agent registry (weighbridge bridge / ANPR / printers)
CREATE TABLE site_agents (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
    agent_code     text NOT NULL,
    hostname       text,
    agent_version  text,
    capabilities   text[] NOT NULL DEFAULT '{}',   -- SCALE, ANPR, LABEL, TEMP
    api_key_hash   text NOT NULL,
    last_heartbeat_at timestamptz,
    buffered_events integer NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','DEGRADED','OFFLINE','DISABLED')),
    UNIQUE (company_id, agent_code)
);

-- ============================================================================
--  SECTION 09 — INDEXES, TRIGGERS, ROW-LEVEL SECURITY, VIEWS
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Hot-path indexes. Get these in from day one; retrofitting onto a 10M-row
--  ledger during a festival week is not an experience worth having.
-- ---------------------------------------------------------------------------
CREATE INDEX ix_po_worklist        ON purchase_orders (company_id, branch_id, status, expected_date);
CREATE INDEX ix_po_supplier        ON purchase_orders (supplier_id, order_date DESC);
CREATE INDEX ix_po_lines_product   ON po_lines (product_id, line_status);
CREATE INDEX ix_req_worklist       ON requirements (company_id, branch_id, status, required_date);
CREATE INDEX ix_reqline_product    ON requirement_lines (product_id, line_status);
CREATE INDEX ix_quotes_rfq         ON supplier_quotes (rfq_id, rank);
CREATE INDEX ix_quotes_supplier    ON supplier_quotes (supplier_id, product_id, created_at DESC);

CREATE INDEX ix_gate_worklist      ON gate_entries (company_id, warehouse_id, status, arrived_at DESC);
CREATE INDEX ix_gate_vehicle       ON gate_entries (vehicle_id, arrived_at DESC);
CREATE INDEX ix_gate_supplier      ON gate_entries (supplier_id, arrived_at DESC);
CREATE INDEX ix_gate_po            ON gate_entries (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX ix_gate_open          ON gate_entries (warehouse_id, status)
    WHERE status NOT IN ('COMPLETED','REJECTED_AT_GATE','CANCELLED');

CREATE INDEX ix_weigh_gate         ON weighments (gate_entry_id, kind, seq);
CREATE INDEX ix_weigh_variance     ON weighments (company_id, weighed_at DESC)
    WHERE tolerance_breached = true;
CREATE INDEX ix_weigh_manual       ON weighments (weighed_by, weighed_at DESC)
    WHERE capture_mode = 'MANUAL';   -- operator manual-entry rate = fraud signal

CREATE INDEX ix_qc_gate            ON qc_inspections (gate_entry_id);
CREATE INDEX ix_qc_supplier_trend  ON qc_inspections (product_id, inspected_at DESC);
CREATE INDEX ix_qc_rejections      ON qc_inspections (company_id, inspected_at DESC)
    WHERE overall_result IN ('REJECT','PARTIAL');
CREATE INDEX ix_qc_results_param   ON qc_results (parameter_id, is_pass);

CREATE INDEX ix_grn_worklist       ON grns (company_id, warehouse_id, status, grn_date DESC);
CREATE INDEX ix_grn_po             ON grns (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX ix_grn_supplier       ON grns (supplier_id, posting_date DESC);
CREATE INDEX ix_grnlines_product   ON grn_lines (product_id, batch_id);
CREATE INDEX ix_grnlines_poline    ON grn_lines (po_line_id);

CREATE INDEX ix_batches_fefo       ON batches (product_id, warehouse_id, status, expiry_date)
    WHERE status = 'ACTIVE';
CREATE INDEX ix_batches_supplier   ON batches (supplier_id, received_date DESC);
CREATE INDEX ix_labels_batch       ON labels (batch_id);
CREATE INDEX ix_putaway_open       ON putaway_tasks (warehouse_id, status) WHERE status <> 'DONE';

CREATE INDEX ix_ledger_product     ON stock_ledger (product_id, warehouse_id, posted_at DESC);
CREATE INDEX ix_ledger_ref         ON stock_ledger (ref_type, ref_id);
CREATE INDEX ix_ledger_batch       ON stock_ledger (batch_id);

CREATE INDEX ix_landing_grn        ON landing_costs (grn_id, cost_status);
CREATE INDEX ix_landing_abnormal   ON landing_costs (company_id, computed_at DESC)
    WHERE is_abnormal = true;
CREATE INDEX ix_lcl_product        ON landing_cost_lines (product_id);

CREATE INDEX ix_invoice_worklist   ON supplier_invoices (company_id, branch_id, status, invoice_date DESC);
CREATE INDEX ix_invoice_supplier   ON supplier_invoices (supplier_id, invoice_date DESC);
CREATE INDEX ix_paystatus_overdue  ON payment_status (company_id, supplier_id)
    WHERE balance > 0;
CREATE INDEX ix_scores_supplier    ON supplier_scores (supplier_id, period_end DESC);

CREATE INDEX ix_forecast_lookup    ON demand_forecasts (branch_id, product_id, forecast_date);
CREATE INDEX ix_market_prices_prod ON market_prices (product_id, price_date DESC);

-- Fuzzy search for supplier/product pickers and OCR matching
CREATE INDEX ix_products_trgm      ON products  USING gin (name gin_trgm_ops);
CREATE INDEX ix_products_hi_trgm   ON products  USING gin (name_hi gin_trgm_ops);
CREATE INDEX ix_suppliers_trgm     ON suppliers USING gin (trade_name gin_trgm_ops);
CREATE INDEX ix_supplier_legal_trgm ON suppliers USING gin (legal_name gin_trgm_ops);
CREATE INDEX ix_aliases_trgm       ON product_aliases USING gin (alias gin_trgm_ops);

-- JSONB containment queries on snapshots and payloads
CREATE INDEX ix_landing_snapshot   ON landing_costs USING gin (snapshot jsonb_path_ops);
CREATE INDEX ix_workqueue_payload  ON work_queue    USING gin (payload jsonb_path_ops);

-- ---------------------------------------------------------------------------
--  updated_at / version triggers on every business table
-- ---------------------------------------------------------------------------
-- Two variants: tables that carry an optimistic-lock `version` column get the
-- stale-write check; tables that only carry `updated_at` just get touched.
-- Attaching the version trigger to a table without the column raises
-- "record NEW has no field version" on the first UPDATE, so the split matters.
CREATE OR REPLACE FUNCTION trg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DO $$
DECLARE t text; has_version boolean;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at'
                             AND a.attnum > 0 AND NOT a.attisdropped
         WHERE c.relkind = 'r' AND n.nspname = current_schema()
    LOOP
        SELECT EXISTS (
            SELECT 1 FROM pg_attribute a
              JOIN pg_class c2 ON c2.oid = a.attrelid
             WHERE c2.relname = t AND a.attname = 'version'
               AND a.attnum > 0 AND NOT a.attisdropped)
          INTO has_version;

        IF has_version THEN
            EXECUTE format(
              'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                 FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
        ELSE
            EXECUTE format(
              'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                 FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at()', t, t);
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  Audit triggers — attached only to tables where §23 requires history
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'requirements','requirement_lines','purchase_orders','po_lines','po_charges',
        'approvals','gate_entries','weighments','qc_inspections','qc_results',
        'grns','grn_lines','batches','labels','putaway_tasks',
        'landing_costs','purchase_charges','supplier_invoices','invoice_lines',
        'credit_debit_notes','suppliers','products','vehicles','users',
        'roles','role_permissions','role_limits','user_role_assignments',
        'settings','approval_rules','alert_rules','ai_feature_flags','charge_types'
    ] LOOP
        EXECUTE format(
          'CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON %I
             FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  Immutability guards (§13, §23)
-- ---------------------------------------------------------------------------

-- A posted GRN may not be edited; use reversal or amendment
CREATE TRIGGER trg_grn_posted_immutable
    BEFORE UPDATE ON grns
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_when_posted();

-- The stock ledger is append-only. No UPDATE, no DELETE, no exceptions.
CREATE TRIGGER trg_ledger_no_update
    BEFORE UPDATE OR DELETE ON stock_ledger
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();

-- Weighments are append-only; a re-weigh inserts a new row (§11)
CREATE TRIGGER trg_weighment_no_delete
    BEFORE DELETE ON weighments
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();

-- A locked gate entry is immutable (§10)
CREATE OR REPLACE FUNCTION trg_gate_locked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.locked_at IS NOT NULL
       AND (NEW.status, NEW.gate_out_at, NEW.unloading_start_at, NEW.unloading_end_at,
            NEW.detention_minutes, NEW.updated_at, NEW.updated_by, NEW.version)
           IS NOT DISTINCT FROM
           (OLD.status, OLD.gate_out_at, OLD.unloading_start_at, OLD.unloading_end_at,
            OLD.detention_minutes, OLD.updated_at, OLD.updated_by, OLD.version)
       AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'gate_entry_locked: % was submitted and is immutable', OLD.gate_no
            USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_gate_lock_guard
    BEFORE UPDATE ON gate_entries
    FOR EACH ROW EXECUTE FUNCTION trg_gate_locked();

-- No hard delete of approved purchase transactions (§23)
CREATE OR REPLACE FUNCTION trg_no_delete_if_approved()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status NOT IN ('DRAFT','CANCELLED') THEN
        RAISE EXCEPTION 'no_hard_delete: % in status % must be cancelled, not deleted',
            TG_TABLE_NAME, OLD.status USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER trg_po_no_delete BEFORE DELETE ON purchase_orders
    FOR EACH ROW EXECUTE FUNCTION trg_no_delete_if_approved();
CREATE TRIGGER trg_grn_no_delete BEFORE DELETE ON grns
    FOR EACH ROW EXECUTE FUNCTION trg_no_delete_if_approved();
CREATE TRIGGER trg_inv_no_delete BEFORE DELETE ON supplier_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_no_delete_if_approved();

-- ---------------------------------------------------------------------------
--  ROW-LEVEL SECURITY — defence in depth under application-level tenancy
--  The API sets:  SET LOCAL app.company_id = '<uuid>';
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id'
         WHERE c.relkind = 'r' AND n.nspname = current_schema()
           AND c.relname NOT IN ('companies','audit_log')
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (company_id IS NULL OR company_id = current_company_id())
             WITH CHECK (company_id IS NULL OR company_id = current_company_id())', t);
    END LOOP;
END $$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON companies
    USING (id = current_company_id()) WITH CHECK (id = current_company_id());

-- ---------------------------------------------------------------------------
--  DATABASE ROLES — the app must not be able to rewrite history
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chotug_app') THEN
        CREATE ROLE chotug_app LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chotug_readonly') THEN
        CREATE ROLE chotug_readonly LOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO chotug_app, chotug_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chotug_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chotug_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chotug_readonly;

-- Audit and ledger: insert and read only. This is the whole point of them.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log    FROM chotug_app;
REVOKE UPDATE, DELETE, TRUNCATE ON stock_ledger FROM chotug_app;
REVOKE DELETE, TRUNCATE          ON weighments  FROM chotug_app;

-- ---------------------------------------------------------------------------
--  VIEWS
-- ---------------------------------------------------------------------------

-- Live stock position with FEFO ordering, used by put-away and planning
CREATE VIEW v_stock_position AS
SELECT b.company_id,
       b.warehouse_id,
       b.product_id,
       p.sku,
       p.name              AS product_name,
       b.id                AS batch_id,
       b.batch_no,
       b.grade,
       sb.qty,
       sb.weight_kg,
       sb.reserved_qty,
       (sb.qty - sb.reserved_qty)                     AS available_qty,
       COALESCE(b.predicted_expiry_date, b.expiry_date) AS effective_expiry,
       (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_to_expiry,
       b.landed_rate,
       b.status
  FROM stock_balances sb
  JOIN batches  b ON b.id = sb.batch_id
  JOIN products p ON p.id = sb.product_id
 WHERE sb.qty > 0;

-- The open receiving pipeline — the single most-viewed screen in the system
CREATE VIEW v_receiving_pipeline AS
SELECT g.id                AS gate_entry_id,
       g.company_id, g.branch_id, g.warehouse_id,
       g.gate_no, g.status,
       g.vehicle_reg_captured,
       s.trade_name        AS supplier_name,
       po.po_no,
       g.arrived_at,
       EXTRACT(EPOCH FROM (now() - g.arrived_at))/60 AS age_minutes,
       (SELECT count(*) FROM weighments w WHERE w.gate_entry_id = g.id AND w.kind='GROSS') > 0 AS has_gross,
       (SELECT count(*) FROM weighments w WHERE w.gate_entry_id = g.id AND w.kind='TARE')  > 0 AS has_tare,
       (SELECT count(*) FROM qc_inspections q WHERE q.gate_entry_id = g.id)                    AS qc_count,
       (SELECT count(*) FROM grns gr WHERE gr.gate_entry_id = g.id AND gr.status='POSTED')     AS posted_grns,
       g.critical_fail,
       g.is_unplanned
  FROM gate_entries g
  JOIN suppliers s ON s.id = g.supplier_id
  LEFT JOIN purchase_orders po ON po.id = g.po_id
 WHERE g.status NOT IN ('COMPLETED','REJECTED_AT_GATE','CANCELLED');

-- PO fulfilment progress, drives PART_RECEIVED / RECEIVED transitions
CREATE VIEW v_po_progress AS
SELECT po.id AS po_id, po.company_id, po.po_no, po.status,
       sum(pl.qty)                                  AS ordered_qty,
       sum(pl.received_qty)                         AS received_qty,
       sum(pl.accepted_qty)                         AS accepted_qty,
       sum(pl.rejected_qty)                         AS rejected_qty,
       CASE WHEN sum(pl.qty) > 0
            THEN round(100 * sum(pl.received_qty) / sum(pl.qty), 2) END AS fill_pct
  FROM purchase_orders po
  JOIN po_lines pl ON pl.po_id = po.id
 GROUP BY po.id, po.company_id, po.po_no, po.status;

-- AI acceptance rate — the north-star metric for the AI programme (§14.6)
CREATE VIEW v_ai_acceptance AS
SELECT company_id, feature_key, model_version,
       date_trunc('week', created_at)::date AS week,
       count(*)                                                  AS runs,
       count(*) FILTER (WHERE accepted IS TRUE)                   AS accepted,
       count(*) FILTER (WHERE accepted IS FALSE)                  AS overridden,
       count(*) FILTER (WHERE used_fallback)                      AS fallbacks,
       round(100.0 * count(*) FILTER (WHERE accepted IS TRUE)
             / NULLIF(count(*) FILTER (WHERE accepted IS NOT NULL), 0), 2) AS acceptance_pct,
       round(avg(confidence)::numeric, 4)                         AS avg_confidence,
       round(avg(latency_ms)::numeric, 0)                         AS avg_latency_ms
  FROM ai_runs
 GROUP BY company_id, feature_key, model_version, week;

-- ---------------------------------------------------------------------------
--  MATERIALISED VIEWS — dashboard aggregates, refreshed nightly at 02:00 IST
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_purchase_daily AS
SELECT g.company_id, g.branch_id, g.posting_date,
       gl.product_id, g.supplier_id,
       sum(gl.accepted_qty)      AS accepted_qty,
       sum(gl.rejected_qty)      AS rejected_qty,
       sum(gl.net_weight_kg)     AS net_weight_kg,
       sum(gl.line_value)        AS purchase_value,
       count(DISTINCT g.id)      AS grn_count
  FROM grns g
  JOIN grn_lines gl ON gl.grn_id = g.id
 WHERE g.status = 'POSTED'
 GROUP BY g.company_id, g.branch_id, g.posting_date, gl.product_id, g.supplier_id;

CREATE UNIQUE INDEX ux_mv_purchase_daily
    ON mv_purchase_daily (company_id, branch_id, posting_date, product_id, supplier_id);

CREATE MATERIALIZED VIEW mv_qc_rejection_90d AS
SELECT q.company_id, q.product_id, g.supplier_id,
       count(*)                                              AS inspections,
       sum(q.received_qty)                                   AS received_qty,
       sum(q.rejected_qty)                                   AS rejected_qty,
       round(100 * sum(q.rejected_qty) / NULLIF(sum(q.received_qty),0), 2) AS rejection_pct,
       round(avg(q.quality_score), 2)                        AS avg_quality_score
  FROM qc_inspections q
  JOIN gate_entries g ON g.id = q.gate_entry_id
 WHERE q.inspected_at >= now() - interval '90 days'
 GROUP BY q.company_id, q.product_id, g.supplier_id;

CREATE UNIQUE INDEX ux_mv_qc_rej ON mv_qc_rejection_90d (company_id, product_id, supplier_id);

CREATE MATERIALIZED VIEW mv_weight_variance_90d AS
SELECT w.company_id, g.supplier_id, g.vehicle_id, w.weighed_by,
       count(*)                        AS weighments,
       round(avg(abs(w.variance_pct)), 3) AS avg_abs_variance_pct,
       count(*) FILTER (WHERE w.tolerance_breached) AS breaches,
       count(*) FILTER (WHERE w.capture_mode = 'MANUAL') AS manual_captures
  FROM weighments w
  JOIN gate_entries g ON g.id = w.gate_entry_id
 WHERE w.weighed_at >= now() - interval '90 days'
   AND w.variance_pct IS NOT NULL
 GROUP BY w.company_id, g.supplier_id, g.vehicle_id, w.weighed_by;

CREATE MATERIALIZED VIEW mv_landing_cost_trend AS
SELECT lc.company_id, lcl.product_id,
       date_trunc('day', lc.computed_at)::date AS cost_date,
       round(avg(lcl.landed_rate_per_kg), 4)   AS avg_landed_per_kg,
       min(lcl.landed_rate_per_kg)             AS min_landed_per_kg,
       max(lcl.landed_rate_per_kg)             AS max_landed_per_kg,
       sum(lcl.landed_value)                   AS total_landed_value
  FROM landing_costs lc
  JOIN landing_cost_lines lcl ON lcl.landing_cost_id = lc.id
 WHERE lc.cost_status = 'ACTUAL'
 GROUP BY lc.company_id, lcl.product_id, cost_date;

CREATE UNIQUE INDEX ux_mv_lc_trend ON mv_landing_cost_trend (company_id, product_id, cost_date);

-- ============================================================================
--  SECTION 10 — SEED DATA
--  Permissions, system roles, UOMs, tax codes, charge types, QC templates.
--  Everything below is idempotent (ON CONFLICT DO NOTHING) so it can be
--  re-run safely on every deploy.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Permission catalogue (§22) — note that data-level permissions are separate
--  so cost/rate/export/delete can be controlled independently.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('purchase.requirement.create','purchase','requirement','create','Create requirement',false,'NORMAL'),
 ('purchase.requirement.submit','purchase','requirement','submit','Submit requirement',false,'NORMAL'),
 ('purchase.requirement.approve','purchase','requirement','approve','Approve requirement',false,'SENSITIVE'),
 ('purchase.quote.compare','purchase','quote','compare','Compare supplier quotes',false,'NORMAL'),
 ('purchase.quote.select','purchase','quote','select','Select winning source',false,'SENSITIVE'),
 ('purchase.po.create','purchase','po','create','Create PO/Indent',false,'NORMAL'),
 ('purchase.po.submit','purchase','po','submit','Submit PO for approval',false,'NORMAL'),
 ('purchase.po.approve','purchase','po','approve','Approve PO within limit',false,'CRITICAL'),
 ('purchase.po.cancel','purchase','po','cancel','Cancel a PO',false,'SENSITIVE'),
 ('purchase.po.revise','purchase','po','revise','Revise an approved PO',false,'SENSITIVE'),
 ('receiving.gate.create','receiving','gate','create','Create gate entry',false,'NORMAL'),
 ('receiving.gate.submit','receiving','gate','submit','Submit and lock gate entry',false,'NORMAL'),
 ('receiving.gate.reject','receiving','gate','reject','Reject vehicle at gate',false,'SENSITIVE'),
 ('receiving.exception.approve','receiving','gate','exception','Approve chain bypass',false,'CRITICAL'),
 ('receiving.weighment.create','receiving','weighment','create','Capture weight',false,'NORMAL'),
 ('receiving.weighment.reweigh','receiving','weighment','reweigh','Trigger re-weighment',false,'SENSITIVE'),
 ('receiving.weighment.approve','receiving','weighment','approve','Approve weight variance',false,'CRITICAL'),
 ('quality.inspection.create','quality','inspection','create','Perform QC inspection',false,'NORMAL'),
 ('quality.inspection.approve','quality','inspection','approve','Approve/override QC result',false,'CRITICAL'),
 ('quality.template.manage','quality','template','manage','Manage QC templates',false,'SENSITIVE'),
 ('receiving.grn.create','receiving','grn','create','Create GRN draft',false,'NORMAL'),
 ('receiving.grn.submit','receiving','grn','submit','Post GRN to inventory',false,'CRITICAL'),
 ('receiving.grn.amend','receiving','grn','amend','Amend a posted GRN',false,'CRITICAL'),
 ('receiving.grn.reverse','receiving','grn','reverse','Reverse a posted GRN',false,'CRITICAL'),
 ('receiving.label.print','receiving','label','print','Print batch/crate labels',false,'NORMAL'),
 ('receiving.putaway.confirm','receiving','putaway','confirm','Confirm put-away scan',false,'NORMAL'),
 ('costing.landing.view','costing','landing','view','View landing cost',false,'SENSITIVE'),
 ('costing.landing.recompute','costing','landing','recompute','Recompute landing cost',false,'SENSITIVE'),
 ('costing.charge.manage','costing','charge','manage','Manage charges',false,'SENSITIVE'),
 ('finance.invoice.create','finance','invoice','create','Capture supplier invoice',false,'NORMAL'),
 ('finance.invoice.match','finance','invoice','match','Run 3-way match',false,'NORMAL'),
 ('finance.invoice.approve','finance','invoice','approve','Approve invoice mismatch',false,'CRITICAL'),
 ('finance.payment.view','finance','payment','view','View payment status',false,'SENSITIVE'),
 ('finance.note.create','finance','note','create','Create credit/debit note',false,'SENSITIVE'),
 ('master.supplier.manage','master','supplier','manage','Manage suppliers',false,'SENSITIVE'),
 ('master.supplier.block','master','supplier','block','Block/unblock supplier',false,'CRITICAL'),
 ('master.product.manage','master','product','manage','Manage products',false,'SENSITIVE'),
 ('master.vehicle.manage','master','vehicle','manage','Manage vehicles/drivers',false,'NORMAL'),
 ('reports.purchase.view','reports','purchase','view','View purchase reports',false,'NORMAL'),
 ('reports.supplier.view','reports','supplier','view','View supplier performance',false,'NORMAL'),
 ('admin.rbac.manage','admin','rbac','manage','Manage roles and permissions',false,'CRITICAL'),
 ('admin.settings.manage','admin','settings','manage','Manage thresholds and rules',false,'CRITICAL'),
 ('admin.audit.view','admin','audit','view','View full audit trail',false,'SENSITIVE'),
 ('admin.override','admin','override','execute','Break-glass override',false,'CRITICAL'),
 ('ai.suggestion.accept','ai','suggestion','accept','Accept an AI suggestion',false,'NORMAL'),
 ('ai.feature.manage','ai','feature','manage','Enable/disable AI features',false,'CRITICAL'),
 -- data-level permissions: strip columns server-side, never CSS-hide (§6.1)
 ('data.cost.view','data','cost','view','See rate/landing cost/margin columns',true,'SENSITIVE'),
 ('data.margin.view','data','margin','view','See margin analytics',true,'SENSITIVE'),
 ('data.export','data','export','execute','Export any report to file',true,'SENSITIVE'),
 ('data.backdate','data','backdate','execute','Post with an earlier date',true,'CRITICAL')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
--  UOMs
-- ---------------------------------------------------------------------------
INSERT INTO uoms (code, name, name_hi, uom_type, base_uom, factor_to_base) VALUES
 ('KG',   'Kilogram', 'किलोग्राम', 'WEIGHT', NULL,  1),
 ('GM',   'Gram',     'ग्राम',     'WEIGHT', 'KG',  0.001),
 ('QTL',  'Quintal',  'क्विंटल',   'WEIGHT', 'KG',  100),
 ('TON',  'Tonne',    'टन',        'WEIGHT', 'KG',  1000),
 ('PCS',  'Pieces',   'नग',        'COUNT',  NULL,  1),
 ('DOZ',  'Dozen',    'दर्जन',     'COUNT',  'PCS', 12),
 ('CRATE','Crate',    'क्रेट',     'COUNT',  NULL,  1),
 ('BAG',  'Bag',      'बोरी',      'COUNT',  NULL,  1),
 ('BOX',  'Box',      'पेटी',      'COUNT',  NULL,  1),
 ('LTR',  'Litre',    'लीटर',      'VOLUME', NULL,  1)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
--  GST tax codes. Most fresh produce is nil-rated; packaged goods are not.
-- ---------------------------------------------------------------------------
INSERT INTO tax_codes (code, name, gst_rate, is_input_creditable) VALUES
 ('GST0',  'GST 0% (exempt / fresh produce)', 0,  false),
 ('GST5',  'GST 5%',                          5,  true),
 ('GST12', 'GST 12%',                        12,  true),
 ('GST18', 'GST 18%',                        18,  true),
 ('GST28', 'GST 28%',                        28,  true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
--  Bootstrap procedure for a new company: roles, series, charges, settings.
--  Call once per tenant: SELECT bootstrap_company('<company_uuid>');
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bootstrap_company(p_company uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_role_id uuid;
    r         record;
BEGIN
    -- System roles (§22)
    FOR r IN SELECT * FROM (VALUES
        ('PURCHASE_EXEC','Purchase Executive','क्रय कार्यकारी',   0, NULL::numeric),
        ('PURCHASE_MGR', 'Purchase Manager',  'क्रय प्रबंधक',      2, 500000),
        ('QC_EXEC',      'QC Executive',      'गुणवत्ता कार्यकारी',0, NULL),
        ('QC_HEAD',      'QC Head',           'गुणवत्ता प्रमुख',   2, NULL),
        ('GATE_EXEC',    'Gate Executive',    'गेट कार्यकारी',     0, NULL),
        ('WH_EXEC',      'Warehouse Executive','गोदाम कार्यकारी',  0, NULL),
        ('FINANCE_EXEC', 'Finance Executive', 'वित्त कार्यकारी',   2, 200000),
        ('OWNER',        'Owner / Super Admin','स्वामी',           3, NULL)
    ) AS t(code, name, name_hi, lvl, po_limit)
    LOOP
        INSERT INTO roles (company_id, code, name, name_hi, is_system)
        VALUES (p_company, r.code, r.name, r.name_hi, true)
        ON CONFLICT (company_id, code) DO NOTHING
        RETURNING id INTO v_role_id;

        IF v_role_id IS NULL THEN
            SELECT id INTO v_role_id FROM roles WHERE company_id = p_company AND code = r.code;
        END IF;

        INSERT INTO role_limits (role_id, max_po_value, max_approval_level,
                                 max_rate_variance_pct, max_qty_variance_pct,
                                 max_weight_variance_pct, max_backdate_days)
        VALUES (v_role_id, r.po_limit, r.lvl,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 10 ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 10 ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 5  ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 30  ELSE 0 END)
        ON CONFLICT (role_id) DO NOTHING;
    END LOOP;

    -- Grant permissions per role, mirroring the §6.2 matrix
    PERFORM grant_role_perms(p_company, 'PURCHASE_EXEC', ARRAY[
        'purchase.requirement.create','purchase.requirement.submit','purchase.quote.compare',
        'purchase.po.create','purchase.po.submit','ai.suggestion.accept',
        'reports.purchase.view','reports.supplier.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_MGR', ARRAY[
        'purchase.requirement.create','purchase.requirement.submit','purchase.requirement.approve',
        'purchase.quote.compare','purchase.quote.select','purchase.po.create','purchase.po.submit',
        'purchase.po.approve','purchase.po.revise','purchase.po.cancel',
        'receiving.weighment.approve','costing.landing.view','ai.suggestion.accept',
        'reports.purchase.view','reports.supplier.view','data.cost.view','data.export']);
    PERFORM grant_role_perms(p_company, 'QC_EXEC', ARRAY[
        'quality.inspection.create','reports.supplier.view']);
    PERFORM grant_role_perms(p_company, 'QC_HEAD', ARRAY[
        'quality.inspection.create','quality.inspection.approve','quality.template.manage',
        'reports.supplier.view','data.export']);
    PERFORM grant_role_perms(p_company, 'GATE_EXEC', ARRAY[
        'receiving.gate.create','receiving.gate.submit','receiving.gate.reject',
        'receiving.weighment.create','master.vehicle.manage']);
    PERFORM grant_role_perms(p_company, 'WH_EXEC', ARRAY[
        'receiving.weighment.create','receiving.grn.create','receiving.grn.submit',
        'receiving.label.print','receiving.putaway.confirm']);
    PERFORM grant_role_perms(p_company, 'FINANCE_EXEC', ARRAY[
        'finance.invoice.create','finance.invoice.match','finance.invoice.approve',
        'finance.payment.view','finance.note.create','costing.landing.view',
        'reports.purchase.view','data.cost.view','data.export']);
    -- Owner gets everything
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT role_row.id, p.code FROM roles AS role_row CROSS JOIN permissions p
     WHERE role_row.company_id = p_company AND role_row.code = 'OWNER'
    ON CONFLICT DO NOTHING;

    -- Default charge types feeding the landing-cost engine (§16)
    INSERT INTO charge_types (company_id, code, name, name_hi, allocation_basis, is_creditable, borne_by) VALUES
      (p_company,'COMMISSION','Aadhti/Mandi Commission','आढ़त कमीशन','VALUE', false,'BUYER'),
      (p_company,'MARKET_FEE','APMC Market Fee',        'मंडी शुल्क','VALUE', false,'BUYER'),
      (p_company,'TRANSPORT', 'Transport / Freight',    'भाड़ा',     'WEIGHT',false,'BUYER'),
      (p_company,'LOADING',   'Loading (Hamali)',       'चढ़ाई',     'WEIGHT',false,'BUYER'),
      (p_company,'UNLOADING', 'Unloading (Hamali)',     'उतराई',    'WEIGHT',false,'BUYER'),
      (p_company,'PACKING',   'Packing / Crate',        'पैकिंग',    'QTY',   false,'BUYER'),
      (p_company,'COLD_STORE','Cold Storage',           'शीत भंडारण','WEIGHT',true, 'BUYER'),
      (p_company,'GATE_FEE',  'Gate / Documentation',   'गेट शुल्क', 'EQUAL', false,'BUYER'),
      (p_company,'INSURANCE', 'Transit Insurance',      'बीमा',      'VALUE', true, 'BUYER'),
      (p_company,'OTHER',     'Other Allocable Cost',   'अन्य',      'MANUAL',false,'BUYER')
    ON CONFLICT (company_id, code) DO NOTHING;

    -- Default tolerance profile (§17)
    INSERT INTO tolerance_profiles (company_id, code, name, is_default)
    VALUES (p_company, 'DEFAULT', 'Default tolerance profile', true)
    ON CONFLICT (company_id, code) DO NOTHING;

    -- Operating thresholds — all Owner-editable in P1 (§24 settings screen)
    INSERT INTO settings (company_id, scope, key, value) VALUES
      (p_company,'COMPANY','weight.tolerance.green_pct',      '0.5'),
      (p_company,'COMPANY','weight.tolerance.amber_pct',      '2.0'),
      (p_company,'COMPANY','weight.tolerance.red_pct',        '5.0'),
      (p_company,'COMPANY','approval.auto_approve_below',     '25000'),
      (p_company,'COMPANY','approval.max_rate_variance_pct',  '5'),
      (p_company,'COMPANY','approval.max_qty_variance_pct',   '10'),
      (p_company,'COMPANY','approval.min_margin_pct',         '8'),
      (p_company,'COMPANY','landing_cost.variance_alert_pct', '3'),
      (p_company,'COMPANY','qc.sla_minutes',                  '45'),
      (p_company,'COMPANY','grn.sla_minutes',                 '120'),
      (p_company,'COMPANY','grocery.min_remaining_shelf_pct', '75'),
      (p_company,'COMPANY','ai.min_acceptance_target_pct',    '60')
    ON CONFLICT (company_id, branch_id, key) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION grant_role_perms(p_company uuid, p_role text, p_perms text[])
RETURNS void LANGUAGE sql AS $$
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, unnest(p_perms)
      FROM roles r
     WHERE r.company_id = p_company AND r.code = p_role
    ON CONFLICT DO NOTHING;
$$;

COMMIT;

-- ============================================================================
--  APPENDIX A — QC TEMPLATE SEED (§13.3)
--  Run AFTER a company exists. Shown for POTATO; repeat the pattern for
--  onion, tomato, banana, mango, apple, leafy, citrus, grain, spice,
--  packaged grocery and dairy using the parameter tables in the blueprint.
-- ============================================================================
/*
WITH t AS (
  INSERT INTO qc_templates (company_id, code, name, name_hi, sampling_rule)
  VALUES ('<company_uuid>', 'QC_POTATO', 'Potato QC', 'आलू गुणवत्ता जाँच',
          '{"mode":"SQRT","min_units":5,"new_supplier_multiplier":2}')
  RETURNING id, company_id)
INSERT INTO qc_parameters
  (company_id, template_id, seq, code, label, label_hi, param_type, unit,
   min_ok, max_ok, is_critical, weight, requires_photo, ai_assisted, ai_feature_key)
SELECT t.company_id, t.id, v.seq, v.code, v.label, v.label_hi, v.ptype, v.unit,
       v.min_ok, v.max_ok, v.crit, v.wt, v.photo, v.ai, v.ai_key
FROM t, (VALUES
  (1,'SIZE_MM',   'Size grading',            'आकार',          'NUMERIC','mm', 40, 80, false, 1.0, false, true, 'size_distribution'),
  (2,'GREENING',  'Greening (solanine)',     'हरापन',         'PERCENT','%',   0,  2, true,  2.0, true,  true, 'defect_area_pct'),
  (3,'SPROUTING', 'Sprouting',               'अंकुरण',        'PERCENT','%',   0,  3, false, 1.5, false, true, 'defect_area_pct'),
  (4,'ROT',       'Rot / soft rot',          'सड़न',           'PERCENT','%',   0,  1, true,  3.0, true,  true, 'defect_area_pct'),
  (5,'DAMAGE',    'Cuts, bruises, damage',   'कटा-फटा',       'PERCENT','%',   0,  5, false, 1.5, true,  true, 'defect_area_pct'),
  (6,'SOIL',      'Adhering soil by weight', 'मिट्टी',         'PERCENT','%',   0,  2, false, 1.0, false, false, NULL),
  (7,'HOLLOW',    'Hollow/black heart (cut)','खोखलापन',       'COUNT',  'in10',0,  1, false, 2.0, true,  false, NULL),
  (8,'DRY_MATTER','Dry matter (chipping)',   'शुष्क पदार्थ',   'NUMERIC','%',  20, 30, false, 1.0, false, false, NULL)
) AS v(seq,code,label,label_hi,ptype,unit,min_ok,max_ok,crit,wt,photo,ai,ai_key);
*/

-- ============================================================================
--  APPENDIX B — OPERATIONAL NOTES
-- ============================================================================
--  1. Set the tenant on EVERY request, inside the transaction:
--        SET LOCAL app.company_id = '...';  SET LOCAL app.user_id = '...';
--        SET LOCAL app.actor_role = 'PURCHASE_MGR'; SET LOCAL app.request_id = '...';
--     Without app.company_id, RLS returns zero rows. That is intentional:
--     a forgotten tenant context fails closed, not open.
--
--  2. Refresh materialised views nightly:
--        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_purchase_daily;
--     (CONCURRENTLY requires the unique indexes created above.)
--
--  3. Roll audit partitions forward monthly:
--        SELECT ensure_audit_partition((CURRENT_DATE + interval '1 month')::date);
--
--  4. Purge expired idempotency keys hourly:
--        DELETE FROM idempotency_keys WHERE expires_at < now();
--
--  5. The concurrency test that must live in CI: fire 50 parallel
--     POST /grn/:id/submit and assert exactly one stock_ledger row per
--     GRN line. uq_ledger_grn_line and uq_grn_idempotency are what make
--     that pass; do not drop them for "performance".
-- ============================================================================
