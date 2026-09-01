--
-- PostgreSQL database dump
--

\restrict kJyEJFtUdYPLhQX7AQgoNlzMKrwx4zhijLkeeJ8vS7Hg2hGdzkHFbJc0MOOnad5

-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: fssai_t; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.fssai_t AS text
	CONSTRAINT fssai_t_check CHECK (((VALUE IS NULL) OR (VALUE ~ '^[0-9]{14}$'::text)));


--
-- Name: gstin_t; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.gstin_t AS text
	CONSTRAINT gstin_t_check CHECK (((VALUE IS NULL) OR (VALUE ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$'::text)));


--
-- Name: hsn_t; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.hsn_t AS text
	CONSTRAINT hsn_t_check CHECK (((VALUE IS NULL) OR (VALUE ~ '^[0-9]{4,8}$'::text)));


--
-- Name: money_amt; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.money_amt AS numeric(18,4) NOT NULL DEFAULT 0;


--
-- Name: money_null; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.money_null AS numeric(18,4);


--
-- Name: pan_t; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.pan_t AS text
	CONSTRAINT pan_t_check CHECK (((VALUE IS NULL) OR (VALUE ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'::text)));


--
-- Name: pct; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.pct AS numeric(9,4);


--
-- Name: qty_amt; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.qty_amt AS numeric(14,3);


--
-- Name: rate_amt; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.rate_amt AS numeric(18,6);


--
-- Name: short_code; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.short_code AS text
	CONSTRAINT short_code_check CHECK ((VALUE ~ '^[A-Z0-9_-]{1,32}$'::text));


--
-- Name: vehicle_reg_t; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.vehicle_reg_t AS text
	CONSTRAINT vehicle_reg_t_check CHECK (((VALUE IS NULL) OR (VALUE ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$'::text) OR (VALUE ~ '^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$'::text)));


--
-- Name: weight_kg; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.weight_kg AS numeric(14,3);


--
-- Name: bootstrap_company(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bootstrap_company(p_company uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_role_id uuid;
    r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('PURCHASE_EXEC','Purchase Executive','क्रय कार्यकारी',0,NULL::numeric),
        ('PURCHASE_MGR','Purchase Manager','क्रय प्रबंधक',2,500000),
        ('QC_EXEC','QC Executive','गुणवत्ता कार्यकारी',0,NULL),
        ('QC_HEAD','QC Head','गुणवत्ता प्रमुख',2,NULL),
        ('GATE_EXEC','Gate Executive','गेट कार्यकारी',0,NULL),
        ('WH_EXEC','Warehouse Executive','गोदाम कार्यकारी',0,NULL),
        ('FINANCE_EXEC','Finance Executive','वित्त कार्यकारी',2,200000),
        ('OWNER','Owner / Super Admin','स्वामी',3,NULL)
    ) AS t(code, name, name_hi, lvl, po_limit) LOOP
        INSERT INTO roles (company_id, code, name, name_hi, is_system)
        VALUES (p_company, r.code, r.name, r.name_hi, true)
        ON CONFLICT (company_id, code) DO NOTHING RETURNING id INTO v_role_id;
        IF v_role_id IS NULL THEN
            SELECT id INTO v_role_id FROM roles WHERE company_id=p_company AND code=r.code;
        END IF;
        INSERT INTO role_limits (role_id, max_po_value, max_approval_level,
                                 max_rate_variance_pct, max_qty_variance_pct,
                                 max_weight_variance_pct, max_backdate_days)
        VALUES (v_role_id, r.po_limit, r.lvl,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 10 ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 10 ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 100 WHEN 'PURCHASE_MGR' THEN 5 ELSE 0 END,
                CASE r.code WHEN 'OWNER' THEN 30 ELSE 0 END)
        ON CONFLICT (role_id) DO NOTHING;
    END LOOP;

    PERFORM grant_role_perms(p_company, 'PURCHASE_EXEC', ARRAY['purchase.requirement.create','purchase.requirement.submit','purchase.quote.compare','purchase.po.create','purchase.po.submit','ai.suggestion.accept','reports.purchase.view','reports.supplier.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_MGR', ARRAY['purchase.requirement.create','purchase.requirement.submit','purchase.requirement.approve','purchase.quote.compare','purchase.quote.select','purchase.po.create','purchase.po.submit','purchase.po.approve','purchase.po.revise','purchase.po.cancel','receiving.weighment.approve','costing.landing.view','ai.suggestion.accept','reports.purchase.view','reports.supplier.view','data.cost.view','data.export']);
    PERFORM grant_role_perms(p_company, 'QC_EXEC', ARRAY['quality.inspection.create','reports.supplier.view']);
    PERFORM grant_role_perms(p_company, 'QC_HEAD', ARRAY['quality.inspection.create','quality.inspection.approve','quality.template.manage','reports.supplier.view','data.export']);
    PERFORM grant_role_perms(p_company, 'GATE_EXEC', ARRAY['receiving.gate.create','receiving.gate.submit','receiving.gate.reject','receiving.weighment.create','master.vehicle.manage']);
    PERFORM grant_role_perms(p_company, 'WH_EXEC', ARRAY['receiving.weighment.create','receiving.grn.create','receiving.grn.submit','receiving.label.print','receiving.putaway.confirm']);
    PERFORM grant_role_perms(p_company, 'FINANCE_EXEC', ARRAY['finance.invoice.create','finance.invoice.match','finance.invoice.approve','finance.payment.view','finance.note.create','costing.landing.view','reports.purchase.view','data.cost.view','data.export']);
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT role_row.id, p.code FROM roles AS role_row CROSS JOIN permissions p
    WHERE role_row.company_id=p_company AND role_row.code='OWNER' ON CONFLICT DO NOTHING;

    INSERT INTO charge_types (company_id, code, name, name_hi, allocation_basis, is_creditable, borne_by) VALUES
      (p_company,'COMMISSION','Aadhti/Mandi Commission','आढ़त कमीशन','VALUE',false,'BUYER'),
      (p_company,'MARKET_FEE','APMC Market Fee','मंडी शुल्क','VALUE',false,'BUYER'),
      (p_company,'TRANSPORT','Transport / Freight','भाड़ा','WEIGHT',false,'BUYER'),
      (p_company,'LOADING','Loading (Hamali)','चढ़ाई','WEIGHT',false,'BUYER'),
      (p_company,'UNLOADING','Unloading (Hamali)','उतराई','WEIGHT',false,'BUYER'),
      (p_company,'PACKING','Packing / Crate','पैकिंग','QTY',false,'BUYER'),
      (p_company,'COLD_STORE','Cold Storage','शीत भंडारण','WEIGHT',true,'BUYER'),
      (p_company,'GATE_FEE','Gate / Documentation','गेट शुल्क','EQUAL',false,'BUYER'),
      (p_company,'INSURANCE','Transit Insurance','बीमा','VALUE',true,'BUYER'),
      (p_company,'OTHER','Other Allocable Cost','अन्य','MANUAL',false,'BUYER')
    ON CONFLICT (company_id, code) DO NOTHING;
    INSERT INTO tolerance_profiles (company_id, code, name, is_default)
    VALUES (p_company,'DEFAULT','Default tolerance profile',true)
    ON CONFLICT (company_id, code) DO NOTHING;
    INSERT INTO settings (company_id, scope, key, value) VALUES
      (p_company,'COMPANY','weight.tolerance.green_pct','0.5'),(p_company,'COMPANY','weight.tolerance.amber_pct','2.0'),
      (p_company,'COMPANY','weight.tolerance.red_pct','5.0'),(p_company,'COMPANY','approval.auto_approve_below','25000'),
      (p_company,'COMPANY','approval.max_rate_variance_pct','5'),(p_company,'COMPANY','approval.max_qty_variance_pct','10'),
      (p_company,'COMPANY','approval.min_margin_pct','8'),(p_company,'COMPANY','landing_cost.variance_alert_pct','3'),
      (p_company,'COMPANY','qc.sla_minutes','45'),(p_company,'COMPANY','grn.sla_minutes','120'),
      (p_company,'COMPANY','grocery.min_remaining_shelf_pct','75'),(p_company,'COMPANY','ai.min_acceptance_target_pct','60')
    ON CONFLICT (company_id, branch_id, key) DO NOTHING;
END $$;


--
-- Name: bootstrap_farming(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bootstrap_farming(p_company uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE v_role_id uuid; r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('FARM_MGR','Farm Manager','फार्म प्रबंधक',2,3),
        ('FARM_STAFF','Farm Staff','फार्म कर्मचारी',0,1)
    ) AS t(code, name, name_hi, lvl, backdate) LOOP
        INSERT INTO roles (company_id, code, name, name_hi, is_system)
        VALUES (p_company, r.code, r.name, r.name_hi, true)
        ON CONFLICT (company_id, code) DO NOTHING RETURNING id INTO v_role_id;
        IF v_role_id IS NULL THEN
            SELECT id INTO v_role_id FROM roles WHERE company_id = p_company AND code = r.code;
        END IF;
        INSERT INTO role_limits (role_id, max_approval_level, max_backdate_days)
        VALUES (v_role_id, r.lvl, r.backdate) ON CONFLICT (role_id) DO NOTHING;
    END LOOP;

    PERFORM grant_role_perms(p_company, 'FARM_STAFF', ARRAY[
        'farming.task.complete','farming.harvest.record',
        'farming.dispatch.create','farming.expense.create','farming.loss.record']);
    PERFORM grant_role_perms(p_company, 'FARM_MGR', ARRAY[
        'farming.farm.manage','farming.crop.start','farming.crop.close',
        'farming.task.complete','farming.harvest.record','farming.dispatch.create',
        'farming.expense.create','farming.loss.record','farming.cost.view',
        'farming.report.view','reports.purchase.view','data.cost.view']);
    PERFORM grant_role_perms(p_company, 'WH_EXEC', ARRAY['farming.dispatch.receive','farming.report.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_EXEC', ARRAY['farming.report.view']);
    PERFORM grant_role_perms(p_company, 'PURCHASE_MGR',  ARRAY['farming.report.view','farming.cost.view']);

    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
     WHERE r.company_id = p_company AND r.code = 'OWNER'
    ON CONFLICT DO NOTHING;

    INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
    SELECT b.company_id, b.id, t.doc_type, fy.fy, t.prefix, 1, 6
      FROM branches b
      CROSS JOIN (VALUES ('CROP','CROP'),('HARV','HRV'),('FDN','FDN')) AS t(doc_type, prefix)
      CROSS JOIN (SELECT DISTINCT fy FROM number_series WHERE company_id = p_company) AS fy
     WHERE b.company_id = p_company
    ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;
END $$;


--
-- Name: FUNCTION bootstrap_farming(p_company uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bootstrap_farming(p_company uuid) IS 'Call after bootstrap_company() for a new tenant: farm roles, permissions and numbering.';


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_actor_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;


--
-- Name: current_company_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_company_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;


--
-- Name: ensure_audit_partition(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_audit_partition(p_month date) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_start date := date_trunc('month', p_month)::date;
    v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
    v_name  text := 'audit_log_' || to_char(v_start, 'YYYY"m"MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            v_name, v_start, v_end);
        EXECUTE format('CREATE INDEX ON %I (entity_type, entity_id, occurred_at DESC)', v_name);
        EXECUTE format('CREATE INDEX ON %I (actor_id, occurred_at DESC)', v_name);
    END IF;
END $$;


--
-- Name: grant_role_perms(uuid, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grant_role_perms(p_company uuid, p_role text, p_perms text[]) RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, unnest(p_perms)
      FROM roles r
     WHERE r.company_id = p_company AND r.code = p_role
    ON CONFLICT DO NOTHING;
$$;


--
-- Name: loc_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.loc_code(prefix text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT prefix || '-' || string_agg(
           substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                  1 + floor(random() * 32)::int, 1), '')
    FROM generate_series(1, 6);
$$;


--
-- Name: next_doc_no(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_doc_no(p_company uuid, p_branch uuid, p_type text, p_fy text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_prefix text;
    v_width  int;
    v_no     bigint;
BEGIN
    -- FOR UPDATE serialises concurrent callers on this one series row
    UPDATE number_series
       SET next_no = next_no + 1
     WHERE company_id = p_company
       AND branch_id  = p_branch
       AND doc_type   = p_type
       AND fy         = p_fy
    RETURNING prefix, width, next_no INTO v_prefix, v_width, v_no;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'number_series_missing: %/%/% for company %',
            p_type, p_fy, p_branch, p_company
            USING ERRCODE = '23503';
    END IF;

    RETURN v_prefix || '/' || p_fy || '/' || lpad(v_no::text, v_width, '0');
END $$;


--
-- Name: FUNCTION next_doc_no(p_company uuid, p_branch uuid, p_type text, p_fy text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.next_doc_no(p_company uuid, p_branch uuid, p_type text, p_fy text) IS 'Returns e.g. PO/2026-27/000123. Row-locked, gapless within a committed tx.';


--
-- Name: trg_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_audit_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_before jsonb;
    v_after  jsonb;
    v_diff   jsonb;
    v_id     uuid;
    v_company uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_before := NULL;  v_after := to_jsonb(NEW);
    ELSIF TG_OP = 'UPDATE' THEN
        v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    ELSE
        v_before := to_jsonb(OLD); v_after := NULL;
    END IF;

    -- Composite-key relationship tables do not have an `id` field.
    v_id := NULLIF(COALESCE(v_after, v_before)->>'id', '')::uuid;

    IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(key, jsonb_build_object('old', v_before->key,
                                                        'new', v_after->key))
          INTO v_diff
          FROM jsonb_each(v_after)
         WHERE v_after->key IS DISTINCT FROM v_before->key
           AND key NOT IN ('updated_at','version');
        IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
            RETURN COALESCE(NEW, OLD);
        END IF;
    END IF;

    v_company := COALESCE(v_after->>'company_id', v_before->>'company_id')::uuid;

    INSERT INTO audit_log (
        company_id, actor_id, actor_role, branch_id, session_id,
        ip, device_fingerprint, entity_type, entity_id, action,
        before, after, diff, reason_code, reason_text, request_id, occurred_at)
    VALUES (
        COALESCE(v_company, current_company_id()),
        current_actor_id(),
        nullif(current_setting('app.actor_role', true), ''),
        COALESCE(v_after->>'branch_id', v_before->>'branch_id')::uuid,
        nullif(current_setting('app.session_id', true), '')::uuid,
        nullif(current_setting('app.ip', true), '')::inet,
        nullif(current_setting('app.device', true), ''),
        TG_TABLE_NAME, v_id, TG_OP,
        v_before, v_after, v_diff,
        nullif(current_setting('app.reason_code', true), ''),
        nullif(current_setting('app.reason_text', true), ''),
        nullif(current_setting('app.request_id', true), ''),
        now());

    RETURN COALESCE(NEW, OLD);
END $$;


--
-- Name: trg_forbid_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION
      'immutable_row: % rows cannot be % once written (use reversal/amendment)',
      TG_TABLE_NAME, lower(TG_OP)
      USING ERRCODE = '0A000';
END $$;


--
-- Name: trg_forbid_update_when_posted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_forbid_update_when_posted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status IN ('POSTED','REVERSED') THEN
        -- Allow only the narrow set of columns that amendment/reversal links use
        IF (NEW.* IS DISTINCT FROM OLD.*) AND
           (NEW.status, NEW.amended_by_grn_id, NEW.reversal_of_grn_id)
           IS NOT DISTINCT FROM
           (OLD.status, OLD.amended_by_grn_id, OLD.reversal_of_grn_id) THEN
            RAISE EXCEPTION
              'posted_document_immutable: GRN % is % and cannot be edited directly',
              OLD.grn_no, OLD.status
              USING ERRCODE = '0A000';
        END IF;
    END IF;
    RETURN NEW;
END $$;


--
-- Name: trg_gate_locked(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_gate_locked() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.locked_at IS NOT NULL
       AND (NEW.status, NEW.gate_out_at, NEW.unloading_start_at, NEW.unloading_end_at,
            NEW.detention_minutes, NEW.updated_at, NEW.updated_by, NEW.version)
           IS NOT DISTINCT FROM
           (OLD.status, OLD.gate_out_at, OLD.unloading_start_at, OLD.unloading_end_at,
            OLD.detention_minutes, OLD.updated_at, OLD.updated_by, OLD.version)
       AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'gate_entry_locked: % was submitted and is immutable', OLD.gate_no
            USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
END $$;


--
-- Name: trg_no_delete_if_approved(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_no_delete_if_approved() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status NOT IN ('DRAFT','CANCELLED') THEN
        RAISE EXCEPTION 'no_hard_delete: % in status % must be cancelled, not deleted',
            TG_TABLE_NAME, OLD.status USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
END $$;


--
-- Name: trg_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    IF TG_OP = 'UPDATE' THEN
        -- Optimistic concurrency: the app sends the version it read.
        -- A stale write raises here rather than silently clobbering.
        IF NEW.version IS NOT NULL AND OLD.version IS NOT NULL
           AND NEW.version <> OLD.version THEN
            RAISE EXCEPTION
              'stale_write: % id=% expected version % but row is at %',
              TG_TABLE_NAME, OLD.id, NEW.version, OLD.version
              USING ERRCODE = '40001';
        END IF;
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END $$;


--
-- Name: trg_supplier_product_tracking_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_supplier_product_tracking_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_sup text; v_sku text;
BEGIN
    IF NEW.tracking_code IS NOT NULL THEN RETURN NEW; END IF;
    SELECT s.code INTO v_sup FROM suppliers s WHERE s.id = NEW.supplier_id;
    SELECT p.sku  INTO v_sku FROM products  p WHERE p.id = NEW.product_id;
    -- Readable on a printed label and unambiguous when typed back in.
    NEW.tracking_code := upper(regexp_replace(
        COALESCE(v_sup, 'SUP') || '-' || COALESCE(v_sku, 'PRD'), '[^A-Z0-9-]', '', 'gi'));
    RETURN NEW;
END $$;


--
-- Name: trg_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;


--
-- Name: uuid_generate_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.uuid_generate_v7() RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ts_ms   bigint;
    v_bytes   bytea;
BEGIN
    v_ts_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

    -- 16 random bytes, then overwrite the first 6 with the timestamp
    v_bytes := gen_random_bytes(16);
    v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
    v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
    v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
    v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
    v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >>  8) & 255)::int);
    v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);

    -- version 7 in the high nibble of byte 6
    v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));
    -- RFC 4122 variant (10xx) in the top bits of byte 8
    v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));

    RETURN encode(v_bytes, 'hex')::uuid;
END $$;


--
-- Name: FUNCTION uuid_generate_v7(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.uuid_generate_v7() IS 'Time-ordered UUID v7. Use as DEFAULT for all primary keys.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: aadhtis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aadhtis (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    mandi_id uuid,
    licence_no text,
    commission_pct public.pct DEFAULT 0 NOT NULL,
    settlement_cycle_days smallint DEFAULT 7 NOT NULL,
    market_fee_pct public.pct DEFAULT 0 NOT NULL,
    hamali_rate public.money_null,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: ai_feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_feature_flags (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    feature_key text NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    fallback_mode text DEFAULT 'RULE'::text NOT NULL,
    min_confidence numeric(5,4) DEFAULT 0.70 NOT NULL,
    auto_apply_below_value public.money_null,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_feature_flags_fallback_mode_check CHECK ((fallback_mode = ANY (ARRAY['RULE'::text, 'STATISTICAL'::text, 'OFF'::text])))
);


--
-- Name: ai_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_models (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    feature_key text NOT NULL,
    model_name text NOT NULL,
    model_version text NOT NULL,
    license text NOT NULL,
    trained_at timestamp with time zone,
    dataset_hash text,
    eval_metrics jsonb,
    approved_by uuid,
    approved_at timestamp with time zone,
    is_active boolean DEFAULT false NOT NULL,
    rollback_to uuid,
    endpoint text
);


--
-- Name: ai_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid,
    feature_key text NOT NULL,
    model_id uuid,
    model_name text NOT NULL,
    model_version text NOT NULL,
    entity_type text,
    entity_id uuid,
    input_hash text NOT NULL,
    input_ref jsonb,
    output jsonb NOT NULL,
    reason jsonb,
    confidence numeric(5,4),
    latency_ms integer,
    cost_tokens integer,
    used_fallback boolean DEFAULT false NOT NULL,
    fallback_reason text,
    accepted boolean,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    override_value jsonb,
    feedback_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    alert_type text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    severity text DEFAULT 'MEDIUM'::text NOT NULL,
    threshold jsonb,
    target_role_ids uuid[],
    channels text[] DEFAULT ARRAY['IN_APP'::text] NOT NULL,
    sla_minutes integer,
    escalate_after_minutes integer,
    escalate_to_role_id uuid,
    digest_window_minutes integer,
    dedupe_window_minutes integer DEFAULT 60 NOT NULL,
    CONSTRAINT alert_rules_severity_check CHECK ((severity = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text])))
);


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid,
    alert_type text NOT NULL,
    severity text NOT NULL,
    entity_type text,
    entity_id uuid,
    title text NOT NULL,
    message text NOT NULL,
    message_hi text,
    dedupe_hash text,
    status text DEFAULT 'OPEN'::text NOT NULL,
    acked_by uuid,
    acked_at timestamp with time zone,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    snoozed_until timestamp with time zone,
    snooze_reason text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alerts_severity_check CHECK ((severity = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text]))),
    CONSTRAINT alerts_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'ACK'::text, 'RESOLVED'::text, 'SUPPRESSED'::text, 'SNOOZED'::text])))
);


--
-- Name: approval_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid,
    doc_type text NOT NULL,
    trigger_code text NOT NULL,
    threshold_numeric numeric(18,4),
    required_level smallint NOT NULL,
    required_role_id uuid,
    sla_minutes integer DEFAULT 240 NOT NULL,
    escalate_after_minutes integer,
    escalate_to_role_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT approval_rules_doc_type_check CHECK ((doc_type = ANY (ARRAY['REQUIREMENT'::text, 'PO'::text, 'GRN'::text, 'INVOICE'::text, 'RATE_REVISION'::text]))),
    CONSTRAINT approval_rules_required_level_check CHECK (((required_level >= 1) AND (required_level <= 3))),
    CONSTRAINT approval_rules_trigger_code_check CHECK ((trigger_code = ANY (ARRAY['VALUE'::text, 'RATE_VARIANCE'::text, 'QTY_VARIANCE'::text, 'WEIGHT_VARIANCE'::text, 'NEW_SUPPLIER'::text, 'SUPPLIER_RISK'::text, 'MARGIN_RISK'::text, 'URGENT'::text, 'LANDING_COST'::text, 'BACKDATE'::text])))
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    doc_type text NOT NULL,
    doc_id uuid NOT NULL,
    doc_no text,
    level smallint NOT NULL,
    triggers text[] DEFAULT '{}'::text[] NOT NULL,
    trigger_detail jsonb,
    required_role_id uuid,
    requested_by uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    sla_due_at timestamp with time zone,
    status text DEFAULT 'PENDING'::text NOT NULL,
    approver_id uuid,
    decided_at timestamp with time zone,
    reason_code text,
    reason_text text,
    escalated_from uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT approvals_doc_type_check CHECK ((doc_type = ANY (ARRAY['REQUIREMENT'::text, 'PO'::text, 'GRN'::text, 'INVOICE'::text, 'RATE_REVISION'::text, 'GATE_EXCEPTION'::text, 'WEIGHT_VARIANCE'::text, 'QC_OVERRIDE'::text, 'GRN_REVERSAL'::text, 'SUPPLIER_STATUS'::text]))),
    CONSTRAINT approvals_level_check CHECK (((level >= 1) AND (level <= 3))),
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'HELD'::text, 'REJECTED'::text, 'WITHDRAWN'::text, 'ESCALATED'::text]))),
    CONSTRAINT ck_appr_maker_checker CHECK (((approver_id IS NULL) OR (approver_id <> requested_by))),
    CONSTRAINT ck_appr_reason CHECK (((status <> ALL (ARRAY['HELD'::text, 'REJECTED'::text])) OR (reason_text IS NOT NULL)))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    file_key text NOT NULL,
    file_name text NOT NULL,
    mime text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum text NOT NULL,
    scan_status text DEFAULT 'PENDING'::text NOT NULL,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_scan_status_check CHECK ((scan_status = ANY (ARRAY['PENDING'::text, 'CLEAN'::text, 'INFECTED'::text, 'ERROR'::text])))
);


--
-- Name: audit_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_counts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    task_id uuid,
    warehouse_id uuid NOT NULL,
    bin_id uuid,
    scanned_qr text,
    product_id uuid NOT NULL,
    batch_id uuid,
    expected_qty numeric(14,3) DEFAULT 0 NOT NULL,
    counted_qty numeric(14,3) NOT NULL,
    variance_qty numeric(14,3) GENERATED ALWAYS AS ((counted_qty - expected_qty)) STORED,
    condition text DEFAULT 'GOOD'::text NOT NULL,
    loss_qty numeric(14,3) DEFAULT 0 NOT NULL,
    loss_value numeric(14,2),
    note text,
    photo_key text,
    counted_by uuid NOT NULL,
    counted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_counts_condition_check CHECK ((condition = ANY (ARRAY['GOOD'::text, 'DAMAGED'::text, 'SPOILED'::text, 'EXPIRED'::text, 'MISSING'::text, 'MISPLACED'::text]))),
    CONSTRAINT audit_counts_counted_qty_check CHECK ((counted_qty >= (0)::numeric)),
    CONSTRAINT audit_counts_loss_qty_check CHECK ((loss_qty >= (0)::numeric)),
    CONSTRAINT ck_audit_note CHECK ((((condition = 'GOOD'::text) AND (loss_qty = (0)::numeric)) OR (note IS NOT NULL)))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    actor_id uuid,
    actor_role text,
    branch_id uuid,
    session_id uuid,
    ip inet,
    device_fingerprint text,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    diff jsonb,
    reason_code text,
    reason_text text,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: audit_log_2026m08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log_2026m08 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    actor_id uuid,
    actor_role text,
    branch_id uuid,
    session_id uuid,
    ip inet,
    device_fingerprint text,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    diff jsonb,
    reason_code text,
    reason_text text,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_2026m09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log_2026m09 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    actor_id uuid,
    actor_role text,
    branch_id uuid,
    session_id uuid,
    ip inet,
    device_fingerprint text,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    diff jsonb,
    reason_code text,
    reason_text text,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_2026m10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log_2026m10 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    actor_id uuid,
    actor_role text,
    branch_id uuid,
    session_id uuid,
    ip inet,
    device_fingerprint text,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    diff jsonb,
    reason_code text,
    reason_text text,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log_default (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    actor_id uuid,
    actor_role text,
    branch_id uuid,
    session_id uuid,
    ip inet,
    device_fingerprint text,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    diff jsonb,
    reason_code text,
    reason_text text,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_tasks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    task_no text NOT NULL,
    scope text DEFAULT 'WAREHOUSE'::text NOT NULL,
    scope_id uuid,
    product_id uuid,
    reason text NOT NULL,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    due_date date,
    status text DEFAULT 'OPEN'::text NOT NULL,
    findings text,
    assigned_to uuid,
    raised_by uuid NOT NULL,
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    completed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT audit_tasks_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'NORMAL'::text, 'HIGH'::text, 'URGENT'::text]))),
    CONSTRAINT audit_tasks_scope_check CHECK ((scope = ANY (ARRAY['WAREHOUSE'::text, 'FLOOR'::text, 'SECTION'::text, 'RACK'::text, 'SHELF'::text, 'PRODUCT'::text, 'BATCH'::text]))),
    CONSTRAINT audit_tasks_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text, 'DONE'::text, 'CANCELLED'::text]))),
    CONSTRAINT ck_audit_done CHECK (((status <> 'DONE'::text) OR (findings IS NOT NULL)))
);


--
-- Name: batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batches (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    batch_no text NOT NULL,
    product_id uuid NOT NULL,
    grn_line_id uuid,
    supplier_id uuid,
    farm_id uuid,
    received_date date NOT NULL,
    harvest_date date,
    mfg_date date,
    expiry_date date,
    shelf_life_days smallint,
    predicted_expiry_date date,
    shelf_life_model_version text,
    grade text,
    initial_qty public.qty_amt NOT NULL,
    remaining_qty public.qty_amt NOT NULL,
    net_weight_kg public.weight_kg,
    remaining_weight_kg public.weight_kg,
    landed_rate public.rate_amt,
    landed_rate_per_kg public.rate_amt,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    quarantine_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT batches_check CHECK ((((remaining_qty)::numeric >= (0)::numeric) AND ((remaining_qty)::numeric <= ((initial_qty)::numeric + 0.001)))),
    CONSTRAINT batches_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'QUARANTINE'::text, 'CONSUMED'::text, 'EXPIRED'::text, 'WRITTEN_OFF'::text, 'RETURNED'::text])))
);


--
-- Name: bins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bins (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    rack_id uuid NOT NULL,
    code text NOT NULL,
    capacity_kg public.weight_kg,
    capacity_crates integer,
    current_fill_kg public.weight_kg DEFAULT 0 NOT NULL,
    is_pickface boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    qr_code text
);


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    type text NOT NULL,
    gstin public.gstin_t,
    fssai_lic_no public.fssai_t,
    fssai_expiry date,
    address jsonb,
    geo_lat numeric(10,7),
    geo_lng numeric(10,7),
    contact_phone text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT branches_type_check CHECK ((type = ANY (ARRAY['BRANCH'::text, 'WAREHOUSE'::text, 'BOTH'::text])))
);


--
-- Name: centre_day_close; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.centre_day_close (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    close_date date NOT NULL,
    system_qty numeric(14,3) DEFAULT 0 NOT NULL,
    system_revenue numeric(14,2) DEFAULT 0 NOT NULL,
    declared_qty numeric(14,3) DEFAULT 0 NOT NULL,
    declared_revenue numeric(14,2) DEFAULT 0 NOT NULL,
    cash_amount numeric(14,2) DEFAULT 0 NOT NULL,
    online_amount numeric(14,2) DEFAULT 0 NOT NULL,
    expenses numeric(14,2) DEFAULT 0 NOT NULL,
    wastage_qty numeric(14,3) DEFAULT 0 NOT NULL,
    variance numeric(14,2) GENERATED ALWAYS AS ((declared_revenue - system_revenue)) STORED,
    note text,
    closed_by uuid NOT NULL,
    closed_at timestamp with time zone DEFAULT now() NOT NULL,
    receipt_id uuid,
    expense_request_id uuid,
    CONSTRAINT ck_close_variance CHECK (((abs((declared_revenue - system_revenue)) < 0.01) OR (note IS NOT NULL)))
);


--
-- Name: charge_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.charge_types (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    allocation_basis text DEFAULT 'VALUE'::text NOT NULL,
    is_creditable boolean DEFAULT false NOT NULL,
    affects_landing_cost boolean DEFAULT true NOT NULL,
    default_amount public.money_null,
    default_pct public.pct,
    borne_by text DEFAULT 'BUYER'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT charge_types_allocation_basis_check CHECK ((allocation_basis = ANY (ARRAY['VALUE'::text, 'WEIGHT'::text, 'QTY'::text, 'EQUAL'::text, 'MANUAL'::text]))),
    CONSTRAINT charge_types_borne_by_check CHECK ((borne_by = ANY (ARRAY['BUYER'::text, 'SUPPLIER'::text, 'SHARED'::text])))
);


--
-- Name: cold_chain_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cold_chain_summaries (
    gate_entry_id uuid NOT NULL,
    company_id uuid NOT NULL,
    min_temp_c numeric(5,2),
    max_temp_c numeric(5,2),
    mean_temp_c numeric(5,2),
    degree_hours_above numeric(10,3),
    excursion_count smallint DEFAULT 0 NOT NULL,
    longest_excursion_min integer,
    door_open_events smallint,
    shelf_life_penalty_days numeric(6,2),
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    code text NOT NULL,
    legal_name text NOT NULL,
    trade_name text,
    gstin public.gstin_t,
    pan public.pan_t,
    fssai_lic_no public.fssai_t,
    fssai_expiry date,
    registered_address jsonb,
    fy_start_month smallint DEFAULT 4 NOT NULL,
    base_currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    default_locale text DEFAULT 'en'::text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    default_margin_pct numeric(6,2) DEFAULT 15 NOT NULL,
    overhead_window_days integer DEFAULT 30 NOT NULL,
    upi_id text,
    upi_payee_name text,
    CONSTRAINT companies_default_locale_check CHECK ((default_locale = ANY (ARRAY['en'::text, 'hi'::text]))),
    CONSTRAINT companies_fy_start_month_check CHECK (((fy_start_month >= 1) AND (fy_start_month <= 12))),
    CONSTRAINT companies_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'CLOSED'::text])))
);


--
-- Name: container_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.container_types (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    container_kind text NOT NULL,
    tare_kg public.weight_kg NOT NULL,
    is_returnable boolean DEFAULT true NOT NULL,
    deposit_amount public.money_null,
    owner text,
    rfid_enabled boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT container_types_container_kind_check CHECK ((container_kind = ANY (ARRAY['CRATE'::text, 'BAG'::text, 'BOX'::text, 'PALLET'::text, 'DRUM'::text, 'TRAY'::text]))),
    CONSTRAINT container_types_owner_check CHECK ((owner = ANY (ARRAY['OWN'::text, 'SUPPLIER'::text, 'THIRD_PARTY'::text])))
);


--
-- Name: containers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.containers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    container_type_id uuid NOT NULL,
    code text NOT NULL,
    rfid_tag text,
    actual_tare_kg public.weight_kg,
    current_location text,
    held_by_supplier_id uuid,
    status text DEFAULT 'AVAILABLE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT containers_status_check CHECK ((status = ANY (ARRAY['AVAILABLE'::text, 'IN_USE'::text, 'WITH_SUPPLIER'::text, 'DAMAGED'::text, 'LOST'::text])))
);


--
-- Name: credit_debit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_debit_notes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    note_no text NOT NULL,
    note_type text NOT NULL,
    supplier_id uuid NOT NULL,
    invoice_id uuid,
    grn_id uuid,
    reason_code text NOT NULL,
    amount public.money_amt NOT NULL,
    tax_amount public.money_amt,
    total public.money_amt NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    auto_drafted boolean DEFAULT false NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT credit_debit_notes_note_type_check CHECK ((note_type = ANY (ARRAY['CREDIT'::text, 'DEBIT'::text]))),
    CONSTRAINT credit_debit_notes_reason_code_check CHECK ((reason_code = ANY (ARRAY['QC_REJECTION'::text, 'SHORT_SUPPLY'::text, 'RATE_DIFFERENCE'::text, 'WEIGHT_SHORTAGE'::text, 'DAMAGE'::text, 'TAX_CORRECTION'::text, 'OTHER'::text]))),
    CONSTRAINT credit_debit_notes_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ISSUED'::text, 'ACCEPTED'::text, 'SETTLED'::text, 'CANCELLED'::text])))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    name text NOT NULL,
    phone text,
    kind text DEFAULT 'WALK_IN'::text NOT NULL,
    gstin text,
    address text,
    credit_limit numeric(14,2) DEFAULT 0 NOT NULL,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT customers_kind_check CHECK ((kind = ANY (ARRAY['WALK_IN'::text, 'SHOP'::text, 'HOTEL'::text, 'WHOLESALER'::text, 'INSTITUTION'::text, 'ONLINE'::text])))
);


--
-- Name: demand_forecasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_forecasts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    forecast_date date NOT NULL,
    run_date date NOT NULL,
    horizon_days smallint NOT NULL,
    p50_qty public.qty_amt NOT NULL,
    p90_qty public.qty_amt,
    p10_qty public.qty_amt,
    model_name text NOT NULL,
    model_version text,
    features jsonb,
    actual_qty public.qty_amt,
    abs_pct_error public.pct
);


--
-- Name: demand_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_signals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    signal_date date NOT NULL,
    signal_type text NOT NULL,
    qty public.qty_amt NOT NULL,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT demand_signals_signal_type_check CHECK ((signal_type = ANY (ARRAY['SALE'::text, 'ADVANCE_ORDER'::text, 'BRANCH_INDENT'::text, 'WASTAGE'::text, 'RETURN'::text, 'STOCKOUT'::text, 'FESTIVAL'::text, 'PROMO'::text])))
);


--
-- Name: device_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_readings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    scale_device_id uuid,
    site_agent_id uuid,
    kind text DEFAULT 'WEIGHT'::text NOT NULL,
    value_kg public.weight_kg,
    raw_reading text,
    is_stable boolean DEFAULT false NOT NULL,
    scanned_code text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_by uuid,
    consumed_at timestamp with time zone,
    CONSTRAINT device_readings_kind_check CHECK ((kind = ANY (ARRAY['WEIGHT'::text, 'SCAN'::text, 'TEMPERATURE'::text])))
);


--
-- Name: drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drivers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    full_name text NOT NULL,
    phone text,
    dl_number text,
    dl_expiry date,
    photo_key text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    consent_obtained_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    retired_at timestamp with time zone,
    retired_by uuid,
    retired_reason text,
    CONSTRAINT ck_driver_retired CHECK ((is_active OR (retired_at IS NOT NULL))),
    CONSTRAINT drivers_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'WATCH'::text, 'BLOCKED'::text])))
);


--
-- Name: expected_arrivals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expected_arrivals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    po_id uuid NOT NULL,
    expected_date date NOT NULL,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    slot_booked_by text,
    vehicle_hint public.vehicle_reg_t,
    status text DEFAULT 'EXPECTED'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    supplier_marked_sent_at timestamp with time zone,
    supplier_note text,
    supplier_invoice_no text,
    driver_name text,
    driver_phone text,
    transporter text,
    lr_no text,
    eway_bill_no text,
    mandi_patti_no text,
    CONSTRAINT expected_arrivals_status_check CHECK ((status = ANY (ARRAY['EXPECTED'::text, 'ARRIVED'::text, 'MISSED'::text, 'CANCELLED'::text])))
);


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_categories (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    icon text,
    affects_landed_cost boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: farm_crop_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_crop_cycles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid NOT NULL,
    crop_id uuid NOT NULL,
    product_id uuid,
    cycle_no text NOT NULL,
    area_acre numeric(10,3) NOT NULL,
    sowing_date date NOT NULL,
    duration_days smallint NOT NULL,
    expected_harvest_date date NOT NULL,
    expected_harvest_end_date date NOT NULL,
    expected_yield_kg numeric(14,3) NOT NULL,
    estimated_cost numeric(18,4) DEFAULT 0 NOT NULL,
    harvested_kg numeric(14,3) DEFAULT 0 NOT NULL,
    waste_kg numeric(14,3) DEFAULT 0 NOT NULL,
    dispatched_kg numeric(14,3) DEFAULT 0 NOT NULL,
    received_kg numeric(14,3) DEFAULT 0 NOT NULL,
    loss_kg numeric(14,3) DEFAULT 0 NOT NULL,
    actual_cost numeric(18,4) DEFAULT 0 NOT NULL,
    revenue numeric(18,4) DEFAULT 0 NOT NULL,
    health text DEFAULT 'GREEN'::text NOT NULL,
    health_note text,
    status text DEFAULT 'GROWING'::text NOT NULL,
    first_harvest_at timestamp with time zone,
    closed_at timestamp with time zone,
    closed_by uuid,
    close_reason text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_crop_cycles_area_acre_check CHECK ((area_acre > (0)::numeric)),
    CONSTRAINT farm_crop_cycles_check CHECK ((expected_harvest_date >= sowing_date)),
    CONSTRAINT farm_crop_cycles_check1 CHECK ((expected_harvest_end_date >= expected_harvest_date)),
    CONSTRAINT farm_crop_cycles_health_check CHECK ((health = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))),
    CONSTRAINT farm_crop_cycles_status_check CHECK ((status = ANY (ARRAY['PLANNED'::text, 'GROWING'::text, 'HARVESTING'::text, 'CLOSED'::text, 'FAILED'::text])))
);


--
-- Name: farm_crops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_crops (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    product_id uuid,
    duration_days smallint NOT NULL,
    harvest_window_days smallint DEFAULT 1 NOT NULL,
    yield_per_acre_kg numeric(14,3) NOT NULL,
    seed_cost_per_acre numeric(18,4) DEFAULT 0 NOT NULL,
    input_cost_per_acre numeric(18,4) DEFAULT 0 NOT NULL,
    irrigation_interval_days smallint DEFAULT 4 NOT NULL,
    irrigation_interval_days_hot smallint,
    heat_threshold_c numeric(5,2) DEFAULT 36 NOT NULL,
    inspection_interval_days smallint DEFAULT 7 NOT NULL,
    fertilizer_schedule jsonb DEFAULT '[]'::jsonb NOT NULL,
    spray_schedule jsonb DEFAULT '[]'::jsonb NOT NULL,
    seasons text[] DEFAULT ARRAY['ALL'::text] NOT NULL,
    water_need text DEFAULT 'MEDIUM'::text NOT NULL,
    avoid_after_crop_codes text[] DEFAULT '{}'::text[] NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_crops_duration_days_check CHECK ((duration_days > 0)),
    CONSTRAINT farm_crops_harvest_window_days_check CHECK ((harvest_window_days > 0)),
    CONSTRAINT farm_crops_water_need_check CHECK ((water_need = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text]))),
    CONSTRAINT farm_crops_yield_per_acre_kg_check CHECK ((yield_per_acre_kg > (0)::numeric))
);


--
-- Name: farm_day_closes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_day_closes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    close_date date NOT NULL,
    tasks_total integer DEFAULT 0 NOT NULL,
    tasks_done integer DEFAULT 0 NOT NULL,
    tasks_pending integer DEFAULT 0 NOT NULL,
    tasks_problem integer DEFAULT 0 NOT NULL,
    harvest_kg numeric(14,3) DEFAULT 0 NOT NULL,
    dispatch_kg numeric(14,3) DEFAULT 0 NOT NULL,
    expense_amount numeric(18,4) DEFAULT 0 NOT NULL,
    problems_count integer DEFAULT 0 NOT NULL,
    health text DEFAULT 'GREEN'::text NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    closed_by uuid,
    closed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT farm_day_closes_health_check CHECK ((health = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text])))
);


--
-- Name: farm_dispatch_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_dispatch_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    dispatch_id uuid NOT NULL,
    harvest_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    product_id uuid NOT NULL,
    grade text NOT NULL,
    dispatch_weight_kg numeric(14,3) NOT NULL,
    received_weight_kg numeric(14,3),
    crate_count integer DEFAULT 0 NOT NULL,
    rate_per_kg numeric(18,6),
    batch_id uuid,
    CONSTRAINT farm_dispatch_lines_dispatch_weight_kg_check CHECK ((dispatch_weight_kg > (0)::numeric)),
    CONSTRAINT farm_dispatch_lines_grade_check CHECK ((grade = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'WASTE'::text])))
);


--
-- Name: farm_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_dispatches (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    dispatch_no text NOT NULL,
    dispatch_date date DEFAULT CURRENT_DATE NOT NULL,
    vehicle_id uuid,
    vehicle_reg text,
    driver_name text,
    dispatch_weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    received_weight_kg numeric(14,3),
    variance_kg numeric(14,3),
    variance_pct numeric(9,4),
    variance_band text,
    variance_reason text,
    status text DEFAULT 'DISPATCHED'::text NOT NULL,
    dispatched_by uuid,
    received_by uuid,
    received_at timestamp with time zone,
    idempotency_key text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_dispatches_status_check CHECK ((status = ANY (ARRAY['DISPATCHED'::text, 'RECEIVED'::text, 'CANCELLED'::text]))),
    CONSTRAINT farm_dispatches_variance_band_check CHECK (((variance_band IS NULL) OR (variance_band = ANY (ARRAY['GREEN'::text, 'AMBER'::text, 'RED'::text, 'CRITICAL'::text]))))
);


--
-- Name: farm_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_expenses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid,
    cycle_id uuid,
    task_id uuid,
    machine_id uuid,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    expense_type text NOT NULL,
    amount numeric(18,4) NOT NULL,
    qty numeric(14,3),
    uom text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT farm_expenses_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT farm_expenses_expense_type_check CHECK ((expense_type = ANY (ARRAY['SEED'::text, 'FERTILIZER'::text, 'PESTICIDE'::text, 'LABOUR'::text, 'WATER'::text, 'ELECTRICITY'::text, 'MACHINE'::text, 'FUEL'::text, 'HARVEST'::text, 'PACKING'::text, 'TRANSPORT'::text, 'RENT'::text, 'OTHER'::text])))
);


--
-- Name: farm_harvest_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_harvest_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    harvest_id uuid NOT NULL,
    grade text NOT NULL,
    weight_kg numeric(14,3) NOT NULL,
    crate_count integer DEFAULT 0 NOT NULL,
    destination text DEFAULT 'RETAIL'::text NOT NULL,
    dispatched_kg numeric(14,3) DEFAULT 0 NOT NULL,
    label_code text,
    CONSTRAINT farm_harvest_lines_destination_check CHECK ((destination = ANY (ARRAY['RETAIL'::text, 'B2B'::text, 'PROCESSING'::text, 'WASTE'::text, 'FARM_HOLD'::text]))),
    CONSTRAINT farm_harvest_lines_grade_check CHECK ((grade = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'WASTE'::text]))),
    CONSTRAINT farm_harvest_lines_weight_kg_check CHECK ((weight_kg >= (0)::numeric))
);


--
-- Name: farm_harvests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_harvests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    product_id uuid,
    harvest_no text NOT NULL,
    harvest_date date DEFAULT CURRENT_DATE NOT NULL,
    crop_age_days smallint,
    gross_weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    tare_weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    net_weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    crate_count integer DEFAULT 0 NOT NULL,
    container_type_id uuid,
    capture_mode text DEFAULT 'MANUAL'::text NOT NULL,
    scale_device_id uuid,
    label_code text,
    status text DEFAULT 'READY'::text NOT NULL,
    harvested_by uuid,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_harvests_capture_mode_check CHECK ((capture_mode = ANY (ARRAY['MANUAL'::text, 'SCALE'::text]))),
    CONSTRAINT farm_harvests_gross_weight_kg_check CHECK ((gross_weight_kg >= (0)::numeric)),
    CONSTRAINT farm_harvests_net_weight_kg_check CHECK ((net_weight_kg >= (0)::numeric)),
    CONSTRAINT farm_harvests_status_check CHECK ((status = ANY (ARRAY['READY'::text, 'PART_DISPATCHED'::text, 'DISPATCHED'::text, 'CANCELLED'::text])))
);


--
-- Name: farm_losses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_losses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid,
    cycle_id uuid,
    loss_date date DEFAULT CURRENT_DATE NOT NULL,
    reason text NOT NULL,
    qty_kg numeric(14,3) DEFAULT 0 NOT NULL,
    estimated_value numeric(18,4) DEFAULT 0 NOT NULL,
    note text,
    reported_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT farm_losses_reason_check CHECK ((reason = ANY (ARRAY['DISEASE'::text, 'PEST'::text, 'WEATHER'::text, 'WATER'::text, 'QUALITY_REJECT'::text, 'HARVEST_DAMAGE'::text, 'SUSPECTED_THEFT'::text, 'OTHER'::text])))
);


--
-- Name: farm_machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_machines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    machine_type text NOT NULL,
    status text DEFAULT 'AVAILABLE'::text NOT NULL,
    last_service_date date,
    service_interval_days smallint DEFAULT 90 NOT NULL,
    next_service_date date,
    status_note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_machines_machine_type_check CHECK ((machine_type = ANY (ARRAY['TRACTOR'::text, 'PUMP'::text, 'SPRAYER'::text, 'TILLER'::text, 'HARVESTER'::text, 'GENERATOR'::text, 'OTHER'::text]))),
    CONSTRAINT farm_machines_status_check CHECK ((status = ANY (ARRAY['AVAILABLE'::text, 'IN_USE'::text, 'MAINTENANCE_DUE'::text, 'BREAKDOWN'::text])))
);


--
-- Name: farm_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_observations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid,
    cycle_id uuid,
    task_id uuid,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    day_number smallint,
    health text NOT NULL,
    stage text,
    issue_code text,
    note text,
    photo_data text,
    photo_mime text,
    observed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT farm_observations_health_check CHECK ((health = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))),
    CONSTRAINT farm_observations_stage_check CHECK (((stage IS NULL) OR (stage = ANY (ARRAY['SOWING'::text, 'GERMINATION'::text, 'VEGETATIVE'::text, 'FLOWERING'::text, 'FRUITING'::text, 'HARVEST'::text]))))
);


--
-- Name: farm_plots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_plots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    code text NOT NULL,
    name text,
    area_acre numeric(10,3) DEFAULT 0 NOT NULL,
    soil_type text,
    irrigation_type text,
    qr_code text NOT NULL,
    status text DEFAULT 'IDLE'::text NOT NULL,
    last_crop_id uuid,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT farm_plots_area_acre_check CHECK ((area_acre >= (0)::numeric)),
    CONSTRAINT farm_plots_irrigation_type_check CHECK (((irrigation_type IS NULL) OR (irrigation_type = ANY (ARRAY['DRIP'::text, 'SPRINKLER'::text, 'FLOOD'::text, 'FURROW'::text, 'MANUAL'::text])))),
    CONSTRAINT farm_plots_status_check CHECK ((status = ANY (ARRAY['IDLE'::text, 'PREPARING'::text, 'CROPPED'::text, 'RESTING'::text, 'RETIRED'::text])))
);


--
-- Name: farm_staff_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_staff_scores (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    tasks_assigned integer DEFAULT 0 NOT NULL,
    tasks_done integer DEFAULT 0 NOT NULL,
    tasks_on_time integer DEFAULT 0 NOT NULL,
    tasks_late integer DEFAULT 0 NOT NULL,
    problems_raised integer DEFAULT 0 NOT NULL,
    red_issues integer DEFAULT 0 NOT NULL,
    harvest_kg numeric(14,3) DEFAULT 0 NOT NULL,
    grade_a_pct numeric(9,4),
    waste_pct numeric(9,4),
    score numeric(5,2) DEFAULT 0 NOT NULL,
    rating text DEFAULT 'GREEN'::text NOT NULL,
    breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT farm_staff_scores_rating_check CHECK ((rating = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text])))
);


--
-- Name: farm_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_tasks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    plot_id uuid,
    cycle_id uuid,
    task_type text NOT NULL,
    title text NOT NULL,
    title_hi text,
    due_date date NOT NULL,
    day_number smallint,
    input_name text,
    planned_qty numeric(14,3),
    input_uom text,
    requires_qty boolean DEFAULT false NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    severity text DEFAULT 'GREEN'::text NOT NULL,
    source text DEFAULT 'CALENDAR'::text NOT NULL,
    dedupe_key text NOT NULL,
    actual_qty numeric(14,3),
    done_at timestamp with time zone,
    done_by uuid,
    note text,
    problem_code text,
    auto_skipped_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_farm_task_problem CHECK (((status <> 'PROBLEM'::text) OR (problem_code IS NOT NULL))),
    CONSTRAINT farm_tasks_problem_code_check CHECK (((problem_code IS NULL) OR (problem_code = ANY (ARRAY['DISEASE'::text, 'PEST'::text, 'WEATHER'::text, 'WATER'::text, 'MACHINE'::text, 'LABOUR'::text, 'INPUT_MISSING'::text, 'OTHER'::text])))),
    CONSTRAINT farm_tasks_severity_check CHECK ((severity = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))),
    CONSTRAINT farm_tasks_source_check CHECK ((source = ANY (ARRAY['CALENDAR'::text, 'WEATHER'::text, 'MANUAL'::text, 'SYSTEM'::text]))),
    CONSTRAINT farm_tasks_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'DONE'::text, 'PROBLEM'::text, 'SKIPPED'::text, 'CANCELLED'::text]))),
    CONSTRAINT farm_tasks_task_type_check CHECK ((task_type = ANY (ARRAY['IRRIGATION'::text, 'FERTILIZER'::text, 'SPRAY'::text, 'INSPECTION'::text, 'WEEDING'::text, 'HARVEST'::text, 'MACHINE'::text, 'OTHER'::text])))
);


--
-- Name: farm_weather; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farm_weather (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    farm_id uuid NOT NULL,
    weather_date date NOT NULL,
    temp_min_c numeric(5,2),
    temp_max_c numeric(5,2),
    rain_mm numeric(8,2) DEFAULT 0 NOT NULL,
    rain_prob_pct numeric(5,2),
    wind_kmph numeric(6,2),
    humidity_pct numeric(5,2),
    condition text,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT farm_weather_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'FORECAST'::text, 'API'::text])))
);


--
-- Name: farms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farms (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid,
    name text,
    khasra_no text,
    village text,
    area_acre numeric(10,3),
    crops text[],
    certifications text[],
    cert_expiry date,
    geo_lat numeric(10,7),
    geo_lng numeric(10,7),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    code text,
    branch_id uuid,
    is_own boolean DEFAULT false NOT NULL,
    water_source text,
    soil_type text,
    default_warehouse_id uuid,
    manager_id uuid,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    notes text,
    CONSTRAINT ck_farm_ownership CHECK (((is_own AND (code IS NOT NULL) AND (branch_id IS NOT NULL)) OR ((NOT is_own) AND (supplier_id IS NOT NULL)))),
    CONSTRAINT ck_farm_status CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))),
    CONSTRAINT ck_farm_water_source CHECK (((water_source IS NULL) OR (water_source = ANY (ARRAY['TUBE_WELL'::text, 'CANAL'::text, 'RIVER'::text, 'POND'::text, 'RAIN_FED'::text, 'DRIP'::text, 'BOREWELL'::text, 'OTHER'::text]))))
);


--
-- Name: gate_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_entries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    gate_no text NOT NULL,
    direction text DEFAULT 'IN'::text NOT NULL,
    po_id uuid,
    expected_arrival_id uuid,
    supplier_id uuid NOT NULL,
    source_type text NOT NULL,
    vehicle_id uuid,
    vehicle_reg_captured public.vehicle_reg_t NOT NULL,
    driver_id uuid,
    driver_name text,
    driver_phone text,
    transporter text,
    seal_no text,
    seal_intact boolean,
    eway_bill_no text,
    eway_generated_at timestamp with time zone,
    eway_valid_until timestamp with time zone,
    eway_vehicle_no public.vehicle_reg_t,
    eway_verified boolean,
    eway_verify_source text,
    supplier_invoice_ref text,
    lr_no text,
    mandi_patti_no text,
    anpr_reading text,
    anpr_confidence numeric(5,4),
    anpr_matched boolean,
    anpr_frame_key text,
    checklist_template_id uuid,
    checklist_result jsonb,
    checklist_score numeric(5,2),
    critical_fail boolean DEFAULT false NOT NULL,
    arrived_at timestamp with time zone DEFAULT now() NOT NULL,
    docs_verified_at timestamp with time zone,
    unloading_start_at timestamp with time zone,
    unloading_end_at timestamp with time zone,
    gate_out_at timestamp with time zone,
    turnaround_minutes integer GENERATED ALWAYS AS (
CASE
    WHEN (gate_out_at IS NOT NULL) THEN ((EXTRACT(epoch FROM (gate_out_at - arrived_at)) / (60)::numeric))::integer
    ELSE NULL::integer
END) STORED,
    detention_minutes integer,
    is_unplanned boolean DEFAULT false NOT NULL,
    exception_reason text,
    exception_approved_by uuid,
    exception_approved_at timestamp with time zone,
    status text DEFAULT 'ARRIVED'::text NOT NULL,
    rejected_reason text,
    locked_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    qc_bin_id uuid,
    qc_parked_at timestamp with time zone,
    qc_released_at timestamp with time zone,
    CONSTRAINT ck_gate_exception CHECK (((po_id IS NOT NULL) OR (is_unplanned = false) OR ((exception_reason IS NOT NULL) AND (exception_approved_by IS NOT NULL)))),
    CONSTRAINT gate_entries_direction_check CHECK ((direction = ANY (ARRAY['IN'::text, 'OUT'::text]))),
    CONSTRAINT gate_entries_eway_verify_source_check CHECK ((eway_verify_source = ANY (ARRAY['GSP_API'::text, 'MANUAL'::text, 'OCR'::text]))),
    CONSTRAINT gate_entries_source_type_check CHECK ((source_type = ANY (ARRAY['FARMER'::text, 'MANDI'::text, 'AADHTI'::text, 'WHOLESALER'::text]))),
    CONSTRAINT gate_entries_status_check CHECK ((status = ANY (ARRAY['ARRIVED'::text, 'WEIGHED'::text, 'QC_PENDING'::text, 'QC_COMPLETE'::text, 'GRN_PENDING'::text, 'COMPLETED'::text, 'REJECTED_AT_GATE'::text, 'CANCELLED'::text])))
);


--
-- Name: gate_entry_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_entry_docs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    gate_entry_id uuid NOT NULL,
    doc_type text NOT NULL,
    file_key text NOT NULL,
    ocr_json jsonb,
    ocr_confidence numeric(5,4),
    ocr_model text,
    verified_by uuid,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT gate_entry_docs_doc_type_check CHECK ((doc_type = ANY (ARRAY['INVOICE'::text, 'EWAY_BILL'::text, 'LR'::text, 'MANDI_PATTI'::text, 'DO'::text, 'WEIGH_SLIP'::text, 'QUALITY_CERT'::text, 'PERMIT'::text, 'OTHER'::text])))
);


--
-- Name: gate_entry_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_entry_photos (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    gate_entry_id uuid NOT NULL,
    kind text NOT NULL,
    file_key text NOT NULL,
    geo_lat numeric(10,7),
    geo_lng numeric(10,7),
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_by uuid,
    device_id text,
    CONSTRAINT gate_entry_photos_kind_check CHECK ((kind = ANY (ARRAY['VEHICLE_FRONT'::text, 'NUMBER_PLATE'::text, 'LOAD_OPEN'::text, 'SEAL'::text, 'DRIVER'::text, 'CONTAINER_INTERIOR'::text, 'DAMAGE'::text, 'OTHER'::text])))
);


--
-- Name: grn_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grn_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    grn_id uuid NOT NULL,
    line_no smallint NOT NULL,
    po_line_id uuid,
    qc_inspection_id uuid,
    product_id uuid NOT NULL,
    uom text NOT NULL,
    received_qty public.qty_amt NOT NULL,
    accepted_qty public.qty_amt DEFAULT 0 NOT NULL,
    rejected_qty public.qty_amt DEFAULT 0 NOT NULL,
    hold_qty public.qty_amt DEFAULT 0 NOT NULL,
    net_weight_kg public.weight_kg,
    container_type_id uuid,
    container_count integer,
    rate public.rate_amt NOT NULL,
    grade text,
    line_value public.money_amt,
    batch_id uuid,
    rejection_reason_code text,
    rejection_action text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_grnline_balance CHECK (((((accepted_qty)::numeric + (rejected_qty)::numeric) + (hold_qty)::numeric) <= ((received_qty)::numeric + 0.001))),
    CONSTRAINT ck_grnline_reject_reason CHECK ((((rejected_qty)::numeric = (0)::numeric) OR (rejection_reason_code IS NOT NULL))),
    CONSTRAINT grn_lines_rejection_action_check CHECK ((rejection_action = ANY (ARRAY['RETURN'::text, 'DESTROY'::text, 'SUPPLIER_COLLECT'::text, 'HOLD'::text])))
);


--
-- Name: grns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grns (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    grn_no text NOT NULL,
    gate_entry_id uuid NOT NULL,
    po_id uuid,
    supplier_id uuid NOT NULL,
    grn_date date DEFAULT CURRENT_DATE NOT NULL,
    posting_date date DEFAULT CURRENT_DATE NOT NULL,
    is_backdated boolean DEFAULT false NOT NULL,
    backdate_approved_by uuid,
    total_received_qty public.qty_amt DEFAULT 0 NOT NULL,
    total_accepted_qty public.qty_amt DEFAULT 0 NOT NULL,
    total_rejected_qty public.qty_amt DEFAULT 0 NOT NULL,
    total_net_weight_kg public.weight_kg,
    total_value public.money_amt,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    posted_at timestamp with time zone,
    posted_by uuid,
    idempotency_key text,
    amended_by_grn_id uuid,
    reversal_of_grn_id uuid,
    amend_reason text,
    is_partial boolean DEFAULT false NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_grn_amend_reason CHECK (((status <> ALL (ARRAY['AMENDED'::text, 'REVERSED'::text])) OR (amend_reason IS NOT NULL))),
    CONSTRAINT ck_grn_backdate CHECK (((is_backdated = false) OR (backdate_approved_by IS NOT NULL))),
    CONSTRAINT ck_grn_posted_fields CHECK (((status <> 'POSTED'::text) OR ((posted_at IS NOT NULL) AND (posted_by IS NOT NULL) AND (idempotency_key IS NOT NULL)))),
    CONSTRAINT grns_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'POSTED'::text, 'AMENDED'::text, 'REVERSED'::text])))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    key text NOT NULL,
    company_id uuid,
    user_id uuid,
    endpoint text NOT NULL,
    request_hash text NOT NULL,
    response_body jsonb,
    status_code smallint,
    state text DEFAULT 'IN_PROGRESS'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT idempotency_keys_state_check CHECK ((state = ANY (ARRAY['IN_PROGRESS'::text, 'COMPLETED'::text, 'FAILED'::text])))
);


--
-- Name: integration_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_log (
    id bigint NOT NULL,
    company_id uuid,
    integration text NOT NULL,
    direction text NOT NULL,
    endpoint text,
    request_summary jsonb,
    response_summary jsonb,
    status_code smallint,
    success boolean NOT NULL,
    latency_ms integer,
    error text,
    retry_count smallint DEFAULT 0 NOT NULL,
    correlation_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_log_direction_check CHECK ((direction = ANY (ARRAY['OUTBOUND'::text, 'INBOUND'::text])))
);


--
-- Name: integration_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_log_id_seq OWNED BY public.integration_log.id;


--
-- Name: invoice_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    line_no smallint NOT NULL,
    raw_description text,
    product_id uuid,
    matched_grn_line_id uuid,
    matched_po_line_id uuid,
    match_confidence numeric(5,4),
    qty public.qty_amt NOT NULL,
    uom text,
    rate public.rate_amt NOT NULL,
    discount public.money_amt,
    tax_rate public.pct,
    tax_amount public.money_amt,
    amount public.money_amt NOT NULL,
    hsn_code public.hsn_t
);


--
-- Name: labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labels (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    label_type text NOT NULL,
    code text NOT NULL,
    qr_payload jsonb NOT NULL,
    container_id uuid,
    actual_weight_kg public.weight_kg,
    printed_at timestamp with time zone,
    printed_by uuid,
    printer_device text,
    reprint_count smallint DEFAULT 0 NOT NULL,
    voided_at timestamp with time zone,
    void_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT labels_label_type_check CHECK ((label_type = ANY (ARRAY['LOT'::text, 'CRATE'::text, 'BOX'::text, 'PALLET'::text])))
);


--
-- Name: landing_cost_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_cost_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    landing_cost_id uuid NOT NULL,
    grn_line_id uuid NOT NULL,
    product_id uuid NOT NULL,
    batch_id uuid,
    accepted_qty public.qty_amt NOT NULL,
    accepted_weight_kg public.weight_kg,
    base_rate public.rate_amt NOT NULL,
    base_value public.money_amt,
    allocated_charges jsonb DEFAULT '{}'::jsonb NOT NULL,
    allocated_total public.money_amt,
    non_creditable_tax public.money_amt,
    wastage_pct public.pct DEFAULT 0 NOT NULL,
    wastage_amount public.money_amt,
    landed_value public.money_amt,
    landed_rate_per_uom public.rate_amt,
    landed_rate_per_kg public.rate_amt,
    prev_landed_rate public.rate_amt,
    rate_change_pct public.pct
);


--
-- Name: landing_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_costs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    grn_id uuid NOT NULL,
    cost_status text NOT NULL,
    base_amount public.money_amt,
    discount_amount public.money_amt,
    total_charges public.money_amt,
    non_creditable_tax public.money_amt,
    wastage_provision public.money_amt,
    total_landed public.money_amt,
    estimated_total public.money_null,
    variance_vs_estimate public.money_null,
    variance_vs_estimate_pct public.pct,
    is_abnormal boolean DEFAULT false NOT NULL,
    margin_risk_flag boolean DEFAULT false NOT NULL,
    snapshot jsonb NOT NULL,
    rule_version text,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by uuid,
    CONSTRAINT landing_costs_cost_status_check CHECK ((cost_status = ANY (ARRAY['ESTIMATED'::text, 'ACTUAL'::text])))
);


--
-- Name: mandis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mandis (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    apmc_code text,
    district text,
    state_code character(2),
    geo_lat numeric(10,7),
    geo_lng numeric(10,7),
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: market_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_prices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid,
    product_id uuid,
    commodity_name text NOT NULL,
    mandi_id uuid,
    market_name text,
    price_date date NOT NULL,
    min_price public.rate_amt,
    max_price public.rate_amt,
    modal_price public.rate_amt,
    arrival_qty public.qty_amt,
    uom text,
    source text DEFAULT 'AGMARKNET'::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT market_prices_source_check CHECK ((source = ANY (ARRAY['AGMARKNET'::text, 'MANUAL'::text, 'SUPPLIER'::text, 'INTERNAL'::text])))
);


--
-- Name: market_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_signals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    product_id uuid NOT NULL,
    signal_date date NOT NULL,
    trend_7d_pct public.pct,
    trend_30d_pct public.pct,
    direction text,
    volatility numeric(8,4),
    demand_score numeric(5,2),
    supply_score numeric(5,2),
    buy_score numeric(5,2),
    risk_score numeric(5,2),
    market_balance_index numeric(6,3),
    market_health_score numeric(5,2),
    weather_impact jsonb,
    data_freshness_at timestamp with time zone,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT market_signals_direction_check CHECK ((direction = ANY (ARRAY['RISING'::text, 'FALLING'::text, 'STABLE'::text, 'VOLATILE'::text])))
);


--
-- Name: match_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.match_results (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    run_by uuid,
    tolerance_profile_id uuid,
    overall text NOT NULL,
    qty_result text,
    rate_result text,
    tax_result text,
    charge_result text,
    qty_variance public.qty_amt,
    rate_variance_pct public.pct,
    tax_variance public.money_null,
    charge_variance public.money_null,
    findings jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_note text,
    is_latest boolean DEFAULT true NOT NULL,
    CONSTRAINT match_results_charge_result_check CHECK ((charge_result = ANY (ARRAY['OK'::text, 'WARN'::text, 'FAIL'::text]))),
    CONSTRAINT match_results_overall_check CHECK ((overall = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'CRITICAL_MISMATCH'::text]))),
    CONSTRAINT match_results_qty_result_check CHECK ((qty_result = ANY (ARRAY['OK'::text, 'WARN'::text, 'FAIL'::text]))),
    CONSTRAINT match_results_rate_result_check CHECK ((rate_result = ANY (ARRAY['OK'::text, 'WARN'::text, 'FAIL'::text]))),
    CONSTRAINT match_results_tax_result_check CHECK ((tax_result = ANY (ARRAY['OK'::text, 'WARN'::text, 'FAIL'::text])))
);


--
-- Name: money_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.money_receipts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    receipt_no text NOT NULL,
    source text NOT NULL,
    warehouse_id uuid,
    payer_name text NOT NULL,
    source_type text,
    source_id uuid,
    amount public.money_amt NOT NULL,
    mode text NOT NULL,
    transaction_ref text,
    received_on date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'DECLARED'::text NOT NULL,
    declared_by uuid,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    confirmed_amount public.money_null,
    dispute_note text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_receipt_dispute CHECK (((status <> 'DISPUTED'::text) OR (dispute_note IS NOT NULL))),
    CONSTRAINT ck_receipt_ref CHECK (((mode = 'CASH'::text) OR (transaction_ref IS NOT NULL))),
    CONSTRAINT money_receipts_amount_check CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT money_receipts_mode_check CHECK ((mode = ANY (ARRAY['CASH'::text, 'UPI'::text, 'BANK'::text, 'CHEQUE'::text, 'CARD'::text]))),
    CONSTRAINT money_receipts_source_check CHECK ((source = ANY (ARRAY['CENTRE'::text, 'CUSTOMER'::text, 'OTHER'::text]))),
    CONSTRAINT money_receipts_status_check CHECK ((status = ANY (ARRAY['DECLARED'::text, 'CONFIRMED'::text, 'DISPUTED'::text, 'CANCELLED'::text])))
);


--
-- Name: mv_landing_cost_trend; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_landing_cost_trend AS
 SELECT lc.company_id,
    lcl.product_id,
    (date_trunc('day'::text, lc.computed_at))::date AS cost_date,
    round(avg((lcl.landed_rate_per_kg)::numeric), 4) AS avg_landed_per_kg,
    min((lcl.landed_rate_per_kg)::numeric) AS min_landed_per_kg,
    max((lcl.landed_rate_per_kg)::numeric) AS max_landed_per_kg,
    sum((lcl.landed_value)::numeric) AS total_landed_value
   FROM (public.landing_costs lc
     JOIN public.landing_cost_lines lcl ON ((lcl.landing_cost_id = lc.id)))
  WHERE (lc.cost_status = 'ACTUAL'::text)
  GROUP BY lc.company_id, lcl.product_id, ((date_trunc('day'::text, lc.computed_at))::date)
  WITH NO DATA;


--
-- Name: mv_purchase_daily; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_purchase_daily AS
 SELECT g.company_id,
    g.branch_id,
    g.posting_date,
    gl.product_id,
    g.supplier_id,
    sum((gl.accepted_qty)::numeric) AS accepted_qty,
    sum((gl.rejected_qty)::numeric) AS rejected_qty,
    sum((gl.net_weight_kg)::numeric) AS net_weight_kg,
    sum((gl.line_value)::numeric) AS purchase_value,
    count(DISTINCT g.id) AS grn_count
   FROM (public.grns g
     JOIN public.grn_lines gl ON ((gl.grn_id = g.id)))
  WHERE (g.status = 'POSTED'::text)
  GROUP BY g.company_id, g.branch_id, g.posting_date, gl.product_id, g.supplier_id
  WITH NO DATA;


--
-- Name: qc_inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_inspections (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    inspection_no text,
    gate_entry_id uuid NOT NULL,
    po_line_id uuid,
    product_id uuid NOT NULL,
    template_id uuid,
    template_version smallint,
    inspector_id uuid NOT NULL,
    inspected_at timestamp with time zone DEFAULT now() NOT NULL,
    lot_size public.qty_amt,
    sample_size public.qty_amt,
    sampling_note text,
    overall_result text NOT NULL,
    received_qty public.qty_amt NOT NULL,
    accepted_qty public.qty_amt DEFAULT 0 NOT NULL,
    rejected_qty public.qty_amt DEFAULT 0 NOT NULL,
    hold_qty public.qty_amt DEFAULT 0 NOT NULL,
    expected_grade text,
    assigned_grade text,
    downgraded_from text,
    downgrade_rate_request_id uuid,
    quality_score numeric(5,2),
    critical_failures text[],
    rejection_reason_codes text[],
    ai_run_id uuid,
    ai_score numeric(5,2),
    ai_grade text,
    ai_confidence numeric(5,4),
    ai_overridden boolean DEFAULT false NOT NULL,
    override_reason text,
    cold_chain_breach boolean DEFAULT false NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    uom text,
    returned_qty public.qty_amt,
    returned_at timestamp with time zone,
    returned_by uuid,
    return_vehicle_reg text,
    return_note text,
    return_outcome text,
    return_seen_at timestamp with time zone,
    CONSTRAINT ck_qc_ai_override CHECK (((ai_overridden = false) OR (override_reason IS NOT NULL))),
    CONSTRAINT ck_qc_downgrade CHECK (((downgraded_from IS NULL) OR (assigned_grade IS NOT NULL))),
    CONSTRAINT ck_qc_qty_balance CHECK (((((accepted_qty)::numeric + (rejected_qty)::numeric) + (hold_qty)::numeric) <= ((received_qty)::numeric + 0.001))),
    CONSTRAINT ck_qc_return_outcome CHECK (((return_outcome IS NULL) OR (return_outcome = ANY (ARRAY['SENT_BACK'::text, 'PART_SENT_BACK'::text, 'DESTROYED'::text, 'KEPT_AT_A_DISCOUNT'::text])))),
    CONSTRAINT ck_qc_return_qty CHECK (((returned_qty IS NULL) OR (((returned_qty)::numeric >= (0)::numeric) AND ((returned_qty)::numeric <= ((rejected_qty)::numeric + 0.001))))),
    CONSTRAINT ck_qc_return_recorded CHECK (((returned_qty IS NULL) OR ((returned_at IS NOT NULL) AND (returned_by IS NOT NULL) AND (return_outcome IS NOT NULL)))),
    CONSTRAINT ck_qc_scored_only_with_template CHECK (((template_id IS NOT NULL) OR (quality_score IS NULL))),
    CONSTRAINT qc_inspections_overall_result_check CHECK ((overall_result = ANY (ARRAY['ACCEPT'::text, 'PARTIAL'::text, 'REJECT'::text, 'HOLD'::text]))),
    CONSTRAINT qc_inspections_quality_score_check CHECK (((quality_score >= (0)::numeric) AND (quality_score <= (100)::numeric)))
);


--
-- Name: COLUMN qc_inspections.template_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qc_inspections.template_id IS 'The checklist used, or NULL where the product has none — the decision is still recorded. See db/45.';


--
-- Name: COLUMN qc_inspections.uom; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qc_inspections.uom IS 'What received/accepted/rejected/hold are counted in — taken from the order line, because that is the unit the supplier is billing in. See db/47.';


--
-- Name: mv_qc_rejection_90d; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_qc_rejection_90d AS
 SELECT q.company_id,
    q.product_id,
    g.supplier_id,
    count(*) AS inspections,
    sum((q.received_qty)::numeric) AS received_qty,
    sum((q.rejected_qty)::numeric) AS rejected_qty,
    round((((100)::numeric * sum((q.rejected_qty)::numeric)) / NULLIF(sum((q.received_qty)::numeric), (0)::numeric)), 2) AS rejection_pct,
    round(avg(q.quality_score), 2) AS avg_quality_score
   FROM (public.qc_inspections q
     JOIN public.gate_entries g ON ((g.id = q.gate_entry_id)))
  WHERE (q.inspected_at >= (now() - '90 days'::interval))
  GROUP BY q.company_id, q.product_id, g.supplier_id
  WITH NO DATA;


--
-- Name: weighments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weighments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    gate_entry_id uuid NOT NULL,
    weighment_no text,
    seq smallint DEFAULT 1 NOT NULL,
    kind text NOT NULL,
    method text DEFAULT 'TWO_WEIGHMENT'::text NOT NULL,
    gross_kg public.weight_kg,
    tare_kg public.weight_kg,
    container_type_id uuid,
    container_count integer,
    container_tare_kg public.weight_kg,
    packing_tare_kg public.weight_kg,
    net_kg public.weight_kg,
    capture_mode text NOT NULL,
    scale_device_id uuid,
    raw_reading text,
    reading_hash text,
    hash_verified boolean,
    stable_ms integer,
    photo_key text,
    expected_kg public.weight_kg,
    variance_kg public.weight_kg,
    variance_pct public.pct,
    tolerance_pct public.pct,
    tolerance_breached boolean DEFAULT false NOT NULL,
    variance_band text,
    variance_reason_code text,
    approved_by uuid,
    approved_at timestamp with time zone,
    approval_reason text,
    reweigh_reason text,
    weighed_by uuid NOT NULL,
    weighed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT ck_weigh_manual_reason CHECK (((capture_mode <> 'MANUAL'::text) OR (raw_reading IS NULL))),
    CONSTRAINT ck_weigh_reweigh_reason CHECK (((kind <> 'REWEIGH'::text) OR (reweigh_reason IS NOT NULL))),
    CONSTRAINT ck_weigh_variance_approval CHECK (((tolerance_breached = false) OR (approved_by IS NOT NULL) OR (kind = 'GROSS'::text))),
    CONSTRAINT weighments_capture_mode_check CHECK ((capture_mode = ANY (ARRAY['SCALE'::text, 'MANUAL'::text]))),
    CONSTRAINT weighments_kind_check CHECK ((kind = ANY (ARRAY['GROSS'::text, 'TARE'::text, 'REWEIGH'::text, 'SAMPLE'::text]))),
    CONSTRAINT weighments_method_check CHECK ((method = ANY (ARRAY['TWO_WEIGHMENT'::text, 'ONE_WEIGHMENT'::text, 'CRATE_COUNT'::text]))),
    CONSTRAINT weighments_variance_band_check CHECK ((variance_band = ANY (ARRAY['GREEN'::text, 'AMBER'::text, 'RED'::text, 'CRITICAL'::text])))
);


--
-- Name: mv_weight_variance_90d; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_weight_variance_90d AS
 SELECT w.company_id,
    g.supplier_id,
    g.vehicle_id,
    w.weighed_by,
    count(*) AS weighments,
    round(avg(abs((w.variance_pct)::numeric)), 3) AS avg_abs_variance_pct,
    count(*) FILTER (WHERE w.tolerance_breached) AS breaches,
    count(*) FILTER (WHERE (w.capture_mode = 'MANUAL'::text)) AS manual_captures
   FROM (public.weighments w
     JOIN public.gate_entries g ON ((g.id = w.gate_entry_id)))
  WHERE ((w.weighed_at >= (now() - '90 days'::interval)) AND (w.variance_pct IS NOT NULL))
  GROUP BY w.company_id, g.supplier_id, g.vehicle_id, w.weighed_by
  WITH NO DATA;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid,
    role_id uuid,
    branch_id uuid,
    alert_id uuid,
    channel text NOT NULL,
    template text NOT NULL,
    payload jsonb,
    locale text DEFAULT 'en'::text NOT NULL,
    send_status text DEFAULT 'QUEUED'::text NOT NULL,
    provider_ref text,
    error text,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    read_at timestamp with time zone,
    acted_at timestamp with time zone,
    CONSTRAINT notifications_channel_check CHECK ((channel = ANY (ARRAY['IN_APP'::text, 'PUSH'::text, 'SMS'::text, 'WHATSAPP'::text, 'EMAIL'::text]))),
    CONSTRAINT notifications_send_status_check CHECK ((send_status = ANY (ARRAY['QUEUED'::text, 'SENT'::text, 'DELIVERED'::text, 'READ'::text, 'FAILED'::text, 'SUPPRESSED'::text])))
);


--
-- Name: number_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.number_series (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    doc_type text NOT NULL,
    fy text NOT NULL,
    prefix text NOT NULL,
    next_no bigint DEFAULT 1 NOT NULL,
    width smallint DEFAULT 6 NOT NULL,
    CONSTRAINT number_series_doc_type_check CHECK ((doc_type = ANY ('{AUD,BATCH,CN,CROP,DN,FDN,GATE,GRN,HARV,IND,INV,ISS,LABEL,PAY,PCK,PIC,PMT,PO,PUT,QC,RCP,REQ,RFQ,WGT}'::text[])))
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id bigint NOT NULL,
    company_id uuid,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    attempts smallint DEFAULT 0 NOT NULL,
    last_error text
);


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbox_id_seq OWNED BY public.outbox.id;


--
-- Name: pack_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pack_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    run_no text NOT NULL,
    packed_on date DEFAULT CURRENT_DATE NOT NULL,
    pack_count integer DEFAULT 0 NOT NULL,
    total_qty public.qty_amt DEFAULT 0 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: packs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    run_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    code text NOT NULL,
    pack_no integer NOT NULL,
    group_label text,
    qty public.qty_amt NOT NULL,
    uom text NOT NULL,
    price public.money_amt NOT NULL,
    grade text,
    status text DEFAULT 'IN_STOCK'::text NOT NULL,
    sold_issue_id uuid,
    sold_at timestamp with time zone,
    void_reason text,
    printed_at timestamp with time zone,
    print_count smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    weight_kg numeric(12,3),
    graded_by uuid,
    graded_at timestamp with time zone,
    qc_note text,
    bin_id uuid,
    stored_at timestamp with time zone,
    stored_by uuid,
    transfer_issue_id uuid,
    dispatched_at timestamp with time zone,
    destination_warehouse_id uuid,
    outbound_rate_used numeric(14,4),
    CONSTRAINT ck_pack_in_transit CHECK (((status = 'IN_TRANSIT'::text) = (transfer_issue_id IS NOT NULL))),
    CONSTRAINT packs_price_check CHECK (((price)::numeric >= (0)::numeric)),
    CONSTRAINT packs_qty_check CHECK (((qty)::numeric > (0)::numeric)),
    CONSTRAINT packs_status_check CHECK ((status = ANY (ARRAY['IN_STOCK'::text, 'IN_TRANSIT'::text, 'SOLD'::text, 'VOID'::text])))
);


--
-- Name: COLUMN packs.destination_warehouse_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.packs.destination_warehouse_id IS 'Where this box was priced to go. NULL means it was priced to sell where it was packed, and carries no delivery cost.';


--
-- Name: COLUMN packs.outbound_rate_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.packs.outbound_rate_used IS 'The per-kilo delivery rate that went into this label. Kept so a price can be explained months later, when the rate has moved.';


--
-- Name: payment_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    request_no text NOT NULL,
    kind text NOT NULL,
    supplier_id uuid,
    payee_user_id uuid,
    payee_name text NOT NULL,
    expense_category_id uuid,
    warehouse_id uuid,
    source_type text,
    source_id uuid,
    amount public.money_amt NOT NULL,
    due_date date,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    note text,
    status text DEFAULT 'REQUESTED'::text NOT NULL,
    paid_amount public.money_amt DEFAULT 0 NOT NULL,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    rejected_by uuid,
    rejected_at timestamp with time zone,
    reject_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    is_system_raised boolean DEFAULT false NOT NULL,
    became_due_at timestamp with time zone,
    due_reason text,
    transport_amount numeric(14,2),
    CONSTRAINT ck_payreq_expense_cat CHECK (((kind <> 'EXPENSE'::text) OR (expense_category_id IS NOT NULL))),
    CONSTRAINT ck_payreq_paid CHECK (((paid_amount)::numeric <= ((amount)::numeric + 0.01))),
    CONSTRAINT ck_payreq_reject CHECK (((status <> 'REJECTED'::text) OR (reject_reason IS NOT NULL))),
    CONSTRAINT ck_payreq_transport CHECK (((transport_amount IS NULL) OR (((transport_amount)::numeric >= (0)::numeric) AND ((transport_amount)::numeric <= (amount)::numeric)))),
    CONSTRAINT payment_requests_amount_check CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT payment_requests_kind_check CHECK ((kind = ANY (ARRAY['SUPPLIER_INVOICE'::text, 'WAGES'::text, 'EXPENSE'::text, 'ADVANCE'::text, 'REFUND'::text, 'TRANSPORT'::text]))),
    CONSTRAINT payment_requests_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'NORMAL'::text, 'HIGH'::text, 'URGENT'::text]))),
    CONSTRAINT payment_requests_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'VERIFIED'::text, 'PART_PAID'::text, 'PAID'::text, 'REJECTED'::text, 'CANCELLED'::text])))
);


--
-- Name: COLUMN payment_requests.is_system_raised; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_requests.is_system_raised IS 'True when a document becoming payable queued this itself. Such a request skips maker-checker on verify, because the document''s own control already ran.';


--
-- Name: COLUMN payment_requests.became_due_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_requests.became_due_at IS 'Set when the goods moved without the money. Finance owes this, it is no longer optional.';


--
-- Name: COLUMN payment_requests.transport_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_requests.transport_amount IS 'The freight inside this request, where the supplier is carrying. Part of amount, not on top of it — so Finance pays one figure and can still see what it is made of.';


--
-- Name: payment_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_status (
    invoice_id uuid NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    payable_amount public.money_amt DEFAULT 0 NOT NULL,
    paid_amount public.money_amt DEFAULT 0 NOT NULL,
    balance public.money_amt DEFAULT 0 NOT NULL,
    due_date date,
    is_blocked boolean DEFAULT false NOT NULL,
    blocked_reason text,
    last_payment_at timestamp with time zone,
    external_ref text,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_source text
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    payment_no text NOT NULL,
    request_id uuid NOT NULL,
    amount public.money_amt NOT NULL,
    mode text NOT NULL,
    transaction_ref text,
    paid_from text,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_by uuid,
    status text DEFAULT 'POSTED'::text NOT NULL,
    reversed_at timestamp with time zone,
    reversed_by uuid,
    reverse_reason text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_payment_ref CHECK (((mode = 'CASH'::text) OR (transaction_ref IS NOT NULL))),
    CONSTRAINT ck_payment_reverse CHECK (((status <> 'REVERSED'::text) OR (reverse_reason IS NOT NULL))),
    CONSTRAINT payments_amount_check CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['POSTED'::text, 'REVERSED'::text])))
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    code text NOT NULL,
    module text NOT NULL,
    entity text NOT NULL,
    action text NOT NULL,
    description text NOT NULL,
    is_data_level boolean DEFAULT false NOT NULL,
    risk_level text DEFAULT 'NORMAL'::text NOT NULL,
    CONSTRAINT permissions_risk_level_check CHECK ((risk_level = ANY (ARRAY['NORMAL'::text, 'SENSITIVE'::text, 'CRITICAL'::text])))
);


--
-- Name: pickups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pickups (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    pickup_no text NOT NULL,
    po_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    warehouse_id uuid,
    pickup_on date NOT NULL,
    window_start time without time zone,
    window_end time without time zone,
    pickup_address text,
    notes text,
    driver_id uuid,
    vehicle_id uuid,
    assigned_at timestamp with time zone,
    accepted_at timestamp with time zone,
    en_route_at timestamp with time zone,
    loaded_at timestamp with time zone,
    delivered_at timestamp with time zone,
    reported_crates integer,
    reported_note text,
    status text DEFAULT 'OFFERED'::text NOT NULL,
    cancel_reason text,
    gate_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    transport_cost numeric(14,2),
    cost_note text,
    CONSTRAINT pickups_status_check CHECK ((status = ANY (ARRAY['OFFERED'::text, 'ASSIGNED'::text, 'EN_ROUTE'::text, 'LOADED'::text, 'DELIVERED'::text, 'CANCELLED'::text])))
);


--
-- Name: COLUMN pickups.transport_cost; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pickups.transport_cost IS 'Our own freight for this collection. Raised with Finance as a TRANSPORT request, the same way a centre transfer raises one.';


--
-- Name: po_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_charges (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    po_id uuid NOT NULL,
    charge_type_id uuid NOT NULL,
    amount public.money_amt NOT NULL,
    allocation_basis text NOT NULL,
    borne_by text DEFAULT 'BUYER'::text NOT NULL,
    is_creditable boolean DEFAULT false NOT NULL,
    third_party_supplier_id uuid,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT po_charges_allocation_basis_check CHECK ((allocation_basis = ANY (ARRAY['VALUE'::text, 'WEIGHT'::text, 'QTY'::text, 'EQUAL'::text, 'MANUAL'::text]))),
    CONSTRAINT po_charges_borne_by_check CHECK ((borne_by = ANY (ARRAY['BUYER'::text, 'SUPPLIER'::text, 'SHARED'::text])))
);


--
-- Name: po_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    po_id uuid NOT NULL,
    line_no smallint NOT NULL,
    requirement_line_id uuid,
    product_id uuid NOT NULL,
    qty public.qty_amt NOT NULL,
    uom text NOT NULL,
    qty_in_base public.qty_amt NOT NULL,
    expected_weight_kg public.weight_kg,
    rate public.rate_amt NOT NULL,
    discount_pct public.pct DEFAULT 0 NOT NULL,
    discount_amount public.money_amt,
    tax_code_id uuid,
    tax_amount public.money_amt,
    line_total public.money_amt,
    expected_grade text,
    received_qty public.qty_amt DEFAULT 0 NOT NULL,
    accepted_qty public.qty_amt DEFAULT 0 NOT NULL,
    rejected_qty public.qty_amt DEFAULT 0 NOT NULL,
    line_status text DEFAULT 'OPEN'::text NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT po_lines_check CHECK ((((accepted_qty)::numeric + (rejected_qty)::numeric) <= ((received_qty)::numeric + 0.001))),
    CONSTRAINT po_lines_line_status_check CHECK ((line_status = ANY (ARRAY['OPEN'::text, 'PART_RECEIVED'::text, 'RECEIVED'::text, 'CLOSED'::text, 'CANCELLED'::text]))),
    CONSTRAINT po_lines_qty_check CHECK (((qty)::numeric > (0)::numeric)),
    CONSTRAINT po_lines_rate_check CHECK (((rate)::numeric >= (0)::numeric))
);


--
-- Name: po_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_revisions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    po_id uuid NOT NULL,
    revision_no smallint NOT NULL,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    diff jsonb NOT NULL,
    reason_code text,
    reason_text text NOT NULL
);


--
-- Name: product_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_aliases (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    product_id uuid NOT NULL,
    alias text NOT NULL,
    source text,
    supplier_id uuid,
    CONSTRAINT product_aliases_source_check CHECK ((source = ANY (ARRAY['SUPPLIER'::text, 'MANDI'::text, 'INVOICE'::text, 'OCR'::text])))
);


--
-- Name: product_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_categories (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    parent_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    segment text NOT NULL,
    default_qc_template_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT product_categories_segment_check CHECK ((segment = ANY (ARRAY['FRUIT'::text, 'VEGETABLE'::text, 'GROCERY'::text, 'DAIRY'::text, 'SPICE'::text, 'GRAIN'::text, 'OTHER'::text])))
);


--
-- Name: product_uoms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_uoms (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    product_id uuid NOT NULL,
    uom text NOT NULL,
    conversion_to_base numeric(18,6) NOT NULL,
    is_purchase_default boolean DEFAULT false NOT NULL,
    CONSTRAINT product_uoms_conversion_to_base_check CHECK ((conversion_to_base > (0)::numeric))
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    name_hi text,
    category_id uuid NOT NULL,
    variety text,
    base_uom text NOT NULL,
    purchase_uom text NOT NULL,
    is_variable_weight boolean DEFAULT false NOT NULL,
    is_perishable boolean DEFAULT true NOT NULL,
    is_batch_tracked boolean DEFAULT true NOT NULL,
    shelf_life_days smallint,
    storage_type text DEFAULT 'AMBIENT'::text NOT NULL,
    storage_temp_min_c numeric(5,2),
    storage_temp_max_c numeric(5,2),
    rotation_rule text DEFAULT 'FEFO'::text NOT NULL,
    hsn_code public.hsn_t,
    tax_code_id uuid,
    min_stock public.qty_amt,
    max_stock public.qty_amt,
    reorder_point public.qty_amt,
    safety_stock_days numeric(6,2) DEFAULT 1,
    lead_time_days numeric(6,2) DEFAULT 1,
    moq public.qty_amt,
    order_multiple public.qty_amt,
    abc_class character(1),
    default_wastage_pct public.pct DEFAULT 0 NOT NULL,
    qc_template_id uuid,
    agmark_grade_scheme text,
    grades_allowed text[] DEFAULT ARRAY['A'::text, 'B'::text, 'C'::text],
    rate_tolerance_pct public.pct,
    qty_tolerance_pct public.pct,
    weight_tolerance_pct public.pct,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    icon text,
    min_margin_pct numeric(6,2),
    sell_price numeric(14,2),
    CONSTRAINT products_abc_class_check CHECK ((abc_class = ANY (ARRAY['A'::bpchar, 'B'::bpchar, 'C'::bpchar]))),
    CONSTRAINT products_rotation_rule_check CHECK ((rotation_rule = ANY (ARRAY['FEFO'::text, 'FIFO'::text, 'LIFO'::text]))),
    CONSTRAINT products_storage_type_check CHECK ((storage_type = ANY (ARRAY['AMBIENT'::text, 'CHILLED'::text, 'COLD'::text, 'FROZEN'::text, 'RIPENING'::text])))
);


--
-- Name: COLUMN products.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.icon IS 'Icon key rendered by web/src/components/icons.tsx. Falls back to the category icon.';


--
-- Name: purchase_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_charges (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    doc_type text NOT NULL,
    doc_id uuid NOT NULL,
    charge_type_id uuid NOT NULL,
    amount public.money_amt NOT NULL,
    allocation_basis text NOT NULL,
    is_creditable boolean DEFAULT false NOT NULL,
    affects_landing_cost boolean DEFAULT true NOT NULL,
    supplier_id uuid,
    reference_no text,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT purchase_charges_allocation_basis_check CHECK ((allocation_basis = ANY (ARRAY['VALUE'::text, 'WEIGHT'::text, 'QTY'::text, 'EQUAL'::text, 'MANUAL'::text]))),
    CONSTRAINT purchase_charges_doc_type_check CHECK ((doc_type = ANY (ARRAY['PO'::text, 'GRN'::text, 'INVOICE'::text, 'MANUAL'::text]))),
    CONSTRAINT purchase_charges_source_check CHECK ((source = ANY (ARRAY['PO'::text, 'GRN'::text, 'INVOICE'::text, 'MANUAL'::text, 'OCR'::text, 'AUTO'::text])))
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    po_no text NOT NULL,
    doc_type text DEFAULT 'PO'::text NOT NULL,
    requirement_id uuid,
    supplier_id uuid NOT NULL,
    source_type text NOT NULL,
    mandi_id uuid,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    expected_date date NOT NULL,
    expected_window_start timestamp with time zone,
    expected_window_end timestamp with time zone,
    delivery_location text,
    delivery_terms text,
    transport_by text,
    payment_terms_days smallint DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    subtotal public.money_amt,
    discount_total public.money_amt,
    charge_total public.money_amt,
    tax_total public.money_amt,
    grand_total public.money_amt,
    estimated_landed_total public.money_amt,
    rate_tolerance_pct public.pct,
    qty_tolerance_pct public.pct,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    revision_no smallint DEFAULT 0 NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    confirmed_at timestamp with time zone,
    closed_at timestamp with time zone,
    cancel_reason text,
    is_urgent boolean DEFAULT false NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    self_approved boolean DEFAULT false NOT NULL,
    self_approved_reason text,
    supplier_response text DEFAULT 'PENDING'::text NOT NULL,
    supplier_responded_at timestamp with time zone,
    supplier_responded_by uuid,
    supplier_response_note text,
    transport_requested_at timestamp with time zone,
    transport_requested_by uuid,
    transport_request_note text,
    sent_without_payment boolean DEFAULT false NOT NULL,
    sent_without_payment_at timestamp with time zone,
    sent_without_payment_note text,
    CONSTRAINT ck_po_decline_reason CHECK (((supplier_response <> 'DECLINED'::text) OR (supplier_response_note IS NOT NULL))),
    CONSTRAINT ck_po_maker_checker CHECK (((approved_by IS NULL) OR (approved_by <> submitted_by) OR (self_approved AND (self_approved_reason IS NOT NULL)))),
    CONSTRAINT ck_po_supplier_response CHECK ((supplier_response = ANY (ARRAY['PENDING'::text, 'ACCEPTED'::text, 'DECLINED'::text]))),
    CONSTRAINT purchase_orders_doc_type_check CHECK ((doc_type = ANY (ARRAY['PO'::text, 'INDENT'::text]))),
    CONSTRAINT purchase_orders_source_type_check CHECK ((source_type = ANY (ARRAY['FARMER'::text, 'MANDI'::text, 'AADHTI'::text, 'WHOLESALER'::text]))),
    CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text, 'CONFIRMED'::text, 'PART_RECEIVED'::text, 'RECEIVED'::text, 'CLOSED'::text, 'CANCELLED'::text]))),
    CONSTRAINT purchase_orders_transport_by_check CHECK ((transport_by = ANY (ARRAY['SUPPLIER'::text, 'BUYER'::text, 'THIRD_PARTY'::text])))
);


--
-- Name: COLUMN purchase_orders.self_approved; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.purchase_orders.self_approved IS 'True when the submitter approved their own order because their role authority already covered every rule that fired. Never set without a reason.';


--
-- Name: putaway_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.putaway_tasks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    task_no text,
    grn_line_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    qty public.qty_amt NOT NULL,
    weight_kg public.weight_kg,
    rotation_rule text DEFAULT 'FEFO'::text NOT NULL,
    suggested_zone_id uuid,
    suggested_rack_id uuid,
    suggested_bin_id uuid,
    actual_bin_id uuid,
    mismatch_reason text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    scanned_by uuid,
    started_at timestamp with time zone,
    done_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_putaway_mismatch CHECK (((actual_bin_id IS NULL) OR (suggested_bin_id IS NULL) OR (actual_bin_id = suggested_bin_id) OR (mismatch_reason IS NOT NULL))),
    CONSTRAINT putaway_tasks_rotation_rule_check CHECK ((rotation_rule = ANY (ARRAY['FEFO'::text, 'FIFO'::text, 'LIFO'::text]))),
    CONSTRAINT putaway_tasks_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text, 'DONE'::text, 'EXCEPTION'::text, 'CANCELLED'::text])))
);


--
-- Name: qc_lot_grades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_lot_grades (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    inspection_id uuid NOT NULL,
    group_no integer NOT NULL,
    label text,
    grade text NOT NULL,
    container_count integer,
    qty public.qty_amt NOT NULL,
    uom text,
    weight_kg public.weight_kg,
    disposition text DEFAULT 'ACCEPT'::text NOT NULL,
    reason_code text,
    price_factor_pct numeric(5,2) DEFAULT 100 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT qc_lot_grades_disposition_check CHECK ((disposition = ANY (ARRAY['ACCEPT'::text, 'REJECT'::text, 'HOLD'::text]))),
    CONSTRAINT qc_lot_grades_price_factor_pct_check CHECK (((price_factor_pct >= (0)::numeric) AND (price_factor_pct <= (200)::numeric))),
    CONSTRAINT qc_lot_grades_qty_check CHECK (((qty)::numeric > (0)::numeric))
);


--
-- Name: qc_parameters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_parameters (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    template_id uuid NOT NULL,
    seq smallint NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    label_hi text,
    param_type text NOT NULL,
    unit text,
    min_ok numeric(12,4),
    max_ok numeric(12,4),
    options jsonb,
    is_critical boolean DEFAULT false NOT NULL,
    is_mandatory boolean DEFAULT true NOT NULL,
    weight numeric(6,3) DEFAULT 1 NOT NULL,
    requires_photo boolean DEFAULT false NOT NULL,
    ai_assisted boolean DEFAULT false NOT NULL,
    ai_feature_key text,
    help_text text,
    CONSTRAINT qc_parameters_param_type_check CHECK ((param_type = ANY (ARRAY['NUMERIC'::text, 'BOOLEAN'::text, 'SELECT'::text, 'PERCENT'::text, 'COUNT'::text, 'PHOTO'::text, 'TEXT'::text])))
);


--
-- Name: qc_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_photos (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    inspection_id uuid NOT NULL,
    parameter_id uuid,
    file_key text NOT NULL,
    ai_annotations jsonb,
    is_training_candidate boolean DEFAULT true NOT NULL,
    labelled_at timestamp with time zone,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_by uuid
);


--
-- Name: qc_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_results (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    inspection_id uuid NOT NULL,
    parameter_id uuid NOT NULL,
    value_num numeric(12,4),
    value_bool boolean,
    value_text text,
    defect_pct public.pct,
    is_pass boolean NOT NULL,
    is_critical_fail boolean DEFAULT false NOT NULL,
    reason_code text,
    ai_prefilled boolean DEFAULT false NOT NULL,
    ai_value numeric(12,4),
    ai_confidence numeric(5,4),
    inspector_changed boolean DEFAULT false NOT NULL
);


--
-- Name: qc_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    product_id uuid,
    category_id uuid,
    version smallint DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sampling_rule jsonb DEFAULT '{"mode": "SQRT", "min_units": 5, "bulk_points": 3, "skip_lot_enabled": false, "composite_kg_per_tonne": 1, "new_supplier_multiplier": 2, "high_rejection_multiplier": 2}'::jsonb NOT NULL,
    scoring_rule jsonb DEFAULT '{"accept_min": 85, "partial_min": 50, "downgrade_min": 70}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    supersedes_id uuid,
    retired_at timestamp with time zone,
    note text,
    template_version smallint DEFAULT 1 NOT NULL
);


--
-- Name: racks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.racks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    zone_id uuid NOT NULL,
    code text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    qr_code text
);


--
-- Name: reefer_temp_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reefer_temp_logs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    gate_entry_id uuid NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    temp_c numeric(5,2) NOT NULL,
    humidity_pct public.pct,
    source text NOT NULL,
    device_id text,
    probe_point text,
    is_excursion boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reefer_temp_logs_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'IOT'::text, 'FILE'::text, 'PROBE'::text])))
);


--
-- Name: requirement_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requirement_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    line_no smallint NOT NULL,
    product_id uuid NOT NULL,
    uom text NOT NULL,
    current_stock public.qty_amt,
    available_stock public.qty_amt,
    reserved_qty public.qty_amt,
    in_transit_qty public.qty_amt,
    open_po_qty public.qty_amt,
    avg_daily_sale public.qty_amt,
    lead_time_days numeric(6,2),
    min_stock public.qty_amt,
    max_stock public.qty_amt,
    suggested_qty public.qty_amt,
    suggested_by text,
    suggestion_reason jsonb,
    ai_run_id uuid,
    ai_confidence numeric(5,4),
    final_qty public.qty_amt NOT NULL,
    edit_reason text,
    duplicate_warning jsonb,
    advance_order_qty public.qty_amt DEFAULT 0 NOT NULL,
    converted_qty public.qty_amt DEFAULT 0 NOT NULL,
    line_status text DEFAULT 'OPEN'::text NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    pack_size_kg numeric(10,3),
    pack_count integer,
    CONSTRAINT ck_reqline_pack_positive CHECK (((pack_size_kg IS NULL) OR ((pack_size_kg > (0)::numeric) AND (pack_count > 0)))),
    CONSTRAINT ck_reqline_packs CHECK (((pack_size_kg IS NULL) = (pack_count IS NULL))),
    CONSTRAINT requirement_lines_check CHECK (((suggested_qty IS NULL) OR ((final_qty)::numeric = (suggested_qty)::numeric) OR (edit_reason IS NOT NULL))),
    CONSTRAINT requirement_lines_final_qty_check CHECK (((final_qty)::numeric > (0)::numeric)),
    CONSTRAINT requirement_lines_line_status_check CHECK ((line_status = ANY (ARRAY['OPEN'::text, 'PART_CONVERTED'::text, 'CONVERTED'::text, 'CANCELLED'::text]))),
    CONSTRAINT requirement_lines_suggested_by_check CHECK ((suggested_by = ANY (ARRAY['RULE'::text, 'AI'::text, 'NONE'::text])))
);


--
-- Name: COLUMN requirement_lines.pack_size_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.requirement_lines.pack_size_kg IS 'Size of box asked for, in kg. Null means "however you pack it".';


--
-- Name: COLUMN requirement_lines.pack_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.requirement_lines.pack_count IS 'How many boxes of that size. final_qty stays the total, so every existing report is unaffected.';


--
-- Name: requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requirements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    req_no text NOT NULL,
    req_date date DEFAULT CURRENT_DATE NOT NULL,
    required_date date NOT NULL,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    closed_at timestamp with time zone,
    cancel_reason text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    self_approved boolean DEFAULT false NOT NULL,
    self_approved_reason text,
    raised_for_warehouse_id uuid,
    reasoning text,
    CONSTRAINT requirements_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'NORMAL'::text, 'HIGH'::text, 'URGENT'::text]))),
    CONSTRAINT requirements_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'LOW_STOCK'::text, 'MIN_MAX'::text, 'SALES_DEMAND'::text, 'BRANCH_DEMAND'::text, 'WAREHOUSE_DEMAND'::text, 'PENDING_ORDER'::text, 'ADVANCE_ORDER'::text, 'SEASONAL'::text, 'AI_FORECAST'::text, 'SAFETY_STOCK'::text]))),
    CONSTRAINT requirements_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text, 'CONVERTED'::text, 'CLOSED'::text, 'CANCELLED'::text])))
);


--
-- Name: rfqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rfqs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    rfq_no text NOT NULL,
    requirement_id uuid,
    status text DEFAULT 'OPEN'::text NOT NULL,
    valid_till date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT rfqs_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'OPEN'::text, 'CLOSED'::text, 'CANCELLED'::text])))
);


--
-- Name: role_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_limits (
    role_id uuid NOT NULL,
    max_po_value public.money_null,
    max_rate_variance_pct public.pct,
    max_qty_variance_pct public.pct,
    max_weight_variance_pct public.pct,
    max_backdate_days smallint DEFAULT 0 NOT NULL,
    max_approval_level smallint DEFAULT 0 NOT NULL,
    max_invoice_mismatch_value public.money_null,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT role_limits_max_approval_level_check CHECK (((max_approval_level >= 0) AND (max_approval_level <= 3)))
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_code text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by uuid
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: scale_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scale_devices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    code text NOT NULL,
    device_kind text NOT NULL,
    make text,
    model text,
    protocol text,
    baud_rate integer,
    parser_key text,
    capacity_kg public.weight_kg,
    least_count_kg numeric(8,3),
    hmac_key_enc bytea NOT NULL,
    verification_expiry date,
    last_seen_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT scale_devices_device_kind_check CHECK ((device_kind = ANY (ARRAY['WEIGHBRIDGE'::text, 'PLATFORM'::text, 'BENCH'::text]))),
    CONSTRAINT scale_devices_protocol_check CHECK ((protocol = ANY (ARRAY['SERIAL_ASCII'::text, 'MODBUS_RTU'::text, 'TCP'::text, 'HID'::text, 'MANUAL'::text])))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    active_role_id uuid,
    active_branch_id uuid,
    refresh_token_hash text NOT NULL,
    device_fingerprint text,
    user_agent text,
    ip inet,
    panel text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    rotated_from uuid,
    CONSTRAINT sessions_panel_check CHECK ((panel = ANY (ARRAY['OWNER'::text, 'PURCHASE'::text, 'GATE'::text, 'QC'::text, 'WAREHOUSE'::text, 'FINANCE'::text, 'SUPPLIER'::text])))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid,
    scope text DEFAULT 'COMPANY'::text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    data_type text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settings_scope_check CHECK ((scope = ANY (ARRAY['COMPANY'::text, 'BRANCH'::text])))
);


--
-- Name: site_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_agents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    agent_code text NOT NULL,
    hostname text,
    agent_version text,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    api_key_hash text NOT NULL,
    last_heartbeat_at timestamp with time zone,
    buffered_events integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    CONSTRAINT site_agents_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DEGRADED'::text, 'OFFLINE'::text, 'DISABLED'::text])))
);


--
-- Name: stock_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_balances (
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    product_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    qty public.qty_amt DEFAULT 0 NOT NULL,
    weight_kg public.weight_kg DEFAULT 0 NOT NULL,
    reserved_qty public.qty_amt DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_balances_qty_check CHECK (((qty)::numeric >= (0)::numeric))
);


--
-- Name: stock_issue_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_issue_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    line_no integer NOT NULL,
    product_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    qty public.qty_amt NOT NULL,
    weight_kg public.weight_kg,
    uom text NOT NULL,
    rate public.rate_amt,
    value public.money_null,
    landed_rate_per_kg public.rate_amt,
    CONSTRAINT stock_issue_lines_qty_check CHECK (((qty)::numeric > (0)::numeric))
);


--
-- Name: stock_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_issues (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    issue_no text NOT NULL,
    issue_date date DEFAULT CURRENT_DATE NOT NULL,
    reason text NOT NULL,
    party_name text,
    reference_no text,
    total_qty public.qty_amt DEFAULT 0 NOT NULL,
    total_weight_kg public.weight_kg DEFAULT 0 NOT NULL,
    total_value public.money_amt DEFAULT 0 NOT NULL,
    note text,
    status text DEFAULT 'POSTED'::text NOT NULL,
    idempotency_key text,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    posted_by uuid,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    customer_id uuid,
    dest_warehouse_id uuid,
    vehicle_id uuid,
    vehicle_reg text,
    driver_name text,
    transport_cost numeric(14,2),
    dispatched_at timestamp with time zone,
    received_at timestamp with time zone,
    received_by uuid,
    received_note text,
    from_packs boolean DEFAULT false NOT NULL,
    CONSTRAINT ck_issue_cancel CHECK (((status <> 'CANCELLED'::text) OR (cancel_reason IS NOT NULL))),
    CONSTRAINT ck_issue_note CHECK (((reason = 'SALE'::text) OR (note IS NOT NULL))),
    CONSTRAINT stock_issues_reason_check CHECK ((reason = ANY (ARRAY['SALE'::text, 'TRANSFER_OUT'::text, 'WASTAGE'::text, 'RETURN'::text, 'CONSUMPTION'::text, 'ADJUSTMENT'::text]))),
    CONSTRAINT stock_issues_status_check CHECK ((status = ANY ('{CANCELLED,IN_TRANSIT,POSTED,RECEIVED}'::text[])))
);


--
-- Name: stock_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_ledger (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    product_id uuid NOT NULL,
    batch_id uuid,
    bin_id uuid,
    direction text NOT NULL,
    qty public.qty_amt NOT NULL,
    weight_kg public.weight_kg,
    uom text NOT NULL,
    rate public.rate_amt,
    value public.money_null,
    txn_type text NOT NULL,
    ref_type text NOT NULL,
    ref_id uuid NOT NULL,
    ref_line_id uuid,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    posted_by uuid,
    CONSTRAINT stock_ledger_direction_check CHECK ((direction = ANY (ARRAY['IN'::text, 'OUT'::text]))),
    CONSTRAINT stock_ledger_qty_check CHECK (((qty)::numeric > (0)::numeric)),
    CONSTRAINT stock_ledger_txn_type_check CHECK ((txn_type = ANY (ARRAY['GRN'::text, 'GRN_REVERSAL'::text, 'SALE'::text, 'TRANSFER_IN'::text, 'TRANSFER_OUT'::text, 'ADJUSTMENT'::text, 'WASTAGE'::text, 'RETURN'::text, 'CONSUMPTION'::text])))
);


--
-- Name: supplier_defect_trends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_defect_trends (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    product_id uuid,
    defect_code text NOT NULL,
    occurrences_90d integer DEFAULT 0 NOT NULL,
    consecutive_lots integer DEFAULT 0 NOT NULL,
    last_seen_at timestamp with time zone,
    alert_raised boolean DEFAULT false NOT NULL
);


--
-- Name: supplier_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_invoices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    invoice_no text NOT NULL,
    invoice_date date NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    due_date date,
    po_id uuid,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    subtotal public.money_amt,
    discount public.money_amt,
    charges public.money_amt,
    tax_amount public.money_amt,
    total public.money_amt NOT NULL,
    supplier_gstin public.gstin_t,
    place_of_supply character(2),
    irn text,
    eway_bill_no text,
    is_rcm boolean DEFAULT false NOT NULL,
    file_key text,
    file_checksum text,
    ocr_json jsonb,
    ocr_confidence numeric(5,4),
    ocr_model text,
    ocr_arithmetic_ok boolean,
    status text DEFAULT 'PENDING'::text NOT NULL,
    hold_reason text,
    approved_by uuid,
    approved_at timestamp with time zone,
    duplicate_of_id uuid,
    duplicate_score numeric(5,4),
    duplicate_cleared_by uuid,
    duplicate_cleared_reason text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    filed_by_supplier boolean DEFAULT false NOT NULL,
    CONSTRAINT supplier_invoices_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'MATCHED'::text, 'MISMATCH'::text, 'HOLD'::text, 'APPROVED'::text, 'PAYABLE'::text, 'PART_PAID'::text, 'PAID'::text, 'CANCELLED'::text])))
);


--
-- Name: supplier_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_products (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    product_id uuid NOT NULL,
    typical_grade text,
    moq public.qty_amt,
    lead_time_days numeric(6,2),
    last_rate public.rate_amt,
    last_purchase_at timestamp with time zone,
    avg_rejection_pct public.pct,
    is_preferred boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    supplier_code text,
    supplier_name_for_product text,
    tracking_code text,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: COLUMN supplier_products.supplier_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.supplier_products.supplier_code IS 'What the SUPPLIER calls this product on their own paperwork.';


--
-- Name: COLUMN supplier_products.tracking_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.supplier_products.tracking_code IS 'What WE track it by: <supplier code>-<product sku>. Printed on labels; never reissued.';


--
-- Name: supplier_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_quotes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    rfq_id uuid,
    requirement_line_id uuid,
    supplier_id uuid NOT NULL,
    source_type text NOT NULL,
    mandi_id uuid,
    product_id uuid NOT NULL,
    quoted_rate public.rate_amt NOT NULL,
    uom text NOT NULL,
    available_qty public.qty_amt,
    offered_grade text,
    valid_till date,
    payment_terms_days smallint,
    charges jsonb,
    computed_landed_rate public.rate_amt,
    expected_rejection_pct public.pct,
    expected_shortage_pct public.pct,
    credit_cost public.money_null,
    quality_score_hist numeric(5,2),
    on_time_pct_hist public.pct,
    rank smallint,
    ai_score numeric(6,3),
    ai_reason jsonb,
    ai_run_id uuid,
    is_selected boolean DEFAULT false NOT NULL,
    selected_by uuid,
    selection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    quoted_by_supplier boolean DEFAULT false NOT NULL,
    is_standing boolean DEFAULT false NOT NULL,
    note text,
    superseded_at timestamp with time zone,
    CONSTRAINT supplier_quotes_source_type_check CHECK ((source_type = ANY (ARRAY['FARMER'::text, 'MANDI'::text, 'AADHTI'::text, 'WHOLESALER'::text])))
);


--
-- Name: supplier_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_scores (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    product_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    order_count integer DEFAULT 0 NOT NULL,
    on_time_pct public.pct,
    fill_rate_pct public.pct,
    rejection_pct public.pct,
    weight_variance_pct public.pct,
    rate_competitiveness public.pct,
    doc_compliance_pct public.pct,
    avg_response_hours numeric(8,2),
    quality_score_avg numeric(5,2),
    landed_cost_index numeric(8,4),
    trust_score numeric(5,2),
    performance_score numeric(5,2),
    breakdown jsonb,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    legal_name text NOT NULL,
    trade_name text,
    source_type text NOT NULL,
    gstin public.gstin_t,
    pan public.pan_t,
    fssai_lic_no public.fssai_t,
    fssai_expiry date,
    msme_no text,
    is_composition_dealer boolean DEFAULT false NOT NULL,
    is_unregistered boolean DEFAULT false NOT NULL,
    phone text,
    alt_phone text,
    email text,
    address jsonb,
    district text,
    state_code character(2),
    geo_lat numeric(10,7),
    geo_lng numeric(10,7),
    bank_account_enc bytea,
    bank_ifsc text,
    bank_masked text,
    upi_masked text,
    payment_terms_days smallint DEFAULT 0 NOT NULL,
    credit_limit public.money_null,
    default_charge_profile jsonb,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    status_reason text,
    status_changed_at timestamp with time zone,
    status_changed_by uuid,
    trust_score numeric(5,2),
    performance_score numeric(5,2),
    scores_updated_at timestamp with time zone,
    first_purchase_at timestamp with time zone,
    last_purchase_at timestamp with time zone,
    consent_obtained_at timestamp with time zone,
    consent_purpose text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT suppliers_performance_score_check CHECK (((performance_score >= (0)::numeric) AND (performance_score <= (100)::numeric))),
    CONSTRAINT suppliers_source_type_check CHECK ((source_type = ANY (ARRAY['FARMER'::text, 'MANDI'::text, 'AADHTI'::text, 'WHOLESALER'::text]))),
    CONSTRAINT suppliers_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'PREFERRED'::text, 'ON_HOLD'::text, 'BLOCKED'::text]))),
    CONSTRAINT suppliers_trust_score_check CHECK (((trust_score >= (0)::numeric) AND (trust_score <= (100)::numeric)))
);


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    panel text,
    queued_count integer DEFAULT 0 NOT NULL,
    conflict_count integer DEFAULT 0 NOT NULL,
    last_sync_at timestamp with time zone,
    last_error text,
    app_version text
);


--
-- Name: tax_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_codes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    gst_rate public.pct DEFAULT 0 NOT NULL,
    cess_rate public.pct DEFAULT 0 NOT NULL,
    is_input_creditable boolean DEFAULT true NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    effective_to date,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: tolerance_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tolerance_profiles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    qty_tol_pct public.pct DEFAULT 0.5 NOT NULL,
    rate_tol_pct public.pct DEFAULT 1.0 NOT NULL,
    tax_tol_abs public.money_amt DEFAULT 1 NOT NULL,
    charge_tol_pct public.pct DEFAULT 2.0 NOT NULL,
    critical_qty_pct public.pct DEFAULT 5.0 NOT NULL,
    critical_rate_pct public.pct DEFAULT 10.0 NOT NULL,
    applies_to_category_id uuid,
    applies_to_source_type text,
    is_default boolean DEFAULT false NOT NULL
);


--
-- Name: unload_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unload_boxes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    gate_entry_id uuid NOT NULL,
    po_line_id uuid,
    product_id uuid NOT NULL,
    box_no integer NOT NULL,
    weight_kg numeric(12,3) NOT NULL,
    capture_mode text DEFAULT 'MANUAL'::text NOT NULL,
    scale_device_id uuid,
    scanned_code text,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    weighed_by uuid NOT NULL,
    weighed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_box_void CHECK (((voided_at IS NULL) OR (void_reason IS NOT NULL))),
    CONSTRAINT unload_boxes_capture_mode_check CHECK ((capture_mode = ANY (ARRAY['MANUAL'::text, 'DEVICE'::text, 'SCAN'::text]))),
    CONSTRAINT unload_boxes_weight_kg_check CHECK ((weight_kg > (0)::numeric))
);


--
-- Name: uoms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uoms (
    code text NOT NULL,
    name text NOT NULL,
    name_hi text,
    uom_type text NOT NULL,
    base_uom text,
    factor_to_base numeric(18,6) DEFAULT 1 NOT NULL,
    CONSTRAINT uoms_uom_type_check CHECK ((uom_type = ANY (ARRAY['WEIGHT'::text, 'COUNT'::text, 'VOLUME'::text])))
);


--
-- Name: user_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_invites (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: user_permission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permission_overrides (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    permission_code text NOT NULL,
    effect text NOT NULL,
    reason text NOT NULL,
    expires_on date,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_permission_overrides_effect_check CHECK ((effect = ANY (ARRAY['GRANT'::text, 'REVOKE'::text])))
);


--
-- Name: user_role_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role_assignments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    branch_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    warehouse_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    valid_from date DEFAULT CURRENT_DATE NOT NULL,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT user_role_assignments_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    employee_code text,
    full_name text NOT NULL,
    email text,
    phone text,
    password_hash text,
    mfa_secret_enc bytea,
    mfa_enabled boolean DEFAULT false NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    default_branch_id uuid,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    last_login_at timestamp with time zone,
    failed_login_count smallint DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    password_changed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    supplier_id uuid,
    driver_id uuid,
    must_change_password boolean DEFAULT false NOT NULL,
    CONSTRAINT users_check CHECK (((email IS NOT NULL) OR (phone IS NOT NULL))),
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['en'::text, 'hi'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['INVITED'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'DISABLED'::text])))
);


--
-- Name: v_ai_acceptance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_ai_acceptance AS
 SELECT company_id,
    feature_key,
    model_version,
    (date_trunc('week'::text, created_at))::date AS week,
    count(*) AS runs,
    count(*) FILTER (WHERE (accepted IS TRUE)) AS accepted,
    count(*) FILTER (WHERE (accepted IS FALSE)) AS overridden,
    count(*) FILTER (WHERE used_fallback) AS fallbacks,
    round(((100.0 * (count(*) FILTER (WHERE (accepted IS TRUE)))::numeric) / (NULLIF(count(*) FILTER (WHERE (accepted IS NOT NULL)), 0))::numeric), 2) AS acceptance_pct,
    round(avg(confidence), 4) AS avg_confidence,
    round(avg(latency_ms), 0) AS avg_latency_ms
   FROM public.ai_runs
  GROUP BY company_id, feature_key, model_version, ((date_trunc('week'::text, created_at))::date);


--
-- Name: v_batch_unit_cost; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_batch_unit_cost AS
 SELECT b.id AS batch_id,
    b.company_id,
    b.product_id,
    p.base_uom,
        CASE
            WHEN (COALESCE((b.landed_rate_per_kg)::numeric, (0)::numeric) > (0)::numeric) THEN (COALESCE((b.landed_rate)::numeric, (0)::numeric) / (b.landed_rate_per_kg)::numeric)
            ELSE (1)::numeric
        END AS kg_per_purchase_unit,
    round((COALESCE((gl.accepted_qty)::numeric, (b.initial_qty)::numeric, (0)::numeric) * COALESCE((b.landed_rate)::numeric, (0)::numeric)), 4) AS landed_value,
        CASE
            WHEN ((COALESCE((b.initial_qty)::numeric, (0)::numeric) > (0)::numeric) AND (gl.accepted_qty IS NOT NULL)) THEN round((((gl.accepted_qty)::numeric * COALESCE((b.landed_rate)::numeric, (0)::numeric)) / (b.initial_qty)::numeric), 4)
            ELSE COALESCE((b.landed_rate_per_kg)::numeric, (b.landed_rate)::numeric, (0)::numeric)
        END AS landed_per_held_unit
   FROM ((public.batches b
     JOIN public.products p ON ((p.id = b.product_id)))
     LEFT JOIN public.grn_lines gl ON ((gl.id = b.grn_line_id)));


--
-- Name: VIEW v_batch_unit_cost; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_batch_unit_cost IS 'The landed cost of one unit of what we HOLD — what the batch cost divided by what went into stock. Multiplies correctly against stock_balances.qty, packs.qty and stock_issue_lines.qty without knowing what unit they are in. See db/52.';


--
-- Name: v_inbound_freight_per_kg; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_inbound_freight_per_kg AS
 WITH win AS (
         SELECT c.id AS company_id,
            GREATEST(c.overhead_window_days, 1) AS days
           FROM public.companies c
        ), supplier_carried AS (
         SELECT w_1.company_id,
            COALESCE(sum(pr.transport_amount), (0)::numeric) AS freight
           FROM (win w_1
             LEFT JOIN public.payment_requests pr ON (((pr.company_id = w_1.company_id) AND (pr.transport_amount IS NOT NULL) AND (pr.status <> ALL (ARRAY['CANCELLED'::text, 'REJECTED'::text])) AND (pr.requested_at > (now() - ((w_1.days || ' days'::text))::interval)))))
          GROUP BY w_1.company_id
        ), we_collected AS (
         SELECT w_1.company_id,
            COALESCE(sum(pk.transport_cost), (0)::numeric) AS freight
           FROM (win w_1
             LEFT JOIN public.pickups pk ON (((pk.company_id = w_1.company_id) AND (pk.transport_cost IS NOT NULL) AND (pk.status <> 'CANCELLED'::text) AND (pk.created_at > (now() - ((w_1.days || ' days'::text))::interval)))))
          GROUP BY w_1.company_id
        ), received AS (
         SELECT w_1.company_id,
            COALESCE(sum((g.total_net_weight_kg)::numeric), (0)::numeric) AS kg
           FROM (win w_1
             LEFT JOIN public.grns g ON (((g.company_id = w_1.company_id) AND (g.status = 'POSTED'::text) AND (g.posting_date > (CURRENT_DATE - w_1.days)))))
          GROUP BY w_1.company_id
        )
 SELECT w.company_id,
    w.days AS window_days,
    COALESCE(sc.freight, (0)::numeric) AS supplier_carried,
    COALESCE(wc.freight, (0)::numeric) AS we_collected,
    (COALESCE(sc.freight, (0)::numeric) + COALESCE(wc.freight, (0)::numeric)) AS inbound_spend,
    COALESCE(r.kg, (0)::numeric) AS kg_received,
        CASE
            WHEN (COALESCE(r.kg, (0)::numeric) > (0)::numeric) THEN round(((COALESCE(sc.freight, (0)::numeric) + COALESCE(wc.freight, (0)::numeric)) / r.kg), 4)
            ELSE (0)::numeric
        END AS inbound_per_kg
   FROM (((win w
     LEFT JOIN supplier_carried sc ON ((sc.company_id = w.company_id)))
     LEFT JOIN we_collected wc ON ((wc.company_id = w.company_id)))
     LEFT JOIN received r ON ((r.company_id = w.company_id)));


--
-- Name: v_outbound_cost_per_kg; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_outbound_cost_per_kg AS
 WITH win AS (
         SELECT c.id AS company_id,
            GREATEST(c.overhead_window_days, 1) AS days
           FROM public.companies c
        ), moved AS (
         SELECT w_1.company_id,
            COALESCE(sum(si.transport_cost), (0)::numeric) AS freight,
            COALESCE(sum((si.total_weight_kg)::numeric), (0)::numeric) AS kg,
            (count(si.id))::integer AS trips
           FROM (win w_1
             LEFT JOIN public.stock_issues si ON (((si.company_id = w_1.company_id) AND (si.dest_warehouse_id IS NOT NULL) AND (si.status <> 'CANCELLED'::text) AND (si.issue_date > (CURRENT_DATE - w_1.days)))))
          GROUP BY w_1.company_id
        )
 SELECT w.company_id,
    w.days AS window_days,
    COALESCE(m.freight, (0)::numeric) AS outbound_spend,
    COALESCE(m.kg, (0)::numeric) AS kg_moved,
    COALESCE(m.trips, 0) AS trips,
        CASE
            WHEN (COALESCE(m.kg, (0)::numeric) > (0)::numeric) THEN round((COALESCE(m.freight, (0)::numeric) / m.kg), 4)
            ELSE (0)::numeric
        END AS outbound_per_kg
   FROM (win w
     LEFT JOIN moved m ON ((m.company_id = w.company_id)));


--
-- Name: v_overhead_per_kg; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_overhead_per_kg AS
 WITH win AS (
         SELECT c.id AS company_id,
            GREATEST(c.overhead_window_days, 1) AS days
           FROM public.companies c
        ), spend AS (
         SELECT w_1.company_id,
            COALESCE(sum((p.amount)::numeric), (0)::numeric) AS operating_spend
           FROM (((win w_1
             LEFT JOIN public.payment_requests pr ON ((pr.company_id = w_1.company_id)))
             LEFT JOIN public.expense_categories ec ON (((ec.id = pr.expense_category_id) AND ec.affects_landed_cost)))
             LEFT JOIN public.payments p ON (((p.request_id = pr.id) AND (p.status = 'POSTED'::text) AND (p.paid_at > (now() - ((w_1.days || ' days'::text))::interval)))))
          WHERE (ec.id IS NOT NULL)
          GROUP BY w_1.company_id
        ), handled AS (
         SELECT w_1.company_id,
            COALESCE(sum((g.total_net_weight_kg)::numeric), (0)::numeric) AS kg
           FROM (win w_1
             LEFT JOIN public.grns g ON (((g.company_id = w_1.company_id) AND (g.status = 'POSTED'::text) AND (g.posting_date > (CURRENT_DATE - w_1.days)))))
          GROUP BY w_1.company_id
        )
 SELECT w.company_id,
    w.days AS window_days,
    COALESCE(s.operating_spend, (0)::numeric) AS operating_spend,
    COALESCE(h.kg, (0)::numeric) AS kg_handled,
        CASE
            WHEN (COALESCE(h.kg, (0)::numeric) > (0)::numeric) THEN round((COALESCE(s.operating_spend, (0)::numeric) / h.kg), 4)
            ELSE (0)::numeric
        END AS overhead_per_kg
   FROM ((win w
     LEFT JOIN spend s ON ((s.company_id = w.company_id)))
     LEFT JOIN handled h ON ((h.company_id = w.company_id)));


--
-- Name: v_batch_pricing; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_batch_pricing AS
 WITH factor AS (
         SELECT b_1.id AS batch_id,
                CASE
                    WHEN (COALESCE((b_1.landed_rate_per_kg)::numeric, (0)::numeric) > (0)::numeric) THEN (COALESCE((b_1.landed_rate)::numeric, (0)::numeric) / (b_1.landed_rate_per_kg)::numeric)
                    ELSE (1)::numeric
                END AS kg_per_unit
           FROM public.batches b_1
        ), held AS (
         SELECT b_1.id AS batch_id,
                CASE
                    WHEN ((COALESCE((b_1.initial_qty)::numeric, (0)::numeric) > (0)::numeric) AND (COALESCE((gl.net_weight_kg)::numeric, (0)::numeric) > (0)::numeric)) THEN ((gl.net_weight_kg)::numeric / (b_1.initial_qty)::numeric)
                    ELSE (1)::numeric
                END AS kg_per_held_unit
           FROM (public.batches b_1
             LEFT JOIN public.grn_lines gl ON ((gl.id = b_1.grn_line_id)))
        )
 SELECT b.id AS batch_id,
    b.company_id,
    b.product_id,
    p.name AS product_name,
    b.batch_no,
    b.landed_rate,
    b.landed_rate_per_kg,
    o.overhead_per_kg,
    ib.inbound_per_kg,
    ob.outbound_per_kg,
    round(COALESCE((b.landed_rate)::numeric, (0)::numeric), 2) AS cost_to_warehouse,
    round((COALESCE(o.overhead_per_kg, (0)::numeric) * f.kg_per_unit), 2) AS overhead_cost,
    round((COALESCE(ib.inbound_per_kg, (0)::numeric) * f.kg_per_unit), 2) AS freight_in,
    round((COALESCE(ob.outbound_per_kg, (0)::numeric) * f.kg_per_unit), 2) AS cost_to_centre,
    COALESCE((p.default_wastage_pct)::numeric, (0)::numeric) AS wastage_pct,
    COALESCE(p.min_margin_pct, c.default_margin_pct) AS margin_pct,
    round((((COALESCE((b.landed_rate)::numeric, (0)::numeric) + (COALESCE(o.overhead_per_kg, (0)::numeric) * f.kg_per_unit)) + (COALESCE(ib.inbound_per_kg, (0)::numeric) * f.kg_per_unit)) + (COALESCE(ob.outbound_per_kg, (0)::numeric) * f.kg_per_unit)), 2) AS true_cost,
    round((((((COALESCE((b.landed_rate)::numeric, (0)::numeric) + (COALESCE(o.overhead_per_kg, (0)::numeric) * f.kg_per_unit)) + (COALESCE(ib.inbound_per_kg, (0)::numeric) * f.kg_per_unit)) + (COALESCE(ob.outbound_per_kg, (0)::numeric) * f.kg_per_unit)) / GREATEST(((1)::numeric - (COALESCE((p.default_wastage_pct)::numeric, (0)::numeric) / 100.0)), 0.05)) * ((1)::numeric + (COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0))), 2) AS min_sell_price,
    h.kg_per_held_unit,
    p.base_uom,
    round((((uc.landed_per_held_unit + (COALESCE(o.overhead_per_kg, (0)::numeric) * h.kg_per_held_unit)) + (COALESCE(ib.inbound_per_kg, (0)::numeric) * h.kg_per_held_unit)) + (COALESCE(ob.outbound_per_kg, (0)::numeric) * h.kg_per_held_unit)), 4) AS true_cost_per_held_unit,
    round((((((uc.landed_per_held_unit + (COALESCE(o.overhead_per_kg, (0)::numeric) * h.kg_per_held_unit)) + (COALESCE(ib.inbound_per_kg, (0)::numeric) * h.kg_per_held_unit)) + (COALESCE(ob.outbound_per_kg, (0)::numeric) * h.kg_per_held_unit)) / GREATEST(((1)::numeric - (COALESCE((p.default_wastage_pct)::numeric, (0)::numeric) / 100.0)), 0.05)) * ((1)::numeric + (COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0))), 4) AS min_sell_per_held_unit,
    round(((uc.landed_per_held_unit + (COALESCE(o.overhead_per_kg, (0)::numeric) * h.kg_per_held_unit)) + (COALESCE(ib.inbound_per_kg, (0)::numeric) * h.kg_per_held_unit)), 4) AS cost_before_delivery
   FROM ((((((((public.batches b
     JOIN public.products p ON ((p.id = b.product_id)))
     JOIN public.companies c ON ((c.id = b.company_id)))
     JOIN factor f ON ((f.batch_id = b.id)))
     JOIN held h ON ((h.batch_id = b.id)))
     JOIN public.v_batch_unit_cost uc ON ((uc.batch_id = b.id)))
     LEFT JOIN public.v_overhead_per_kg o ON ((o.company_id = b.company_id)))
     LEFT JOIN public.v_inbound_freight_per_kg ib ON ((ib.company_id = b.company_id)))
     LEFT JOIN public.v_outbound_cost_per_kg ob ON ((ob.company_id = b.company_id)));


--
-- Name: v_bin_contents; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_bin_contents AS
 SELECT pk.company_id,
    pk.bin_id,
    b.code AS bin_code,
    r.code AS rack_code,
    pk.warehouse_id,
    pk.product_id,
    pk.grade,
    (count(*))::integer AS packs,
    sum((pk.qty)::numeric) AS qty,
    sum(COALESCE(pk.weight_kg, (0)::numeric)) AS weight_kg,
    min(pk.stored_at) AS first_stored_at
   FROM ((public.packs pk
     JOIN public.bins b ON ((b.id = pk.bin_id)))
     JOIN public.racks r ON ((r.id = b.rack_id)))
  WHERE ((pk.status = 'IN_STOCK'::text) AND (pk.bin_id IS NOT NULL))
  GROUP BY pk.company_id, pk.bin_id, b.code, r.code, pk.warehouse_id, pk.product_id, pk.grade;


--
-- Name: v_bin_fill; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_bin_fill AS
 SELECT bn.id AS bin_id,
    bn.company_id,
    bn.code,
    bn.capacity_kg,
    COALESCE(sum(COALESCE(pk.weight_kg,
        CASE
            WHEN (pk.uom = 'KG'::text) THEN (pk.qty)::numeric
            ELSE NULL::numeric
        END, (0)::numeric)), (0)::numeric) AS fill_kg,
    (count(pk.id))::integer AS boxes,
        CASE
            WHEN ((bn.capacity_kg IS NULL) OR ((bn.capacity_kg)::numeric = (0)::numeric)) THEN NULL::numeric
            ELSE round(((COALESCE(sum(COALESCE(pk.weight_kg,
            CASE
                WHEN (pk.uom = 'KG'::text) THEN (pk.qty)::numeric
                ELSE NULL::numeric
            END, (0)::numeric)), (0)::numeric) / (bn.capacity_kg)::numeric) * (100)::numeric), 1)
        END AS filled_pct,
    GREATEST((0)::numeric, (COALESCE((bn.capacity_kg)::numeric, (0)::numeric) - COALESCE(sum(COALESCE(pk.weight_kg,
        CASE
            WHEN (pk.uom = 'KG'::text) THEN (pk.qty)::numeric
            ELSE NULL::numeric
        END, (0)::numeric)), (0)::numeric))) AS free_kg
   FROM (public.bins bn
     LEFT JOIN public.packs pk ON (((pk.bin_id = bn.id) AND (pk.status = 'IN_STOCK'::text))))
  GROUP BY bn.id, bn.company_id, bn.code, bn.capacity_kg;


--
-- Name: VIEW v_bin_fill; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_bin_fill IS 'What is on a shelf right now, derived from the boxes on it. Use this rather than bins.current_fill_kg, which nothing maintains.';


--
-- Name: warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    storage_types text[] DEFAULT '{AMBIENT}'::text[] NOT NULL,
    has_weighbridge boolean DEFAULT false NOT NULL,
    weighbridge_capacity_kg public.weight_kg,
    weighbridge_stamp_expiry date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    upi_id text,
    upi_payee_name text,
    is_centre boolean DEFAULT false NOT NULL,
    city text,
    address text,
    manager_user_id uuid,
    opened_on date,
    monthly_rent numeric(14,2),
    delivery_rate_per_kg numeric(14,4),
    delivery_rate_note text,
    delivery_rate_set_at timestamp with time zone,
    delivery_rate_set_by uuid,
    CONSTRAINT ck_wh_delivery_rate CHECK (((delivery_rate_per_kg IS NULL) OR (delivery_rate_per_kg >= (0)::numeric))),
    CONSTRAINT warehouses_storage_types_check CHECK ((storage_types <@ ARRAY['AMBIENT'::text, 'CHILLED'::text, 'COLD'::text, 'FROZEN'::text, 'RIPENING'::text]))
);


--
-- Name: COLUMN warehouses.delivery_rate_per_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.warehouses.delivery_rate_per_kg IS 'What it costs to move a kilo from the warehouse to this centre. Set by an admin. NULL means nobody has said, and the actual trips are used instead — which is not the same as a rate of zero. See db/50.';


--
-- Name: v_centre_delivery_rate; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_centre_delivery_rate AS
 WITH win AS (
         SELECT c.id AS company_id,
            GREATEST(c.overhead_window_days, 1) AS days
           FROM public.companies c
        ), actual AS (
         SELECT si.dest_warehouse_id AS warehouse_id,
            sum(si.transport_cost) AS spend,
            sum((si.total_qty)::numeric) AS kg,
            (count(*))::integer AS trips
           FROM (public.stock_issues si
             JOIN win w_1 ON ((w_1.company_id = si.company_id)))
          WHERE ((si.dest_warehouse_id IS NOT NULL) AND (si.transport_cost > (0)::numeric) AND (si.status <> 'CANCELLED'::text) AND (si.issue_date > (CURRENT_DATE - w_1.days)))
          GROUP BY si.dest_warehouse_id
        )
 SELECT w.id AS warehouse_id,
    w.company_id,
    w.name,
    w.is_centre,
    w.delivery_rate_per_kg AS set_rate,
    w.delivery_rate_note,
    w.delivery_rate_set_at,
        CASE
            WHEN (COALESCE(a.kg, (0)::numeric) > (0)::numeric) THEN round((a.spend / a.kg), 4)
            ELSE NULL::numeric
        END AS actual_rate,
    COALESCE(a.trips, 0) AS trips,
    COALESCE(a.spend, (0)::numeric) AS spend,
    COALESCE(a.kg, (0)::numeric) AS kg_moved,
    COALESCE(w.delivery_rate_per_kg,
        CASE
            WHEN (COALESCE(a.kg, (0)::numeric) > (0)::numeric) THEN round((a.spend / a.kg), 4)
            ELSE NULL::numeric
        END, (0)::numeric) AS rate_per_kg,
        CASE
            WHEN (w.delivery_rate_per_kg IS NOT NULL) THEN 'set by an admin'::text
            WHEN (COALESCE(a.kg, (0)::numeric) > (0)::numeric) THEN 'from what the trips cost'::text
            ELSE 'nobody has delivered here yet'::text
        END AS rate_source
   FROM (public.warehouses w
     LEFT JOIN actual a ON ((a.warehouse_id = w.id)));


--
-- Name: VIEW v_centre_delivery_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_centre_delivery_rate IS 'The delivery rate per kilo for each centre — what an admin set, or what the trips actually cost. Use rate_per_kg; the rest is there so a screen can say where the number came from.';


--
-- Name: v_effective_upi; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_effective_upi AS
 SELECT w.id AS warehouse_id,
    w.company_id,
    w.name AS place_name,
    COALESCE(NULLIF(w.upi_id, ''::text), c.upi_id) AS upi_id,
    COALESCE(NULLIF(w.upi_payee_name, ''::text), c.upi_payee_name, c.trade_name) AS payee_name,
    (NULLIF(w.upi_id, ''::text) IS NOT NULL) AS is_own_code
   FROM (public.warehouses w
     JOIN public.companies c ON ((c.id = w.company_id)));


--
-- Name: v_farm_crop_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_farm_crop_status AS
 SELECT c.id AS cycle_id,
    c.company_id,
    c.branch_id,
    c.farm_id,
    c.plot_id,
    c.status,
    c.health,
    f.name AS farm_name,
    pl.code AS plot_code,
    fc.name AS crop_name,
    fc.name_hi AS crop_name_hi,
    c.cycle_no,
    c.product_id,
    c.area_acre,
    c.sowing_date,
    (CURRENT_DATE - c.sowing_date) AS crop_age_days,
    c.duration_days,
    c.expected_harvest_date,
    (c.expected_harvest_date - CURRENT_DATE) AS days_to_harvest,
    c.expected_yield_kg,
    c.harvested_kg,
    c.waste_kg,
    c.dispatched_kg,
    c.estimated_cost,
    c.actual_cost,
    c.revenue,
        CASE
            WHEN (c.harvested_kg > (0)::numeric) THEN round((c.actual_cost / c.harvested_kg), 4)
            ELSE NULL::numeric
        END AS cost_per_kg,
    ( SELECT count(*) AS count
           FROM public.farm_tasks t
          WHERE ((t.cycle_id = c.id) AND (t.status = 'PENDING'::text) AND (t.due_date < CURRENT_DATE))) AS overdue_tasks,
    ( SELECT count(*) AS count
           FROM public.farm_tasks t
          WHERE ((t.cycle_id = c.id) AND (t.status = 'PENDING'::text) AND (t.due_date = CURRENT_DATE))) AS today_tasks,
    ( SELECT count(*) AS count
           FROM public.farm_tasks t
          WHERE ((t.cycle_id = c.id) AND (t.status = 'PROBLEM'::text))) AS open_problems
   FROM (((public.farm_crop_cycles c
     JOIN public.farms f ON ((f.id = c.farm_id)))
     JOIN public.farm_plots pl ON ((pl.id = c.plot_id)))
     JOIN public.farm_crops fc ON ((fc.id = c.crop_id)));


--
-- Name: v_farm_harvest_forecast; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_farm_harvest_forecast AS
 SELECT c.company_id,
    c.product_id,
    p.name AS product_name,
    p.sku,
    (d.day)::date AS harvest_date,
    sum((GREATEST((c.expected_yield_kg - c.harvested_kg), (0)::numeric) / (GREATEST(((c.expected_harvest_end_date - c.expected_harvest_date) + 1), 1))::numeric)) AS expected_kg
   FROM ((public.farm_crop_cycles c
     JOIN public.products p ON ((p.id = c.product_id)))
     CROSS JOIN LATERAL generate_series((GREATEST(c.expected_harvest_date, CURRENT_DATE))::timestamp with time zone, (c.expected_harvest_end_date)::timestamp with time zone, '1 day'::interval) d(day))
  WHERE ((c.status = ANY (ARRAY['GROWING'::text, 'HARVESTING'::text])) AND (c.product_id IS NOT NULL) AND ((d.day)::date <= (CURRENT_DATE + 30)))
  GROUP BY c.company_id, c.product_id, p.name, p.sku, ((d.day)::date);


--
-- Name: v_farm_traceability; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_farm_traceability AS
 SELECT b.id AS batch_id,
    b.company_id,
    b.batch_no,
    b.grade,
    b.product_id,
    p.name AS product_name,
    f.id AS farm_id,
    f.name AS farm_name,
    pl.code AS plot_code,
    fc.name AS crop_name,
    c.cycle_no,
    c.sowing_date,
    c.area_acre,
    h.harvest_no,
    h.harvest_date,
    h.crop_age_days,
    dl.grade AS dispatch_grade,
    d.dispatch_no,
    d.dispatch_date,
    d.received_at,
    dl.dispatch_weight_kg,
    dl.received_weight_kg,
    b.landed_rate_per_kg,
    COALESCE((sb.qty)::numeric, (0)::numeric) AS remaining_qty
   FROM (((((((((public.farm_dispatch_lines dl
     JOIN public.farm_dispatches d ON ((d.id = dl.dispatch_id)))
     JOIN public.farm_harvests h ON ((h.id = dl.harvest_id)))
     JOIN public.farm_crop_cycles c ON ((c.id = dl.cycle_id)))
     JOIN public.farm_crops fc ON ((fc.id = c.crop_id)))
     JOIN public.farm_plots pl ON ((pl.id = c.plot_id)))
     JOIN public.farms f ON ((f.id = c.farm_id)))
     JOIN public.batches b ON ((b.id = dl.batch_id)))
     JOIN public.products p ON ((p.id = b.product_id)))
     LEFT JOIN public.stock_balances sb ON ((sb.batch_id = b.id)))
  WHERE (dl.batch_id IS NOT NULL);


--
-- Name: warehouse_floors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_floors (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    qr_code text
);


--
-- Name: zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zones (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    code text NOT NULL,
    name text,
    storage_type text DEFAULT 'AMBIENT'::text NOT NULL,
    temp_min_c numeric(5,2),
    temp_max_c numeric(5,2),
    humidity_min public.pct,
    humidity_max public.pct,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    floor_id uuid,
    qr_code text,
    purpose text DEFAULT 'STORAGE'::text NOT NULL,
    CONSTRAINT ck_zone_purpose CHECK ((purpose = ANY (ARRAY['STORAGE'::text, 'QC'::text, 'PACKING'::text, 'DISPATCH'::text, 'RETURNS'::text]))),
    CONSTRAINT zones_check CHECK (((temp_min_c IS NULL) OR (temp_max_c IS NULL) OR (temp_min_c <= temp_max_c))),
    CONSTRAINT zones_storage_type_check CHECK ((storage_type = ANY (ARRAY['AMBIENT'::text, 'CHILLED'::text, 'COLD'::text, 'FROZEN'::text, 'RIPENING'::text, 'QUARANTINE'::text])))
);


--
-- Name: v_locations; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_locations AS
 SELECT f.company_id,
    'FLOOR'::text AS level,
    f.id,
    f.qr_code,
    f.code,
    f.name,
    f.warehouse_id,
    NULL::uuid AS parent_id,
    f.is_active,
    ((w.name || ' · '::text) || f.name) AS path
   FROM (public.warehouse_floors f
     JOIN public.warehouses w ON ((w.id = f.warehouse_id)))
UNION ALL
 SELECT z.company_id,
    'SECTION'::text AS level,
    z.id,
    z.qr_code,
    z.code,
    z.name,
    z.warehouse_id,
    z.floor_id AS parent_id,
    z.is_active,
    (((w.name || ' · '::text) || COALESCE((f.name || ' · '::text), ''::text)) || z.name) AS path
   FROM ((public.zones z
     JOIN public.warehouses w ON ((w.id = z.warehouse_id)))
     LEFT JOIN public.warehouse_floors f ON ((f.id = z.floor_id)))
UNION ALL
 SELECT r.company_id,
    'RACK'::text AS level,
    r.id,
    r.qr_code,
    r.code,
    r.code AS name,
    z.warehouse_id,
    r.zone_id AS parent_id,
    r.is_active,
    (((((w.name || ' · '::text) || COALESCE((f.name || ' · '::text), ''::text)) || z.name) || ' · rack '::text) || r.code) AS path
   FROM (((public.racks r
     JOIN public.zones z ON ((z.id = r.zone_id)))
     JOIN public.warehouses w ON ((w.id = z.warehouse_id)))
     LEFT JOIN public.warehouse_floors f ON ((f.id = z.floor_id)))
UNION ALL
 SELECT b.company_id,
    'SHELF'::text AS level,
    b.id,
    b.qr_code,
    b.code,
    b.code AS name,
    z.warehouse_id,
    b.rack_id AS parent_id,
    b.is_active,
    (((((((w.name || ' · '::text) || COALESCE((f.name || ' · '::text), ''::text)) || z.name) || ' · rack '::text) || r.code) || ' · shelf '::text) || b.code) AS path
   FROM ((((public.bins b
     JOIN public.racks r ON ((r.id = b.rack_id)))
     JOIN public.zones z ON ((z.id = r.zone_id)))
     JOIN public.warehouses w ON ((w.id = z.warehouse_id)))
     LEFT JOIN public.warehouse_floors f ON ((f.id = z.floor_id)));


--
-- Name: v_pack_size_demand; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pack_size_demand AS
 SELECT r.company_id,
    r.raised_for_warehouse_id AS warehouse_id,
    w.name AS centre_name,
    rl.product_id,
    p.name AS product_name,
    p.icon,
    rl.pack_size_kg,
    (sum(rl.pack_count))::integer AS boxes_wanted,
    sum((rl.final_qty)::numeric) AS qty_wanted,
    min(r.required_date) AS needed_by,
    max(r.priority) AS priority,
    (count(*))::integer AS requests
   FROM (((public.requirement_lines rl
     JOIN public.requirements r ON ((r.id = rl.requirement_id)))
     JOIN public.products p ON ((p.id = rl.product_id)))
     LEFT JOIN public.warehouses w ON ((w.id = r.raised_for_warehouse_id)))
  WHERE ((rl.pack_size_kg IS NOT NULL) AND (r.status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text])) AND (rl.line_status = ANY (ARRAY['OPEN'::text, 'PART_CONVERTED'::text])))
  GROUP BY r.company_id, r.raised_for_warehouse_id, w.name, rl.product_id, p.name, p.icon, rl.pack_size_kg;


--
-- Name: v_po_progress; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_po_progress AS
 SELECT po.id AS po_id,
    po.company_id,
    po.po_no,
    po.status,
    sum((pl.qty)::numeric) AS ordered_qty,
    sum((pl.received_qty)::numeric) AS received_qty,
    sum((pl.accepted_qty)::numeric) AS accepted_qty,
    sum((pl.rejected_qty)::numeric) AS rejected_qty,
        CASE
            WHEN (sum((pl.qty)::numeric) > (0)::numeric) THEN round((((100)::numeric * sum((pl.received_qty)::numeric)) / sum((pl.qty)::numeric)), 2)
            ELSE NULL::numeric
        END AS fill_pct
   FROM (public.purchase_orders po
     JOIN public.po_lines pl ON ((pl.po_id = po.id)))
  GROUP BY po.id, po.company_id, po.po_no, po.status;


--
-- Name: v_product_pricing; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_product_pricing AS
 WITH live AS (
         SELECT b.company_id,
            b.product_id,
            sum(((b.landed_rate_per_kg)::numeric * GREATEST((b.remaining_qty)::numeric, (0)::numeric))) AS weighted,
            sum(GREATEST((b.remaining_qty)::numeric, (0)::numeric)) AS qty
           FROM public.batches b
          WHERE ((b.status = 'ACTIVE'::text) AND ((b.remaining_qty)::numeric > (0)::numeric) AND (COALESCE((b.landed_rate_per_kg)::numeric, (0)::numeric) > (0)::numeric))
          GROUP BY b.company_id, b.product_id
        ), latest AS (
         SELECT DISTINCT ON (b.company_id, b.product_id) b.company_id,
            b.product_id,
            b.landed_rate_per_kg
           FROM public.batches b
          WHERE (COALESCE((b.landed_rate_per_kg)::numeric, (0)::numeric) > (0)::numeric)
          ORDER BY b.company_id, b.product_id, b.created_at DESC
        ), bought AS (
         SELECT p_1.id AS product_id,
            COALESCE(NULLIF((l_1.weighted / NULLIF(l_1.qty, (0)::numeric)), (0)::numeric), (lt.landed_rate_per_kg)::numeric, (0)::numeric) AS rate
           FROM ((public.products p_1
             LEFT JOIN live l_1 ON ((l_1.product_id = p_1.id)))
             LEFT JOIN latest lt ON ((lt.product_id = p_1.id)))
        )
 SELECT p.id AS product_id,
    p.company_id,
    p.sku,
    p.name AS product_name,
    p.icon,
    p.base_uom,
    p.category_id,
    COALESCE(l.qty, (0)::numeric) AS qty_on_hand,
    round(bt.rate, 2) AS cost_to_warehouse,
    round(COALESCE(o.overhead_per_kg, (0)::numeric), 2) AS overhead_cost,
    round(COALESCE(ib.inbound_per_kg, (0)::numeric), 2) AS freight_in,
    round(COALESCE(ob.outbound_per_kg, (0)::numeric), 2) AS cost_to_centre,
    round((((bt.rate + COALESCE(o.overhead_per_kg, (0)::numeric)) + COALESCE(ib.inbound_per_kg, (0)::numeric)) + COALESCE(ob.outbound_per_kg, (0)::numeric)), 2) AS total_cost,
    COALESCE((p.default_wastage_pct)::numeric, (0)::numeric) AS wastage_pct,
    COALESCE(p.min_margin_pct, c.default_margin_pct) AS margin_pct,
    (p.min_margin_pct IS NOT NULL) AS margin_is_own,
    p.sell_price,
    round((((((bt.rate + COALESCE(o.overhead_per_kg, (0)::numeric)) + COALESCE(ib.inbound_per_kg, (0)::numeric)) + COALESCE(ob.outbound_per_kg, (0)::numeric)) / GREATEST(((1)::numeric - (COALESCE((p.default_wastage_pct)::numeric, (0)::numeric) / 100.0)), 0.05)) * ((1)::numeric + (COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0))), 2) AS min_sell_price
   FROM ((((((public.products p
     JOIN public.companies c ON ((c.id = p.company_id)))
     JOIN bought bt ON ((bt.product_id = p.id)))
     LEFT JOIN live l ON ((l.product_id = p.id)))
     LEFT JOIN public.v_overhead_per_kg o ON ((o.company_id = p.company_id)))
     LEFT JOIN public.v_inbound_freight_per_kg ib ON ((ib.company_id = p.company_id)))
     LEFT JOIN public.v_outbound_cost_per_kg ob ON ((ob.company_id = p.company_id)))
  WHERE p.is_active;


--
-- Name: v_unload_totals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_unload_totals AS
 SELECT company_id,
    gate_entry_id,
    product_id,
    po_line_id,
    (count(*))::integer AS boxes,
    sum(weight_kg) AS net_kg,
    round(avg(weight_kg), 3) AS avg_box_kg,
    min(weight_kg) AS min_box_kg,
    max(weight_kg) AS max_box_kg,
    max(weighed_at) AS last_weighed_at
   FROM public.unload_boxes b
  WHERE (voided_at IS NULL)
  GROUP BY company_id, gate_entry_id, product_id, po_line_id;


--
-- Name: v_qc_holding; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_qc_holding AS
 SELECT g.company_id,
    g.warehouse_id,
    g.id AS gate_entry_id,
    g.gate_no,
    g.status,
    g.qc_bin_id,
    b.code AS bay_code,
    b.qr_code AS bay_qr,
    z.name AS section_name,
    g.qc_parked_at,
    COALESCE(s.trade_name, s.legal_name) AS supplier_name,
    o.po_no,
    COALESCE(t.boxes, 0) AS boxes,
    COALESCE(t.net_kg, (0)::numeric) AS net_kg,
    COALESCE(t.products, 0) AS products,
    (EXTRACT(epoch FROM (now() - COALESCE(g.qc_parked_at, g.arrived_at))) / (60)::numeric) AS waiting_minutes
   FROM ((((((public.gate_entries g
     JOIN public.suppliers s ON ((s.id = g.supplier_id)))
     LEFT JOIN public.purchase_orders o ON ((o.id = g.po_id)))
     LEFT JOIN public.bins b ON ((b.id = g.qc_bin_id)))
     LEFT JOIN public.racks r ON ((r.id = b.rack_id)))
     LEFT JOIN public.zones z ON ((z.id = r.zone_id)))
     LEFT JOIN LATERAL ( SELECT (count(DISTINCT u.product_id))::integer AS products,
            (sum(u.boxes))::integer AS boxes,
            sum(u.net_kg) AS net_kg
           FROM public.v_unload_totals u
          WHERE (u.gate_entry_id = g.id)) t ON (true))
  WHERE ((g.qc_released_at IS NULL) AND (g.status <> ALL (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'REJECTED_AT_GATE'::text])) AND ((g.qc_bin_id IS NOT NULL) OR (g.status = ANY (ARRAY['WEIGHED'::text, 'QC_PENDING'::text, 'QC_COMPLETE'::text, 'GRN_PENDING'::text]))));


--
-- Name: v_qc_rejections; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_qc_rejections AS
 SELECT q.id AS inspection_id,
    q.company_id,
    q.inspection_no,
    q.inspected_at,
    q.warehouse_id,
    w.name AS warehouse_name,
    q.product_id,
    p.name AS product_name,
    p.icon AS product_icon,
    COALESCE(q.uom, l.uom, p.base_uom, 'KG'::text) AS uom,
    q.received_qty,
    q.accepted_qty,
    q.rejected_qty,
    q.hold_qty,
    q.overall_result,
    q.rejection_reason_codes,
    q.remarks,
    o.id AS po_id,
    o.po_no,
    o.supplier_id,
    COALESCE(s.trade_name, s.legal_name) AS supplier_name,
    l.rate AS ordered_rate,
    round(((q.rejected_qty)::numeric * COALESCE((l.rate)::numeric, (0)::numeric)), 2) AS rejected_value,
    q.returned_qty,
    q.returned_at,
    q.return_outcome,
    q.return_vehicle_reg,
    q.return_note,
    q.return_seen_at,
    u.full_name AS returned_by_name,
    (((q.rejected_qty)::numeric > (0)::numeric) AND (q.returned_qty IS NULL)) AS awaiting_decision
   FROM ((((((public.qc_inspections q
     JOIN public.products p ON ((p.id = q.product_id)))
     JOIN public.warehouses w ON ((w.id = q.warehouse_id)))
     LEFT JOIN public.po_lines l ON ((l.id = q.po_line_id)))
     LEFT JOIN public.purchase_orders o ON ((o.id = l.po_id)))
     LEFT JOIN public.suppliers s ON ((s.id = o.supplier_id)))
     LEFT JOIN public.users u ON ((u.id = q.returned_by)))
  WHERE ((q.rejected_qty)::numeric > (0)::numeric);


--
-- Name: VIEW v_qc_rejections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_qc_rejections IS 'Everything QC turned away, with the unit it was measured in and what became of it. The warehouse records the send-back against it; the supplier reads the same rows.';


--
-- Name: v_receiving_pipeline; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_receiving_pipeline AS
 SELECT g.id AS gate_entry_id,
    g.company_id,
    g.branch_id,
    g.warehouse_id,
    g.gate_no,
    g.status,
    g.vehicle_reg_captured,
    s.trade_name AS supplier_name,
    po.po_no,
    g.arrived_at,
    (EXTRACT(epoch FROM (now() - g.arrived_at)) / (60)::numeric) AS age_minutes,
    (( SELECT count(*) AS count
           FROM public.weighments w
          WHERE ((w.gate_entry_id = g.id) AND (w.kind = 'GROSS'::text))) > 0) AS has_gross,
    (( SELECT count(*) AS count
           FROM public.weighments w
          WHERE ((w.gate_entry_id = g.id) AND (w.kind = 'TARE'::text))) > 0) AS has_tare,
    ( SELECT count(*) AS count
           FROM public.qc_inspections q
          WHERE (q.gate_entry_id = g.id)) AS qc_count,
    ( SELECT count(*) AS count
           FROM public.grns gr
          WHERE ((gr.gate_entry_id = g.id) AND (gr.status = 'POSTED'::text))) AS posted_grns,
    g.critical_fail,
    g.is_unplanned
   FROM ((public.gate_entries g
     JOIN public.suppliers s ON ((s.id = g.supplier_id)))
     LEFT JOIN public.purchase_orders po ON ((po.id = g.po_id)))
  WHERE (g.status <> ALL (ARRAY['COMPLETED'::text, 'REJECTED_AT_GATE'::text, 'CANCELLED'::text]));


--
-- Name: v_stock_position; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_position AS
 SELECT b.company_id,
    b.warehouse_id,
    b.product_id,
    p.sku,
    p.name AS product_name,
    b.id AS batch_id,
    b.batch_no,
    b.grade,
    sb.qty,
    sb.weight_kg,
    sb.reserved_qty,
    ((sb.qty)::numeric - (sb.reserved_qty)::numeric) AS available_qty,
    COALESCE(b.predicted_expiry_date, b.expiry_date) AS effective_expiry,
    (COALESCE(b.predicted_expiry_date, b.expiry_date) - CURRENT_DATE) AS days_to_expiry,
    b.landed_rate,
    b.status
   FROM ((public.stock_balances sb
     JOIN public.batches b ON ((b.id = sb.batch_id)))
     JOIN public.products p ON ((p.id = sb.product_id)))
  WHERE ((sb.qty)::numeric > (0)::numeric);


--
-- Name: v_supplier_dues; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_supplier_dues AS
 SELECT pr.id AS request_id,
    pr.company_id,
    pr.branch_id,
    pr.request_no,
    pr.supplier_id,
    pr.payee_name,
    pr.amount,
    pr.paid_amount,
    ((pr.amount)::numeric - (pr.paid_amount)::numeric) AS balance,
    pr.status,
    pr.due_date,
    pr.became_due_at,
    pr.due_reason,
    pr.priority,
    pr.note,
    ((pr.due_date IS NOT NULL) AND (pr.due_date < CURRENT_DATE)) AS overdue,
    GREATEST((CURRENT_DATE - pr.due_date), 0) AS days_overdue,
    o.id AS po_id,
    o.po_no,
    o.sent_without_payment_at,
    i.id AS invoice_id,
    i.invoice_no
   FROM ((public.payment_requests pr
     LEFT JOIN public.supplier_invoices i ON (((pr.source_type = 'supplier_invoice'::text) AND (i.id = pr.source_id))))
     LEFT JOIN public.purchase_orders o ON ((o.id =
        CASE
            WHEN (pr.source_type = 'purchase_order'::text) THEN pr.source_id
            ELSE i.po_id
        END)))
  WHERE ((pr.became_due_at IS NOT NULL) AND (pr.status <> ALL (ARRAY['PAID'::text, 'REJECTED'::text, 'CANCELLED'::text])));


--
-- Name: v_supplier_rates; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_supplier_rates AS
 SELECT q.id AS quote_id,
    q.company_id,
    q.supplier_id,
    COALESCE(s.trade_name, s.legal_name) AS supplier_name,
    s.source_type,
    s.status AS supplier_status,
    q.product_id,
    p.name AS product_name,
    p.sku,
    p.base_uom,
    q.quoted_rate,
    q.uom,
    q.available_qty,
    q.offered_grade,
    q.valid_till,
    q.note,
    q.quoted_by_supplier,
    q.updated_at AS quoted_at,
    ((q.valid_till IS NOT NULL) AND (q.valid_till < CURRENT_DATE)) AS is_stale,
    sp.last_rate AS last_paid_rate,
    sp.last_purchase_at,
    sp.tracking_code,
        CASE
            WHEN ((sp.last_rate IS NOT NULL) AND ((sp.last_rate)::numeric <> (0)::numeric)) THEN round(((((q.quoted_rate)::numeric - (sp.last_rate)::numeric) / (sp.last_rate)::numeric) * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS change_pct
   FROM (((public.supplier_quotes q
     JOIN public.suppliers s ON ((s.id = q.supplier_id)))
     JOIN public.products p ON ((p.id = q.product_id)))
     LEFT JOIN public.supplier_products sp ON (((sp.supplier_id = q.supplier_id) AND (sp.product_id = q.product_id))))
  WHERE (q.is_standing AND (q.superseded_at IS NULL));


--
-- Name: v_user_permissions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_user_permissions AS
 WITH from_roles AS (
         SELECT u.id AS user_id,
            u.company_id,
            rp.permission_code
           FROM ((public.users u
             JOIN public.user_role_assignments ura ON (((ura.user_id = u.id) AND (ura.valid_from <= CURRENT_DATE) AND ((ura.valid_to IS NULL) OR (ura.valid_to >= CURRENT_DATE)))))
             JOIN public.role_permissions rp ON ((rp.role_id = ura.role_id)))
        ), live AS (
         SELECT user_permission_overrides.id,
            user_permission_overrides.company_id,
            user_permission_overrides.user_id,
            user_permission_overrides.permission_code,
            user_permission_overrides.effect,
            user_permission_overrides.reason,
            user_permission_overrides.expires_on,
            user_permission_overrides.granted_by,
            user_permission_overrides.granted_at
           FROM public.user_permission_overrides
          WHERE ((user_permission_overrides.expires_on IS NULL) OR (user_permission_overrides.expires_on >= CURRENT_DATE))
        )
 SELECT user_id,
    company_id,
    permission_code,
    source
   FROM ( SELECT fr.user_id,
            fr.company_id,
            fr.permission_code,
            'ROLE'::text AS source
           FROM from_roles fr
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM live o
                  WHERE ((o.user_id = fr.user_id) AND (o.permission_code = fr.permission_code) AND (o.effect = 'REVOKE'::text)))))
        UNION
         SELECT o.user_id,
            o.company_id,
            o.permission_code,
            'GRANTED'::text
           FROM live o
          WHERE (o.effect = 'GRANT'::text)) p;


--
-- Name: workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    user_id uuid,
    code text NOT NULL,
    full_name text NOT NULL,
    phone text,
    designation text,
    employment text DEFAULT 'DAILY'::text NOT NULL,
    wage_type text DEFAULT 'DAILY'::text NOT NULL,
    wage_rate numeric(14,2) DEFAULT 0 NOT NULL,
    overtime_rate numeric(14,2),
    standard_hours numeric(5,2) DEFAULT 8 NOT NULL,
    joined_on date,
    left_on date,
    id_proof text,
    address text,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT workers_employment_check CHECK ((employment = ANY (ARRAY['PERMANENT'::text, 'DAILY'::text, 'CONTRACT'::text, 'SEASONAL'::text]))),
    CONSTRAINT workers_wage_rate_check CHECK ((wage_rate >= (0)::numeric)),
    CONSTRAINT workers_wage_type_check CHECK ((wage_type = ANY (ARRAY['MONTHLY'::text, 'DAILY'::text, 'HOURLY'::text, 'PIECE'::text])))
);


--
-- Name: v_worker_output; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_worker_output AS
 SELECT w.id AS worker_id,
    w.company_id,
    (COALESCE(b.boxes, (0)::bigint))::integer AS boxes_weighed,
    COALESCE(b.kg, (0)::numeric) AS kg_weighed,
    (COALESCE(p.packs, (0)::bigint))::integer AS boxes_packed,
    (COALESCE(a.counts, (0)::bigint))::integer AS audits_done
   FROM (((public.workers w
     LEFT JOIN ( SELECT unload_boxes.weighed_by,
            count(*) AS boxes,
            sum(unload_boxes.weight_kg) AS kg
           FROM public.unload_boxes
          WHERE ((unload_boxes.voided_at IS NULL) AND (unload_boxes.weighed_at > (now() - '30 days'::interval)))
          GROUP BY unload_boxes.weighed_by) b ON ((b.weighed_by = w.user_id)))
     LEFT JOIN ( SELECT packs.graded_by,
            count(*) AS packs
           FROM public.packs
          WHERE ((packs.graded_by IS NOT NULL) AND (packs.graded_at > (now() - '30 days'::interval)))
          GROUP BY packs.graded_by) p ON ((p.graded_by = w.user_id)))
     LEFT JOIN ( SELECT audit_counts.counted_by,
            count(*) AS counts
           FROM public.audit_counts
          WHERE (audit_counts.counted_at > (now() - '30 days'::interval))
          GROUP BY audit_counts.counted_by) a ON ((a.counted_by = w.user_id)));


--
-- Name: vehicle_trip_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_trip_logs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    gate_entry_id uuid NOT NULL,
    vehicle_id uuid,
    event text NOT NULL,
    event_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    meta jsonb,
    CONSTRAINT vehicle_trip_logs_event_check CHECK ((event = ANY (ARRAY['ARRIVED'::text, 'DOCS_VERIFIED'::text, 'ANPR_CAPTURED'::text, 'CHECKLIST_DONE'::text, 'GROSS_WEIGHED'::text, 'BAY_ASSIGNED'::text, 'UNLOADING_START'::text, 'UNLOADING_END'::text, 'QC_START'::text, 'QC_END'::text, 'TARE_WEIGHED'::text, 'GRN_POSTED'::text, 'DETENTION_START'::text, 'DETENTION_END'::text, 'GATE_OUT'::text])))
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    reg_no public.vehicle_reg_t NOT NULL,
    vehicle_type text DEFAULT 'TRUCK'::text NOT NULL,
    make_model text,
    capacity_kg public.weight_kg,
    is_reefer boolean DEFAULT false NOT NULL,
    reefer_min_temp_c numeric(5,2),
    tare_reference_kg public.weight_kg,
    tare_verified_at timestamp with time zone,
    fitness_expiry date,
    insurance_expiry date,
    puc_expiry date,
    permit_expiry date,
    owner_supplier_id uuid,
    transporter_name text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    status_reason text,
    trips_90d integer DEFAULT 0 NOT NULL,
    avg_weight_variance_pct public.pct,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    retired_at timestamp with time zone,
    retired_by uuid,
    retired_reason text,
    default_seal_no text,
    CONSTRAINT ck_vehicle_retired CHECK ((is_active OR (retired_at IS NOT NULL))),
    CONSTRAINT vehicles_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'WATCH'::text, 'BLOCKED'::text]))),
    CONSTRAINT vehicles_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['TRUCK'::text, 'TEMPO'::text, 'PICKUP'::text, 'TRACTOR'::text, 'REEFER'::text, 'CONTAINER'::text, 'TWO_WHEELER'::text])))
);


--
-- Name: wage_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wage_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    days_present numeric(6,2) DEFAULT 0 NOT NULL,
    days_absent numeric(6,2) DEFAULT 0 NOT NULL,
    days_leave numeric(6,2) DEFAULT 0 NOT NULL,
    hours_worked numeric(8,2) DEFAULT 0 NOT NULL,
    overtime_hours numeric(8,2) DEFAULT 0 NOT NULL,
    base_amount numeric(14,2) DEFAULT 0 NOT NULL,
    overtime_amount numeric(14,2) DEFAULT 0 NOT NULL,
    bonus_amount numeric(14,2) DEFAULT 0 NOT NULL,
    bonus_reason text,
    deductions numeric(14,2) DEFAULT 0 NOT NULL,
    deduction_reason text,
    net_amount numeric(14,2) DEFAULT 0 NOT NULL,
    note text,
    request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT ck_wage_bonus CHECK (((bonus_amount = (0)::numeric) OR (bonus_reason IS NOT NULL))),
    CONSTRAINT ck_wage_deduction CHECK (((deductions = (0)::numeric) OR (deduction_reason IS NOT NULL)))
);


--
-- Name: work_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_queue (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    warehouse_id uuid,
    queue_key text NOT NULL,
    doc_type text NOT NULL,
    doc_id uuid NOT NULL,
    doc_no text,
    title text NOT NULL,
    subtitle text,
    severity text DEFAULT 'normal'::text NOT NULL,
    required_permission text NOT NULL,
    assigned_role_id uuid,
    assigned_user_id uuid,
    sla_due_at timestamp with time zone,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    CONSTRAINT work_queue_queue_key_check CHECK ((queue_key = ANY ('{AI_SUGGESTION,ALERT,APPROVAL,EXPECTED_ARRIVAL,FARM_HARVEST,FARM_RECEIVE,FARM_TASK,FINANCE_EXCEPTION,GRN_PENDING,INVOICE_MATCH,PO_CONFIRM,PUTAWAY_PENDING,QC_PENDING,REQUIREMENT_REVIEW,TRANSPORT_REQUEST,WEIGH_PENDING}'::text[]))),
    CONSTRAINT work_queue_severity_check CHECK ((severity = ANY (ARRAY['normal'::text, 'warn'::text, 'critical'::text])))
);


--
-- Name: worker_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_attendance (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    company_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    on_date date NOT NULL,
    status text DEFAULT 'PRESENT'::text NOT NULL,
    hours numeric(5,2),
    overtime_hours numeric(5,2) DEFAULT 0 NOT NULL,
    is_paid_leave boolean DEFAULT false NOT NULL,
    note text,
    marked_by uuid NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_attendance_status_check CHECK ((status = ANY (ARRAY['PRESENT'::text, 'HALF_DAY'::text, 'ABSENT'::text, 'LEAVE'::text, 'WEEKLY_OFF'::text, 'HOLIDAY'::text])))
);


--
-- Name: audit_log_2026m08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ATTACH PARTITION public.audit_log_2026m08 FOR VALUES FROM ('2026-08-01 00:00:00+05:30') TO ('2026-09-01 00:00:00+05:30');


--
-- Name: audit_log_2026m09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ATTACH PARTITION public.audit_log_2026m09 FOR VALUES FROM ('2026-09-01 00:00:00+05:30') TO ('2026-10-01 00:00:00+05:30');


--
-- Name: audit_log_2026m10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ATTACH PARTITION public.audit_log_2026m10 FOR VALUES FROM ('2026-10-01 00:00:00+05:30') TO ('2026-11-01 00:00:00+05:30');


--
-- Name: audit_log_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ATTACH PARTITION public.audit_log_default DEFAULT;


--
-- Name: integration_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_log ALTER COLUMN id SET DEFAULT nextval('public.integration_log_id_seq'::regclass);


--
-- Name: outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox ALTER COLUMN id SET DEFAULT nextval('public.outbox_id_seq'::regclass);


--
-- Name: aadhtis aadhtis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aadhtis
    ADD CONSTRAINT aadhtis_pkey PRIMARY KEY (id);


--
-- Name: aadhtis aadhtis_supplier_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aadhtis
    ADD CONSTRAINT aadhtis_supplier_id_key UNIQUE (supplier_id);


--
-- Name: ai_feature_flags ai_feature_flags_company_id_feature_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_feature_flags
    ADD CONSTRAINT ai_feature_flags_company_id_feature_key_key UNIQUE (company_id, feature_key);


--
-- Name: ai_feature_flags ai_feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_feature_flags
    ADD CONSTRAINT ai_feature_flags_pkey PRIMARY KEY (id);


--
-- Name: ai_models ai_models_feature_key_model_name_model_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_feature_key_model_name_model_version_key UNIQUE (feature_key, model_name, model_version);


--
-- Name: ai_models ai_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_pkey PRIMARY KEY (id);


--
-- Name: ai_runs ai_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_pkey PRIMARY KEY (id);


--
-- Name: alert_rules alert_rules_company_id_alert_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_company_id_alert_type_key UNIQUE (company_id, alert_type);


--
-- Name: alert_rules alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: approval_rules approval_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_pkey PRIMARY KEY (id);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_counts audit_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_2026m08 audit_log_2026m08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_2026m08
    ADD CONSTRAINT audit_log_2026m08_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_2026m09 audit_log_2026m09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_2026m09
    ADD CONSTRAINT audit_log_2026m09_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_2026m10 audit_log_2026m10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_2026m10
    ADD CONSTRAINT audit_log_2026m10_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_default audit_log_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_default
    ADD CONSTRAINT audit_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_tasks audit_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_pkey PRIMARY KEY (id);


--
-- Name: batches batches_company_id_batch_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_company_id_batch_no_key UNIQUE (company_id, batch_no);


--
-- Name: batches batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_pkey PRIMARY KEY (id);


--
-- Name: bins bins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bins
    ADD CONSTRAINT bins_pkey PRIMARY KEY (id);


--
-- Name: bins bins_rack_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bins
    ADD CONSTRAINT bins_rack_id_code_key UNIQUE (rack_id, code);


--
-- Name: branches branches_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_company_id_code_key UNIQUE (company_id, code);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: centre_day_close centre_day_close_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_pkey PRIMARY KEY (id);


--
-- Name: charge_types charge_types_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charge_types
    ADD CONSTRAINT charge_types_company_id_code_key UNIQUE (company_id, code);


--
-- Name: charge_types charge_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charge_types
    ADD CONSTRAINT charge_types_pkey PRIMARY KEY (id);


--
-- Name: cold_chain_summaries cold_chain_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cold_chain_summaries
    ADD CONSTRAINT cold_chain_summaries_pkey PRIMARY KEY (gate_entry_id);


--
-- Name: companies companies_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_code_key UNIQUE (code);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: container_types container_types_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.container_types
    ADD CONSTRAINT container_types_company_id_code_key UNIQUE (company_id, code);


--
-- Name: container_types container_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.container_types
    ADD CONSTRAINT container_types_pkey PRIMARY KEY (id);


--
-- Name: containers containers_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_company_id_code_key UNIQUE (company_id, code);


--
-- Name: containers containers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_pkey PRIMARY KEY (id);


--
-- Name: credit_debit_notes credit_debit_notes_company_id_note_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_company_id_note_no_key UNIQUE (company_id, note_no);


--
-- Name: credit_debit_notes credit_debit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: demand_forecasts demand_forecasts_branch_id_product_id_forecast_date_run_dat_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecasts
    ADD CONSTRAINT demand_forecasts_branch_id_product_id_forecast_date_run_dat_key UNIQUE (branch_id, product_id, forecast_date, run_date, model_name);


--
-- Name: demand_forecasts demand_forecasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecasts
    ADD CONSTRAINT demand_forecasts_pkey PRIMARY KEY (id);


--
-- Name: demand_signals demand_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_signals
    ADD CONSTRAINT demand_signals_pkey PRIMARY KEY (id);


--
-- Name: device_readings device_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_readings
    ADD CONSTRAINT device_readings_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_company_id_dl_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_company_id_dl_number_key UNIQUE (company_id, dl_number);


--
-- Name: drivers drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);


--
-- Name: expected_arrivals expected_arrivals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expected_arrivals
    ADD CONSTRAINT expected_arrivals_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_company_id_code_key UNIQUE (company_id, code);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: farm_crop_cycles farm_crop_cycles_company_id_cycle_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_company_id_cycle_no_key UNIQUE (company_id, cycle_no);


--
-- Name: farm_crop_cycles farm_crop_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_pkey PRIMARY KEY (id);


--
-- Name: farm_crops farm_crops_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crops
    ADD CONSTRAINT farm_crops_company_id_code_key UNIQUE (company_id, code);


--
-- Name: farm_crops farm_crops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crops
    ADD CONSTRAINT farm_crops_pkey PRIMARY KEY (id);


--
-- Name: farm_day_closes farm_day_closes_farm_id_close_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_day_closes
    ADD CONSTRAINT farm_day_closes_farm_id_close_date_key UNIQUE (farm_id, close_date);


--
-- Name: farm_day_closes farm_day_closes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_day_closes
    ADD CONSTRAINT farm_day_closes_pkey PRIMARY KEY (id);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_dispatch_id_harvest_id_grade_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_dispatch_id_harvest_id_grade_key UNIQUE (dispatch_id, harvest_id, grade);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_pkey PRIMARY KEY (id);


--
-- Name: farm_dispatches farm_dispatches_company_id_dispatch_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_company_id_dispatch_no_key UNIQUE (company_id, dispatch_no);


--
-- Name: farm_dispatches farm_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_pkey PRIMARY KEY (id);


--
-- Name: farm_expenses farm_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_pkey PRIMARY KEY (id);


--
-- Name: farm_harvest_lines farm_harvest_lines_harvest_id_grade_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvest_lines
    ADD CONSTRAINT farm_harvest_lines_harvest_id_grade_key UNIQUE (harvest_id, grade);


--
-- Name: farm_harvest_lines farm_harvest_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvest_lines
    ADD CONSTRAINT farm_harvest_lines_pkey PRIMARY KEY (id);


--
-- Name: farm_harvests farm_harvests_company_id_harvest_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_company_id_harvest_no_key UNIQUE (company_id, harvest_no);


--
-- Name: farm_harvests farm_harvests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_pkey PRIMARY KEY (id);


--
-- Name: farm_losses farm_losses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_pkey PRIMARY KEY (id);


--
-- Name: farm_machines farm_machines_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_machines
    ADD CONSTRAINT farm_machines_company_id_code_key UNIQUE (company_id, code);


--
-- Name: farm_machines farm_machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_machines
    ADD CONSTRAINT farm_machines_pkey PRIMARY KEY (id);


--
-- Name: farm_observations farm_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_pkey PRIMARY KEY (id);


--
-- Name: farm_plots farm_plots_farm_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_plots
    ADD CONSTRAINT farm_plots_farm_id_code_key UNIQUE (farm_id, code);


--
-- Name: farm_plots farm_plots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_plots
    ADD CONSTRAINT farm_plots_pkey PRIMARY KEY (id);


--
-- Name: farm_staff_scores farm_staff_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_staff_scores
    ADD CONSTRAINT farm_staff_scores_pkey PRIMARY KEY (id);


--
-- Name: farm_staff_scores farm_staff_scores_user_id_period_start_period_end_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_staff_scores
    ADD CONSTRAINT farm_staff_scores_user_id_period_start_period_end_key UNIQUE (user_id, period_start, period_end);


--
-- Name: farm_tasks farm_tasks_company_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_company_id_dedupe_key_key UNIQUE (company_id, dedupe_key);


--
-- Name: farm_tasks farm_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_pkey PRIMARY KEY (id);


--
-- Name: farm_weather farm_weather_farm_id_weather_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_weather
    ADD CONSTRAINT farm_weather_farm_id_weather_date_key UNIQUE (farm_id, weather_date);


--
-- Name: farm_weather farm_weather_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_weather
    ADD CONSTRAINT farm_weather_pkey PRIMARY KEY (id);


--
-- Name: farms farms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_pkey PRIMARY KEY (id);


--
-- Name: gate_entries gate_entries_company_id_gate_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_company_id_gate_no_key UNIQUE (company_id, gate_no);


--
-- Name: gate_entries gate_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_pkey PRIMARY KEY (id);


--
-- Name: gate_entry_docs gate_entry_docs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_docs
    ADD CONSTRAINT gate_entry_docs_pkey PRIMARY KEY (id);


--
-- Name: gate_entry_photos gate_entry_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_photos
    ADD CONSTRAINT gate_entry_photos_pkey PRIMARY KEY (id);


--
-- Name: grn_lines grn_lines_grn_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_grn_id_line_no_key UNIQUE (grn_id, line_no);


--
-- Name: grn_lines grn_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_pkey PRIMARY KEY (id);


--
-- Name: grns grns_company_id_grn_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_company_id_grn_no_key UNIQUE (company_id, grn_no);


--
-- Name: grns grns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key);


--
-- Name: integration_log integration_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_log
    ADD CONSTRAINT integration_log_pkey PRIMARY KEY (id);


--
-- Name: invoice_lines invoice_lines_invoice_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_line_no_key UNIQUE (invoice_id, line_no);


--
-- Name: invoice_lines invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: labels labels_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_company_id_code_key UNIQUE (company_id, code);


--
-- Name: labels labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_pkey PRIMARY KEY (id);


--
-- Name: landing_cost_lines landing_cost_lines_landing_cost_id_grn_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_landing_cost_id_grn_line_id_key UNIQUE (landing_cost_id, grn_line_id);


--
-- Name: landing_cost_lines landing_cost_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_pkey PRIMARY KEY (id);


--
-- Name: landing_costs landing_costs_grn_id_cost_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_grn_id_cost_status_key UNIQUE (grn_id, cost_status);


--
-- Name: landing_costs landing_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_pkey PRIMARY KEY (id);


--
-- Name: mandis mandis_company_id_name_district_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mandis
    ADD CONSTRAINT mandis_company_id_name_district_key UNIQUE (company_id, name, district);


--
-- Name: mandis mandis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mandis
    ADD CONSTRAINT mandis_pkey PRIMARY KEY (id);


--
-- Name: market_prices market_prices_commodity_name_market_name_price_date_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_prices
    ADD CONSTRAINT market_prices_commodity_name_market_name_price_date_source_key UNIQUE (commodity_name, market_name, price_date, source);


--
-- Name: market_prices market_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_prices
    ADD CONSTRAINT market_prices_pkey PRIMARY KEY (id);


--
-- Name: market_signals market_signals_company_id_product_id_signal_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_signals
    ADD CONSTRAINT market_signals_company_id_product_id_signal_date_key UNIQUE (company_id, product_id, signal_date);


--
-- Name: market_signals market_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_signals
    ADD CONSTRAINT market_signals_pkey PRIMARY KEY (id);


--
-- Name: match_results match_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_pkey PRIMARY KEY (id);


--
-- Name: money_receipts money_receipts_company_id_receipt_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_company_id_receipt_no_key UNIQUE (company_id, receipt_no);


--
-- Name: money_receipts money_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: number_series number_series_company_id_branch_id_doc_type_fy_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_series
    ADD CONSTRAINT number_series_company_id_branch_id_doc_type_fy_key UNIQUE (company_id, branch_id, doc_type, fy);


--
-- Name: number_series number_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_series
    ADD CONSTRAINT number_series_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: pack_runs pack_runs_company_id_run_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_company_id_run_no_key UNIQUE (company_id, run_no);


--
-- Name: pack_runs pack_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_pkey PRIMARY KEY (id);


--
-- Name: packs packs_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_company_id_code_key UNIQUE (company_id, code);


--
-- Name: packs packs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_pkey PRIMARY KEY (id);


--
-- Name: payment_requests payment_requests_company_id_request_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_company_id_request_no_key UNIQUE (company_id, request_no);


--
-- Name: payment_requests payment_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_pkey PRIMARY KEY (id);


--
-- Name: payment_status payment_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_status
    ADD CONSTRAINT payment_status_pkey PRIMARY KEY (invoice_id);


--
-- Name: payments payments_company_id_payment_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_company_id_payment_no_key UNIQUE (company_id, payment_no);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (code);


--
-- Name: pickups pickups_company_id_pickup_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_company_id_pickup_no_key UNIQUE (company_id, pickup_no);


--
-- Name: pickups pickups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_pkey PRIMARY KEY (id);


--
-- Name: po_charges po_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_charges
    ADD CONSTRAINT po_charges_pkey PRIMARY KEY (id);


--
-- Name: po_lines po_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_pkey PRIMARY KEY (id);


--
-- Name: po_lines po_lines_po_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_po_id_line_no_key UNIQUE (po_id, line_no);


--
-- Name: po_revisions po_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_revisions
    ADD CONSTRAINT po_revisions_pkey PRIMARY KEY (id);


--
-- Name: po_revisions po_revisions_po_id_revision_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_revisions
    ADD CONSTRAINT po_revisions_po_id_revision_no_key UNIQUE (po_id, revision_no);


--
-- Name: product_aliases product_aliases_company_id_alias_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_company_id_alias_source_key UNIQUE (company_id, alias, source);


--
-- Name: product_aliases product_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_pkey PRIMARY KEY (id);


--
-- Name: product_categories product_categories_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_company_id_code_key UNIQUE (company_id, code);


--
-- Name: product_categories product_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (id);


--
-- Name: product_uoms product_uoms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_uoms
    ADD CONSTRAINT product_uoms_pkey PRIMARY KEY (id);


--
-- Name: product_uoms product_uoms_product_id_uom_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_uoms
    ADD CONSTRAINT product_uoms_product_id_uom_key UNIQUE (product_id, uom);


--
-- Name: products products_company_id_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_company_id_sku_key UNIQUE (company_id, sku);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: purchase_charges purchase_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_charges
    ADD CONSTRAINT purchase_charges_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_company_id_po_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_company_id_po_no_key UNIQUE (company_id, po_no);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: putaway_tasks putaway_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_pkey PRIMARY KEY (id);


--
-- Name: qc_inspections qc_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_pkey PRIMARY KEY (id);


--
-- Name: qc_lot_grades qc_lot_grades_inspection_id_group_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_inspection_id_group_no_key UNIQUE (inspection_id, group_no);


--
-- Name: qc_lot_grades qc_lot_grades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_pkey PRIMARY KEY (id);


--
-- Name: qc_parameters qc_parameters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_parameters
    ADD CONSTRAINT qc_parameters_pkey PRIMARY KEY (id);


--
-- Name: qc_parameters qc_parameters_template_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_parameters
    ADD CONSTRAINT qc_parameters_template_id_code_key UNIQUE (template_id, code);


--
-- Name: qc_photos qc_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_photos
    ADD CONSTRAINT qc_photos_pkey PRIMARY KEY (id);


--
-- Name: qc_results qc_results_inspection_id_parameter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_results
    ADD CONSTRAINT qc_results_inspection_id_parameter_id_key UNIQUE (inspection_id, parameter_id);


--
-- Name: qc_results qc_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_results
    ADD CONSTRAINT qc_results_pkey PRIMARY KEY (id);


--
-- Name: qc_templates qc_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_templates
    ADD CONSTRAINT qc_templates_pkey PRIMARY KEY (id);


--
-- Name: racks racks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.racks
    ADD CONSTRAINT racks_pkey PRIMARY KEY (id);


--
-- Name: racks racks_zone_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.racks
    ADD CONSTRAINT racks_zone_id_code_key UNIQUE (zone_id, code);


--
-- Name: reefer_temp_logs reefer_temp_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reefer_temp_logs
    ADD CONSTRAINT reefer_temp_logs_pkey PRIMARY KEY (id);


--
-- Name: requirement_lines requirement_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_pkey PRIMARY KEY (id);


--
-- Name: requirement_lines requirement_lines_requirement_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_requirement_id_line_no_key UNIQUE (requirement_id, line_no);


--
-- Name: requirements requirements_company_id_req_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_company_id_req_no_key UNIQUE (company_id, req_no);


--
-- Name: requirements requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_pkey PRIMARY KEY (id);


--
-- Name: rfqs rfqs_company_id_rfq_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rfqs
    ADD CONSTRAINT rfqs_company_id_rfq_no_key UNIQUE (company_id, rfq_no);


--
-- Name: rfqs rfqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rfqs
    ADD CONSTRAINT rfqs_pkey PRIMARY KEY (id);


--
-- Name: role_limits role_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_limits
    ADD CONSTRAINT role_limits_pkey PRIMARY KEY (role_id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_code);


--
-- Name: roles roles_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_code_key UNIQUE (company_id, code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: scale_devices scale_devices_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_devices
    ADD CONSTRAINT scale_devices_company_id_code_key UNIQUE (company_id, code);


--
-- Name: scale_devices scale_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_devices
    ADD CONSTRAINT scale_devices_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settings settings_company_id_branch_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_company_id_branch_id_key_key UNIQUE NULLS NOT DISTINCT (company_id, branch_id, key);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: site_agents site_agents_company_id_agent_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_agents
    ADD CONSTRAINT site_agents_company_id_agent_code_key UNIQUE (company_id, agent_code);


--
-- Name: site_agents site_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_agents
    ADD CONSTRAINT site_agents_pkey PRIMARY KEY (id);


--
-- Name: stock_balances stock_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_pkey PRIMARY KEY (product_id, batch_id, warehouse_id);


--
-- Name: stock_issue_lines stock_issue_lines_issue_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_issue_id_line_no_key UNIQUE (issue_id, line_no);


--
-- Name: stock_issue_lines stock_issue_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_pkey PRIMARY KEY (id);


--
-- Name: stock_issues stock_issues_company_id_issue_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_company_id_issue_no_key UNIQUE (company_id, issue_no);


--
-- Name: stock_issues stock_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_pkey PRIMARY KEY (id);


--
-- Name: stock_ledger stock_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_pkey PRIMARY KEY (id);


--
-- Name: supplier_defect_trends supplier_defect_trends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_defect_trends
    ADD CONSTRAINT supplier_defect_trends_pkey PRIMARY KEY (id);


--
-- Name: supplier_defect_trends supplier_defect_trends_supplier_id_product_id_defect_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_defect_trends
    ADD CONSTRAINT supplier_defect_trends_supplier_id_product_id_defect_code_key UNIQUE (supplier_id, product_id, defect_code);


--
-- Name: supplier_invoices supplier_invoices_company_id_supplier_id_invoice_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_company_id_supplier_id_invoice_no_key UNIQUE (company_id, supplier_id, invoice_no);


--
-- Name: supplier_invoices supplier_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_pkey PRIMARY KEY (id);


--
-- Name: supplier_products supplier_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_pkey PRIMARY KEY (id);


--
-- Name: supplier_products supplier_products_supplier_id_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_supplier_id_product_id_key UNIQUE (supplier_id, product_id);


--
-- Name: supplier_quotes supplier_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_pkey PRIMARY KEY (id);


--
-- Name: supplier_scores supplier_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_scores
    ADD CONSTRAINT supplier_scores_pkey PRIMARY KEY (id);


--
-- Name: supplier_scores supplier_scores_supplier_id_product_id_period_start_period__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_scores
    ADD CONSTRAINT supplier_scores_supplier_id_product_id_period_start_period__key UNIQUE (supplier_id, product_id, period_start, period_end);


--
-- Name: suppliers suppliers_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_company_id_code_key UNIQUE (company_id, code);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_user_id_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_user_id_device_id_key UNIQUE (user_id, device_id);


--
-- Name: tax_codes tax_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_codes
    ADD CONSTRAINT tax_codes_code_key UNIQUE (code);


--
-- Name: tax_codes tax_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_codes
    ADD CONSTRAINT tax_codes_pkey PRIMARY KEY (id);


--
-- Name: tolerance_profiles tolerance_profiles_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tolerance_profiles
    ADD CONSTRAINT tolerance_profiles_company_id_code_key UNIQUE (company_id, code);


--
-- Name: tolerance_profiles tolerance_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tolerance_profiles
    ADD CONSTRAINT tolerance_profiles_pkey PRIMARY KEY (id);


--
-- Name: unload_boxes unload_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_pkey PRIMARY KEY (id);


--
-- Name: uoms uoms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uoms
    ADD CONSTRAINT uoms_pkey PRIMARY KEY (code);


--
-- Name: worker_attendance uq_attendance; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_attendance
    ADD CONSTRAINT uq_attendance UNIQUE (worker_id, on_date);


--
-- Name: audit_tasks uq_audit_task_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT uq_audit_task_no UNIQUE (company_id, task_no);


--
-- Name: unload_boxes uq_box_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT uq_box_no UNIQUE (gate_entry_id, box_no);


--
-- Name: centre_day_close uq_close_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT uq_close_day UNIQUE (warehouse_id, close_date);


--
-- Name: warehouse_floors uq_floor_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT uq_floor_code UNIQUE (warehouse_id, code);


--
-- Name: stock_ledger uq_ledger_grn_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT uq_ledger_grn_line UNIQUE (ref_type, ref_line_id, txn_type);


--
-- Name: user_permission_overrides uq_user_perm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT uq_user_perm UNIQUE (user_id, permission_code);


--
-- Name: wage_runs uq_wage_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT uq_wage_period UNIQUE (worker_id, period_start, period_end);


--
-- Name: workers uq_worker_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT uq_worker_code UNIQUE (company_id, code);


--
-- Name: user_invites user_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_pkey PRIMARY KEY (id);


--
-- Name: user_invites user_invites_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_token_hash_key UNIQUE (token_hash);


--
-- Name: user_permission_overrides user_permission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_pkey PRIMARY KEY (id);


--
-- Name: user_role_assignments user_role_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_assignments
    ADD CONSTRAINT user_role_assignments_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vehicle_trip_logs vehicle_trip_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_trip_logs
    ADD CONSTRAINT vehicle_trip_logs_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_company_id_reg_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_company_id_reg_no_key UNIQUE (company_id, reg_no);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: wage_runs wage_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT wage_runs_pkey PRIMARY KEY (id);


--
-- Name: warehouse_floors warehouse_floors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT warehouse_floors_pkey PRIMARY KEY (id);


--
-- Name: warehouses warehouses_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_company_id_code_key UNIQUE (company_id, code);


--
-- Name: warehouses warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);


--
-- Name: weighments weighments_gate_entry_id_kind_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_gate_entry_id_kind_seq_key UNIQUE (gate_entry_id, kind, seq);


--
-- Name: weighments weighments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_pkey PRIMARY KEY (id);


--
-- Name: work_queue work_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_pkey PRIMARY KEY (id);


--
-- Name: work_queue work_queue_queue_key_doc_type_doc_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_queue_key_doc_type_doc_id_key UNIQUE (queue_key, doc_type, doc_id);


--
-- Name: worker_attendance worker_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_attendance
    ADD CONSTRAINT worker_attendance_pkey PRIMARY KEY (id);


--
-- Name: workers workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_pkey PRIMARY KEY (id);


--
-- Name: zones zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_pkey PRIMARY KEY (id);


--
-- Name: zones zones_warehouse_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_warehouse_id_code_key UNIQUE (warehouse_id, code);


--
-- Name: ix_ai_runs_acceptance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_runs_acceptance ON public.ai_runs USING btree (feature_key, accepted, created_at DESC);


--
-- Name: ix_ai_runs_feature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_runs_feature ON public.ai_runs USING btree (company_id, feature_key, created_at DESC);


--
-- Name: ix_alerts_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_alerts_open ON public.alerts USING btree (company_id, branch_id, severity, created_at DESC) WHERE (status = 'OPEN'::text);


--
-- Name: ix_aliases_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_aliases_trgm ON public.product_aliases USING gin (alias public.gin_trgm_ops);


--
-- Name: ix_approvals_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_approvals_pending ON public.approvals USING btree (company_id, branch_id, status, sla_due_at) WHERE (status = 'PENDING'::text);


--
-- Name: ix_arrival_invoice_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_arrival_invoice_no ON public.expected_arrivals USING btree (company_id, lower(supplier_invoice_no)) WHERE ((supplier_invoice_no IS NOT NULL) AND (status <> 'CANCELLED'::text));


--
-- Name: ix_attach_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attach_entity ON public.attachments USING btree (entity_type, entity_id);


--
-- Name: ix_attendance_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_day ON public.worker_attendance USING btree (company_id, on_date);


--
-- Name: ix_audit_count_bin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_count_bin ON public.audit_counts USING btree (bin_id, counted_at);


--
-- Name: ix_audit_count_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_count_product ON public.audit_counts USING btree (company_id, product_id, counted_at);


--
-- Name: ix_audit_count_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_count_task ON public.audit_counts USING btree (task_id);


--
-- Name: ix_audit_task_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_task_open ON public.audit_tasks USING btree (company_id, status, due_date) WHERE (status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text]));


--
-- Name: ix_batches_fefo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batches_fefo ON public.batches USING btree (product_id, warehouse_id, status, expiry_date) WHERE (status = 'ACTIVE'::text);


--
-- Name: ix_batches_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batches_supplier ON public.batches USING btree (supplier_id, received_date DESC);


--
-- Name: ix_box_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_box_entry ON public.unload_boxes USING btree (gate_entry_id) WHERE (voided_at IS NULL);


--
-- Name: ix_box_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_box_product ON public.unload_boxes USING btree (company_id, product_id, weighed_at);


--
-- Name: ix_customer_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_customer_phone ON public.customers USING btree (company_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: ix_cycle_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cycle_open ON public.farm_crop_cycles USING btree (company_id, status, expected_harvest_date);


--
-- Name: ix_cycle_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cycle_product ON public.farm_crop_cycles USING btree (product_id, expected_harvest_date);


--
-- Name: ix_device_readings_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_device_readings_latest ON public.device_readings USING btree (company_id, warehouse_id, kind, captured_at DESC) WHERE (consumed_at IS NULL);


--
-- Name: ix_dispatch_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_dispatch_open ON public.farm_dispatches USING btree (company_id, warehouse_id, status) WHERE (status = 'DISPATCHED'::text);


--
-- Name: ix_drivers_roster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_drivers_roster ON public.drivers USING btree (company_id, full_name) WHERE is_active;


--
-- Name: ix_farm_expense_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_expense_cycle ON public.farm_expenses USING btree (cycle_id, expense_date);


--
-- Name: ix_farm_expense_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_expense_day ON public.farm_expenses USING btree (company_id, farm_id, expense_date);


--
-- Name: ix_farm_loss_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_loss_cycle ON public.farm_losses USING btree (cycle_id, loss_date);


--
-- Name: ix_farm_task_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_task_cycle ON public.farm_tasks USING btree (cycle_id, due_date);


--
-- Name: ix_farm_task_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_task_staff ON public.farm_tasks USING btree (done_by, done_at DESC);


--
-- Name: ix_farm_task_today; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farm_task_today ON public.farm_tasks USING btree (company_id, farm_id, due_date) WHERE (status = 'PENDING'::text);


--
-- Name: ix_farms_own; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_farms_own ON public.farms USING btree (company_id, is_own) WHERE is_own;


--
-- Name: ix_forecast_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_forecast_lookup ON public.demand_forecasts USING btree (branch_id, product_id, forecast_date);


--
-- Name: ix_gate_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_open ON public.gate_entries USING btree (warehouse_id, status) WHERE (status <> ALL (ARRAY['COMPLETED'::text, 'REJECTED_AT_GATE'::text, 'CANCELLED'::text]));


--
-- Name: ix_gate_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_po ON public.gate_entries USING btree (po_id) WHERE (po_id IS NOT NULL);


--
-- Name: ix_gate_qc_bay; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_qc_bay ON public.gate_entries USING btree (qc_bin_id) WHERE ((qc_bin_id IS NOT NULL) AND (qc_released_at IS NULL));


--
-- Name: ix_gate_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_supplier ON public.gate_entries USING btree (supplier_id, arrived_at DESC);


--
-- Name: ix_gate_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_vehicle ON public.gate_entries USING btree (vehicle_id, arrived_at DESC);


--
-- Name: ix_gate_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_worklist ON public.gate_entries USING btree (company_id, warehouse_id, status, arrived_at DESC);


--
-- Name: ix_grn_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_grn_po ON public.grns USING btree (po_id) WHERE (po_id IS NOT NULL);


--
-- Name: ix_grn_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_grn_supplier ON public.grns USING btree (supplier_id, posting_date DESC);


--
-- Name: ix_grn_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_grn_worklist ON public.grns USING btree (company_id, warehouse_id, status, grn_date DESC);


--
-- Name: ix_grnlines_poline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_grnlines_poline ON public.grn_lines USING btree (po_line_id);


--
-- Name: ix_grnlines_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_grnlines_product ON public.grn_lines USING btree (product_id, batch_id);


--
-- Name: ix_harvest_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_harvest_cycle ON public.farm_harvests USING btree (cycle_id, harvest_date DESC);


--
-- Name: ix_harvest_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_harvest_open ON public.farm_harvests USING btree (company_id, status, harvest_date) WHERE (status = ANY (ARRAY['READY'::text, 'PART_DISPATCHED'::text]));


--
-- Name: ix_idem_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_idem_expiry ON public.idempotency_keys USING btree (expires_at);


--
-- Name: ix_integration_log_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_integration_log_recent ON public.integration_log USING btree (integration, occurred_at DESC);


--
-- Name: ix_invoice_dupe_probe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_invoice_dupe_probe ON public.supplier_invoices USING btree (company_id, supplier_id, invoice_date, total);


--
-- Name: ix_invoice_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_invoice_supplier ON public.supplier_invoices USING btree (supplier_id, invoice_date DESC);


--
-- Name: ix_invoice_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_invoice_worklist ON public.supplier_invoices USING btree (company_id, branch_id, status, invoice_date DESC);


--
-- Name: ix_issue_in_transit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_issue_in_transit ON public.stock_issues USING btree (company_id, dest_warehouse_id) WHERE (status = 'IN_TRANSIT'::text);


--
-- Name: ix_issue_lines_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_issue_lines_batch ON public.stock_issue_lines USING btree (batch_id);


--
-- Name: ix_issue_loose_sales; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_issue_loose_sales ON public.stock_issues USING btree (company_id, issue_date) WHERE ((reason = 'SALE'::text) AND (NOT from_packs));


--
-- Name: ix_labels_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_labels_batch ON public.labels USING btree (batch_id);


--
-- Name: ix_landing_abnormal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_landing_abnormal ON public.landing_costs USING btree (company_id, computed_at DESC) WHERE (is_abnormal = true);


--
-- Name: ix_landing_grn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_landing_grn ON public.landing_costs USING btree (grn_id, cost_status);


--
-- Name: ix_landing_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_landing_snapshot ON public.landing_costs USING gin (snapshot jsonb_path_ops);


--
-- Name: ix_lcl_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_lcl_product ON public.landing_cost_lines USING btree (product_id);


--
-- Name: ix_ledger_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_batch ON public.stock_ledger USING btree (batch_id);


--
-- Name: ix_ledger_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_product ON public.stock_ledger USING btree (product_id, warehouse_id, posted_at DESC);


--
-- Name: ix_ledger_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_ref ON public.stock_ledger USING btree (ref_type, ref_id);


--
-- Name: ix_market_prices_prod; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_market_prices_prod ON public.market_prices USING btree (product_id, price_date DESC);


--
-- Name: ix_match_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_match_latest ON public.match_results USING btree (invoice_id) WHERE is_latest;


--
-- Name: ix_notif_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notif_user_unread ON public.notifications USING btree (user_id, queued_at DESC) WHERE (read_at IS NULL);


--
-- Name: ix_obs_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_obs_cycle ON public.farm_observations USING btree (cycle_id, observed_at DESC);


--
-- Name: ix_obs_open_issue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_obs_open_issue ON public.farm_observations USING btree (company_id, observed_at DESC) WHERE (health <> 'GREEN'::text);


--
-- Name: ix_outbox_unpublished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_outbox_unpublished ON public.outbox USING btree (created_at) WHERE (published_at IS NULL);


--
-- Name: ix_pack_runs_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_pack_runs_batch ON public.pack_runs USING btree (batch_id);


--
-- Name: ix_packs_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_batch ON public.packs USING btree (batch_id);


--
-- Name: ix_packs_bin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_bin ON public.packs USING btree (bin_id) WHERE (status = 'IN_STOCK'::text);


--
-- Name: ix_packs_in_transit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_in_transit ON public.packs USING btree (transfer_issue_id) WHERE (status = 'IN_TRANSIT'::text);


--
-- Name: ix_packs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_run ON public.packs USING btree (run_id);


--
-- Name: ix_packs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_status ON public.packs USING btree (company_id, status);


--
-- Name: ix_packs_unstored; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_packs_unstored ON public.packs USING btree (company_id, warehouse_id) WHERE ((status = 'IN_STOCK'::text) AND (bin_id IS NULL));


--
-- Name: ix_payments_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_day ON public.payments USING btree (company_id, paid_at DESC);


--
-- Name: ix_payments_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_request ON public.payments USING btree (request_id);


--
-- Name: ix_payreq_dues; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payreq_dues ON public.payment_requests USING btree (company_id, due_date) WHERE ((became_due_at IS NOT NULL) AND (status <> ALL (ARRAY['PAID'::text, 'REJECTED'::text, 'CANCELLED'::text])));


--
-- Name: ix_payreq_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payreq_inbox ON public.payment_requests USING btree (company_id, status, due_date) WHERE (status = ANY (ARRAY['REQUESTED'::text, 'VERIFIED'::text, 'PART_PAID'::text]));


--
-- Name: ix_payreq_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payreq_source ON public.payment_requests USING btree (source_type, source_id);


--
-- Name: ix_paystatus_overdue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_paystatus_overdue ON public.payment_status USING btree (company_id, supplier_id) WHERE ((balance)::numeric > (0)::numeric);


--
-- Name: ix_pickups_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_pickups_driver ON public.pickups USING btree (driver_id, status);


--
-- Name: ix_pickups_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_pickups_open ON public.pickups USING btree (company_id, status, pickup_on);


--
-- Name: ix_po_lines_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_po_lines_product ON public.po_lines USING btree (product_id, line_status);


--
-- Name: ix_po_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_po_supplier ON public.purchase_orders USING btree (supplier_id, order_date DESC);


--
-- Name: ix_po_supplier_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_po_supplier_response ON public.purchase_orders USING btree (company_id, supplier_response) WHERE (status = 'CONFIRMED'::text);


--
-- Name: ix_po_transport_requested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_po_transport_requested ON public.purchase_orders USING btree (company_id, transport_requested_at) WHERE (transport_requested_at IS NOT NULL);


--
-- Name: ix_po_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_po_worklist ON public.purchase_orders USING btree (company_id, branch_id, status, expected_date);


--
-- Name: ix_products_hi_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_products_hi_trgm ON public.products USING gin (name_hi public.gin_trgm_ops);


--
-- Name: ix_products_no_qc_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_products_no_qc_template ON public.products USING btree (company_id) WHERE ((qc_template_id IS NULL) AND is_active);


--
-- Name: ix_products_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_products_trgm ON public.products USING gin (name public.gin_trgm_ops);


--
-- Name: ix_purchase_charges_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_purchase_charges_doc ON public.purchase_charges USING btree (doc_type, doc_id);


--
-- Name: ix_putaway_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_putaway_open ON public.putaway_tasks USING btree (warehouse_id, status) WHERE (status <> 'DONE'::text);


--
-- Name: ix_qc_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_gate ON public.qc_inspections USING btree (gate_entry_id);


--
-- Name: ix_qc_lot_grades_inspection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_lot_grades_inspection ON public.qc_lot_grades USING btree (inspection_id);


--
-- Name: ix_qc_rejections; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_rejections ON public.qc_inspections USING btree (company_id, inspected_at DESC) WHERE (overall_result = ANY (ARRAY['REJECT'::text, 'PARTIAL'::text]));


--
-- Name: ix_qc_results_param; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_results_param ON public.qc_results USING btree (parameter_id, is_pass);


--
-- Name: ix_qc_returns_unseen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_returns_unseen ON public.qc_inspections USING btree (company_id, returned_at DESC) WHERE (returned_at IS NOT NULL);


--
-- Name: ix_qc_supplier_trend; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_supplier_trend ON public.qc_inspections USING btree (product_id, inspected_at DESC);


--
-- Name: ix_qc_templates_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_qc_templates_live ON public.qc_templates USING btree (company_id, code) WHERE is_active;


--
-- Name: ix_quotes_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_quotes_rfq ON public.supplier_quotes USING btree (rfq_id, rank);


--
-- Name: ix_quotes_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_quotes_supplier ON public.supplier_quotes USING btree (supplier_id, product_id, created_at DESC);


--
-- Name: ix_receipts_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_receipts_open ON public.money_receipts USING btree (company_id, status, received_on DESC);


--
-- Name: ix_req_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_req_worklist ON public.requirements USING btree (company_id, branch_id, status, required_date);


--
-- Name: ix_reqline_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_reqline_product ON public.requirement_lines USING btree (product_id, line_status);


--
-- Name: ix_scores_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_scores_supplier ON public.supplier_scores USING btree (supplier_id, period_end DESC);


--
-- Name: ix_sessions_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sessions_user_active ON public.sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: ix_standing_quote_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_standing_quote_product ON public.supplier_quotes USING btree (company_id, product_id) WHERE (is_standing AND (superseded_at IS NULL));


--
-- Name: ix_stock_issue_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_stock_issue_recent ON public.stock_issues USING btree (company_id, issue_date DESC, warehouse_id);


--
-- Name: ix_supplier_invoice_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_supplier_invoice_no ON public.supplier_invoices USING btree (company_id, lower(invoice_no)) WHERE (status <> 'CANCELLED'::text);


--
-- Name: ix_supplier_legal_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_supplier_legal_trgm ON public.suppliers USING gin (legal_name public.gin_trgm_ops);


--
-- Name: ix_suppliers_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_suppliers_trgm ON public.suppliers USING gin (trade_name public.gin_trgm_ops);


--
-- Name: ix_user_invites_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_invites_user ON public.user_invites USING btree (user_id);


--
-- Name: ix_user_perm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_perm ON public.user_permission_overrides USING btree (user_id, expires_on);


--
-- Name: ix_users_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_driver ON public.users USING btree (driver_id) WHERE (driver_id IS NOT NULL);


--
-- Name: ix_users_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_supplier ON public.users USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: ix_vehicles_roster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_vehicles_roster ON public.vehicles USING btree (company_id, reg_no) WHERE is_active;


--
-- Name: ix_weigh_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_weigh_gate ON public.weighments USING btree (gate_entry_id, kind, seq);


--
-- Name: ix_weigh_manual; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_weigh_manual ON public.weighments USING btree (weighed_by, weighed_at DESC) WHERE (capture_mode = 'MANUAL'::text);


--
-- Name: ix_weigh_variance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_weigh_variance ON public.weighments USING btree (company_id, weighed_at DESC) WHERE (tolerance_breached = true);


--
-- Name: ix_wh_centre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_wh_centre ON public.warehouses USING btree (company_id) WHERE is_centre;


--
-- Name: ix_worker_place; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_worker_place ON public.workers USING btree (company_id, warehouse_id) WHERE is_active;


--
-- Name: ix_workqueue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workqueue_open ON public.work_queue USING btree (company_id, branch_id, queue_key, severity, sla_due_at) WHERE (resolved_at IS NULL);


--
-- Name: ix_workqueue_payload; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workqueue_payload ON public.work_queue USING gin (payload jsonb_path_ops);


--
-- Name: ix_zone_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_zone_purpose ON public.zones USING btree (warehouse_id, purpose) WHERE (purpose <> 'STORAGE'::text);


--
-- Name: uq_alerts_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_alerts_dedupe ON public.alerts USING btree (company_id, dedupe_hash) WHERE ((status = 'OPEN'::text) AND (dedupe_hash IS NOT NULL));


--
-- Name: uq_bin_code_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bin_code_ci ON public.bins USING btree (company_id, lower(code));


--
-- Name: uq_bin_qr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bin_qr ON public.bins USING btree (qr_code);


--
-- Name: uq_container_rfid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_container_rfid ON public.containers USING btree (company_id, rfid_tag) WHERE (rfid_tag IS NOT NULL);


--
-- Name: uq_customer_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_customer_name ON public.customers USING btree (company_id, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE is_active;


--
-- Name: uq_cycle_live_per_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cycle_live_per_plot ON public.farm_crop_cycles USING btree (plot_id) WHERE (status = ANY (ARRAY['PLANNED'::text, 'GROWING'::text, 'HARVESTING'::text]));


--
-- Name: uq_farm_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_farm_code ON public.farms USING btree (company_id, code) WHERE (code IS NOT NULL);


--
-- Name: uq_floor_qr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_floor_qr ON public.warehouse_floors USING btree (qr_code);


--
-- Name: uq_grn_gate_posted; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_grn_gate_posted ON public.grns USING btree (gate_entry_id) WHERE (status = 'POSTED'::text);


--
-- Name: uq_grn_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_grn_idempotency ON public.grns USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_invoice_irn; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoice_irn ON public.supplier_invoices USING btree (company_id, irn) WHERE (irn IS NOT NULL);


--
-- Name: uq_payment_txn_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_txn_ref ON public.payments USING btree (company_id, transaction_ref) WHERE ((transaction_ref IS NOT NULL) AND (status = 'POSTED'::text));


--
-- Name: uq_payreq_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payreq_source ON public.payment_requests USING btree (company_id, source_type, source_id) WHERE ((source_id IS NOT NULL) AND (status <> 'CANCELLED'::text));


--
-- Name: uq_plot_qr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_plot_qr ON public.farm_plots USING btree (company_id, qr_code);


--
-- Name: uq_qc_template_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_qc_template_live ON public.qc_templates USING btree (company_id, code) WHERE is_active;


--
-- Name: uq_qc_template_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_qc_template_version ON public.qc_templates USING btree (company_id, code, template_version);


--
-- Name: uq_rack_qr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rack_qr ON public.racks USING btree (qr_code);


--
-- Name: uq_receipt_txn_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_receipt_txn_ref ON public.money_receipts USING btree (company_id, transaction_ref) WHERE ((transaction_ref IS NOT NULL) AND (status <> 'CANCELLED'::text));


--
-- Name: uq_standing_quote; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_standing_quote ON public.supplier_quotes USING btree (company_id, supplier_id, product_id) WHERE (is_standing AND (superseded_at IS NULL));


--
-- Name: uq_supplier_gstin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_gstin ON public.suppliers USING btree (company_id, gstin) WHERE (gstin IS NOT NULL);


--
-- Name: uq_supplier_pan; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_pan ON public.suppliers USING btree (company_id, pan) WHERE (pan IS NOT NULL);


--
-- Name: uq_supplier_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_phone ON public.suppliers USING btree (company_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: uq_supplier_product_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_product_code ON public.supplier_products USING btree (supplier_id, supplier_code) WHERE (supplier_code IS NOT NULL);


--
-- Name: uq_supplier_tracking_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_tracking_code ON public.supplier_products USING btree (company_id, tracking_code) WHERE (tracking_code IS NOT NULL);


--
-- Name: uq_user_role_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_role_active ON public.user_role_assignments USING btree (user_id, role_id) WHERE (valid_to IS NULL);


--
-- Name: uq_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_email ON public.users USING btree (company_id, lower(email)) WHERE (email IS NOT NULL);


--
-- Name: uq_users_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_phone ON public.users USING btree (company_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: uq_zone_qr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_zone_qr ON public.zones USING btree (qr_code);


--
-- Name: ux_mv_lc_trend; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mv_lc_trend ON public.mv_landing_cost_trend USING btree (company_id, product_id, cost_date);


--
-- Name: ux_mv_purchase_daily; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mv_purchase_daily ON public.mv_purchase_daily USING btree (company_id, branch_id, posting_date, product_id, supplier_id);


--
-- Name: ux_mv_qc_rej; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mv_qc_rej ON public.mv_qc_rejection_90d USING btree (company_id, product_id, supplier_id);


--
-- Name: audit_log_2026m08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_log_pkey ATTACH PARTITION public.audit_log_2026m08_pkey;


--
-- Name: audit_log_2026m09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_log_pkey ATTACH PARTITION public.audit_log_2026m09_pkey;


--
-- Name: audit_log_2026m10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_log_pkey ATTACH PARTITION public.audit_log_2026m10_pkey;


--
-- Name: audit_log_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_log_pkey ATTACH PARTITION public.audit_log_default_pkey;


--
-- Name: aadhtis trg_aadhtis_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_aadhtis_updated BEFORE UPDATE ON public.aadhtis FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: ai_feature_flags trg_ai_feature_flags_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ai_feature_flags_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_feature_flags FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: ai_feature_flags trg_ai_feature_flags_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ai_feature_flags_updated BEFORE UPDATE ON public.ai_feature_flags FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: alert_rules trg_alert_rules_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_alert_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: approval_rules trg_approval_rules_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_approval_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.approval_rules FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: approval_rules trg_approval_rules_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_approval_rules_updated BEFORE UPDATE ON public.approval_rules FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: approvals trg_approvals_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_approvals_audit AFTER INSERT OR DELETE OR UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: approvals trg_approvals_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_approvals_updated BEFORE UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: batches trg_batches_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_batches_audit AFTER INSERT OR DELETE OR UPDATE ON public.batches FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: batches trg_batches_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_batches_updated BEFORE UPDATE ON public.batches FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: bins trg_bins_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bins_updated BEFORE UPDATE ON public.bins FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: branches trg_branches_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: charge_types trg_charge_types_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_charge_types_audit AFTER INSERT OR DELETE OR UPDATE ON public.charge_types FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: charge_types trg_charge_types_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_charge_types_updated BEFORE UPDATE ON public.charge_types FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: companies trg_companies_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: container_types trg_container_types_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_container_types_updated BEFORE UPDATE ON public.container_types FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: containers trg_containers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_containers_updated BEFORE UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: credit_debit_notes trg_credit_debit_notes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_credit_debit_notes_audit AFTER INSERT OR DELETE OR UPDATE ON public.credit_debit_notes FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: credit_debit_notes trg_credit_debit_notes_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_credit_debit_notes_updated BEFORE UPDATE ON public.credit_debit_notes FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: drivers trg_drivers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_drivers_audit AFTER INSERT OR DELETE OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: drivers trg_drivers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_drivers_updated BEFORE UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: expected_arrivals trg_expected_arrivals_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_expected_arrivals_updated BEFORE UPDATE ON public.expected_arrivals FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: expense_categories trg_expense_categories_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_expense_categories_updated BEFORE UPDATE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: farm_crop_cycles trg_farm_crop_cycles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_crop_cycles_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_crop_cycles FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_crop_cycles trg_farm_crop_cycles_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_crop_cycles_updated BEFORE UPDATE ON public.farm_crop_cycles FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_crops trg_farm_crops_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_crops_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_crops FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_crops trg_farm_crops_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_crops_updated BEFORE UPDATE ON public.farm_crops FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_dispatches trg_farm_dispatches_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_dispatches_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_dispatches FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_dispatches trg_farm_dispatches_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_dispatches_updated BEFORE UPDATE ON public.farm_dispatches FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_expenses trg_farm_expenses_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_expenses_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_expenses FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_expenses trg_farm_expenses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_expenses_updated BEFORE UPDATE ON public.farm_expenses FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: farm_harvests trg_farm_harvests_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_harvests_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_harvests FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_harvests trg_farm_harvests_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_harvests_updated BEFORE UPDATE ON public.farm_harvests FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_losses trg_farm_losses_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_losses_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_losses FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_machines trg_farm_machines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_machines_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_machines FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_machines trg_farm_machines_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_machines_updated BEFORE UPDATE ON public.farm_machines FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_plots trg_farm_plots_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_plots_audit AFTER INSERT OR DELETE OR UPDATE ON public.farm_plots FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farm_plots trg_farm_plots_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_plots_updated BEFORE UPDATE ON public.farm_plots FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farm_tasks trg_farm_tasks_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farm_tasks_updated BEFORE UPDATE ON public.farm_tasks FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: farms trg_farms_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farms_audit AFTER INSERT OR DELETE OR UPDATE ON public.farms FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: farms trg_farms_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farms_updated BEFORE UPDATE ON public.farms FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: gate_entries trg_gate_entries_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gate_entries_audit AFTER INSERT OR DELETE OR UPDATE ON public.gate_entries FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: gate_entries trg_gate_entries_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gate_entries_updated BEFORE UPDATE ON public.gate_entries FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: gate_entries trg_gate_lock_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gate_lock_guard BEFORE UPDATE ON public.gate_entries FOR EACH ROW EXECUTE FUNCTION public.trg_gate_locked();


--
-- Name: grn_lines trg_grn_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grn_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.grn_lines FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: grn_lines trg_grn_lines_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grn_lines_updated BEFORE UPDATE ON public.grn_lines FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: grns trg_grn_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grn_no_delete BEFORE DELETE ON public.grns FOR EACH ROW EXECUTE FUNCTION public.trg_no_delete_if_approved();


--
-- Name: grns trg_grn_posted_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grn_posted_immutable BEFORE UPDATE ON public.grns FOR EACH ROW EXECUTE FUNCTION public.trg_forbid_update_when_posted();


--
-- Name: grns trg_grns_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grns_audit AFTER INSERT OR DELETE OR UPDATE ON public.grns FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: grns trg_grns_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grns_updated BEFORE UPDATE ON public.grns FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: supplier_invoices trg_inv_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inv_no_delete BEFORE DELETE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.trg_no_delete_if_approved();


--
-- Name: invoice_lines trg_invoice_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoice_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: labels trg_labels_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_labels_audit AFTER INSERT OR DELETE OR UPDATE ON public.labels FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: landing_costs trg_landing_costs_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_landing_costs_audit AFTER INSERT OR DELETE OR UPDATE ON public.landing_costs FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: stock_ledger trg_ledger_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_no_update BEFORE DELETE OR UPDATE ON public.stock_ledger FOR EACH ROW EXECUTE FUNCTION public.trg_forbid_mutation();


--
-- Name: money_receipts trg_money_receipts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_money_receipts_audit AFTER INSERT OR DELETE OR UPDATE ON public.money_receipts FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: money_receipts trg_money_receipts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_money_receipts_updated BEFORE UPDATE ON public.money_receipts FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: payment_requests trg_payment_requests_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_requests_audit AFTER INSERT OR DELETE OR UPDATE ON public.payment_requests FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: payment_requests trg_payment_requests_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_requests_updated BEFORE UPDATE ON public.payment_requests FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: payments trg_payments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_audit AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: payments trg_payments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: po_charges trg_po_charges_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_po_charges_audit AFTER INSERT OR DELETE OR UPDATE ON public.po_charges FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: po_lines trg_po_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_po_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.po_lines FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: po_lines trg_po_lines_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_po_lines_updated BEFORE UPDATE ON public.po_lines FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: purchase_orders trg_po_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_po_no_delete BEFORE DELETE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.trg_no_delete_if_approved();


--
-- Name: product_categories trg_product_categories_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_categories_updated BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: products trg_products_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_audit AFTER INSERT OR DELETE OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: products trg_products_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: purchase_charges trg_purchase_charges_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_purchase_charges_audit AFTER INSERT OR DELETE OR UPDATE ON public.purchase_charges FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: purchase_orders trg_purchase_orders_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_purchase_orders_audit AFTER INSERT OR DELETE OR UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: purchase_orders trg_purchase_orders_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_purchase_orders_updated BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: putaway_tasks trg_putaway_tasks_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_putaway_tasks_audit AFTER INSERT OR DELETE OR UPDATE ON public.putaway_tasks FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: putaway_tasks trg_putaway_tasks_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_putaway_tasks_updated BEFORE UPDATE ON public.putaway_tasks FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: qc_inspections trg_qc_inspections_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_qc_inspections_audit AFTER INSERT OR DELETE OR UPDATE ON public.qc_inspections FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: qc_inspections trg_qc_inspections_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_qc_inspections_updated BEFORE UPDATE ON public.qc_inspections FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: qc_results trg_qc_results_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_qc_results_audit AFTER INSERT OR DELETE OR UPDATE ON public.qc_results FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: qc_templates trg_qc_templates_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_qc_templates_updated BEFORE UPDATE ON public.qc_templates FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: racks trg_racks_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_racks_updated BEFORE UPDATE ON public.racks FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: requirement_lines trg_requirement_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_requirement_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.requirement_lines FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: requirement_lines trg_requirement_lines_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_requirement_lines_updated BEFORE UPDATE ON public.requirement_lines FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: requirements trg_requirements_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_requirements_audit AFTER INSERT OR DELETE OR UPDATE ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: requirements trg_requirements_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_requirements_updated BEFORE UPDATE ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: rfqs trg_rfqs_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_rfqs_updated BEFORE UPDATE ON public.rfqs FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: role_limits trg_role_limits_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_limits_audit AFTER INSERT OR DELETE OR UPDATE ON public.role_limits FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: role_limits trg_role_limits_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_limits_updated BEFORE UPDATE ON public.role_limits FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: role_permissions trg_role_permissions_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_permissions_audit AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: roles trg_roles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_roles_audit AFTER INSERT OR DELETE OR UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: roles trg_roles_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: scale_devices trg_scale_devices_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_scale_devices_updated BEFORE UPDATE ON public.scale_devices FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: settings trg_settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_settings_audit AFTER INSERT OR DELETE OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: settings trg_settings_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: stock_balances trg_stock_balances_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stock_balances_updated BEFORE UPDATE ON public.stock_balances FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();


--
-- Name: stock_issues trg_stock_issues_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stock_issues_audit AFTER INSERT OR DELETE OR UPDATE ON public.stock_issues FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: stock_issues trg_stock_issues_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stock_issues_updated BEFORE UPDATE ON public.stock_issues FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: supplier_invoices trg_supplier_invoices_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_supplier_invoices_audit AFTER INSERT OR DELETE OR UPDATE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: supplier_invoices trg_supplier_invoices_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_supplier_invoices_updated BEFORE UPDATE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: supplier_products trg_supplier_product_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_supplier_product_code BEFORE INSERT OR UPDATE OF supplier_id, product_id ON public.supplier_products FOR EACH ROW EXECUTE FUNCTION public.trg_supplier_product_tracking_code();


--
-- Name: supplier_products trg_supplier_products_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_supplier_products_updated BEFORE UPDATE ON public.supplier_products FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: supplier_quotes trg_supplier_quotes_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_supplier_quotes_updated BEFORE UPDATE ON public.supplier_quotes FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: suppliers trg_suppliers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_suppliers_audit AFTER INSERT OR DELETE OR UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: suppliers trg_suppliers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: user_role_assignments trg_user_role_assignments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_role_assignments_audit AFTER INSERT OR DELETE OR UPDATE ON public.user_role_assignments FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: user_role_assignments trg_user_role_assignments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_role_assignments_updated BEFORE UPDATE ON public.user_role_assignments FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: users trg_users_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_audit AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: users trg_users_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: vehicles trg_vehicles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vehicles_audit AFTER INSERT OR DELETE OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: vehicles trg_vehicles_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vehicles_updated BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: warehouses trg_warehouses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_warehouses_updated BEFORE UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: weighments trg_weighment_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_weighment_no_delete BEFORE DELETE ON public.weighments FOR EACH ROW EXECUTE FUNCTION public.trg_forbid_mutation();


--
-- Name: weighments trg_weighments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_weighments_audit AFTER INSERT OR DELETE OR UPDATE ON public.weighments FOR EACH ROW EXECUTE FUNCTION public.trg_audit_row();


--
-- Name: zones trg_zones_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zones_updated BEFORE UPDATE ON public.zones FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();


--
-- Name: aadhtis aadhtis_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aadhtis
    ADD CONSTRAINT aadhtis_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: aadhtis aadhtis_mandi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aadhtis
    ADD CONSTRAINT aadhtis_mandi_id_fkey FOREIGN KEY (mandi_id) REFERENCES public.mandis(id);


--
-- Name: aadhtis aadhtis_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aadhtis
    ADD CONSTRAINT aadhtis_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: ai_feature_flags ai_feature_flags_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_feature_flags
    ADD CONSTRAINT ai_feature_flags_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: ai_feature_flags ai_feature_flags_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_feature_flags
    ADD CONSTRAINT ai_feature_flags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: ai_models ai_models_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: ai_models ai_models_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: ai_models ai_models_rollback_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_rollback_to_fkey FOREIGN KEY (rollback_to) REFERENCES public.ai_models(id);


--
-- Name: ai_runs ai_runs_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id);


--
-- Name: ai_runs ai_runs_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: ai_runs ai_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: ai_runs ai_runs_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.ai_models(id);


--
-- Name: alert_rules alert_rules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: alert_rules alert_rules_escalate_to_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_escalate_to_role_id_fkey FOREIGN KEY (escalate_to_role_id) REFERENCES public.roles(id);


--
-- Name: alerts alerts_acked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_acked_by_fkey FOREIGN KEY (acked_by) REFERENCES public.users(id);


--
-- Name: alerts alerts_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: alerts alerts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: alerts alerts_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: approval_rules approval_rules_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: approval_rules approval_rules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: approval_rules approval_rules_escalate_to_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_escalate_to_role_id_fkey FOREIGN KEY (escalate_to_role_id) REFERENCES public.roles(id);


--
-- Name: approval_rules approval_rules_required_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_required_role_id_fkey FOREIGN KEY (required_role_id) REFERENCES public.roles(id);


--
-- Name: approvals approvals_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.users(id);


--
-- Name: approvals approvals_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: approvals approvals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: approvals approvals_escalated_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_escalated_from_fkey FOREIGN KEY (escalated_from) REFERENCES public.approvals(id);


--
-- Name: approvals approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: approvals approvals_required_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_required_role_id_fkey FOREIGN KEY (required_role_id) REFERENCES public.roles(id);


--
-- Name: attachments attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: audit_counts audit_counts_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: audit_counts audit_counts_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_bin_id_fkey FOREIGN KEY (bin_id) REFERENCES public.bins(id);


--
-- Name: audit_counts audit_counts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: audit_counts audit_counts_counted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_counted_by_fkey FOREIGN KEY (counted_by) REFERENCES public.users(id);


--
-- Name: audit_counts audit_counts_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: audit_counts audit_counts_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.audit_tasks(id) ON DELETE SET NULL;


--
-- Name: audit_counts audit_counts_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_counts
    ADD CONSTRAINT audit_counts_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: audit_tasks audit_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: audit_tasks audit_tasks_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: audit_tasks audit_tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: audit_tasks audit_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: audit_tasks audit_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: audit_tasks audit_tasks_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: audit_tasks audit_tasks_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id);


--
-- Name: audit_tasks audit_tasks_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: audit_tasks audit_tasks_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_tasks
    ADD CONSTRAINT audit_tasks_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: batches batches_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: batches batches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: batches batches_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id);


--
-- Name: batches batches_grn_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_grn_line_id_fkey FOREIGN KEY (grn_line_id) REFERENCES public.grn_lines(id);


--
-- Name: batches batches_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: batches batches_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: batches batches_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: bins bins_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bins
    ADD CONSTRAINT bins_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: bins bins_rack_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bins
    ADD CONSTRAINT bins_rack_id_fkey FOREIGN KEY (rack_id) REFERENCES public.racks(id) ON DELETE CASCADE;


--
-- Name: branches branches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: centre_day_close centre_day_close_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: centre_day_close centre_day_close_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: centre_day_close centre_day_close_expense_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_expense_request_id_fkey FOREIGN KEY (expense_request_id) REFERENCES public.payment_requests(id);


--
-- Name: centre_day_close centre_day_close_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.money_receipts(id);


--
-- Name: centre_day_close centre_day_close_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.centre_day_close
    ADD CONSTRAINT centre_day_close_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: charge_types charge_types_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charge_types
    ADD CONSTRAINT charge_types_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: cold_chain_summaries cold_chain_summaries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cold_chain_summaries
    ADD CONSTRAINT cold_chain_summaries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: cold_chain_summaries cold_chain_summaries_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cold_chain_summaries
    ADD CONSTRAINT cold_chain_summaries_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: container_types container_types_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.container_types
    ADD CONSTRAINT container_types_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: containers containers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: containers containers_container_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_container_type_id_fkey FOREIGN KEY (container_type_id) REFERENCES public.container_types(id);


--
-- Name: containers containers_held_by_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_held_by_supplier_id_fkey FOREIGN KEY (held_by_supplier_id) REFERENCES public.suppliers(id);


--
-- Name: credit_debit_notes credit_debit_notes_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: credit_debit_notes credit_debit_notes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: credit_debit_notes credit_debit_notes_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_grn_id_fkey FOREIGN KEY (grn_id) REFERENCES public.grns(id);


--
-- Name: credit_debit_notes credit_debit_notes_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.supplier_invoices(id);


--
-- Name: credit_debit_notes credit_debit_notes_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_debit_notes
    ADD CONSTRAINT credit_debit_notes_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: customers customers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: customers customers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: customers customers_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: customers customers_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: demand_forecasts demand_forecasts_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecasts
    ADD CONSTRAINT demand_forecasts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: demand_forecasts demand_forecasts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecasts
    ADD CONSTRAINT demand_forecasts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: demand_forecasts demand_forecasts_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecasts
    ADD CONSTRAINT demand_forecasts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: demand_signals demand_signals_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_signals
    ADD CONSTRAINT demand_signals_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: demand_signals demand_signals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_signals
    ADD CONSTRAINT demand_signals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: demand_signals demand_signals_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_signals
    ADD CONSTRAINT demand_signals_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: device_readings device_readings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_readings
    ADD CONSTRAINT device_readings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: device_readings device_readings_scale_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_readings
    ADD CONSTRAINT device_readings_scale_device_id_fkey FOREIGN KEY (scale_device_id) REFERENCES public.scale_devices(id) ON DELETE SET NULL;


--
-- Name: device_readings device_readings_site_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_readings
    ADD CONSTRAINT device_readings_site_agent_id_fkey FOREIGN KEY (site_agent_id) REFERENCES public.site_agents(id) ON DELETE SET NULL;


--
-- Name: device_readings device_readings_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_readings
    ADD CONSTRAINT device_readings_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: drivers drivers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: expected_arrivals expected_arrivals_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expected_arrivals
    ADD CONSTRAINT expected_arrivals_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: expected_arrivals expected_arrivals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expected_arrivals
    ADD CONSTRAINT expected_arrivals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: expected_arrivals expected_arrivals_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expected_arrivals
    ADD CONSTRAINT expected_arrivals_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: expected_arrivals expected_arrivals_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expected_arrivals
    ADD CONSTRAINT expected_arrivals_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: expense_categories expense_categories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: farm_crop_cycles farm_crop_cycles_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farm_crop_cycles farm_crop_cycles_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: farm_crop_cycles farm_crop_cycles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_crop_cycles farm_crop_cycles_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.farm_crops(id);


--
-- Name: farm_crop_cycles farm_crop_cycles_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE RESTRICT;


--
-- Name: farm_crop_cycles farm_crop_cycles_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE RESTRICT;


--
-- Name: farm_crop_cycles farm_crop_cycles_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crop_cycles
    ADD CONSTRAINT farm_crop_cycles_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: farm_crops farm_crops_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crops
    ADD CONSTRAINT farm_crops_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_crops farm_crops_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_crops
    ADD CONSTRAINT farm_crops_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: farm_day_closes farm_day_closes_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_day_closes
    ADD CONSTRAINT farm_day_closes_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: farm_day_closes farm_day_closes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_day_closes
    ADD CONSTRAINT farm_day_closes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_day_closes farm_day_closes_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_day_closes
    ADD CONSTRAINT farm_day_closes_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farm_dispatch_lines farm_dispatch_lines_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_dispatch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_dispatch_id_fkey FOREIGN KEY (dispatch_id) REFERENCES public.farm_dispatches(id) ON DELETE CASCADE;


--
-- Name: farm_dispatch_lines farm_dispatch_lines_harvest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_harvest_id_fkey FOREIGN KEY (harvest_id) REFERENCES public.farm_harvests(id);


--
-- Name: farm_dispatch_lines farm_dispatch_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatch_lines
    ADD CONSTRAINT farm_dispatch_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: farm_dispatches farm_dispatches_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farm_dispatches farm_dispatches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_dispatches farm_dispatches_dispatched_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_dispatched_by_fkey FOREIGN KEY (dispatched_by) REFERENCES public.users(id);


--
-- Name: farm_dispatches farm_dispatches_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE RESTRICT;


--
-- Name: farm_dispatches farm_dispatches_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id);


--
-- Name: farm_dispatches farm_dispatches_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: farm_dispatches farm_dispatches_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_dispatches
    ADD CONSTRAINT farm_dispatches_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: farm_expenses farm_expenses_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farm_expenses farm_expenses_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_expenses farm_expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: farm_expenses farm_expenses_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id) ON DELETE SET NULL;


--
-- Name: farm_expenses farm_expenses_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE RESTRICT;


--
-- Name: farm_expenses farm_expenses_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.farm_machines(id) ON DELETE SET NULL;


--
-- Name: farm_expenses farm_expenses_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE SET NULL;


--
-- Name: farm_expenses farm_expenses_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_expenses
    ADD CONSTRAINT farm_expenses_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.farm_tasks(id) ON DELETE SET NULL;


--
-- Name: farm_harvest_lines farm_harvest_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvest_lines
    ADD CONSTRAINT farm_harvest_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_harvest_lines farm_harvest_lines_harvest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvest_lines
    ADD CONSTRAINT farm_harvest_lines_harvest_id_fkey FOREIGN KEY (harvest_id) REFERENCES public.farm_harvests(id) ON DELETE CASCADE;


--
-- Name: farm_harvests farm_harvests_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farm_harvests farm_harvests_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_harvests farm_harvests_container_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_container_type_id_fkey FOREIGN KEY (container_type_id) REFERENCES public.container_types(id);


--
-- Name: farm_harvests farm_harvests_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id) ON DELETE RESTRICT;


--
-- Name: farm_harvests farm_harvests_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE RESTRICT;


--
-- Name: farm_harvests farm_harvests_harvested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_harvested_by_fkey FOREIGN KEY (harvested_by) REFERENCES public.users(id);


--
-- Name: farm_harvests farm_harvests_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE RESTRICT;


--
-- Name: farm_harvests farm_harvests_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: farm_harvests farm_harvests_scale_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_harvests
    ADD CONSTRAINT farm_harvests_scale_device_id_fkey FOREIGN KEY (scale_device_id) REFERENCES public.scale_devices(id);


--
-- Name: farm_losses farm_losses_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_losses farm_losses_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id) ON DELETE SET NULL;


--
-- Name: farm_losses farm_losses_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farm_losses farm_losses_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE SET NULL;


--
-- Name: farm_losses farm_losses_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_losses
    ADD CONSTRAINT farm_losses_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.users(id);


--
-- Name: farm_machines farm_machines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_machines
    ADD CONSTRAINT farm_machines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_machines farm_machines_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_machines
    ADD CONSTRAINT farm_machines_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE SET NULL;


--
-- Name: farm_observations farm_observations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_observations farm_observations_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id) ON DELETE CASCADE;


--
-- Name: farm_observations farm_observations_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farm_observations farm_observations_observed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_observed_by_fkey FOREIGN KEY (observed_by) REFERENCES public.users(id);


--
-- Name: farm_observations farm_observations_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE CASCADE;


--
-- Name: farm_observations farm_observations_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_observations
    ADD CONSTRAINT farm_observations_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.farm_tasks(id) ON DELETE SET NULL;


--
-- Name: farm_plots farm_plots_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_plots
    ADD CONSTRAINT farm_plots_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_plots farm_plots_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_plots
    ADD CONSTRAINT farm_plots_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farm_staff_scores farm_staff_scores_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_staff_scores
    ADD CONSTRAINT farm_staff_scores_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_staff_scores farm_staff_scores_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_staff_scores
    ADD CONSTRAINT farm_staff_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: farm_tasks farm_tasks_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farm_tasks farm_tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_tasks farm_tasks_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.farm_crop_cycles(id) ON DELETE CASCADE;


--
-- Name: farm_tasks farm_tasks_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.users(id);


--
-- Name: farm_tasks farm_tasks_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farm_tasks farm_tasks_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_tasks
    ADD CONSTRAINT farm_tasks_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.farm_plots(id) ON DELETE CASCADE;


--
-- Name: farm_weather farm_weather_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_weather
    ADD CONSTRAINT farm_weather_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farm_weather farm_weather_farm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farm_weather
    ADD CONSTRAINT farm_weather_farm_id_fkey FOREIGN KEY (farm_id) REFERENCES public.farms(id) ON DELETE CASCADE;


--
-- Name: farms farms_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: farms farms_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: farms farms_default_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_default_warehouse_id_fkey FOREIGN KEY (default_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: farms farms_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id);


--
-- Name: farms farms_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farms
    ADD CONSTRAINT farms_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: product_aliases fk_alias_supplier; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT fk_alias_supplier FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: product_categories fk_category_qc_template; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT fk_category_qc_template FOREIGN KEY (default_qc_template_id) REFERENCES public.qc_templates(id);


--
-- Name: grn_lines fk_grnline_batch; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT fk_grnline_batch FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: products fk_product_qc_template; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT fk_product_qc_template FOREIGN KEY (qc_template_id) REFERENCES public.qc_templates(id);


--
-- Name: qc_inspections fk_qc_ai_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT fk_qc_ai_run FOREIGN KEY (ai_run_id) REFERENCES public.ai_runs(id);


--
-- Name: supplier_quotes fk_quote_ai_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT fk_quote_ai_run FOREIGN KEY (ai_run_id) REFERENCES public.ai_runs(id);


--
-- Name: requirement_lines fk_reqline_ai_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT fk_reqline_ai_run FOREIGN KEY (ai_run_id) REFERENCES public.ai_runs(id);


--
-- Name: gate_entries gate_entries_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: gate_entries gate_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: gate_entries gate_entries_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: gate_entries gate_entries_exception_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_exception_approved_by_fkey FOREIGN KEY (exception_approved_by) REFERENCES public.users(id);


--
-- Name: gate_entries gate_entries_expected_arrival_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_expected_arrival_id_fkey FOREIGN KEY (expected_arrival_id) REFERENCES public.expected_arrivals(id);


--
-- Name: gate_entries gate_entries_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id);


--
-- Name: gate_entries gate_entries_qc_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_qc_bin_id_fkey FOREIGN KEY (qc_bin_id) REFERENCES public.bins(id);


--
-- Name: gate_entries gate_entries_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: gate_entries gate_entries_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: gate_entries gate_entries_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entries
    ADD CONSTRAINT gate_entries_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: gate_entry_docs gate_entry_docs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_docs
    ADD CONSTRAINT gate_entry_docs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: gate_entry_docs gate_entry_docs_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_docs
    ADD CONSTRAINT gate_entry_docs_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: gate_entry_docs gate_entry_docs_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_docs
    ADD CONSTRAINT gate_entry_docs_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: gate_entry_photos gate_entry_photos_captured_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_photos
    ADD CONSTRAINT gate_entry_photos_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.users(id);


--
-- Name: gate_entry_photos gate_entry_photos_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_photos
    ADD CONSTRAINT gate_entry_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: gate_entry_photos gate_entry_photos_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_entry_photos
    ADD CONSTRAINT gate_entry_photos_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: grn_lines grn_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: grn_lines grn_lines_container_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_container_type_id_fkey FOREIGN KEY (container_type_id) REFERENCES public.container_types(id);


--
-- Name: grn_lines grn_lines_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_grn_id_fkey FOREIGN KEY (grn_id) REFERENCES public.grns(id) ON DELETE CASCADE;


--
-- Name: grn_lines grn_lines_po_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_po_line_id_fkey FOREIGN KEY (po_line_id) REFERENCES public.po_lines(id);


--
-- Name: grn_lines grn_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: grn_lines grn_lines_qc_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_qc_inspection_id_fkey FOREIGN KEY (qc_inspection_id) REFERENCES public.qc_inspections(id);


--
-- Name: grn_lines grn_lines_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_lines
    ADD CONSTRAINT grn_lines_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: grns grns_amended_by_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_amended_by_grn_id_fkey FOREIGN KEY (amended_by_grn_id) REFERENCES public.grns(id);


--
-- Name: grns grns_backdate_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_backdate_approved_by_fkey FOREIGN KEY (backdate_approved_by) REFERENCES public.users(id);


--
-- Name: grns grns_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: grns grns_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: grns grns_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id);


--
-- Name: grns grns_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id);


--
-- Name: grns grns_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES public.users(id);


--
-- Name: grns grns_reversal_of_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_reversal_of_grn_id_fkey FOREIGN KEY (reversal_of_grn_id) REFERENCES public.grns(id);


--
-- Name: grns grns_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);


--
-- Name: grns grns_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: grns grns_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grns
    ADD CONSTRAINT grns_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: invoice_lines invoice_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_lines invoice_lines_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.supplier_invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_lines invoice_lines_matched_grn_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_matched_grn_line_id_fkey FOREIGN KEY (matched_grn_line_id) REFERENCES public.grn_lines(id);


--
-- Name: invoice_lines invoice_lines_matched_po_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_matched_po_line_id_fkey FOREIGN KEY (matched_po_line_id) REFERENCES public.po_lines(id);


--
-- Name: invoice_lines invoice_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: invoice_lines invoice_lines_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: labels labels_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id) ON DELETE CASCADE;


--
-- Name: labels labels_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: labels labels_container_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id);


--
-- Name: labels labels_printed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_printed_by_fkey FOREIGN KEY (printed_by) REFERENCES public.users(id);


--
-- Name: landing_cost_lines landing_cost_lines_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: landing_cost_lines landing_cost_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: landing_cost_lines landing_cost_lines_grn_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_grn_line_id_fkey FOREIGN KEY (grn_line_id) REFERENCES public.grn_lines(id);


--
-- Name: landing_cost_lines landing_cost_lines_landing_cost_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_landing_cost_id_fkey FOREIGN KEY (landing_cost_id) REFERENCES public.landing_costs(id) ON DELETE CASCADE;


--
-- Name: landing_cost_lines landing_cost_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_cost_lines
    ADD CONSTRAINT landing_cost_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: landing_costs landing_costs_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: landing_costs landing_costs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: landing_costs landing_costs_computed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_computed_by_fkey FOREIGN KEY (computed_by) REFERENCES public.users(id);


--
-- Name: landing_costs landing_costs_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_costs
    ADD CONSTRAINT landing_costs_grn_id_fkey FOREIGN KEY (grn_id) REFERENCES public.grns(id) ON DELETE CASCADE;


--
-- Name: mandis mandis_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mandis
    ADD CONSTRAINT mandis_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: market_prices market_prices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_prices
    ADD CONSTRAINT market_prices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: market_prices market_prices_mandi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_prices
    ADD CONSTRAINT market_prices_mandi_id_fkey FOREIGN KEY (mandi_id) REFERENCES public.mandis(id);


--
-- Name: market_prices market_prices_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_prices
    ADD CONSTRAINT market_prices_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: market_signals market_signals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_signals
    ADD CONSTRAINT market_signals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: market_signals market_signals_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_signals
    ADD CONSTRAINT market_signals_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: match_results match_results_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: match_results match_results_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.supplier_invoices(id) ON DELETE CASCADE;


--
-- Name: match_results match_results_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: match_results match_results_run_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_run_by_fkey FOREIGN KEY (run_by) REFERENCES public.users(id);


--
-- Name: match_results match_results_tolerance_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_tolerance_profile_id_fkey FOREIGN KEY (tolerance_profile_id) REFERENCES public.tolerance_profiles(id);


--
-- Name: money_receipts money_receipts_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: money_receipts money_receipts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: money_receipts money_receipts_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: money_receipts money_receipts_declared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_declared_by_fkey FOREIGN KEY (declared_by) REFERENCES public.users(id);


--
-- Name: money_receipts money_receipts_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_receipts
    ADD CONSTRAINT money_receipts_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: notifications notifications_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: notifications notifications_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: notifications notifications_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: number_series number_series_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_series
    ADD CONSTRAINT number_series_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: number_series number_series_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_series
    ADD CONSTRAINT number_series_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: pack_runs pack_runs_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: pack_runs pack_runs_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: pack_runs pack_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: pack_runs pack_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: pack_runs pack_runs_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: pack_runs pack_runs_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_runs
    ADD CONSTRAINT pack_runs_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: packs packs_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: packs packs_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_bin_id_fkey FOREIGN KEY (bin_id) REFERENCES public.bins(id);


--
-- Name: packs packs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: packs packs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: packs packs_destination_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_destination_warehouse_id_fkey FOREIGN KEY (destination_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: packs packs_graded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_graded_by_fkey FOREIGN KEY (graded_by) REFERENCES public.users(id);


--
-- Name: packs packs_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: packs packs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.pack_runs(id) ON DELETE CASCADE;


--
-- Name: packs packs_sold_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_sold_issue_id_fkey FOREIGN KEY (sold_issue_id) REFERENCES public.stock_issues(id);


--
-- Name: packs packs_stored_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_stored_by_fkey FOREIGN KEY (stored_by) REFERENCES public.users(id);


--
-- Name: packs packs_transfer_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_transfer_issue_id_fkey FOREIGN KEY (transfer_issue_id) REFERENCES public.stock_issues(id);


--
-- Name: packs packs_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: packs packs_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: payment_requests payment_requests_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: payment_requests payment_requests_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: payment_requests payment_requests_expense_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_expense_category_id_fkey FOREIGN KEY (expense_category_id) REFERENCES public.expense_categories(id);


--
-- Name: payment_requests payment_requests_payee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_payee_user_id_fkey FOREIGN KEY (payee_user_id) REFERENCES public.users(id);


--
-- Name: payment_requests payment_requests_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES public.users(id);


--
-- Name: payment_requests payment_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: payment_requests payment_requests_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: payment_requests payment_requests_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: payment_requests payment_requests_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_requests
    ADD CONSTRAINT payment_requests_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: payment_status payment_status_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_status
    ADD CONSTRAINT payment_status_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: payment_status payment_status_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_status
    ADD CONSTRAINT payment_status_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.supplier_invoices(id) ON DELETE CASCADE;


--
-- Name: payment_status payment_status_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_status
    ADD CONSTRAINT payment_status_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: payments payments_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: payments payments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: payments payments_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.users(id);


--
-- Name: payments payments_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.payment_requests(id) ON DELETE RESTRICT;


--
-- Name: payments payments_reversed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_reversed_by_fkey FOREIGN KEY (reversed_by) REFERENCES public.users(id);


--
-- Name: pickups pickups_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: pickups pickups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: pickups pickups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: pickups pickups_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: pickups pickups_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id);


--
-- Name: pickups pickups_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id);


--
-- Name: pickups pickups_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: pickups pickups_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: pickups pickups_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: pickups pickups_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pickups
    ADD CONSTRAINT pickups_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: po_charges po_charges_charge_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_charges
    ADD CONSTRAINT po_charges_charge_type_id_fkey FOREIGN KEY (charge_type_id) REFERENCES public.charge_types(id);


--
-- Name: po_charges po_charges_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_charges
    ADD CONSTRAINT po_charges_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: po_charges po_charges_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_charges
    ADD CONSTRAINT po_charges_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: po_charges po_charges_third_party_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_charges
    ADD CONSTRAINT po_charges_third_party_supplier_id_fkey FOREIGN KEY (third_party_supplier_id) REFERENCES public.suppliers(id);


--
-- Name: po_lines po_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: po_lines po_lines_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: po_lines po_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: po_lines po_lines_requirement_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_requirement_line_id_fkey FOREIGN KEY (requirement_line_id) REFERENCES public.requirement_lines(id);


--
-- Name: po_lines po_lines_tax_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_tax_code_id_fkey FOREIGN KEY (tax_code_id) REFERENCES public.tax_codes(id);


--
-- Name: po_lines po_lines_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_lines
    ADD CONSTRAINT po_lines_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: po_revisions po_revisions_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_revisions
    ADD CONSTRAINT po_revisions_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: po_revisions po_revisions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_revisions
    ADD CONSTRAINT po_revisions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: po_revisions po_revisions_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_revisions
    ADD CONSTRAINT po_revisions_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: product_aliases product_aliases_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: product_aliases product_aliases_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_categories product_categories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: product_categories product_categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.product_categories(id);


--
-- Name: product_uoms product_uoms_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_uoms
    ADD CONSTRAINT product_uoms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: product_uoms product_uoms_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_uoms
    ADD CONSTRAINT product_uoms_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_uoms product_uoms_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_uoms
    ADD CONSTRAINT product_uoms_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: products products_base_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_base_uom_fkey FOREIGN KEY (base_uom) REFERENCES public.uoms(code);


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id);


--
-- Name: products products_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: products products_purchase_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_purchase_uom_fkey FOREIGN KEY (purchase_uom) REFERENCES public.uoms(code);


--
-- Name: products products_tax_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_tax_code_id_fkey FOREIGN KEY (tax_code_id) REFERENCES public.tax_codes(id);


--
-- Name: purchase_charges purchase_charges_charge_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_charges
    ADD CONSTRAINT purchase_charges_charge_type_id_fkey FOREIGN KEY (charge_type_id) REFERENCES public.charge_types(id);


--
-- Name: purchase_charges purchase_charges_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_charges
    ADD CONSTRAINT purchase_charges_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: purchase_charges purchase_charges_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_charges
    ADD CONSTRAINT purchase_charges_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: purchase_orders purchase_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: purchase_orders purchase_orders_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: purchase_orders purchase_orders_mandi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_mandi_id_fkey FOREIGN KEY (mandi_id) REFERENCES public.mandis(id);


--
-- Name: purchase_orders purchase_orders_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.requirements(id);


--
-- Name: purchase_orders purchase_orders_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: purchase_orders purchase_orders_supplier_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_supplier_responded_by_fkey FOREIGN KEY (supplier_responded_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_transport_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_transport_requested_by_fkey FOREIGN KEY (transport_requested_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: putaway_tasks putaway_tasks_actual_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_actual_bin_id_fkey FOREIGN KEY (actual_bin_id) REFERENCES public.bins(id);


--
-- Name: putaway_tasks putaway_tasks_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: putaway_tasks putaway_tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: putaway_tasks putaway_tasks_grn_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_grn_line_id_fkey FOREIGN KEY (grn_line_id) REFERENCES public.grn_lines(id) ON DELETE CASCADE;


--
-- Name: putaway_tasks putaway_tasks_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: putaway_tasks putaway_tasks_scanned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_scanned_by_fkey FOREIGN KEY (scanned_by) REFERENCES public.users(id);


--
-- Name: putaway_tasks putaway_tasks_suggested_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_suggested_bin_id_fkey FOREIGN KEY (suggested_bin_id) REFERENCES public.bins(id);


--
-- Name: putaway_tasks putaway_tasks_suggested_rack_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_suggested_rack_id_fkey FOREIGN KEY (suggested_rack_id) REFERENCES public.racks(id);


--
-- Name: putaway_tasks putaway_tasks_suggested_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_suggested_zone_id_fkey FOREIGN KEY (suggested_zone_id) REFERENCES public.zones(id);


--
-- Name: putaway_tasks putaway_tasks_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.putaway_tasks
    ADD CONSTRAINT putaway_tasks_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: qc_inspections qc_inspections_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: qc_inspections qc_inspections_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: qc_inspections qc_inspections_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: qc_inspections qc_inspections_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: qc_inspections qc_inspections_inspector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_inspector_id_fkey FOREIGN KEY (inspector_id) REFERENCES public.users(id);


--
-- Name: qc_inspections qc_inspections_po_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_po_line_id_fkey FOREIGN KEY (po_line_id) REFERENCES public.po_lines(id);


--
-- Name: qc_inspections qc_inspections_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: qc_inspections qc_inspections_returned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_returned_by_fkey FOREIGN KEY (returned_by) REFERENCES public.users(id);


--
-- Name: qc_inspections qc_inspections_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.qc_templates(id);


--
-- Name: qc_inspections qc_inspections_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_inspections
    ADD CONSTRAINT qc_inspections_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: qc_lot_grades qc_lot_grades_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: qc_lot_grades qc_lot_grades_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: qc_lot_grades qc_lot_grades_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES public.qc_inspections(id) ON DELETE CASCADE;


--
-- Name: qc_lot_grades qc_lot_grades_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_lot_grades
    ADD CONSTRAINT qc_lot_grades_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: qc_parameters qc_parameters_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_parameters
    ADD CONSTRAINT qc_parameters_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: qc_parameters qc_parameters_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_parameters
    ADD CONSTRAINT qc_parameters_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.qc_templates(id) ON DELETE CASCADE;


--
-- Name: qc_photos qc_photos_captured_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_photos
    ADD CONSTRAINT qc_photos_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.users(id);


--
-- Name: qc_photos qc_photos_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_photos
    ADD CONSTRAINT qc_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: qc_photos qc_photos_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_photos
    ADD CONSTRAINT qc_photos_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES public.qc_inspections(id) ON DELETE CASCADE;


--
-- Name: qc_photos qc_photos_parameter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_photos
    ADD CONSTRAINT qc_photos_parameter_id_fkey FOREIGN KEY (parameter_id) REFERENCES public.qc_parameters(id);


--
-- Name: qc_results qc_results_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_results
    ADD CONSTRAINT qc_results_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: qc_results qc_results_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_results
    ADD CONSTRAINT qc_results_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES public.qc_inspections(id) ON DELETE CASCADE;


--
-- Name: qc_results qc_results_parameter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_results
    ADD CONSTRAINT qc_results_parameter_id_fkey FOREIGN KEY (parameter_id) REFERENCES public.qc_parameters(id);


--
-- Name: qc_templates qc_templates_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_templates
    ADD CONSTRAINT qc_templates_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id);


--
-- Name: qc_templates qc_templates_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_templates
    ADD CONSTRAINT qc_templates_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: qc_templates qc_templates_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_templates
    ADD CONSTRAINT qc_templates_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: qc_templates qc_templates_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_templates
    ADD CONSTRAINT qc_templates_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.qc_templates(id);


--
-- Name: racks racks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.racks
    ADD CONSTRAINT racks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: racks racks_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.racks
    ADD CONSTRAINT racks_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: reefer_temp_logs reefer_temp_logs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reefer_temp_logs
    ADD CONSTRAINT reefer_temp_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: reefer_temp_logs reefer_temp_logs_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reefer_temp_logs
    ADD CONSTRAINT reefer_temp_logs_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: requirement_lines requirement_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: requirement_lines requirement_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: requirement_lines requirement_lines_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.requirements(id) ON DELETE CASCADE;


--
-- Name: requirement_lines requirement_lines_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirement_lines
    ADD CONSTRAINT requirement_lines_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: requirements requirements_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: requirements requirements_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: requirements requirements_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: requirements requirements_raised_for_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_raised_for_warehouse_id_fkey FOREIGN KEY (raised_for_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: requirements requirements_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);


--
-- Name: requirements requirements_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requirements
    ADD CONSTRAINT requirements_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: rfqs rfqs_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rfqs
    ADD CONSTRAINT rfqs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: rfqs rfqs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rfqs
    ADD CONSTRAINT rfqs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: rfqs rfqs_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rfqs
    ADD CONSTRAINT rfqs_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.requirements(id);


--
-- Name: role_limits role_limits_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_limits
    ADD CONSTRAINT role_limits_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_permission_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES public.permissions(code) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: roles roles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: scale_devices scale_devices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_devices
    ADD CONSTRAINT scale_devices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: scale_devices scale_devices_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_devices
    ADD CONSTRAINT scale_devices_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: sessions sessions_active_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_active_branch_id_fkey FOREIGN KEY (active_branch_id) REFERENCES public.branches(id);


--
-- Name: sessions sessions_active_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_active_role_id_fkey FOREIGN KEY (active_role_id) REFERENCES public.roles(id);


--
-- Name: sessions sessions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_rotated_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_rotated_from_fkey FOREIGN KEY (rotated_from) REFERENCES public.sessions(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: settings settings_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: settings settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: settings settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: site_agents site_agents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_agents
    ADD CONSTRAINT site_agents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: site_agents site_agents_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_agents
    ADD CONSTRAINT site_agents_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_balances stock_balances_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: stock_balances stock_balances_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_balances stock_balances_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: stock_balances stock_balances_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_issue_lines stock_issue_lines_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: stock_issue_lines stock_issue_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_issue_lines stock_issue_lines_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.stock_issues(id) ON DELETE CASCADE;


--
-- Name: stock_issue_lines stock_issue_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: stock_issue_lines stock_issue_lines_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issue_lines
    ADD CONSTRAINT stock_issue_lines_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: stock_issues stock_issues_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: stock_issues stock_issues_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id);


--
-- Name: stock_issues stock_issues_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_issues stock_issues_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: stock_issues stock_issues_dest_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_dest_warehouse_id_fkey FOREIGN KEY (dest_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_issues stock_issues_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES public.users(id);


--
-- Name: stock_issues stock_issues_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id);


--
-- Name: stock_issues stock_issues_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: stock_issues stock_issues_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_issues
    ADD CONSTRAINT stock_issues_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_ledger stock_ledger_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: stock_ledger stock_ledger_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_bin_id_fkey FOREIGN KEY (bin_id) REFERENCES public.bins(id);


--
-- Name: stock_ledger stock_ledger_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: stock_ledger stock_ledger_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_ledger stock_ledger_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES public.users(id);


--
-- Name: stock_ledger stock_ledger_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: stock_ledger stock_ledger_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: stock_ledger stock_ledger_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: supplier_defect_trends supplier_defect_trends_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_defect_trends
    ADD CONSTRAINT supplier_defect_trends_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: supplier_defect_trends supplier_defect_trends_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_defect_trends
    ADD CONSTRAINT supplier_defect_trends_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: supplier_defect_trends supplier_defect_trends_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_defect_trends
    ADD CONSTRAINT supplier_defect_trends_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: supplier_invoices supplier_invoices_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: supplier_invoices supplier_invoices_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: supplier_invoices supplier_invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: supplier_invoices supplier_invoices_duplicate_cleared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_duplicate_cleared_by_fkey FOREIGN KEY (duplicate_cleared_by) REFERENCES public.users(id);


--
-- Name: supplier_invoices supplier_invoices_duplicate_of_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_duplicate_of_id_fkey FOREIGN KEY (duplicate_of_id) REFERENCES public.supplier_invoices(id);


--
-- Name: supplier_invoices supplier_invoices_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id);


--
-- Name: supplier_invoices supplier_invoices_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: supplier_products supplier_products_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: supplier_products supplier_products_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: supplier_products supplier_products_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: supplier_quotes supplier_quotes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: supplier_quotes supplier_quotes_mandi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_mandi_id_fkey FOREIGN KEY (mandi_id) REFERENCES public.mandis(id);


--
-- Name: supplier_quotes supplier_quotes_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: supplier_quotes supplier_quotes_requirement_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_requirement_line_id_fkey FOREIGN KEY (requirement_line_id) REFERENCES public.requirement_lines(id);


--
-- Name: supplier_quotes supplier_quotes_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.rfqs(id) ON DELETE CASCADE;


--
-- Name: supplier_quotes supplier_quotes_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id);


--
-- Name: supplier_quotes supplier_quotes_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: supplier_quotes supplier_quotes_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_quotes
    ADD CONSTRAINT supplier_quotes_uom_fkey FOREIGN KEY (uom) REFERENCES public.uoms(code);


--
-- Name: supplier_scores supplier_scores_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_scores
    ADD CONSTRAINT supplier_scores_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: supplier_scores supplier_scores_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_scores
    ADD CONSTRAINT supplier_scores_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: supplier_scores supplier_scores_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_scores
    ADD CONSTRAINT supplier_scores_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: sync_state sync_state_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: sync_state sync_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tolerance_profiles tolerance_profiles_applies_to_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tolerance_profiles
    ADD CONSTRAINT tolerance_profiles_applies_to_category_id_fkey FOREIGN KEY (applies_to_category_id) REFERENCES public.product_categories(id);


--
-- Name: tolerance_profiles tolerance_profiles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tolerance_profiles
    ADD CONSTRAINT tolerance_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: unload_boxes unload_boxes_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: unload_boxes unload_boxes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: unload_boxes unload_boxes_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: unload_boxes unload_boxes_po_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_po_line_id_fkey FOREIGN KEY (po_line_id) REFERENCES public.po_lines(id);


--
-- Name: unload_boxes unload_boxes_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: unload_boxes unload_boxes_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.users(id);


--
-- Name: unload_boxes unload_boxes_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: unload_boxes unload_boxes_weighed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unload_boxes
    ADD CONSTRAINT unload_boxes_weighed_by_fkey FOREIGN KEY (weighed_by) REFERENCES public.users(id);


--
-- Name: uoms uoms_base_uom_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uoms
    ADD CONSTRAINT uoms_base_uom_fkey FOREIGN KEY (base_uom) REFERENCES public.uoms(code);


--
-- Name: user_invites user_invites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_permission_overrides user_permission_overrides_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: user_permission_overrides user_permission_overrides_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_permission_overrides user_permission_overrides_permission_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES public.permissions(code) ON DELETE CASCADE;


--
-- Name: user_permission_overrides user_permission_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_role_assignments user_role_assignments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_assignments
    ADD CONSTRAINT user_role_assignments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_role_assignments user_role_assignments_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_assignments
    ADD CONSTRAINT user_role_assignments_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_role_assignments user_role_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_assignments
    ADD CONSTRAINT user_role_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: users users_default_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_default_branch_id_fkey FOREIGN KEY (default_branch_id) REFERENCES public.branches(id);


--
-- Name: users users_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: users users_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: vehicle_trip_logs vehicle_trip_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_trip_logs
    ADD CONSTRAINT vehicle_trip_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: vehicle_trip_logs vehicle_trip_logs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_trip_logs
    ADD CONSTRAINT vehicle_trip_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: vehicle_trip_logs vehicle_trip_logs_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_trip_logs
    ADD CONSTRAINT vehicle_trip_logs_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: vehicle_trip_logs vehicle_trip_logs_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_trip_logs
    ADD CONSTRAINT vehicle_trip_logs_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: vehicles vehicles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: vehicles vehicles_owner_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_owner_supplier_id_fkey FOREIGN KEY (owner_supplier_id) REFERENCES public.suppliers(id);


--
-- Name: wage_runs wage_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT wage_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: wage_runs wage_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT wage_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wage_runs wage_runs_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT wage_runs_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.payment_requests(id);


--
-- Name: wage_runs wage_runs_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wage_runs
    ADD CONSTRAINT wage_runs_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: warehouse_floors warehouse_floors_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT warehouse_floors_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: warehouse_floors warehouse_floors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT warehouse_floors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: warehouse_floors warehouse_floors_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT warehouse_floors_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: warehouse_floors warehouse_floors_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_floors
    ADD CONSTRAINT warehouse_floors_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: warehouses warehouses_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: warehouses warehouses_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: warehouses warehouses_delivery_rate_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_delivery_rate_set_by_fkey FOREIGN KEY (delivery_rate_set_by) REFERENCES public.users(id);


--
-- Name: warehouses warehouses_manager_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_manager_user_id_fkey FOREIGN KEY (manager_user_id) REFERENCES public.users(id);


--
-- Name: weighments weighments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: weighments weighments_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: weighments weighments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: weighments weighments_container_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_container_type_id_fkey FOREIGN KEY (container_type_id) REFERENCES public.container_types(id);


--
-- Name: weighments weighments_gate_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_gate_entry_id_fkey FOREIGN KEY (gate_entry_id) REFERENCES public.gate_entries(id) ON DELETE CASCADE;


--
-- Name: weighments weighments_scale_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_scale_device_id_fkey FOREIGN KEY (scale_device_id) REFERENCES public.scale_devices(id);


--
-- Name: weighments weighments_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: weighments weighments_weighed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weighments
    ADD CONSTRAINT weighments_weighed_by_fkey FOREIGN KEY (weighed_by) REFERENCES public.users(id);


--
-- Name: work_queue work_queue_assigned_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_assigned_role_id_fkey FOREIGN KEY (assigned_role_id) REFERENCES public.roles(id);


--
-- Name: work_queue work_queue_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES public.users(id);


--
-- Name: work_queue work_queue_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: work_queue work_queue_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: work_queue work_queue_required_permission_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_required_permission_fkey FOREIGN KEY (required_permission) REFERENCES public.permissions(code);


--
-- Name: work_queue work_queue_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: work_queue work_queue_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_queue
    ADD CONSTRAINT work_queue_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: worker_attendance worker_attendance_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_attendance
    ADD CONSTRAINT worker_attendance_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: worker_attendance worker_attendance_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_attendance
    ADD CONSTRAINT worker_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id);


--
-- Name: worker_attendance worker_attendance_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_attendance
    ADD CONSTRAINT worker_attendance_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE CASCADE;


--
-- Name: workers workers_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: workers workers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: workers workers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: workers workers_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: workers workers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: workers workers_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: zones zones_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: zones zones_floor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_floor_id_fkey FOREIGN KEY (floor_id) REFERENCES public.warehouse_floors(id);


--
-- Name: zones zones_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON DELETE CASCADE;


--
-- Name: aadhtis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aadhtis ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_counts audit_counts_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_counts_rls ON public.audit_counts USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: audit_log_2026m08; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log_2026m08 ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log_2026m09; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log_2026m09 ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log_2026m10; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log_2026m10 ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log_default; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log_default ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_tasks audit_tasks_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_tasks_rls ON public.audit_tasks USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;

--
-- Name: bins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bins ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: centre_day_close; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.centre_day_close ENABLE ROW LEVEL SECURITY;

--
-- Name: centre_day_close centre_day_close_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY centre_day_close_rls ON public.centre_day_close USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: charge_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.charge_types ENABLE ROW LEVEL SECURITY;

--
-- Name: cold_chain_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cold_chain_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: container_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.container_types ENABLE ROW LEVEL SECURITY;

--
-- Name: containers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.containers ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_debit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_debit_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: customers customers_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customers_rls ON public.customers USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: demand_forecasts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demand_forecasts ENABLE ROW LEVEL SECURITY;

--
-- Name: demand_signals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demand_signals ENABLE ROW LEVEL SECURITY;

--
-- Name: device_readings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_readings ENABLE ROW LEVEL SECURITY;

--
-- Name: drivers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

--
-- Name: expected_arrivals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expected_arrivals ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_crop_cycles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_crop_cycles ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_crops; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_crops ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_day_closes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_day_closes ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_dispatch_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_dispatch_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_dispatches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_dispatches ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_harvest_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_harvest_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_harvests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_harvests ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_losses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_losses ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_machines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_machines ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_observations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_plots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_plots ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_staff_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_staff_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: farm_weather; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farm_weather ENABLE ROW LEVEL SECURITY;

--
-- Name: farms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_entry_docs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_entry_docs ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_entry_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_entry_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: grn_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grn_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: grns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grns ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_log ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: labels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;

--
-- Name: landing_cost_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.landing_cost_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: landing_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.landing_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: mandis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mandis ENABLE ROW LEVEL SECURITY;

--
-- Name: market_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_prices ENABLE ROW LEVEL SECURITY;

--
-- Name: market_signals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_signals ENABLE ROW LEVEL SECURITY;

--
-- Name: match_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;

--
-- Name: money_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.money_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: number_series; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.number_series ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: pack_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pack_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: packs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.packs ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_status ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: pickups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pickups ENABLE ROW LEVEL SECURITY;

--
-- Name: po_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.po_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: po_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.po_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: po_revisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.po_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: product_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: product_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: product_uoms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_uoms ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: putaway_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.putaway_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_inspections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_inspections ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_lot_grades; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_lot_grades ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_parameters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_parameters ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_results ENABLE ROW LEVEL SECURITY;

--
-- Name: qc_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qc_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: racks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.racks ENABLE ROW LEVEL SECURITY;

--
-- Name: reefer_temp_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reefer_temp_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: requirement_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.requirement_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: requirements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.requirements ENABLE ROW LEVEL SECURITY;

--
-- Name: rfqs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rfqs ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: scale_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scale_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: site_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_issue_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_issue_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_issues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_issues ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_defect_trends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_defect_trends ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_products ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_quotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: aadhtis tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.aadhtis USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: ai_feature_flags tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_feature_flags USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: ai_models tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_models USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: ai_runs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_runs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: alert_rules tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.alert_rules USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: alerts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.alerts USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: approval_rules tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.approval_rules USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: approvals tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.approvals USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: attachments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.attachments USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: audit_log_2026m08 tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log_2026m08 USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: audit_log_2026m09 tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log_2026m09 USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: audit_log_2026m10 tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log_2026m10 USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: audit_log_default tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log_default USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: batches tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.batches USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: bins tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.bins USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: branches tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.branches USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: charge_types tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.charge_types USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: cold_chain_summaries tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.cold_chain_summaries USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: container_types tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.container_types USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: containers tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.containers USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: credit_debit_notes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.credit_debit_notes USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: demand_forecasts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.demand_forecasts USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: demand_signals tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.demand_signals USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: device_readings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.device_readings USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: drivers tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.drivers USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: expected_arrivals tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.expected_arrivals USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: expense_categories tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.expense_categories USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_crop_cycles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_crop_cycles USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_crops tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_crops USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_day_closes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_day_closes USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_dispatch_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_dispatch_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_dispatches tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_dispatches USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_expenses tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_expenses USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_harvest_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_harvest_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_harvests tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_harvests USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_losses tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_losses USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_machines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_machines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_observations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_observations USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_plots tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_plots USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_staff_scores tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_staff_scores USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_tasks tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_tasks USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farm_weather tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farm_weather USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: farms tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.farms USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: gate_entries tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.gate_entries USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: gate_entry_docs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.gate_entry_docs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: gate_entry_photos tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.gate_entry_photos USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: grn_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.grn_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: grns tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.grns USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: idempotency_keys tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.idempotency_keys USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: integration_log tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.integration_log USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: invoice_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.invoice_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: labels tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.labels USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: landing_cost_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.landing_cost_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: landing_costs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.landing_costs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: mandis tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.mandis USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: market_prices tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.market_prices USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: market_signals tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.market_signals USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: match_results tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.match_results USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: money_receipts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.money_receipts USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: notifications tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notifications USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: number_series tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.number_series USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: outbox tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.outbox USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: pack_runs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.pack_runs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: packs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.packs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: payment_requests tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payment_requests USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: payment_status tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payment_status USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: payments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payments USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: pickups tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.pickups USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: po_charges tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.po_charges USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: po_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.po_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: po_revisions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.po_revisions USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: product_aliases tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.product_aliases USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: product_categories tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.product_categories USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: product_uoms tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.product_uoms USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: products tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.products USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: purchase_charges tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.purchase_charges USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: purchase_orders tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.purchase_orders USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: putaway_tasks tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.putaway_tasks USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_inspections tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_inspections USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_lot_grades tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_lot_grades USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_parameters tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_parameters USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_photos tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_photos USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_results tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_results USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: qc_templates tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.qc_templates USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: racks tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.racks USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: reefer_temp_logs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.reefer_temp_logs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: requirement_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.requirement_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: requirements tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.requirements USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: rfqs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.rfqs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: roles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.roles USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: scale_devices tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.scale_devices USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: sessions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.sessions USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: settings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.settings USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: site_agents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.site_agents USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: stock_balances tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_balances USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: stock_issue_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_issue_lines USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: stock_issues tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_issues USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: stock_ledger tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_ledger USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: supplier_defect_trends tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.supplier_defect_trends USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: supplier_invoices tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.supplier_invoices USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: supplier_products tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.supplier_products USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: supplier_quotes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.supplier_quotes USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: supplier_scores tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.supplier_scores USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: suppliers tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.suppliers USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: sync_state tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.sync_state USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: tolerance_profiles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tolerance_profiles USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: user_role_assignments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.user_role_assignments USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: users tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.users USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: vehicle_trip_logs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.vehicle_trip_logs USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: vehicles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.vehicles USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: warehouses tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.warehouses USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: weighments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.weighments USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: work_queue tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.work_queue USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: zones tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.zones USING (((company_id IS NULL) OR (company_id = public.current_company_id()))) WITH CHECK (((company_id IS NULL) OR (company_id = public.current_company_id())));


--
-- Name: companies tenant_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_self ON public.companies USING ((id = public.current_company_id())) WITH CHECK ((id = public.current_company_id()));


--
-- Name: tolerance_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tolerance_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: unload_boxes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unload_boxes ENABLE ROW LEVEL SECURITY;

--
-- Name: unload_boxes unload_boxes_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY unload_boxes_rls ON public.unload_boxes USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: user_permission_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permission_overrides user_permission_overrides_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_permission_overrides_rls ON public.user_permission_overrides USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: user_role_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_role_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicle_trip_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_trip_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- Name: wage_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wage_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: wage_runs wage_runs_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wage_runs_rls ON public.wage_runs USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: warehouse_floors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouse_floors ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouse_floors warehouse_floors_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY warehouse_floors_rls ON public.warehouse_floors USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: warehouses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

--
-- Name: weighments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.weighments ENABLE ROW LEVEL SECURITY;

--
-- Name: work_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_attendance worker_attendance_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_attendance_rls ON public.worker_attendance USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: workers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;

--
-- Name: workers workers_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workers_rls ON public.workers USING ((company_id = (current_setting('app.company_id'::text, true))::uuid)) WITH CHECK ((company_id = (current_setting('app.company_id'::text, true))::uuid));


--
-- Name: zones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict kJyEJFtUdYPLhQX7AQgoNlzMKrwx4zhijLkeeJ8vS7Hg2hGdzkHFbJc0MOOnad5

