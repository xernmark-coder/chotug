# ChotuG ERP — Purchase Module
## Screen-by-screen guide: what you see, every button, and what it actually does

This is the companion document to the application. For every page it lists:

- **What is on the screen** — the data shown and where it comes from
- **Buttons and controls** — every one of them
- **What happens** — the API called, the permission needed, and the real business effect

Conventions used throughout:

| Convention | Meaning |
|---|---|
| **Colour** | Indigo = primary action · Amber = needs attention · Red = stop / danger · Cyan = done, healthy. No green anywhere. |
| **Max 3 primary buttons** | Every screen has at most three prominent actions. Everything else is quiet. |
| **Prefilled + read-only** | Anything the system can already know is filled in and locked, with an explicit *Edit* that asks for a reason. |
| **Exceptions rise** | Anything overdue, rejected or out of tolerance sorts to the top of a list and gets a coloured left bar. |
| **Server decides** | Hiding a button is a convenience. Every action is re-checked on the server against your permissions. |

---

# 0. Sign in

**Route:** `/login`

### What is on the screen
- The ChotuG mark and the words "Purchase & Receiving".
- Two fields: **Email or phone**, **Password**.
- A list of seven demo logins with their role, under the heading "Demo logins — password `chotug123`".

### Buttons and controls

| Control | What it does |
|---|---|
| **Sign in** | `POST /api/auth/login`. On success stores a JWT and loads your profile, permissions, branches and approval limits, then goes to **My Work**. On failure shows *"Email or password is not correct"* without revealing which was wrong. After 5 failed attempts the account locks for 15 minutes. |
| Any demo-login row | Fills the email field with that address. A convenience for the demo, nothing more. |

### What you should know
Your role is loaded at sign-in and decides which menu items exist at all. A gate executive genuinely does not see the Approvals or Payments pages.

---

# 1. My Work — the home screen

**Route:** `/` · **Everyone**

This is the single most important screen in the system. It answers "what should I do next?" without the person having to know which module their work lives in.

### What is on the screen
- A greeting with your first name and the time of day.
- A count: *"7 things waiting for you"*.
- If anything is late: a red banner — *"3 tasks are past the agreed time. They are at the top of the list."*
- **Your queue** — one table, filtered by the server to only tasks your permissions let you act on:

| Column | What it shows |
|---|---|
| What | The kind of task: Requirement, Approval, Arrival, Weighment, Quality check, Goods receipt, Put-away, Invoice, Alert |
| Task | The headline, e.g. *"Weigh vehicle MH12AB1234"*, with a sub-line giving context |
| Document | The document number (GT/2026-27/000014) |
| Where | Branch or warehouse |
| Waiting | Age, or a red **Overdue** chip if the agreed time has passed |

Rows are sorted: overdue first, then critical, then warn, then oldest first.

### Buttons and controls

| Control | What it does |
|---|---|
| **Refresh** | Re-reads `GET /api/insights/work-queue`. The page also refreshes itself every 60 seconds. |
| Clicking any row / **Open →** | Jumps straight to the exact screen where that task is done — a weighment task opens that vehicle's gate record on the weighment tab; an approval opens the approvals queue; a put-away task opens the put-away list. |

### What you should know
Tasks appear here automatically the moment a document becomes someone else's problem, and disappear the moment it's dealt with. Nobody has to remember to hand work over.

---

# 2. Dashboard

**Route:** `/dashboard` · **Everyone** (money figures need `data.cost.view` or `reports.purchase.view`)

### What is on the screen

**Row 1 — operational KPIs (always shown).** Each is clickable.

| Card | Meaning | Turns amber/red when |
|---|---|---|
| Needs approval | Pending approvals count | Anything overdue |
| Arriving today | Expected vehicles due today or earlier | — |
| At the gate | Vehicles inside the receiving chain, split into "to weigh · QC · to post" | Anything waiting for QC |
| Open alerts | High and critical alerts still open | Any open alert |

**Row 2 — money KPIs (only if you may see cost).**
Purchased today · Purchased this month · Outstanding payable (amber if any overdue) · Rejection rate over 30 days (red above 8%, amber above 4%).

**Main column**
- **Purchases, last 30 days** — a bar chart of daily posted receipt value.
- **Suppliers by value, last 30 days** — supplier, type, receipt count, performance score chip, value.

**Side column**
- **Running low** — up to 12 products at or below reorder point, with current stock, the reorder point beneath it, and a days-of-cover chip (red under 1 day).
- **Pipeline** — a plain list of counts: open requirements, draft/submitted POs, waiting to weigh, waiting for QC, waiting for receipt, waiting for put-away, invoices to match.

### Buttons and controls

| Control | What it does |
|---|---|
| Any KPI card | Navigates to the list behind that number. No number is a dead end. |
| **Buy list →** | Goes to *What to Buy*. |
| **All suppliers →** | Goes to the Suppliers page. |
| Any "Running low" row | Goes to *What to Buy*. |
| Branch selector (top bar) | Re-scopes every figure on the page to that branch. |

---

# 3. What to Buy — the automatic buy list

**Route:** `/buy-list` · Needs `purchase.requirement.create`

This is section 2 of the specification made real: *the system tells you what to buy and how much, you don't have to work it out.*

### What is on the screen
- A blue explainer: the quantities come from your own stock, the last 28 days of sales, open purchase orders, lead time and expected wastage.
- A filter: **Only show products that need ordering** (on by default).
- One row per product:

| Column | What it shows |
|---|---|
| ☐ | Select this product for the requirement |
| Product | Name, Hindi name, SKU |
| Why | Chips for each trigger: *low stock*, *min max*, *advance order*, *sales demand* |
| Stock | Current stock, and underneath either "+250 on order" or "nothing on order" |
| Sells/day | 28-day average daily sale |
| Cover | Days of cover — red under 1 day, amber under the lead time |
| Suggested | The system's recommended quantity |
| Order qty | An editable box, pre-filled with the suggestion |
| Last rate | The rate on the most recent order for that product |
| ✨ | Opens the forecast and price detail |

Urgent rows are red-barred and sort to the top.

### How the suggested quantity is calculated
```
demand over (lead time + review period)
  + statistical safety stock (service-level z × demand variability × √horizon)
  + advance customer orders
  ÷ (1 − expected wastage %)          ← buy the gross, sell the net
  − stock already available − in-transit − open purchase orders
  then lifted to MOQ, rounded to the order multiple, capped at max stock
```

### Buttons and controls

| Control | What it does |
|---|---|
| **Recalculate** | Re-runs `GET /api/planning/requirement-note`. Use it after a delivery is posted. |
| **Select all suggested** | Ticks every product with a suggestion above zero. |
| Editing **Order qty** | If your number differs from the suggestion, a reason dialog opens immediately. The row shows ⚠️ until a reason is given, 📝 once it has one. |
| Reason dialog → **Use suggested N** | Discards your edit and restores the suggested figure. |
| Reason dialog → **Save reason** | Records why you disagreed. Choices include festival demand, supplier stock limited, price good today, price too high, storage limited, quality issues expected, known upcoming order. |
| **✨** on a row | Opens the forecast panel (see below). |
| **Create requirement (n)** | `POST /api/planning/requirements`. Refuses if any edited quantity has no reason. Creates the requirement, records the suggested-vs-final quantity and your reason on every line, warns about duplicate open requirements for the same product, writes the accept/override signal back against the AI run, then opens the new requirement. |

### The ✨ forecast panel
- **Buy suggestion** — the number, a written explanation, the single biggest risk, a confidence percentage, and the working shown as a list (demand, safety stock, already covered, wastage gross-up).
- **Expected demand, next 7 days** — a chart with a p10–p90 band around the p50 line, and the model name.
- **Mandi price** — a 30-day price line, a RISING / FALLING / STABLE chip with the 7-day change, and one line of buying advice.

If no AI model is configured, the number and the chart still appear — they are computed from your own data. Only the written sentences disappear, and the panel says so.

---

# 4. Requirements

## 4.1 Requirement list
**Route:** `/requirements`

Shows: number, needed-by date, branch, priority chip, source, product count, total quantity, status chip, who raised it. Urgent rows are red-barred.

| Control | What it does |
|---|---|
| Status filter | Filters to DRAFT / SUBMITTED / APPROVED / CONVERTED / CLOSED / CANCELLED |
| **New from buy list** | Goes to *What to Buy* |
| Any row | Opens the requirement |

## 4.2 Requirement detail
**Route:** `/requirements/:id`

Shows the header (branch, needed-by, status) and every line: product, stock at the time it was raised, suggested quantity, ordered quantity, your change reason, how much has been converted to a PO, and the line status. If any product already had an open requirement, an amber banner warns about ordering twice.

| Button | Permission | What it does |
|---|---|---|
| **Submit** | `purchase.requirement.submit` | `POST /planning/requirements/:id/submit`. Moves DRAFT → SUBMITTED and pushes a *"ready to source"* task to whoever can compare quotes. |
| **Compare sources & order** | `purchase.po.create` | Opens the PO creation screen pre-loaded with the outstanding quantities from this requirement. |

---

# 5. Purchase orders

## 5.1 PO list
**Route:** `/purchase-orders`

Shows: number (with revision), order date, supplier and source type, expected date, value, a receive-progress bar, and status chips including *awaiting approval* and *urgent*.

| Control | What it does |
|---|---|
| Status filter | Narrows the list |
| **New order** | Opens PO creation |
| Any row | Opens the PO |

## 5.2 Create a purchase order
**Route:** `/purchase-orders/new` · Needs `purchase.po.create`

A four-step strip across the top: Choose source → Add products → Charges → Submit.

**Section 1 — Source.** Supplier dropdown (blocked suppliers are not listed, and the server refuses them anyway), expected delivery date, and once a supplier is chosen a row of facts: status, source type, credit terms or "cash / immediate", commission % for an aadhti, trust score. A checkbox marks the order **urgent**, which the approval engine treats as a trigger.

**Section 2 — Products.** Add from a dropdown; each line has quantity, rate, expected kg, line total, and two quiet buttons: ⚖️ compare sources and ✕ remove.

> When you leave the rate box, the system quietly checks it against the last 90 days of purchases for that product using a robust (median/MAD) test. If it's unusual you get an amber line: *"This rate is unusual — recent purchases have been around ₹22.40. Confirm before submitting."* It never blocks you.

**Section 3 — Charges.** Add commission, transport, hamali, mandi fee, packing, toll, weighbridge fee. Each shows how it will be spread (by value, weight, quantity, or equally). The text explains why this matters: leave them out and the margin you see later is wrong.

**Side panel — Order summary.** Product count, goods value, charges, order total in large type. If the total exceeds your own approval limit, an amber note says so and tells you it will go to a higher approver.

| Button | What it does |
|---|---|
| **⚖️** on a line | Opens *Compare sources* (below) |
| **Save & submit** | Creates the PO, then submits it. The approval engine evaluates value, rate variance vs last purchase, new-supplier and urgent triggers. If nothing fires, the order self-approves and the audit trail records that. Otherwise you're told: *"Sent for level 2 approval (VALUE, NEW_SUPPLIER)."* |
| **Save as draft** | Creates the PO in DRAFT. Nothing is sent anywhere. |

### Compare sources (the ⚖️ dialog)
Enter each supplier's rate, commission, transport and loading. **Compare landed cost** calls `POST /planning/quotes`, which for every quote computes:

```
landed = (rate + charges per kg)
         ÷ (1 − expected rejection% − expected shortage%)   ← from that supplier's own history
         − value of the credit period they offer
```

You get a recommendation in plain words — *"Ramesh Aadhti has a higher headline rate than Market Yard but a lower landed cost of ₹24.80/unit after charges, rejection and credit"* — and a ranked table showing quoted rate, landed rate, their rejection %, their on-time %, and a **new supplier** chip where relevant. **Use this** copies the supplier and rate back into the order.

## 5.3 PO detail
**Route:** `/purchase-orders/:id`

A progress strip: Draft → Submitted → Approved → Confirmed → Receiving → Received. If approval is pending, an amber banner names the level and the triggers.

Shows lines (ordered, rate, received, accepted, rejected, total, line status), charges, revision history with old→new values and the reason, and an approvals panel showing who asked, who decided, when, and why.

| Button | Permission | What it does |
|---|---|---|
| **Submit** | `purchase.po.submit` | Sends for approval, or auto-approves if within authority |
| **Confirm with supplier** | `purchase.po.submit` | Moves APPROVED → CONFIRMED, creates an **expected arrival** and pushes a task to the gate team. This is what makes the truck appear on the gate's radar. |
| **Revise** | `purchase.po.revise` | Opens the revision dialog |

### Revise dialog
Amber warning that a revision reopens approval and is recorded with old and new values. A table of lines showing how much has already been received (you cannot reduce below that — the server refuses). A mandatory free-text reason. **Save revision** writes a diff into the revision history and re-runs the approval rules.

## 5.4 Approvals
**Route:** `/approvals` · Needs an approve permission

One table of everything waiting on you: document number and type, *why* chips (value, rate variance, new supplier, urgent…), value, supplier, level chip, who raised it and how long ago, and the due time. Overdue rows are red-barred and sort first.

Exactly three actions per row, as the specification requires — nothing else:

| Button | What it does |
|---|---|
| **Approve** | Opens a confirm dialog with the facts and an optional note. On confirm: the approval is decided; when no approvals remain pending the PO moves to APPROVED. **The server refuses if you raised the request yourself, if the level is above your limit, or if the value is above your PO limit** — with a message that says which. |
| **Hold** | Same dialog, but the reason is **required**. The document stays where it is with your reason attached. |
| **Reject** | Reason required. A rejected PO goes back to DRAFT so the buyer can fix it. |

---

# 6. Receiving — the chain that cannot be skipped

The order is fixed: **Gate entry → Weighment → Quality check → Goods receipt → Put-away.** Stock cannot enter without a gate entry, because the database itself requires one on every receipt.

## 6.1 Expected arrivals
**Route:** `/arrivals`

Vehicles you're waiting for: expected date (with a red **not arrived** chip if overdue), PO number, supplier, warehouse, vehicle hint, product count, value.

| Button | What it does |
|---|---|
| **Vehicle at gate** | Opens a blank gate entry |
| Any row / **Record arrival** | Opens the gate entry pre-filled with that PO, supplier and vehicle hint |

## 6.2 Gate & receiving pipeline
**Route:** `/gate` · Touch-optimised (48px targets, larger type)

Every vehicle currently inside the chain: vehicle number in large mono type, gate number, supplier and PO (or a **no order** chip), stage chip, a plain-English **next step** ("Weigh in", "Quality check", "Post receipt"), what has been weighed, QC count, minutes waiting (red past 3 hours), and flags for **hygiene fail** or **unplanned**.

| Button | What it does |
|---|---|
| **Refresh** | Reloads the pipeline |
| **Vehicle at gate** | New gate entry |
| Any row | Opens that vehicle's record |

## 6.3 Gate entry
**Route:** `/gate/new` · Needs `receiving.gate.create` · Touch-optimised

Four numbered sections.

**1 · Which delivery is this?** A dropdown of expected arrivals, or *"— No purchase order (unplanned) —"*.

> Choosing unplanned shows an amber warning that this is an exception needing a reason and a supervisor's approval, and reveals a supplier picker and a reason box. If you don't hold `receiving.exception.approve`, a red panel says: *"You cannot approve an unplanned arrival. Call a manager to the gate — what you type here is kept."* The database itself will not accept an unplanned arrival without both a reason and an approver.

**2 · Vehicle & driver.** Vehicle number in large mono type (auto-uppercased, spaces stripped); typing a known number auto-links the vehicle master. If the vehicle's fitness, insurance or PUC has expired, an amber panel names which — *you can still receive the goods, but it is recorded and an alert is raised.* Driver picker plus editable name.

**3 · Documents.** E-way bill, supplier invoice/bill number, mandi patti number, seal number, and a "seal was intact" checkbox.

**4 · Vehicle hygiene check.** Six FSSAI-aligned checks. Two are marked **critical** — overall hygiene and no chemical/non-food cargo. Failing either raises a CRITICAL alert and shows a stop banner on the vehicle's record.

| Button | What it does |
|---|---|
| **Submit & lock** | Creates the gate entry and immediately locks it. From that moment the database rejects edits to everything except lifecycle timings. Pushes a *weigh this vehicle* task with a 45-minute target. |
| **Save without locking** | Creates it in an editable state. Weighment cannot start until it's locked — the vehicle record will say so. |

## 6.4 Vehicle record
**Route:** `/gate/:id` · Touch-optimised

A five-step strip (At gate → Weighed → Quality check → QC done → Received), a red banner if hygiene failed critically, an amber banner if the entry isn't locked yet, and three tabs. The right tab opens automatically based on where the vehicle actually is.

### Tab 1 — Weighment

**Weighments taken** lists every reading, append-only: sequence, type, gross, tare, containers (`40 × 1.85`), net, expected, variance chip coloured GREEN/AMBER/RED/CRITICAL, capture mode, and who weighed. **A re-weigh is a new row — earlier readings are never erased.**

**Record weight** panel:

| Control | What it does |
|---|---|
| Which weight is this? | Loaded (gross) / Empty (tare) / Re-weighment. Auto-selects the next logical one. |
| Why re-weigh? | Appears for re-weighments; **required** |
| Gross / Empty weight | Large bold number inputs |
| Crate / bag type | Container master with its tare — *this is what stops inflated weights* |
| How many crates / bags? | Multiplied by the container tare and subtracted |
| How was this weight taken? | Typed from the display, or read directly from the weighbridge (recorded as provenance) |
| Live preview | *"Net weight will be 8,412.5 kg — after 40 × 1.85 kg container tare"* |
| **Record weight** | Saves the reading. Net = gross − vehicle tare − (crates × tare) − packing. Computes variance against the PO's expected weight. |

What happens on a variance:
- Within tolerance → GREEN, nothing else happens.
- Beyond tolerance → an alert is raised.
- RED or CRITICAL → an approval request is raised, **and quality check is blocked until it is cleared**.
- If you don't hold `receiving.weighment.approve`, a breach on the closing weight is refused outright with the numbers spelled out: *"Net weight 8,412 kg is −7.2% away from the expected 9,065 kg… A supervisor must approve this weight before it can be saved."*

When both halves of the cycle exist, the vehicle moves to QC_PENDING and a quality-check task appears for the QC team.

### Tab 2 — Quality check

**Products to inspect** lists the PO lines with an *inspected* / *pending* chip and an **Inspect** button.

**The inspection dialog** (per product):
- A blue banner with the sampling instruction, computed live: *"Inspect 21 unit(s) from a lot of 420 — doubled because this is a new supplier"*. Sample size uses the √ rule, doubled for new suppliers and for suppliers with a high recent rejection rate.
- **📷 Take photos and let AI pre-fill** — opens the camera. Up to three photos go to a vision model, which fills in the AI-assisted parameters. Every filled field gets an indigo **AI filled — confirm** chip. The confidence is shown. Below a configured confidence floor, the AI grade is discarded and only the raw suggestions are shown. **The inspector confirms every value; whether they changed it is stored as the training signal.**
- The parameter checklist, driven by the product's QC template — not a fixed form. Boolean parameters render as **No / Yes** buttons (Yes = the bad thing is present, so it turns red). Select parameters render as one button per option. Numeric and percent parameters show the acceptable range as placeholder text. Critical parameters carry a red **critical** chip.
- **Decision**: received, rejected, on hold, accepted (calculated), grade given, and — when anything is rejected — a multi-select of rejection reasons (rot, overripe, damage, undersize, foreign matter, wet, pest, wrong variety, temperature abuse).

| Button | What it does |
|---|---|
| **Save inspection** | Scores the checklist with the template's weights, records every answer with its pass/fail and whether the inspector changed an AI value, writes the disposition, raises a rejection alert if anything was rejected, and — when all products are inspected — moves the vehicle to QC_COMPLETE and pushes the goods-receipt task. |

**Critical failure handling.** If a critical parameter fails and you still accept quantity, the button stays disabled until you write a reason, and saving raises a QC-override approval for the QC head. The system will not let a critical failure pass silently.

### Tab 3 — Post receipt

A table pre-filled from the weighment and inspections: product, received, accepted, rejected, net kg, rate, grade, how many crate labels to print, and line value. All editable. Total value entering stock is shown in large type.

| Button | Permission | What it does |
|---|---|---|
| **Post receipt to stock** | `receiving.grn.submit` | The single most important transaction in the system. |

**What "Post receipt to stock" does — all in one database transaction, all or nothing:**

1. Checks an idempotency key, so a retried tap on a bad 4G connection can never post stock twice.
2. Refuses if quality check isn't complete, unless you hold the exception permission.
3. Checks your back-dating limit if the posting date isn't today.
4. Creates the GRN header and lines.
5. For each accepted quantity: creates a **batch** with an expiry date derived from shelf life; prints a **lot label** and the requested number of **crate labels** (variable-weight products carry their real weight per crate).
6. Writes the **stock ledger** IN row and updates **stock balances**.
7. Suggests a bin by storage type and free capacity, and creates a **put-away task**.
8. Updates the PO line's received/accepted/rejected quantities and line status; moves the PO to PART_RECEIVED or RECEIVED.
9. Closes the gate entry and stamps the gate-out time.
10. Writes a `grn.posted` event to the outbox so Pricing and Accounts hear about it — in the same transaction, so a committed receipt can never fail to notify them.

If the same receipt is somehow submitted twice, the database's unique constraint stops it and you get *"This receipt has already been posted to inventory. Nothing was posted twice."*

## 6.5 Goods receipts
**Route:** `/grns` and `/grns/:id`

The list shows number, posting date, supplier, vehicle and gate, PO, accepted, rejected (bold red), net kg, value, a **landed cost computed / pending** chip, and status.

The detail page shows every line with its batch number and expiry, quantities, rate, grade, QC score and value; plus the landed cost block once computed.

| Button | Permission | What it does |
|---|---|---|
| **Compute landed cost** | `costing.landing.recompute` | Opens the landed-cost dialog |
| **Reverse** | `receiving.grn.reverse` | Opens the reversal dialog |

### Landed cost dialog
Explains the rule: *transport is spread by weight, commission by value — so a heavy cheap crate does not subsidise a light expensive one.* Add any charge that came with the load; charges already on the PO are included automatically.

**Compute** produces, per product: base rate, allocated charges, wastage provision, landed rate per unit, landed rate per kg, and the change against the last landed rate for that product. A change beyond the configured threshold (default 15%) turns the row red, sets an **abnormal movement** flag, raises a CRITICAL alert, and puts a red banner on the receipt: *"The landed cost moved sharply on this receipt. Check selling prices before this stock goes out."* Computing an ACTUAL cost also writes the landed rate onto the batches and emits `landing_cost.updated` for the Pricing module.

### Reverse dialog
Red warning: this removes the stock again and reopens the PO lines, only works if the stock hasn't already moved out, and the original receipt stays in the records. A reason of at least six characters is required. **Reverse receipt** writes reversal rows to the stock ledger (it does not delete anything), restores the PO line quantities, marks the batches written-off, and raises a HIGH alert.

## 6.6 Put-away
**Route:** `/putaway` · Needs `receiving.putaway.confirm` · Touch-optimised

Tasks waiting: product and storage type, batch with expiry, quantity and weight, rotation rule chip (FEFO/FIFO), and the suggested location as `ZONE/RACK/BIN`. Sorted by earliest expiry, because that is what FEFO means.

| Button | What it does |
|---|---|
| Any row / **Confirm** | Opens the confirmation dialog |
| Dialog: **Which bin did you actually use?** | Lists bins with storage type and current fill vs capacity |
| Dialog: **Why a different bin?** | Appears **only** if you picked something other than the suggestion, and is then required |
| **Confirm put-away** | Marks the task done, updates the bin's fill weight, and stamps the bin onto the stock ledger row so the stock's physical location is now known. |

## 6.7 Stock & batches
**Route:** `/stock`

Every batch on hand: product, batch number, grade, quantity, available (quantity minus reserved), weight, expiry with a **days left** chip (red at 1 day, amber at 3), landed rate, status. Sorted by soonest expiry.

| Control | What it does |
|---|---|
| Trace box + **Trace** | Scan or type any label code. Opens a full one-up traceability card: product, batch, grade, received and expiry dates, quantity remaining, supplier and source type, **farm name and village where known**, the goods receipt, and the vehicle and gate entry it arrived on. |

---

# 7. Money

## 7.1 Invoices
**Route:** `/invoices`

Number (with a red **possible duplicate** chip), date, supplier, PO, total, match result chip, balance, status. Duplicates and holds are red-barred.

| Button | What it does |
|---|---|
| Status filter | Narrows the list |
| **Capture invoice** | Opens the capture form |
| Any row | Opens the invoice |

## 7.2 Capture invoice
**Route:** `/invoices/new` · Needs `finance.invoice.create`

Header: supplier, invoice number, invoice date, due date, and a **reverse charge** checkbox for unregistered suppliers. Then the lines exactly as printed on the paper: description, quantity, rate, amount (rate × quantity auto-fills the amount, but you can override it to match what the supplier actually printed).

| Button | What it does |
|---|---|
| **Add line** | Adds a blank row |
| **Capture invoice** | Saves it. Immediately checks for duplicates — same supplier with the same invoice number, or the same date and amount — and warns you if found. Checks whether the line amounts actually add up to the stated subtotal. Pushes an *invoice to match* task to Finance. |

## 7.3 Invoice detail and 3-way match
**Route:** `/invoices/:id`

Red banner if it looks like a duplicate. Amber banner if the arithmetic on the invoice itself doesn't add up.

**Invoice lines vs what we received** — billed quantity beside received quantity, billed rate beside PO rate, and amount. Any line with no matching goods receipt is red-barred with a **no receipt** chip.

| Button | Permission | What it does |
|---|---|---|
| **Run 3-way match** | `finance.invoice.match` | Compares invoice against goods receipt (quantity) and purchase order (rate), using the company's tolerance profile. |

**What the match produces:** four verdict chips (QTY, RATE, TAX, CHARGE) and a findings table listing every problem in plain words — *"Billed quantity is 6.4% away from what was received"* — with the expected and actual values.

**What happens next, automatically:**

| Outcome | Result |
|---|---|
| Everything within tolerance | Status → MATCHED, then **PAYABLE**, and a payable record is created. The invoice-match task is cleared. |
| Outside tolerance | Status → MISMATCH. A HIGH alert is raised and an approval request goes to Finance. |
| Beyond the critical threshold | Status → **HOLD** with the failures recorded as the hold reason. It cannot become payable. |
| Billed more than received | A **debit note is auto-drafted** for the difference, so the money is actually recovered rather than forgotten. It appears in the Credit / debit notes panel with an **auto-drafted** chip. |

## 7.4 Payment status
**Route:** `/payments` · Needs `finance.payment.view`

Read-only by design — *this module never pays anyone.* Shows invoice, supplier, invoice date, due date, payable, paid, balance, an overdue chip, and a **blocked** chip. Overdue beyond 7 days is red-barred. Filters: everything / balance outstanding / overdue only.

## 7.5 Suppliers
**Route:** `/suppliers`

An explainer of how the scores work, then: supplier and code, type, status, performance score chip, trust score chip, on-time %, rejection %, weight variance %, receipts and value over 90 days. Blocked suppliers are red-barred; on-hold or high-rejection suppliers are amber.

- **Performance** = on-time 25% + fill rate 20% + (100 − rejection×4) 25% + quality score 30%
- **Trust** = weight-variance honesty 40% + document compliance 25% + rejection 20% + performance 15%
- Both are pulled towards 50 when a supplier has few orders, so one lucky delivery doesn't look like excellence.

| Button | What it does |
|---|---|
| **Recompute scores** | Recalculates every supplier from the last 90 days of receipts, quality inspections and weighments, and writes both the period record and the supplier's current scores. |

---

# 8. Insight

## 8.1 Alerts
**Route:** `/alerts`

Severity chip, title with the detail beneath, alert type, age, status. Critical rows red-barred.

Alerts the system raises on its own: low stock, PO approval pending, arrival missed, weight variance, QC rejection, GRN pending, invoice mismatch, duplicate invoice, abnormal landed cost, put-away pending, vehicle compliance, hygiene failure, GRN reversed.

| Button | What it does |
|---|---|
| **Acknowledge** | Marks it seen, with your name and the time |
| **Resolve** | Marks it dealt with |
| Status filter | OPEN / ACK / RESOLVED |

Alerts deduplicate on a 60-minute window so one stuck document cannot flood the panel.

## 8.2 Reports
**Route:** `/reports` · Needs `reports.purchase.view`

Seven report cards; clicking one loads it. A from/to date range and a row count.

| Report | What it answers |
|---|---|
| Purchase register | Every line received, with rate and landed cost |
| Quality & rejection | What was rejected, why, and by whom |
| Weight variance | Where the weighbridge disagreed with the order — sorted by worst |
| Landed cost analysis | True cost per kg and how it moved |
| Pending purchase orders | Ordered but not received, sorted by most overdue |
| Stock position | On-hand by batch with expiry risk |
| AI acceptance | How often people take the AI suggestion vs override it |

| Button | Permission | What it does |
|---|---|---|
| **Download CSV** | `data.export` | Downloads the current report as a properly escaped CSV. The button is absent for roles without export rights — and the server enforces it too. |

## 8.3 AI centre
**Route:** `/ai`

**Ask about your purchases** — type a question in plain language. The answer is built only from data your own permissions allow, so if your role cannot see cost, the assistant cannot tell you a cost. Answers show a confidence figure.

**Recent AI runs** — feature, model, confidence, whether a person **accepted** or **overridden** it, a *statistics only* chip when no model was used, latency, and age. This is the honesty ledger for the AI programme.

**Features panel** — a toggle per feature: demand forecast, buy suggestion, price signal, quality photo assist, anomaly detection, assistant. Each shows its fallback mode and confidence floor. Toggling needs `ai.feature.manage`.

A closing note: *with no model configured, forecasting and buy suggestions still work from your own sales history — only the written explanations disappear.*

## 8.4 Settings
**Route:** `/settings` · Needs `admin.settings.manage`

Each threshold with a plain-English label and its technical key underneath: weight tolerance %, rate tolerance %, quantity tolerance %, financial year, forecast horizon, service level factor (1.65 ≈ 95% availability), allow AI to place orders automatically, landed-cost jump % that raises an alert. A **Save** button appears on a field only once you change it.

## 8.5 Profile
**Route:** `/profile`

Your roles, employee code, branches, PO approval limit, approval level, back-dating allowance, and the full list of your permission codes as chips. Useful when someone asks "why can't I do this?" — the answer is on this page.

---

# 9. Navigation map

The left sidebar groups pages by the job being done, not by database module:

```
Work        My Work · Dashboard · Alerts
Plan & Buy  What to Buy · Requirements · Purchase Orders · Approvals
Receive     Expected Arrivals · Gate & Receiving · Goods Receipts · Put-away · Stock & Batches
Money       Invoices & Match · Payment Status · Suppliers
Insight     Reports · AI Centre · Settings
```

Menu items you have no permission for are not rendered at all. A gate executive sees five items; the owner sees all seventeen. **My Work** carries a badge with your open task count; **Alerts** carries a red badge with the critical count.

---

# 10. What each role sees on sign-in

| Role | Lands on | Their day |
|---|---|---|
| **Purchase Executive** | My Work | Buy list → requirement → compare sources → PO → submit |
| **Purchase Manager** | My Work (approvals at the top) | Approve / hold / reject, watch supplier scores and rate anomalies |
| **Gate Executive** | My Work (arrivals) | Record vehicle → checklist → submit & lock → weigh |
| **QC Executive** | My Work (QC pending) | Open vehicle → photo assist → checklist → accept / reject / hold |
| **Warehouse Executive** | My Work (GRN + put-away) | Post receipt → labels → put away by FEFO |
| **Finance Executive** | My Work (invoices) | Capture invoice → 3-way match → payable, or hold and debit note |
| **Owner** | Dashboard | Everything, plus the audit trail and AI governance |

---

# Farming

Two audiences, deliberately different interfaces.

**The field** — FARM TODAY, the plot QR screen, HARVEST. Big targets, three buttons, no forms,
usable one-handed in sunlight. A worker is never shown a crop calendar, a cost, or a dropdown he
cannot answer from where he is standing.

**The desk** — Crops, Crop Planning, Farm Control. The same dense tables, chips and KPI tiles the
purchase module uses, so a manager moving between the two is not relearning the product.

Colour means the same thing everywhere: 🟢 fine · 🟡 look at this · 🔴 act now. (GREEN renders in the
app's existing cyan "ok" token — the palette deliberately avoids green.)

## Farm Today — `/farm`

The field worker's entire application.

| Element | What it does |
|---|---|
| Weather banner | The *decision*, not the data: "Rain expected — hold irrigation", "Heat risk at 39°C". Red banners also raise an alert for the manager. |
| Progress bar | Today's jobs done / total, plus how many are overdue and how many the weather held. |
| Task card | One job. **DONE** · **PROBLEM** · **SKIP**, and nothing else. Harvest cards also offer *Weigh & grade*; inspection cards offer *Crop check*. |
| DONE on a job needing a quantity | Opens one field — how much was actually used. Date, staff, farm and plot are attached without asking. |
| PROBLEM | Pick from eight plain-language reasons (Hindi alongside), optional photo. Writes the task status, a crop observation and a manager alert in one action. |
| Plot cards | Per plot: crop, day number, the water answer (💧 Today / ⏸ Hold / Not due) and the harvest countdown. Click to open the crop. |
| DAY CLOSE | One button. The system reads the day's tasks, harvest, expenses, problems and health and writes the report. |

## Plot QR — `/farm/plot/:qr`

What the QR stuck on a plot gate resolves to. Crop, sowing date, last watering, last spray, last
fertiliser, next harvest, health, and today's job *on this plot only*. This is the screen that stops
entries landing on the wrong crop.

## Start a crop — `/farm/crops/new`

Four answers: crop, plot, area, sowing date. The right-hand panel previews what will happen —
harvest window, expected yield, expected cost, cost per kg, and a count of the irrigation,
fertiliser, spray and inspection jobs about to be created. Nothing is written until you commit; then
the whole calendar is created in one transaction. If this crop has finished on this farm before, the
yield estimate is blended with what it actually gave, and the panel says so.

## Crop file — `/farm/crops/:id`

Four KPIs (health, harvest countdown, harvested vs expected, cost per kg) and four tabs:

- **Calendar** — every job, its colour, what was actually used, who did it, and any weather
  reschedule ("↻ Rain expected — irrigation held by the system").
- **Photo diary** — a timeline that builds itself from sowing, crop checks and harvests.
- **Harvests** — each pick with its grade split.
- **Cost & profit** — where the money went by type, spend against estimate, and actual cost per kg.
  Hidden server-side without `farming.cost.view`.

While picking is still open, "harvested vs expected" reads as progress, not as a shortfall — a
multi-pick crop one day into a two-week window is early, not short.

## Harvest — `/farm/harvest`

Scan/select the plot → weigh → grade → print. The readout shows net weight with the crate tare
already subtracted from the crate master. Four grades only, each showing where it goes (Retail /
B2B / Processing / Waste); they must add up to the net weight. Leave them all blank and the lot is
grade A. Waste is booked as a loss automatically. The result is a crate label carrying farm, plot,
crop, harvest number, date, crop age and net weight — none of which anyone typed.

## Farm → Warehouse — `/farm/dispatch`

**Send**: pick grades off ready harvests (waste never travels), choose the warehouse and vehicle.
**Weigh & receive** (warehouse role): enter what actually arrived per grade. The banner shows farm
sent / warehouse received / variance live. Beyond tolerance the server refuses to save without a
written reason, then books the gap as a loss against the crop. On save it creates batches, labels,
a `TRANSFER_IN` ledger row and stock balances — the produce is now ordinary stock.

## Farm Control — `/farm/dashboard`

The owner's screen: farm health as one colour, today's jobs done/total, harvest today, critical
problems, the 7-day forecast chart, cost per kg measured over *finished* crops, live crops by plot,
and problems reported from the field with who reported them.

## Crop Planning — `/farm/planning`

- **Next crop** — 60-day demand from sales history against expected farm production, with margin,
  and rotation/season/water as explicit vetoes ("Not a kharif crop", "Should not follow TOMATO").
- **Buy vs grow** — this farm's measured cost per kg against today's market rate, with a risk
  premium on growing, and a verdict the owner can overrule.
- **Harvest forecast** — today / tomorrow / next 3 / next 7 days, and by product.
- **Staff** — computed from completion, punctuality, red issues, grade-A share and waste. Never
  typed by a manager.

## Farms & Plots — `/farm/setup`

Filled in once. Farms with their water source, plots with auto-generated QR codes to print and
stick on gates, and machines with a three-colour status and a service date.

## Finance desk — `/finance`

One route, two screens, decided by `finance.expense.view`.

**Finance, the owner, the purchase manager** get the desk. Eight tiles across
the top — what is waiting to be checked, what is verified and unpaid, what has
been collected but not confirmed, what is owed to suppliers, then the flow:
paid out, collected, net movement, and how much of the spend was cash. Under
them four tabs, and every one of them is a queue you can act on:

- **To verify** — somebody asked for money. *Check it* opens the claim next to
  who raised it and what it is for. Finance can approve a smaller number than
  was asked for; turning it down needs a reason.
- **To pay** — verified claims and the outstanding balance on part-paid ones.
  Anything that is not cash demands a transaction reference, and the same
  reference cannot be used twice.
- **Coming in** — money a centre or customer says it has paid. Confirming asks
  what *actually landed*; a gap forces a note and flags the receipt as
  disputed.
- **Where it went** — spend by category, cash versus online, and the daily in
  and out.

**Everybody else** — the gate clerk, the QC hand, the warehouse, the farm — get
*Money Requests*: what they have asked Finance to pay and where each one stands,
in words rather than statuses ("with Finance to check", "approved, payment due",
"turned down — …"). The nav item renames itself to match.

The split exists so that nobody is shown an inbox they have no right to act on,
and nobody who spends money in the field is left with no way to claim it back.

## Supplier portal — the order is a conversation

The orders tab used to show a status and one button. It now shows where the
order is in a four-step conversation, and offers only the step that is
actually next:

| What the supplier sees | What they can do |
|---|---|
| *being placed* | nothing — we have not given it to them yet |
| **answer this** | **Accept or decline** |
| *you declined — <reason>* | nothing |
| *to send* (no payment asked for) | **Ask for payment** · **Send** |
| *waiting for payment* / *part paid — ₹1,000 of ₹8,000* | nothing; it is with Finance |
| *payment turned down — <reason>* | speak to the buyer |
| *paid — send it* | **Mark as sent** |
| *on the way* | **Update** |
| *delivered* | bill it |

`OrderState` and `OrderAction` read the same order object and derive the step
the same way, so the chip and the button cannot contradict each other — the
failure that makes a portal untrustworthy.

Accepting is the most urgent thing on the screen, so it has its own KPI:
**Waiting for your answer**, red while anything sits there.

**On the buyer's side**, the purchase order list gained a *Supplier says*
column — *no answer yet*, *accepted*, *accepted · wants ₹8,000*, or *declined —
crop damaged by rain*. A confirmed order the supplier has refused used to look
identical to one being loaded. The dashboard tile **Suppliers not answered**
counts both, and turns red the moment one is declined.

## Gate entry — one field, then corrections

`/gate/new` now opens on **"Invoice number from the driver's papers"**. Type it,
press Find, and the purchase order, supplier, vehicle, driver, phone,
transporter and invoice reference fill themselves in — all of it recorded by the
supplier days earlier when they accepted the order. Everything stays editable;
the clerk corrects whatever the paperwork actually says.

The banner underneath is the point of the exercise. It turns **red** if that
invoice has already been through the gate ("do not let it in twice"), **amber**
if the load has not been paid for, and notes when the supplier never marked it
as sent. All three are things that cannot be undone once the lorry is inside.

## Unloading — `/unload/:gateEntryId`

Used standing next to a lorry, on a tablet, one-handed, by somebody holding a
box. So the product is a **tile** and not a dropdown, the weight is a **number
pad** and not a text field, and recording a box leaves the screen exactly where
it was, ready for the next one.

- **Which product** — big tiles with the produce icon, each showing its running
  count and weight. A single-product load selects itself.
- **Or scan the code printed on the box** — the supplier's own code, resolved
  through `supplier_products`, falling back to our SKU.
- **Running total** — boxes, kilos, average box weight and the spread
  (`4 boxes · avg 12.20 kg (11.8–12.5)`), and the gap against what was ordered,
  in red past 5%.
- **Last boxes** — the most recent dozen, each voidable with a reason. A voided
  box stays visible, struck through, with the reason on it.

The weighbridge weighs the **lorry** — one number for a load carrying mango,
tomato and onion together. This weighs what actually came off it, which is the
only way to know how much of each product arrived. Those totals then prefill
the goods receipt, and the receipt line shows where the number came from:
*4 boxes weighed · 48.8 kg*.

## Packing bench — `/pack-bench/:batchId`

Reached from **Packing & labels → Grade & pack** (the old bulk run is still
there, one button along, because "make me 40 crates of 5 kg" is also a real
job).

Same thumb-sized language as the unload screen: the grade is a **tile**, the
quantity is a **number pad**, one tap packs the box.

- **A · B · C · Reject** tiles, each showing how many boxes of that grade have
  come off this batch already.
- When the chosen grade differs from what the lot was graded off the vehicle,
  an amber note says so: *"The lot was graded A and you are calling this box B.
  That is allowed — you are holding it — and the difference is recorded against
  your name."*
- **Price** is remembered per grade, because it is per grade in practice.
- **Shelf, if it goes now** — scan the bin and the box is graded, labelled and
  stored in one action. Leave it blank and it waits on the bench.
- **On the bench** lists everything not yet on a shelf, with a *Put on a shelf*
  action that takes a scanned bin code and a tick list.

The packs list on the main packing page now shows **grade** and **where** — the
two things somebody sent to fetch a box actually needs — with *on the bench* in
amber for anything not yet put away.

## Warehouse map — `/warehouse-map`

The floor plan as the client described it: **floor → section → rack → shelf**.
Shelves are tiles — tinted when they hold something — so an aisle with space in
it is visible from across the room. Clicking one prints its label.

Racks and shelves are created in runs (*"six shelves on this rack"*). Laying a
warehouse out one row at a time is how it never gets laid out.

Sections that existed before floors did hang under **"Not on a floor yet"**.
They work exactly as before; they are just waiting for somebody to say where
they are.

### The QR is real

`components/qr.tsx` is a QR encoder written the same way as the Code 128 one
next to it — drawn, not fetched. A label that only prints when a CDN is
reachable is not a label, and a warehouse basement is where the signal dies.

It is deliberately narrow: **version 1, EC level M, alphanumeric** — 20
characters, where every code we print is ten. Anything that does not fit falls
back to printing the text, which a human can still read and type in.

It is verified rather than assumed: 800 random codes across every length from 1
to 20 were rendered and decoded back with a real scanner library, and the first
version failed all of them — the two copies of the format-information bits run
in different directions, and mirroring one of them produces a code that looks
perfectly plausible and scans as nothing.

## Audit — `/audit`

Four numbers at the top: waiting to be counted, shelves counted in 30 days, how
many **did not match the books**, and what has been written off at landed cost.

**Scan a shelf** is the whole job. Point the phone at the sticker; the screen
shows what the books think is there *before* asking what is actually there —
the right order, because the auditor should see the claim they are checking.
Then: how much is there, what state it is in, how much is a write-off, and what
they saw. Anything not in good condition demands a note.

Under it, in amber: *"Recording this does not change the stock figures. It
records what you found; correcting the books is somebody else's decision, made
against your finding."* That is not a disclaimer — it is the design. The
`AUDITOR` role's sidebar contains Dashboard, My Work, Alerts, Stock, Audit,
Reports and Catalogue, and nothing that can move a rupee or a crate.

**What we keep losing** ranks products by written-off value over 90 days and
breaks it down by condition — damaged, spoiled, expired, missing, on the wrong
shelf.

## Centres — `/centres`

Two tabs. **Centres** lists each shop: what it is holding, what is on the way,
what it sold in 30 days, and whether it has closed today. **How they compare**
ranks them — but the column that matters is *net after costs*, and the page
says so: revenue flatters a shop with high rent, a long delivery run and heavy
wastage.

### One centre — `/centres/:id`

The shop's own screen, in the order the day happens:

- **Coming to you** — loads on a lorry, with the vehicle and driver. *It
  arrived* opens a count sheet; only what is confirmed becomes their stock, and
  a shortfall demands an explanation and tells the buyer.
- **On the shelves** — with expiry called in plain terms: *2d — sell first*,
  and past the date *2d past — write it off*, because "−2d" is not advice
  anybody can act on.
- **Today's bills** and **Last two weeks** of closes, with the gap between the
  bills and the declaration in red.
- **Ask for stock** — goes to the purchase manager with the person's own
  reasoning, because *"Ganpati this weekend"* gets a different answer from
  *"ran out"*.
- **Close the day** — shows what the bills say first, then asks what was
  actually taken, split cash and online. Any gap demands a note and is flagged
  to the owner and Finance. Closing again corrects the same day.

## Customers — `/customers`

Who buys, from which shop, how often and how much. At the till the buyer is a
**dropdown with a + New beside it** rather than a free-text box: a name typed
by hand is a different spelling every time, and "who buys from us" stops being
an answerable question.

## One person's panel — People & Access → *Their panel*

Roles stay the sane thing to manage: twelve roles, not sixty people. This is the
layer on top, for the client's own example — two purchase executives, one of
whom may confirm orders with suppliers and one of whom may not.

Every permission in the system is listed by module with **can / cannot** against
it, the ones that differ from the role tinted and shown first when you tick
*Only what is different from the role*. Giving or taking one asks for a reason
and, on a grant, an optional expiry — a permission that outlives its reason is
how access creeps. **Put them back on their role** clears the lot.

## The price ladder, at the till

The sell dialog now reads as an argument rather than four numbers:

| | |
|---|---|
| Bought for | ₹24.00 |
| Running costs | + ₹7.63 — wages, power, cold store, per KG |
| **Really cost** | **₹31.63** |
| **Do not sell below** | **₹39.97** — 9% goes to waste · 15% margin |

And the warning below it now distinguishes three different mistakes: below what
it cost, covering the purchase but not the running costs, and under the intended
margin.

## Product performance — `/performance`

One row per product, opening into its own card. The collapsed row carries
**after waste** and **sell-through** deliberately: a revenue-sorted table puts
the loss-makers at the top looking successful, and a product with good revenue,
40% wastage and 30% sell-through is losing money. Cards for those are tinted red
down the left edge.

Opened, each product shows who it is **bought from**, where it is **sold**,
where it **stands** (bought, still on the shelf, thrown away or short, kept
after waste), and a daily revenue chart — with an honest note instead of a
chart when there is only one day of sales.

The **Categories** tab has revenue by category, margin against waste side by
side, and a card per category. Those totals are summed from the products, so
the two tabs cannot disagree.

## Workers & wages — `/hr`

Three tabs because they happen at different times of day.

**Today** is the one that has to be fast — a row per person, five big buttons
(In · Half · Absent · Leave · Off) and an overtime box, no dialog. Anyone not
yet marked is left visibly pale, and **Everyone in** fills the common case in
one tap. Anything slower and attendance stops being taken.

**People** carries the record behind those taps: what they are paid and how,
the last 30 days of attendance, what they actually did (boxes weighed, boxes
packed, shelves counted — measured, not rated), and what they have been paid.

**Wages** works a period out from the attendance rather than asking anyone to
type it, shows the arithmetic per person, takes a bonus with a reason, and sends
one request per person to Finance. A period already sent shows as *sent* and
cannot be run twice.

## Filters, everywhere, with the numbers under them

One hook and one bar (`useFilters`, `FilterBar`, `FilterTotals` in `ui.tsx`),
used by every list, so a filter behaves the same on the order list as on the
requirement list. Six hand-rolled filter bars would be six sets of slightly
different behaviour and five of them would be subtly wrong.

Every bar has **a time window** (the client's must-have), facet dropdowns built
from the data itself — a supplier never ordered from does not appear, one added
this morning does — a search box, and a **Clear N filters** button that only
shows when something is on.

Under every filtered table is the strip that is the point of the exercise:

```
9 orders of 53                    ORDERED ₹58,086      RECEIVED 1,210
```

A filtered list without it answers "which ones" but not "how much", and "how
much" is the question somebody filtered in order to ask.
