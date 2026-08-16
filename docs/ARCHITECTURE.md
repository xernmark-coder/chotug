# Architecture

## The problem this shape solves

Fresh produce purchasing fails in three specific ways, and the architecture is arranged around
preventing each one:

1. **Stock appears without evidence.** Someone posts a receipt that no truck, weighbridge or
   inspector ever saw. Fixed by making `grns.gate_entry_id` NOT NULL in the schema — there is no
   code path, authorised or not, that creates inventory without a gate entry behind it.
2. **The cost is wrong.** Margin is computed against the rate on the bill, ignoring commission,
   transport, hamali, mandi cess and the 8% of tomatoes that will be thrown away. Fixed by making
   landed cost a first-class computed artefact that emits an event to Pricing.
3. **The weight is wrong.** Wet produce, uncounted crates, a convenient re-weigh. Fixed by
   append-only weighments with container tare, tolerance bands, and a database constraint that
   refuses to store a breached closing weight without an approver.

Everything else follows from those three.

---

## Layers

```
web (React + Vite)
  │  fetch /api/*  — JWT in Authorization header
  ▼
express routes           modules/{masters,planning,receiving,costing,insights}.ts
  │                      validation (Zod) → permission guard → withTx
  ▼
platform services        numbering · outbox · work queue · alerts · approvals · settings
domain (pure functions)  every formula, no I/O
  ▼
postgres                 96 tables · RLS · constraints · triggers · views · matviews
```

The database is not a persistence detail here — it is the last line of defence. Constraints like
`ck_po_maker_checker`, `uq_ledger_grn_line` and `ck_gate_exception` are load-bearing. The
application's job is to reach them with good messages, not to replace them.

---

## Tenancy and audit

`withTx()` opens a transaction and sets two session GUCs before anything else runs:

```sql
SELECT set_config('app.company_id', $1, true);
SELECT set_config('app.user_id',    $2, true);
```

`true` makes them transaction-scoped, so a pooled connection handed to the next request never
carries the previous tenant's identity. Row-level security policies read the first; the audit
trigger reads the second. Neither can be forgotten by a developer writing a new endpoint, because
there is no other way to get a client.

---

## Permissions

Loaded once per request in a single query that returns every permission code from every active role
assignment, plus the *most permissive* limit across those roles (limits are a ceiling, not a floor).
`requires('purchase.po.approve')` guards the route; `admin.override` passes any gate but is still
recorded by the audit trigger.

The frontend receives the same permission list and uses it to decide what to render. That is a
convenience only — every action is re-checked server-side, and several checks (maker–checker,
approval level, PO value limit, back-date window) exist *only* on the server because they depend on
the document, not just the user.

---

## The work queue

The single mechanism that makes the UI navigable. When a document becomes someone else's problem, a
row goes into `work_queue` with the permission required to act on it and an SLA. When they deal with
it, the row is resolved.

`GET /insights/work-queue` filters by `required_permission = ANY(your permissions)`. So "My Work" is
correct for every role without any per-role UI code, and nothing depends on someone remembering to
tell the next person.

---

## The GRN transaction

The critical path. One `withTx` performs, in order:

```
idempotency key claim
  → chain-completeness check (QC done, or an authorised exception)
  → back-date limit check
  → grns header
  → per line:
       grn_lines
       batches (expiry from shelf life)
       labels (lot + per-crate, real weight for variable-weight goods)
       stock_ledger IN
       stock_balances upsert
       bin suggestion → putaway_tasks → work_queue
       po_lines progress
  → purchase_orders status
  → gate_entries → COMPLETED
  → outbox: grn.posted
  → idempotency response cached
```

Three things make this safe under a bad warehouse network:

- **Idempotency key** claimed at the start; a retry returns the cached response instead of posting
  twice.
- **`uq_ledger_grn_line`** — a unique index on the ledger by GRN line. Even if the idempotency layer
  were bypassed, the database refuses the second insert and the user is told *"already posted"*.
- **The outbox is written inside the same transaction.** A committed receipt can never fail to
  notify Pricing and Accounts, and a rolled-back one never notifies them wrongly.

---

## AI

Six features, one contract:

```
1. compute a statistical answer that is always available
2. optionally ask an LLM to refine or explain it
3. persist an ai_runs row: model, confidence, latency, used_fallback
4. return advisory output — never a committed business record
5. when a human accepts or overrides, write that back to the same row
```

| Feature | Statistical core | LLM adds |
|---|---|---|
| F1 demand forecast | seasonal-naive + day-of-week factors + damped trend, p10/p50/p90 | nothing — pure statistics |
| F2 buy suggestion | the recommended-quantity formula | narrative and risk |
| F4 price signal | linear regression on mandi modal prices | one line of buying advice |
| F5 QC photo assist | — | parameter pre-fill from photos, gated by a confidence floor |
| F8 anomaly | robust z-score (median + MAD) | nothing |
| F9 assistant | — | answers from permission-scoped context only |

Median and MAD rather than mean and standard deviation for anomalies, because one crazy mandi day
would otherwise desensitise the detector permanently.

The forecast is implemented in TypeScript rather than calling out to Python/StatsForecast. It is the
one thing the system needs every single morning, and a working install should not depend on a second
runtime being healthy.

---

## Domain layer

Every number the business argues about is computed in `domain/index.ts` and nowhere else:
recommended quantity, weight variance and bands, net weight, QC scoring, sample size, landing cost
allocation, quote landed rate, supplier scores, 3-way match, state machines.

Pure functions, no imports from the database. This is what prevents the classic ERP disease where
the dashboard says ₹42.30 and the report says ₹42.28 — there is exactly one implementation, and it
can be unit-tested without a database.

---

## Charge allocation

Not a detail. Each charge type carries an allocation basis:

| Basis | Used for | Why |
|---|---|---|
| VALUE | commission, mandi cess | they are genuinely a percentage of value |
| WEIGHT | transport, hamali | a truck charges by load, not by invoice value |
| QTY | packing, crate charges | per unit handled |
| EQUAL | toll, weighbridge fee | fixed per trip |

Allocate transport by value and a heavy cheap crate of potatoes silently subsidises a light
expensive box of mangoes — and the mango margin looks better than it is.

---

## State machines

Declared as data in `TRANSITIONS`, checked by `assertTransition()` before any write. Illegal moves
are rejected with a message naming what *is* allowed: *"A po in 'RECEIVED' cannot move to
'CANCELLED'. Allowed: CLOSED."* The GATE machine is aligned exactly with the schema's status CHECK
constraint, so the application and the database cannot disagree.

---

## Error translation

`errorHandler` maps Postgres constraint names to sentences a warehouse supervisor can act on:

| Constraint | Message |
|---|---|
| `uq_ledger_grn_line` | This receipt has already been posted to inventory. Nothing was posted twice. |
| `ck_po_maker_checker` | The person who submitted this order cannot also approve it. |
| `ck_qc_qty_balance` | Accepted + rejected + hold cannot exceed the received quantity. |
| `grn_immutable` | A posted GRN cannot be edited. Use amend or reverse instead. |
| `gate_entry_locked` | This gate entry is submitted and locked. Raise an amendment instead. |

The constraint stays authoritative; only the wording is the application's job.

---

## Frontend

React 18 + Vite + React Router, ~12 KB of CSS tokens, Recharts for the three charts. No state
library — a small `useApi` hook covers every screen, and the work queue means no screen needs to
know about another screen's state.

Colour carries meaning and nothing else: indigo for primary action, amber for anything needing
attention, red for stop, cyan for done. No green anywhere, per the client's instruction. Warehouse
and gate screens add a `touch` class that lifts every control to a 48 px minimum and 16 px text.

The prefilled-and-read-only pattern is enforced by a shared component: anything the system already
knows is filled and locked, with an explicit **Edit** that demands a reason — which is then stored
on the row and used as the AI feedback signal.

---

## The farming module

Farming was added on top of the purchase module rather than beside it. The test applied to every
design decision was: *could a purchase-module screen already answer this?* Where the answer was
yes, the farming module reuses it instead of building a parallel one.

### What it reuses rather than rebuilds

| Concern | Reused |
|---|---|
| Where produce ends up | `batches` → `stock_ledger` → `stock_balances`, unchanged |
| Farm traceability on a batch | `batches.farm_id`, which already existed for supplier farms |
| Someone's to-do list | `work_queue`, with three new `queue_key` values |
| Something is wrong | `alerts` + `alert_rules`, deduplicated the same way |
| Document numbers | `next_doc_no()` with three new doc types (`CROP`, `HARV`, `FDN`) |
| Thresholds | `settings`, so the owner tunes farming on the existing settings screen |
| Who may do what | `permissions` / `roles`, with two new system roles |
| Tenancy, audit, optimistic locking | The same triggers and RLS policies, attached explicitly |

The consequence that matters: **a farm-grown crate is the same first-class batch as a bought
one.** Stock & Batches, FEFO put-away suggestions, expiry risk and the stock-position report all
understood farm produce the day the module shipped, because none of them had to learn anything.

### `farms` was widened, not duplicated

`farms` already existed as *a supplier's farm*, for one-up traceability. An own farm is the same
physical object with no supplier behind it, so `supplier_id` became nullable and `is_own`,
`code`, `branch_id` and a few operational columns were added, guarded by:

```sql
CHECK ((is_own AND code IS NOT NULL AND branch_id IS NOT NULL)
       OR (NOT is_own AND supplier_id IS NOT NULL))
```

A second `own_farms` table would have meant `batches` needing two nullable farm keys and every
traceability query needing a union. This way there is one farm concept and one join.

### Where produce enters stock

The purchase module's hard rule is that stock only appears behind a gate entry, a weighment, a QC
check and a GRN. Farm produce has no supplier and no gate, so it enters through its own door —
but under the same discipline:

```
farm_harvests  (weigh + grade, tare from the crate master)
      ↓
farm_dispatches  (farm says 500 kg)
      ↓  POST /farming/dispatches/:id/receive   ← one transaction, idempotency key
batches · labels · stock_ledger (TRANSFER_IN) · stock_balances
```

`TRANSFER_IN` rather than `GRN` because nothing was purchased: the produce moved between two
places the company already owns. `uq_ledger_grn_line UNIQUE (ref_type, ref_line_id, txn_type)`
covers it with `ref_type = 'farm_dispatch'`, so a retried receive fails at the database exactly
the way a retried GRN does.

The two-sided weight check is the point of the flow, not a nicety: the farm's dispatch weight and
the warehouse's received weight are recorded separately, and a gap beyond the configured tolerance
is **refused** without a written reason and then booked as a loss against the crop.

### The daily pass

Everything the module promises to do "by itself" lives in one function, `runDailyPass()`:

- re-roll every derived total on a live cycle from its source rows;
- colour each crop from what is actually wrong — overdue jobs, open problems, the last health
  check, a slipping harvest window;
- read today's weather and **hold irrigation** when rain is coming, rescheduling it two days out;
  skip spraying in high wind; raise an inspection alert on heat or frost;
- wake the harvest reminder as the window approaches and redden it when the window is missed;
- push **one** work-queue line per farm, not one per task.

It runs on every open of FARM TODAY rather than on a cron. That is deliberate: it is idempotent
(dedupe keys on tasks, dedupe hashes on alerts), and a farm laptop that was off for three days
should catch up when someone opens it, not stay three days behind waiting for a scheduler. A cron
can still call `POST /farming/farms/:id/refresh` if one is wanted.

### Onboarding a new tenant

`04_farming.sql` back-fills the farm roles, permissions and numbering for every company that
already exists, and defines `bootstrap_farming(company_uuid)` for ones created later. Because
`03_migration_fixes.sql` redefines `bootstrap_company()` wholesale, the farming setup is kept in a
separate function rather than folded into it — otherwise the two files would silently overwrite
each other depending on migration order. For a new tenant, call both:

```sql
SELECT bootstrap_company('<company_uuid>');
SELECT bootstrap_farming('<company_uuid>');
```

### Two audiences, one product

The field screens (FARM TODAY, the plot QR screen, HARVEST) are a different interface from the
desk screens, on purpose: big targets, three buttons, no forms, usable one-handed in sunlight.
They share the app's components and tokens, so a manager moving between purchase and farming is
not relearning the product — but a worker is never shown a crop calendar, a cost, or a dropdown he
cannot answer from where he is standing.

The colour vocabulary is 🟢/🟡/🔴 throughout, as the spec asks. GREEN maps onto the app's existing
cyan "ok" token rather than introducing a green — the palette deliberately avoids green, and one
visual language beats two.

### What is derived, and therefore never asked for

| The user types | The system derives |
|---|---|
| Crop, plot, area, sowing date | Harvest date, duration, expected yield, expected cost, the whole task calendar |
| DONE / PROBLEM / SKIP | Date, staff, farm, plot, crop age, the next due date, the manager alert |
| Gross weight, crate count, grade split | Tare, net weight, crop age, batch, label, destination per grade, warehouse notification |
| Expense type and amount | Farm, plot, crop, date, user, and the effect on cost per kg |
| A loss reason | The quantity's value, from what the crop has cost so far |
| Nothing at all | Colour rating, staff performance, 7-day forecast, buy-vs-grow, next-crop suggestion |

---

## Two later corrections worth knowing about

### Approval is now "within your own authority", not "never yourself"

`ck_po_maker_checker` forbade `approved_by = submitted_by` outright. The intent was right, but
taken literally it also blocked the Owner — who has nobody above them to route to — and a manager
whose own limit already covered the order. Both cases produced a document parked in a queue only
that same person could clear, which is how work stops rather than how control happens.

The rule is now **no *silent* self-approval** rather than no self-approval:

```sql
CHECK (approved_by IS NULL
       OR approved_by <> submitted_by
       OR (self_approved AND self_approved_reason IS NOT NULL))
```

Maker–checker still applies wherever the document genuinely exceeds the submitter's authority —
which is the case it exists for.

This also repaired a dead end nobody had noticed: requirements never raised an approval at all, so
they never reached `APPROVED`, and the PO step only marks a requirement `CONVERTED`
`WHERE status='APPROVED'`. That step had therefore never once fired.

### Queue text is written on the server, once

`"PO PO/2026-27/000012 needs level 2 approval"` with a subtitle of `"RATE_VARIANCE"` told the
reader nothing they could act on, so the web app had grown a `taskCopy()` helper that rewrote it —
badly, lower-casing supplier names and bolting on "Action required:" boilerplate.

Both are gone. `requestApprovals()` writes the sentence — action, subject, reason — and the page
renders what it is given:

> **Approve purchase order PO/2026-27/000023**
> ₹1,50,000 for Sahyadri — over the ₹1,00,000 approval limit · marked urgent

One place to keep honest, and it is the same string that goes to the audit trail.

### A migration-ordering trap

`04_farming.sql` and `06_stock_issue.sql` both rewrite `number_series_doc_type_check`. A plain
DROP/ADD in the earlier file revoked the later file's `ISS` the next time the chain re-ran, which
is how an "idempotent" migration set quietly stops being idempotent. Both now rebuild the
constraint as the union of what they need and what is already in use.

---

## Bugs found by driving the order → receive → QC → store chain

The chain was walked end to end as each role rather than read. Eight defects surfaced; all but
one had been there from the start and were invisible because no test ever completed the sequence.

| # | Defect | Consequence |
|---|---|---|
| 1 | A **lone GROSS weighment stored `net_kg` = the whole loaded lorry** | Every first weighment reported a CRITICAL variance (+472% on a 900 kg PO) and raised an alert, training people to ignore variance. Fixed: a two-weighment cycle has no net until both readings exist. |
| 2 | The QC sampling plan **summed `net_kg` across weighments** | It sized the sample against the truck (72 of 5150) instead of the produce (31 of 950), and would double-count after any re-weigh. Fixed: read the latest completed net, not a sum. |
| 3 | **Put-away confirmation always 500'd** — it tried to `UPDATE stock_ledger SET bin_id`, which `trg_ledger_no_update` forbids | No put-away had ever been confirmed. The column was written by that one statement and read by nothing; the ledger records movement, not a shelf. Statement removed. |
| 4 | **An over-tolerance weight could only be recorded by the Owner** | `ck_weigh_variance_approval` demands an approver on the row, but `PURCHASE_MGR` (the only role that can approve) was never granted `receiving.weighment.create`, and the roles that can create cannot approve. The vehicle stuck at the weighbridge. Grant added. |
| 5 | **`costing.landing.recompute` was granted to no role at all** | Landed cost — the module's headline number — was unreachable for everyone but the break-glass Owner. Granted to `PURCHASE_MGR` and `FINANCE_EXEC`. |
| 6 | **Nothing ever set `invoice_lines.matched_grn_line_id`** | The 3-way match read it, found nothing, and reported *"Invoice line has no matching goods receipt"* on every invoice — so it could never return MATCH and every invoice went to HOLD. Capture now auto-pairs each line to this supplier's posted receipt lines by product (explicit pairing still wins). |
| 7 | **`assertTransition` threw a plain `Error`** | Every illegal state transition in the app — PO, requirement, gate, GRN, invoice — surfaced as *"Something went wrong on our side"*, discarding a message that already said exactly what was wrong and what was allowed. Now a `TransitionError` mapped to 422 with its own sentence. |
| 8 | **Auto-approval violated `ck_po_maker_checker`** | The "no rule fired, approve on submit" path sets `approved_by = submitted_by`, which the constraint rejected — so a PO under every threshold could not be submitted at all. Recorded as an explicit self-approval with a reason. |

Four of these (3, 4, 5, 6) share one shape: **a state the system can reach that nobody has the
rights or the code path to leave.** They are invisible to unit tests and to any walkthrough that
stops at the happy step before them, and they only appear when one person tries to carry a single
document all the way from the buy list to a matched invoice.
