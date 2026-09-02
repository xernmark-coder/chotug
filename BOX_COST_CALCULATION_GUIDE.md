# Box Cost Calculation Logic

## Overview
Box pricing in ChotuG involves multiple cost components and careful unit management. The key insight is distinguishing between **what we buy** (purchase unit) and **what we hold** (held unit, typically kilograms for produce).

---

## The Core Formula

```
BOX PRICE = Per-Unit Cost × Box Size × (1 + Margin%) / (1 - Wastage%)
```

Expanded:
```
BOX PRICE = [landed_cost + overhead + freight_in + delivery] × box_kg × (1 + margin%) / (1 - wastage%)
```

---

## Cost Components (Per Kilogram)

### 1. **Landed Cost (landed_rate_per_kg)**
- What we actually paid for the produce
- Already recorded when the GRN (Goods Receipt Note) is posted
- Example: Mango batch bought at ₹68/kg

### 2. **Overhead Per Kilogram (overhead_per_kg)**
- Cost of running the warehouse
- Calculated as: Operating spend ÷ Total kg handled (over 30-day window)
- Applied to every kg that passes through
- Example: ₹2.50 per kg

### 3. **Inbound Freight Per Kilogram (inbound_per_kg)**
- Cost to get produce from supplier to warehouse
- Set per company in the Catalogue
- Applied to every kg received
- Example: ₹1.50 per kg

### 4. **Outbound/Delivery Rate Per Kilogram (outbound_per_kg)**
- Cost to deliver from warehouse to a retail center
- **Only included if the box is traveling to a center**
- If box stays at warehouse (selling point), this is ₹0
- Set per warehouse/center in Delivery Rates configuration
- Example: ₹22.80 per kg to Kothrud center vs ₹9.03 average (old system)

---

## Key Calculation Steps (Database Level)

### Step 1: Determine Unit Conversion (db/48, db/49, db/52)
```sql
-- For a batch, calculate how many kg are in one purchase unit
kg_per_unit = landed_rate / landed_rate_per_kg

-- For kilograms (base_uom = 'KG'), held unit = 1 kg
-- For boxes (base_uom = 'BOX'), held unit = the number of kg per box
```

**Example:**
- Mango: Bought at ₹68/box, 15 kg per box
  - landed_rate = 68 (per box)
  - landed_rate_per_kg = 4.53 (per kg)
  - kg_per_unit = 68 ÷ 4.53 = 15 kg per box ✓

### Step 2: Calculate Cost Per Held Unit (db/51)
```sql
-- Cost before delivery (warehouse to center)
cost_before_delivery = held_rate 
                     + (overhead_per_kg × kg_per_held_unit)
                     + (inbound_per_kg × kg_per_held_unit)

-- Full cost including delivery
true_cost_per_held_unit = cost_before_delivery 
                        + (outbound_per_kg × kg_per_held_unit)
```

**Example for a 5 kg mango box:**
- Landed: ₹4.53/kg × 5 kg = ₹22.65
- Overhead: ₹2.50/kg × 5 kg = ₹12.50
- Freight in: ₹1.50/kg × 5 kg = ₹7.50
- **Cost before delivery = ₹42.65 per box**
- Delivery (Kothrud): ₹22.80/kg × 5 kg = ₹114 (if shipping)
- **Full cost = ₹156.65 (if shipping) or ₹42.65 (if local)**

### Step 3: Apply Wastage & Margin (db/48, db/51)
```sql
-- Wastage: % of produce that spoils/waste
-- Margin: % profit needed on the sale

min_sell_price = (true_cost_per_held_unit / (1 - wastage%)) × (1 + margin%)
```

**Example (continuing from above):**
- Product wastage: 10%
- Margin: 30%
- Selling locally (warehouse): ₹42.65
  - Adjusted for wastage: ₹42.65 ÷ (1 - 0.10) = ₹47.39
  - With margin: ₹47.39 × 1.30 = **₹61.61**
- Selling at Kothrud: ₹156.65
  - Adjusted for wastage: ₹156.65 ÷ 0.90 = ₹174.06
  - With margin: ₹174.06 × 1.30 = **₹226.28**

---

## What Changed (The Unit Bug Fix)

### The Problem
The system was mixing purchase units and held units:
- Mango batch: Bought by **box** (15 kg per box), cost ₹68 per box
- Stock held in: **kg** (100 kg = 6.67 boxes)
- Frontend multiplied: **per-box cost × number of kg in box**
- Result: ₹68 × 5 kg = ₹340 instead of ₹22.67

### The Solution
Three new views separate the concerns:

1. **v_batch_unit_cost** (db/52): Derives the cost per held unit from actual records
   ```sql
   landed_per_held_unit = landed_value ÷ initial_qty
   -- Uses what was actually booked, not assumptions
   ```

2. **v_batch_pricing** (db/48, db/51): Adds all costs per held unit
   ```
   true_cost_per_held_unit (all costs in one unit)
   cost_before_delivery (costs without delivery)
   min_sell_price (with wastage & margin applied)
   ```

3. **packing bench (web/src/pages/PackBench.tsx)**: 
   - Asks for box size in kg
   - Multiplies: cost_per_kg × box_size_kg
   - Applies margin based on packer's choice

---

## Packing Bench Workflow

### 1. Select Batch & Grade
- Choose which batch to pack (already defines the cost base)
- Choose quality grade (A/B/C/Reject)
- Only A/B/C boxes get priced labels (Reject discarded)

### 2. Enter Box Size (in kg)
- Packer types: "5" for a 5 kg box
- This size is entered at the bench, nowhere else
- The size determines how many kg of cost go into one box

### 3. Choose Destination
- Select where box is going:
  - "Warehouse" (local) → delivery_rate = ₹0
  - "Kothrud" (center) → delivery_rate = ₹22.80/kg
  - Other centers have their own rates
- Rate is added per kg to the cost

### 4. Set Margin
- Default margin from product (or company default)
- Packer can override if they know the market
- This is NOT the floor price — it's the starting point

### 5. Label Price Generated
```javascript
// Frontend calculation (matches database formula)
function suggestPrice(cost, boxSize, wastagePct, margin) {
  const costPerUnit = cost; // already includes delivery for chosen center
  const spread = costPerUnit / Math.max(1 - wastagePct/100, 0.05);
  const withMargin = spread * (1 + margin/100);
  return Math.ceil(withMargin * boxSize); // Round UP to nearest rupee
}
```

---

## Database Views Used

| View | Purpose | Used By |
|------|---------|---------|
| `v_batch_unit_cost` | Cost per held unit (kg) derived from receipts | Finance reconciliation |
| `v_batch_pricing` | All costs rolled up per held unit | Packing bench, reports |
| `v_product_pricing` | Batch-level pricing with all breakdowns | Pricing reports, catalog |
| `v_overhead_per_kg` | Overhead averaged over 30 days | Every cost calculation |
| `v_inbound_freight_per_kg` | Inbound cost by company | Every cost calculation |
| `v_outbound_cost_per_kg` | Delivery cost by warehouse/center | Destination-specific pricing |

---

## Critical Constraints

### ✓ What Works
- Exact per held unit, always in stock's unit
- Multiplicative: cost × qty = total cost
- Idempotent: same batch always costs the same per unit
- Traceable: every component is measured or set

### ✗ What Doesn't Work
- Guessing the held unit (uses actual stock records)
- Hidden unit conversions (explicit kg_per_held_unit)
- Average delivery costs (destination-specific)
- Delivery added before box destination is known

### ⚠ Verification Test
```sql
-- Every batch in stock should equal what we paid
SELECT COUNT(*) FROM batches b
  WHERE abs((SELECT qty FROM stock_balances sb 
              WHERE sb.batch_id = b.id)
            * (SELECT landed_per_held_unit FROM v_batch_unit_cost uc 
                WHERE uc.batch_id = b.id)
            - b.landed_value) > 0.02
  -- Should return 0 (or very close due to rounding)
```

---

## Examples in Action

### Example 1: Local Sale (Warehouse)
```
Batch: Apple, Cost ₹3.50/kg
- Overhead: ₹2.00/kg
- Freight in: ₹0.50/kg
- Margin: 20%
- Wastage: 5%
- Box size: 6 kg
- Destination: Warehouse (local)

Cost per kg = ₹3.50 + ₹2.00 + ₹0.50 = ₹6.00
Spread over waste = ₹6.00 / 0.95 = ₹6.32
With margin = ₹6.32 × 1.20 = ₹7.58
Box price = ₹7.58 × 6 kg = ₹45.48 → ₹46 (rounded up)
```

### Example 2: Delivery to Kothrud
```
Same batch, but shipping to Kothrud
- Delivery rate: ₹25/kg

Cost per kg = ₹3.50 + ₹2.00 + ₹0.50 + ₹25 = ₹31.00
Spread over waste = ₹31.00 / 0.95 = ₹32.63
With margin = ₹32.63 × 1.20 = ₹39.16
Box price = ₹39.16 × 6 kg = ₹234.96 → ₹235 (rounded up)
```

### Example 3: The Old Bug
```
Mango: ₹68/box, 15 kg per box → ₹4.53/kg (true rate)

OLD BUG (mixed units):
- Cost per box = ₹68
- Packer enters: 5 kg box
- Calculation: ₹68 × 5 = ₹340 ❌ (15x too high!)

NEW (correct):
- Cost per kg = ₹4.53
- Packer enters: 5 kg box
- Calculation: ₹4.53 × 5 = ₹22.65 ✓
```

---

## Configuration Locations

### In the Catalog (per product)
- Default wastage %
- Default margin %

### In the Warehouse/Company Settings
- Overhead per kg (calculated from operating spend)
- Inbound freight per kg
- Outbound delivery rate per center

### At Packing Bench (per box)
- Grade (A/B/C)
- Box size in kg
- Destination warehouse
- Margin override (optional)

---

## Troubleshooting

**Box priced too high?**
- Check if outbound rate was included when it shouldn't be
- Verify box size was entered correctly
- Check if margin was manually raised

**Box priced too low (below cost)?**
- Check if destination rate is missing
- Verify cost_before_delivery is populated
- Check product wastage % is realistic

**All boxes for a batch priced wrong?**
- Check landed_rate in the batch record
- Verify overhead_per_kg is set for the company
- Ensure grn_lines.accepted_qty matches stock_balances entry

---

## Reference Files
- **db/48_cost_per_unit_held.sql** - Convert per-purchase-unit to per-held-unit
- **db/51_cost_before_delivery.sql** - Add all non-delivery costs
- **db/52_unit_cost_from_what_was_booked.sql** - Derive held unit from actual stock
- **web/src/pages/PackBench.tsx** - Frontend pricing logic
- **web/src/pages/Catalogue.tsx** - Set overhead and delivery rates
