-- =============================================================================
-- 25 · THE INVOICE AND THE VEHICLE ARE ENTERED ONCE, BY THE PERSON WHO KNOWS
--
--   "when purchase is confirmed the invoice and vehical are entered by the
--    supplier panel … also when the vehical come at gate they will only enter
--    this invoice number and get the entry, by invoice number the vehical
--    driver and other details of vehical will be autofilled as entered by
--    supplier, the gate person will edit that details if necessary."
--
-- The gate clerk currently retypes the lorry number, the driver's name and his
-- phone number off a piece of paper, in the rain, with the driver waiting. Every
-- one of those facts was already known by the supplier days earlier. So the
-- supplier records them once when they accept the order, and the gate types the
-- invoice number and corrects whatever is wrong.
--
-- The expected arrival is the natural home for them: it already exists from the
-- moment we confirm the order, and it is the row the gate reads.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE expected_arrivals
  ADD COLUMN IF NOT EXISTS supplier_invoice_no text,
  ADD COLUMN IF NOT EXISTS driver_name         text,
  ADD COLUMN IF NOT EXISTS driver_phone        text,
  ADD COLUMN IF NOT EXISTS transporter         text,
  ADD COLUMN IF NOT EXISTS lr_no               text,
  ADD COLUMN IF NOT EXISTS eway_bill_no        text;

-- The gate's whole interaction is "type this number, get the vehicle". That
-- lookup must not be a sequential scan over every arrival we have ever had.
CREATE INDEX IF NOT EXISTS ix_arrival_invoice_no
    ON expected_arrivals (company_id, lower(supplier_invoice_no))
 WHERE supplier_invoice_no IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS ix_supplier_invoice_no
    ON supplier_invoices (company_id, lower(invoice_no))
 WHERE status <> 'CANCELLED';

-- An invoice filed at acceptance has no receipt to match against yet — the
-- goods have not moved. It is a bill for an agreed order, which is exactly what
-- PENDING already means, so no new status is needed. What is new is knowing
-- that the supplier filed it themselves rather than our clerk keying it in.
ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS filed_by_supplier boolean NOT NULL DEFAULT false;

COMMIT;
