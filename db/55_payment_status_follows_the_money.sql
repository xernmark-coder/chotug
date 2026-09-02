-- =============================================================================
-- 55 · WHAT IS OWED ON AN INVOICE IS DERIVED, NOT REMEMBERED
--
--   "fix the payment status and invoice match pages … it is not reflecting the
--    product that arrived. also payment is made but still not reflecting and
--    relying on old 3 match flow."
--
-- payment_status is the table behind the Payment Status page. A row was written
-- in exactly one place: the moment a three-way match came back MATCHED. Two
-- consequences, both of which the client is looking at:
--
--   · AN INVOICE THAT NEVER MATCHED HAS NO ROW. Invoices filed by the supplier
--     when they accept, or captured against a purchase order, go straight to
--     Finance to be paid — the match is reconciliation after the fact, not a
--     gate. None of them ever appeared on the page. 39 invoices, 13 rows.
--
--   · PAYING DID NOT UPDATE IT. The Finance desk pays a payment_request and
--     then runs `UPDATE payment_status …`, which changes nothing at all when
--     there is no row to change. 27 payments posted, and the page still read
--     "₹0 paid" against invoices that had been settled in full.
--
-- The fix is to stop asking anybody to remember. What is owed on an invoice is
-- a fact about two things that are already recorded — the invoice total, and
-- the payments posted against it — so it is computed from them, by a trigger
-- that fires however the money moved. Any future payment route is covered
-- automatically, because the trigger is on the money rather than on the screen.
--
-- The columns an outside system owns (external_ref, is_blocked, blocked_reason)
-- are left alone: those are somebody's assertion, not arithmetic.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* What has actually been paid against one invoice, from the payments
 * themselves. A claim can hang off the invoice directly, or off the purchase
 * order the invoice belongs to — both are the same money and both count. */
CREATE OR REPLACE VIEW v_invoice_paid AS
SELECT i.id                                        AS invoice_id,
       i.company_id,
       COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'POSTED'), 0) AS paid_amount,
       MAX(pay.paid_at) FILTER (WHERE pay.status = 'POSTED')             AS last_payment_at
  FROM supplier_invoices i
  LEFT JOIN payment_requests pr
         ON pr.company_id = i.company_id
        AND pr.status <> 'CANCELLED'
        AND ((pr.source_type = 'supplier_invoice' AND pr.source_id = i.id)
          OR (pr.source_type = 'purchase_order'   AND pr.source_id = i.po_id))
  LEFT JOIN payments pay ON pay.request_id = pr.id
 GROUP BY i.id, i.company_id;

/* Recompute one invoice's row, creating it if it is not there. Called by the
 * triggers below and by the backfill. */
CREATE OR REPLACE FUNCTION sync_payment_status(p_invoice_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
    SELECT i.id, i.company_id, i.supplier_id, i.total, i.due_date, i.status,
           COALESCE(vp.paid_amount, 0) AS paid, vp.last_payment_at
      INTO v
      FROM supplier_invoices i
      LEFT JOIN v_invoice_paid vp ON vp.invoice_id = i.id
     WHERE i.id = p_invoice_id;
    IF NOT FOUND OR v.status = 'CANCELLED' THEN
        DELETE FROM payment_status WHERE invoice_id = p_invoice_id;
        RETURN;
    END IF;

    INSERT INTO payment_status (invoice_id, company_id, supplier_id, payable_amount,
            paid_amount, balance, due_date, last_payment_at, last_synced_at, sync_source)
    VALUES (v.id, v.company_id, v.supplier_id, v.total,
            v.paid, GREATEST(v.total - v.paid, 0), v.due_date, v.last_payment_at,
            now(), 'DERIVED')
    ON CONFLICT (invoice_id) DO UPDATE
       SET payable_amount  = EXCLUDED.payable_amount,
           paid_amount     = EXCLUDED.paid_amount,
           balance         = EXCLUDED.balance,
           due_date        = COALESCE(EXCLUDED.due_date, payment_status.due_date),
           last_payment_at = EXCLUDED.last_payment_at,
           last_synced_at  = now(),
           sync_source     = 'DERIVED';
END $$;

/* ------------------------------------------------------------- triggers -- */
/* On the money, not on the screen — so it holds however the payment was made. */
CREATE OR REPLACE FUNCTION trg_payment_syncs_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_inv uuid;
BEGIN
    SELECT CASE WHEN pr.source_type = 'supplier_invoice' THEN pr.source_id
                ELSE (SELECT si.id FROM supplier_invoices si
                       WHERE si.po_id = pr.source_id AND si.status <> 'CANCELLED'
                       ORDER BY si.created_at LIMIT 1) END
      INTO v_inv
      FROM payment_requests pr
     WHERE pr.id = COALESCE(NEW.request_id, OLD.request_id);
    IF v_inv IS NOT NULL THEN PERFORM sync_payment_status(v_inv); END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_payments_sync_status ON payments;
CREATE TRIGGER trg_payments_sync_status
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_payment_syncs_invoice();

/* An invoice filed, re-totalled or cancelled changes what is owed too. */
CREATE OR REPLACE FUNCTION trg_invoice_syncs_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sync_payment_status(NEW.id);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_invoice_sync_status ON supplier_invoices;
CREATE TRIGGER trg_invoice_sync_status
    AFTER INSERT OR UPDATE OF total, due_date, status ON supplier_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_invoice_syncs_status();

/* --------------------------------------------------------- the backfill -- */
/* Every invoice that never matched, and every payment that never landed on the
 * page. Idempotent: it recomputes, it does not accumulate. */
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT id FROM supplier_invoices LOOP
        PERFORM sync_payment_status(r.id);
    END LOOP;
END $$;

GRANT SELECT ON v_invoice_paid TO chotug_app;
GRANT SELECT ON v_invoice_paid TO chotug_readonly;

COMMIT;
