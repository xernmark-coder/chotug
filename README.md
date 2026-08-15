# ChotuG ERP — Purchase & Receiving Module

A production-shaped implementation of the ChotuG Purchase Module: React + Express + PostgreSQL,
built directly on the supplied 96-table schema, with free-model AI for forecasting, buy
suggestions, price signals and photo-assisted quality checks.

**The one idea behind the whole thing:** every kilogram that enters the business must be
evidence-backed — a gate entry, a weighment, a quality check and a goods receipt — and what the
produce *costs* is its landed cost, never the rate on the bill.

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
| `wh@chotug.in` | Warehouse Executive | Goods receipts, put-away, stock |
| `finance@chotug.in` | Finance Executive | Invoices, 3-way match, payment status |

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
│   └── 02_seed.sql            company, branches, warehouse, bins, products, suppliers,
│                              QC templates, charge types, approval and alert rules
├── server/
│   └── src/
│       ├── db.ts              pool, tenancy GUCs, withTx
│       ├── domain/index.ts    every formula, pure and testable
│       ├── platform/          auth & RBAC, numbering, outbox, work queue, alerts, approvals
│       ├── ai/                provider gateway + the six AI features
│       ├── modules/           masters · planning · receiving · costing · insights
│       └── scripts/           migrate, seed
├── web/
│   └── src/
│       ├── styles.css         design tokens (indigo / amber / cyan — no green)
│       ├── lib/api.ts         fetch client, auth context, formatting
│       ├── components/ui.tsx  layout, table, chips, KPI, modal, toast, AI box
│       └── pages/             Home · Planning · Purchase · Receiving · Grn · Finance
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

**Complete and working end to end:** authentication and RBAC with role limits; the requirement
note with statistical planning; requirements; source comparison on landed cost; purchase orders
with the approval engine, maker–checker and revisions; gate entry with locking and exception
handling; append-only weighment with tare and variance bands; template-driven QC with weighted
scoring, sampling rules and critical-failure handling; the atomic GRN posting with batches, labels,
stock ledger, balances and put-away tasks; landed cost allocation with abnormal-jump detection;
invoice capture, 3-way match and auto-drafted debit notes; payment status (read-only); supplier
scoring; the work queue; alerts; seven reports with CSV export; and all six AI features with
statistical fallbacks.

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
