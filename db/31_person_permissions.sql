-- =============================================================================
-- 31 · WHAT ONE PERSON SEES, NOT JUST WHAT THEIR JOB SEES
--
--   "what each panel see should be totally controllable by the admin, admin
--    should be able to give extra permissions or remove some permissions from a
--    panel of a person, for example there are two purchase executives, admin
--    can set different things on their panels … person centric will override
--    position and can be reset also."
--
-- Roles stay the default and stay the sane thing to manage — twelve roles
-- rather than sixty people. What is added is a per-person layer on top:
--
--     what they see  =  (their roles' permissions  +  their GRANTs)  −  their REVOKEs
--
-- Every override carries a reason and who set it, because "why can Sunil
-- approve orders and Ganesh cannot" is a question that gets asked six months
-- later, usually by an auditor. Resetting a person is deleting their rows,
-- which is why this is a separate table and not a column on users.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS user_permission_overrides (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    effect          text NOT NULL CHECK (effect IN ('GRANT','REVOKE')),
    reason          text NOT NULL,
    -- A temporary grant for somebody covering a colleague's leave should expire
    -- on its own. A permission that outlives its reason is how access creeps.
    expires_on      date,
    granted_by      uuid NOT NULL REFERENCES users(id),
    granted_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_perm UNIQUE (user_id, permission_code)
);

-- No partial index on the expiry: CURRENT_DATE is not immutable, so it cannot
-- appear in a predicate. The expiry is filtered at read time instead.
CREATE INDEX IF NOT EXISTS ix_user_perm ON user_permission_overrides (user_id, expires_on);

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY user_permission_overrides_rls ON user_permission_overrides
    USING (company_id = current_setting('app.company_id', true)::uuid)
    WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* The resolved answer, in one place. Any screen that wants to know what a
 * person can do reads this rather than repeating the three-way arithmetic and
 * getting the precedence subtly wrong. */
CREATE OR REPLACE VIEW v_user_permissions AS
WITH from_roles AS (
    SELECT u.id AS user_id, u.company_id, rp.permission_code
      FROM users u
      JOIN user_role_assignments ura ON ura.user_id = u.id
       AND ura.valid_from <= CURRENT_DATE
       AND (ura.valid_to IS NULL OR ura.valid_to >= CURRENT_DATE)
      JOIN role_permissions rp ON rp.role_id = ura.role_id
), live AS (
    SELECT * FROM user_permission_overrides
     WHERE expires_on IS NULL OR expires_on >= CURRENT_DATE
)
SELECT p.user_id, p.company_id, p.permission_code, p.source
  FROM (
    SELECT fr.user_id, fr.company_id, fr.permission_code, 'ROLE'::text AS source
      FROM from_roles fr
     WHERE NOT EXISTS (SELECT 1 FROM live o
                        WHERE o.user_id = fr.user_id
                          AND o.permission_code = fr.permission_code
                          AND o.effect = 'REVOKE')
    UNION
    SELECT o.user_id, o.company_id, o.permission_code, 'GRANTED'
      FROM live o WHERE o.effect = 'GRANT'
  ) p;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES ('admin.permission.override','admin','permission','override',
        'Give or take away one permission from one person', false,'CRITICAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER', ARRAY['admin.permission.override']);
    END LOOP;
END $$;

COMMIT;
