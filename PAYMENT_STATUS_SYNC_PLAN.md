# Payment Status Sync Plan — No 3-Way Match

## Problem
Since 3-way match was removed, invoices can be paid immediately or delayed, but the invoice detail page doesn't reflect payment status because `payment_status` table is never initialized.

**Current broken flow:**
```
Invoice filed → No payment_status created (was waiting for MATCHED status)
                ↓
Finance makes payment → UPDATE payment_status fails (record doesn't exist)
                ↓
Buyer checks invoice → Paid: ₹0 (no record to show)
```

---

## Solution Architecture

### Principle
`payment_status` is the **single source of truth** for "how much have we paid this supplier on this invoice?"
- Created once when invoice is accepted/filed
- Updated every time Finance makes a payment
- Always reflects current payment state on invoice detail page

---

## Implementation Plan (No Code Changes Yet)

### Phase 1: Create payment_status Early
**When:** Immediately when invoice is accepted/filed (not dependent on 3-way match)

**Current code location:** [costing.ts:645-655](server/src/modules/costing.ts#L645)
```typescript
if (newStatus === 'MATCHED') {  // ← This condition needs to change
  INSERT INTO payment_status (...)
}
```

**What needs to happen:**
- `payment_status` should be created when invoice status becomes `PAYABLE` (or first saved)
- Not conditional on 3-way match result
- Should happen in **supplier invoice acceptance flow** OR **invoice capture flow**

**Option A:** Create when invoice is first captured/filed
- Location: `supplier.ts` → `POST /supplier-portal/invoices` OR `/supplier/invoices`
- Trigger: Right after `INSERT INTO supplier_invoices`
- Result: By the time Finance sees it, payment_status exists

**Option B:** Create as part of invoice acceptance workflow
- Location: `costing.ts` → When invoice status first becomes any "payable" state
- Trigger: Could be automatic or manual acceptance
- Result: Clear moment when supplier becomes a payee

**Recommended:** **Option A** — Create at capture time
- Simpler: happens once, at the beginning
- Clearer: no dependency on complex match logic
- Earlier: Finance knows immediately this is a payable invoice

---

### Phase 2: Sync Payment Updates Both Ways

**Current state:** ✓ Finance → payment_status works (line 611 in finance.ts)
```typescript
UPDATE payment_status
  SET paid_amount = paid_amount + amount,
      balance = GREATEST(payable_amount - (paid_amount + amount), 0)
WHERE invoice_id = $1
```

**Problem:** This fails silently if record doesn't exist (no rows affected)

**What needs to happen:**
1. **Ensure payment_status always exists** (Phase 1 solves this)
2. **Ensure balance is recalculated** after each payment
3. **Expose payment status on invoice detail page** (already queries it, just needs data)

**SQL flow to verify:**
```sql
-- Verify payment_status exists
SELECT * FROM payment_status WHERE invoice_id = 'the-invoice-id';

-- When Finance makes payment
UPDATE payment_status 
  SET paid_amount = paid_amount + ?, 
      balance = payable_amount - (paid_amount + ?),
      last_synced_at = now(),
      sync_source = 'FINANCE_PANEL'
WHERE invoice_id = ?;

-- Buyer sees this on invoice detail
SELECT ps.payable_amount, ps.paid_amount, ps.balance, ps.last_payment_at
FROM payment_status ps 
WHERE ps.invoice_id = ?;
```

---

### Phase 3: Real-Time Sync from Finance (Optional)

**If payment comes from external source (Tally/Finance integration):**

Currently, `sync_source` can be:
- `'PURCHASE_MODULE'` — Created here when invoice captured
- `'FINANCE_PANEL'` — Updated when Finance makes payment
- Could add: `'TALLY_SYNC'` or `'PAYMENT_GATEWAY'`

**Flow if using Tally:**
```
Tally records payment
  ↓
Payment sync endpoint receives update
  ↓
UPDATE payment_status SET paid_amount, balance, external_ref, sync_source='TALLY_SYNC'
  ↓
Buyer sees latest status on invoice detail
```

**Endpoint location:** [costing.ts:822](server/src/modules/costing.ts#L822) — Already has sync endpoint
```typescript
// POST /costing/payments/sync
// Updates payment_status from external sources
```

---

## Database Initialization Changes

### payment_status Table (No schema change needed, just different usage)

**Current columns (all needed):**
```
invoice_id          ← PK, which invoice this is for
company_id          ← Filter by company
supplier_id         ← Filter by supplier
payable_amount      ← Total that must be paid (invoice.total)
paid_amount         ← How much paid so far
balance             ← payable - paid (the key field to show)
due_date            ← When it's due
is_blocked          ← Is this invoice blocked from payment?
blocked_reason      ← Why is it blocked?
last_payment_at     ← When was last payment made?
external_ref        ← Tally/Finance reference
last_synced_at      ← When did Finance last update this?
sync_source         ← Where did the last update come from?
```

**No schema changes needed** — just change when records are created.

---

## Data Flow Diagram

```
INVOICE CAPTURED
    ↓
[NEW] CREATE payment_status (
  invoice_id = invoice.id,
  company_id = invoice.company_id,
  supplier_id = invoice.supplier_id,
  payable_amount = invoice.total,
  paid_amount = 0,
  balance = invoice.total,
  due_date = invoice.due_date,
  sync_source = 'PURCHASE_MODULE'
)
    ↓
INVOICE DETAIL PAGE LOADS
    ↓
SELECT FROM payment_status WHERE invoice_id = ?
    ↓
Shows: Payable ₹6,500, Paid ₹0, Balance ₹6,500 ✓
    ↓
FINANCE MAKES PAYMENT (₹2,000)
    ↓
UPDATE payment_status
  SET paid_amount = 2000,
      balance = 4500,
      last_payment_at = now(),
      sync_source = 'FINANCE_PANEL'
WHERE invoice_id = ?
    ↓
BUYER REFRESHES PAGE
    ↓
SELECT FROM payment_status WHERE invoice_id = ?
    ↓
Shows: Payable ₹6,500, Paid ₹2,000, Balance ₹4,500 ✓
    ↓
PAYMENT COMPLETE
    ↓
UPDATE supplier_invoices SET status='PAID' WHERE id = ?
    ↓
Shows: Payable ₹6,500, Paid ₹6,500, Balance ₹0 ✓
```

---

## Code Locations to Change

| Module | File | Current Behavior | Change Needed |
|--------|------|------------------|---------------|
| **Supplier (invoice capture)** | `server/src/modules/supplier.ts` | Files invoice → runs 3-way match | Create payment_status immediately after INSERT |
| **Costing (invoice detail)** | `server/src/modules/costing.ts` | Only creates payment_status if MATCHED | Remove that condition, move to supplier.ts |
| **Finance (payments)** | `server/src/modules/finance.ts` | Updates payment_status | ✓ No change (already works if record exists) |
| **Web (invoice page)** | `web/src/pages/Finance.tsx` | Queries payment_status | ✓ No change (already works if data exists) |

---

## Summary of Changes Needed

### Must Change
1. **supplier.ts** — Add payment_status INSERT right after invoice INSERT
   - Trigger: When invoice is first filed
   - Data: invoice.id, invoice.total, invoice.due_date, invoice.supplier_id

2. **costing.ts** — Remove payment_status INSERT from 3-way match flow
   - Delete lines ~645-655 (the conditional INSERT)
   - Keep all match checking and status updates
   - Keep supplier_invoices status updates

### Will Work Automatically
- Finance payment sync (already UPDATEs payment_status)
- Invoice detail page (already queries payment_status)
- Payment reversal (already handles payment_status rollback)

---

## Benefits

| Before | After |
|--------|-------|
| Payment_status only if match passes | Payment_status created for ALL invoices |
| Finance payment doesn't sync if no record | Finance payment always syncs |
| Buyer sees "Paid: ₹0" even after payment | Buyer sees actual payment status |
| Payment made but status unknown | Payment is always visible |
| 3-way match gates payment (old flow) | Match is info only (new flow) |

---

## Testing Checklist

After implementation:

- [ ] File invoice → payment_status created immediately
- [ ] Finance makes payment → balance updates on invoice page
- [ ] Payment reversed → balance goes back up
- [ ] Multiple payments → balance decrements correctly
- [ ] Invoice paid completely → balance = 0
- [ ] Goods not received yet → invoice still shows as payable (match status is separate)
- [ ] External sync from Tally → payment_status updates from external_ref

---

## Timeline

- **Phase 1 (Must):** Move payment_status creation to supplier.ts (1 change)
- **Phase 2 (Already works):** Finance sync continues to work
- **Phase 3 (Optional):** Wire up Tally sync if using external Finance system

**Risk Level:** Low — Just moving an INSERT earlier in the flow, no logic changes
**Rollback:** Trivial — move INSERT back to where it was
