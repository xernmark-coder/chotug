-- Repairs for databases initialized before the audit-trigger and settings
-- uniqueness fixes. Safe to run after 01_schema.sql on a fresh database too.

CREATE OR REPLACE FUNCTION trg_audit_row()
RETURNS trigger LANGUAGE plpgsql AS $$
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

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_company_id_branch_id_key_key;
ALTER TABLE settings
    ADD CONSTRAINT settings_company_id_branch_id_key_key
    UNIQUE NULLS NOT DISTINCT (company_id, branch_id, key);

CREATE OR REPLACE FUNCTION bootstrap_company(p_company uuid)
RETURNS void LANGUAGE plpgsql AS $$
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
