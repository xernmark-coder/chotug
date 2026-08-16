-- ============================================================================
--  ChotuG ERP — FARMING MODULE : MASTER DATA SEED
--  Run AFTER 04_farming.sql. Idempotent — safe to re-run.
--
--  Master data only: the agronomy calendar, one demo farm with four plots,
--  its machines and two farm users. The running crops, the task calendar,
--  the weather and the harvest history are created by
--  `npm --prefix server run seed`, so they go through the same calendar
--  generator production uses instead of being hand-written here.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Two more products so the crop plan has somewhere to put the harvest.
--    §30's "next crop" suggestion is meaningless with only one candidate.
-- ---------------------------------------------------------------------------
INSERT INTO products (id, company_id, sku, name, name_hi, category_id, variety, base_uom, purchase_uom,
                      is_variable_weight, is_perishable, is_batch_tracked, shelf_life_days,
                      storage_type, storage_temp_min_c, storage_temp_max_c, rotation_rule, hsn_code,
                      min_stock, max_stock, reorder_point, safety_stock_days, lead_time_days,
                      default_wastage_pct, grades_allowed, is_active)
VALUES
 ('01919000-0000-7000-8000-000000000069','01919000-0000-7000-8000-000000000001','VEG-CUC-01','Cucumber','खीरा','01919000-0000-7000-8000-000000000052','Malini','KG','KG',
  false,true,true,10,'CHILLED',8,12,'FEFO','0707',80,500,120,1,1,7.0,ARRAY['A','B','C'],true),
 ('01919000-0000-7000-8000-00000000006a','01919000-0000-7000-8000-000000000001','VEG-CAP-01','Capsicum','शिमला मिर्च','01919000-0000-7000-8000-000000000052','Indra Green','KG','CRATE',
  true,true,true,14,'CHILLED',7,10,'FEFO','0709',60,400,90,1,1,6.0,ARRAY['A','B','C'],true)
ON CONFLICT (company_id, sku) DO NOTHING;

UPDATE products p SET qc_template_id = t.id
  FROM qc_templates t
 WHERE p.company_id = t.company_id AND p.qc_template_id IS NULL
   AND t.code = 'QC-VEG-GEN'
   AND p.sku IN ('VEG-CUC-01','VEG-CAP-01');

-- ---------------------------------------------------------------------------
-- 2. Crop master — this is the ONLY place agronomy is configured, and it is
--    what lets §2 ask the staff four questions instead of forty.
--
--    duration_days       sowing → first pick
--    harvest_window_days how long picking runs (1 for a single-lift crop)
--    yield_per_acre_kg   the estimate §20 later measures reality against
--    fertilizer_schedule [{day, label, input, qtyPerAcre, uom}] → auto tasks
-- ---------------------------------------------------------------------------
INSERT INTO farm_crops (company_id, code, name, name_hi, product_id, duration_days,
                        harvest_window_days, yield_per_acre_kg, seed_cost_per_acre,
                        input_cost_per_acre, irrigation_interval_days,
                        irrigation_interval_days_hot, inspection_interval_days,
                        fertilizer_schedule, spray_schedule, seasons, water_need,
                        avoid_after_crop_codes)
SELECT '01919000-0000-7000-8000-000000000001', v.code, v.name, v.name_hi,
       (SELECT id FROM products WHERE company_id='01919000-0000-7000-8000-000000000001' AND sku = v.sku),
       v.dur, v.win, v.yield_acre, v.seed_cost, v.input_cost, v.irr, v.irr_hot, v.insp,
       v.fert::jsonb, v.spray::jsonb, v.seasons, v.water, v.avoid
FROM (VALUES
 ('TOMATO','Tomato','टमाटर','VEG-TOM-01', 70, 35, 12000, 9000, 46000, 4, 2, 7,
  '[{"day":10,"label":"Basal dose — DAP","input":"DAP","qtyPerAcre":50,"uom":"KG"},
    {"day":25,"label":"First top dressing — Urea","input":"Urea","qtyPerAcre":40,"uom":"KG"},
    {"day":45,"label":"Flowering dose — NPK 19:19:19","input":"NPK 19:19:19","qtyPerAcre":25,"uom":"KG"},
    {"day":60,"label":"Fruit-set dose — Potash","input":"MOP","qtyPerAcre":25,"uom":"KG"}]',
  '[{"day":20,"label":"Preventive fungicide check"},
    {"day":40,"label":"Fruit borer inspection"},
    {"day":55,"label":"Leaf curl / whitefly check"}]',
  ARRAY['KHARIF','RABI','ALL'],'HIGH', ARRAY['TOMATO','CAPSICUM']),

 ('ONION','Onion','प्याज़','VEG-ONI-01', 115, 7, 10000, 7000, 38000, 7, 5, 10,
  '[{"day":15,"label":"Basal dose — DAP","input":"DAP","qtyPerAcre":50,"uom":"KG"},
    {"day":35,"label":"Nitrogen split — Urea","input":"Urea","qtyPerAcre":45,"uom":"KG"},
    {"day":60,"label":"Bulb development — Sulphur","input":"Sulphur","qtyPerAcre":20,"uom":"KG"}]',
  '[{"day":30,"label":"Thrips inspection"},{"day":70,"label":"Purple blotch check"}]',
  ARRAY['RABI','ALL'],'MEDIUM', ARRAY['ONION']),

 ('POTATO','Potato','आलू','VEG-POT-01', 95, 5, 9000, 22000, 34000, 6, 4, 10,
  '[{"day":12,"label":"Basal dose — NPK","input":"NPK 10:26:26","qtyPerAcre":60,"uom":"KG"},
    {"day":30,"label":"Earthing up + Urea","input":"Urea","qtyPerAcre":40,"uom":"KG"},
    {"day":55,"label":"Tuber bulking — Potash","input":"MOP","qtyPerAcre":30,"uom":"KG"}]',
  '[{"day":35,"label":"Late blight inspection"},{"day":65,"label":"Aphid check"}]',
  ARRAY['RABI'],'MEDIUM', ARRAY['POTATO','TOMATO']),

 ('SPINACH','Spinach','पालक','VEG-SPI-01', 32, 14, 3500, 2500, 12000, 3, 2, 6,
  '[{"day":8,"label":"Nitrogen boost — Urea","input":"Urea","qtyPerAcre":20,"uom":"KG"},
    {"day":18,"label":"Second cut feed — Urea","input":"Urea","qtyPerAcre":15,"uom":"KG"}]',
  '[{"day":14,"label":"Leaf miner check"}]',
  ARRAY['ALL'],'HIGH', ARRAY[]::text[]),

 ('CAULIFLOWER','Cauliflower','फूलगोभी','VEG-CAU-01', 85, 12, 8000, 6000, 30000, 5, 3, 8,
  '[{"day":12,"label":"Basal dose — DAP","input":"DAP","qtyPerAcre":45,"uom":"KG"},
    {"day":30,"label":"Vegetative push — Urea","input":"Urea","qtyPerAcre":35,"uom":"KG"},
    {"day":50,"label":"Curd initiation — Boron","input":"Borax","qtyPerAcre":5,"uom":"KG"}]',
  '[{"day":25,"label":"Diamondback moth check"},{"day":55,"label":"Curd rot inspection"}]',
  ARRAY['RABI','ALL'],'MEDIUM', ARRAY['CAULIFLOWER']),

 ('CUCUMBER','Cucumber','खीरा','VEG-CUC-01', 45, 30, 7000, 5500, 24000, 3, 2, 7,
  '[{"day":10,"label":"Basal dose — NPK","input":"NPK 19:19:19","qtyPerAcre":30,"uom":"KG"},
    {"day":25,"label":"Vine feed — Urea","input":"Urea","qtyPerAcre":25,"uom":"KG"}]',
  '[{"day":18,"label":"Downy mildew check"},{"day":32,"label":"Fruit fly inspection"}]',
  ARRAY['ALL'],'HIGH', ARRAY['CUCUMBER']),

 ('CAPSICUM','Capsicum','शिमला मिर्च','VEG-CAP-01', 75, 40, 9000, 14000, 52000, 3, 2, 7,
  '[{"day":12,"label":"Basal dose — DAP","input":"DAP","qtyPerAcre":50,"uom":"KG"},
    {"day":30,"label":"Vegetative dose — Urea","input":"Urea","qtyPerAcre":30,"uom":"KG"},
    {"day":50,"label":"Fruit-set — Calcium nitrate","input":"Calcium Nitrate","qtyPerAcre":20,"uom":"KG"}]',
  '[{"day":22,"label":"Thrips / mite inspection"},{"day":45,"label":"Anthracnose check"}]',
  ARRAY['RABI','ALL'],'HIGH', ARRAY['CAPSICUM','TOMATO'])
) AS v(code,name,name_hi,sku,dur,win,yield_acre,seed_cost,input_cost,irr,irr_hot,insp,
       fert,spray,seasons,water,avoid)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The demo farm. §1 — entered once and then never asked for again.
-- ---------------------------------------------------------------------------
INSERT INTO farms (id, company_id, branch_id, code, name, is_own, village, area_acre,
                   water_source, soil_type, default_warehouse_id, geo_lat, geo_lng, status)
VALUES ('01919000-0000-7000-8000-000000000084','01919000-0000-7000-8000-000000000001',
        '01919000-0000-7000-8000-000000000011','FARM-01','ChotuG Farm-01', true,
        'Shirur, Pune', 4.0, 'TUBE_WELL', 'Black cotton',
        '01919000-0000-7000-8000-000000000021', 18.8280, 74.3730, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO farm_plots (company_id, farm_id, code, name, area_acre, soil_type, irrigation_type, qr_code, status)
SELECT '01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000084',
       v.code, v.name, v.area, 'Black cotton', v.irr, 'PLOT-FARM01-' || v.code, 'IDLE'
FROM (VALUES
  ('A','North block',   1.2, 'DRIP'),
  ('B','Canal side',    1.0, 'DRIP'),
  ('C','Well block',    1.0, 'SPRINKLER'),
  ('D','Back block',    0.8, 'FLOOD')
) AS v(code, name, area, irr)
ON CONFLICT (farm_id, code) DO NOTHING;

INSERT INTO farm_machines (company_id, farm_id, code, name, machine_type, status,
                           last_service_date, service_interval_days, next_service_date)
SELECT '01919000-0000-7000-8000-000000000001','01919000-0000-7000-8000-000000000084',
       v.code, v.name, v.mtype, v.status,
       CURRENT_DATE - v.since, v.interval, CURRENT_DATE - v.since + v.interval
FROM (VALUES
  ('MC-TRC-01','Mahindra 275 DI Tractor','TRACTOR',  'AVAILABLE',       40,  90),
  ('MC-PMP-01','5 HP Submersible Pump',  'PUMP',     'AVAILABLE',       20, 120),
  ('MC-SPR-01','Knapsack Power Sprayer', 'SPRAYER',  'MAINTENANCE_DUE', 95,  90),
  ('MC-TLR-01','Rotavator / Tiller',     'TILLER',   'AVAILABLE',       15, 180)
) AS v(code, name, mtype, status, since, interval)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Two farm users. Passwords are hashed by `npm --prefix server run seed`.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, company_id, employee_code, full_name, email, phone, locale, default_branch_id, status) VALUES
 ('01919000-0000-7000-8000-000000000108','01919000-0000-7000-8000-000000000001','E-008','Dattatray Kadam','farm@chotug.in','+919820000008','hi','01919000-0000-7000-8000-000000000011','ACTIVE'),
 ('01919000-0000-7000-8000-000000000109','01919000-0000-7000-8000-000000000001','E-009','Sunita Bhosale','field@chotug.in','+919820000009','hi','01919000-0000-7000-8000-000000000011','ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_role_assignments (company_id, user_id, role_id)
SELECT '01919000-0000-7000-8000-000000000001', u.id, r.id
FROM (VALUES
  ('01919000-0000-7000-8000-000000000108'::uuid,'FARM_MGR'),
  ('01919000-0000-7000-8000-000000000109','FARM_STAFF')
) AS u(id, role_code)
JOIN roles r ON r.company_id = '01919000-0000-7000-8000-000000000001' AND r.code = u.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id AND a.role_id = r.id);

UPDATE farms SET manager_id = '01919000-0000-7000-8000-000000000108'
 WHERE id = '01919000-0000-7000-8000-000000000084' AND manager_id IS NULL;

COMMIT;
