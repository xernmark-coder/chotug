-- =============================================================================
-- 33 · THE PEOPLE WHO DO THE WORK
--
--   "one hr panel, from hr panel they will keep track of every person working
--    in their center, their wages, everything about them such as leave they are
--    taking, their working hours and performances of the workers and bonuses
--    given to them."
--
-- Wages already reach Finance — a WAGES payment request is paid like any other.
-- What was missing is the person behind the payment: who they are, where they
-- work, whether they turned up, and what the month adds up to.
--
-- A worker is deliberately NOT a user. Most of the people being paid here —
-- loaders, packers, cleaners — will never log in, and requiring an account to
-- be paid is how half the workforce ends up off the books. Where somebody does
-- have a login, `user_id` links the two.
--
-- Attendance is one row per person per day, because that is how it is taken:
-- somebody walks the floor in the morning. Marking it twice corrects it.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS workers (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    -- Which warehouse or centre they turn up to.
    warehouse_id   uuid REFERENCES warehouses(id),
    user_id        uuid REFERENCES users(id),

    code           text NOT NULL,
    full_name      text NOT NULL,
    phone          text,
    designation    text,
    employment     text NOT NULL DEFAULT 'DAILY'
                   CHECK (employment IN ('PERMANENT','DAILY','CONTRACT','SEASONAL')),

    wage_type      text NOT NULL DEFAULT 'DAILY'
                   CHECK (wage_type IN ('MONTHLY','DAILY','HOURLY','PIECE')),
    wage_rate      numeric(14,2) NOT NULL DEFAULT 0 CHECK (wage_rate >= 0),
    -- Paid on top of the day rate, per hour, for hours beyond the standard day.
    overtime_rate  numeric(14,2),
    standard_hours numeric(5,2) NOT NULL DEFAULT 8,

    joined_on      date,
    left_on        date,
    id_proof       text,
    address        text,
    note           text,
    is_active      boolean NOT NULL DEFAULT true,

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES users(id),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES users(id),
    version        int NOT NULL DEFAULT 1,
    CONSTRAINT uq_worker_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS ix_worker_place ON workers (company_id, warehouse_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS worker_attendance (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    worker_id      uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    on_date        date NOT NULL,
    status         text NOT NULL DEFAULT 'PRESENT'
                   CHECK (status IN ('PRESENT','HALF_DAY','ABSENT','LEAVE','WEEKLY_OFF','HOLIDAY')),
    hours          numeric(5,2),
    overtime_hours numeric(5,2) NOT NULL DEFAULT 0,
    -- Paid leave is an absence the business still pays for; unpaid is not. The
    -- distinction is the whole reason leave is tracked rather than just counted.
    is_paid_leave  boolean NOT NULL DEFAULT false,
    note           text,
    marked_by      uuid NOT NULL REFERENCES users(id),
    marked_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_attendance UNIQUE (worker_id, on_date)
);

CREATE INDEX IF NOT EXISTS ix_attendance_day ON worker_attendance (company_id, on_date);

/* A month's pay, worked out from the attendance rather than typed, then sent
 * to Finance as an ordinary payment request. Finance verifies and pays it the
 * same way they pay a supplier — one place money leaves from. */
CREATE TABLE IF NOT EXISTS wage_runs (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    worker_id      uuid NOT NULL REFERENCES workers(id),
    period_start   date NOT NULL,
    period_end     date NOT NULL,

    days_present   numeric(6,2) NOT NULL DEFAULT 0,
    days_absent    numeric(6,2) NOT NULL DEFAULT 0,
    days_leave     numeric(6,2) NOT NULL DEFAULT 0,
    hours_worked   numeric(8,2) NOT NULL DEFAULT 0,
    overtime_hours numeric(8,2) NOT NULL DEFAULT 0,

    base_amount    numeric(14,2) NOT NULL DEFAULT 0,
    overtime_amount numeric(14,2) NOT NULL DEFAULT 0,
    bonus_amount   numeric(14,2) NOT NULL DEFAULT 0,
    bonus_reason   text,
    deductions     numeric(14,2) NOT NULL DEFAULT 0,
    deduction_reason text,
    net_amount     numeric(14,2) NOT NULL DEFAULT 0,
    CONSTRAINT ck_wage_bonus CHECK (bonus_amount = 0 OR bonus_reason IS NOT NULL),
    CONSTRAINT ck_wage_deduction CHECK (deductions = 0 OR deduction_reason IS NOT NULL),

    note           text,
    request_id     uuid REFERENCES payment_requests(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES users(id),
    CONSTRAINT uq_wage_period UNIQUE (worker_id, period_start, period_end)
);

ALTER TABLE workers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE wage_runs         ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY workers_rls ON workers
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY worker_attendance_rls ON worker_attendance
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY wage_runs_rls ON wage_runs
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* "Performance of the workers" — measured, not rated. Boxes weighed off the
 * lorry and boxes graded at the bench are already recorded against whoever did
 * them; a worker linked to a login inherits their own count. A number somebody
 * earned beats a star rating somebody gave them. */
CREATE OR REPLACE VIEW v_worker_output AS
SELECT w.id AS worker_id, w.company_id,
       COALESCE(b.boxes, 0)::int   AS boxes_weighed,
       COALESCE(b.kg, 0)           AS kg_weighed,
       COALESCE(p.packs, 0)::int   AS boxes_packed,
       COALESCE(a.counts, 0)::int  AS audits_done
  FROM workers w
  LEFT JOIN (SELECT weighed_by, count(*) AS boxes, SUM(weight_kg) AS kg
               FROM unload_boxes WHERE voided_at IS NULL
                AND weighed_at > now() - interval '30 days'
              GROUP BY weighed_by) b ON b.weighed_by = w.user_id
  LEFT JOIN (SELECT graded_by, count(*) AS packs FROM packs
              WHERE graded_by IS NOT NULL AND graded_at > now() - interval '30 days'
              GROUP BY graded_by) p ON p.graded_by = w.user_id
  LEFT JOIN (SELECT counted_by, count(*) AS counts FROM audit_counts
              WHERE counted_at > now() - interval '30 days'
              GROUP BY counted_by) a ON a.counted_by = w.user_id;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('hr.worker.manage','hr','worker','manage','Add and edit the people who work here', false,'NORMAL'),
 ('hr.attendance.mark','hr','attendance','mark','Mark who turned up today', false,'NORMAL'),
 ('hr.wages.run','hr','wages','run','Work out a period''s wages and send them to Finance', false,'SENSITIVE'),
 ('hr.report.view','hr','report','view','See attendance, wages and worker output', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (id, company_id, code, name, description, is_system)
SELECT uuid_generate_v7(), c.id, 'HR_EXEC', 'HR',
       'Keeps the people records: who works here, who turned up, what they are owed.', false
  FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.code = 'HR_EXEC');

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'HR_EXEC', ARRAY[
            'hr.worker.manage','hr.attendance.mark','hr.wages.run','hr.report.view',
            'finance.request.create']);
        PERFORM grant_role_perms(c.id, 'OWNER', ARRAY[
            'hr.worker.manage','hr.attendance.mark','hr.wages.run','hr.report.view']);
        -- The person running a warehouse or a shop is the one who knows who
        -- turned up; making them ask HR to record it is how attendance stops
        -- being taken at all.
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['hr.attendance.mark','hr.report.view']);
        PERFORM grant_role_perms(c.id, 'CENTRE_EXEC',  ARRAY['hr.attendance.mark','hr.report.view']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['hr.report.view']);
    END LOOP;
END $$;

COMMIT;
