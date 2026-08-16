# Farming module — gap register

An end-to-end audit of the farming section, walked as the people who would actually use it: a
field labourer on a phone, a farm manager, and an owner. Every item below was **reproduced against
the running system**, not inferred from reading code. Evidence is quoted where it matters.

Severity is "what does this cost the user", not "how hard is it to fix".

---

## P0 — Live breakage

### 1. ~~FARM TODAY stops working about an hour after the first crop problem~~ — **FIXED**

`GET /api/farming/today` returns `409 {"error":"That record already exists.","code":"duplicate",
"detail":"uq_alerts_dedupe"}`. The primary screen for the primary user goes down and stays down.

Reproduced:

```
call while alerts are fresh ............ 200
(age the open alerts past 60 minutes)
call again ............................. 409
```

**Cause** — a mismatch between two dedupe rules that were written independently:

| Where | Rule |
|---|---|
| `raiseAlert()` in `platform/services.ts` | skip if an identical OPEN alert exists **created in the last 60 minutes** |
| `uq_alerts_dedupe` in `01_schema.sql` | unique on `(company_id, dedupe_hash)` where `status='OPEN'` — **no time limit** |

So an alert that is still OPEN after 60 minutes passes the application guard and then hits the
index. The daily pass re-raises crop-health alerts on every FARM TODAY open, so this fires
reliably rather than occasionally.

**This is pre-existing, not farming-specific.** `raiseAlert` is untouched by the farming work
(`git diff` on `services.ts` shows only two type-union additions). It is latent in purchase too —
any `LOW_STOCK`, `QC_REJECTION` or `PO_APPROVAL_PENDING` alert left open for an hour and re-raised
will 409 the same way. Farming just made it a certainty instead of a coincidence.

**Fixed.** `raiseAlert()` now inserts with
`ON CONFLICT (company_id, dedupe_hash) WHERE status='OPEN' DO UPDATE`, so the database is the
single arbiter: one open alert per subject, and a re-raise refreshes it instead of failing.
Verified by aging every open alert three hours and calling `/farming/today` repeatedly — 200 each
time, where it previously returned 409 permanently.

---

## P1 — The field worker cannot do the job on the device they own

The whole design premise is a labourer with a phone in a field. These break that premise.

### 2. There is no navigation on a phone

`styles.css` hides the sidebar below 720px and **nothing replaces it** — no hamburger, no drawer,
no bottom bar (`grep` for hamburger/menu-toggle/mobile-nav/drawer returns nothing).

Measured at 390×844: `sidebar visible = false`, 13 clickable elements on the page, none of which
navigate anywhere. A worker who lands on `/farm` can never reach Harvest, and after scanning a
plot QR has no way back.

### 3. The topbar overflows on a phone

At 390px the title, the branch selector and the action buttons sit on one row. "Harvest" and
"Refresh" are cut off the right edge — see `phone-farm-today.png`. The branch `<select>` also has
no business being on a field worker's screen at all; they work at one farm.

### 4. Hindi is designed for but never delivered

The schema carries `title_hi`, `name_hi`, `crop_name_hi`, and the domain returns `reasonHi` /
`messageHi`. Almost none of it reaches the screen:

```
source   | tasks | with_hindi
CALENDAR |   165 |          1
SYSTEM   |     1 |          1
WEATHER  |     1 |          1
```

Two separate faults. `planCrop()` has no `titleHi` field at all, so the calendar generator writes
165 tasks with a NULL Hindi title. And FARM TODAY renders `{t.title}` regardless, so even the rows
that *do* have Hindi never show it. Only the problem-reason list and the weather banner are
actually bilingual — and those are hardcoded strings in the page.

For a Marathi- or Hindi-speaking labourer this is an English app with Devanagari decoration.

### 5. Online-only

Every action is a live `fetch`. There is no service worker, no queue, no optimistic write. Farms
have patchy 4G; this is the environment the idempotency keys were designed for, but nothing on the
client takes advantage of them.

### 6. Watering the whole farm is one tap per plot

One pump, one canal turn, three plots — three separate DONE presses. There is no bulk action and
no "same job across plots" grouping. Verified: three irrigation cards for one physical act.

### 7. An unplanned watering cannot be recorded

`POST /farming/tasks` creates an ad-hoc job, but it **has no UI caller**. If someone waters off
schedule the only path is to mark the *next* pending task DONE early. That happens to reset the
clock correctly, but it is a workaround, not a designed path, and it silently loses the fact that
an extra watering happened.

### 8. Database constraint names are shown to users

Two reproduced examples:

- `{"error":"That record already exists.","detail":"uq_cycle_live_per_plot"}`
- `{"error":"That record already exists.","detail":"uq_alerts_dedupe"}`

The purchase module maps its constraints to sentences in `errorHandler`. The farming constraints
were never added to that map, so a farmer trying to sow half a plot is told a unique index name.

---

## P2 — The farm's real operating model does not fit the data model

### 9. One live crop per plot blocks how vegetables are actually grown

`uq_cycle_live_per_plot` permits exactly one active cycle per plot. That rules out two
completely normal practices:

- **Succession sowing** — spinach or coriander sown in thirds a fortnight apart, so picking is
  continuous rather than one glut. Reproduced: sowing 0.5 acre on a 1.2-acre plot that already has
  tomato is rejected outright.
- **Intercropping** — tomato with marigold, or onion between sugarcane rows. Standard practice,
  impossible here.

The plot is the wrong grain for a crop cycle. A sub-plot / bed / "sowing block" between plot and
cycle would fix it, and `farm_plots` already has the shape to be nested.

### 10. No nursery or transplant date

Tomato, capsicum, cauliflower and brinjal are raised in a nursery for 25–30 days and then
transplanted. A farmer counts crop age and harvest date from **transplant**, not from sowing.
`farm_crop_cycles` has only `sowing_date`, so every derived date for a transplanted crop is
roughly a month wrong unless the user lies about the sowing date.

### 11. Produce that never reaches a warehouse cannot be recorded

The only exit from a harvest is `farm_dispatches` → a company warehouse. Real farms sell B and C
grade at the gate to a passing trader, send a load straight to the mandi, keep some for staff, or
feed rejects to cattle. None of that can be entered.

Consequences beyond the missing record: `dispatched_kg` never balances against `harvested_kg`, the
farm looks like it is losing produce, and revenue — hence cost per kg and profit — is wrong.
`farm_harvest_lines.destination` already has the vocabulary (`RETAIL`/`B2B`/`PROCESSING`/
`FARM_HOLD`); there is simply no endpoint that consumes it as a sale.

### 12. Nothing can be corrected

`grep` for delete/void/cancel/amend across the farming router returns nothing. There is no path to:

- fix a harvest entered as 3120 kg instead of 312.0 kg
- cancel a dispatch that never left
- correct a sowing date typed wrong on day one
- reverse a crop closed by mistake

Weights are typed by tired people on phones. The purchase module took this seriously — posted GRNs
are immutable but have explicit amend and reverse paths. Farming has immutability with no escape
hatch, which is worse than either option alone.

### 13. The crop master cannot be edited from the app

Seven crops are seeded in SQL. There is no create/update endpoint and no screen. A farmer growing
brinjal, okra, coriander, fenugreek or bitter gourd — all ordinary — cannot start a cycle at all,
and has no way to tune an interval or a yield figure they know to be wrong for their soil.

This is the single biggest limiter on the module being usable outside the demo.

### 14. Units are not the ones farmers use

Area is acre-only; Maharashtra works in **guntha** (1/40 acre) and much of north India in
**bigha**. Weight is kg-only; trade happens in **quintal**. The `uoms` table already carries QTL,
so the weight half is a display decision rather than a schema change.

### 15. Daily-wage labour has no place in the system

`§22` staff performance joins `farm_tasks.done_by` to `users`. Every worker therefore needs a login
and a role assignment. On a 4-acre farm the labour is two or three people who change with the
season and do not have accounts. In practice one supervisor will press every button, so
"performance" measures the supervisor and nothing else.

A lightweight `farm_workers` table (name, phone, no login) referenced by tasks and harvests would
model reality; `users` should stay for people who actually sign in.

### 16. Tasks are never assigned to anyone

`work_queue.assigned_user_id` exists and is never set by farming. Every job belongs to everybody,
so a manager cannot split the morning between two people, and nobody can see "my" work.

---

## P3 — Automation that fails quietly

### 17. No weather means no automation, and nobody is told

Deleting today's weather row and calling `/farming/today` returns `weather: null, advice: null`.
Irrigation is never held, spraying is never deferred, no heat or frost alert fires — and the screen
looks completely normal. The feature simply stops, silently.

At minimum this needs a visible "no weather for today" state on FARM TODAY and a prompt to enter
it. Better, it needs item 19.

### 18. The daily pass only runs when somebody opens FARM TODAY

Deliberate, and documented in ARCHITECTURE.md — but the consequence is under-stated there. Crop
colours, harvest-due alerts and the owner's dashboard only advance when a field worker opens the
app. If the team is off for three days, the owner sees a green farm because nothing recomputed. The
owner's view depends on the worker's behaviour, which is backwards.

### 19. Weather must be typed in by hand, every day

There is no forecast fetcher. `source` supports `API`, nothing calls one. Expecting a daily manual
weather entry from a farm office is expecting the feature to lapse in week two.

### 20. The staff score cannot see work that was ignored

`tasksAssigned` is computed as `max(tasksDone + problemsRaised, tasksDone)` — it is derived from
what the person *touched*. Somebody who completes 2 of their 20 jobs is recorded as 2 assigned and
2 done: 100% completion. The metric can distinguish late from on-time, but it structurally cannot
distinguish diligence from avoidance, which is the main thing a farm owner wants from it.

The fix needs a real denominator — tasks that fell due on plots that person works — which in turn
needs item 16.

### 21. Water is counted in events, not in water

Irrigation records only *that* it happened. No duration, no pump hours, no volume. So `cropCost`
has a `WATER` bucket that only ever fills from a manually entered electricity bill, and per-crop
water cost — a real number on a tube-well farm — is unavailable.

### 22. Machine usage is never captured

`farm_expenses.machine_id` exists; no screen sets it. `§23`'s "link the machine to the farm and
plot it was used on" is therefore not implemented, and machine status is a manual dropdown that
nothing else feeds.

### 23. Multi-pick crops nag every day

When a harvest reminder is completed and the window is still open, the next daily pass creates a
fresh one dated today. Tomato picks every third day across a 35-day window, so the worker gets a
harvest card on all 35 days and learns to ignore it. The reminder should respect a per-crop pick
interval, not reappear daily.

---

## P4 — Built but not connected, or not built

| # | Gap | State |
|---|---|---|
| 24 | **§25 farm supply is not wired into the buy list** | `GET /farming/supply-plan` and the harvest forecast both work; `planning.ts` never calls either. A buyer still sees "buy 500 kg tomato" with no idea the farm delivers 350 kg tomorrow. This is the one item that leaves a stated requirement unmet. |
| 25 | `farm_staff_scores` | Table created, **never written to**. Performance is recomputed on every request. Either snapshot into it per period or drop the table. |
| 26 | Plot QR codes | The string and the `/farm/plot/:qr` route work. **No QR image is rendered** — no library in `package.json`. The labels §6 asks you to stick on plot gates cannot be printed. |
| 27 | Crate labels | `window.print()` prints an HTML card. No barcode, no QR, no ZPL/TSPL. Not scannable, so §28's "scan the crate" trace has no physical input. |
| 28 | Smart scale | `capture_mode` and `scale_device_id` are recorded; no serial/TCP driver exists. Weight is typed. |
| 29 | Profit from sales | `revenue` is typed when a crop is closed. §29's "profit updates as the product sells" needs a sales module this repo does not contain. |
| 30 | Expected revenue | Missing from the owner dashboard; §32 lists it. Needs a selling price on the crop master. |
| 31 | Crop photos | Stored as data URIs on `farm_observations`. Fine for a diary, wrong past a few hundred rows — and they travel in every API response for the crop file. |
| 32 | Farm pending stock | Tracked per cycle (`harvested − dispatched − waste`), but there is no screen showing §17's "Farm Pending: 30 kg" as its own view. |

---

## P5 — Engineering

| # | Gap |
|---|---|
| 33 | **No automated tests anywhere in the farming module.** Verification was by driving the running app, which does not survive a refactor. The domain layer is pure functions and is the cheapest possible thing to test — `planCrop`, `irrigationDecision`, `harvestReadiness`, `dispatchVariance`, `cropCost`, `staffScore` — and none of it is covered. |
| 34 | A genuinely fresh-database migration has never been run (no create-database rights on this machine). Only idempotent re-runs on an existing database are proven. |
| 35 | The outbox is written transactionally and nothing drains it — pre-existing, now inherited by every farming event. |
| 36 | `bootstrap_company()` does not call `bootstrap_farming()`; a new tenant silently gets no farm roles unless the operator remembers both. Documented, but a footgun. |

---

## Suggested order

1. **Item 1** on its own — it is a live outage, and one statement.
2. **Items 2, 3, 4, 8** — the field worker's phone. Without these the module has no primary user.
3. **Items 13, 12, 11** — crop master CRUD, a correction path, and farm-gate sales. These three are
   what stand between "demo" and "a farm could run on this".
4. **Item 24** — connect the farm to the buy list; it is the requirement that is formally unmet.
5. **Items 9, 10, 15** — the data-model changes. Worth doing deliberately and together, since they
   all touch the cycle/plot/worker grain.
