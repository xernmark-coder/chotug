# ChotuG ERP — Purchase, Receiving & Farming

A production-shaped implementation of the ChotuG Purchase and Farming modules: React + Express +
PostgreSQL, built directly on the supplied 96-table schema, with free-model AI for forecasting, buy
suggestions, price signals and photo-assisted quality checks.

**The one idea behind purchasing:** every kilogram that enters the business must be
evidence-backed — a gate entry, a weighment, a quality check and a goods receipt — and what the
produce *costs* is its landed cost, never the rate on the bill.

**The one idea behind farming:** the person standing in the field reports *ground reality* — crop,
area, actual weight, a problem, a bill — and the system does everything else. Dates, the task
calendar, crop age, harvest windows, stock, cost per kg, profit, colour ratings, staff performance
and the next crop are all derived. A farm-grown crate becomes the same first-class batch a bought
crate does, so purchasing and farming share one stock ledger and one traceability trail.

---

## Quick start

**Requirements:** Node 20+, PostgreSQL 15+ (16 recommended).

```bash
# 1. Create the database
createdb chotug_erp
psql chotug_erp -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. Backend
cd server
cp ../.env.example .env          # then edit DATABASE_URL
npm install
npm run migrate                  # applies db/01_schema.sql + db/02_seed.sql
npm run seed                     # demo passwords, 90 days of sales, market prices, opening stock
npm run dev                      # http://localhost:4000

# 3. Frontend (a second terminal)
cd web
npm install
npm run dev                      # http://localhost:5173
```

Or with Docker:

```bash
docker compose up --build
docker compose exec api npm run migrate
docker compose exec api npm run seed
```

### Demo logins — password `chotug123`

| Email | Role | What they see |
|---|---|---|
| `owner@chotug.in` | Owner | Everything, plus audit and AI governance |
| `buyer@chotug.in` | Purchase Executive | Buy list, requirements, purchase orders |
| `manager@chotug.in` | Purchase Manager | Approvals, supplier scores |
| `gate@chotug.in` | Gate Executive | Arrivals, gate entry, weighment |
| `qc@chotug.in` | QC Executive | Quality checks |
| `wh@chotug.in` | Warehouse Executive | Goods receipts, put-away, stock, farm deliveries |
| `finance@chotug.in` | Finance Executive | Invoices, 3-way match, payment status |
| `farm@chotug.in` | Farm Manager | Crops, harvest, farm cost, crop planning |
| `field@chotug.in` | Farm Staff | **FARM TODAY only** — done / problem / skip |

Sign in as each one — the navigation genuinely changes, because permissions are checked on the
server and the menu is built from what came back.

---

## Try the whole flow in five minutes

1. **`buyer@chotug.in`** → *What to Buy*. Tomato, mango and spinach are seeded below reorder point,
   so they appear at the top in red. Change one quantity — it asks why. Tick a few and
   **Create requirement**, then **Submit**.
2. Same user → the requirement → **Compare sources & order**. Add rates, click ⚖️ on a line to
   compare landed cost across suppliers, add a transport and a commission charge, then
   **Save & submit**. If it's over ₹1,00,000 it goes for approval.
3. **`manager@chotug.in`** → *Approvals* → **Approve**. (Try approving as `buyer@` first — the
   server refuses, because the person who submitted cannot approve.)
4. Back as buyer → the PO → **Confirm with supplier**. An expected arrival is created.
5. **`gate@chotug.in`** → *Expected Arrivals* → **Record arrival**. Fill the vehicle and hygiene
   checklist → **Submit & lock**. Try editing it afterwards; the database refuses.
6. Same user → *Gate & Receiving* → the vehicle → **Weighment**. Enter a gross weight, then a tare,
   picking a crate type and count. Watch the net weight preview subtract the container tare, and
   the variance chip colour itself against the PO's expected weight.
7. **`qc@chotug.in`** → the vehicle → *Quality check* → **Inspect**. The sampling instruction is
   computed for you. Fill the checklist (set "Rot" to **Yes** to see a critical failure force a
   written reason). Save.
8. **`wh@chotug.in`** → the vehicle → *Post receipt* → **Post receipt to stock**. One transaction
   creates batches, labels, the stock ledger row, the balance, the put-away task and the PO
   progress. Then *Put-away* → confirm into a different bin and watch it demand a reason.
9. Open the receipt → **Compute landed cost**. Add hamali and transport. See the true cost per kg
   and how far it moved from the last purchase.
10. **`finance@chotug.in`** → *Capture invoice* for that supplier, then **Run 3-way match**.
    Deliberately bill more than was received and watch the debit note auto-draft.

---

## Try the farming flow in five minutes

The seed leaves three crops growing on ChotuG Farm-01 at different ages, a finished potato crop
from last season, and a hot-weather forecast.

1. **`field@chotug.in`** → this is a field worker, so the app opens on **FARM TODAY** and there is
   almost nothing else in the menu. Note the heat alert at the top: the system read the weather and
   decided, so nobody opens a second app. Each job has exactly three buttons.
2. Press **DONE** on an irrigation job. Now open *Crops* → that plot → *Calendar*: the next
   irrigation has already been scheduled. Nobody set a date.
3. Press **PROBLEM** on any job, pick *Pest*, add a photo. It becomes a task status, a crop-health
   observation and a manager alert in one action — and the crop turns 🔴 on every screen.
4. **`farm@chotug.in`** → *Farms & Plots* → open the QR link on Plot-A (`PLOT-FARM01-A`). This is
   what a worker's phone shows after scanning the gate: that plot's crop, today's job, last
   watering, last spray, next harvest. Wrong-plot entries mostly stop happening once this exists.
5. *Crops* → **Start a crop** on the free Plot-D. Choose a crop and an area and watch the right-hand
   panel fill in: harvest date, expected yield, expected cost, and how many irrigation, fertiliser,
   spray and inspection jobs are about to be created. Nothing is saved until you commit. Start it —
   a 30–60 job calendar is written in one transaction.
6. *Harvest* → pick Plot-C, enter a gross weight and a crate type. Watch the tare subtract itself.
   Split the weight across the four grades (they must add up to the net — try making them not).
   Record it: you get a crate label carrying farm, plot, crop age and harvest number.
7. *Farm → Warehouse* → **Send to warehouse**. Waste never travels; only sellable grades appear.
8. **`wh@chotug.in`** → *Farm → Warehouse* → **Weigh & receive**. Type a weight 8% short and try to
   save: the server refuses without a reason. Give one, and in a single transaction it creates
   batches, labels, a `TRANSFER_IN` ledger row and stock balances, and books the missing kilos as a
   loss against the crop. Retry the same request — the idempotency key returns the first result
   instead of doubling your stock.
9. Same user → *Stock & Batches*. The farm produce is there, alongside purchased stock, valued at
   what it cost to **grow**. It needed no new screen.
10. **`owner@chotug.in`** → *Farm Control*. Farm health in one colour, today's job count, the 7-day
    harvest forecast the warehouse can plan against, and cost per kg measured from finished crops.
    Then *Crop Planning* → **Buy vs grow**: the potato crop that finished last season cost ₹5.75/kg
    to grow against a ₹18 market — so it says keep growing, and shows its working.

---

## Configuring AI (all free options)

The system works completely without any AI key. Forecasts, buy quantities, sample sizes, anomaly
detection and supplier scores are all statistics computed from your own data. An LLM only adds the
written explanations and photo-assisted grading.

Set these in `server/.env`:

```bash
# Option A — nothing at all (default). Statistics only.
AI_PROVIDER=rules

# Option B — OpenRouter free lane
AI_PROVIDER=openrouter
AI_API_KEY=sk-or-v1-...
AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
AI_VISION_MODEL=qwen/qwen2.5-vl-72b-instruct:free

# Option C — Groq (very fast, generous free tier)
AI_PROVIDER=groq
AI_API_KEY=gsk_...
AI_MODEL=llama-3.3-70b-versatile

# Option D — Ollama, fully local, zero cost, no data leaves the building
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434/v1/chat/completions
AI_MODEL=llama3.1:8b
AI_VISION_MODEL=llama3.2-vision:11b
```

**Governance, which is not optional in this design:**

- Statistics always produce the number. The LLM explains it. If the model's own suggested quantity
  disagrees with the statistical one by more than 25%, the statistical number is kept and the
  disagreement is recorded with lowered confidence.
- Every call writes an `ai_runs` row: model, confidence, latency, whether it fell back, and later
  whether a human accepted or overrode it. That feedback loop is visible in the AI Centre and in
  the *AI acceptance* report.
- Photo-assisted grading below the configured confidence floor is shown but never pre-selected.
  The inspector confirms every value, and `inspector_changed` is stored as the training signal.
- If the model times out, rate-limits or returns unparseable output, the caller degrades to the
  statistical path. A warehouse at 5 a.m. cannot wait on someone's quota.

---

## Where things live

```
chotug-erp/
├── db/
│   ├── 01_schema.sql          the supplied schema, unmodified
│   ├── 02_seed.sql            company, branches, warehouse, bins, products, suppliers,
│   │                          QC templates, charge types, approval and alert rules
│   ├── 03_migration_fixes.sql repairs for databases built before the audit-trigger fix
│   ├── 04_farming.sql         farming schema — additive and idempotent, adds no
│   │                          breaking change to any existing table
│   ├── 05_farming_seed.sql    crop master (the agronomy), demo farm, plots, machines
│   ├── 06_stock_issue.sql     stock issues (the way stock leaves) + approve-within-
│   │                          your-own-authority
│   ├── 07_flow_fixes.sql      dead ends found by driving order → receive → store as
│   │                          each role rather than by reading the code
│   └── 08_fleet_masters.sql   vehicles and drivers you can add and remove; removal
│                              retires the row, it never deletes it
├── server/
│   └── src/
│       ├── db.ts              pool, tenancy GUCs, withTx
│       ├── domain/index.ts    every purchase formula, pure and testable
│       ├── domain/farming.ts   every farming formula — calendar, irrigation, colour,
│       │                       cost/kg, buy-vs-grow, staff score, next crop
│       ├── platform/          auth & RBAC, numbering, outbox, work queue, alerts, approvals
│       ├── ai/                provider gateway + the six AI features
│       ├── modules/           masters · planning · receiving · costing · insights ·
│       │                       farming · inventory
│       └── scripts/           migrate, seed
├── web/
│   └── src/
│       ├── styles.css         design tokens (indigo / amber / cyan — no green)
│       ├── lib/api.ts         fetch client, auth context, formatting
│       ├── components/ui.tsx  layout, table, chips, KPI, modal, toast, AI box
│       └── pages/             Home · Planning · Purchase · Receiving · Grn · Finance · Farming
└── docs/
    ├── UI_GUIDE.md            ← every page, every button, what each one does
    ├── ARCHITECTURE.md        why it is built this way
    └── API_REFERENCE.md       every endpoint
```

---

## Two deliberate deviations from the blueprint

**Raw SQL instead of Drizzle.** The blueprint specifies Drizzle ORM. With 96 tables carrying
generated columns, partial unique indexes, partitioned audit tables and row-level security, a
hand-written Drizzle schema would be a second source of truth that drifts from the first. `pg` with
parameterised SQL keeps the supplied schema authoritative — its constraints are the last line of
defence and this way nothing sits between them and the application. Every column reference in the
codebase was validated against `01_schema.sql`.

**Custom CSS instead of Tailwind.** The requirement was a UI where "the person immediately reaches
the thing he wants", on tablets in a warehouse. A small token system makes the colour language
enforceable — amber *always* means look at this, red *always* means stop — which is harder to hold
consistent across thousands of inline utility classes. The whole stylesheet is 12 KB.

---

## What is complete and what is not

**Complete and working end to end (farming):** farm and plot setup with per-plot QR codes; the crop
master that makes the calendar automatic; one-minute crop start with a full preview and an
auto-generated 30–60 job calendar; FARM TODAY with done/problem/skip and no forms; weather-driven
irrigation holds, spray avoidance and heat/frost alerts; automatic next-due dates; three-colour
crop health with manager alerts; the photo crop diary; harvest-ready countdown; harvest with crate
tare, four grades and printable labels; farm→warehouse dispatch with the two-sided weight check
and forced variance reasons; produce entering the existing stock ledger as ordinary batches; farm
expenses in three fields; automatic cost per kg; expected-vs-actual yield; loss recording with
system-valued quantities; computed staff performance; machine status; day close; the 7-day harvest
forecast; demand-based crop planning; buy-vs-grow; next-crop suggestions; seed-to-sale
traceability; and the owner dashboard.

**Complete and working end to end (purchase):** authentication and RBAC with role limits; the requirement
note with statistical planning; requirements; source comparison on landed cost; purchase orders
with the approval engine, maker–checker and revisions; gate entry with locking and exception
handling; append-only weighment with tare and variance bands; template-driven QC with weighted
scoring, sampling rules and critical-failure handling; the atomic GRN posting with batches, labels,
stock ledger, balances and put-away tasks; landed cost allocation with abnormal-jump detection;
invoice capture, 3-way match and auto-drafted debit notes; payment status (read-only); supplier
scoring; the work queue; alerts; seven reports with CSV export; and all six AI features with
statistical fallbacks.

**Farming, scaffolded rather than finished:** the smart-scale integration records `capture_mode`
and accepts a scale-written weight, but no serial/TCP driver is written; crop photos are stored as
data URIs on the row rather than in object storage, which is fine for a diary and wrong for
volume; `farm_staff_scores` exists as a table but performance is computed on demand rather than
snapshotted per period; revenue per crop is entered when a crop is closed rather than flowing back
automatically from sales, because this repository has no sales module to flow from; and the daily
pass runs when someone opens FARM TODAY rather than on a scheduler (deliberate — see
ARCHITECTURE.md — but a cron calling `POST /farming/farms/:id/refresh` is the production shape).

**Scaffolded, needs work before production:** OCR for invoice capture (the form is manual);
weighbridge serial/TCP integration (capture mode is recorded, the driver is not written); label
printing to a physical printer (payloads are generated, the ZPL/TSPL emitter is not); the outbox
publisher process (events are written transactionally, nothing drains the table yet); WhatsApp and
SMS alert channels (only in-app); Hindi translation strings (the schema and masters carry
`name_hi`, the UI chrome is English); and background jobs — supplier scoring and matview refresh
are on-demand endpoints rather than scheduled.

**Before you go live:** change `JWT_SECRET`, force a password change on every seeded user, put TLS
in front of the API, set `AI_PROVIDER` deliberately, and run the seed's opening-stock step only
once.
