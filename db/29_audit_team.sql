-- =============================================================================
-- 29 · THE AUDIT TEAM
--
--   "there will be one audit team interface, also from that everything will be
--    recorded such as who, how, when, how much audit it done everything. they
--    will record how much loss or status of any product during audit. and this
--    audit team will get message to audit particular stock or product."
--
-- Two tables, because an audit is two different facts:
--
--   audit_tasks   — somebody was ASKED to go and look. Who asked, why, by when.
--   audit_counts  — what was FOUND. One row per shelf-and-product actually
--                   counted, with the book figure captured at the moment of
--                   counting so the variance cannot drift afterwards.
--
-- Keeping them apart matters: an audit that finds nothing wrong is still work
-- that was done, and a shelf nobody was asked to check but somebody counted
-- anyway is still a finding.
--
-- Nothing here moves stock. An audit reports; correcting the books is a stock
-- adjustment, made deliberately by somebody with that right, against the
-- finding. An audit that silently rewrote the ledger would be the easiest
-- theft in the building.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS audit_tasks (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    warehouse_id  uuid          REFERENCES warehouses(id),
    task_no       text NOT NULL,

    -- What to go and look at. Any one of these, or the whole warehouse.
    scope         text NOT NULL DEFAULT 'WAREHOUSE'
                  CHECK (scope IN ('WAREHOUSE','FLOOR','SECTION','RACK','SHELF','PRODUCT','BATCH')),
    scope_id      uuid,
    product_id    uuid REFERENCES products(id),

    reason        text NOT NULL,
    priority      text NOT NULL DEFAULT 'NORMAL'
                  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    due_date      date,

    status        text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
    -- Filled in when the auditor closes it, in their own words.
    findings      text,
    CONSTRAINT ck_audit_done CHECK (status <> 'DONE' OR findings IS NOT NULL),

    assigned_to   uuid REFERENCES users(id),
    raised_by     uuid NOT NULL REFERENCES users(id),
    raised_at     timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    completed_at  timestamptz,
    completed_by  uuid REFERENCES users(id),

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid REFERENCES users(id),
    version       int NOT NULL DEFAULT 1,
    CONSTRAINT uq_audit_task_no UNIQUE (company_id, task_no)
);

CREATE TABLE IF NOT EXISTS audit_counts (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    task_id       uuid REFERENCES audit_tasks(id) ON DELETE SET NULL,
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id),

    -- Where they were standing. Recorded as the scanned code as well as the id,
    -- because the label is the evidence they were actually there.
    bin_id        uuid REFERENCES bins(id),
    scanned_qr    text,

    product_id    uuid NOT NULL REFERENCES products(id),
    batch_id      uuid REFERENCES batches(id),

    /* The book figure AT THE MOMENT OF COUNTING. Recomputing it later would
     * make yesterday's variance change every time stock moved. */
    expected_qty  numeric(14,3) NOT NULL DEFAULT 0,
    counted_qty   numeric(14,3) NOT NULL CHECK (counted_qty >= 0),
    variance_qty  numeric(14,3) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,

    -- What state it was in, which is half the point of walking the floor.
    condition     text NOT NULL DEFAULT 'GOOD'
                  CHECK (condition IN ('GOOD','DAMAGED','SPOILED','EXPIRED','MISSING','MISPLACED')),
    loss_qty      numeric(14,3) NOT NULL DEFAULT 0 CHECK (loss_qty >= 0),
    loss_value    numeric(14,2),
    note          text,
    CONSTRAINT ck_audit_note CHECK (
        (condition = 'GOOD' AND loss_qty = 0) OR note IS NOT NULL),

    photo_key     text,
    counted_by    uuid NOT NULL REFERENCES users(id),
    counted_at    timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_audit_task_open
    ON audit_tasks (company_id, status, due_date) WHERE status IN ('OPEN','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS ix_audit_count_task    ON audit_counts (task_id);
CREATE INDEX IF NOT EXISTS ix_audit_count_product ON audit_counts (company_id, product_id, counted_at);
CREATE INDEX IF NOT EXISTS ix_audit_count_bin     ON audit_counts (bin_id, counted_at);

ALTER TABLE audit_tasks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_counts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY audit_tasks_rls ON audit_tasks
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY audit_counts_rls ON audit_counts
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('audit.task.raise','audit','task','raise',
  'Ask the audit team to check a shelf, product or warehouse', false,'NORMAL'),
 ('audit.count.record','audit','count','record',
  'Record what was actually found on a shelf', false,'NORMAL'),
 ('audit.report.view','audit','report','view',
  'See audit history, variances and losses', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

-- The audit team is a role, not a person. It must be able to see stock and
-- scan locations, and nothing else — an auditor who can adjust the books is
-- not an auditor.
INSERT INTO roles (id, company_id, code, name, description, is_system)
SELECT uuid_generate_v7(), c.id, 'AUDITOR', 'Audit team',
       'Counts stock, records losses and reports. Cannot move or adjust stock.', false
  FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.code = 'AUDITOR');

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'AUDITOR', ARRAY[
            'audit.count.record','audit.report.view','audit.task.raise',
            'reports.purchase.view']);
        PERFORM grant_role_perms(c.id, 'OWNER', ARRAY[
            'audit.task.raise','audit.count.record','audit.report.view']);
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['audit.task.raise','audit.report.view']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['audit.task.raise','audit.report.view']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['audit.report.view']);
    END LOOP;
END $$;

-- AUD document numbers, alongside PO / GRN / PAY and the rest.
--
-- The check is rebuilt as the union of what is needed and what is already in
-- use. Several earlier migrations each rewrote this list from scratch, and
-- re-running an old one silently revoked a doc type a later one had added.
DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['AUD']) AS t
        UNION SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

-- The prefix is the document type alone: next_doc_no() adds the financial year
-- and the counter. Putting the year in here too produced AUD/2026-27//2026-27/2.
INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, 'AUD', fy.fy, 'AUD', 1, 6
  FROM branches b
  CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

-- Repair any series created before that was noticed.
UPDATE number_series SET prefix = 'AUD' WHERE doc_type = 'AUD' AND prefix <> 'AUD';

COMMIT;
