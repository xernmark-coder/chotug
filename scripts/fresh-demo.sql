-- =============================================================================
-- FRESH APP FOR A DEMO
--
-- Empties every transaction and leaves the place itself standing: the company,
-- its branches and warehouses, the shelves, the product catalogue, the roles
-- and — the point of the exercise — everybody's login.
--
-- What SURVIVES: companies, branches, warehouses, zones/racks/bins, products
-- and categories, UOMs, charge and expense types, tax codes, roles, permissions,
-- users and their access, settings, number series, suppliers, customers,
-- drivers, vehicles, workers, farms and plots, QC templates.
--
-- What GOES: every order, delivery, receipt, inspection, box, sale, payment,
-- audit, task, alert and ledger row.
--
-- Run it against the database you mean. There is no undo.
--     psql "$DATABASE_URL" -f scripts/fresh-demo.sql
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- No trigger juggling is needed: the guards that refuse to delete a posted
-- document are BEFORE DELETE triggers, and TRUNCATE does not fire those. It
-- also means this works as the ordinary application user, with no superuser.

TRUNCATE TABLE
  -- money
  payments, money_receipts, payment_status, payment_requests, credit_debit_notes,
  invoice_lines, supplier_invoices, match_results,
  landing_cost_lines, landing_costs, purchase_charges, po_charges,
  -- buying
  po_revisions, po_lines, purchase_orders, rfqs, supplier_quotes,
  requirement_lines, requirements, approvals,
  -- receiving and quality
  pickups, expected_arrivals, gate_entry_photos, gate_entry_docs, gate_entries,
  weighments, unload_boxes, grn_lines, grns,
  qc_photos, qc_results, qc_lot_grades, qc_inspections,
  -- stock
  packs, pack_runs, labels, containers, batches, stock_balances,
  stock_issue_lines, stock_issues, stock_ledger, putaway_tasks,
  audit_counts, audit_tasks,
  -- selling and centres
  centre_day_close,
  -- people and pay
  worker_attendance, wage_runs,
  -- farm activity (the farms and plots themselves stay)
  farm_dispatch_lines, farm_dispatches, farm_harvest_lines, farm_harvests,
  farm_losses, farm_expenses, farm_observations, farm_tasks, farm_day_closes,
  farm_crop_cycles, farm_staff_scores, farm_weather,
  -- signals, scores and machine output
  demand_forecasts, demand_signals, market_signals, market_prices,
  supplier_defect_trends, supplier_scores, cold_chain_summaries,
  device_readings, reefer_temp_logs, vehicle_trip_logs, ai_runs,
  -- the desk
  work_queue, notifications, alerts, attachments, outbox, integration_log,
  idempotency_keys, audit_log
RESTART IDENTITY CASCADE;

-- Counters that number documents. Left alone they would carry on from wherever
-- the old data stopped, and the first purchase order of a fresh demo would be
-- PO/2026-27/000076.
UPDATE number_series SET next_no = 1;

-- Figures kept ON masters that only mean anything with transactions behind them.
UPDATE suppliers SET
  trust_score = NULL, performance_score = NULL,
  first_purchase_at = NULL, last_purchase_at = NULL;
UPDATE supplier_products SET last_rate = NULL;
UPDATE bins SET current_fill_kg = 0;

-- Sessions point at data that no longer exists; make everyone log in again.
TRUNCATE TABLE sessions;

COMMIT;

-- What is left, so you can see it worked.
SELECT 'users' AS kept, count(*) FROM users
UNION ALL SELECT 'products',   count(*) FROM products
UNION ALL SELECT 'warehouses', count(*) FROM warehouses
UNION ALL SELECT 'suppliers',  count(*) FROM suppliers
UNION ALL SELECT 'bins',       count(*) FROM bins
UNION ALL SELECT '--- wiped ---', NULL
UNION ALL SELECT 'purchase_orders', count(*) FROM purchase_orders
UNION ALL SELECT 'grns',            count(*) FROM grns
UNION ALL SELECT 'packs',           count(*) FROM packs
UNION ALL SELECT 'payment_requests',count(*) FROM payment_requests;
