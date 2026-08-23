-- =============================================================================
-- 34 · THE COMPANY'S OWN UPI CODE
--
--   "admin should be able to set particular upi code from his panel so centres
--    may print that, or keep their own code for online payment at their shop."
--
-- Two levels, and the order matters: a centre's own code wins where it has one,
-- and the company's is what everyone else prints. Only having the per-centre
-- one — which is what was built first — meant a new shop had nothing to print
-- until somebody remembered to set it.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS upi_id         text,
  ADD COLUMN IF NOT EXISTS upi_payee_name text;

/* What a given place should actually print. One definition, so the centre
 * screen, the label and the receipt cannot each pick a different code. */
CREATE OR REPLACE VIEW v_effective_upi AS
SELECT w.id            AS warehouse_id,
       w.company_id,
       w.name          AS place_name,
       COALESCE(NULLIF(w.upi_id, ''), c.upi_id)                 AS upi_id,
       COALESCE(NULLIF(w.upi_payee_name, ''), c.upi_payee_name,
                c.trade_name)                                   AS payee_name,
       (NULLIF(w.upi_id, '') IS NOT NULL)                       AS is_own_code
  FROM warehouses w
  JOIN companies c ON c.id = w.company_id;

COMMIT;
