# API reference

All endpoints are under `/api`. Every route except `/api/health` and `/api/auth/login` needs
`Authorization: Bearer <token>`. Permissions in the table are enforced server-side; `admin.override`
passes any gate.


## auth + masters

| Method | Path | Permission |
|---|---|---|
| POST | `/auth/login` | — |
| GET | `/auth/me` | — |
| POST | `/auth/change-password` | — |
| GET | `/masters/products` | — |
| GET | `/masters/suppliers` | — |
| POST | `/masters/suppliers` | master.supplier.manage |
| GET | `/masters/warehouses` | — |
| GET | `/masters/vehicles` | — |
| POST | `/masters/vehicles` | master.vehicle.manage |
| PUT | `/masters/vehicles/:id` | master.vehicle.manage |
| POST | `/masters/vehicles/:id/retire` | master.vehicle.manage |
| POST | `/masters/vehicles/:id/restore` | master.vehicle.manage |
| GET | `/masters/drivers` | — |
| POST | `/masters/drivers` | master.vehicle.manage |
| PUT | `/masters/drivers/:id` | master.vehicle.manage |
| POST | `/masters/drivers/:id/retire` | master.vehicle.manage |
| POST | `/masters/drivers/:id/restore` | master.vehicle.manage |
| GET | `/masters/container-types` | — |
| GET | `/masters/charge-types` | — |
| GET | `/masters/bins` | — |
| GET | `/masters/settings` | — |
| PUT | `/masters/settings/:key` | admin.settings.manage |
| GET | `/masters/qc-templates` | — |
| GET | `/masters/audit` | admin.audit.view |


## planning

| Method | Path | Permission |
|---|---|---|
| GET | `/planning/requirement-note` | — |
| GET | `/planning/insight/:productId` | — |
| POST | `/planning/requirements` | purchase.requirement.create |
| GET | `/planning/requirements` | — |
| GET | `/planning/requirements/:id` | — |
| POST | `/planning/requirements/:id/submit` | purchase.requirement.submit |
| POST | `/planning/quotes` | purchase.quote.compare |
| POST | `/planning/purchase-orders` | purchase.po.create |
| GET | `/planning/purchase-orders` | — |
| GET | `/planning/purchase-orders/:id` | — |
| POST | `/planning/purchase-orders/:id/submit` | purchase.po.submit |
| GET | `/planning/approvals` | — |
| POST | `/planning/approvals/:id/decide` | — |
| POST | `/planning/purchase-orders/:id/confirm` | purchase.po.submit |
| POST | `/planning/purchase-orders/:id/revise` | purchase.po.revise |
| GET | `/planning/expected-arrivals` | — |
| GET | `/planning/supplier-rates` | purchase.rate.compare |


## receiving

| Method | Path | Permission |
|---|---|---|
| POST | `/receiving/gate-entries` | receiving.gate.create |
| POST | `/receiving/gate-entries/:id/submit` | receiving.gate.submit |
| GET | `/receiving/pipeline` | — |
| GET | `/receiving/gate-entries/:id` | — |
| POST | `/receiving/gate-entries/:id/weighments` | receiving.weighment.create |
| GET | `/receiving/gate-entries/:id/qc-plan/:productId` | — |
| POST | `/receiving/qc/photo-assist` | quality.inspection.create |
| POST | `/receiving/gate-entries/:id/inspections` | quality.inspection.create |
| POST | `/receiving/gate-entries/:id/grn` | receiving.grn.submit |
| GET | `/receiving/grns` | — |
| GET | `/receiving/grns/:id` | — |
| POST | `/receiving/grns/:id/reverse` | receiving.grn.reverse |
| GET | `/receiving/putaway` | — |
| POST | `/receiving/putaway/:id/confirm` | receiving.putaway.confirm |
| GET | `/receiving/trace/:code` | — |


## costing

| Method | Path | Permission |
|---|---|---|
| POST | `/costing/landing-cost/:grnId/compute` | costing.landing.recompute |
| GET | `/costing/landing-cost/:grnId` | — |
| POST | `/costing/invoices` | finance.invoice.create |
| POST | `/costing/invoices/:id/match` | finance.invoice.match |
| GET | `/costing/invoices` | — |
| GET | `/costing/invoices/:id` | — |
| GET | `/costing/invoices/:id/candidates` | — |
| GET | `/costing/payments` | finance.payment.view |
| POST | `/costing/payments/sync` | finance.payment.view |
| GET | `/costing/rate-check` | — |


## insights

| Method | Path | Permission |
|---|---|---|
| GET | `/insights/work-queue` | — |
| GET | `/insights/dashboard` | — |
| GET | `/insights/alerts` | — |
| POST | `/insights/alerts/:id/ack` | — |
| GET | `/insights/supplier-performance` | reports.supplier.view |
| POST | `/insights/supplier-performance/recompute` | reports.supplier.view |
| GET | `/insights/reports/:key` | reports.purchase.view |
| POST | `/insights/ai/assistant` | — |
| GET | `/insights/ai/forecast/:productId` | — |
| GET | `/insights/ai/price-signal/:productId` | — |
| GET | `/insights/ai/runs` | — |
| GET | `/insights/ai/features` | — |
| PUT | `/insights/ai/features/:key` | ai.feature.manage |
| GET | `/insights/stock` | — |

---

## Key request shapes

### `POST /api/planning/requirements`
```json
{
  "branchId": "uuid", "requiredDate": "2026-08-14", "priority": "NORMAL",
  "source": "LOW_STOCK",
  "lines": [{
    "productId": "uuid", "uom": "KG",
    "finalQty": 500, "suggestedQty": 420, "suggestedBy": "RULE",
    "editReason": "Festival demand expected"
  }]
}
```
`editReason` is **required** whenever `finalQty !== suggestedQty`. The server refuses otherwise.

### `POST /api/planning/quotes` — source comparison
```json
{
  "productId": "uuid",
  "quotes": [{
    "supplierId": "uuid", "sourceType": "AADHTI", "quotedRate": 24.5,
    "uom": "KG", "paymentTermsDays": 7, "qtyKg": 1000,
    "charges": { "commission": 1470, "transport": 900, "loading": 350 }
  }]
}
```
Returns each quote ranked by **landed** rate with the supplier's own rejection and on-time history
folded in, plus a recommendation in plain words.

### `POST /api/masters/vehicles` — and the fleet lists generally
```json
{
  "regNo": "MH12AB1234", "vehicleType": "TRUCK", "transporterName": "Shivneri Transport",
  "capacityKg": 9000, "tareReferenceKg": 4200,
  "fitnessExpiry": "2027-03-31", "insuranceExpiry": "2027-01-15", "pucExpiry": "2026-11-30",
  "status": "ACTIVE"
}
```
`regNo` is normalised (upper-cased, spaces and dashes dropped) and must match the `vehicle_reg_t`
format before it reaches the database. A registration already on the list is a `409`; one that was
retired earlier is **restored on its original row**, so its old gate entries stay attached to it.
Anything other than `status: "ACTIVE"` needs a `statusReason` — a `BLOCKED` truck is turned away at
the gate and the person turning it away has to be able to say why.

`POST /api/masters/drivers` is the same shape with `fullName`, `phone`, `dlNumber`, `dlExpiry`,
`status` and `consentObtained` (DPDP: a licence number is personal data).

`GET` on either list returns the **active roster** — what the gate dropdowns show. Pass
`?includeRetired=1` for the management view, which also returns removed and blocked rows.

`POST .../:id/retire` takes the row off the roster; it never deletes. Gate entries, weighments and
receipts keep pointing at it, and `POST .../:id/restore` puts it back. Retiring is refused while the
vehicle or driver is on a gate entry that has not reached `COMPLETED`, `REJECTED_AT_GATE` or
`CANCELLED` — the truck is physically in the yard.

### `POST /api/receiving/gate-entries/:id/weighments`
```json
{
  "kind": "TARE", "method": "TWO_WEIGHMENT", "tareKg": 4210,
  "containerTypeId": "uuid", "containerCount": 40,
  "captureMode": "MANUAL"
}
```
Net = gross − vehicle tare − (crates × container tare) − packing. A breach on the closing weight
requires `receiving.weighment.approve`, or the request is refused with the numbers explained.

### `POST /api/receiving/gate-entries/:id/grn` — the atomic posting
```json
{
  "idempotencyKey": "grn-<uuid>",
  "postingDate": "2026-08-13",
  "lines": [{
    "poLineId": "uuid", "qcInspectionId": "uuid", "productId": "uuid", "uom": "KG",
    "receivedQty": 1000, "acceptedQty": 940, "rejectedQty": 60, "holdQty": 0,
    "netWeightKg": 940, "rate": 24.5, "grade": "A",
    "rejectionReasonCode": "DAMAGE", "rejectionAction": "RETURN",
    "crateLabels": 47
  }]
}
```
Send the same `idempotencyKey` twice and the second call returns the first response — no double
posting. Omitting `rejectionReasonCode` when `rejectedQty > 0` is refused.

### `POST /api/costing/landing-cost/:grnId/compute`
```json
{
  "costStatus": "ACTUAL",
  "charges": [
    { "chargeTypeId": "uuid", "amount": 900 },
    { "chargeTypeId": "uuid", "amount": 350 }
  ]
}
```
Charges already on the PO are merged automatically. Returns per-line landed rate per unit and per
kg, the change against that product's last landed rate, and `isAbnormal` when the move exceeds the
configured threshold.

---

## Error format

```json
{ "error": "The person who submitted this order cannot also approve it.",
  "code": "rule_violation", "detail": "ck_po_maker_checker" }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Validation failed; `detail` maps field → message |
| 401 | `unauthorized` | No token, expired token, or the account is inactive |
| 403 | `forbidden` | Permission or limit; `detail.needs` lists what was required |
| 404 | `not_found` | — |
| 409 | `conflict` / `already_posted` / `duplicate` | Concurrent or repeated action |
| 422 | `rule_violation` / `immutable` | A business rule from the specification was violated |


## farming

The farming module's rule: the caller sends **ground reality** (crop, area, actual weight, a
problem, an expense). Everything else on the response — dates, calendar, crop age, harvest window,
stock, cost, colour — is derived server-side and never accepted as input.

### Setup — asked once

| Method | Path | Permission |
|---|---|---|
| GET | `/farming/farms` | — |
| POST | `/farming/farms` | farming.farm.manage |
| GET | `/farming/farms/:id` | — |
| POST | `/farming/farms/:id/plots` | farming.farm.manage |
| POST | `/farming/farms/:id/refresh` | — |
| GET | `/farming/crops` | — |
| GET | `/farming/machines` | — |
| POST | `/farming/machines/:id/status` | farming.farm.manage · farming.task.complete |
| GET | `/farming/scan/:qr` | — |

`GET /farming/scan/:qr` is what the QR on a plot gate resolves to: it returns that plot's crop,
today's jobs, last watering / spray / fertiliser and the harvest countdown.

### Crop cycle

| Method | Path | Permission |
|---|---|---|
| POST | `/farming/crop-cycles/preview` | — |
| POST | `/farming/crop-cycles` | farming.crop.start |
| GET | `/farming/crop-cycles` | — |
| GET | `/farming/crop-cycles/:id` | — |
| POST | `/farming/crop-cycles/:id/close` | farming.crop.close |

`preview` returns the harvest date, duration, expected yield, expected cost and the full task
calendar **without saving anything** — so nobody commits a crop without seeing what follows.
`POST /crop-cycles` takes only `{farmId, plotId, cropId, areaAcre, sowingDate}` and writes the
entire calendar (typically 30–60 tasks) in the same transaction.

### Daily work

| Method | Path | Permission |
|---|---|---|
| GET | `/farming/today` | — |
| POST | `/farming/tasks` | farming.task.complete |
| POST | `/farming/tasks/:id/action` | farming.task.complete |
| POST | `/farming/observations` | farming.task.complete |
| POST | `/farming/weather` | — |
| POST | `/farming/day-close` | farming.task.complete |

`GET /farming/today` runs the **daily pass** before responding (see ARCHITECTURE.md): it colours
every live crop, holds irrigation when rain is due, wakes the harvest reminder and refreshes the
shared work queue. It is idempotent, so a farm laptop that was off for three days catches up on
the next open rather than waiting for a scheduler.

`POST /tasks/:id/action` takes `{action: DONE|PROBLEM|SKIP}`. `PROBLEM` requires a `problemCode`
and additionally writes a crop observation and alerts the manager. `DONE` on an irrigation task
schedules the next one automatically.

### Harvest → warehouse → stock

| Method | Path | Permission |
|---|---|---|
| POST | `/farming/harvests` | farming.harvest.record |
| GET | `/farming/harvests` | — |
| POST | `/farming/dispatches` | farming.dispatch.create |
| GET | `/farming/dispatches` | — |
| POST | `/farming/dispatches/:id/receive` | farming.dispatch.receive |
| GET | `/farming/traceability/:batchId` | — |

`POST /dispatches/:id/receive` is the farming module's GRN: one transaction, an
`idempotencyKey`, and `batches → stock_ledger (TRANSFER_IN) → stock_balances`. A weight gap larger
than `farming.dispatch_variance_crit_pct` is **refused** without a written reason, then recorded as
a loss against the crop. `uq_ledger_grn_line` means a retried receive collides at the database
rather than doubling stock.

### Money and insight

| Method | Path | Permission |
|---|---|---|
| POST | `/farming/expenses` | farming.expense.create |
| GET | `/farming/expenses` | farming.cost.view · farming.expense.create |
| POST | `/farming/losses` | farming.loss.record |
| GET | `/farming/dashboard` | — |
| GET | `/farming/harvest-forecast` | — |
| GET | `/farming/supply-plan` | — |
| GET | `/farming/planning` | farming.report.view |
| GET | `/farming/staff-performance` | farming.report.view |

Cost, profit and expense rows are stripped **server-side** for callers without
`farming.cost.view` / `data.cost.view`, never hidden in the UI.

`GET /farming/supply-plan?productId=&demandKg=` is the join into purchasing: it answers "the
warehouse needs 500 kg — how much is the farm about to deliver, and how much must be bought?"


## inventory — the way stock leaves

Until this existed the only `OUT` movement in the API was a GRN reversal, so stock could enter and
never leave. A stock issue is the mirror of a goods receipt and obeys the same rules: one
transaction, an idempotency key, and the append-only ledger as the record.

| Method | Path | Permission |
|---|---|---|
| GET | `/inventory/issuable` | — |
| POST | `/inventory/issues` | inventory.stock.issue |
| GET | `/inventory/issues` | — |
| POST | `/inventory/issues/:id/cancel` | inventory.stock.cancel |

`GET /issuable` lists every batch with stock on hand, **oldest-expiring first** — FEFO is not a
nicety on perishables, and the right batch should be the first one on screen.

`POST /issues` takes `{idempotencyKey, warehouseId, reason, lines[{batchId, qty, rate?}]}`.
`reason` is one of `SALE · TRANSFER_OUT · WASTAGE · RETURN · CONSUMPTION · ADJUSTMENT` and maps
1:1 onto `stock_ledger.txn_type`, so the document and the ledger speak the same vocabulary.

Two guards that are deliberate rather than incidental:

- **Anything that is not a sale needs a written reason.** Stock that disappears without one is
  what this system exists to prevent.
- **`WASTAGE` and `ADJUSTMENT` need `inventory.stock.writeoff`**, a separate permission from an
  ordinary sale — they destroy value with nothing coming back, and they raise a `STOCK_WRITE_OFF`
  alert on posting.

Leaving `rate` blank values the line at the batch's own landed cost, so a write-off is valued
honestly and a farm-grown crate carries what it cost to *grow*. The response returns `totalCost`
beside `totalValue`, and `marginValue` on a sale — which is how selling below cost becomes visible
at the moment it happens rather than in a month-end report.

Cancelling writes a compensating `IN` row rather than deleting anything, the same way a GRN is
reversed instead of edited.


## Approval — within your own authority

`requestApprovals()` now settles maker–checker itself. It returns `level: 0` when the submitter
already holds the level (and the money limit) that every triggered rule asks for, because in that
case there is nobody more senior to route to — the document would land in a queue only that same
person could clear.

- **Owner** — approves everything on submit.
- **A manager inside their own limit** — approves on submit; above it, still goes up.
- **Anyone else** — unchanged.

Which money limit applies depends on the document: `max_po_value` for a PO or requirement,
`max_invoice_mismatch_value` for an invoice. Checking an invoice against the PO limit would have
quietly let finance wave through a mismatch far larger than they are trusted with.

Self-approval is **recorded, not hidden**: `purchase_orders.self_approved` and
`self_approved_reason` are set, and `ck_po_maker_checker` was relaxed from "never" to "only when
the row says so and gives a reason".

## finance — every rupee in and out

Mounted at `/api/finance`. Three ideas, kept apart on purpose:

- a **request** is a *claim* on money — anybody who spends may raise one;
- a **payment** is money *actually moving* — only Finance;
- a **receipt** is money *arriving* — declared by whoever took it, confirmed by
  Finance against what really landed.

A claim can be part-paid, reduced, or turned down; only "paid twice" must be
impossible.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/expense-categories` | any | Seeded with the client's own list; `affects_landed_cost` decides whether the cost reaches the produce |
| POST | `/expense-categories` | `admin.settings.manage` | |
| GET | `/payment-modes` | any | Standard methods plus company-saved custom methods |
| POST | `/payment-modes` | `finance.payment.make` | `{ name }`; saves a custom method for future Finance payments |
| POST | `/requests` | `finance.request.create` | Held by everyone who spends: purchase, gate, QC, warehouse, farm |
| GET | `/requests` | any | **Scoped**: without `finance.expense.view` you see only your own, `?mine=1` or not |
| GET | `/requests/:id` | any | With its payment history |
| POST | `/requests/:id/verify` | `finance.request.verify` | `{ decision: VERIFY \| REJECT, approvedAmount?, reason? }` — may approve *less*, never more; rejection needs a reason |
| POST | `/requests/:id/pay` | `finance.payment.make` | Part payments allowed; standard or custom `mode`; non-cash needs `transactionRef`, and a reference cannot be reused |
| POST | `/payments/:id/reverse` | `finance.payment.reverse` | Needs a reason; restores the request |
| POST | `/receipts` | `finance.receipt.record` | A *declaration*, not a confirmation |
| GET | `/receipts` | any | Scoped like requests |
| POST | `/receipts/:id/confirm` | `finance.receipt.confirm` | A gap between declared and landed forces a note and marks the receipt `DISPUTED` |
| GET | `/overview` | `finance.expense.view` | KPIs, spend by category, cash vs online, daily in/out |

**Maker–checker.** Nobody verifies a request they raised. A document that
queues *itself* — a captured supplier invoice — is marked `is_system_raised`
and skips that check, because there is no second human to find: the person who
captured the invoice is the same Finance clerk who must pay it.

**The three-way match is not a gate.** A supplier invoice reaches this inbox on
capture, from our clerk or from the supplier's own portal. The match still runs
and is still shown on the invoice; it informs the buyer, it does not hold the
money.

## supplier — the other side answers

Mounted at `/api/supplier`. The client's sequence, and the endpoint for each
arrow:

```
we confirm  →  POST /orders/:id/respond          (ACCEPT | DECLINE)
            →  POST /orders/:id/request-payment  (goes to the Finance inbox)
            →  Finance verifies and pays          (POST /finance/requests/:id/pay)
            →  POST /orders/:id/dispatch          (the gate is told to expect it)
```

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/orders/:id/respond` | `supplier.order.accept` | Only a `CONFIRMED` order; only once. A decline **needs a reason**, cancels the expected arrival so the gate stops waiting, raises a HIGH alert and puts a critical task in front of the buyer |
| POST | `/orders/:id/request-payment` | `supplier.payment.request` | Must have accepted first. May ask for **less** than the order is worth, never more, and only once per order — `uq_payreq_source` makes a second claim on the same goods impossible. Asking again returns the standing request and what has been paid on it |
| POST | `/orders/:id/dispatch` | `supplier.order.dispatch` | Refused unless the order is accepted, **and** any payment they asked for is fully paid. A supplier on credit terms never raises a request, so nothing changes for them — the gate only bites on money they asked for and have not received |

`GET /orders` and `GET /orders/:id` carry `supplier_response`, the response
note, and the live payment request (`payment_request_no`, `payment_status`,
`payment_amount`, `payment_paid`), so the portal's label and its button can
never disagree about which step the order is at.

The buyer's `GET /planning/purchase-orders` carries the same fields: our status
says where the paperwork is, theirs says whether anybody is going to load a
lorry.

Accepting also pushes a task to the **buyer** — *"PO/55 accepted by the
supplier — arrange payment"*. Note that `pushTask` upserts on
`(queue_key, doc_type, doc_id)` and now updates `required_permission` and
`sla_due_at` along with the words. It did not, so this task inherited
`purchase.po.approve` from the earlier "needs confirming" row and went to
approvers instead of the buyer it was written for: present in the table,
correct on inspection, invisible to the one person who had to act.

### The supplier's own price list

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/supplier/rates` | `supplier.rate.update` | Products they are set up to sell **or have sold us before**. The second half matters: a supplier who had delivered for a year opened this to nothing at all, with no way to fix it themselves |
| POST | `/supplier/rates` | `supplier.rate.update` | One live standing price per supplier and product (`uq_standing_quote`). A change supersedes rather than overwrites, so last week's asking price is still answerable |
| GET | `/planning/supplier-rates` | `purchase.rate.compare` | The office side, from `v_supplier_rates`: asking price, what we last paid, and the movement between them |

`supplier_products.last_rate` is written when a goods receipt is posted — the
only moment the figure is certain. It was read in three places and written in
none, so "what we last paid them" was permanently blank.

### Transport

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/supplier/orders/:id/request-vehicle` | `supplier.transport.request` | A request, not a booking. Refused if a pickup already exists or they have already asked. Lands in the `TRANSPORT_REQUEST` queue and puts the order at the top of Dispatch |
| POST | `/supplier/orders/:id/respond` | `supplier.order.accept` | Takes `transportCost` — what the supplier is charging to bring it. Refused together with `needVehicle`: one journey has one payer |
| POST | `/receiving/pickups` | `logistics.pickup.manage` | Takes `transportCost` where the fare is already agreed |
| POST | `/receiving/pickups/:id/cost` | `logistics.pickup.manage` | The fare after the trip, which is when it is usually settled. Raises a `TRANSPORT` request against `source_type='pickup'`. Refuses to change a figure Finance is already holding — cancel that request first |

`GET /receiving/pickups/candidates` covers `APPROVED` and `CONFIRMED` orders —
a lorry takes arranging, and waiting for the supplier's answer loses a day.
Arranging a pickup clears the request and resolves the task. Each candidate
carries `supplier_freight`, so nobody books a lorry for a load the supplier is
already billing us to bring.

#### Who paid for the lorry in

The leg out of the warehouse already reached the price: a transfer carries
`transport_cost`, `v_outbound_cost_per_kg` spreads it over the kilos moved, and
`v_batch_pricing` adds it before the margin. The leg *in* had nowhere to be
recorded, so produce looked cheaper than it was and was priced accordingly.

It arrives two ways and the difference is Finance's:

- **the supplier brings it** — part of what we owe them, so it rides on the one
  claim the order already has (`payment_requests.transport_amount`), named
  separately rather than buried in a higher rate per kilo
- **we send a vehicle** — our own cost, agreed on Dispatch (`pickups.transport_cost`)
  and raised as a `TRANSPORT` claim so the driver actually gets paid

`v_inbound_freight_per_kg` sums both over the company's overhead window and
divides by the kilos received in it. A claim Finance rejected buys no freight.
`v_batch_pricing.freight_in` is where it lands:

```
bought for + overheads + freight IN + freight OUT
─────────────────────────────────────────────────  × (1 + margin)
                1 − wastage
```

Both columns are `numeric`, not `money_amt`: that domain is `NOT NULL DEFAULT 0`,
which would make "nobody has priced this yet" indistinguishable from "the trip
was free" — and Dispatch chases only the first.

#### What was refused, in what, and where it went

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/receiving/rejections` | `quality.inspection.view` | `v_qc_rejections` — everything QC turned away. `?state=open` is the warehouse's queue: refused, and nobody has said what became of it |
| POST | `/receiving/rejections/:id/return` | `quality.rejection.return` | `SENT_BACK` · `PART_SENT_BACK` · `DESTROYED` · `KEPT_AT_A_DISCOUNT`. Answerable **once** — it cannot be rewritten under a supplier who has already read it |
| GET | `/supplier/rejections` | `supplier.order.view` | The same rows, scoped to that supplier |
| POST | `/supplier/rejections/seen` | `supplier.order.view` | They have read it — so a dispute can tell whether they were told at the time |

`qc_inspections.uom` is written at save from the **order line**, because that is
the unit the supplier is billing in — a rejection and the invoice it argues with
have to be in the same terms. Forty kilos and forty crates are an argument, and
before this the record could not settle it; the entry form knew the unit and
threw it away on save. Every screen that prints a rejected quantity now prints
the unit with it.

Rejecting and sending back are **two events**, hours apart, done by two people:
QC decides at the bay, the warehouse puts it on a lorry — or dumps it, or keeps
it at an agreed discount. The answer hangs off the inspection rather than
becoming its own document: there is exactly one rejection to answer, the
quantity can never exceed it (`ck_qc_return_qty`), and it must say who and when
(`ck_qc_return_recorded`). `returned_qty` is nullable on purpose — "nobody has
said yet" is the warehouse's queue and is not the same as "nothing went back".

#### Where the margin is set, and where it comes out

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/masters/pricing` | any | `v_product_pricing`: bought at, handling, freight in, to the shop, total cost, margin, wastage, floor, and what it is actually selling at |
| GET | `/masters/pricing/basis` | any | What the three per-kilo figures are made of, so a number nobody can trace is not a number anybody believes |
| PUT | `/masters/products/:id/pricing` | `master.pricing.manage` | `minMarginPct: null` puts the product back on the company default — different from setting it to the same number, because it then moves when policy moves |

The company default lives on `companies.default_margin_pct` (Settings); a
product overrides it with `products.min_margin_pct`. `v_product_pricing`
carries `margin_is_own` so the screen can say which of the two is in force.

`v_product_pricing` and `v_batch_pricing` compute the same sum at two levels —
per product across the batches in stock, and per batch. **They must stay in
step**: the first is what an admin prices against, the second is the floor at
the packing bench, and a difference between them is a number nobody can
defend. Both are DROPped and recreated rather than replaced, because
`CREATE OR REPLACE VIEW` cannot move a column and `freight_in` sits in the
middle of the costs it belongs between.

The packing bench fills the label price in from that floor — `min_sell_price ×
box size`, rounded up to the rupee so a suggestion never lands under the floor
it came from — and leaves it editable. A price the operator sets by hand is
remembered for that grade; a worked-out one is not, or the next box of a
different size would carry the last box's price.

## receiving — invoice-first entry and per-box weighing

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/receiving/lookup/invoice?no=` | `receiving.gate.create` | The gate's whole job at the barrier. Returns the order, supplier, vehicle, driver, transporter, LR, e-way, the invoice total, whether it has been **paid**, and whether that invoice **has already been through the gate**. A number nobody has seen returns `{found:false}` with a sentence, not an error — plenty of loads arrive against no invoice |
| GET | `/receiving/gate-entries/:id/boxes` | any | Ordered vs unloaded per product, plus the last 200 boxes. A product on the lorry that was never ordered still appears — that is the case worth seeing |
| POST | `/receiving/gate-entries/:id/boxes` | `receiving.box.weigh` | One box. Takes `productId` **or** `scannedCode` (the supplier's code or tracking code printed on the box, falling back to our SKU). Box numbers are allocated under the gate entry's row lock, so two tablets weighing at once cannot claim the same number |
| POST | `/receiving/boxes/:id/void` | `receiving.box.void` | Needs a reason. **Nothing edits a weight** — a weight that can be changed after the fact is a weight nobody can be held to. The box stays on the record and stops counting |

`v_unload_totals` is the one place per-product totals are computed, so no two
screens can disagree about how much mango came off the lorry. The gate file
(`GET /gate-entries/:id`) carries `boxTotals`, and the goods receipt prefills
its received quantity and net weight from them.

**Who may do what:** the warehouse weighs and voids; the gate and QC may weigh;
the purchase manager and owner may void. Weighing is routine, voiding is not.

## inventory — the packing bench

Quality and packing are one job. Lot QC still governs what is accepted off the
vehicle; this is the finer pass made by the person holding the box.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/inventory/pack-bench/:batchId` | any | The batch, what is left unpacked, the split by grade so far, the last 40 boxes, and every active shelf |
| POST | `/inventory/pack-bench/:batchId/box` | `inventory.pack.grade` | One box: quantity, its **own** grade, price, optional note, optional `binCode` to store it in the same breath. Opens today's pack run for the batch if there isn't one |
| POST | `/inventory/packs/store` | `inventory.pack.store` | `{ binCode, packIds }` — scan the shelf, tick the boxes. One call, so a box is never half-stored |
| GET | `/inventory/bins` | any | What is on each shelf: packs, quantity, weight, and which product and grade |

**Why the grade is per box.** The lot inspection gives one grade to everything
off one lorry. The packer has each box in their hands and can see that this one
is A and the next is B. Grading the lot and packing separately throws that
judgement away and puts a grade on the label that the label is supposed to be
about. When a box is graded differently from its lot, the screen says so and the
difference is recorded against the packer's name.

`v_bin_contents` is the single source for what is on a shelf, so "where is the
A-grade mango" has one answer rather than one per screen.

Guards: packing more than the batch holds is refused with the number still
unpacked; an unknown shelf code is refused by name; a gate clerk may not store
(403).

## warehouse — the map and the audit team

Mounted at `/api/warehouse`. Four levels — **floor → section → rack → shelf** —
each with its own printed QR. Three of them already existed as zone/rack/bin;
this adds the floor above them and a scannable code on every one, rather than
building a second hierarchy beside the working one.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/layout` | any | The whole map with pack counts per shelf |
| POST | `/floors` · `/sections` · `/racks` · `/shelves` | `master.location.manage` | Racks and shelves take a `count` and are created in runs (`A` → `A1, A2, A3`), because nobody lays out ninety shelves one at a time |
| GET | `/scan/:qr` | any | **One code, one answer.** A shelf returns its contents and its last ten audits; a rack or section returns its children; a *pack* label returns the pack and where it is, because with two stickers on a box that is an easy mistake and an answerable one; anything else returns `{found:false}` with a sentence |
| GET | `/audits` · `/audits/:id` | `audit.report.view` | Tasks with counts, loss quantity and loss value |
| POST | `/audits` | `audit.task.raise` | Pushes the task into the auditor's work queue — the same queue every other role works from |
| POST | `/audits/counts` | `audit.count.record` | One shelf, one product. **The book figure is captured here and stored**; recomputing it later would make last Tuesday's variance change every time a crate moved |
| POST | `/audits/:id/complete` | `audit.count.record` | Needs findings in the auditor's own words |
| GET | `/audits-summary` | `audit.report.view` | Open, overdue, mismatches, and what is being lost, by condition and by product |

**The audit reports; it does not correct.** Nothing in this module moves stock.
The `AUDITOR` role can count, scan and report, and cannot issue, adjust or sell
— an auditor who can rewrite the ledger is not an auditor. A variance or a
write-off raises an alert; deciding what to do about it is somebody else's job.

`v_locations` resolves any scanned code to its level and full path; `loc_code()`
generates the codes from an alphabet with no O/0 or I/1, because these get read
back off dusty labels.

## centres — the shops

`POST /centres/transfers` moves the **packed boxes** as well as the quantity.
Whole boxes only: sending 23 kg of a batch packed into 5 kg boxes is refused
with `{ boxSize: 5, suggest: [20, 25] }`, because anything beyond whole boxes
has to come from produce that is not in a box. Dispatched boxes go `IN_TRANSIT`,
lose their bin, and keep their code, grade and price.

`POST /centres/transfers/:id/receive` books in as many boxes as were counted;
the rest are voided against the shortfall note. A box is never marked arrived
because the paperwork said it was sent.

Mounted at `/api/centres`. **A centre is a warehouse with `is_centre` set.** It
holds stock, stock moves through the same ledger, packs sit on the same shelves
— giving it its own table would have meant a second stock model and two
different answers to "how much mango is in Kothrud".

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | any | Every centre: holding, value, loads in transit, 30-day sales, customers, last close |
| PATCH | `/:id` | `admin.settings.manage` | Turn a warehouse into a centre; city, manager, rent, its own UPI |
| GET | `/:id/today` | any | Stock, incoming loads, today's bills, the last fortnight of closes, customers |
| POST | `/transfers` | `inventory.stock.issue` | Sends stock **and raises the transport cost with Finance** as a claim, rather than a number typed on a transfer that nobody pays |
| POST | `/transfers/:id/receive` | `centre.stock.receive` | Per line. Only what is confirmed becomes the shop's stock; a shortfall needs a note and alerts the buyer |
| GET/POST | `/customers/list`, `/customers` | `master.customer.manage` to add | Added from the dropdown at the till, because that is when you meet them |
| GET | `/:id/day-close-draft` | any | What the bills say, before the person disagrees with it |
| POST | `/:id/day-close` | `centre.day.close` | Freezes the system figure beside the declared one; a gap needs a note, raises an alert, and the cash goes to Finance as a receipt |
| GET | `/performance` | `centre.performance.view` | Ranked, with **net after costs** — revenue flatters a shop with high rent, a long delivery run and heavy wastage |

**Stock in transit belongs to neither place.** Before this a transfer credited
the destination the instant somebody pressed send, so a load that never arrived
looked exactly like one sitting on the shelf. It is now `IN_TRANSIT` until the
shop counts it in.

**Closing twice is a correction, not a second day's takings** — the existing
receipt is amended, and if Finance has already confirmed it, the change is
alerted instead of silently rewriting a fact they checked.

A centre asking for stock is an ordinary requirement carrying
`raisedForWarehouseId` and the person's own `reasoning`, so it lands in the
purchase manager's existing review queue.

## Person-centric permissions

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/masters/users/:id/permissions` | `admin.rbac.manage` | **Every** permission in the system with where this person's answer comes from — role, granted, or revoked. Showing only what they have would make "why can't they do X" unanswerable |
| POST | `/masters/users/:id/permissions` | `admin.permission.override` | `{ permissionCode, effect: GRANT \| REVOKE \| DEFAULT, reason, expiresOn? }`. A reason is required; `DEFAULT` removes the override and puts them back on their role |
| POST | `/masters/users/:id/permissions/reset` | `admin.permission.override` | Clears every override for that person |

```
what they see = (their roles' permissions + GRANTs) − REVOKEs
```

Resolved by `v_user_permissions` in the database, so the screen showing what a
person can do and the gate deciding whether to let them cannot disagree about
precedence. `loadActor` reads that view.

Guards, each tested: a grant with no reason is refused; an expired grant stops
working the next time they sign in; **nobody can edit their own permissions**
— it is the one change with no second pair of eyes anywhere in the system.

## Pricing — what it really cost

`v_overhead_per_kg` derives the cost of simply running the place, rather than
asking anyone to type it:

```
overhead per kg = operating expenses actually PAID in the window
                ÷ kilos actually RECEIVED in the window
```

Both sides are facts already in the system, so it moves as the business moves.
Only categories flagged `affects_landed_cost` count — rent and wages do, a
supplier advance does not, because that is the purchase price arriving early
and counting it would charge the same rupee twice.

`v_batch_pricing` then gives, per batch:

```
true cost     = landed rate + overhead
minimum price = true cost ÷ (1 − wastage%) × (1 + margin%)
```

Dividing by the wastage rather than multiplying is the part that gets done
wrong: if a tenth of a crate is thrown away, the nine tenths that sell have to
carry the whole crate's cost.

`GET /inventory/issuable` and `/inventory/sell-suggestions` both carry
`overhead_per_kg`, `true_cost` and `min_sell_price`, and the **suggested price
now floors at the minimum rather than at the purchase price** — selling at what
a crate cost to buy loses money quietly, which is the worst way to lose it.

## GET /insights/product-performance

`?days=` (1–365). Returns `products[]` and `categories[]`. Per product: bought
and sold quantity and value, margin and margin %, **waste from both wastage
issues and audit shortfalls**, sell-through, stock still held, the top four
suppliers, the top four places it sells, and a daily revenue series.

Categories are summed from the products rather than queried separately, so the
two can never disagree on a page whose whole purpose is comparison.

## hr — the people who do the work

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/hr/workers` | `hr.report.view` | With 30-day attendance and measured output |
| POST/PATCH | `/hr/workers`, `/hr/workers/:id` | `hr.worker.manage` | A worker is **not** a user — most will never log in, and requiring an account to be paid is how half a workforce ends up off the books |
| GET/POST | `/hr/attendance` | `hr.attendance.mark` to write | A batch per day, because somebody walks the floor once. Marking again corrects it. A future date is refused |
| GET | `/hr/wages/preview` | `hr.wages.run` | Worked out from the attendance, nothing saved |
| POST | `/hr/wages/run` | `hr.wages.run` | One `WAGES` payment request per person, so Finance can hold one without holding everybody. A bonus needs a reason; the same period cannot be run twice |
| GET | `/hr/summary` | `hr.report.view` | Headcount, today, wages and bonuses, day-cost per place |

Monthly pay is a salary — it does not shrink because February is short; what it
loses is unpaid absence. With no overtime rate set, an overtime hour is worth an
hour of the normal day, because assuming zero would quietly pay people nothing
for it.

**Performance is measured, not rated**: boxes weighed, boxes packed and shelves
counted are already recorded against whoever did them (`v_worker_output`). A
number somebody earned beats a star somebody gave them.

## masters — the company

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/masters/qc-templates` | any | Live checklists with their checks, how many products use each, and how many inspections have been run against it |
| POST | `/masters/qc-templates` | `quality.template.manage` | Refuses a numeric check with no range (every answer would pass), a choice with nothing to choose from, duplicate check codes, and thresholds that do not descend |
| PUT | `/masters/qc-templates/:id` | `quality.template.manage` | Never used → changed in place. Used → v1 retired intact, v2 created, products moved. Retires **before** inserting, because `uq_qc_template_live` cannot be deferred |
| POST | `/masters/qc-templates/:id/retire` | `quality.template.manage` | Needs a reason, and a replacement if products still use it |
| PUT | `/masters/products/:id/qc-template` | `quality.template.manage` | Which checklist a product is inspected against |
| GET | `/masters/company` | any | Company UPI, default margin, overhead window, and what **each place actually prints** |
| PATCH | `/masters/company` | `admin.settings.manage` | |

`v_effective_upi`: a centre's own code wins where it has one, the company's is
what everyone else prints. Only having the per-centre code meant a new shop had
nothing to print until somebody remembered to set it.
