# Invoice Payment Status Bug Analysis

## Issue Summary
Invoice shows **Paid: ₹0, Balance: Full amount** even though:
- Goods have been received and stored
- Payment has been made in Finance module

## Root Cause

The problem is in the **payment_status table initialization logic**. Here's the flow:

### When Payment Status Record is Created
[costing.ts:650-655](server/src/modules/costing.ts#L650)
```sql
INSERT INTO payment_status (invoice_id, company_id, supplier_id, payable_amount, balance, due_date, sync_source)
VALUES ($1,$2,$3,$4,$4,$5,'PURCHASE_MODULE')
ON CONFLICT (invoice_id) DO UPDATE SET payable_amount=EXCLUDED.payable_amount, balance=EXCLUDED.balance, due_date=EXCLUDED.due_date, last_synced_at=now()
```

**This INSERT only happens when invoice status becomes 'MATCHED'** (line 645)

### What Can Go Wrong

1. **Invoice never reaches MATCHED status**
   - If 3-way match fails → status = MISMATCH or HOLD
   - payment_status record is NEVER created
   - So Finance module can't track the payment

2. **Invoice status is different**
   - PENDING_RECEIPT: No payment_status (goods not yet arrived)
   - MISMATCH: No payment_status
   - HOLD: No payment_status  
   - MATCHED → PAYABLE: payment_status created ✓

3. **The Query in Invoice Detail**
[costing.ts:768-770](server/src/modules/costing.ts#L768)
```sql
SELECT ps.* FROM payment_status ps WHERE ps.invoice_id=$1
```
Returns null if no record exists → Frontend shows "Payment is made in Finance. This module only shows the status."

### When Payment is Made
[finance.ts:611-616](server/src/modules/finance.ts#L611)
```sql
UPDATE payment_status
    SET paid_amount = paid_amount + $2,
        balance = GREATEST(payable_amount - (paid_amount + $2), 0),
        last_payment_at = now(), last_synced_at = now(),
        sync_source = 'FINANCE_PANEL'
  WHERE invoice_id = $1
```

This UPDATE fails silently if payment_status record doesn't exist (no rows affected).

---

## The Broken Workflow

```
1. Invoice filed
   ↓
2. GRN posted (goods received) 
   ↓
3. checkInvoiceAgainstReceipts() runs
   ├─ If 3-way match PASSES → status = MATCHED → payment_status CREATED ✓
   └─ If 3-way match FAILS → status = MISMATCH/HOLD → payment_status NOT CREATED ✗
   ↓
4. Finance makes payment
   ├─ If payment_status EXISTS → balance is updated ✓
   └─ If payment_status MISSING → payment recorded but status not synced ✗
   ↓
5. Buyer views invoice
   └─ Shows Paid: ₹0 because payment_status record is null
```

---

## Symptoms

1. **Invoice shows goods were not received** (yet goods are in warehouse)
   - `receipt_status` is checked on line 231 of Finance.tsx
   - Based on receipt_status in v_batch_pricing view

2. **Payment section shows full balance even after payment**
   - payment_status record doesn't exist
   - Payment made in Finance but no corresponding record to update

3. **The confusing message**
   - "Payment is made in Finance. This module only shows the status."
   - This is technically correct—it IS read-only here
   - But it hides the fact that there's **no status record to show**

---

## Why This Happens

This is a **design issue with the three-way match logic**:

According to [CLIENT_PHASE2_PLAN.md](docs/CLIENT_PHASE2_PLAN.md):
> "the match is no longer a gate. An invoice reaches the Finance inbox the moment it is captured, Finance verifies and pays. The three-way match still runs and is still shown on the invoice, but as reconciliation the buyer can read, never as a lock on the money."

**But the code still locks payment_status creation behind a successful match** (line 645: `if (newStatus === 'MATCHED')`).

So if:
- Invoice status: MISMATCH ❌
- payment_status: Doesn't exist ❌
- Finance payment: Made, but can't find payment_status to update ❌
- Buyer sees: "Paid: 0" ❌

---

## The Fix Needed

payment_status should be created **whenever invoice becomes PAYABLE**, not just when MATCHED:

```sql
-- CURRENT (Wrong): Only if MATCHED
if (newStatus === 'MATCHED') {
  INSERT INTO payment_status (...)
}

-- SHOULD BE: When MATCHED OR MISMATCH OR HOLD (anytime invoice can be paid)
if (['MATCHED', 'MISMATCH', 'HOLD'].includes(newStatus)) {
  INSERT INTO payment_status (...)
}
```

This way:
- ✓ Payment_status always exists once invoice is invoiced
- ✓ Finance payments always find a record to update
- ✓ Buyer sees current payment status (even if there's a mismatch)
- ✓ Reconciliation can still show the mismatch separately

---

## Scenario That Breaks

**This invoice (from screenshot):**
1. Invoice filed: SAH/11-11/11
2. GRN posted... but **there's a qty/rate mismatch** 
3. Match fails → invoice status = MISMATCH
4. **payment_status is NOT created** ← BUG
5. Finance pays anyway (policy says match is not a gate)
6. Payment goes to database, but payment_status missing
7. Buyer checks invoice → sees "Paid: ₹0"

---

## Is This Page Needed At All?

The message suggests this might be intentionally read-only and informational only:
> "Payment is made in Finance. This module only shows the status."

**Options:**
1. **Keep it but fix it** – Ensure payment_status always syncs (small fix)
2. **Remove it** – If Finance is the source of truth, maybe this payment card is redundant
3. **Make it sync from Finance** – Query payment_requests directly instead of payment_status

The current hybrid approach (half-synced, half-read-only) is what's causing the confusion.

---

## Current Status Check

The issue is **valid** — the payment_status sync logic is incomplete. Once an invoice fails 3-way match, payment tracking breaks even though the payment was legitimately made according to client policy.

**Recommendation:** Create payment_status for any invoiced supplier invoice (MATCHED, MISMATCH, or HOLD status), not just successfully matched ones. This ensures Finance payments always have a record to update.
