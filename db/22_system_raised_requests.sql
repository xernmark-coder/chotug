-- ============================================================================
--  A payment request raised BY THE SYSTEM is not somebody's claim.
--
--  When a supplier invoice passes the 3-way match it queues itself with
--  Finance. Whoever ran the match is recorded as having raised it — and since
--  running the match is Finance's own job, maker-checker then refused to let
--  them verify it. The invoice was payable and unpayable at the same time.
--
--  The control on a supplier invoice is the match itself: three documents had
--  to agree before it got here. A second human staring at it adds nothing, so
--  system-raised requests are flagged and skip that check. Requests a PERSON
--  raises still need somebody else to verify them.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS is_system_raised boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payment_requests.is_system_raised IS
  'True when a document becoming payable queued this itself. Such a request '
  'skips maker-checker on verify, because the document''s own control already ran.';

-- Anything already queued from a source document was raised by the system.
UPDATE payment_requests SET is_system_raised = true
 WHERE source_id IS NOT NULL AND is_system_raised = false;

COMMIT;
