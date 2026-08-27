-- ============================================================================
-- 40 · CUSTOM PAYMENT METHODS
--
-- Finance keeps the common methods in the UI, but the business may pay through
-- a wallet, demand draft, RTGS or another method. The method is still recorded
-- as text on the payment evidence; this removes only the old fixed enum check.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_mode_check;

COMMIT;