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
