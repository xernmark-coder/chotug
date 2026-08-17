-- ============================================================================
--  ChotuG ERP — FARMING MODULE (own-farm production)
--
--  Runs AFTER 01_schema.sql / 03_migration_fixes.sql / 02_seed.sql.
--  Everything here is ADDITIVE and idempotent: no existing table is dropped,
--  no existing column changes meaning, and re-running is safe.
--
--  The one idea behind the whole thing:  the staff member reports GROUND
--  REALITY (crop, area, actual weight, a problem, a bill) and the system
--  derives everything else — dates, calendar, crop age, harvest window,
--  stock, cost per kg, colour rating and the next crop.
--
--  It plugs into the existing chain rather than sitting beside it:
--     farm_crop_cycles → farm_harvests → farm_dispatches
--       → batches (farm_id) → stock_ledger (TRANSFER_IN) → stock_balances
--  so a farm-grown crate is the same first-class batch as a purchased one and
--  every existing stock, traceability and expiry screen already understands it.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ============================================================================
--  SECTION F0 — EXTEND WHAT ALREADY EXISTS (never replace it)
-- ============================================================================

-- `farms` was a supplier's farm, used for one-up traceability on a batch.
-- An own farm is the same physical thing with no supplier behind it, so we
-- widen the table instead of creating a parallel one — which means
-- batches.farm_id keeps working for BOTH sources with zero changes.
ALTER TABLE farms ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS code                 text;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS branch_id            uuid REFERENCES branches(id);
ALTER TABLE farms ADD COLUMN IF NOT EXISTS is_own               boolean NOT NULL DEFAULT false;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS water_source         text;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS soil_type            text;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS default_warehouse_id uuid REFERENCES warehouses(id);
ALTER TABLE farms ADD COLUMN IF NOT EXISTS manager_id           uuid REFERENCES users(id);
ALTER TABLE farms ADD COLUMN IF NOT EXISTS status               text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE farms ADD COLUMN IF NOT EXISTS notes                text;

ALTER TABLE farms DROP CONSTRAINT IF EXISTS ck_farm_status;
ALTER TABLE farms ADD  CONSTRAINT ck_farm_status
      CHECK (status IN ('ACTIVE','INACTIVE'));
ALTER TABLE farms DROP CONSTRAINT IF EXISTS ck_farm_water_source;
ALTER TABLE farms ADD  CONSTRAINT ck_farm_water_source
      CHECK (water_source IS NULL OR water_source IN
             ('TUBE_WELL','CANAL','RIVER','POND','RAIN_FED','DRIP','BOREWELL','OTHER'));
-- An own farm belongs to a branch and needs a code; a supplier farm needs neither.
ALTER TABLE farms DROP CONSTRAINT IF EXISTS ck_farm_ownership;
ALTER TABLE farms ADD  CONSTRAINT ck_farm_ownership
      CHECK ((is_own AND code IS NOT NULL AND branch_id IS NOT NULL)
             OR (NOT is_own AND supplier_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_farm_code ON farms (company_id, code)
       WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_farms_own ON farms (company_id, is_own) WHERE is_own;

-- The work queue is the single home screen for every role (§5.3). Farming
-- tasks belong in it, not in a second inbox nobody looks at.
-- Rebuild the allowed queue keys as the union of what this migration needs and
-- what is already in the table — the same trap the number_series rebuild below
-- documents. A later migration adds its own key (PO_CONFIRM); a plain DROP/ADD
-- here revoked it on the next re-run, and once rows carrying that key existed
-- the constraint could no longer even be created:
--
--   check constraint "work_queue_queue_key_check" is violated by some row
--
-- which stopped every deploy at 04_farming.sql.
DO $$
DECLARE v_keys text[];
BEGIN
    SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys FROM (
        SELECT unnest(ARRAY['REQUIREMENT_REVIEW','AI_SUGGESTION','APPROVAL',
                            'EXPECTED_ARRIVAL','WEIGH_PENDING','QC_PENDING',
                            'GRN_PENDING','PUTAWAY_PENDING','INVOICE_MATCH',
                            'FINANCE_EXCEPTION','ALERT',
                            'FARM_TASK','FARM_HARVEST','FARM_RECEIVE']) AS k
        UNION
        SELECT queue_key FROM work_queue
    ) x;
    ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_queue_key_check;
    EXECUTE format(
      'ALTER TABLE work_queue ADD CONSTRAINT work_queue_queue_key_check
         CHECK (queue_key = ANY (%L))', v_keys);
END $$;

-- Document numbering for the three farming documents.
-- Rebuild the allowed doc types as the union of what this migration needs and
-- what is already in use. A later migration adds its own (ISS), and a plain
-- DROP/ADD here would revoke it the next time this file re-ran — which is how
-- an "idempotent" migration chain quietly stops being idempotent.
DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['REQ','RFQ','IND','PO','GATE','WGT','QC','GRN',
                          'BATCH','LABEL','INV','DN','CN','PUT',
                          'CROP','HARV','FDN']) AS t
        UNION
        SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

-- ============================================================================
--  SECTION F1 — FARM SETUP  (§1: entered once, never asked again)
-- ============================================================================

CREATE TABLE IF NOT EXISTS farm_plots (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    farm_id         uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    code            text NOT NULL,                  -- A, B, C, BED-01
    name            text,
    area_acre       numeric(10,3) NOT NULL DEFAULT 0 CHECK (area_acre >= 0),
    soil_type       text,
    irrigation_type text CHECK (irrigation_type IS NULL OR irrigation_type IN
                     ('DRIP','SPRINKLER','FLOOD','FURROW','MANUAL')),
    -- §6: the QR stuck on the plot gate. Scanning it opens THIS plot's screen,
    -- which is what stops entries landing on the wrong crop.
    qr_code         text NOT NULL,
    status          text NOT NULL DEFAULT 'IDLE'
                    CHECK (status IN ('IDLE','PREPARING','CROPPED','RESTING','RETIRED')),
    last_crop_id    uuid,
    notes           text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    version         integer NOT NULL DEFAULT 1,
    UNIQUE (farm_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_qr ON farm_plots (company_id, qr_code);

-- ---------------------------------------------------------------------------
--  Crop master — the agronomy that makes the calendar automatic (§2, §4).
--  Everything the system later "knows by itself" is configured here ONCE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_crops (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id            uuid NOT NULL REFERENCES companies(id),
    code                  text NOT NULL,
    name                  text NOT NULL,
    name_hi               text,
    -- What this crop becomes in inventory once harvested. Without it the
    -- harvest cannot enter stock, so it is effectively mandatory in practice.
    product_id            uuid REFERENCES products(id),
    duration_days         smallint NOT NULL CHECK (duration_days > 0),
    harvest_window_days   smallint NOT NULL DEFAULT 1 CHECK (harvest_window_days > 0),
    yield_per_acre_kg     numeric(14,3) NOT NULL CHECK (yield_per_acre_kg > 0),
    seed_cost_per_acre    numeric(18,4) NOT NULL DEFAULT 0,
    input_cost_per_acre   numeric(18,4) NOT NULL DEFAULT 0,   -- fertiliser+spray+labour estimate
    irrigation_interval_days      smallint NOT NULL DEFAULT 4,
    irrigation_interval_days_hot  smallint,                   -- used above heat_threshold_c
    heat_threshold_c      numeric(5,2) NOT NULL DEFAULT 36,
    inspection_interval_days      smallint NOT NULL DEFAULT 7,
    -- [{ "day": 15, "label": "Basal dose — DAP", "input": "DAP",
    --    "qtyPerAcre": 50, "uom": "KG" }]
    fertilizer_schedule   jsonb NOT NULL DEFAULT '[]'::jsonb,
    spray_schedule        jsonb NOT NULL DEFAULT '[]'::jsonb,
    seasons               text[] NOT NULL DEFAULT ARRAY['ALL'],
    water_need            text NOT NULL DEFAULT 'MEDIUM'
                          CHECK (water_need IN ('LOW','MEDIUM','HIGH')),
    avoid_after_crop_codes text[] NOT NULL DEFAULT '{}',       -- §30 rotation sense
    notes                 text,
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid,
    version               integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS farm_machines (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    farm_id           uuid REFERENCES farms(id) ON DELETE SET NULL,
    code              text NOT NULL,
    name              text NOT NULL,
    machine_type      text NOT NULL CHECK (machine_type IN
                      ('TRACTOR','PUMP','SPRAYER','TILLER','HARVESTER','GENERATOR','OTHER')),
    -- §23: three colours, nothing more.
    status            text NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (status IN ('AVAILABLE','IN_USE','MAINTENANCE_DUE','BREAKDOWN')),
    last_service_date date,
    service_interval_days smallint NOT NULL DEFAULT 90,
    next_service_date date,
    status_note       text,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

-- ============================================================================
--  SECTION F2 — CROP CYCLE  (§2: four answers, then the system takes over)
-- ============================================================================

CREATE TABLE IF NOT EXISTS farm_crop_cycles (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id            uuid NOT NULL REFERENCES companies(id),
    branch_id             uuid NOT NULL REFERENCES branches(id),
    farm_id               uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
    plot_id               uuid NOT NULL REFERENCES farm_plots(id) ON DELETE RESTRICT,
    crop_id               uuid NOT NULL REFERENCES farm_crops(id),
    product_id            uuid REFERENCES products(id),
    cycle_no              text NOT NULL,
    -- what the human typed --------------------------------------------------
    area_acre             numeric(10,3) NOT NULL CHECK (area_acre > 0),
    sowing_date           date NOT NULL,
    -- what the system derived -----------------------------------------------
    duration_days         smallint NOT NULL,
    expected_harvest_date date NOT NULL,
    expected_harvest_end_date date NOT NULL,
    expected_yield_kg     numeric(14,3) NOT NULL,
    estimated_cost        numeric(18,4) NOT NULL DEFAULT 0,
    -- what reality then did -------------------------------------------------
    harvested_kg          numeric(14,3) NOT NULL DEFAULT 0,
    waste_kg              numeric(14,3) NOT NULL DEFAULT 0,
    dispatched_kg         numeric(14,3) NOT NULL DEFAULT 0,
    received_kg           numeric(14,3) NOT NULL DEFAULT 0,
    loss_kg               numeric(14,3) NOT NULL DEFAULT 0,
    actual_cost           numeric(18,4) NOT NULL DEFAULT 0,
    revenue               numeric(18,4) NOT NULL DEFAULT 0,
    -- §5: the whole module speaks in three colours
    health                text NOT NULL DEFAULT 'GREEN'
                          CHECK (health IN ('GREEN','YELLOW','RED')),
    health_note           text,
    status                text NOT NULL DEFAULT 'GROWING'
                          CHECK (status IN ('PLANNED','GROWING','HARVESTING','CLOSED','FAILED')),
    first_harvest_at      timestamptz,
    closed_at             timestamptz,
    closed_by             uuid REFERENCES users(id),
    close_reason          text,
    remarks               text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid,
    version               integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, cycle_no),
    CHECK (expected_harvest_date >= sowing_date),
    CHECK (expected_harvest_end_date >= expected_harvest_date)
);
-- One live crop per plot. Two crops on one bed is a data-entry mistake, not a
-- farming practice, and it corrupts every per-plot number downstream.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_live_per_plot ON farm_crop_cycles (plot_id)
    WHERE status IN ('PLANNED','GROWING','HARVESTING');
CREATE INDEX IF NOT EXISTS ix_cycle_open ON farm_crop_cycles
    (company_id, status, expected_harvest_date);
CREATE INDEX IF NOT EXISTS ix_cycle_product ON farm_crop_cycles (product_id, expected_harvest_date);

-- ---------------------------------------------------------------------------
--  §3 / §4 — FARM TODAY. One row per thing a person must do on a given day,
--  generated from the crop calendar at sowing and adjusted by the weather.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_tasks (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    branch_id       uuid NOT NULL REFERENCES branches(id),
    farm_id         uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    plot_id         uuid REFERENCES farm_plots(id) ON DELETE CASCADE,
    cycle_id        uuid REFERENCES farm_crop_cycles(id) ON DELETE CASCADE,
    task_type       text NOT NULL CHECK (task_type IN
                    ('IRRIGATION','FERTILIZER','SPRAY','INSPECTION','WEEDING',
                     'HARVEST','MACHINE','OTHER')),
    title           text NOT NULL,
    title_hi        text,
    due_date        date NOT NULL,
    day_number      smallint,                     -- crop age when this falls due
    -- §8: only genuinely unknowable things are asked for. Quantity is one.
    input_name      text,
    planned_qty     numeric(14,3),
    input_uom       text,
    requires_qty    boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','DONE','PROBLEM','SKIPPED','CANCELLED')),
    severity        text NOT NULL DEFAULT 'GREEN'
                    CHECK (severity IN ('GREEN','YELLOW','RED')),
    source          text NOT NULL DEFAULT 'CALENDAR'
                    CHECK (source IN ('CALENDAR','WEATHER','MANUAL','SYSTEM')),
    -- The dedupe key is what makes calendar regeneration and the daily weather
    -- pass idempotent: running them twice cannot double a farmer's work list.
    dedupe_key      text NOT NULL,
    actual_qty      numeric(14,3),
    done_at         timestamptz,
    done_by         uuid REFERENCES users(id),
    note            text,
    problem_code    text CHECK (problem_code IS NULL OR problem_code IN
                    ('DISEASE','PEST','WEATHER','WATER','MACHINE','LABOUR','INPUT_MISSING','OTHER')),
    auto_skipped_reason text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    version         integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, dedupe_key),
    CONSTRAINT ck_farm_task_problem CHECK (status <> 'PROBLEM' OR problem_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_farm_task_today ON farm_tasks (company_id, farm_id, due_date)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_farm_task_cycle ON farm_tasks (cycle_id, due_date);
CREATE INDEX IF NOT EXISTS ix_farm_task_staff ON farm_tasks (done_by, done_at DESC);

-- ---------------------------------------------------------------------------
--  §10 / §11 — Crop health check and the photo diary. One question, three
--  answers, an optional photo. Anything more and it stops being filled in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_observations (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    farm_id       uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    plot_id       uuid REFERENCES farm_plots(id) ON DELETE CASCADE,
    cycle_id      uuid REFERENCES farm_crop_cycles(id) ON DELETE CASCADE,
    task_id       uuid REFERENCES farm_tasks(id) ON DELETE SET NULL,
    observed_at   timestamptz NOT NULL DEFAULT now(),
    day_number    smallint,
    health        text NOT NULL CHECK (health IN ('GREEN','YELLOW','RED')),
    stage         text CHECK (stage IS NULL OR stage IN
                  ('SOWING','GERMINATION','VEGETATIVE','FLOWERING','FRUITING','HARVEST')),
    issue_code    text,
    note          text,
    photo_data    text,                     -- data: URI from the phone camera
    photo_mime    text,
    observed_by   uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid
);
CREATE INDEX IF NOT EXISTS ix_obs_cycle ON farm_observations (cycle_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_obs_open_issue ON farm_observations (company_id, observed_at DESC)
    WHERE health <> 'GREEN';

-- ---------------------------------------------------------------------------
--  §9 — Weather. One row per farm per day; the irrigation and spray decisions
--  read it so nobody has to open a second app.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_weather (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    farm_id       uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    weather_date  date NOT NULL,
    temp_min_c    numeric(5,2),
    temp_max_c    numeric(5,2),
    rain_mm       numeric(8,2) NOT NULL DEFAULT 0,
    rain_prob_pct numeric(5,2),
    wind_kmph     numeric(6,2),
    humidity_pct  numeric(5,2),
    condition     text,
    source        text NOT NULL DEFAULT 'MANUAL'
                  CHECK (source IN ('MANUAL','FORECAST','API')),
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (farm_id, weather_date)
);

-- ============================================================================
--  SECTION F3 — HARVEST → DISPATCH → STOCK
--  §13 §15 §16: scan, weigh, grade, print. The system supplies the rest.
-- ============================================================================

CREATE TABLE IF NOT EXISTS farm_harvests (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    branch_id         uuid NOT NULL REFERENCES branches(id),
    farm_id           uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
    plot_id           uuid NOT NULL REFERENCES farm_plots(id) ON DELETE RESTRICT,
    cycle_id          uuid NOT NULL REFERENCES farm_crop_cycles(id) ON DELETE RESTRICT,
    product_id        uuid REFERENCES products(id),
    harvest_no        text NOT NULL,
    harvest_date      date NOT NULL DEFAULT CURRENT_DATE,
    crop_age_days     smallint,                       -- derived, never typed
    gross_weight_kg   numeric(14,3) NOT NULL DEFAULT 0 CHECK (gross_weight_kg >= 0),
    tare_weight_kg    numeric(14,3) NOT NULL DEFAULT 0,
    net_weight_kg     numeric(14,3) NOT NULL DEFAULT 0 CHECK (net_weight_kg >= 0),
    crate_count       integer NOT NULL DEFAULT 0,
    container_type_id uuid REFERENCES container_types(id),
    -- §14: a connected scale writes the weight itself; typing it is the fallback.
    capture_mode      text NOT NULL DEFAULT 'MANUAL'
                      CHECK (capture_mode IN ('MANUAL','SCALE')),
    scale_device_id   uuid REFERENCES scale_devices(id),
    label_code        text,                            -- the printed crate QR
    status            text NOT NULL DEFAULT 'READY'
                      CHECK (status IN ('READY','PART_DISPATCHED','DISPATCHED','CANCELLED')),
    harvested_by      uuid REFERENCES users(id),
    remarks           text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid,
    version           integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, harvest_no)
);
CREATE INDEX IF NOT EXISTS ix_harvest_cycle ON farm_harvests (cycle_id, harvest_date DESC);
CREATE INDEX IF NOT EXISTS ix_harvest_open ON farm_harvests (company_id, status, harvest_date)
    WHERE status IN ('READY','PART_DISPATCHED');

-- §15 — exactly four grades. More than four and nobody grades honestly.
CREATE TABLE IF NOT EXISTS farm_harvest_lines (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    harvest_id    uuid NOT NULL REFERENCES farm_harvests(id) ON DELETE CASCADE,
    grade         text NOT NULL CHECK (grade IN ('A','B','C','WASTE')),
    weight_kg     numeric(14,3) NOT NULL CHECK (weight_kg >= 0),
    crate_count   integer NOT NULL DEFAULT 0,
    destination   text NOT NULL DEFAULT 'RETAIL'
                  CHECK (destination IN ('RETAIL','B2B','PROCESSING','WASTE','FARM_HOLD')),
    dispatched_kg numeric(14,3) NOT NULL DEFAULT 0,
    label_code    text,
    UNIQUE (harvest_id, grade)
);

-- ---------------------------------------------------------------------------
--  §16 — Farm → warehouse transfer, with the two-sided weight check that
--  makes a 3 kg difference visible instead of invisible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_dispatches (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    branch_id           uuid NOT NULL REFERENCES branches(id),
    farm_id             uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
    warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
    dispatch_no         text NOT NULL,
    dispatch_date       date NOT NULL DEFAULT CURRENT_DATE,
    vehicle_id          uuid REFERENCES vehicles(id),
    vehicle_reg         text,
    driver_name         text,
    dispatch_weight_kg  numeric(14,3) NOT NULL DEFAULT 0,
    received_weight_kg  numeric(14,3),
    variance_kg         numeric(14,3),
    variance_pct        numeric(9,4),
    variance_band       text CHECK (variance_band IS NULL OR variance_band IN
                        ('GREEN','AMBER','RED','CRITICAL')),
    variance_reason     text,
    status              text NOT NULL DEFAULT 'DISPATCHED'
                        CHECK (status IN ('DISPATCHED','RECEIVED','CANCELLED')),
    dispatched_by       uuid REFERENCES users(id),
    received_by         uuid REFERENCES users(id),
    received_at         timestamptz,
    idempotency_key     text,
    remarks             text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, dispatch_no)
);
CREATE INDEX IF NOT EXISTS ix_dispatch_open ON farm_dispatches (company_id, warehouse_id, status)
    WHERE status = 'DISPATCHED';

CREATE TABLE IF NOT EXISTS farm_dispatch_lines (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    dispatch_id         uuid NOT NULL REFERENCES farm_dispatches(id) ON DELETE CASCADE,
    harvest_id          uuid NOT NULL REFERENCES farm_harvests(id),
    cycle_id            uuid NOT NULL REFERENCES farm_crop_cycles(id),
    product_id          uuid NOT NULL REFERENCES products(id),
    grade               text NOT NULL CHECK (grade IN ('A','B','C','WASTE')),
    dispatch_weight_kg  numeric(14,3) NOT NULL CHECK (dispatch_weight_kg > 0),
    received_weight_kg  numeric(14,3),
    crate_count         integer NOT NULL DEFAULT 0,
    rate_per_kg         numeric(18,6),               -- the farm's own cost per kg
    -- The link into the existing inventory world. Once this is set the produce
    -- is ordinary stock and every stock screen already understands it.
    batch_id            uuid REFERENCES batches(id),
    UNIQUE (dispatch_id, harvest_id, grade)
);

-- ============================================================================
--  SECTION F4 — MONEY, LOSS, PERFORMANCE, DAY CLOSE
-- ============================================================================

-- §18: three fields. Farm, plot, crop, date and user are attached by the system.
CREATE TABLE IF NOT EXISTS farm_expenses (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    farm_id       uuid NOT NULL REFERENCES farms(id) ON DELETE RESTRICT,
    plot_id       uuid REFERENCES farm_plots(id) ON DELETE SET NULL,
    cycle_id      uuid REFERENCES farm_crop_cycles(id) ON DELETE SET NULL,
    task_id       uuid REFERENCES farm_tasks(id) ON DELETE SET NULL,
    machine_id    uuid REFERENCES farm_machines(id) ON DELETE SET NULL,
    expense_date  date NOT NULL DEFAULT CURRENT_DATE,
    expense_type  text NOT NULL CHECK (expense_type IN
                  ('SEED','FERTILIZER','PESTICIDE','LABOUR','WATER','ELECTRICITY',
                   'MACHINE','FUEL','HARVEST','PACKING','TRANSPORT','RENT','OTHER')),
    amount        numeric(18,4) NOT NULL CHECK (amount >= 0),
    qty           numeric(14,3),
    uom           text,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid
);
CREATE INDEX IF NOT EXISTS ix_farm_expense_cycle ON farm_expenses (cycle_id, expense_date);
CREATE INDEX IF NOT EXISTS ix_farm_expense_day ON farm_expenses (company_id, farm_id, expense_date);

-- §21: the user picks a reason. The system works out what it cost.
CREATE TABLE IF NOT EXISTS farm_losses (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    farm_id       uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    plot_id       uuid REFERENCES farm_plots(id) ON DELETE SET NULL,
    cycle_id      uuid REFERENCES farm_crop_cycles(id) ON DELETE SET NULL,
    loss_date     date NOT NULL DEFAULT CURRENT_DATE,
    reason        text NOT NULL CHECK (reason IN
                  ('DISEASE','PEST','WEATHER','WATER','QUALITY_REJECT',
                   'HARVEST_DAMAGE','SUSPECTED_THEFT','OTHER')),
    qty_kg        numeric(14,3) NOT NULL DEFAULT 0,
    estimated_value numeric(18,4) NOT NULL DEFAULT 0,
    note          text,
    reported_by   uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid
);
CREATE INDEX IF NOT EXISTS ix_farm_loss_cycle ON farm_losses (cycle_id, loss_date);

-- §31: one button. The system reads the day and writes the report.
CREATE TABLE IF NOT EXISTS farm_day_closes (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    farm_id         uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    close_date      date NOT NULL,
    tasks_total     integer NOT NULL DEFAULT 0,
    tasks_done      integer NOT NULL DEFAULT 0,
    tasks_pending   integer NOT NULL DEFAULT 0,
    tasks_problem   integer NOT NULL DEFAULT 0,
    harvest_kg      numeric(14,3) NOT NULL DEFAULT 0,
    dispatch_kg     numeric(14,3) NOT NULL DEFAULT 0,
    expense_amount  numeric(18,4) NOT NULL DEFAULT 0,
    problems_count  integer NOT NULL DEFAULT 0,
    health          text NOT NULL DEFAULT 'GREEN'
                    CHECK (health IN ('GREEN','YELLOW','RED')),
    summary         jsonb NOT NULL DEFAULT '{}'::jsonb,
    closed_by       uuid REFERENCES users(id),
    closed_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (farm_id, close_date)
);

-- §22: staff rating is computed from what happened, never typed by a manager.
CREATE TABLE IF NOT EXISTS farm_staff_scores (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id        uuid NOT NULL REFERENCES companies(id),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start      date NOT NULL,
    period_end        date NOT NULL,
    tasks_assigned    integer NOT NULL DEFAULT 0,
    tasks_done        integer NOT NULL DEFAULT 0,
    tasks_on_time     integer NOT NULL DEFAULT 0,
    tasks_late        integer NOT NULL DEFAULT 0,
    problems_raised   integer NOT NULL DEFAULT 0,
    red_issues        integer NOT NULL DEFAULT 0,
    harvest_kg        numeric(14,3) NOT NULL DEFAULT 0,
    grade_a_pct       numeric(9,4),
    waste_pct         numeric(9,4),
    score             numeric(5,2) NOT NULL DEFAULT 0,
    rating            text NOT NULL DEFAULT 'GREEN'
                      CHECK (rating IN ('GREEN','YELLOW','RED')),
    breakdown         jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, period_start, period_end)
);

-- ============================================================================
--  SECTION F5 — INDEXES, TRIGGERS, ROW-LEVEL SECURITY
--  The 01_schema DO-blocks only saw the tables that existed then, so the new
--  tables must be wired up explicitly. Missing this is how a new module
--  silently leaks across tenants.
-- ============================================================================

DO $$
DECLARE t text; has_version boolean;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'farm_plots','farm_crops','farm_machines','farm_crop_cycles','farm_tasks',
        'farm_observations','farm_weather','farm_harvests','farm_harvest_lines',
        'farm_dispatches','farm_dispatch_lines','farm_expenses','farm_losses',
        'farm_day_closes','farm_staff_scores'
    ] LOOP
        -- updated_at / optimistic-lock trigger, matching the 01_schema split
        IF NOT EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgname = format('trg_%s_updated', t)
                          AND tgrelid = t::regclass)
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = t::regclass AND a.attname = 'updated_at'
                          AND a.attnum > 0 AND NOT a.attisdropped) THEN
            SELECT EXISTS (SELECT 1 FROM pg_attribute a
                            WHERE a.attrelid = t::regclass AND a.attname = 'version'
                              AND a.attnum > 0 AND NOT a.attisdropped) INTO has_version;
            EXECUTE format(
              'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW
                 EXECUTE FUNCTION %s()',
              t, t, CASE WHEN has_version THEN 'trg_set_updated_at' ELSE 'trg_touch_updated_at' END);
        END IF;

        -- tenant isolation, identical to the policy every other table carries
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- FORCE is deliberately NOT applied: on a managed Postgres the
        -- application connects as the table owner, and FORCE would apply the
        -- policy to it too — breaking sign-in, which must look a user up
        -- before any company is known. See 11_rls_managed_host.sql.
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = current_schema() AND tablename = t
                          AND policyname = 'tenant_isolation') THEN
            EXECUTE format(
              'CREATE POLICY tenant_isolation ON %I
                 USING (company_id IS NULL OR company_id = current_company_id())
                 WITH CHECK (company_id IS NULL OR company_id = current_company_id())', t);
        END IF;
    END LOOP;
END $$;

-- Audit history where §23 would demand it: money, stock movement and anything
-- an owner might later dispute.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'farms','farm_plots','farm_crops','farm_crop_cycles','farm_harvests',
        'farm_dispatches','farm_expenses','farm_losses','farm_machines'
    ] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgname = format('trg_%s_audit', t)
                          AND tgrelid = t::regclass) THEN
            EXECUTE format(
              'CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                 FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
        END IF;
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    farm_plots, farm_crops, farm_machines, farm_crop_cycles, farm_tasks,
    farm_observations, farm_weather, farm_harvests, farm_harvest_lines,
    farm_dispatches, farm_dispatch_lines, farm_expenses, farm_losses,
    farm_day_closes, farm_staff_scores
TO chotug_app;
GRANT SELECT ON
    farm_plots, farm_crops, farm_machines, farm_crop_cycles, farm_tasks,
    farm_observations, farm_weather, farm_harvests, farm_harvest_lines,
    farm_dispatches, farm_dispatch_lines, farm_expenses, farm_losses,
    farm_day_closes, farm_staff_scores
TO chotug_readonly;

-- ============================================================================
--  SECTION F6 — VIEWS
-- ============================================================================

-- The colour of every live crop, in one place, with the two facts that decide
-- it: is a task overdue, and is the harvest window slipping.
CREATE OR REPLACE VIEW v_farm_crop_status AS
SELECT c.id                AS cycle_id,
       c.company_id, c.branch_id, c.farm_id, c.plot_id, c.status, c.health,
       f.name              AS farm_name,
       pl.code             AS plot_code,
       fc.name             AS crop_name,
       fc.name_hi          AS crop_name_hi,
       c.cycle_no, c.product_id, c.area_acre, c.sowing_date,
       (CURRENT_DATE - c.sowing_date)                       AS crop_age_days,
       c.duration_days,
       c.expected_harvest_date,
       (c.expected_harvest_date - CURRENT_DATE)             AS days_to_harvest,
       c.expected_yield_kg, c.harvested_kg, c.waste_kg, c.dispatched_kg,
       c.estimated_cost, c.actual_cost, c.revenue,
       CASE WHEN c.harvested_kg > 0
            THEN round(c.actual_cost / c.harvested_kg, 4) END AS cost_per_kg,
       (SELECT count(*) FROM farm_tasks t
         WHERE t.cycle_id = c.id AND t.status = 'PENDING'
           AND t.due_date < CURRENT_DATE)                   AS overdue_tasks,
       (SELECT count(*) FROM farm_tasks t
         WHERE t.cycle_id = c.id AND t.status = 'PENDING'
           AND t.due_date = CURRENT_DATE)                   AS today_tasks,
       (SELECT count(*) FROM farm_tasks t
         WHERE t.cycle_id = c.id AND t.status = 'PROBLEM')  AS open_problems
  FROM farm_crop_cycles c
  JOIN farms       f  ON f.id  = c.farm_id
  JOIN farm_plots  pl ON pl.id = c.plot_id
  JOIN farm_crops  fc ON fc.id = c.crop_id;

-- §24 — the seven-day harvest forecast that lets sales and the warehouse
-- prepare instead of react. Actual harvest replaces the estimate as it lands.
CREATE OR REPLACE VIEW v_farm_harvest_forecast AS
SELECT c.company_id,
       c.product_id,
       p.name AS product_name,
       p.sku,
       d.day::date AS harvest_date,
       SUM(
         GREATEST(c.expected_yield_kg - c.harvested_kg, 0)
         / GREATEST((c.expected_harvest_end_date - c.expected_harvest_date) + 1, 1)
       ) AS expected_kg
  FROM farm_crop_cycles c
  JOIN products p ON p.id = c.product_id
  CROSS JOIN LATERAL generate_series(
        GREATEST(c.expected_harvest_date, CURRENT_DATE),
        c.expected_harvest_end_date, interval '1 day') AS d(day)
 WHERE c.status IN ('GROWING','HARVESTING')
   AND c.product_id IS NOT NULL
   AND d.day::date <= CURRENT_DATE + 30
 GROUP BY c.company_id, c.product_id, p.name, p.sku, d.day::date;

-- §28 — seed to sale. One row per farm batch, joinable straight onto the
-- existing stock ledger, so a complaint on a crate reaches the plot and sowing.
CREATE OR REPLACE VIEW v_farm_traceability AS
SELECT b.id              AS batch_id,
       b.company_id, b.batch_no, b.grade, b.product_id,
       p.name            AS product_name,
       f.id              AS farm_id,
       f.name            AS farm_name,
       pl.code           AS plot_code,
       fc.name           AS crop_name,
       c.cycle_no, c.sowing_date, c.area_acre,
       h.harvest_no, h.harvest_date, h.crop_age_days,
       dl.grade          AS dispatch_grade,
       d.dispatch_no, d.dispatch_date, d.received_at,
       dl.dispatch_weight_kg, dl.received_weight_kg,
       b.landed_rate_per_kg,
       COALESCE(sb.qty, 0) AS remaining_qty
  FROM farm_dispatch_lines dl
  JOIN farm_dispatches  d  ON d.id  = dl.dispatch_id
  JOIN farm_harvests    h  ON h.id  = dl.harvest_id
  JOIN farm_crop_cycles c  ON c.id  = dl.cycle_id
  JOIN farm_crops       fc ON fc.id = c.crop_id
  JOIN farm_plots       pl ON pl.id = c.plot_id
  JOIN farms            f  ON f.id  = c.farm_id
  JOIN batches          b  ON b.id  = dl.batch_id
  JOIN products         p  ON p.id  = b.product_id
  LEFT JOIN stock_balances sb ON sb.batch_id = b.id
 WHERE dl.batch_id IS NOT NULL;

-- ============================================================================
--  SECTION F7 — PERMISSIONS, ROLES, NUMBERING, SETTINGS
-- ============================================================================

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('farming.farm.manage',      'farming','farm',    'manage', 'Add and edit farms, plots and machines', false,'SENSITIVE'),
 ('farming.crop.start',       'farming','crop',    'start',  'Start a crop cycle',                     false,'NORMAL'),
 ('farming.crop.close',       'farming','crop',    'close',  'Close a crop and plan the next one',     false,'SENSITIVE'),
 ('farming.task.complete',    'farming','task',    'complete','Mark a farm task done / problem / skip',false,'NORMAL'),
 ('farming.harvest.record',   'farming','harvest', 'record', 'Record a harvest with weight and grade', false,'NORMAL'),
 ('farming.dispatch.create',  'farming','dispatch','create', 'Send harvested produce to a warehouse',  false,'NORMAL'),
 ('farming.dispatch.receive', 'farming','dispatch','receive','Receive a farm dispatch into stock',     false,'CRITICAL'),
 ('farming.expense.create',   'farming','expense', 'create', 'Record a farm expense',                  false,'NORMAL'),
 ('farming.loss.record',      'farming','loss',    'record', 'Record a crop loss',                     false,'SENSITIVE'),
 ('farming.cost.view',        'farming','cost',    'view',   'See crop cost per kg and farm profit',   true, 'SENSITIVE'),
 ('farming.report.view',      'farming','report',  'view',   'View farm dashboard and reports',        false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

-- Two new system roles. The field worker gets the smallest possible set: he
-- reports what he did and what went wrong, and nothing else.
INSERT INTO roles (company_id, code, name, name_hi, is_system)
SELECT c.id, v.code, v.name, v.name_hi, true
  FROM companies c
  CROSS JOIN (VALUES
    ('FARM_MGR',   'Farm Manager',  'फार्म प्रबंधक'),
    ('FARM_STAFF', 'Farm Staff',    'फार्म कर्मचारी')
  ) AS v(code, name, name_hi)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO role_limits (role_id, max_approval_level, max_backdate_days)
SELECT r.id, CASE r.code WHEN 'FARM_MGR' THEN 2 ELSE 0 END,
             CASE r.code WHEN 'FARM_MGR' THEN 3 ELSE 1 END
  FROM roles r WHERE r.code IN ('FARM_MGR','FARM_STAFF')
ON CONFLICT (role_id) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'FARM_STAFF', ARRAY[
            'farming.task.complete','farming.harvest.record',
            'farming.dispatch.create','farming.expense.create','farming.loss.record']);
        PERFORM grant_role_perms(c.id, 'FARM_MGR', ARRAY[
            'farming.farm.manage','farming.crop.start','farming.crop.close',
            'farming.task.complete','farming.harvest.record','farming.dispatch.create',
            'farming.expense.create','farming.loss.record','farming.cost.view',
            'farming.report.view','reports.purchase.view','data.cost.view']);
        -- Warehouse receives the farm's lorry the same way it receives a supplier's.
        PERFORM grant_role_perms(c.id, 'WH_EXEC',  ARRAY['farming.dispatch.receive','farming.report.view']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_EXEC', ARRAY['farming.report.view']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR',  ARRAY['farming.report.view','farming.cost.view']);
        -- Owner holds everything, including permissions added after bootstrap.
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
         WHERE r.company_id = c.id AND r.code = 'OWNER'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- Numbering for the farming documents, for every branch that already exists.
INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, t.doc_type, fy.fy, t.prefix, 1, 6
  FROM branches b
  CROSS JOIN (VALUES ('CROP','CROP'),('HARV','HRV'),('FDN','FDN')) AS t(doc_type, prefix)
  CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

-- Operating thresholds, all owner-editable on the existing settings screen.
INSERT INTO settings (company_id, scope, key, value, data_type)
SELECT c.id, 'COMPANY', v.k, v.val::jsonb, v.dt
  FROM companies c CROSS JOIN (VALUES
    ('farming.dispatch_variance_warn_pct', '1',   'number'),
    ('farming.dispatch_variance_crit_pct', '3',   'number'),
    ('farming.harvest_alert_days',         '3',   'number'),
    ('farming.harvest_delay_grace_days',   '2',   'number'),
    ('farming.rain_hold_mm',               '5',   'number'),
    ('farming.rain_hold_prob_pct',         '60',  'number'),
    ('farming.spray_wind_kmph',            '20',  'number'),
    ('farming.heat_alert_c',               '38',  'number'),
    ('farming.frost_alert_c',              '6',   'number'),
    ('farming.yield_shortfall_warn_pct',   '10',  'number'),
    ('farming.task_sla_minutes',           '600', 'number')
  ) AS v(k, val, dt)
ON CONFLICT (company_id, branch_id, key) DO NOTHING;

-- Alert rules so the farming alerts land in the same panel as everything else.
INSERT INTO alert_rules (company_id, alert_type, is_enabled, severity, threshold, channels, sla_minutes, dedupe_window_minutes)
SELECT c.id, v.t, true, v.s, v.th::jsonb, ARRAY['IN_APP'], v.sla, 180
  FROM companies c CROSS JOIN (VALUES
    ('CROP_HEALTH_RED',       'CRITICAL','{"health":"RED"}',            60),
    ('CROP_HEALTH_YELLOW',    'MEDIUM',  '{"health":"YELLOW"}',        360),
    ('FARM_TASK_OVERDUE',     'MEDIUM',  '{"grace_days":1}',           360),
    ('HARVEST_DUE',           'MEDIUM',  '{"days_before":3}',          720),
    ('HARVEST_DELAYED',       'HIGH',    '{"grace_days":2}',           360),
    ('FARM_WEATHER_RISK',     'MEDIUM',  '{}',                         360),
    ('FARM_DISPATCH_VARIANCE','HIGH',    '{"tolerance_pct":3}',         60),
    ('YIELD_BELOW_EXPECTED',  'MEDIUM',  '{"shortfall_pct":10}',       720),
    ('MACHINE_BREAKDOWN',     'HIGH',    '{}',                         120)
  ) AS v(t, s, th, sla)
WHERE NOT EXISTS (SELECT 1 FROM alert_rules a WHERE a.company_id = c.id AND a.alert_type = v.t);

-- ---------------------------------------------------------------------------
--  bootstrap_company(): keep new tenants in step with what we just did to the
--  existing one, so a fresh company is not silently missing the farm roles.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bootstrap_farming(p_company uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role_id uuid; r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('FARM_MGR','Farm Manager','फार्म प्रबंधक',2,3),
        ('FARM_STAFF','Farm Staff','फार्म कर्मचारी',0,1)
    ) AS t(code, name, name_hi, lvl, backdate) LOOP
        INSERT INTO roles (company_id, code, name, name_hi, is_system)
        VALUES (p_company, r.code, r.name, r.name_hi, true)
        ON CONFLICT (company_id, code) DO NOTHING RETURNING id INTO v_role_id;
        IF v_role_id IS NULL THEN
            SELECT id INTO v_role_id FROM roles WHERE company_id = p_company AND code = r.code;
        END IF;
        INSERT INTO role_limits (role_id, max_approval_level, max_backdate_days)
        VALUES (v_role_id, r.lvl, r.backdate) ON CONFLICT (role_id) DO NOTHING;
    END LOOP;

    PERFORM grant_role_perms(p_company, 'FARM_STAFF', ARRAY[
        'farming.task.complete','farming.harvest.record',
        'farming.dispatch.create','farming.expense.create','farming.loss.record']);
    PERFORM grant_role_perms(p_company, 'FARM_MGR', ARRAY[
        'farming.farm.manage','farming.crop.start','farming.crop.close',
        'farming.task.complete','farming.harvest.record','farming.dispatch.create',
        'farming.expense.create','farming.loss.record','farming.cost.view',
        'farming.report.view','reports.purchase.view','data.cost.view']);
    PERFORM grant_role_perms(p_company, 'WH_EXEC', ARRAY['farming.dispatch.receive','farming.report.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_EXEC', ARRAY['farming.report.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_MGR',  ARRAY['farming.report.view','farming.cost.view']);

    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
     WHERE r.company_id = p_company AND r.code = 'OWNER'
    ON CONFLICT DO NOTHING;

    INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
    SELECT b.company_id, b.id, t.doc_type, fy.fy, t.prefix, 1, 6
      FROM branches b
      CROSS JOIN (VALUES ('CROP','CROP'),('HARV','HRV'),('FDN','FDN')) AS t(doc_type, prefix)
      CROSS JOIN (SELECT DISTINCT fy FROM number_series WHERE company_id = p_company) AS fy
     WHERE b.company_id = p_company
    ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;
END $$;

COMMENT ON FUNCTION bootstrap_farming IS
  'Call after bootstrap_company() for a new tenant: farm roles, permissions and numbering.';

COMMIT;
