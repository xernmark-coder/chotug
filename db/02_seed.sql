-- ============================================================================
--  ChotuG ERP — Purchase Module : DEMO / BOOTSTRAP SEED
--  Run AFTER 01_schema.sql. Idempotent — safe to re-run.
--
--    psql "$DATABASE_URL" -f db/01_schema.sql
--    psql "$DATABASE_URL" -f db/02_seed.sql
--    npm --prefix server run seed        # hashes passwords + demo transactions
--
--  Everything here is master data only. No transactional documents are seeded
--  in SQL — those are created through the API by server/src/scripts/seed.ts so
--  that every state machine, numbering series and audit row is exercised the
--  same way production will exercise them.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Company + org tree
-- ---------------------------------------------------------------------------
INSERT INTO companies (id, code, legal_name, trade_name, gstin, pan, fy_start_month, default_locale)
VALUES ('01919000-0000-7000-8000-000000000001',
        'CHOTUG', 'ChotuG Retail Private Limited', 'ChotuG',
        '27AABCC1234D1Z5', 'AABCC1234D', 4, 'en')
ON CONFLICT (code) DO NOTHING;

SELECT bootstrap_company('01919000-0000-7000-8000-000000000001');

INSERT INTO branches (id, company_id, code, name, name_hi, type, gstin, contact_phone, geo_lat, geo_lng)
VALUES
 ('01919000-0000-7000-8000-000000000011','01919000-0000-7000-8000-000000000001',
  'PUN-HO','Pune Head Office & DC','पुणे मुख्यालय','BOTH','27AABCC1234D1Z5','+912041000000',18.5204,73.8567),
 ('01919000-0000-7000-8000-000000000012','01919000-0000-7000-8000-000000000001',
  'PUN-KP','Kothrud Retail Branch','कोथरूड शाखा','BRANCH','27AABCC1234D1Z5','+912041000001',18.5074,73.8077)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO warehouses (id, company_id, branch_id, code, name, storage_types,
                        has_weighbridge, weighbridge_capacity_kg, weighbridge_stamp_expiry)
VALUES ('01919000-0000-7000-8000-000000000021','01919000-0000-7000-8000-000000000001',
        '01919000-0000-7000-8000-000000000011','WH-PUN-01','Pune Central Warehouse',
        ARRAY['AMBIENT','CHILLED','COLD','RIPENING'], true, 40000, CURRENT_DATE + 300)
ON CONFLICT (company_id, code) DO NOTHING;

-- Zones -> racks -> bins. FEFO put-away needs real bins to suggest.
INSERT INTO zones (id, company_id, warehouse_id, code, name, storage_type, temp_min_c, temp_max_c)
VALUES
 ('01919000-0000-7000-8000-000000000031','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000021','Z-AMB','Ambient Hall','AMBIENT',18,30),
 ('01919000-0000-7000-8000-000000000032','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000021','Z-CHL','Chiller Room','CHILLED',2,8),
 ('01919000-0000-7000-8000-000000000033','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000021','Z-RIP','Ripening Chamber','RIPENING',14,20)
ON CONFLICT DO NOTHING;

INSERT INTO racks (id, company_id, zone_id, code)
VALUES
 ('01919000-0000-7000-8000-000000000041','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000031','R-A1'),
 ('01919000-0000-7000-8000-000000000042','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000031','R-A2'),
 ('01919000-0000-7000-8000-000000000043','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000032','R-C1'),
 ('01919000-0000-7000-8000-000000000044','01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000033','R-P1')
ON CONFLICT DO NOTHING;

/* Four shelves on every rack.
 *
 * The NOT EXISTS is not belt-and-braces. 27_pack_and_grade added
 * uq_bin_code_ci — a shelf label has to be unique across the whole company,
 * because the point of it is that scanning it identifies one shelf and nothing
 * else. But a rack code is only unique within its section, so two sections each
 * holding a rack "A1" both want a shelf "A1-1", and the second one violates
 * that index. ON CONFLICT (rack_id, code) cannot catch it: the row conflicts on
 * a different index from the one named as the arbiter.
 *
 * The effect was that this file could not be re-run on any database that had
 * already been seeded — which is every database — so `npm run migrate` died
 * here and no migration after it ever ran. */
INSERT INTO bins (company_id, rack_id, code, capacity_kg, capacity_crates, is_pickface)
SELECT '01919000-0000-7000-8000-000000000001', r.id, r.code || '-' || b.n, 1500, 60, (b.n = 1)
FROM racks r CROSS JOIN generate_series(1,4) AS b(n)
WHERE r.company_id = '01919000-0000-7000-8000-000000000001'
  AND NOT EXISTS (
      SELECT 1 FROM bins x
       WHERE x.company_id = r.company_id
         AND lower(x.code) = lower(r.code || '-' || b.n))
ON CONFLICT (rack_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Users — password_hash is filled by `npm --prefix server run seed`
--    Demo logins (all password: chotug123)
--      owner@chotug.in     Owner / Super Admin
--      buyer@chotug.in     Purchase Executive
--      manager@chotug.in   Purchase Manager
--      gate@chotug.in      Gate Executive
--      qc@chotug.in        QC Executive
--      wh@chotug.in        Warehouse Executive
--      finance@chotug.in   Finance Executive
-- ---------------------------------------------------------------------------
INSERT INTO users (id, company_id, employee_code, full_name, email, phone, locale, default_branch_id, status) VALUES
 ('01919000-0000-7000-8000-000000000101','01919000-0000-7000-8000-000000000001','E-001','Rakesh Gupta (Owner)','owner@chotug.in','+919820000001','en','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000102','01919000-0000-7000-8000-000000000001','E-002','Sunil Patil','buyer@chotug.in','+919820000002','en','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000103','01919000-0000-7000-8000-000000000001','E-003','Meera Joshi','manager@chotug.in','+919820000003','en','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000104','01919000-0000-7000-8000-000000000001','E-004','Ganesh Shinde','gate@chotug.in','+919820000004','hi','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000105','01919000-0000-7000-8000-000000000001','E-005','Anita Rao','qc@chotug.in','+919820000005','en','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000106','01919000-0000-7000-8000-000000000001','E-006','Vikas Jadhav','wh@chotug.in','+919820000006','hi','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000107','01919000-0000-7000-8000-000000000001','E-007','Priya Nair','finance@chotug.in','+919820000007','en','01919000-0000-7000-8000-000000000011','ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_role_assignments (company_id, user_id, role_id)
SELECT '01919000-0000-7000-8000-000000000001', u.id, r.id
FROM (VALUES
  ('01919000-0000-7000-8000-000000000101'::uuid,'OWNER'),
  ('01919000-0000-7000-8000-000000000102','PURCHASE_EXEC'),
  ('01919000-0000-7000-8000-000000000103','PURCHASE_MGR'),
  ('01919000-0000-7000-8000-000000000104','GATE_EXEC'),
  ('01919000-0000-7000-8000-000000000105','QC_EXEC'),
  ('01919000-0000-7000-8000-000000000106','WH_EXEC'),
  ('01919000-0000-7000-8000-000000000107','FINANCE_EXEC')
) AS u(id, role_code)
JOIN roles r ON r.company_id = '01919000-0000-7000-8000-000000000001' AND r.code = u.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id AND a.role_id = r.id);

-- ---------------------------------------------------------------------------
-- 3. Number series — one row per branch per doc type per FY, else next_doc_no()
--    raises number_series_missing.
-- ---------------------------------------------------------------------------
INSERT INTO number_series (company_id, branch_id, doc_type, fy, prefix, next_no, width)
SELECT b.company_id, b.id, t.doc_type, '2026-27', t.prefix, 1, 6
FROM branches b
CROSS JOIN (VALUES
  ('REQ','REQ'),('RFQ','RFQ'),('IND','IND'),('PO','PO'),('GATE','GT'),('WGT','WT'),
  ('QC','QC'),('GRN','GRN'),('BATCH','BAT'),('LABEL','LBL'),('INV','INV'),
  ('DN','DN'),('CN','CN'),('PUT','PUT')
) AS t(doc_type, prefix)
WHERE b.company_id = '01919000-0000-7000-8000-000000000001'
ON CONFLICT (company_id, branch_id, doc_type, fy) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Charge types (§16 landing cost inputs)
-- ---------------------------------------------------------------------------
INSERT INTO charge_types (company_id, code, name, name_hi, allocation_basis, is_creditable, affects_landing_cost, borne_by) VALUES
 ('01919000-0000-7000-8000-000000000001','COMM','Aadhti / Mandi Commission','आढ़त कमीशन','VALUE',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','MANDI_FEE','Mandi Cess / Market Fee','मंडी शुल्क','VALUE',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','TRANSPORT','Transport / Freight','भाड़ा','WEIGHT',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','HAMALI','Loading / Unloading (Hamali)','हमाली','WEIGHT',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','PACKING','Packing / Crate Charges','पैकिंग','QTY',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','TOLL','Toll & Octroi','टोल','EQUAL',false,true,'BUYER'),
 ('01919000-0000-7000-8000-000000000001','WEIGH_FEE','Weighbridge Fee','कांटा शुल्क','EQUAL',false,true,'BUYER')
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Container types — tare is what stops weight fraud (§11)
-- ---------------------------------------------------------------------------
INSERT INTO container_types (company_id, code, name, container_kind, tare_kg, is_returnable, owner) VALUES
 ('01919000-0000-7000-8000-000000000001','CR-PLS','Plastic Crate 20kg','CRATE',1.850,true,'OWN'),
 ('01919000-0000-7000-8000-000000000001','CR-WD','Wooden Crate','CRATE',3.200,false,'SUPPLIER'),
 ('01919000-0000-7000-8000-000000000001','BAG-JT','Jute Bag 50kg','BAG',0.650,false,'SUPPLIER'),
 ('01919000-0000-7000-8000-000000000001','BOX-CB','Corrugated Box','BOX',0.420,false,'SUPPLIER'),
 ('01919000-0000-7000-8000-000000000001','PLT-WD','Wooden Pallet','PALLET',18.000,true,'OWN')
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Product categories & products
-- ---------------------------------------------------------------------------
INSERT INTO product_categories (id, company_id, code, name, name_hi, segment, parent_id) VALUES
 ('01919000-0000-7000-8000-000000000051','01919000-0000-7000-8000-000000000001','FRUIT','Fruits','फल','FRUIT',NULL),
 ('01919000-0000-7000-8000-000000000052','01919000-0000-7000-8000-000000000001','VEG','Vegetables','सब्ज़ी','VEGETABLE',NULL),
 ('01919000-0000-7000-8000-000000000053','01919000-0000-7000-8000-000000000001','LEAFY','Leafy Greens','पत्तेदार','VEGETABLE','01919000-0000-7000-8000-000000000052'),
 ('01919000-0000-7000-8000-000000000054','01919000-0000-7000-8000-000000000001','GROC','Grocery','किराना','GROCERY',NULL)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO products (id, company_id, sku, name, name_hi, category_id, variety, base_uom, purchase_uom,
                      is_variable_weight, is_perishable, is_batch_tracked, shelf_life_days,
                      storage_type, storage_temp_min_c, storage_temp_max_c, rotation_rule, hsn_code,
                      min_stock, max_stock, reorder_point, safety_stock_days, lead_time_days,
                      default_wastage_pct, grades_allowed, is_active)
VALUES
 ('01919000-0000-7000-8000-000000000061','01919000-0000-7000-8000-000000000001','VEG-POT-01','Potato','आलू','01919000-0000-7000-8000-000000000052','Kufri Jyoti','KG','KG',
  false,true,true,30,'AMBIENT',10,15,'FIFO','0701',400,3000,600,2,1,3.0,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-000000000062','01919000-0000-7000-8000-000000000001','VEG-ONI-01','Onion','प्याज़','01919000-0000-7000-8000-000000000052','Nashik Red','KG','KG',
  false,true,true,45,'AMBIENT',12,20,'FIFO','0703',500,4000,800,2,1,4.0,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-000000000063','01919000-0000-7000-8000-000000000001','VEG-TOM-01','Tomato','टमाटर','01919000-0000-7000-8000-000000000052','Hybrid Round','KG','CRATE',
  true,true,true,7,'CHILLED',8,12,'FEFO','0702',200,1200,300,1,1,8.0,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-000000000064','01919000-0000-7000-8000-000000000001','FRU-BAN-01','Banana','केला','01919000-0000-7000-8000-000000000051','Grand Naine','KG','KG',
  false,true,true,9,'RIPENING',14,18,'FEFO','0803',150,900,250,1,1,7.0,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-000000000065','01919000-0000-7000-8000-000000000001','FRU-MAN-01','Mango','आम','01919000-0000-7000-8000-000000000051','Alphonso','KG','BOX',
  true,true,true,10,'RIPENING',12,16,'FEFO','0804',100,600,150,1,2,6.0,ARRAY['A','B'],true),
 ('01919000-0000-7000-8000-000000000066','01919000-0000-7000-8000-000000000001','FRU-APP-01','Apple','सेब','01919000-0000-7000-8000-000000000051','Shimla Delicious','KG','BOX',
  true,true,true,60,'COLD',0,4,'FEFO','0808',120,800,200,2,3,3.5,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-000000000067','01919000-0000-7000-8000-000000000001','VEG-SPI-01','Spinach','पालक','01919000-0000-7000-8000-000000000053','Desi','KG','KG',
  false,true,true,3,'CHILLED',2,6,'FEFO','0709',40,200,60,1,1,12.0,ARRAY['A','B'],true),
 ('01919000-0000-7000-8000-000000000068','01919000-0000-7000-8000-000000000001','VEG-CAU-01','Cauliflower','फूलगोभी','01919000-0000-7000-8000-000000000052','Snowball','KG','KG',
  false,true,true,8,'CHILLED',4,8,'FEFO','0704',80,500,120,1,1,9.0,ARRAY['A','B','C'],true)
ON CONFLICT (company_id, sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Suppliers — one of each of the four source types (§6)
-- ---------------------------------------------------------------------------
INSERT INTO suppliers (id, company_id, code, legal_name, trade_name, source_type, gstin, pan,
                       is_unregistered, phone, district, state_code, payment_terms_days,
                       status, trust_score, performance_score) VALUES
 ('01919000-0000-7000-8000-000000000071','01919000-0000-7000-8000-000000000001','SUP-F001','Baban Shelar','Shelar Farm','FARMER',NULL,NULL,
  true,'+919011100001','Pune','27',0,'ACTIVE',82.0,79.5),
 ('01919000-0000-7000-8000-000000000072','01919000-0000-7000-8000-000000000001','SUP-M001','Pune Market Yard Traders','Market Yard','MANDI','27AAAAM1234A1Z1','AAAAM1234A',
  false,'+919011100002','Pune','27',3,'ACTIVE',74.0,71.0),
 ('01919000-0000-7000-8000-000000000073','01919000-0000-7000-8000-000000000001','SUP-A001','Ramesh Aadhti & Sons','Ramesh Aadhti','AADHTI','27AAAAA1234B1Z2','AAAAA1234B',
  false,'+919011100003','Nashik','27',7,'PREFERRED',88.5,86.0),
 ('01919000-0000-7000-8000-000000000074','01919000-0000-7000-8000-000000000001','SUP-W001','Sahyadri Wholesale Pvt Ltd','Sahyadri','WHOLESALER','27AAAAW1234C1Z3','AAAAW1234C',
  false,'+919011100004','Pune','27',15,'ACTIVE',69.0,64.5)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO mandis (id, company_id, name, apmc_code, district, state_code, geo_lat, geo_lng)
VALUES ('01919000-0000-7000-8000-000000000081','01919000-0000-7000-8000-000000000001','Pune APMC Market Yard','APMC-PUN','Pune','27',18.4922,73.8547)
ON CONFLICT DO NOTHING;

INSERT INTO aadhtis (id, company_id, supplier_id, mandi_id, licence_no, commission_pct, settlement_cycle_days, market_fee_pct, hamali_rate)
VALUES ('01919000-0000-7000-8000-000000000082','01919000-0000-7000-8000-000000000001',
        '01919000-0000-7000-8000-000000000073','01919000-0000-7000-8000-000000000081','APMC/AAD/2019/0442',6.0,7,1.05,0.35)
ON CONFLICT DO NOTHING;

INSERT INTO farms (id, company_id, supplier_id, name, khasra_no, village, area_acre, crops, geo_lat, geo_lng)
VALUES ('01919000-0000-7000-8000-000000000083','01919000-0000-7000-8000-000000000001',
        '01919000-0000-7000-8000-000000000071','Shelar Wadi','114/2A','Khed, Pune',12.5,
        ARRAY['Potato','Onion','Tomato'],18.8412,73.8712)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Vehicles & drivers
-- ---------------------------------------------------------------------------
INSERT INTO vehicles (company_id, reg_no, vehicle_type, capacity_kg, is_reefer, tare_reference_kg,
                      fitness_expiry, insurance_expiry, puc_expiry, transporter_name, status) VALUES
 ('01919000-0000-7000-8000-000000000001','MH12AB1234','TRUCK',9000,false,4200,CURRENT_DATE+200,CURRENT_DATE+150,CURRENT_DATE+60,'Shivneri Transport','ACTIVE'),
 ('01919000-0000-7000-8000-000000000001','MH14CD5678','TEMPO',3000,false,1650,CURRENT_DATE+120,CURRENT_DATE+90,CURRENT_DATE+20,'Self','ACTIVE'),
 ('01919000-0000-7000-8000-000000000001','MH04EF9012','REEFER',7000,true,4800,CURRENT_DATE+300,CURRENT_DATE+240,CURRENT_DATE+110,'ColdMove Logistics','ACTIVE')
ON CONFLICT (company_id, reg_no) DO NOTHING;

INSERT INTO drivers (company_id, full_name, phone, dl_number, dl_expiry, status) VALUES
 ('01919000-0000-7000-8000-000000000001','Santosh Kale','+919011200001','MH1220110012345',CURRENT_DATE+400,'ACTIVE'),
 ('01919000-0000-7000-8000-000000000001','Imran Shaikh','+919011200002','MH1420150067890',CURRENT_DATE+250,'ACTIVE')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. QC templates (§13.3) — per-commodity, parameter driven, not a fixed form
-- ---------------------------------------------------------------------------
INSERT INTO qc_templates (id, company_id, code, name, name_hi, category_id, version, is_active)
VALUES
 ('01919000-0000-7000-8000-000000000091','01919000-0000-7000-8000-000000000001','QC-VEG-GEN','Vegetable — General','सब्ज़ी सामान्य','01919000-0000-7000-8000-000000000052',1,true),
 ('01919000-0000-7000-8000-000000000092','01919000-0000-7000-8000-000000000001','QC-FRU-GEN','Fruit — General','फल सामान्य','01919000-0000-7000-8000-000000000051',1,true),
 ('01919000-0000-7000-8000-000000000093','01919000-0000-7000-8000-000000000001','QC-LEAFY','Leafy Greens','पत्तेदार','01919000-0000-7000-8000-000000000053',1,true)
ON CONFLICT (company_id, code, version) DO NOTHING;

INSERT INTO qc_parameters (company_id, template_id, seq, code, label, label_hi, param_type, unit,
                           min_ok, max_ok, options, is_critical, is_mandatory, weight, requires_photo,
                           ai_assisted, ai_feature_key, help_text) VALUES
 -- Vegetable general
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',1,'FRESH','Freshness','ताज़गी','SELECT',NULL,NULL,NULL,
  '[{"value":"FRESH","label":"Fresh","score":100},{"value":"OK","label":"Acceptable","score":75},{"value":"WILTED","label":"Wilted","score":30}]',
  false,true,2.0,false,true,'freshness_stage','Judge by skin turgidity and colour'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',2,'DAMAGE','Damaged / bruised %','क्षतिग्रस्त %','PERCENT','%',0,5,NULL,false,true,2.5,true,true,'defect_area_pct','Count damaged units in the sample'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',3,'ROT','Rot / mould present','सड़ांध','BOOLEAN',NULL,NULL,NULL,NULL,true,true,3.0,true,true,'rot_detect','Any visible rot is a critical failure'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',4,'SIZE','Average size / count per kg','औसत आकार','NUMERIC','pcs/kg',3,12,NULL,false,true,1.0,false,false,NULL,NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',5,'SOIL','Soil / foreign matter %','मिट्टी %','PERCENT','%',0,3,NULL,false,true,1.5,false,false,NULL,'Deduct from net weight if excessive'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000091',6,'MOIST','Excess surface moisture','अतिरिक्त नमी','BOOLEAN',NULL,NULL,NULL,NULL,false,false,1.0,false,false,NULL,'Wet produce inflates weight and rots faster'),
 -- Fruit general
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',1,'RIPE','Ripeness stage','पकाव','SELECT',NULL,NULL,NULL,
  '[{"value":"UNRIPE","label":"Unripe","score":60},{"value":"OPTIMAL","label":"Optimal","score":100},{"value":"OVERRIPE","label":"Overripe","score":25}]',
  false,true,2.5,true,true,'ripeness_stage','Stage drives shelf life prediction'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',2,'BRIX','Brix (sweetness)','ब्रिक्स','NUMERIC','°Bx',10,22,NULL,false,false,1.5,false,false,NULL,'Use refractometer on 3 sample units'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',3,'BRUISE','Bruising %','चोट %','PERCENT','%',0,4,NULL,false,true,2.5,true,true,'defect_area_pct',NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',4,'ROT','Rot / fungal spots','सड़ांध','BOOLEAN',NULL,NULL,NULL,NULL,true,true,3.0,true,true,'rot_detect','Critical — reject or hold the lot'),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',5,'SIZE','Count per kg','प्रति किलो नग','NUMERIC','pcs/kg',2,10,NULL,false,true,1.0,false,false,NULL,NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000092',6,'UNIFORM','Size uniformity','एकरूपता','SELECT',NULL,NULL,NULL,
  '[{"value":"HIGH","label":"Uniform","score":100},{"value":"MED","label":"Mixed","score":70},{"value":"LOW","label":"Very mixed","score":40}]',
  false,false,1.0,false,false,NULL,NULL),
 -- Leafy
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000093',1,'FRESH','Leaf freshness','पत्ता ताज़गी','SELECT',NULL,NULL,NULL,
  '[{"value":"CRISP","label":"Crisp","score":100},{"value":"SOFT","label":"Slightly soft","score":65},{"value":"WILTED","label":"Wilted","score":20}]',
  false,true,3.0,true,true,'freshness_stage',NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000093',2,'YELLOW','Yellowing %','पीलापन %','PERCENT','%',0,5,NULL,false,true,2.0,true,true,'defect_area_pct',NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000093',3,'ROT','Slime / rot','सड़ांध','BOOLEAN',NULL,NULL,NULL,NULL,true,true,3.0,true,false,NULL,NULL),
 ('01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000093',4,'SOIL','Soil / grit %','मिट्टी %','PERCENT','%',0,4,NULL,false,true,1.5,false,false,NULL,NULL)
ON CONFLICT (template_id, code) DO NOTHING;

-- Attach templates to products
UPDATE products p SET qc_template_id = t.id
FROM qc_templates t
WHERE p.company_id = t.company_id
  AND p.qc_template_id IS NULL
  AND t.code = CASE
        WHEN p.category_id = '01919000-0000-7000-8000-000000000051' THEN 'QC-FRU-GEN'
        WHEN p.category_id = '01919000-0000-7000-8000-000000000053' THEN 'QC-LEAFY'
        ELSE 'QC-VEG-GEN' END;

-- ---------------------------------------------------------------------------
-- 10. Tolerance profile for 3-way match (§17) + approval rules (§9)
-- ---------------------------------------------------------------------------
INSERT INTO tolerance_profiles (company_id, code, name, qty_tol_pct, rate_tol_pct, tax_tol_abs,
                                charge_tol_pct, critical_qty_pct, critical_rate_pct, is_default)
VALUES ('01919000-0000-7000-8000-000000000001','TOL-STD','Standard Fresh Produce',2.0,2.0,5,3.0,6.0,10.0,true)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO approval_rules (company_id, doc_type, trigger_code, threshold_numeric, required_level, required_role_id, sla_minutes)
SELECT '01919000-0000-7000-8000-000000000001', v.doc_type, v.trigger_code, v.threshold, v.lvl,
       (SELECT id FROM roles WHERE company_id='01919000-0000-7000-8000-000000000001' AND code = v.role_code), v.sla
FROM (VALUES
  ('PO','VALUE',        100000::numeric, 2, 'PURCHASE_MGR', 240),
  ('PO','VALUE',        500000::numeric, 3, 'OWNER',        480),
  ('PO','RATE_VARIANCE',    10::numeric, 2, 'PURCHASE_MGR', 120),
  ('PO','NEW_SUPPLIER',   NULL::numeric, 2, 'PURCHASE_MGR', 240),
  ('PO','URGENT',         NULL::numeric, 2, 'PURCHASE_MGR',  60),
  ('GRN','WEIGHT_VARIANCE',  2::numeric, 2, 'PURCHASE_MGR',  60),
  ('INVOICE','VALUE',    50000::numeric, 2, 'FINANCE_EXEC', 480),
  ('REQUIREMENT','VALUE',200000::numeric,2, 'PURCHASE_MGR', 480)
) AS v(doc_type, trigger_code, threshold, lvl, role_code, sla)
WHERE NOT EXISTS (
  SELECT 1 FROM approval_rules ar
  WHERE ar.company_id='01919000-0000-7000-8000-000000000001'
    AND ar.doc_type=v.doc_type AND ar.trigger_code=v.trigger_code
    AND ar.required_level=v.lvl);

-- ---------------------------------------------------------------------------
-- 11. Alert rules (§19) and company settings
-- ---------------------------------------------------------------------------
INSERT INTO alert_rules (company_id, alert_type, is_enabled, severity, threshold, channels, sla_minutes, dedupe_window_minutes)
SELECT '01919000-0000-7000-8000-000000000001', v.t, true, v.s, v.th::jsonb, ARRAY['IN_APP'], v.sla, 60
FROM (VALUES
 ('LOW_STOCK',             'HIGH',    '{"check":"reorder_point"}',   360),
 ('PO_APPROVAL_PENDING',   'MEDIUM',  '{"sla_minutes":240}',         240),
 ('ARRIVAL_MISSED',        'MEDIUM',  '{"grace_hours":6}',           360),
 ('WEIGHT_VARIANCE',       'HIGH',    '{"tolerance_pct":2}',          60),
 ('QC_REJECTION',          'HIGH',    '{"min_reject_pct":5}',         60),
 ('GRN_PENDING',           'MEDIUM',  '{"sla_minutes":120}',         120),
 ('INVOICE_MISMATCH',      'HIGH',    '{}',                          480),
 ('LANDING_COST_ABNORMAL', 'CRITICAL','{"jump_pct":15}',              60),
 ('PUTAWAY_PENDING',       'LOW',     '{"sla_minutes":240}',         240)
) AS v(t,s,th,sla)
WHERE NOT EXISTS (SELECT 1 FROM alert_rules a WHERE a.company_id='01919000-0000-7000-8000-000000000001' AND a.alert_type=v.t);

INSERT INTO settings (company_id, scope, key, value, data_type) VALUES
 ('01919000-0000-7000-8000-000000000001','COMPANY','purchase.weight_tolerance_pct','2','number'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','purchase.rate_tolerance_pct','5','number'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','purchase.qty_tolerance_pct','5','number'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','purchase.fy','"2026-27"','string'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','planning.forecast_horizon_days','7','number'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','planning.service_level_z','1.65','number'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','ai.auto_purchase_enabled','false','boolean'),
 ('01919000-0000-7000-8000-000000000001','COMPANY','costing.abnormal_jump_pct','15','number')
ON CONFLICT (company_id, branch_id, key) DO NOTHING;

INSERT INTO ai_feature_flags (company_id, feature_key, is_enabled, fallback_mode, min_confidence)
SELECT '01919000-0000-7000-8000-000000000001', v.k, true, v.fb, v.c
FROM (VALUES
 ('F1_DEMAND_FORECAST','RULE', 0.60),
 ('F2_BUY_SUGGESTION', 'RULE', 0.55),
 ('F4_PRICE_SIGNAL',   'RULE', 0.55),
 ('F5_QC_ASSIST',      'OFF',   0.70),
 ('F8_ANOMALY',        'RULE', 0.65),
 ('F9_ASSISTANT',      'OFF',   0.50)
) AS v(k,fb,c)
WHERE NOT EXISTS (SELECT 1 FROM ai_feature_flags f WHERE f.company_id='01919000-0000-7000-8000-000000000001' AND f.feature_key=v.k);

COMMIT;
