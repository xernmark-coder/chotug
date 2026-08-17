import { Router } from 'express';
import { pool } from '../db.js';
import { ApiError, h } from '../platform/http.js';

/* ===========================================================================
 * PUBLIC — the label lookup, and nothing else.
 *
 * A shopkeeper who scans a pack has no account and never will. This router is
 * mounted OUTSIDE authenticate() so the scan works from any phone, which means
 * every field it returns is a deliberate decision rather than a default.
 *
 * What goes out: what the pack is, how much is in it, what it cost the buyer,
 * where it came from and how fresh it is — the provenance a produce buyer is
 * entitled to.
 *
 * What never goes out: landed cost, margin, supplier rates, internal document
 * numbers, anything about other packs or stock levels. A competitor scanning a
 * crate in a shop learns what is printed on the label, and no more.
 * ======================================================================== */

export const publicRouter = Router();

publicRouter.get('/pack/:code', h(async (req) => {
  const code = String(req.params.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(code)) throw ApiError.notFound('No pack with that code');

  const { rows } = await pool.query(
    `SELECT k.code, k.qty, k.uom, k.price, k.grade, k.status,
            p.name AS product_name, p.name_hi AS product_name_hi, p.sku,
            r.packed_on,
            b.batch_no, b.harvest_date, b.received_date,
            COALESCE(b.predicted_expiry_date, b.expiry_date) AS best_before,
            c.trade_name AS packed_by,
            f.name AS farm_name,
            s.trade_name AS supplier_name
       FROM packs k
       JOIN pack_runs r ON r.id = k.run_id
       JOIN products  p ON p.id = k.product_id
       JOIN batches   b ON b.id = k.batch_id
       JOIN companies c ON c.id = k.company_id
       LEFT JOIN farms     f ON f.id = b.farm_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE upper(k.code) = $1
      LIMIT 1`,
    [code]);

  const k = rows[0];
  // Same answer for "never existed" and "voided": a stranger enumerating codes
  // should not be able to tell the difference.
  if (!k || k.status === 'VOID') throw ApiError.notFound('No pack with that code');

  const bestBefore: string | null = k.best_before;
  const daysLeft = bestBefore
    ? Math.ceil((new Date(bestBefore).getTime() - Date.now()) / 86_400_000)
    : null;

  return {
    code: k.code,
    product: k.product_name,
    productHi: k.product_name_hi,
    sku: k.sku,
    quantity: Number(k.qty),
    uom: k.uom,
    price: Number(k.price),
    grade: k.grade,
    packedOn: k.packed_on,
    bestBefore,
    daysLeft,
    isFresh: daysLeft == null ? null : daysLeft >= 0,
    harvestedOn: k.harvest_date,
    // "Where it came from" is the farm if we grew it, the supplier if we bought
    // it — one of the two, never both, and never the commercial terms.
    origin: k.farm_name ?? k.supplier_name ?? null,
    originKind: k.farm_name ? 'FARM' : k.supplier_name ? 'SUPPLIER' : null,
    packedBy: k.packed_by,
    batchRef: k.batch_no,
    sold: k.status === 'SOLD',
  };
}));
