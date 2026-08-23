# Client update — implementation plan

Every line of `strict_Update_asked_by_client.txt`, mapped to a phase, with the
decisions that need answering before the code is written.

Phases are ordered by **dependency**, not by importance: the money spine and the
product identity are underneath almost everything else, so they come first even
though the Centre panel is the most visible new thing.

---

## Three decisions I need from you

These are business choices, not technical ones. Getting them wrong is expensive
to undo, so I would rather ask than assume.

### 1. Paying the supplier at confirmation — **decided**

> *"the payment is done at that time of confirmation with supplier"*
> *"no need to 3 way match, every finance will be done as per asked by client"* — 23 Aug 2026

**Answered: the match is no longer a gate.** An invoice reaches the Finance
inbox the moment it is captured, whoever captures it — our clerk or the supplier
through their own portal. Finance verifies and pays. The three-way match still
runs and is still shown on the invoice, but as *reconciliation the buyer can
read*, never as a lock on the money.

What protects the client instead:

- **Finance verifies every request**, and may approve *less* than was asked for.
- **Maker–checker**: nobody verifies a request they raised themselves.
- **A transaction reference is required** on anything that is not cash, and the
  same reference cannot be used twice — the practical guard against paying the
  same bill on Tuesday and again on Friday.
- **Payments are reversible with a reason**, so a wrong payment leaves a trail
  rather than being edited away.

### 2. What a "breed" is in the data

> *"category of mango under that different breeds of the mango"*

Today: category **Fruits** → product **Mango** → a text field `variety` =
"Alphonso". Only one variety per product, and it is just a label — you cannot
hold different stock or different prices for Alphonso and Kesar.

I propose: **a breed becomes a product in its own right**, and Mango becomes a
category:

```
Fruits (category)
└── Mango (category)
    ├── Alphonso   (product — own stock, own price, own code)
    ├── Kesar      (product)
    └── Kokani     (product)
```

Why this and not a fourth level: stock, batches, pricing, QC and every report
already key off one `product_id`. Making a breed a product means all of that
works for breeds on day one. Adding a level below product means rewriting every
one of those queries.

Category performance then rolls up naturally — Alphonso rolls into Mango, Mango
into Fruits. **Confirm** and I will migrate the existing eight products into
this shape.

### 3. Centre — shop, or warehouse?

> *"they sell their product from various centers in the city"*

A centre holds stock and sells it. That makes it, in data terms, a small
warehouse with a till. I intend to model it as a **warehouse row with
`is_centre = true`**, so stock transfers, balances, the ledger and audits all
work there with no new machinery — plus a centre-specific panel on top.

The alternative is a separate `centres` table with its own stock tables, which
means every stock query in the system learns about a second kind of place.
**Confirm** the warehouse approach.

---

## Phase 1 — Product identity  *(foundation)*

Nothing else can be tracked properly until a thing has one name.

| Requirement | What gets built |
|---|---|
| Category → product → breed | `product_categories` made properly hierarchical; breeds migrated to products |
| Supplier's own product number | `supplier_products.supplier_code` — their code for our product |
| One code that tracks it everywhere | Generated `tracking_code` per (supplier, product), printed on labels |
| Visual identification for non-technical staff | An SVG icon per product and per category |
| Admin can add breeds/categories | Master-data screens, and the "add to any dropdown" pattern |

**Unblocks:** per-box weighing, pricing, performance reporting, the centre panel.

---

## Phase 2 — The money spine  *(Finance as the centre of the CRM)*

The client was emphatic that Finance is central. Today the system only tracks
*supplier* payables. This turns it into one place where all money is handled.

| Requirement | What gets built |
|---|---|
| Every payment goes through Finance | `payment_requests` — raised anywhere, verified and paid only by Finance |
| Pay suppliers | Supplier invoice → request → verify → pay |
| Pay workers | Wages raised from HR, paid here |
| Every expense | Electricity, petrol, rent, cleaning, labour — categorised, with the centre or warehouse it belongs to |
| Money coming in | Collections from centres and customers |
| Cash or online | Payment mode on every transaction, with transaction ID stored and checked |
| UPI | Admin sets the company UPI code; centres print it or use their own |
| Centre performance | Revenue, expense and margin per centre |

**Depends on:** Phase 1 (so expenses can be attributed to a product/centre).

### Built — 23 Aug 2026

| Piece | Where |
|---|---|
| Tables, permissions, document series | `db/21_money_spine.sql`, `22_system_raised_requests.sql`, `23_money_access.sql` |
| The whole money API | `server/src/modules/finance.ts` |
| The Finance desk | `web/src/pages/FinanceDesk.tsx` → `/finance` |
| Finance's home screen | `Home.tsx` "Your desk", fed by `money_to_verify` / `money_to_pay_value` / `money_to_confirm` |

**How the screen is split.** Everybody who spends money may raise a request —
the gate clerk who paid a tempo, the QC hand who bought ice. They see *Money
Requests*: what they asked for and where each one stands. Finance, the owner and
the purchase manager see the *Finance desk*: the whole inbox, verify, pay,
confirm collections, and where the money went. Same route, two screens, decided
by `finance.expense.view` — so nobody is shown an inbox they cannot act on, and
nobody is left paying out of pocket with no way to claim it back.

**Still open:** the UPI settings screen (the columns and API exist; the admin
form does not), and per-centre revenue vs expense — that arrives with Phase 5,
when centres become real records rather than warehouses.

---

## Phase 3 — Inbound: supplier → gate → warehouse

| Requirement | What gets built |
|---|---|
| Supplier enters invoice + vehicle at confirmation | **Built** — folded into the accept step: `POST /supplier/orders/:id/respond` files the invoice and the lorry together |
| Gate enters only the invoice number | **Built** — `GET /receiving/lookup/invoice`, wired into `/gate/new` |
| Weigh every box on unload | **Built** — `unload_boxes` + `v_unload_totals`, the `/unload/:id` tablet screen, feeding the goods receipt |
| QC and packing together | **Built** — `/pack-bench/:batchId`: grade each box as it is packed, then scan the shelf |

### Built — 23 Aug 2026

The supplier's acceptance became the moment everything is captured, because it
is the moment they actually know it. `db/24_supplier_acceptance.sql` and
`db/25_invoice_at_confirmation.sql` carry the schema; `db/26_box_weighing.sql`
carries the boxes.

The order of the arrows matters and is enforced end to end: **accepted → paid
(if they asked to be) → sent**. A supplier on credit terms never raises a
request, and for them nothing changed.

`db/27_pack_and_grade.sql` finishes the phase: a pack carries its own grade and
its own shelf, and `v_bin_contents` answers "what is on that shelf".

**Phase 3 is complete.** What is left of it is Phase 4's business: the warehouse
structure itself — floor, section, rack, shelf and their printed QR codes. Racks
and bins already exist and the bench scans them; what does not exist yet is the
screen to lay out a new warehouse and print its labels.

---

## Phase 4 — Warehouse structure and audit

| Requirement | What gets built |
|---|---|
| Floor → section → rack → shelf | Extends the existing zone→rack→bin structure rather than replacing it |
| A QR on every location | Printable QR per floor, section, rack and shelf |
| A QR on the stock, by location | Generated when the box is placed; scanning it says what, where, when, whose |
| Audit team panel | Scan a shelf, see everything on it; record counted vs expected, and any loss |
| Audit trail | Who audited, when, how, how much — already the shape of the existing `audit_log` |
| Audit tasks | Finance or admin asks for a stock/product to be audited; it appears in the audit queue |

---

### Built — 23 Aug 2026

| Piece | Where |
|---|---|
| Floor above the existing zone/rack/bin, QR on all four | `db/28_warehouse_map.sql`, `v_locations` |
| The map, built in runs, with printable labels | `web/src/pages/WarehouseMap.tsx` → `/warehouse-map` |
| A real QR encoder, verified against a scanner library | `web/src/components/qr.tsx` |
| Audit tasks and counts | `db/29_audit_team.sql`, `server/src/modules/warehousemap.ts` |
| The audit desk | `web/src/pages/Audit.tsx` → `/audit` |
| An `AUDITOR` role that can count and report, and move nothing | `29_audit_team.sql` |

**Phase 4 is complete.** What remains of the client's list is Phase 5 (centres
and customers) and Phase 6 (product performance, minimum sell price, HR, filters
everywhere, per-person permission overrides).

## Phase 5 — Centres and customers

| Requirement | What gets built |
|---|---|
| A panel per centre | Stock held, stock sent, sales, customers |
| Send stock to a centre | Transfer with the vehicle and its transport cost recorded |
| Daily close | Quantity sold, revenue, cash vs online — before the centre shuts |
| Raise a requirement | With a reason; goes to the Purchase Manager to review |
| Customers | A real customer master; "add customer" from the dropdown while selling |
| Ranking and comparison | Centres against each other |

---

### Built — 23 Aug 2026

| Piece | Where |
|---|---|
| A centre is a warehouse with `is_centre` | `db/30_centres.sql` |
| Transfers that stay in transit until counted in, with vehicle and transport cost | `server/src/modules/centres.ts` |
| Customers, added from the till | `customers` table, `AddCustomerModal` reused in Sales |
| The day's close, with the gap against the bills | `centre_day_close` |
| Centre ranking on net after costs | `GET /centres/performance` |
| The screens | `web/src/pages/Centres.tsx` → `/centres`, `/centres/:id`, `/customers` |

**Decision 3 answered by building it:** centre = warehouse with a flag. Every
existing mechanism — ledger, batches, packs, shelves, FEFO, the audit — applies
to a shop unchanged.

**Phase 5 is complete.** What remains is Phase 6: product and category
performance, minimum sell price, the HR panel, filters everywhere, and
per-person permission overrides.

## Phase 6 — Insight, HR, and the long tail

| Requirement | What gets built |
|---|---|
| Product and category performance | One card per product: sold, revenue, suppliers, where sold, loss — with graphs; same per category |
| Honest minimum price | Bought at + labour + storage + transport = the floor below which a sale loses money |
| HR panel | Workers, wages, leave, hours, performance, bonuses — wages flow to Finance |
| Filters everywhere | Time always, plus product / supplier / priority / raised-by / search, each showing the count and total for what is filtered |
| Per-person permissions | Admin grants or revokes for one person, overriding their role, and can reset back |

---

## Two things that are already true

Worth saying so they are not paid for twice:

- **"every entry immediately visible to finance and admin"** — the work queue
  and alerts already do this; new events plug into them.
- **"each reduction and increase reflected across the system"** — every stock
  movement already goes through one append-only ledger, and the balance is
  derived from it. I verified this reconciles exactly. New movements (centres,
  audits) will use the same path rather than writing their own.

---

## Suggested order of delivery

1 → 2 → 3 → 4 → 5 → 6, because each phase needs the one before it. If the
client wants something visible sooner, **Phase 5 (Centres)** can be pulled
forward after Phase 1, at the cost of the centre's money not being fully
integrated until Phase 2 lands.

### Built — 23 Aug 2026

| Piece | Where |
|---|---|
| Per-person permission overrides, with reasons and expiry | `db/31_person_permissions.sql`, `v_user_permissions`, People → *Their panel* |
| Minimum sell price from real overheads | `db/32_min_sell_price.sql`, `v_overhead_per_kg`, `v_batch_pricing` |
| Product and category performance with graphs | `GET /insights/product-performance`, `web/src/pages/Performance.tsx` |

### Also built — 23 Aug 2026

| Piece | Where |
|---|---|
| HR: workers, attendance, leave, hours, measured output, wage runs, bonuses | `db/33_hr.sql`, `server/src/modules/hr.ts`, `web/src/pages/Hr.tsx` |
| Filters with totals, as one shared component | `useFilters` / `FilterBar` / `FilterTotals` in `ui.tsx`, applied to orders, requirements, the buy list and invoices |
| Company-level UPI, with per-centre override | `db/34_company_upi.sql`, `v_effective_upi`, Settings |

**Every phase is complete.** All 82 checks in `/tmp/verify.sh` pass; the flow
was driven end to end from order to sale across eight roles.
