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
