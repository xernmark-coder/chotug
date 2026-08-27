-- ============================================================================
-- 39 - Optional arrival document defaults
--
-- Supplier-provided mandi patti numbers travel with the invoice lookup.
-- Registered vehicles may carry a default seal number for gate prefill.
-- Both are optional: NULL means the gate leaves the field blank.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE expected_arrivals
  ADD COLUMN IF NOT EXISTS mandi_patti_no text;

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS default_seal_no text;

COMMIT;
