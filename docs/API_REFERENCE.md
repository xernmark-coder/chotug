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
| GET | `/masters/drivers` | — |
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
