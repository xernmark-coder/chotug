-- ============================================================================
--  ChotuG ERP — STOCK ISSUE (the way stock leaves)
--
--  Until now the only OUT movement in the whole system was a GRN reversal, so
--  stock could enter and never leave. This adds the counterpart document: one
--  issue note, many batch lines, posted to the same append-only ledger a
--  receipt posts to.
--
--  Additive and idempotent. Runs after 05_farming_seed.sql.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Rebuild the allowed doc types as the union of what this migration needs and
-- what is already in use. A later migration adds its own (ISS), and a plain
-- DROP/ADD here would revoke it the next time this file re-ran — which is how
-- an "idempotent" migration chain quietly stops being idempotent.
DO $$
DECLARE v_types text[];
BEGIN
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_types FROM (
        SELECT unnest(ARRAY['REQ','RFQ','IND','PO','GATE','WGT','QC','GRN',
                          'BATCH','LABEL','INV','DN','CN','PUT',
                          'CROP','HARV','FDN','ISS']) AS t
        UNION
        SELECT doc_type FROM number_series
    ) x;
    ALTER TABLE number_series DROP CONSTRAINT IF EXISTS number_series_doc_type_check;
    EXECUTE format(
      'ALTER TABLE number_series ADD CONSTRAINT number_series_doc_type_check
         CHECK (doc_type = ANY (%L))', v_types);
END $$;

-- ---------------------------------------------------------------------------
--  The document. `reason` maps 1:1 onto stock_ledger.txn_type, so the ledger
--  keeps speaking its own vocabulary and nothing has to translate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_issues (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id     uuid NOT NULL REFERENCES companies(id),
    branch_id      uuid NOT NULL REFERENCES branches(id),
    warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
    issue_no       text NOT NULL,
    issue_date     date NOT NULL DEFAULT CURRENT_DATE,
    reason         text NOT NULL CHECK (reason IN
                   ('SALE','TRANSFER_OUT','WASTAGE','RETURN','CONSUMPTION','ADJUSTMENT')),
    -- Who it went to. A customer, another branch, a staff canteen — free text,
    -- because this module has no sales master to point at yet.
    party_name     text,
    reference_no   text,                       -- their PO, a challan, a gate pass
    total_qty      qty_amt NOT NULL DEFAULT 0,
    total_weight_kg weight_kg NOT NULL DEFAULT 0,
    total_value    money_amt NOT NULL DEFAULT 0,
    -- Anything that is not a plain sale needs a written reason. Stock that
    -- disappears without one is exactly what this system exists to prevent.
    note           text,
    status         text NOT NULL DEFAULT 'POSTED'
                   CHECK (status IN ('POSTED','CANCELLED')),
    idempotency_key text,
    posted_at      timestamptz NOT NULL DEFAULT now(),
    posted_by      uuid REFERENCES users(id),
    cancelled_at   timestamptz,
    cancelled_by   uuid REFERENCES users(id),
    cancel_reason  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer NOT NULL DEFAULT 1,
    UNIQUE (company_id, issue_no),
    CONSTRAINT ck_issue_note CHECK (reason = 'SALE' OR note IS NOT NULL),
    CONSTRAINT ck_issue_cancel CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_stock_issue_recent
    ON stock_issues (company_id, issue_date DESC, warehouse_id);

CREATE TABLE IF NOT EXISTS stock_issue_lines (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    company_id   uuid NOT NULL REFERENCES companies(id),
    issue_id     uuid NOT NULL REFERENCES stock_issues(id) ON DELETE CASCADE,
    line_no      integer NOT NULL,
    product_id   uuid NOT NULL REFERENCES products(id),
    batch_id     uuid NOT NULL REFERENCES batches(id),
    qty          qty_amt NOT NULL CHECK (qty > 0),
    weight_kg    weight_kg,
    uom          text NOT NULL REFERENCES uoms(code),
    -- What it left the building at. For a sale this is the selling rate; for
    -- wastage it is the landed cost, so the write-off is valued honestly.
    rate         rate_amt,
    value        money_null,
    -- The cost it was carrying, kept beside the rate so margin is visible
    -- without re-deriving it later from a batch that may since have changed.
    landed_rate_per_kg rate_amt,
    UNIQUE (issue_id, line_no)
);
CREATE INDEX IF NOT EXISTS ix_issue_lines_batch ON stock_issue_lines (batch_id);

-- ---------------------------------------------------------------------------
--  Triggers and RLS — the 01_schema DO-blocks never saw these tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_issues','stock_issue_lines'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = format('trg_%s_updated', t)
                        AND tgrelid = t::regclass)
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t::regclass
                        AND a.attname = 'updated_at' AND a.attnum > 0 AND NOT a.attisdropped) THEN
            EXECUTE format(
              'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                 FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- FORCE is deliberately NOT applied: on a managed Postgres the
        -- application connects as the table owner, and FORCE would apply the
        -- policy to it too — breaking sign-in, which must look a user up
        -- before any company is known. See 11_rls_managed_host.sql.
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
                        AND tablename = t AND policyname = 'tenant_isolation') THEN
            EXECUTE format(
              'CREATE POLICY tenant_isolation ON %I
                 USING (company_id IS NULL OR company_id = current_company_id())
                 WITH CHECK (company_id IS NULL OR company_id = current_company_id())', t);
        END IF;
    END LOOP;

    -- Stock leaving the building is exactly the kind of thing §23 audits.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_issues_audit'
                    AND tgrelid = 'stock_issues'::regclass) THEN
        CREATE TRIGGER trg_stock_issues_audit AFTER INSERT OR UPDATE OR DELETE ON stock_issues
            FOR EACH ROW EXECUTE FUNCTION trg_audit_row();
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_issues, stock_issue_lines TO chotug_app;
GRANT SELECT ON stock_issues, stock_issue_lines TO chotug_readonly;

-- ---------------------------------------------------------------------------
--  Permissions. Issuing stock is a value movement, so it is CRITICAL and the
--  write-off reasons are gated separately from an ordinary sale.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level) VALUES
 ('inventory.stock.issue',     'inventory','stock','issue',  'Issue stock out — sale, transfer, consumption', false,'CRITICAL'),
 ('inventory.stock.writeoff',  'inventory','stock','writeoff','Write stock off as wastage or adjustment',      false,'CRITICAL'),
 ('inventory.stock.cancel',    'inventory','stock','cancel',  'Cancel a posted stock issue',                   false,'CRITICAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'WH_EXEC',      ARRAY['inventory.stock.issue']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['inventory.stock.issue','inventory.stock.writeoff']);
        PERFORM grant_role_perms(c.id, 'FARM_MGR',     ARRAY['inventory.stock.issue']);
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
         WHERE r.company_id = c.id AND r.code = 'OWNER'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, 'ISS', fy.fy, 'ISS', 1, 6
  FROM branches b CROSS JOIN (SELECT DISTINCT fy FROM number_series) AS fy
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

COMMIT;


-- ============================================================================
--  APPROVE-WITHIN-YOUR-OWN-AUTHORITY
--
--  `ck_po_maker_checker` forbade approved_by = submitted_by outright. The
--  intent is right — nobody should quietly wave through their own order — but
--  taken literally it also blocked the Owner, who has nobody above them to
--  route to, and a manager whose own limit already covers the order. In both
--  cases the document landed in a queue only that same person could clear.
--
--  So the rule becomes "no *silent* self-approval" rather than "no
--  self-approval": it is allowed only when the row says so explicitly, which
--  makes it visible in the table, in the audit trail and on the screen.
-- ============================================================================
BEGIN;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS self_approved_reason text;

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS ck_po_maker_checker;
ALTER TABLE purchase_orders ADD  CONSTRAINT ck_po_maker_checker
      CHECK (approved_by IS NULL
             OR approved_by <> submitted_by
             OR (self_approved AND self_approved_reason IS NOT NULL));

COMMENT ON COLUMN purchase_orders.self_approved IS
  'True when the submitter approved their own order because their role authority '
  'already covered every rule that fired. Never set without a reason.';

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS self_approved_reason text;

COMMIT;
