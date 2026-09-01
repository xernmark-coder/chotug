-- =============================================================================
-- 41 · SENDING ON CREDIT, THE REAL COST OF A KILO, AND A PLACE TO PUT THE
--      GOODS WHILE THEY ARE BEING CHECKED
--
-- Five things the client asked for, all of which turned out to be one thing
-- each of these tables was already almost able to say:
--
--   1. "supplier should be able to send without the payment, this payment will
--       come into due of finance which later finance will settle"
--          → the claim already exists (payment_requests). What was missing is
--            the fact that the goods have gone anyway, which is what turns a
--            request into a DUE. One column, not a second table.
--
--   2. "suppose we buy any product, it should immediately come in expense of
--       the finance panel"
--          → the payable is raised when the order is confirmed rather than
--            when somebody remembers to file the invoice. Handled in code;
--            what the database needs is to be able to tell an automatic claim
--            from a person's, which 22 already gave us.
--
--   3. "when the day is closed by the center the money sent by the center
--       should also come automatically there"
--          → the takings already raise a receipt. The centre's own spending on
--            that day did not, so it is queued as an expense here.
--
--   4. "for every product … total cost as its cost plus cost to take it to
--       warehouse and then send to centers … admin should be able to set
--       particular profit such as 20%"
--          → 32 costed the purchase and the overhead. It never costed the trip
--            OUT to the shop, which on fruit is the second biggest number
--            after the fruit. Added, and the margin is applied to the whole.
--
--   5. "when the items come from the gate after weighting during quality check
--       they should be kept somewhere, so make a section in warehouse about the
--       quality check"
--          → a section with a purpose, and the bay a vehicle's load is parked
--            in while it is inspected.
--
-- Additive and idempotent.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

/* ===========================================================================
 * 1 · THE LOAD WENT ANYWAY — SO THE CLAIM IS NOW A DUE
 *
 * Until now the supplier portal refused to dispatch against an unpaid claim.
 * That is the right default and it stays the default, but it is not how the
 * trade actually works: a supplier who has dealt with you for ten years sends
 * the lorry and collects on Friday. Refusing that pushed the whole arrangement
 * outside the system, which is the one place it must not be.
 *
 * A due is not a new kind of document. It is a payment request whose goods have
 * already moved — so Finance is no longer deciding WHETHER to pay, only when.
 * That distinction is the entire point, and it is one timestamp.
 * ======================================================================== */

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS became_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS due_reason    text;

COMMENT ON COLUMN payment_requests.became_due_at IS
  'Set when the goods moved without the money. Finance owes this, it is no longer optional.';

/* Finance's due list must not be a scan of every claim ever raised. */
CREATE INDEX IF NOT EXISTS ix_payreq_dues
    ON payment_requests (company_id, due_date)
 WHERE became_due_at IS NOT NULL AND status NOT IN ('PAID','REJECTED','CANCELLED');

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS sent_without_payment      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_without_payment_at   timestamptz,
  ADD COLUMN IF NOT EXISTS sent_without_payment_note text;

/* What Finance owes for goods it has already got. Every screen that shows a
 * due reads this, so the desk and the supplier's portal cannot disagree about
 * how much is outstanding. */
CREATE OR REPLACE VIEW v_supplier_dues AS
SELECT pr.id                              AS request_id,
       pr.company_id,
       pr.branch_id,
       pr.request_no,
       pr.supplier_id,
       pr.payee_name,
       pr.amount,
       pr.paid_amount,
       (pr.amount - pr.paid_amount)       AS balance,
       pr.status,
       pr.due_date,
       pr.became_due_at,
       pr.due_reason,
       pr.priority,
       pr.note,
       (pr.due_date IS NOT NULL AND pr.due_date < CURRENT_DATE) AS overdue,
       GREATEST(CURRENT_DATE - pr.due_date, 0)                  AS days_overdue,
       o.id                               AS po_id,
       o.po_no,
       o.sent_without_payment_at,
       i.id                               AS invoice_id,
       i.invoice_no
  FROM payment_requests pr
  LEFT JOIN supplier_invoices i
         ON pr.source_type = 'supplier_invoice' AND i.id = pr.source_id
  LEFT JOIN purchase_orders o
         ON o.id = CASE WHEN pr.source_type = 'purchase_order' THEN pr.source_id
                        ELSE i.po_id END
 WHERE pr.became_due_at IS NOT NULL
   AND pr.status NOT IN ('PAID','REJECTED','CANCELLED');

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('supplier.order.send_unpaid','supplier','order','send_unpaid',
  'Send an order before it has been paid for, leaving a due with Finance', false,'SENSITIVE'),
 ('finance.due.view','finance','due','view',
  'See what the business owes for goods it has already received', false,'SENSITIVE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'SUPPLIER',     ARRAY['supplier.order.send_unpaid']);
        PERFORM grant_role_perms(c.id, 'FINANCE_EXEC', ARRAY['finance.due.view']);
        PERFORM grant_role_perms(c.id, 'PURCHASE_MGR', ARRAY['finance.due.view']);
        PERFORM grant_role_perms(c.id, 'OWNER',        ARRAY['finance.due.view']);
    END LOOP;
END $$;

/* ===========================================================================
 * 2 · THE CENTRE'S OWN SPENDING ON THE DAY IT CLOSES
 *
 * The takings already reach Finance as a receipt. The ₹800 the shop spent on
 * ice and the auto-rickshaw did not reach anything at all — it was typed into
 * a box on the close screen and then only ever read back on that same screen.
 * ======================================================================== */

ALTER TABLE centre_day_close
  ADD COLUMN IF NOT EXISTS expense_request_id uuid REFERENCES payment_requests(id);

/* ===========================================================================
 * 3 · A SECTION IS FOR SOMETHING
 *
 * Sections were all alike: somewhere to put a crate. But the floor has areas
 * that are not storage at all — the strip inside the shutter where a lorry is
 * emptied and the load waits to be checked. Recording that as a normal section
 * meant stock "in the warehouse" that had not been accepted yet.
 * ======================================================================== */

ALTER TABLE zones ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'STORAGE';

DO $$ BEGIN
  ALTER TABLE zones ADD CONSTRAINT ck_zone_purpose
    CHECK (purpose IN ('STORAGE','QC','PACKING','DISPATCH','RETURNS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_zone_purpose ON zones (warehouse_id, purpose)
    WHERE purpose <> 'STORAGE';

/* Where this vehicle's load is standing while it is inspected. Null means it
 * has not been unloaded yet, or the goods have already been put away. */
ALTER TABLE gate_entries
  ADD COLUMN IF NOT EXISTS qc_bin_id      uuid REFERENCES bins(id),
  ADD COLUMN IF NOT EXISTS qc_parked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS qc_released_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_gate_qc_bay ON gate_entries (qc_bin_id)
    WHERE qc_bin_id IS NOT NULL AND qc_released_at IS NULL;

/* Every warehouse gets a quality-check area with four bays, because a
 * warehouse without one has nowhere to put a load and the goods end up on the
 * floor by the shutter with nothing in the system saying so. Existing sites
 * that have already made their own QC section are left alone. */
DO $$
DECLARE w record; v_floor uuid; v_zone uuid; v_rack uuid; n int;
BEGIN
    FOR w IN SELECT id, company_id FROM warehouses WHERE NOT COALESCE(is_centre, false) LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM zones z
                               WHERE z.warehouse_id = w.id AND z.purpose = 'QC');

        SELECT id INTO v_floor FROM warehouse_floors
         WHERE warehouse_id = w.id ORDER BY sort_order LIMIT 1;

        INSERT INTO zones (company_id, warehouse_id, floor_id, code, name,
                           storage_type, purpose, qr_code)
        VALUES (w.company_id, w.id, v_floor, 'QC', 'Quality check area',
                'AMBIENT', 'QC', loc_code('SE'))
        ON CONFLICT (warehouse_id, code) DO UPDATE SET purpose = 'QC'
        RETURNING id INTO v_zone;

        INSERT INTO racks (company_id, zone_id, code, qr_code)
        VALUES (w.company_id, v_zone, 'QC', loc_code('RK'))
        ON CONFLICT (zone_id, code) DO NOTHING
        RETURNING id INTO v_rack;

        IF v_rack IS NULL THEN
            SELECT id INTO v_rack FROM racks WHERE zone_id = v_zone AND code = 'QC';
        END IF;

        FOR n IN 1..4 LOOP
            INSERT INTO bins (company_id, rack_id, code, qr_code)
            VALUES (w.company_id, v_rack, 'QC-' || n, loc_code('SH'))
            ON CONFLICT (rack_id, code) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

/* What is standing in the quality-check area right now, and how long it has
 * been standing there. Produce waiting to be checked is produce losing money,
 * so the age is part of the answer rather than something to work out. */
CREATE OR REPLACE VIEW v_qc_holding AS
SELECT g.company_id,
       g.warehouse_id,
       g.id                          AS gate_entry_id,
       g.gate_no,
       g.status,
       g.qc_bin_id,
       b.code                        AS bay_code,
       b.qr_code                     AS bay_qr,
       z.name                        AS section_name,
       g.qc_parked_at,
       COALESCE(s.trade_name, s.legal_name) AS supplier_name,
       o.po_no,
       COALESCE(t.boxes, 0)          AS boxes,
       COALESCE(t.net_kg, 0)         AS net_kg,
       COALESCE(t.products, 0)       AS products,
       EXTRACT(EPOCH FROM (now() - COALESCE(g.qc_parked_at, g.arrived_at)))/60 AS waiting_minutes
  FROM gate_entries g
  JOIN suppliers s ON s.id = g.supplier_id
  LEFT JOIN purchase_orders o ON o.id = g.po_id
  LEFT JOIN bins  b ON b.id = g.qc_bin_id
  LEFT JOIN racks r ON r.id = b.rack_id
  LEFT JOIN zones z ON z.id = r.zone_id
  LEFT JOIN LATERAL (
      SELECT count(DISTINCT product_id)::int AS products,
             SUM(boxes)::int                 AS boxes,
             SUM(net_kg)                     AS net_kg
        FROM v_unload_totals u WHERE u.gate_entry_id = g.id) t ON true
 WHERE g.qc_released_at IS NULL
   AND g.status NOT IN ('COMPLETED','CANCELLED','REJECTED_AT_GATE')
   /* Two things belong on this list and they are not the same thing.
    *
    * A load somebody has PARKED is standing in the area whatever stage the
    * paperwork has reached — boxes come off the lorry while the gate entry is
    * still ARRIVED, and that is precisely the moment the goods are physically
    * in the QC bay.
    *
    * A load at a QC stage that nobody has parked is the other case worth
    * seeing: it is somewhere on the floor and no bay says where. Listing it
    * with a blank bay is how that gets noticed. */
   AND (g.qc_bin_id IS NOT NULL
     OR g.status IN ('WEIGHED','QC_PENDING','QC_COMPLETE','GRN_PENDING'));

/* ===========================================================================
 * 4 · WHAT A KILO REALLY COSTS, INCLUDING BOTH TRIPS
 *
 *   "for every product it should calculate the total cost as its cost plus
 *    cost to take it to warehouse and then send to centers. on this total cost
 *    the admin should be able to set particular profit such as 20% and then
 *    selling cost will be such that overall 20% profit will be there including
 *    transport cost."
 *
 * Three components, and they were not all present:
 *
 *   landed_rate      what we paid, plus the charges booked against that lorry
 *                    — the trip IN. Already on the batch.
 *   overhead_per_kg  wages, power, rent, cold store, spread over the kilos
 *                    handled. Already derived in 32.
 *   outbound_per_kg  the lorry OUT to the shop. Nowhere at all until now, and
 *                    on fruit it is the second largest number after the fruit.
 *
 * The outbound cost is derived the same way as the overhead: what was actually
 * spent moving stock to centres in the window, over the kilos actually moved.
 * A typed-in figure would be wrong within a week.
 * ======================================================================== */

CREATE OR REPLACE VIEW v_outbound_cost_per_kg AS
WITH win AS (
    SELECT c.id AS company_id, GREATEST(c.overhead_window_days, 1) AS days
      FROM companies c
), moved AS (
    SELECT w.company_id,
           COALESCE(SUM(si.transport_cost), 0)   AS freight,
           COALESCE(SUM(si.total_weight_kg), 0)  AS kg,
           count(si.id)::int                     AS trips
      FROM win w
      LEFT JOIN stock_issues si
             ON si.company_id = w.company_id
            AND si.dest_warehouse_id IS NOT NULL
            AND si.status <> 'CANCELLED'
            AND si.issue_date > CURRENT_DATE - w.days
     GROUP BY w.company_id
)
SELECT w.company_id,
       w.days                        AS window_days,
       COALESCE(m.freight, 0)        AS outbound_spend,
       COALESCE(m.kg, 0)             AS kg_moved,
       COALESCE(m.trips, 0)          AS trips,
       CASE WHEN COALESCE(m.kg, 0) > 0
            THEN ROUND(COALESCE(m.freight, 0) / m.kg, 4)
            ELSE 0 END               AS outbound_per_kg
  FROM win w LEFT JOIN moved m ON m.company_id = w.company_id;

/* The batch price, rebuilt so the trip out is in it. Every column 32 published
 * is still here under the same name — the sell screen reads true_cost and
 * min_sell_price and must not have to change to get a better number.
 *
 * DROP rather than CREATE OR REPLACE: the new columns sit in the middle of the
 * list, and Postgres will only replace a view whose columns are unchanged up to
 * the ones being appended. Nothing else in the schema selects from this view —
 * only application queries do — so dropping it takes nothing with it. */
DROP VIEW IF EXISTS v_batch_pricing;
CREATE VIEW v_batch_pricing AS
WITH factor AS (
    /* Overhead and freight are quoted per kilo. A batch counted in crates
     * carries them via its own kg-per-unit ratio rather than a guess; a batch
     * already counted in kilos has a ratio of one. */
    SELECT b.id AS batch_id,
           CASE WHEN COALESCE(b.landed_rate_per_kg, 0) > 0
                THEN COALESCE(b.landed_rate, 0) / b.landed_rate_per_kg
                ELSE 1 END AS kg_per_unit
      FROM batches b
)
SELECT b.id                       AS batch_id,
       b.company_id,
       b.product_id,
       p.name                     AS product_name,
       b.batch_no,
       b.landed_rate,
       b.landed_rate_per_kg,
       o.overhead_per_kg,
       ob.outbound_per_kg,
       /* Named for what they are, so a screen can show the breakdown the
        * client asked to see rather than one total nobody trusts. */
       ROUND(COALESCE(b.landed_rate, 0), 2)                     AS cost_to_warehouse,
       ROUND(COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit, 2) AS overhead_cost,
       ROUND(COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit, 2) AS cost_to_centre,
       COALESCE(p.default_wastage_pct, 0)                       AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)         AS margin_pct,
       ROUND(COALESCE(b.landed_rate, 0)
             + COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit
             + COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit, 2)  AS true_cost,
       /* The wastage division rather than multiplication is the part that gets
        * done wrong: if a tenth of a crate is thrown away, the nine tenths that
        * sell have to carry the whole crate's cost. */
       ROUND((COALESCE(b.landed_rate, 0)
              + COALESCE(o.overhead_per_kg, 0)  * f.kg_per_unit
              + COALESCE(ob.outbound_per_kg, 0) * f.kg_per_unit)
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                AS min_sell_price
  FROM batches b
  JOIN products p  ON p.id = b.product_id
  JOIN companies c ON c.id = b.company_id
  JOIN factor f    ON f.batch_id = b.id
  LEFT JOIN v_overhead_per_kg     o  ON o.company_id  = b.company_id
  LEFT JOIN v_outbound_cost_per_kg ob ON ob.company_id = b.company_id;

/* The same arithmetic one level up, for the catalogue: what a kilo of THIS
 * product costs us all-in, and the least it can be sold for. Priced off live
 * stock where there is any, and off the last thing we paid where there is not
 * — a product with nothing in stock still has to show a price.
 *
 * DROP rather than CREATE OR REPLACE, for the same reason as v_batch_pricing
 * above: db/46 adds the inbound freight leg as a column in the MIDDLE of this
 * list, and Postgres will not replace a view whose columns have moved. Without
 * the drop, re-running the migrations died here — before 46 could put the
 * column back — and left both pricing views short of the costs they are for. */
DROP VIEW IF EXISTS v_product_pricing;
CREATE VIEW v_product_pricing AS
WITH live AS (
    SELECT b.company_id, b.product_id,
           SUM(b.landed_rate_per_kg * GREATEST(b.remaining_qty, 0)) AS weighted,
           SUM(GREATEST(b.remaining_qty, 0))                        AS qty
      FROM batches b
     WHERE b.status = 'ACTIVE' AND b.remaining_qty > 0
       AND COALESCE(b.landed_rate_per_kg, 0) > 0
     GROUP BY b.company_id, b.product_id
), latest AS (
    SELECT DISTINCT ON (b.company_id, b.product_id)
           b.company_id, b.product_id, b.landed_rate_per_kg
      FROM batches b
     WHERE COALESCE(b.landed_rate_per_kg, 0) > 0
     ORDER BY b.company_id, b.product_id, b.created_at DESC
)
SELECT p.id                            AS product_id,
       p.company_id,
       p.sku,
       p.name                          AS product_name,
       p.icon,
       p.base_uom,
       p.category_id,
       COALESCE(l.qty, 0)              AS qty_on_hand,
       ROUND(COALESCE(NULLIF(l.weighted / NULLIF(l.qty, 0), 0),
                      lt.landed_rate_per_kg, 0), 2)              AS cost_to_warehouse,
       ROUND(COALESCE(o.overhead_per_kg, 0), 2)                  AS overhead_cost,
       ROUND(COALESCE(ob.outbound_per_kg, 0), 2)                 AS cost_to_centre,
       ROUND(COALESCE(NULLIF(l.weighted / NULLIF(l.qty, 0), 0), lt.landed_rate_per_kg, 0)
             + COALESCE(o.overhead_per_kg, 0)
             + COALESCE(ob.outbound_per_kg, 0), 2)               AS total_cost,
       COALESCE(p.default_wastage_pct, 0)                        AS wastage_pct,
       COALESCE(p.min_margin_pct, c.default_margin_pct)          AS margin_pct,
       (p.min_margin_pct IS NOT NULL)                            AS margin_is_own,
       p.sell_price,
       ROUND((COALESCE(NULLIF(l.weighted / NULLIF(l.qty, 0), 0), lt.landed_rate_per_kg, 0)
              + COALESCE(o.overhead_per_kg, 0)
              + COALESCE(ob.outbound_per_kg, 0))
             / GREATEST(1 - COALESCE(p.default_wastage_pct, 0) / 100.0, 0.05)
             * (1 + COALESCE(p.min_margin_pct, c.default_margin_pct) / 100.0), 2)
                                                                 AS min_sell_price
  FROM products p
  JOIN companies c ON c.id = p.company_id
  LEFT JOIN live   l  ON l.product_id  = p.id
  LEFT JOIN latest lt ON lt.product_id = p.id
  LEFT JOIN v_overhead_per_kg      o  ON o.company_id  = p.company_id
  LEFT JOIN v_outbound_cost_per_kg ob ON ob.company_id = p.company_id
 WHERE p.is_active;

GRANT SELECT ON v_supplier_dues, v_qc_holding, v_outbound_cost_per_kg,
                v_batch_pricing, v_product_pricing TO chotug_app;
GRANT SELECT ON v_supplier_dues, v_qc_holding, v_outbound_cost_per_kg,
                v_batch_pricing, v_product_pricing TO chotug_readonly;

/* ===========================================================================
 * 5 · THE ADMIN'S OWN PANEL
 *
 *   "admin should be able to change their password add new accounts of admin
 *    or any other position from their panel"
 *
 * Inviting by email already existed and is still the right way to add somebody
 * with a mailbox. It is useless for the gate clerk who has no email and is
 * standing next to the admin — so the admin may also set the first password
 * directly. That is a real power, so it is its own permission rather than
 * being folded into "manage people".
 * ======================================================================== */

/* A password somebody else chose is a password two people know. The only
 * mitigation that actually works is making it temporary, so the account carries
 * the obligation to replace it rather than relying on anybody remembering. */
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

INSERT INTO permissions (code, module, entity, action, description, is_data_level, risk_level)
VALUES
 ('admin.user.password','admin','user','password',
  'Create a login with a password, or reset somebody''s password', false,'CRITICAL')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        PERFORM grant_role_perms(c.id, 'OWNER', ARRAY['admin.user.password']);
    END LOOP;
END $$;

COMMIT;
