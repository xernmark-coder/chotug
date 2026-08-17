-- ===========================================================================
--  12 — PACKING
--
--  Between "50 kg of banana sitting in a batch" and "something a shopkeeper
--  buys" there is a step this system did not have: turning loose stock into
--  packs of a chosen size, each with its own price and its own barcode.
--
--  A pack is NOT a second copy of the stock. The kilos stay on the batch until
--  the pack is actually sold, and that sale goes through the same stock issue
--  every other outward movement uses — one code path for stock leaving the
--  building, which is the invariant worth protecting.
--
--  Packing therefore records intent and identity: how the stock has been made
--  up, what each pack is priced at, and the code printed on it.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

-- 'PCK' joins the allowed document types. Union-based, so a re-run of an
-- earlier file cannot revoke it (see the note in 04_farming.sql).
DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['PCK']) AS t
        UNION
        SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, 'PCK', fy.fy, 'PCK', 1, 6
  FROM branches b CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

-- ---------------------------------------------------------------------------
--  One packing session against one batch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pack_runs (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    branch_id     uuid NOT NULL REFERENCES branches(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
    batch_id      uuid NOT NULL REFERENCES batches(id),
    product_id    uuid NOT NULL REFERENCES products(id),
    run_no        text NOT NULL,
    packed_on     date NOT NULL DEFAULT CURRENT_DATE,
    pack_count    integer NOT NULL DEFAULT 0,
    total_qty     qty_amt NOT NULL DEFAULT 0,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    UNIQUE (company_id, run_no)
);
CREATE INDEX IF NOT EXISTS ix_pack_runs_batch ON pack_runs (batch_id);

-- ---------------------------------------------------------------------------
--  The individual pack — the thing that carries a barcode and a price.
--
--  `price` is per PACK, not per kg: a 5 kg crate at ₹300 is what the buyer
--  actually pays, and pricing per pack is how the trade quotes it. Two packs
--  off the same batch may be priced differently, which is the point.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS packs (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id    uuid NOT NULL REFERENCES companies(id),
    run_id        uuid NOT NULL REFERENCES pack_runs(id) ON DELETE CASCADE,
    batch_id      uuid NOT NULL REFERENCES batches(id),
    product_id    uuid NOT NULL REFERENCES products(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouses(id),

    -- The printed barcode. Short, unambiguous, and unique for all time so a
    -- label found on a floor six months later still resolves to one pack.
    code          text NOT NULL,
    pack_no       integer NOT NULL,
    group_label   text,                      -- "5 kg premium", "2 kg retail"

    qty           qty_amt NOT NULL CHECK (qty > 0),
    uom           text NOT NULL REFERENCES uoms(code),
    price         money_amt NOT NULL CHECK (price >= 0),
    grade         text,

    status        text NOT NULL DEFAULT 'IN_STOCK'
                  CHECK (status IN ('IN_STOCK','SOLD','VOID')),
    sold_issue_id uuid REFERENCES stock_issues(id),
    sold_at       timestamptz,
    void_reason   text,

    printed_at    timestamptz,
    print_count   smallint NOT NULL DEFAULT 0,

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS ix_packs_run    ON packs (run_id);
CREATE INDEX IF NOT EXISTS ix_packs_batch  ON packs (batch_id);
CREATE INDEX IF NOT EXISTS ix_packs_status ON packs (company_id, status);

-- Tenant isolation, matching every other table. FORCE is deliberately not
-- applied — see 11_rls_managed_host.sql.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['pack_runs','packs'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = current_schema() AND tablename = t
                          AND policyname = 'tenant_isolation') THEN
            EXECUTE format(
              'CREATE POLICY tenant_isolation ON %I
                 USING (company_id IS NULL OR company_id = current_company_id())
                 WITH CHECK (company_id IS NULL OR company_id = current_company_id())', t);
        END IF;
    END LOOP;
END $$;

COMMIT;
