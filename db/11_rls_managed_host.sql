-- ===========================================================================
--  11 — ROW-LEVEL SECURITY ON A MANAGED POSTGRES
--
--  The schema puts ENABLE + FORCE row level security on every tenant table.
--  FORCE is the part that applies the policy to the table's OWNER as well as
--  to everybody else — and on a managed host (Render, Neon, RDS) the
--  application connects AS the owner, because that is the only role such a
--  host gives you.
--
--  The result, measured on a real Render database before this file existed:
--
--      SELECT count(*) FROM users;            -- 0 rows, no tenant context
--      SET app.company_id = '…'; SELECT …;    -- 7 rows
--
--  Every request the API makes through withTx() sets app.company_id and works
--  fine. The handful that CANNOT know a company yet are the ones that break:
--
--    · signing in — looking a user up by email is what discovers the company
--    · opening an invite link — the visitor has no account yet
--
--  With FORCE on, those return zero rows and every login fails with
--  "Email or password is not correct". Nothing in the logs says why.
--
--  So: keep ENABLE, drop FORCE.
--
--  What that preserves: the policies stay, and every role that is NOT the
--  owner — chotug_app and chotug_readonly, the reporting logins this schema
--  was written to constrain — is still fully tenant-isolated.
--
--  What it gives up: RLS as a backstop against a bug in our own code that
--  forgets to filter by company. The application still filters by company_id
--  in SQL on every query, and still sets the GUC on every write, so this is a
--  second line of defence rather than the first.
--
--  If you would rather keep FORCE, the alternative is to add a permissive
--  policy per pre-auth table allowing access when app.company_id is unset —
--  stricter in normal traffic, but it opens the same hole on exactly the code
--  paths that forget to set the context. Ask before switching; it is a real
--  trade-off, not an oversight.
--
--  MUST RUN LAST. 04_farming.sql and 06_stock_issue.sql re-apply FORCE to the
--  tables they touch on every migration, so this file has to come after them
--  to undo it each time.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

DO $$
DECLARE
    t   text;
    n   int := 0;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n2 ON n2.oid = c.relnamespace
         -- 'p' as well as 'r': audit_log is PARTITIONED, and a loop that only
         -- matched ordinary tables left it FORCEd. audit_log carries no policy
         -- at all (it is excluded from tenant isolation by design), so RLS on
         -- it denies every write — including the audit trigger's own INSERT,
         -- which fires on nearly every statement the migration runs.
         WHERE c.relkind IN ('r', 'p')
           AND n2.nspname = current_schema()
           AND c.relforcerowsecurity
    LOOP
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
        n := n + 1;
    END LOOP;
    RAISE NOTICE 'RLS: FORCE lifted on % table(s); policies and ENABLE left in place.', n;
END $$;

COMMIT;
