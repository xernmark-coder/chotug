tok(){ curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"chotug123\"}"|python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))"; }
Q(){ PGPASSWORD=chotug psql "postgres://chotug:chotug@localhost:5432/chotug_erp" -tAc "$1"; }
J='content-type: application/json'
OWN=$(tok owner@chotug.in); FIN=$(tok finance@chotug.in); SUP=$(tok sahyadri@gmail.com)
GT=$(tok gate@chotug.in); WHT=$(tok wh@chotug.in); AUD=$(tok audit@chotug.in); BUY=$(tok buyer@chotug.in)
PASS=0; FAIL=0
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
no(){ printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
chk(){ [ -n "$2" ] && [ "$2" != "0" ] && [ "$2" != "null" ] && ok "$1 ($2)" || no "$1" "got '$2'"; }

echo "── 3 · supplier files invoice + vehicle at confirmation, gate types one number"
chk "supplier can accept/decline"        "$(Q "SELECT count(*) FROM permissions WHERE code='supplier.order.accept'")"
chk "orders carry the supplier's answer" "$(Q "SELECT count(*) FROM purchase_orders WHERE supplier_response<>'PENDING'")"
chk "invoices filed by the supplier"     "$(Q "SELECT count(*) FROM supplier_invoices WHERE filed_by_supplier")"
INV=$(Q "SELECT invoice_no FROM supplier_invoices WHERE filed_by_supplier ORDER BY created_at DESC LIMIT 1")
LK=$(curl -s "localhost:4000/api/receiving/lookup/invoice?no=$INV" -H "Authorization: Bearer $GT")
echo "$LK" | grep -q '"found": *true' && echo "$LK" | grep -q 'vehicle_reg' \
  && ok "gate lookup autofills vehicle+driver" || no "gate lookup" "$(echo "$LK"|head -c 80)"
# The driver's name is optional at acceptance — a farmer answering on a phone
# at 5am has the lorry number and not much else — so assert the FIELDS come
# back and the order is identified, not that this particular row was complete.
echo "$LK" | python3 -c "
import sys,json
d=json.load(sys.stdin)
need={'driver_name','driver_phone','vehicle_reg','transporter','lr_no','eway_bill_no'}
exit(0 if d.get('po_no') and need <= set(d) else 1)" \
  && ok "…and the order, with every vehicle field to fill" || no "autofill fields" "missing"

echo "── 5 · one tracking code per supplier+product"
chk "supplier product codes"  "$(Q "SELECT count(*) FROM supplier_products WHERE tracking_code IS NOT NULL")"
chk "tracking codes unique"   "$(Q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_supplier_tracking_code'")"

echo "── 7 · every box weighed on unload"
chk "boxes weighed"           "$(Q "SELECT count(*) FROM unload_boxes WHERE voided_at IS NULL")"
chk "per-product totals view" "$(Q "SELECT count(*) FROM v_unload_totals")"
chk "a void needs a reason"   "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='ck_box_void'")"

echo "── 11 · Finance is the centre of the money"
chk "payment requests"        "$(Q "SELECT count(*) FROM payment_requests")"
chk "…from suppliers"         "$(Q "SELECT count(*) FROM payment_requests WHERE kind IN ('SUPPLIER_INVOICE','ADVANCE')")"
chk "…for wages"              "$(Q "SELECT count(*) FROM payment_requests WHERE kind='WAGES'")"
chk "…for expenses/transport" "$(Q "SELECT count(*) FROM payment_requests WHERE kind IN ('EXPENSE','TRANSPORT')")"
chk "expense categories"      "$(Q "SELECT count(*) FROM expense_categories")"
chk "payments made"           "$(Q "SELECT count(*) FROM payments WHERE status='POSTED'")"
chk "collections recorded"    "$(Q "SELECT count(*) FROM money_receipts")"
chk "centre performance API"  "$(curl -s -o /dev/null -w '%{http_code}' localhost:4000/api/centres/performance -H "Authorization: Bearer $FIN")"

echo "── 13 · cash or online, UPI, transaction ids"
chk "payment modes tracked"   "$(Q "SELECT count(DISTINCT mode) FROM payments")"
chk "company UPI column"      "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='companies' AND column_name='upi_id'")"
chk "company UPI set"         "$(Q "SELECT count(*) FROM companies WHERE upi_id IS NOT NULL")"
chk "each place knows what to print" "$(Q "SELECT count(*) FROM v_effective_upi WHERE upi_id IS NOT NULL")"
chk "centre UPI set"          "$(Q "SELECT count(*) FROM warehouses WHERE upi_id IS NOT NULL")"
DUP=$(curl -s -X POST "localhost:4000/api/finance/requests" -H "Authorization: Bearer $FIN" -H "$J" -d '{"kind":"EXPENSE","amount":1,"payeeName":"x"}')
REF=$(Q "SELECT transaction_ref FROM payments WHERE transaction_ref IS NOT NULL LIMIT 1")
chk "transaction refs stored" "$(Q "SELECT count(*) FROM payments WHERE transaction_ref IS NOT NULL")"
chk "…and unique"             "$(Q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_payment_txn_ref'")"

echo "── 15 · floor → section → rack → shelf, each with a QR"
chk "floors"   "$(Q "SELECT count(*) FROM warehouse_floors")"
chk "sections" "$(Q "SELECT count(*) FROM zones WHERE qr_code IS NOT NULL")"
chk "racks"    "$(Q "SELECT count(*) FROM racks WHERE qr_code IS NOT NULL")"
chk "shelves"  "$(Q "SELECT count(*) FROM bins WHERE qr_code IS NOT NULL")"
QR=$(Q "SELECT qr_code FROM bins WHERE qr_code IS NOT NULL LIMIT 1")
curl -s "localhost:4000/api/warehouse/scan/$QR" -H "Authorization: Bearer $AUD" | grep -q '"found": *true' \
  && ok "scanning a shelf answers" || no "shelf scan" "not found"

echo "── 17/45 · a movement shows up everywhere at once"
B4=$(Q "SELECT COALESCE(SUM(qty),0) FROM stock_balances")
LED=$(Q "SELECT count(*) FROM stock_ledger")
[ "$LED" -gt 0 ] && ok "ledger is the single record ($LED entries)" || no "ledger" "empty"
chk "balances derive from it" "$(Q "SELECT count(*) FROM stock_balances WHERE qty <> 0")"

echo "── 19 · the audit team"
chk "audit role"      "$(Q "SELECT count(*) FROM roles WHERE code='AUDITOR'")"
chk "audit tasks"     "$(Q "SELECT count(*) FROM audit_tasks")"
chk "counts recorded" "$(Q "SELECT count(*) FROM audit_counts")"
chk "who/when/loss"   "$(Q "SELECT count(*) FROM audit_counts WHERE counted_by IS NOT NULL AND counted_at IS NOT NULL")"
chk "loss valued"     "$(Q "SELECT count(*) FROM audit_counts WHERE loss_value IS NOT NULL")"
echo -n "  auditor cannot move stock: "
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST localhost:4000/api/inventory/issues -H "Authorization: Bearer $AUD" -H "$J" -d '{}')
[ "$c" = 403 ] && ok "403" || no "auditor isolation" "$c"

echo "── 21 · customers from a dropdown, and add-new everywhere"
chk "customers"            "$(Q "SELECT count(*) FROM customers")"
chk "sales linked to them" "$(Q "SELECT count(*) FROM stock_issues WHERE customer_id IS NOT NULL")"
for r in "centres.ts:/customers" "masters.ts:/vehicles" "masters.ts:/drivers" "masters.ts:/products" "masters.ts:/categories" "warehousemap.ts:/shelves" "hr.ts:/workers"; do
  file=${r%%:*}; route=${r#*:}
  grep -q "Router.post('$route'" server/src/modules/$file \
    && ok "the API can add one: POST $route" || no "add-new: POST $route" "missing in $file"
done
# An endpoint is not a button. The client asked for the option ON THE DROPDOWN,
# so check the screens where someone picks from a list and would need a new one.
#   file : the select's marker text : the modal that must be reachable from it
for r in "Packing.tsx:customer:AddCustomerModal" \
         "Receiving.tsx:vehicle:VehicleModal" \
         "Receiving.tsx:driver:DriverModal" \
         "Purchase.tsx:Choose a supplier:SupplierModal" \
         "QuickOrder.tsx:Choose a supplier:SupplierModal" \
         "Centres.tsx:What do you need:ProductModal" \
         "FinanceDesk.tsx:Expense type:ExpenseTypeModal"; do
  file=${r%%:*}; rest=${r#*:}; mark=${rest%%:*}; modal=${rest#*:}
  if grep -qi "$mark" web/src/pages/$file && grep -q "$modal" web/src/pages/$file; then
    ok "add-new beside the dropdown: $file → $modal"
  else
    no "add-new beside the dropdown: $file" "no $modal — the picker is a dead end"
  fi
done

echo "── 23 · person-centric permissions override the role"
chk "override table" "$(Q "SELECT count(*) FROM information_schema.tables WHERE table_name='user_permission_overrides'")"
chk "resolver view"  "$(Q "SELECT count(*) FROM v_user_permissions")"
BID=$(Q "SELECT id FROM users WHERE email='buyer@chotug.in'")
curl -s -X POST "localhost:4000/api/masters/users/$BID/permissions" -H "Authorization: Bearer $OWN" -H "$J" \
 -d '{"permissionCode":"purchase.po.approve","effect":"GRANT","reason":"verification run"}' >/dev/null
BUY2=$(tok buyer@chotug.in)
curl -s localhost:4000/api/auth/me -H "Authorization: Bearer $BUY2" | grep -q 'purchase.po.approve' \
  && ok "granted permission takes effect" || no "grant" "not applied"
curl -s -X POST "localhost:4000/api/masters/users/$BID/permissions/reset" -H "Authorization: Bearer $OWN" -H "$J" -d '{}' >/dev/null
BUY3=$(tok buyer@chotug.in)
curl -s localhost:4000/api/auth/me -H "Authorization: Bearer $BUY3" | grep -q 'purchase.po.approve' \
  && no "reset" "still granted" || ok "reset puts them back on the role"

echo "── 27 · quality and packing together, then onto a shelf"
chk "boxes graded at the bench" "$(Q "SELECT count(*) FROM packs WHERE graded_by IS NOT NULL")"
chk "…with their own grade"     "$(Q "SELECT count(DISTINCT grade) FROM packs WHERE graded_by IS NOT NULL")"
chk "…stored on a shelf"        "$(Q "SELECT count(*) FROM packs WHERE bin_id IS NOT NULL")"
chk "shelf contents view"       "$(Q "SELECT count(*) FROM v_bin_contents")"

echo "── 29 · centres"
chk "centres"                  "$(Q "SELECT count(*) FROM warehouses WHERE is_centre")"
chk "stock sent to them"       "$(Q "SELECT count(*) FROM stock_issues WHERE dest_warehouse_id IS NOT NULL")"
chk "vehicle + transport cost" "$(Q "SELECT count(*) FROM stock_issues WHERE transport_cost IS NOT NULL")"
chk "daily close"              "$(Q "SELECT count(*) FROM centre_day_close")"
chk "…with the system's figure beside it" "$(Q "SELECT count(*) FROM centre_day_close WHERE system_revenue IS NOT NULL")"
chk "centre requirement fields" "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='requirements' AND column_name='reasoning'")"

echo "── 33 · an SVG for each product"
chk "icons in the icon set" "$(grep -c 'mango\|apple\|banana\|tomato\|onion\|potato\|leafy\|cauliflower\|cucumber\|capsicum\|grapes' web/src/components/icons.tsx)"
chk "products carrying one" "$(Q "SELECT count(*) FROM products WHERE icon IS NOT NULL")"

echo "── 35 · bought for / total expense / minimum sell"
chk "overhead derived"   "$(Q "SELECT count(*) FROM v_overhead_per_kg WHERE overhead_per_kg > 0")"
chk "minimum sell price" "$(Q "SELECT count(*) FROM v_batch_pricing WHERE min_sell_price > true_cost")"
curl -s localhost:4000/api/inventory/sell-suggestions -H "Authorization: Bearer $OWN" \
 | python3 -c "
import sys,json;d=json.load(sys.stdin)
r = d['suggestions'] if isinstance(d,dict) else d
exit(0 if r and r[0].get('min_sell_price') and r[0].get('floorRate') else 1)" \
 && ok "the till sees the floor price" || no "till pricing" "missing"

echo "── 37 · category → product → breed"
chk "categories"       "$(Q "SELECT count(*) FROM product_categories")"
chk "…nested"          "$(Q "SELECT count(*) FROM product_categories WHERE parent_id IS NOT NULL")"
chk "products under them" "$(Q "SELECT count(*) FROM products WHERE category_id IS NOT NULL")"

echo "── 39 · product and category performance"
curl -s "localhost:4000/api/insights/product-performance?days=90" -H "Authorization: Bearer $OWN" \
 | python3 -c "
import sys,json;d=json.load(sys.stdin)
p=d['products'][0] if d['products'] else {}
need=['boughtQty','soldQty','revenue','suppliers','places','wasteValue','trend']
missing=[k for k in need if k not in p]
exit(1 if missing or not d['categories'] else 0)" \
 && ok "every card field present, categories too" || no "performance payload" "incomplete"

echo "── 41 · HR"
chk "workers"    "$(Q "SELECT count(*) FROM workers")"
chk "attendance" "$(Q "SELECT count(*) FROM worker_attendance")"
chk "leave tracked" "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='worker_attendance' AND column_name='is_paid_leave'")"
chk "hours tracked" "$(Q "SELECT count(*) FROM worker_attendance WHERE hours IS NOT NULL")"
chk "wage runs"  "$(Q "SELECT count(*) FROM wage_runs")"
chk "bonuses"    "$(Q "SELECT count(*) FROM wage_runs WHERE bonus_amount > 0")"
chk "output measured" "$(Q "SELECT count(*) FROM v_worker_output")"
chk "wages reach Finance" "$(Q "SELECT count(*) FROM wage_runs WHERE request_id IS NOT NULL")"

echo "── 29 · sending stock to a centre"
chk "transfers dispatched"       "$(Q "SELECT count(*) FROM stock_issues WHERE dest_warehouse_id IS NOT NULL")"
chk "…and booked in at the shop" "$(Q "SELECT count(*) FROM stock_issues WHERE status='RECEIVED' AND dest_warehouse_id IS NOT NULL")"
chk "vehicle recorded"           "$(Q "SELECT count(*) FROM stock_issues WHERE dest_warehouse_id IS NOT NULL AND vehicle_reg IS NOT NULL")"
chk "transport cost recorded"    "$(Q "SELECT count(*) FROM stock_issues WHERE transport_cost > 0")"
chk "…and it reached Finance"    "$(Q "SELECT count(*) FROM payment_requests WHERE kind='TRANSPORT'")"
chk "a short load is explained"  "$(Q "SELECT count(*) FROM stock_issues WHERE received_note IS NOT NULL")"
chk "the shop has stock"         "$(Q "SELECT count(*) FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id WHERE w.is_centre AND sb.qty<>0")"
# An endpoint nothing calls is a feature nobody has. This is how the send flow
# shipped with a working API and no button for a whole phase.
grep -q "centres/transfers'" web/src/pages/Centres.tsx \
  && ok "a screen actually calls it" || no "send screen" "the API has no caller"
grep -q "SendToCentreModal" web/src/pages/Grn.tsx \
  && ok "reachable from the stock page" || no "stock page" "no way in"
grep -q "SendToCentreModal" web/src/pages/Centres.tsx \
  && ok "reachable from the centre's page" || no "centre page" "no way in"
# The receive path must be able to name a line, or a shortfall cannot be recorded.
grep -q "'id', sil.id" server/src/modules/inventory.ts \
  && ok "issue lines carry their id" || no "issue lines" "no id — shortfall cannot be recorded"
grep -q "si.id = \$4" server/src/modules/inventory.ts \
  && ok "?id= asks for one load, not the newest" || no "?id=" "ignored"

echo "── 47 · the second round of changes"
# The AI suggestion is a number a buyer acts on, not a decimal.
grep -q "DEFAULT_ORDER_STEP = 5" server/src/domain/index.ts \
  && ok "buy suggestions round up to 5" || no "rounding" "not applied"
grep -q "cover + suggested > i.maxStock" server/src/domain/index.ts \
  && ok "...without breaching the storage ceiling" || no "maxStock" "rounding ignores it"

# The office no longer presses a button named after an accounting term.
grep -rq "3-way match" web/src/pages/ && no "3-way match button" "still in the UI" \
  || ok "no 3-way match jargon on screen"
grep -q "checkInvoiceAgainstReceipts" server/src/modules/costing.ts \
  && ok "the comparison runs on its own at capture" || no "auto check" "missing"
grep -q "checkInvoiceAgainstReceipts" server/src/modules/supplier.ts \
  && ok "...and when a supplier files against a receipt" || no "supplier check" "missing"

# The supplier confirms; the buyer is told.
grep -q "Send to supplier" web/src/pages/Purchase.tsx \
  && ok "the buyer sends, they do not \"confirm with\"" || no "wording" "still claims to confirm"
grep -q "accepted by the supplier" server/src/modules/supplier.ts \
  && ok "acceptance reaches the buyer's queue" || no "notification" "missing"
grep -q "required_permission = EXCLUDED.required_permission" server/src/platform/services.ts \
  && ok "a re-pushed task reaches its new audience" || no "task audience" "keeps the old one"
grep -q "tel:" web/src/pages/Purchase.tsx \
  && ok "their number is there to ring if wanted" || no "phone" "not shown"

# The supplier posts their own rates.
chk "standing rates posted"    "$(Q "SELECT count(*) FROM supplier_quotes WHERE is_standing AND superseded_at IS NULL")"
chk "...by the supplier"       "$(Q "SELECT count(*) FROM supplier_quotes WHERE quoted_by_supplier")"
chk "old rates kept"           "$(Q "SELECT count(*) FROM supplier_quotes WHERE superseded_at IS NOT NULL")"
chk "one live rate per pair"   "$(Q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_standing_quote'")"
chk "what we last paid"        "$(Q "SELECT count(*) FROM supplier_products WHERE last_rate IS NOT NULL")"
grep -q "supplier_products" server/src/modules/receiving.ts \
  && ok "...recorded when a receipt is posted" || no "last_rate" "never written"
grep -q "AskingRates" web/src/pages/Finance.tsx \
  && ok "the office can compare them" || no "comparison" "no screen"
grep -q "rate-strip" web/src/pages/QuickOrder.tsx \
  && ok "...and they show while ordering" || no "order screen" "rates not shown"

# Quality and packing are one job, done by the people who grade.
grep -q "inventory.pack.grade" web/src/components/ui.tsx \
  && ok "QC can reach the bench" || no "QC access" "locked out of packing"
grep -q "pack-bench" web/src/pages/Grn.tsx \
  && ok "straight from the receipt to the bench" || no "route" "no link"

# Transport, from the moment the order is placed.
grep -q "APPROVED','CONFIRMED" server/src/modules/receiving.ts \
  && ok "a vehicle can be arranged once placed" || no "candidates" "confirmed only"
chk "supplier can ask"          "$(Q "SELECT count(*) FROM permissions WHERE code='supplier.transport.request'")"
chk "queue accepts the request" "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='work_queue_queue_key_check' AND pg_get_constraintdef(oid) LIKE '%TRANSPORT_REQUEST%'")"
grep -q "Arrange a vehicle" web/src/pages/Purchase.tsx \
  && ok "...or the office assigns one from the order" || no "assign" "no button"

echo "── 71 · a quality check without a checklist"
# The plan endpoint refused when a product had no template, so the dialog was
# empty, "Save inspection" stayed enabled, and pressing it died on
# «can't access property "template", plan is null» — with the lorry at the gate.
chk "an inspection may have no checklist" "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='qc_inspections' AND column_name='template_id' AND is_nullable='YES'")"
chk "...and then carries no score"        "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='ck_qc_scored_only_with_template'")"
grep -q "No checklist is not a refusal" server/src/modules/receiving.ts \
  && ok "the plan comes back either way" || no "plan" "still refuses"
grep -q "templateId: z.string().uuid().nullable()" server/src/modules/receiving.ts \
  && ok "the save accepts none" || no "save" "still demands one"
grep -q "})).default(\[\])," server/src/modules/receiving.ts \
  && ok "...with no answers to give" || no "answers" "still min(1)"
grep -q "plan.template?.id ?? null" web/src/pages/Receiving.tsx \
  && ok "the screen stops reaching into null" || no "screen" "still crashes"
grep -q "No checklist has been set up for" server/src/modules/receiving.ts \
  && ok "...and says what to do about it" || no "message" "unexplained"

# An option is {value,label,score}; one template briefly held bare strings and
# rendered as three blank buttons.
chk "no bare-string options left" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM qc_parameters WHERE param_type='SELECT' AND options IS NOT NULL AND jsonb_typeof(options->0)='string')")"
grep -q "typeof o === 'string' ? o : o?.value" web/src/pages/Receiving.tsx \
  && ok "and a stray one can no longer blank a button" || no "renderer" "assumes objects"

echo "── 69 · how full a shelf is"
# bins.current_fill_kg is a stored number nothing maintains: the bench puts
# boxes on a shelf without touching it, and selling takes them off without
# touching it. It read 0 on a shelf holding 10 kg of bananas — and, worse and
# invisibly, made the put-away suggestion think every shelf was empty.
chk "there is one definition of it" "$(Q "SELECT count(*) FROM information_schema.views WHERE table_name='v_bin_fill'")"
grep -q "JOIN v_bin_fill f ON f.bin_id = b.id" server/src/modules/receiving.ts \
  && ok "the put-away suggestion uses it" || no "suggestion" "reads the stale column"
grep -q "v_bin_fill" server/src/modules/inventory.ts \
  && ok "the packing bench uses it" || no "bench" "reads the stale column"
grep -q "v_bin_fill" server/src/modules/warehousemap.ts \
  && ok "the shelf on the map uses it" || no "map" "reads the stale column"
grep -q "v_bin_fill" server/src/modules/masters.ts \
  && ok "so does the bin list" || no "bins" "reads the stale column"
# A box counted in kilos weighs its quantity; only 8 of 97 carried a weight.
grep -q "CASE WHEN pk.uom = 'KG' THEN pk.qty END" db/44_bin_fill.sql \
  && ok "a box counted in kilos weighs its quantity" || no "weight" "sums nulls"
grep -q "sb.base_uom === 'KG' ? g.qtyPerPack : null" server/src/modules/inventory.ts \
  && ok "...and new boxes record it" || no "packing" "still leaves it empty"
chk "shelves reporting a real weight" "$(Q "SELECT count(*) FROM v_bin_fill WHERE fill_kg > 0")"
chk "capacity now actually limits"    "$(Q "
  SELECT count(*) FROM bins b JOIN v_bin_fill f ON f.bin_id=b.id
   WHERE b.capacity_kg IS NOT NULL AND f.fill_kg + 1450 > b.capacity_kg")"

echo "── 67 · selling is the priority"
# The send screen split on price, which it does not show — so two rows reading
# "Alphonso · BAT/…29 · 5.00 KG · A · C2-R1-2" looked like the same thing twice.
grep -q "Merged one step coarser than the till groups them" web/src/pages/Centres.tsx \
  && ok "send rows merge when only the price differs" || no "send rows" "split invisibly"
grep -q "on the labels" web/src/pages/Centres.tsx \
  && ok "...and the spread is shown, not averaged" || no "price range" "hidden"

# A man at the counter with money is a sale. Which shop a customer is filed
# under, and whether somebody archived him, are management facts.
grep -q "forSale=1" web/src/pages/Packing.tsx \
  && ok "the till sees every customer" || no "till" "filters them out"
grep -q "forSale ? " server/src/modules/centres.ts \
  || grep -q "(\$4::boolean OR c.is_active)" server/src/modules/centres.ts \
  && ok "...archived and other-shop ones included" || no "list" "still filtered"
grep -q "AS is_ours" server/src/modules/centres.ts \
  && ok "...labelled so the seller knows which" || no "labels" "indistinguishable"
grep -q "No customer with that id" server/src/modules/inventory.ts \
  && ok "and the sale is no longer refused" || no "server" "still blocks the sale"
chk "a sale to an archived customer exists" "$(Q "
  SELECT count(*) FROM stock_issues si JOIN customers c ON c.id=si.customer_id
   WHERE si.warehouse_id <> COALESCE(c.warehouse_id, si.warehouse_id)")"

echo "── 65 · what is on a shelf"
# The map showed a shelf as a count and a weight. Standing at a rack the
# questions are the other ones — what is it, whose was it, how long has it got,
# what did it cost, what are we asking. The audit scan already returned most of
# it and had nowhere to be read outside an audit.
grep -q "ShelfModal" web/src/pages/WarehouseMap.tsx \
  && ok "clicking a shelf opens what is on it" || no "shelf detail" "still prints a label"
grep -q "days_on_the_shelf" server/src/modules/warehousemap.ts \
  && ok "...how long it has been there" || no "age" "missing"
grep -q "AS min_sell_price" server/src/modules/warehousemap.ts \
  && grep -q "AS true_cost" server/src/modules/warehousemap.ts \
  && ok "...what it cost and the least it can go for" || no "money" "missing"
grep -q "LEFT JOIN grn_lines gl ON gl.id = b.grn_line_id" server/src/modules/warehousemap.ts \
  && ok "...and who it came from" || no "provenance" "wrong join"
# The average hid a box priced at zero among sixteen priced properly.
grep -q "MIN(pk.price)" server/src/modules/warehousemap.ts \
  && ok "judged on the cheapest box, not the average" || no "pricing check" "averages"
grep -q "cheapest is under the floor" web/src/pages/WarehouseMap.tsx \
  && ok "...and says so on the row" || no "row flag" "missing"
grep -q "has a box with no price on its label" web/src/pages/WarehouseMap.tsx \
  && ok "no price and under the floor are told apart" || no "warnings" "lumped together"
grep -q "shelf-stats" web/src/pages/WarehouseMap.tsx \
  && ok "the summary reads as label and number" || no "layout" "ran together"

echo "── 63 · boxes, grouped"
# 300 boxes of mango were 300 rows and 300 checkboxes on the till, and the send
# screen read a loose-stock endpoint that knew nothing about packing — so a
# warehouse whose stock was all boxed offered "free" kilos and showed none of
# the boxes just made.
grep -q "inventoryRouter.get('/pack-groups'" server/src/modules/inventory.ts \
  && ok "boxes are grouped by what you can ask for" || no "pack-groups" "missing"
grep -q "array_agg(k.id ORDER BY k.created_at" server/src/modules/inventory.ts \
  && ok "...oldest boxes go out first" || no "ordering" "arbitrary"
grep -q "pack-groups" web/src/pages/Sales.tsx \
  && ok "the till reads groups" || no "till" "still one row per box"
grep -q "pack-groups" web/src/pages/Centres.tsx \
  && ok "so does the send screen" || no "send" "still loose stock"
grep -q "Send how many" web/src/pages/Centres.tsx \
  && ok "sending is counted in boxes" || no "send" "still asks for kilos"
grep -q "graded and packed" web/src/pages/Centres.tsx \
  && ok "...and says why nothing loose is listed" || no "empty state" "unexplained"

# Margin, at both levels.
chk "a company default margin"  "$(Q "SELECT count(*) FROM companies WHERE default_margin_pct IS NOT NULL")"
grep -q "defaultMarginPct" web/src/pages/Finance.tsx \
  && ok "...settable in Settings" || no "company margin" "no UI"
grep -q "minMarginPct" web/src/pages/Catalogue.tsx \
  && ok "and per product where it differs" || no "product margin" "no UI"

echo "── 61 · the quality checklist is editable"
# It arrived with the seed and had no editor: a checklist could only be changed
# in SQL, and a product added today inherited its category default or nothing.
grep -q "mastersRouter.post('/qc-templates'" server/src/modules/masters.ts \
  && ok "a checklist can be created" || no "create" "read-only"
grep -q "mastersRouter.put('/qc-templates/:id'" server/src/modules/masters.ts \
  && ok "...and edited" || no "edit" "missing"
grep -q "requires('quality.template.manage')" server/src/modules/masters.ts \
  && ok "...by admin and the QC team" || no "permission" "not gated"
chk "QC holds the permission" "$(Q "SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE rp.permission_code='quality.template.manage' AND r.code='QC_EXEC'")"
grep -q "QcTemplatesPanel" web/src/pages/Catalogue.tsx \
  && ok "there is a screen for it" || no "screen" "API only"

# Editing a used checklist versions rather than mutates: qc_results.parameter_id
# points at the questions that were scored.
chk "template_version is its own column" "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='qc_templates' AND column_name='template_version'")"
chk "one live checklist per code"        "$(Q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_qc_template_live'")"
chk "retired versions kept whole"        "$(Q "SELECT count(*) FROM qc_templates WHERE retired_at IS NOT NULL")"
chk "...with their parameters intact"    "$(Q "SELECT count(*) FROM qc_parameters p JOIN qc_templates t ON t.id=p.template_id WHERE NOT t.is_active")"
chk "old inspections still readable"     "$(Q "SELECT count(*) FROM qc_results r JOIN qc_parameters p ON p.id=r.parameter_id")"
grep -q "Retire FIRST" server/src/modules/masters.ts \
  && ok "the live index is respected on supersede" || no "supersede" "order trips the index"

# A choice is scored; the score drives the result.
grep -q "normaliseOptions" server/src/modules/masters.ts \
  && ok "choice scores survive an edit" || no "options" "scores are dropped"
grep -q "optionsToText" web/src/pages/Catalogue.tsx \
  && ok "...and are editable as text" || no "editor" "cannot see scores"

# Assigning a checklist to a product.
grep -q "products/:id/qc-template" server/src/modules/masters.ts \
  && ok "a product can be pointed at one" || no "assign" "no way to set it"
grep -q "What each product is checked against" web/src/pages/Catalogue.tsx \
  && ok "...from the same screen" || no "assign UI" "missing"
chk "every product has a checklist" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM products WHERE is_active AND qc_template_id IS NULL)")"

echo "── 59 · the fourth round"
# The supplier is agreeing to goods, not to a document number.
grep -q "What we want" web/src/pages/SupplierPortal.tsx \
  && ok "supplier sees the products, not just a PO no" || no "supplier order list" "number only"
grep -q "'productName', pr.name" server/src/modules/supplier.ts \
  && ok "...and the API sends them" || no "supplier orders" "no lines"

# Nobody rings a supplier to confirm an order any more.
grep -rqi "confirm with supplier" web/src/pages/*.tsx --include=*.tsx \
  && grep -rli "confirm with supplier" web/src/pages/*.tsx | grep -qv "Purchase.tsx\|Home.tsx" \
  && no "confirm with supplier" "still on a screen" || ok "no confirm-with-supplier on any screen"
grep -q "To send to suppliers" web/src/pages/Home.tsx \
  && ok "the dashboard card says send" || no "dashboard card" "still says confirm"

# Dispatch belongs with the orders.
# Next entry after Approvals, ignoring the comment that explains why.
grep -A 8 "to: '/approvals'" web/src/components/ui.tsx | grep "to: '/" | sed -n 2p \
  | grep -q "/dispatch" \
  && ok "dispatch sits beside the orders" || no "sidebar" "dispatch is elsewhere"

# Finance should know what it is paying for.
grep -q "AS goods," server/src/modules/finance.ts \
  && ok "payment requests carry their goods" || no "goods" "a name and a number only"
grep -q "head: 'What for'" web/src/pages/FinanceDesk.tsx \
  && ok "...and the desk lists them" || no "finance desk" "not shown"

# Storing a box: a map, not a list of codes.
grep -q "store-map" web/src/pages/PackBench.tsx \
  && ok "shelves are picked off a map" || no "shelf map" "codes only"
grep -q 'placeholder="R-A1-2"' web/src/pages/PackBench.tsx \
  && ok "...and can still be typed or scanned" || no "scan" "map only"

# The weighbridge is optional; boxes can be entered as a run.
grep -q "'ARRIVED', 'QC_PENDING', 'WEIGHED', 'QC_COMPLETE'" server/src/modules/receiving.ts \
  && ok "quality check does not need the weighbridge" || no "weighbridge" "still mandatory"
grep -q "count: z.coerce.number().int().min(1).max(200" server/src/modules/receiving.ts \
  && ok "10 boxes of 20 kg in one entry" || no "bulk boxes" "one at a time"
grep -q "generate_series(1, \$13::int)" server/src/modules/receiving.ts \
  && ok "...still one row per box, each voidable" || no "bulk boxes" "stored as one row"
grep -q "nav(\`/unload/" web/src/pages/Receiving.tsx \
  && ok "the gate offers the box scale instead" || no "gate" "no way to the boxes"
grep -q "Booked in — the crates are still on the floor" web/src/pages/Grn.tsx \
  && ok "a posted receipt points at the bench" || no "receipt" "dead ends"

echo "── 57 · expected kg"
# A buyer in a mandi is buying 200 crates, not 1,840 kilos. The field stays for
# the owner, who does sometimes commit to a tonnage; blank it and the weighment
# compares against the quantity ordered, which is what it did anyway.
grep -q "showExpectedKg = can('admin.override')" web/src/pages/Purchase.tsx \
  && ok "expected kg is the owner's field only" || no "expected kg" "still on every order"
grep -q "colSpan={showExpectedKg ? 6 : 5}" web/src/pages/Purchase.tsx \
  && ok "...and the table still lines up without it" || no "colSpan" "hard-coded"
grep -q "COALESCE(expected_weight_kg, qty_in_base)" server/src/modules/receiving.ts \
  && ok "a blank one falls back to the quantity" || no "fallback" "variance breaks when blank"

echo "── 55 · packed boxes travel with the stock"
# A pack is a physical box with a label on it. Moving the quantity and leaving
# the box behind left the warehouse holding labels for produce that had gone —
# the packing bench showed "-6.0 KG still loose", a quantity that cannot exist.
chk "boxes can be in transit" "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='packs_status_check' AND pg_get_constraintdef(oid) LIKE '%IN_TRANSIT%'")"
chk "a travelling box names its lorry" "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='ck_pack_in_transit'")"
grep -q "moveBoxesOnto" server/src/modules/centres.ts \
  && ok "dispatch puts the boxes on the lorry" || no "dispatch" "boxes left behind"
grep -q "breaking one open" server/src/modules/centres.ts \
  && ok "...and refuses to split one" || no "whole boxes" "a box can be split"
grep -q "transfer_issue_id = \$1 AND status = 'IN_TRANSIT'" server/src/modules/centres.ts \
  && ok "the shop books them in" || no "receive" "boxes never arrive"
grep -q "Did not arrive at" server/src/modules/centres.ts \
  && ok "...and writes off the ones that did not" || no "shortfall" "missing boxes still arrive"
# The whole point: no place holds more labels than produce.
chk "no labels without produce" "$(Q "
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM stock_balances sb
     LEFT JOIN packs pk ON pk.batch_id=sb.batch_id AND pk.warehouse_id=sb.warehouse_id
                       AND pk.status='IN_STOCK'
     GROUP BY sb.batch_id, sb.warehouse_id, sb.qty, sb.reserved_qty
    HAVING (sb.qty - sb.reserved_qty) - COALESCE(SUM(pk.qty),0) < -0.001)")"
chk "boxes now sitting in a shop" "$(Q "
  SELECT count(*) FROM packs pk JOIN warehouses w ON w.id=pk.warehouse_id
   WHERE w.is_centre AND pk.status='IN_STOCK'")"

echo "── 53 · the packing phase"
# What comes off the vehicle is not what gets stored: 2 crates of 50 kg become
# 20 boxes of 5 kg, each with its own grade, price and QR.
grep -q "pack-bench/:batchId/run" server/src/modules/inventory.ts \
  && ok "a run of boxes can be made in one action" || no "pack run" "one box at a time only"
grep -q "requires('inventory.pack.grade')" server/src/modules/inventory.ts \
  && ok "...by the people who grade" || no "permission" "warehouse-only"
grep -q "MakeBoxesModal" web/src/pages/PackBench.tsx \
  && ok "the bench offers it" || no "bench" "no way in"
grep -q "inventoryRouter.post('/pack-runs'" server/src/modules/inventory.ts \
  && no "old bulk endpoint" "still there, and it stamps the lot grade" \
  || ok "the old bulk path is gone"
grep -q "setPacking" web/src/pages/Packing.tsx \
  && no "old bulk modal" "still reachable" || ok "...and so is its modal"
chk "boxes made this way"        "$(Q "SELECT count(*) FROM packs WHERE status='IN_STOCK' AND graded_by IS NOT NULL")"
chk "every box has its own code"  "$(Q "SELECT count(*) FROM (SELECT code FROM packs GROUP BY code HAVING count(*)=1) x")"
# A box cannot exist for produce that has gone.
grep -q "overPacked" server/src/modules/inventory.ts \
  && ok "labels outliving their stock are surfaced" || no "overPacked" "shows a negative"
grep -q "overPacked" web/src/pages/PackBench.tsx \
  && ok "...and the bench says so plainly" || no "bench warning" "missing"

echo "── 51 · the third round"
# The reorder point is an instruction, not a forecast. It was returned to the
# screen and never handed to the planner, so a product below its own floor with
# no sales history suggested buying nothing.
grep -q "reorderPoint?: number" server/src/domain/index.ts \
  && ok "the planner knows about reorder points" || no "reorderPoint" "not on the input type"
grep -q "reorderPoint: r.reorder_point," server/src/modules/planning.ts \
  && ok "...and the buy list passes it" || no "buy list" "still not passing it"
chk "products below their floor get bought" "$(Q "
  SELECT count(*) FROM products p
   LEFT JOIN (SELECT product_id, SUM(qty) q FROM stock_balances GROUP BY 1) b ON b.product_id=p.id
   WHERE p.is_active AND p.reorder_point IS NOT NULL AND COALESCE(b.q,0) <= p.reorder_point")"

# What to buy: the search matched fields the endpoint does not return.
grep -q "i.name, i.nameHi, i.sku" web/src/pages/Planning.tsx \
  && ok "the buy list search matches real fields" || no "search" "matching nothing"
grep -q "category_name" server/src/modules/planning.ts \
  && ok "...and the category facet has values" || no "category" "not returned"
grep -q "already on order" web/src/pages/Planning.tsx \
  && ok "a zero suggestion explains itself" || no "zero" "silent"
grep -q "onBlur={(e) => {" web/src/pages/Planning.tsx \
  && ok "the reason dialog waits until you finish typing" || no "reason dialog" "fires per keystroke"
grep -q "+ New product" web/src/pages/Planning.tsx \
  && ok "a product can be added from the buy list" || no "add product" "no way in"

# One flow: no phone call, and it can be picked up again.
grep -q "Send to suppliers" web/src/pages/QuickOrder.tsx \
  && ok "one flow sends rather than telephones" || no "one flow" "still a phone call"
grep -q "Left part-way through" web/src/pages/QuickOrder.tsx \
  && ok "orders left mid-flow can be picked up" || no "resume" "lost on leaving"

# The supplier keeps their own list, and their cards go somewhere.
grep -q "Router.get('/catalogue'" server/src/modules/supplier.ts \
  && ok "a supplier can say what else they sell" || no "catalogue" "missing"
grep -q "onClick={() => setTab('orders')}" web/src/pages/SupplierPortal.tsx \
  && ok "the supplier's cards are clickable" || no "cards" "dead"

# Transport, visible wherever the order is.
grep -q "wants a vehicle" web/src/pages/Purchase.tsx \
  && ok "a vehicle request shows on the order" || no "transport" "only on Dispatch"
chk "Finance can arrange one too" "$(Q "SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.code='FINANCE_EXEC' AND rp.permission_code='logistics.pickup.manage'")"

# Put-away is gone; the bench places the stock.
grep -rq "to: '/putaway'" web/src/components/ui.tsx \
  && no "put-away" "still in the menu" || ok "put-away removed from the menu"
grep -q "INSERT INTO putaway_tasks" server/src/modules/receiving.ts \
  && no "put-away" "still raising tasks" || ok "no new put-away tasks are raised"
grep -q "Grade & pack \${p?.name}" server/src/modules/receiving.ts \
  && ok "a receipt sends the batch to the bench" || no "bench task" "missing"
chk "no put-away left dangling" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM putaway_tasks WHERE status='PENDING')")"

echo "── 49 · dead ends"
# Re-running the migrations must stay possible. It stopped the day a later file
# added a queue key that an earlier one then removed.
(cd server && npx tsx src/scripts/migrate.ts >/dev/null 2>&1) \
  && ok "migrations re-run from scratch" || no "migrations" "a re-run fails"
# An endpoint nothing calls is a feature nobody has. This is the fault that hid
# the send-to-centre screen, the supplier rate list, the invoice check, payment
# reversal and the password change — every one of them working code with no
# way in. Checked here so the next one is caught the day it appears.
grep -q "auth/change-password" web/src/pages/Finance.tsx \
  && ok "anyone can change their own password" || no "password" "no way to change it"
grep -q "finance/payments/" web/src/pages/FinanceDesk.tsx \
  && ok "a payment made in error can be reversed" || no "reverse" "no way in"
chk "reversals recorded"    "$(Q "SELECT count(*) FROM payments WHERE status='REVERSED'")"
chk "...and the money owed again" "$(Q "SELECT count(*) FROM payment_requests pr JOIN payments p ON p.request_id=pr.id WHERE p.status='REVERSED' AND pr.status<>'PAID'")"

echo "── 46 · who paid for the lorry in"
# Both directions, because there are two of them and each was a separate gap:
# the supplier charging to bring it, and us paying somebody to fetch it.
chk "the supplier can name their fare" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='payment_requests' AND column_name='transport_amount'")"
chk "a collection can carry a fare" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='pickups' AND column_name='transport_cost'")"
# Both columns must accept NULL: "nobody has priced this yet" is not "free",
# and the money_amt domain would have flattened the two together.
NN=$(Q "SELECT count(*) FROM information_schema.columns WHERE is_nullable='NO' AND (
        (table_name='pickups' AND column_name='transport_cost')
     OR (table_name='payment_requests' AND column_name='transport_amount'))")
[ "$NN" = "0" ] && ok "an unpriced trip is not a free one" || no "freight columns" "$NN NOT NULL"
grep -q "transportCost" server/src/modules/supplier.ts \
  && ok "asked on the form where they name the lorry" || no "supplier freight" "no field"
grep -q "needVehicle" server/src/modules/supplier.ts \
  && grep -q "we are paying for the transport" server/src/modules/supplier.ts \
  && ok "only one side pays for the same journey" || no "double charge" "not guarded"
grep -q "pickups/:id/cost" server/src/modules/receiving.ts \
  && ok "the fare can be recorded after the trip" || no "fare" "no endpoint"
grep -q "raiseFreightClaim" server/src/modules/receiving.ts \
  && ok "a fare somebody must be paid reaches Finance" || no "fare claim" "goes nowhere"
chk "freight spread over the kilos it brought" \
  "$(Q "SELECT count(*) FROM pg_views WHERE viewname='v_inbound_freight_per_kg'")"
# The whole point: it has to come out the far end in the price.
chk "…and lands in what the produce cost" \
  "$(Q "SELECT count(*) FROM v_batch_pricing WHERE freight_in > 0")"
chk "…before the margin, not after" \
  "$(Q "SELECT count(*) FROM v_batch_pricing WHERE min_sell_price > true_cost AND freight_in > 0")"
grep -q "is transport" web/src/pages/FinanceDesk.tsx \
  && ok "Finance sees which part was the lorry" || no "finance view" "fare is buried"
grep -q "supplier_freight" server/src/modules/receiving.ts \
  && grep -q "already charging" web/src/pages/Dispatch.tsx \
  && ok "warned before booking a lorry they are already billing for" \
  || no "double freight" "not surfaced"
# A claim Finance turned down is not a cost the produce should carry.
chk "a rejected claim buys no freight" \
  "$(Q "SELECT count(*) FROM pg_views WHERE viewname='v_inbound_freight_per_kg' AND definition LIKE '%REJECTED%'")"

echo "── 51 · the margin, and the price it puts on a box"
# Where the admin sets it: a company default, and an override per product.
chk "a company-wide profit target"  "$(Q "SELECT count(*) FROM companies WHERE default_margin_pct > 0")"
chk "…overridable per product"      "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='products' AND column_name='min_margin_pct'")"
grep -q "margin_is_own" web/src/pages/Catalogue.tsx \
  && ok "the screen says which of the two is in force" || no "margin source" "not shown"
grep -q "minMarginPct: ownMargin ? Number(margin) : null" web/src/pages/Catalogue.tsx \
  && ok "off puts it back on the default, not on the same number" \
  || no "margin reset" "cannot go back to the default"
# One definition of the cost. Two views compute it, and they must agree.
chk "the per-product view carries freight in" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='v_product_pricing' AND column_name='freight_in'")"
DIFF=$(Q "SELECT count(*) FROM v_product_pricing pp WHERE abs(pp.total_cost
        - (pp.cost_to_warehouse + pp.overhead_cost + pp.freight_in + pp.cost_to_centre)) > 0.02")
[ "$DIFF" = "0" ] && ok "the columns on screen add up to the total" \
  || no "cost breakdown" "$DIFF products do not add up"
# The floor must never be under the cost it was derived from.
BAD=$(Q "SELECT count(*) FROM v_product_pricing WHERE min_sell_price < total_cost AND total_cost > 0")
[ "$BAD" = "0" ] && ok "the floor always clears the cost" || no "floor" "$BAD below cost"
# And the box price on the bench comes from that, rather than from memory.
grep -q "function suggestPrice" web/src/pages/PackBench.tsx \
  && ok "the label price is worked out, not typed from memory" \
  || no "pack price" "still blank"
grep -q "Math.ceil" web/src/pages/PackBench.tsx \
  && ok "…rounded up, so it never lands under the floor" || no "rounding" "may fall short"
grep -c "pricedByHand" web/src/pages/PackBench.tsx | grep -qv '^0$' \
  && ok "…and the person at the bench can overrule it" || no "override" "not editable"
grep -q "if (pricedByHand) setPriceByGrade" web/src/pages/PackBench.tsx \
  && ok "a worked-out price is not remembered as a decision" \
  || no "price memory" "freezes the suggestion"
chk "boxes carry a price" "$(Q "SELECT count(*) FROM packs WHERE status='IN_STOCK' AND price > 0")"

echo "── 52 · order in any unit, name the goods, sort by time"
# The unit belongs to the order, not to the product: a thing held in boxes is
# often bought by the kilo, and the rate follows whichever is chosen.
grep -q "function uomChoices" web/src/pages/Purchase.tsx \
  && ok "an order line can change its unit" || no "line uom" "fixed to the product"
chk "…and the unit is stored per line" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='po_lines' AND column_name='uom'")"
chk "…proven: a BOX product ordered in KG" \
  "$(Q "SELECT count(*) FROM po_lines l JOIN products p ON p.id=l.product_id
         WHERE p.purchase_uom <> l.uom")"
# Finance approves a name and a number unless the goods are on the row.
grep -q "si2.po_id" server/src/modules/finance.ts \
  && ok "a supplier's own invoice still names the goods" \
  || no "finance goods" "blank when the invoice has no lines"
BLANK=$(Q "SELECT count(*) FROM payment_requests pr
            JOIN supplier_invoices si ON si.id = pr.source_id
           WHERE pr.source_type='supplier_invoice' AND pr.status <> 'CANCELLED'
             AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=si.id)
             AND NOT EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id=si.po_id)")
[ "$BLANK" = "0" ] && ok "…no claim left without something to check it against" \
  || no "finance goods" "$BLANK claims name nothing"
# First come / latest come, on every table that has rows with a time.
grep -q "const TIME_FIELDS" web/src/components/ui.tsx \
  && ok "every table sorts by when the row arrived" || no "time sort" "per-page only"
grep -q "defaultSort ?? '_added'" web/src/components/ui.tsx \
  && ok "…newest first, without every page saying so" || no "time sort" "not the default"
grep -q "defaultSort ? (cols.find" web/src/components/ui.tsx \
  && ok "…unless the page has a better order of its own" \
  || no "time sort" "overrides a shelf-life queue"
grep -q "noAddedColumn" web/src/components/ui.tsx \
  && ok "…with a way out where a row has no age" || no "time sort" "forced everywhere"
grep -q "String(c.sort(probe) ?? '') === timeOf(probe)" web/src/components/ui.tsx \
  && ok "…and never twice on a table that already shows it" \
  || no "time sort" "can duplicate an existing column"

echo "── 53 · what was refused, in what, and where it went"
# The unit. A rejection printed as a bare number is the start of an argument.
chk "an inspection records what it was counted in" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='qc_inspections' AND column_name='uom'")"
BARE=$(Q "SELECT count(*) FROM qc_inspections WHERE uom IS NULL")
[ "$BARE" = "0" ] && ok "…on every inspection ever taken, backfilled" \
  || no "qc uom" "$BARE inspections still have no unit"
chk "…and it is the order's unit, not a guess" \
  "$(Q "SELECT count(*) FROM qc_inspections q JOIN po_lines l ON l.id=q.po_line_id WHERE q.uom = l.uom")"
chk "…proven on a non-KG line" \
  "$(Q "SELECT count(*) FROM qc_inspections WHERE uom <> 'KG'")"
grep -q "i.uom" web/src/pages/Receiving.tsx \
  && ok "…and no screen prints the number bare" || no "qc list" "still a bare number"

# The send-back: one answer, and it cannot exceed what was refused.
chk "one place both sides read"  "$(Q "SELECT count(*) FROM pg_views WHERE viewname='v_qc_rejections'")"
chk "a rejection can be answered" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='qc_inspections' AND column_name='return_outcome'")"
chk "…never for more than was refused" \
  "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='ck_qc_return_qty'")"
chk "…and never anonymously"      "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='ck_qc_return_recorded'")"
# Unanswered is not the same as "nothing went back" — only NULL can say the first.
NN=$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='qc_inspections'
        AND column_name='returned_qty' AND is_nullable='NO'")
[ "$NN" = "0" ] && ok "…and \"nobody has said yet\" is not \"nothing went back\"" \
  || no "returned_qty" "NOT NULL"
grep -q "rejections/:id/return" server/src/modules/receiving.ts \
  && ok "the warehouse is the one who answers" || no "send-back" "no endpoint"
grep -q "has already been answered" server/src/modules/receiving.ts \
  && ok "…once, so it cannot be rewritten under the supplier" \
  || no "send-back" "can be changed after the supplier saw it"

# And the supplier is actually told.
grep -q "supplierRouter.get('/rejections'" server/src/modules/supplier.ts \
  && ok "the supplier sees what was refused" || no "supplier view" "still a phone call"
grep -q "v_qc_rejections" server/src/modules/supplier.ts \
  && ok "…the same rows the warehouse wrote, not a second count" \
  || no "supplier view" "computes its own number"
grep -q "AND supplier_id = \$2" server/src/modules/supplier.ts \
  && ok "…and only their own" || no "supplier view" "not scoped"
grep -q "REFUSED_LABEL" web/src/pages/SupplierPortal.tsx \
  && ok "…said in their words, not the database's" || no "supplier view" "shows SENT_BACK"
chk "proven: something has actually gone back" \
  "$(Q "SELECT count(*) FROM qc_inspections WHERE return_outcome='SENT_BACK' AND returned_qty > 0")"

echo "── 54 · the freight is already known, so do not ask for it again"
grep -q "known-charges" server/src/modules/costing.ts \
  && ok "landed cost can see the freight on record" || no "known charges" "no endpoint"
grep -q "known-charges" web/src/pages/Grn.tsx \
  && ok "…and the screen fills it in" || no "landed cost" "still typed from memory"
grep -q "Transport is already filled in" web/src/pages/Grn.tsx \
  && ok "…saying where the number came from" || no "landed cost" "number appears unexplained"
grep -q "setPrefilled" web/src/pages/Grn.tsx \
  && ok "…once, so it never overwrites what was typed" || no "prefill" "can clobber an edit"
# Both ways the journey gets paid for must be found.
grep -q "we sent a vehicle for it" server/src/modules/costing.ts \
  && grep -q "the supplier charged it on their invoice" server/src/modules/costing.ts \
  && ok "…from either payer" || no "known charges" "only one source"
grep -q "NOT IN ('CANCELLED', 'REJECTED')" server/src/modules/costing.ts \
  && ok "…and a claim Finance refused buys no freight" || no "known charges" "counts rejected claims"
# Proven: a receipt whose order carried freight has it in the landed rate.
chk "proven: freight reached the landed rate" \
  "$(Q "SELECT count(*) FROM batches b JOIN grn_lines gl ON gl.id=b.grn_line_id
         WHERE b.landed_rate > gl.rate + 0.01")"

echo "── 55 · the margin, set at the bench"
grep -q "Margin on these (%)" web/src/pages/PackBench.tsx \
  && ok "the bench can price at its own margin" || no "bench margin" "catalogue only"
grep -q "function perUnitAt" web/src/pages/PackBench.tsx \
  && ok "…by the same sum the database uses" || no "bench margin" "second formula"
grep -q "back to it" web/src/pages/PackBench.tsx \
  && ok "…with a way back to the catalogue's" || no "bench margin" "no way back"
grep -q "floorPerUnit = Number(bench.min_sell_price)" web/src/pages/PackBench.tsx \
  && ok "…and the floor still measures against policy" || no "floor" "moves with the typed margin"

echo "── 56 · what it cost to buy, and what it fetched"
grep -q "v_product_pricing" server/src/modules/insights.ts \
  && ok "product performance knows the real cost" || no "unit cost" "stops at the supplier's price"
grep -q "unitCost" web/src/pages/Performance.tsx \
  && ok "…broken into what it is made of" || no "unit cost" "one opaque number"
grep -q "soldAt" server/src/modules/insights.ts \
  && ok "…beside what a unit actually fetched" || no "sold at" "totals only"
grep -q "under cost" web/src/pages/Performance.tsx \
  && ok "…and says so when it sold under cost" || no "under cost" "silent"

echo "── 57 · every record list sorts by time"
# The shared column only appears where a row HAS a time, so the queries behind
# the record lists have to carry one. Aggregates deliberately do not.
MISS=""
for q in "e.created_at" "g.created_at" "i.created_at" "o.created_at" "b.created_at"; do :; done
grep -q "e.created_at" server/src/modules/planning.ts || MISS="$MISS expected-arrivals"
grep -q "g.created_at" server/src/modules/receiving.ts || MISS="$MISS yard/grns"
grep -q "i.created_at" server/src/modules/costing.ts   || MISS="$MISS invoices"
grep -q "created_at, reg_no" server/src/modules/masters.ts || MISS="$MISS vehicles"
grep -q "became_due_at AS created_at" server/src/modules/finance.ts || MISS="$MISS dues"
grep -q "MIN(k.created_at)" server/src/modules/inventory.ts || MISS="$MISS pack-groups"
[ -z "$MISS" ] && ok "every record list carries the row's own age" \
  || no "time sort" "no timestamp on:$MISS"
grep -q "inspected_at" web/src/components/ui.tsx \
  && ok "…inspections included" || no "time sort" "QC has no time field"

echo "── 58 · a box is priced by what is in it"
chk "the view says the cost per unit HELD" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='v_batch_pricing' AND column_name='true_cost_per_held_unit'")"
# The bug: a per-PURCHASE-unit cost multiplied by a number of kilograms. For a
# batch bought by the box, the two differ by the weight of the box.
# The build-up is per HELD unit: what one of them cost, plus the per-kilo
# figures scaled by the kilos in one. landed_rate_per_kg is NOT the right base —
# it is per weighed kilo, and stock is not always counted in those. See db/52.
BAD=$(Q "SELECT count(*) FROM v_batch_pricing pr
          JOIN v_batch_unit_cost uc ON uc.batch_id = pr.batch_id
         WHERE abs(pr.true_cost_per_held_unit
                   - (uc.landed_per_held_unit
                      + (COALESCE(pr.overhead_per_kg,0) + COALESCE(pr.inbound_per_kg,0)
                         + COALESCE(pr.outbound_per_kg,0)) * pr.kg_per_held_unit)) > 0.01")
[ "$BAD" = "0" ] && ok "…and it is the per-held-unit build-up, exactly" \
  || no "held cost" "$BAD batches do not add up"
# Proven on the batches where it actually differs.
chk "proven on batches bought by the box" \
  "$(Q "SELECT count(*) FROM v_batch_pricing WHERE landed_rate/NULLIF(landed_rate_per_kg,0) > 1.5")"
OVER=$(Q "SELECT count(*) FROM v_batch_pricing
           WHERE landed_rate/NULLIF(landed_rate_per_kg,0) > 1.5
             AND true_cost_per_held_unit >= true_cost")
[ "$OVER" = "0" ] && ok "…where the held cost is now below the per-box one" \
  || no "held cost" "$OVER still priced per box"
# Every screen that multiplies by a base-unit quantity must read the held cost.
for f in inventory warehousemap; do
  grep -q "per_held_unit" server/src/modules/$f.ts \
    || no "held cost" "$f.ts still reads the per-purchase-unit cost"
done
grep -q "per_held_unit" server/src/modules/inventory.ts \
  && grep -q "per_held_unit" server/src/modules/warehousemap.ts \
  && ok "the bench, the shelf and the till all use it" || no "held cost" "not everywhere"
grep -q "landed_rate_per_kg, b.landed_rate, 0)" server/src/modules/inventory.ts \
  && ok "…and value at risk is per kilo too" || no "value at risk" "per purchase unit"

echo "── 59 · one cost per unit held, everywhere"
chk "one definition to join"  "$(Q "SELECT count(*) FROM pg_views WHERE viewname='v_batch_unit_cost'")"
# The bug class: a per-PURCHASE-unit rate multiplied by a BASE-unit quantity.
# stock_balances.qty, packs.qty and stock_issue_lines.qty are all base-unit, so
# no query may multiply any of them by batches.landed_rate.
BAD=$(grep -rn "landed_rate" server/src/modules/*.ts \
      | grep -E "(sb|sl|sil|pk)\.qty[^)]*\* *COALESCE\(b\.landed_rate|\* *COALESCE\(b\.landed_rate,0?\)" \
      | grep -v "landed_rate_per_kg" | wc -l)
[ "$BAD" = "0" ] && ok "no base-unit quantity is priced per purchase unit" \
  || no "unit mismatch" "$BAD site(s) still multiply qty by landed_rate"
USES=$(grep -rl "landed_per_held_unit" server/src/modules/*.ts | wc -l)
[ "$USES" -ge 4 ] && ok "…the money screens all join the one definition ($USES files)" \
  || no "unit cost" "only $USES files"
# And it has to scale linearly: twice the kilos, twice the money.
chk "proven on batches bought by the box" \
  "$(Q "SELECT count(*) FROM v_batch_unit_cost WHERE kg_per_purchase_unit > 1.5")"
# One stock unit costs the batch's landed value divided by what went into
# stock. Where stock was booked in weighed kilos that equals landed_rate_per_kg;
# where it was booked in boxes it does not, and must not.
LIN=$(Q "SELECT count(*) FROM v_batch_unit_cost uc
          JOIN batches b ON b.id = uc.batch_id
          JOIN grn_lines gl ON gl.id = b.grn_line_id
         WHERE b.initial_qty > 0
           AND abs(uc.landed_per_held_unit
                   - gl.accepted_qty * COALESCE(b.landed_rate,0) / b.initial_qty) > 0.001")
[ "$LIN" = "0" ] && ok "…and one stock unit costs what it cost" \
  || no "unit cost" "$LIN batches disagree with what was paid"

echo "── 60 · the box is priced for the journey it will make"
chk "each shop has its own delivery rate" \
  "$(Q "SELECT count(*) FROM pg_views WHERE viewname='v_centre_delivery_rate'")"
chk "…settable, not only measured" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='warehouses' AND column_name='delivery_rate_per_kg'")"
# NULL must mean "nobody has said", which falls back to the trips — not zero.
NN=$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='warehouses'
        AND column_name='delivery_rate_per_kg' AND is_nullable='NO'")
[ "$NN" = "0" ] && ok "…and unset falls back to what the trips cost" || no "rate" "NOT NULL"
grep -q "delivery-rates/:warehouseId" server/src/modules/masters.ts \
  && ok "…entered from the admin panel" || no "rate" "no endpoint"
grep -q "DeliveryRatesCard" web/src/pages/Catalogue.tsx \
  && ok "…on the same screen as the margins" || no "rate" "no screen"
# The cost before it goes anywhere, so an average is not baked into every box.
chk "the bench prices from cost BEFORE delivery" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='v_batch_pricing' AND column_name='cost_before_delivery'")"
grep -q "cost_before_delivery" web/src/pages/PackBench.tsx \
  && ok "…and adds only the chosen shop's leg" || no "bench" "still a company average"
grep -q "Where will these be sold?" web/src/pages/PackBench.tsx \
  && ok "…chosen before the price, on both forms" || no "bench" "no destination"
# What a label was priced on has to survive, or a price cannot be explained.
chk "a box remembers where it was priced to go" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='packs' AND column_name='destination_warehouse_id'")"
chk "…and the rate that went into it" \
  "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='packs' AND column_name='outbound_rate_used'")"
chk "proven: boxes priced for a shop" \
  "$(Q "SELECT count(*) FROM packs WHERE destination_warehouse_id IS NOT NULL AND outbound_rate_used > 0")"
# The rate the server records must be the database's, never the browser's.
grep -q "async function deliveryRateFor" server/src/modules/inventory.ts \
  && ok "the rate is read from the database, not believed from the browser" \
  || no "rate" "taken from the request"
# And it still scales linearly with what is in the box.
# Linearity is a property of the SUGGESTION, not of stored prices — an operator
# may always type over one, and historic boxes were priced by hand. So assert it
# where it is guaranteed: the suggestion is one per-unit figure multiplied by
# what is in the box, with no branch on size anywhere in it.
grep -q "perUnitAt(cost, wastage, margin) \* per" web/src/pages/PackBench.tsx \
  && ok "…the suggestion is per-unit × what is in the box" \
  || no "linearity" "the suggestion is not a single multiplication"
grep -q "return (cost / Math.max(1 - wastagePct / 100, 0.05)) \* (1 + marginPct / 100);" \
     web/src/pages/PackBench.tsx \
  && ok "…and the per-unit figure never sees the box size" \
  || no "linearity" "box size leaks into the per-unit cost"

echo "── 61 · the arithmetic, checked against what was paid"
# The decisive test: every batch in stock must be worth what we paid for the
# part of it still there. No unit, no rate, no guess — just the money.
BAD=$(Q "SELECT count(*) FROM batches b
          JOIN grn_lines gl ON gl.id = b.grn_line_id
          JOIN v_batch_unit_cost uc ON uc.batch_id = b.id
          JOIN stock_balances sb ON sb.batch_id = b.id
         WHERE sb.qty > 0 AND b.initial_qty > 0
           AND abs(gl.accepted_qty * b.landed_rate * (sb.qty / b.initial_qty)
                   - sb.qty * uc.landed_per_held_unit) > 1")
[ "$BAD" = "0" ] && ok "every batch is valued at what it cost" \
  || no "valuation" "$BAD batch(es) are not"
grep -q "gl.accepted_qty \* COALESCE(b.landed_rate, 0) / b.initial_qty" db/52_unit_cost_from_what_was_booked.sql \
  && ok "…derived from what was booked, not from what the unit is called" \
  || no "unit cost" "still keyed off base_uom"
# The per-kilo overheads must be scaled by the kilos in one stock unit.
BAD2=$(Q "SELECT count(*) FROM v_batch_pricing pr
           JOIN v_batch_unit_cost uc ON uc.batch_id = pr.batch_id
          WHERE abs(pr.cost_before_delivery
                    - (uc.landed_per_held_unit
                       + COALESCE(pr.overhead_per_kg,0) * pr.kg_per_held_unit
                       + COALESCE(pr.inbound_per_kg,0)  * pr.kg_per_held_unit)) > 0.01")
[ "$BAD2" = "0" ] && ok "…and the label price builds on the same figure" \
  || no "pricing" "$BAD2 batch(es) price off a different base"
# Documents must add up to their own lines.
chk "orders add up"   "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM po_lines WHERE abs(line_total - qty*rate*(1-discount_pct/100.0)) > 0.02)")"
chk "receipts add up" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM grn_lines WHERE abs(line_value - accepted_qty*rate) > 0.02)")"
chk "sales add up"    "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM stock_issue_lines WHERE abs(value - qty*rate) > 0.02)")"
chk "payments add up" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE abs(pr.paid_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.request_id=pr.id AND p.status<>'REVERSED'),0)) > 0.02)")"
chk "nobody is paid more than was asked" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM payment_requests WHERE paid_amount > amount + 0.01)")"
chk "no negative stock" "$(Q "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM stock_balances WHERE qty < 0)")"

echo "── 62 · a receipt costs itself"
grep -q "export async function computeLandingFor" server/src/modules/costing.ts \
  && ok "the sum lives in one place" || no "landed cost" "still inline in the route"
grep -q "computeLandingFor(tx, req.actor, grn.id" server/src/modules/receiving.ts \
  && ok "…and runs the moment the receipt is posted" || no "landed cost" "waits for a button"
grep -q "autoFreightCharges" server/src/modules/receiving.ts \
  && ok "…with the freight this order already has on record" || no "landed cost" "freight typed by hand"
# A receipt is a fact; its costing is an opinion. One must not take the other down.
grep -q "Landed cost still to be worked out" server/src/modules/receiving.ts \
  && ok "…and a failed sum never loses the receipt" || no "landed cost" "posting can fail on costing"
chk "proven: receipts costed with their transport" \
  "$(Q "SELECT count(*) FROM landing_costs lc WHERE lc.cost_status='ACTUAL' AND lc.total_charges > 0")"
# The screen and the API must agree on the shape of a line.
grep -q "row_to_json(x)) FROM landing_cost_lines" server/src/modules/receiving.ts \
  && no "landed cost lines" "snake_case where the screen reads camelCase" \
  || ok "the landed-cost lines reach the screen in the shape it reads"

echo "── 43 · filters with totals"
# This check used to name three pages and pass when those three had filters —
# which is checking the work that was done, not the requirement that was asked.
# The client said EVERY list. So: enumerate every page that renders a list and
# assert each one filters it. A page added tomorrow without filters fails here.
MISS=""
for f in web/src/pages/*.tsx; do
  # Pages whose lists are deliberately unfiltered, with the reason:
  case "$(basename $f)" in
    Unload.tsx|PackBench.tsx) continue ;;          # one-vehicle / one-batch touch screens
    QuickOrder.tsx|Scan.tsx|DriverApp.tsx) continue ;;  # wizards, not lists
  esac
  T=$(grep -c "<DataTable" "$f")
  [ "$T" -eq 0 ] && continue
  grep -q "useFilters" "$f" || MISS="$MISS $(basename $f)"
done
[ -z "$MISS" ] && ok "every page with a list filters it" \
  || no "pages with an unfiltered list" "$MISS"

# The map is a tree, so it prunes rather than narrows — but it must still filter.
grep -q "setOnly\|const \[q, setQ\]" web/src/pages/WarehouseMap.tsx \
  && ok "the warehouse map prunes too" || no "warehouse map" "no filter"

BARS=$(grep -h "<FilterBar" web/src/pages/*.tsx | wc -l)
[ "$BARS" -ge 60 ] && ok "filter bars in place ($BARS)" || no "filter bars" "only $BARS"

STRIPS=$(grep -h "<FilterTotals" web/src/pages/*.tsx | wc -l)
[ "$STRIPS" -ge 60 ] && ok "totals strips in place ($STRIPS)" || no "totals strips" "only $STRIPS"

# Every bar must offer the time window the client called the must-have, and
# every strip must carry at least one number.
grep -q "All time" web/src/components/ui.tsx && grep -q "Last 30 days" web/src/components/ui.tsx \
  && ok "the time window the client called the must-have" || no "time window" "missing"
DATED=$(grep -h "date: (" web/src/pages/*.tsx | wc -l)
[ "$DATED" -ge 30 ] && ok "lists with a real date offer it ($DATED)" || no "dated lists" "only $DATED"
grep -q "FilterTotals" web/src/components/ui.tsx && ok "one shared totals strip" || no "totals" "missing"

# Bulk actions must act on what is filtered, not on everything fetched.
grep -q "fStock.rows" web/src/pages/Packing.tsx && ok "print labels follows the filter" \
  || no "print labels" "prints everything"
grep -q "unmarkedHere" web/src/pages/Hr.tsx && ok "\"everyone in\" follows the filter" \
  || no "everyone in" "marks everybody"
grep -q "f.rows.length ? Object.keys(f.rows\[0\])" web/src/pages/Finance.tsx \
  && ok "CSV exports what is on screen" || no "CSV" "exports everything"

# Reports: filters must reset when the report changes, or a supplier picked on
# one report silently narrows the next.
grep -q "React.useEffect(() => { f.clear(); }, \[key\])" web/src/pages/Finance.tsx \
  && ok "report switch clears the filters" || no "report switch" "filters persist"

echo
echo "════ $PASS passed, $FAIL failed ════"
