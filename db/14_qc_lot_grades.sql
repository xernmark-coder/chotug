-- ===========================================================================
--  14 — GRADING A LOAD IN GROUPS
--
--  A QC inspection records one verdict for a whole delivery line: accepted,
--  rejected, held. Real produce does not arrive that way. Forty crates come
--  off a truck and twenty-five are good, ten are middling and five are fit for
--  nothing — and the buyer wants to pay three different prices, or take the
--  good ones and send the rest back.
--
--  This records that split: groups within an inspection, each with its own
--  grade, its own crate count and quantity, and its own disposition.
--
--  The existing accepted/rejected/hold totals on the inspection stay exactly
--  as they are and remain the source of truth for the GRN — the groups are how
--  those totals were arrived at, and they must add up to them.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS qc_lot_grades (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id      uuid NOT NULL REFERENCES companies(id),
    inspection_id   uuid NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,

    group_no        integer NOT NULL,
    label           text,                    -- "top layer", "wet crates"
    grade           text NOT NULL,           -- A / B / C, or whatever the QC template uses

    -- How much of the load this group is. Crates are how the warehouse counts
    -- it; quantity is what the ledger needs. Both are kept because converting
    -- one to the other loses the thing the inspector actually saw.
    container_count integer,
    qty             qty_amt NOT NULL CHECK (qty > 0),
    uom             text REFERENCES uoms(code),
    weight_kg       weight_kg,

    -- What happens to this group. ACCEPT and REJECT roll into the inspection's
    -- accepted/rejected totals; HOLD is stock nobody has decided about yet.
    disposition     text NOT NULL DEFAULT 'ACCEPT'
                    CHECK (disposition IN ('ACCEPT','REJECT','HOLD')),
    reason_code     text,                    -- required when not accepted
    -- What this group is worth relative to the agreed rate: 100 = full price,
    -- 80 = a fifth off for the middling crates. The price negotiation that
    -- actually happens on a mandi floor, written down.
    price_factor_pct numeric(5,2) NOT NULL DEFAULT 100
                    CHECK (price_factor_pct >= 0 AND price_factor_pct <= 200),
    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id),
    UNIQUE (inspection_id, group_no)
);

CREATE INDEX IF NOT EXISTS ix_qc_lot_grades_inspection ON qc_lot_grades (inspection_id);

-- Tenant isolation, matching every other table. FORCE is deliberately not
-- applied — see 11_rls_managed_host.sql.
ALTER TABLE qc_lot_grades ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = current_schema() AND tablename = 'qc_lot_grades'
                      AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON qc_lot_grades
            USING (company_id IS NULL OR company_id = current_company_id())
            WITH CHECK (company_id IS NULL OR company_id = current_company_id());
    END IF;
END $$;

COMMIT;
