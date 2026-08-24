-- =============================================================================
-- 36 · THE SUPPLIER CAN ASK FOR A VEHICLE
--
-- Transport was arranged one way: somebody in the office decided an order
-- needed collecting. But the person who knows whether a lorry is needed is
-- usually the supplier — he is the one standing next to the crates without a
-- way to move them, and his only recourse was to telephone.
--
-- So an order carries the fact that transport was asked for: who asked, when,
-- and what they said. A request is not a pickup — the office still arranges
-- that, and may say no — so this is a flag on the order rather than a
-- half-made pickup row that nobody owns.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS transport_requested_at   timestamptz,
  ADD COLUMN IF NOT EXISTS transport_requested_by   uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS transport_request_note   text;

-- Asking twice is not an error worth blocking, but the office should see one
-- outstanding request per order rather than a list of them.
CREATE INDEX IF NOT EXISTS ix_po_transport_requested
    ON purchase_orders (company_id, transport_requested_at)
 WHERE transport_requested_at IS NOT NULL;

-- The queue this lands in. TypeScript's QueueKey union and this CHECK are two
-- statements of the same list, and a new key added to only one of them fails at
-- the very last step — after the flag has been set and the transaction is half
-- done. Both move together.
DO $$
DECLARE def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
      FROM pg_constraint WHERE conname = 'work_queue_queue_key_check';
    IF def IS NOT NULL AND def NOT LIKE '%TRANSPORT_REQUEST%' THEN
        ALTER TABLE work_queue DROP CONSTRAINT work_queue_queue_key_check;
        ALTER TABLE work_queue ADD CONSTRAINT work_queue_queue_key_check
          CHECK (queue_key IN (
            'REQUIREMENT_REVIEW','AI_SUGGESTION','APPROVAL','EXPECTED_ARRIVAL',
            'WEIGH_PENDING','QC_PENDING','GRN_PENDING','PUTAWAY_PENDING',
            'INVOICE_MATCH','FINANCE_EXCEPTION','ALERT',
            'FARM_TASK','FARM_HARVEST','FARM_RECEIVE','PO_CONFIRM',
            'TRANSPORT_REQUEST'));
    END IF;
END $$;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('supplier.transport.request','supplier','transport','request',
  'Supplier asks the buyer to send a vehicle for an order', false,'NORMAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'SUPPLIER', ARRAY['supplier.transport.request']);
    END LOOP;
END $$;

COMMIT;
