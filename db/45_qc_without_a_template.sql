-- =============================================================================
-- 45 · A QUALITY CHECK WITHOUT A CHECKLIST
--
-- qc_inspections.template_id was NOT NULL, and the plan endpoint refused
-- outright when a product had no checklist. So a lorry carrying a product
-- nobody had set one up for could not be inspected at all: the screen offered
-- "Save inspection", the save reached for plan.template and fell over with
-- «can't access property "template", plan is null», and the goods stood at the
-- gate.
--
-- The checklist is the finer judgement — bruising, stem rot, size. The
-- essential record is the decision: this much arrived, this much we accept,
-- this much we send back. That has to be possible whether or not anybody has
-- written the questions yet, or a product added this morning stops the yard.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE qc_inspections
  ALTER COLUMN template_id      DROP NOT NULL,
  ALTER COLUMN template_version DROP NOT NULL;

-- An inspection with no checklist has no score to give: a score computed from
-- no questions is 100% of nothing, and would read as a clean pass on a screen
-- that ranks suppliers by it. Better to record no score than a flattering one.
DO $$ BEGIN
  ALTER TABLE qc_inspections ADD CONSTRAINT ck_qc_scored_only_with_template
    CHECK (template_id IS NOT NULL OR quality_score IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN qc_inspections.template_id IS
  'The checklist used, or NULL where the product has none — the decision is '
  'still recorded. See db/45.';

COMMIT;
