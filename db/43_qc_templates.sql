-- =============================================================================
-- 39 · THE QUALITY CHECKLIST IS EDITABLE
--
-- qc_templates and qc_parameters have always driven the inspection screen, and
-- there has never been a way to change them: three templates arrived with the
-- seed, `GET /masters/qc-templates` read them, and nothing wrote. A product
-- added today inherits its category's default or gets nothing at all, and the
-- checklist the floor works to could only be changed in SQL.
--
-- quality.template.manage already existed and was held by OWNER and QC_HEAD
-- and used by no endpoint. The QC executives who actually run the checks
-- should be able to fix a checklist they are working to, so they get it too.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Which template a version came from, so "what did this look like before" is a
-- question the data can answer. A used template is never edited in place —
-- qc_results.parameter_id points at the parameters that were scored, and a
-- past inspection has to keep meaning what it meant.
ALTER TABLE qc_templates
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES qc_templates(id),
  ADD COLUMN IF NOT EXISTS retired_at    timestamptz,
  ADD COLUMN IF NOT EXISTS note          text,
  -- The version a person sees. NOT `version`, which looks like it means this
  -- and does not: trg_set_updated_at bumps that on every UPDATE as an
  -- optimistic-locking counter. Retiring v1 therefore moved its `version` to
  -- 2 and collided with the v2 being inserted beside it — the unique index
  -- below was on the lock counter, so superseding a template was impossible.
  ADD COLUMN IF NOT EXISTS template_version smallint NOT NULL DEFAULT 1;

UPDATE qc_templates SET template_version = 1 WHERE template_version IS NULL;

-- One row per code per human version. The old index counted lock bumps.
ALTER TABLE qc_templates DROP CONSTRAINT IF EXISTS qc_templates_company_id_code_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_template_version
    ON qc_templates (company_id, code, template_version);

-- And only one of them live at a time, which is the rule that actually matters
-- when the inspection screen asks "which checklist for this product".
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_template_live
    ON qc_templates (company_id, code) WHERE is_active;

-- A product without a checklist gets inspected against nothing. Not enforced
-- as a constraint — a product can legitimately exist before anybody has
-- decided how to check it — but the screen shows it, so it can be fixed.
CREATE INDEX IF NOT EXISTS ix_products_no_qc_template
    ON products (company_id) WHERE qc_template_id IS NULL AND is_active;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        -- The people running the checks can fix the checklist they run.
        PERFORM grant_role_perms(c.id, 'QC_EXEC',  ARRAY['quality.template.manage']);
        PERFORM grant_role_perms(c.id, 'QC_HEAD',  ARRAY['quality.template.manage']);
        PERFORM grant_role_perms(c.id, 'OWNER',    ARRAY['quality.template.manage']);
    END LOOP;
END $$;

COMMIT;
