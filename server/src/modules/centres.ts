import { Router } from 'express';
import { z } from 'zod';
import { query, withTx, type Actor, type Tx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, pushTask, raiseAlert } from '../platform/services.js';
import { createRequest } from './finance.js';

export const centreRouter = Router();
centreRouter.use(authenticate);

/* ===========================================================================
 * CENTRES — the shops
 *
 * A centre IS a warehouse. It holds stock, stock moves in and out, it has a
 * balance and a ledger. Giving it its own table would have meant a second
 * stock model and two different answers to "how much mango is in Kothrud".
 * So everything already built — batches, packs, shelves, issues, the ledger —
 * applies to a centre unchanged, and this module adds only what is genuinely
 * different about a shop:
 *
 *   · stock arrives from our own warehouse, on a lorry, and is IN TRANSIT
 *     until somebody at the shop says it got there;
 *   · it is sold to customers, who belong to the shop;
 *   · at closing time the person declares the day's takings, and the gap
 *     between their figure and the system's is the thing worth looking at.
 * ======================================================================== */

const money = (n: number) => Math.round(n * 100) / 100;

/* --------------------------------------------------------- the centres --- */

centreRouter.get('/', h(async (req) =>
  query(req.actor,
    `SELECT w.id, w.code, w.name, w.city, w.address, w.is_centre, w.opened_on,
            w.monthly_rent, w.upi_id, w.upi_payee_name,
            u.full_name AS manager_name,
            COALESCE(s.qty, 0)        AS stock_qty,
            COALESCE(s.value, 0)      AS stock_value,
            COALESCE(t.in_transit, 0) AS in_transit_loads,
            COALESCE(d.sold_30d, 0)   AS sold_30d,
            COALESCE(d.revenue_30d, 0) AS revenue_30d,
            c.close_date              AS last_closed_on,
            (SELECT count(*)::int FROM customers x
              WHERE x.warehouse_id = w.id AND x.is_active) AS customers
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.manager_user_id
       LEFT JOIN (SELECT sb.warehouse_id, SUM(sb.qty) AS qty,
                         SUM(sb.qty * COALESCE(b.landed_rate,0)) AS value
                    FROM stock_balances sb
                    LEFT JOIN batches b ON b.id = sb.batch_id
                   GROUP BY sb.warehouse_id) s ON s.warehouse_id = w.id
       LEFT JOIN (SELECT dest_warehouse_id, count(*)::int AS in_transit
                    FROM stock_issues WHERE status = 'IN_TRANSIT'
                   GROUP BY dest_warehouse_id) t ON t.dest_warehouse_id = w.id
       LEFT JOIN (SELECT warehouse_id, SUM(total_qty) AS sold_30d,
                         SUM(total_value) AS revenue_30d
                    FROM stock_issues
                   WHERE reason = 'SALE' AND status IN ('POSTED','RECEIVED')
                     AND issue_date > CURRENT_DATE - 30
                   GROUP BY warehouse_id) d ON d.warehouse_id = w.id
       LEFT JOIN LATERAL (SELECT close_date FROM centre_day_close x
                           WHERE x.warehouse_id = w.id
                           ORDER BY close_date DESC LIMIT 1) c ON true
      WHERE w.company_id = $1
        AND ($2 = 'all' OR w.is_centre)
        AND w.is_active
      ORDER BY w.is_centre DESC, w.name`,
    [req.actor.companyId, String(req.query.include ?? 'centres')])));

centreRouter.patch('/:id', requires('admin.settings.manage'), h(async (req) => {
  const i = body(z.object({
    isCentre: z.boolean().optional(),
    city: z.string().trim().max(60).optional(),
    address: z.string().trim().max(200).optional(),
    managerUserId: z.string().uuid().nullable().optional(),
    openedOn: z.string().optional(),
    monthlyRent: z.coerce.number().nonnegative().optional(),
    upiId: z.string().trim().max(80).optional(),
    upiPayeeName: z.string().trim().max(80).optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE warehouses SET
          is_centre       = COALESCE($2, is_centre),
          city            = COALESCE($3, city),
          address         = COALESCE($4, address),
          manager_user_id = COALESCE($5, manager_user_id),
          opened_on       = COALESCE($6::date, opened_on),
          monthly_rent    = COALESCE($7, monthly_rent),
          upi_id          = COALESCE($8, upi_id),
          upi_payee_name  = COALESCE($9, upi_payee_name),
          updated_by = $10, updated_at = now()
        WHERE id = $1 AND company_id = $11 RETURNING *`,
      [req.params.id, i.isCentre ?? null, i.city ?? null, i.address ?? null,
       i.managerUserId ?? null, i.openedOn ?? null, i.monthlyRent ?? null,
       i.upiId ?? null, i.upiPayeeName ?? null, req.actor.userId, req.actor.companyId]);
    if (!rows[0]) throw ApiError.notFound('No such warehouse.');
    return rows[0];
  });
}));

/* ------------------------------------------------------- what is here ----- */

/** One centre's day: stock on hand, what is coming, what sold, who bought it. */
centreRouter.get('/:id/today', h(async (req) => {
  const [w] = await query(req.actor,
    `SELECT w.*, u.full_name AS manager_name FROM warehouses w
       LEFT JOIN users u ON u.id = w.manager_user_id
      WHERE w.id = $1 AND w.company_id = $2`, [req.params.id, req.actor.companyId]);
  if (!w) throw ApiError.notFound('No such centre.');

  const [stock, incoming, salesToday, closes, customers] = await Promise.all([
    query(req.actor,
      `SELECT p.id AS product_id, p.name AS product_name, p.sku, p.icon, p.base_uom,
              SUM(sb.qty) AS qty, SUM(sb.qty - sb.reserved_qty) AS available,
              SUM(sb.qty * COALESCE(b.landed_rate,0)) AS value,
              MIN(COALESCE(b.predicted_expiry_date, b.expiry_date)) AS soonest_expiry,
              /* How much of it is in labelled boxes. A shop sells boxes, so
               * "30 kg" and "6 boxes of 5 kg" are different facts and the
               * second is the one behind the counter. */
              (SELECT count(*)::int FROM packs pk
                WHERE pk.warehouse_id = $1 AND pk.product_id = p.id
                  AND pk.status = 'IN_STOCK') AS boxes
         FROM stock_balances sb
         JOIN products p ON p.id = sb.product_id
         LEFT JOIN batches b ON b.id = sb.batch_id
        WHERE sb.warehouse_id = $1 AND sb.qty > 0
        GROUP BY p.id, p.name, p.sku, p.icon, p.base_uom
        ORDER BY p.name`, [w.id]),
    query(req.actor,
      `SELECT si.id, si.issue_no, si.issue_date, si.dispatched_at, si.total_qty,
              si.vehicle_reg, si.driver_name, si.transport_cost, si.status,
              (SELECT count(*)::int FROM packs pk
                WHERE pk.transfer_issue_id = si.id AND pk.status = 'IN_TRANSIT') AS boxes,
              sw.name AS from_warehouse,
              (SELECT string_agg(p.name || ' ' || round(sl.qty,1), ', ')
                 FROM stock_issue_lines sl JOIN products p ON p.id = sl.product_id
                WHERE sl.issue_id = si.id) AS contents
         FROM stock_issues si
         JOIN warehouses sw ON sw.id = si.warehouse_id
        WHERE si.dest_warehouse_id = $1 AND si.status = 'IN_TRANSIT'
        ORDER BY si.dispatched_at`, [w.id]),
    query(req.actor,
      `SELECT si.id, si.issue_no, si.total_qty, si.total_value, si.party_name,
              c.name AS customer_name, si.posted_at
         FROM stock_issues si
         LEFT JOIN customers c ON c.id = si.customer_id
        WHERE si.warehouse_id = $1 AND si.reason = 'SALE'
          AND si.status IN ('POSTED','RECEIVED')
          AND si.issue_date = CURRENT_DATE
        ORDER BY si.posted_at DESC`, [w.id]),
    query(req.actor,
      `SELECT * FROM centre_day_close WHERE warehouse_id = $1
        ORDER BY close_date DESC LIMIT 14`, [w.id]),
    query(req.actor,
      `SELECT c.id, c.name, c.phone, c.kind,
              COALESCE(s.orders, 0) AS orders, COALESCE(s.spent, 0) AS spent,
              s.last_bought
         FROM customers c
         LEFT JOIN (SELECT customer_id, count(*)::int AS orders,
                           SUM(total_value) AS spent, MAX(issue_date) AS last_bought
                      FROM stock_issues WHERE customer_id IS NOT NULL
                       AND status IN ('POSTED','RECEIVED')
                     GROUP BY customer_id) s ON s.customer_id = c.id
        WHERE c.warehouse_id = $1 AND c.is_active
        ORDER BY COALESCE(s.spent,0) DESC LIMIT 50`, [w.id]),
  ]);

  const soldToday = salesToday.reduce((a: number, s: any) => a + Number(s.total_qty), 0);
  const revenueToday = salesToday.reduce((a: number, s: any) => a + Number(s.total_value), 0);
  const closedToday = closes.some((c: any) => c.close_date === new Date().toISOString().slice(0, 10));

  return {
    centre: w, stock, incoming, salesToday, closes, customers,
    soldToday, revenueToday, closedToday,
  };
}));

/* ------------------------------------------------------------ transfers -- */

/**
 * Put the packed boxes on the lorry too.
 *
 * A batch that has been through the bench is not loose produce any more — it is
 * a stack of labelled boxes. Sending 30 kg of a batch packed into 5 kg boxes
 * means sending six of those boxes, not thirty anonymous kilos, and the label
 * on each has to end up where the box does or it is pointing at nothing.
 *
 * Whole boxes only. If the quantity asked for would have to break one open, the
 * transfer is refused with the nearest amount that would not — splitting a
 * sealed box is a thing that happens on a floor, not in a database, and if it
 * did happen the person doing it needs to repack and relabel anyway.
 */
async function moveBoxesOnto(
  tx: Tx, actor: Actor, issueId: string, fromWarehouseId: string,
  lines: { batchId: string; qty: number }[],
) {
  const moved: any[] = [];

  for (const l of lines) {
    const { rows: packs } = await tx.query(
      `SELECT p.id, p.code, p.qty, p.grade, p.price, pr.name AS product_name, pr.base_uom
         FROM packs p JOIN products pr ON pr.id = p.product_id
        WHERE p.company_id = $1 AND p.batch_id = $2 AND p.warehouse_id = $3
          AND p.status = 'IN_STOCK'
        ORDER BY p.created_at, p.pack_no
        FOR UPDATE OF p`,
      [actor.companyId, l.batchId, fromWarehouseId]);
    if (!packs.length) continue;   // nothing packed on this batch — loose stock

    /* Fill the lorry box by box, never past what was asked for. */
    const take: any[] = [];
    let taken = 0;
    for (const p of packs) {
      if (taken + Number(p.qty) > Number(l.qty) + 0.001) break;
      take.push(p);
      taken += Number(p.qty);
    }

    const remainder = Number(l.qty) - taken;
    if (remainder > 0.001) {
      /* Whatever is left has to come from produce that is not in a box. */
      const { rows: bal } = await tx.query(
        `SELECT sb.qty - sb.reserved_qty AS available,
                COALESCE((SELECT SUM(x.qty) FROM packs x
                           WHERE x.batch_id = sb.batch_id AND x.warehouse_id = sb.warehouse_id
                             AND x.status = 'IN_STOCK'), 0) AS packed
           FROM stock_balances sb
          WHERE sb.batch_id = $1 AND sb.warehouse_id = $2 AND sb.company_id = $3`,
        [l.batchId, fromWarehouseId, actor.companyId]);
      const loose = Number(bal[0]?.available ?? 0) - Number(bal[0]?.packed ?? 0);
      if (remainder > loose + 0.001) {
        const p0 = packs[0];
        const nextWhole = taken;
        const oneMore = taken + Number(p0.qty);
        throw ApiError.rule(
          `${p0.product_name} is packed into boxes of ${p0.qty} ${p0.base_uom}. `
          + `Sending ${l.qty} would mean breaking one open. `
          + `Send ${nextWhole} or ${oneMore} instead.`,
          { boxSize: Number(p0.qty), suggest: [nextWhole, oneMore] });
      }
    }

    if (!take.length) continue;

    const { rows: upd } = await tx.query(
      `UPDATE packs
          SET status = 'IN_TRANSIT', transfer_issue_id = $2, dispatched_at = now(),
              /* It has left the shelf. Leaving bin_id set would put a box on a
                 rack it is no longer on, and the audit team scans that rack. */
              bin_id = NULL, stored_at = NULL
        WHERE id = ANY($1::uuid[])
        RETURNING id, code, qty, grade, price`,
      [take.map((p) => p.id), issueId]);
    for (const p of upd) moved.push({ ...p, productName: take[0].product_name });
  }

  if (moved.length) {
    await emit(tx, actor, 'stock_issue', issueId, 'packs.dispatched',
      { boxes: moved.length, codes: moved.map((p) => p.code) });
  }
  return moved;
}


/**
 * Send stock to a centre.
 *
 * The stock leaves our warehouse now — that part is a normal issue and the
 * ledger records it. It does NOT arrive until somebody at the shop says so.
 * In between it is on a lorry, and a load that never turns up is visible
 * instead of looking exactly like one sitting on a shelf.
 */
centreRouter.post('/transfers', requires('inventory.stock.issue'), h(async (req) => {
  const i = body(z.object({
    idempotencyKey: z.string().min(8),
    fromWarehouseId: z.string().uuid(),
    toWarehouseId: z.string().uuid(),
    vehicleId: z.string().uuid().nullable().optional(),
    vehicleReg: z.string().trim().max(20).optional(),
    driverName: z.string().trim().max(80).optional(),
    transportCost: z.coerce.number().nonnegative().optional(),
    note: z.string().trim().max(300).optional(),
    lines: z.array(z.object({
      batchId: z.string().uuid(),
      qty: z.coerce.number().positive(),
    })).min(1, 'Nothing to send'),
  }), req.body);

  if (i.fromWarehouseId === i.toWarehouseId) {
    throw ApiError.rule('That is the same place. Pick where it is going.');
  }

  const { postIssue } = await import('./inventory.js');

  return withTx(req.actor, async (tx) => {
    const { rows: dest } = await tx.query(
      `SELECT id, name, branch_id, is_centre FROM warehouses
        WHERE id = $1 AND company_id = $2`, [i.toWarehouseId, req.actor.companyId]);
    if (!dest[0]) throw ApiError.notFound('No such destination.');

    /* The stock leaving is an ordinary issue, posted by the one function that
     * knows how to take stock off a shelf. Reimplementing that here is how two
     * code paths end up disagreeing about the ledger. */
    const issue: any = await postIssue(tx, req.actor, {
      idempotencyKey: i.idempotencyKey,
      warehouseId: i.fromWarehouseId,
      reason: 'TRANSFER_OUT',
      partyName: dest[0].name,
      note: i.note ?? `To ${dest[0].name}`,
      lines: i.lines,
    } as any);

    await tx.query(
      `UPDATE stock_issues
          SET dest_warehouse_id = $2, vehicle_id = $3, vehicle_reg = $4,
              driver_name = $5, transport_cost = $6,
              dispatched_at = now(), status = 'IN_TRANSIT'
        WHERE id = $1`,
      [issue.id, i.toWarehouseId, i.vehicleId ?? null, i.vehicleReg ?? null,
       i.driverName ?? null, i.transportCost ?? null]);

    /* The boxes go with the produce.
     *
     * A pack is a physical box with a label on it. Moving the quantity and
     * leaving the boxes behind left the warehouse holding labels for produce
     * that had gone, and gave the shop loose kilos it could not sell as the
     * 5 kg boxes it had actually been handed. */
    const boxes = await moveBoxesOnto(tx, req.actor, issue.id, i.fromWarehouseId, i.lines);

    /* "the cost of that transport, every single expense will be recorded" —
     * so it goes to Finance as a claim like any other rather than being a
     * number typed on a transfer and never paid by anyone. */
    if (i.transportCost && i.transportCost > 0) {
      const { rows: cat } = await tx.query(
        `SELECT id FROM expense_categories WHERE company_id=$1 AND code='TRANSPORT'`,
        [req.actor.companyId]);
      await createRequest(tx, req.actor, {
        kind: 'TRANSPORT',
        amount: i.transportCost,
        payeeName: i.driverName || i.vehicleReg || 'Transport',
        branchId: dest[0].branch_id,
        expenseCategoryId: cat[0]?.id ?? null,
        warehouseId: i.toWarehouseId,
        note: `${issue.issue_no} to ${dest[0].name}`,
        sourceType: 'stock_issue',
        sourceId: issue.id,
        systemRaised: true,
      });
    }

    await pushTask(tx, req.actor, {
      branchId: dest[0].branch_id, warehouseId: i.toWarehouseId,
      queueKey: 'EXPECTED_ARRIVAL', docType: 'ISS', docId: issue.id, docNo: issue.issue_no,
      title: `Stock on its way to ${dest[0].name}`,
      subtitle: i.vehicleReg ? `Vehicle ${i.vehicleReg}` : 'Confirm when it arrives',
      requiredPermission: 'centre.stock.receive', slaMinutes: 720,
    });

    await emit(tx, req.actor, 'stock_issue', issue.id, 'transfer.dispatched', {
      issueNo: issue.issue_no, to: dest[0].name, vehicleReg: i.vehicleReg ?? null,
    });

    return { ...issue, status: 'IN_TRANSIT', destination: dest[0].name, boxes,
      message: `${issue.issue_no} on its way to ${dest[0].name}`
        + (boxes.length ? `, with ${boxes.length} packed box(es).` : '.') };
  });
}));

/**
 * "It arrived." — and how much of it did.
 *
 * The centre confirms per line, because the whole reason for tracking transit
 * is that what leaves and what lands are not always the same number. Only what
 * is confirmed becomes the shop's stock; the difference is a loss on the trip,
 * recorded against the transfer and alerted.
 */
centreRouter.post('/transfers/:id/receive', requires('centre.stock.receive'), h(async (req) => {
  const i = body(z.object({
    note: z.string().trim().max(300).optional(),
    lines: z.array(z.object({
      lineId: z.string().uuid(),
      receivedQty: z.coerce.number().nonnegative(),
    })).optional(),
  }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    const { rows: hdr } = await tx.query(
      `SELECT si.*, w.name AS dest_name, w.branch_id AS dest_branch
         FROM stock_issues si
         JOIN warehouses w ON w.id = si.dest_warehouse_id
        WHERE si.id = $1 AND si.company_id = $2 FOR UPDATE OF si`,
      [req.params.id, req.actor.companyId]);
    const issue = hdr[0];
    if (!issue) throw ApiError.notFound('No such transfer.');
    if (issue.status !== 'IN_TRANSIT') {
      throw ApiError.rule(issue.status === 'RECEIVED'
        ? 'This load has already been booked in.'
        : `This transfer is ${String(issue.status).toLowerCase()}.`);
    }

    const { rows: lines } = await tx.query(
      `SELECT sl.*, p.base_uom, p.name AS product_name
         FROM stock_issue_lines sl JOIN products p ON p.id = sl.product_id
        WHERE sl.issue_id = $1`, [issue.id]);

    const wanted = new Map((i.lines ?? []).map((l) => [l.lineId, Number(l.receivedQty)]));
    let shortage = 0;
    const shortLines: string[] = [];

    for (const l of lines) {
      const got = wanted.has(l.id) ? wanted.get(l.id)! : Number(l.qty);
      if (got > Number(l.qty) + 0.001) {
        throw ApiError.rule(
          `${l.product_name}: ${got} arrived but only ${l.qty} was sent. Check the paperwork.`);
      }
      if (got > 0) {
        await tx.query(
          `INSERT INTO stock_ledger (company_id, branch_id, warehouse_id, product_id, batch_id,
                  direction, qty, weight_kg, uom, rate, value, txn_type, ref_type, ref_id,
                  ref_line_id, posted_at, posted_by)
           VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,$8,$9,$10,'TRANSFER_IN','stock_transfer_in',$11,$12,now(),$13)`,
          [req.actor.companyId, issue.dest_branch, issue.dest_warehouse_id, l.product_id,
           l.batch_id, got, l.weight_kg, l.uom, l.rate, money(Number(l.rate) * got),
           issue.id, l.id, req.actor.userId]);

        await tx.query(
          `INSERT INTO stock_balances (company_id, warehouse_id, product_id, batch_id,
                  qty, reserved_qty, weight_kg)
           VALUES ($1,$2,$3,$4,$5,0,$6)
           ON CONFLICT (product_id, batch_id, warehouse_id) DO UPDATE
             SET qty = stock_balances.qty + EXCLUDED.qty,
                 weight_kg = stock_balances.weight_kg + COALESCE(EXCLUDED.weight_kg,0),
                 updated_at = now()`,
          [req.actor.companyId, issue.dest_warehouse_id, l.product_id, l.batch_id,
           got, l.weight_kg]);
      }
      const missing = Number(l.qty) - got;
      if (missing > 0.001) { shortage += missing; shortLines.push(`${l.product_name} ${missing}`); }
    }

    if (shortage > 0.001 && !i.note) {
      throw ApiError.rule(
        `${shortLines.join(', ')} did not arrive. Say what happened before booking this in.`);
    }

    await tx.query(
      `UPDATE stock_issues SET status='RECEIVED', received_at=now(), received_by=$2,
              received_note=$3 WHERE id=$1`,
      [issue.id, req.actor.userId, i.note ?? null]);

    /* The boxes arrive with it — but only as many as were counted in.
     *
     * They keep their code, their grade and their price: it is the same box, on
     * a different shelf in a different town. They do not keep their bin, because
     * the rack they were on belongs to the warehouse they have left; the shop
     * scans them onto its own.
     *
     * Boxes covered by the shortfall never turned up. Marking them arrived
     * would recreate exactly the drift this whole change is about, so they are
     * voided against the note the shop had to write. */
    const arrived: any[] = [];
    const lost: any[] = [];
    for (const l of lines) {
      const { rows: inTransit } = await tx.query(
        `SELECT id, code, qty, grade FROM packs
          WHERE transfer_issue_id = $1 AND status = 'IN_TRANSIT' AND batch_id = $2
          ORDER BY created_at, pack_no
          FOR UPDATE`,
        [issue.id, l.batch_id]);
      if (!inTransit.length) continue;

      const got = wanted.has(l.id) ? wanted.get(l.id)! : Number(l.qty);
      const keep: string[] = [];
      const drop: string[] = [];
      let counted = 0;
      for (const p of inTransit) {
        if (counted + Number(p.qty) <= got + 0.001) {
          keep.push(p.id); counted += Number(p.qty); arrived.push(p);
        } else {
          drop.push(p.id); lost.push(p);
        }
      }

      if (keep.length) {
        await tx.query(
          `UPDATE packs
              SET warehouse_id = $2, status = 'IN_STOCK',
                  transfer_issue_id = NULL, dispatched_at = NULL,
                  bin_id = NULL, stored_at = NULL
            WHERE id = ANY($1::uuid[])`,
          [keep, issue.dest_warehouse_id]);
      }
      if (drop.length) {
        await tx.query(
          `UPDATE packs
              SET status = 'VOID', transfer_issue_id = NULL, dispatched_at = NULL,
                  void_reason = $2
            WHERE id = ANY($1::uuid[])`,
          [drop, `Did not arrive at ${issue.dest_name}: ${i.note ?? 'no reason given'}`]);
      }
    }

    if (shortage > 0.001) {
      await raiseAlert(tx, req.actor, {
        alertType: 'TRANSFER_SHORT', severity: 'HIGH', branchId: issue.dest_branch,
        entityType: 'stock_issue', entityId: issue.id,
        title: `${issue.issue_no}: ${shortLines.join(', ')} short on arrival`,
        message: `${issue.dest_name} booked in less than was sent. ${i.note}`,
      });
    }

    await emit(tx, req.actor, 'stock_issue', issue.id, 'transfer.received',
      { issueNo: issue.issue_no, shortage });

    const withBoxes = arrived.length
      ? ` ${arrived.length} box(es) came with it`
        + (lost.length
          ? `, ${lost.length} did not and ${lost.length === 1 ? 'has' : 'have'} been written off.`
          : '.')
      : '';
    return {
      ok: true, issueNo: issue.issue_no, shortage, boxes: arrived, boxesLost: lost,
      message: (shortage > 0.001
        ? `Booked in, ${shortLines.join(', ')} short. The buyer has been told.`
        : `${issue.issue_no} booked in at ${issue.dest_name}.`) + withBoxes,
    };
  });
}));

/* ------------------------------------------------------------ customers -- */

centreRouter.get('/customers/list', h(async (req) =>
  query(req.actor,
    `SELECT c.*, w.name AS centre_name,
            COALESCE(s.orders,0) AS orders, COALESCE(s.spent,0) AS spent, s.last_bought
       FROM customers c
       LEFT JOIN warehouses w ON w.id = c.warehouse_id
       LEFT JOIN (SELECT customer_id, count(*)::int AS orders, SUM(total_value) AS spent,
                         MAX(issue_date) AS last_bought
                    FROM stock_issues WHERE customer_id IS NOT NULL
                     AND status IN ('POSTED','RECEIVED')
                   GROUP BY customer_id) s ON s.customer_id = c.id
      WHERE c.company_id = $1 AND c.is_active
        AND ($2::uuid IS NULL OR c.warehouse_id = $2)
        AND ($3 = '' OR c.name ILIKE '%' || $3 || '%' OR c.phone ILIKE '%' || $3 || '%')
      ORDER BY COALESCE(s.spent,0) DESC, c.name LIMIT 200`,
    [req.actor.companyId, req.query.warehouseId || null, String(req.query.q ?? '')])));

/** Added from the dropdown at the till, because that is when you meet them. */
centreRouter.post('/customers', requires('master.customer.manage'), h(async (req) => {
  const i = body(z.object({
    name: z.string().trim().min(1, "What is the customer's name?").max(80),
    phone: z.string().trim().max(20).optional(),
    kind: z.enum(['WALK_IN', 'SHOP', 'HOTEL', 'WHOLESALER', 'INSTITUTION', 'ONLINE'])
      .default('WALK_IN'),
    warehouseId: z.string().uuid().nullable().optional(),
    gstin: z.string().trim().max(20).optional(),
    address: z.string().trim().max(200).optional(),
    creditLimit: z.coerce.number().nonnegative().default(0),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO customers (company_id, warehouse_id, name, phone, kind, gstin,
              address, credit_limit, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.actor.companyId, i.warehouseId ?? null, i.name, i.phone ?? null, i.kind,
       i.gstin ?? null, i.address ?? null, i.creditLimit, req.actor.userId]);
    return { ...rows[0], message: `${i.name} added.` };
  });
}));

/* --------------------------------------------------------- the day close -- */

/** What the system thinks happened today, ready for the person to disagree. */
centreRouter.get('/:id/day-close-draft', h(async (req) => {
  const [d] = await query(req.actor,
    `SELECT COALESCE(SUM(total_qty),0)   AS system_qty,
            COALESCE(SUM(total_value),0) AS system_revenue,
            count(*)::int                AS bills
       FROM stock_issues
      WHERE warehouse_id = $1 AND reason = 'SALE'
        AND status IN ('POSTED','RECEIVED') AND issue_date = COALESCE($2::date, CURRENT_DATE)`,
    [req.params.id, req.query.date || null]);

  const [already] = await query(req.actor,
    `SELECT * FROM centre_day_close
      WHERE warehouse_id = $1 AND close_date = COALESCE($2::date, CURRENT_DATE)`,
    [req.params.id, req.query.date || null]);

  return { ...d, alreadyClosed: already ?? null };
}));

/**
 * Closing the day.
 *
 * The system's figure is frozen into the row next to the person's declared one.
 * The gap between them is the finding, and it cannot drift afterwards — which
 * it would if the variance were recomputed from live sales every time somebody
 * opened the report.
 */
centreRouter.post('/:id/day-close', requires('centre.day.close'), h(async (req) => {
  const i = body(z.object({
    closeDate: z.string().optional(),
    declaredQty: z.coerce.number().nonnegative().default(0),
    declaredRevenue: z.coerce.number().nonnegative(),
    cashAmount: z.coerce.number().nonnegative().default(0),
    onlineAmount: z.coerce.number().nonnegative().default(0),
    expenses: z.coerce.number().nonnegative().default(0),
    wastageQty: z.coerce.number().nonnegative().default(0),
    note: z.string().trim().max(500).optional(),
    /* Declaring the takings and handing the money over are the same act at a
     * shop counter, so this raises the receipt Finance will confirm. */
    declareToFinance: z.boolean().default(true),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows: w } = await tx.query(
      `SELECT id, name, branch_id FROM warehouses WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.actor.companyId]);
    if (!w[0]) throw ApiError.notFound('No such centre.');

    const date = i.closeDate ?? new Date().toISOString().slice(0, 10);
    const { rows: sys } = await tx.query(
      `SELECT COALESCE(SUM(total_qty),0) AS qty, COALESCE(SUM(total_value),0) AS revenue
         FROM stock_issues
        WHERE warehouse_id=$1 AND reason='SALE' AND status IN ('POSTED','RECEIVED')
          AND issue_date=$2::date`, [w[0].id, date]);

    /* Closing the same day twice is a correction, not a second day's takings.
     * The first version of this inserted a fresh receipt each time and collided
     * on the receipt number — so a centre that miscounted could not fix it. */
    const { rows: prior } = await tx.query(
      `SELECT c.id, c.receipt_id, r.status AS receipt_status
         FROM centre_day_close c
         LEFT JOIN money_receipts r ON r.id = c.receipt_id
        WHERE c.warehouse_id = $1 AND c.close_date = $2::date`, [w[0].id, date]);

    let receiptId: string | null = prior[0]?.receipt_id ?? null;
    const handedOver = money(i.cashAmount + i.onlineAmount);
    const mode = i.cashAmount >= i.onlineAmount ? 'CASH' : 'UPI';

    if (i.declareToFinance && handedOver > 0) {
      if (receiptId && prior[0].receipt_status === 'DECLARED') {
        await tx.query(
          `UPDATE money_receipts SET amount=$2, mode=$3, updated_by=$4, updated_at=now()
            WHERE id=$1`, [receiptId, handedOver, mode, req.actor.userId]);
      } else if (receiptId) {
        /* Finance has already confirmed what landed. Changing the declaration
         * now would rewrite a fact they checked, so the correction stands in
         * the close and the receipt is left alone for them to reconcile. */
        await raiseAlert(tx, req.actor, {
          alertType: 'CENTRE_CLOSE_AMENDED', severity: 'MEDIUM',
          branchId: w[0].branch_id, entityType: 'money_receipt', entityId: receiptId,
          title: `${w[0].name} changed its ${date} declaration after Finance confirmed it`,
          message: `Now declaring ${handedOver}. ${i.note ?? ''}`,
        });
      } else {
        const { rows: r } = await tx.query(
          `INSERT INTO money_receipts (company_id, branch_id, receipt_no, source, payer_name,
                  warehouse_id, amount, mode, received_on, note, declared_by, created_by, updated_by)
           VALUES ($1,$2,$3,'CENTRE',$4,$5,$6,$7,$8::date,$9,$10,$10,$10)
           RETURNING id`,
          [req.actor.companyId, w[0].branch_id,
           `RCP-${date}-${String(w[0].code ?? w[0].id).slice(0, 8)}`,
           w[0].name, w[0].id, handedOver, mode, date,
           `Day close ${date}`, req.actor.userId]);
        receiptId = r[0]?.id ?? null;
      }
    }

    const { rows } = await tx.query(
      `INSERT INTO centre_day_close (company_id, warehouse_id, close_date,
              system_qty, system_revenue, declared_qty, declared_revenue,
              cash_amount, online_amount, expenses, wastage_qty, note, closed_by, receipt_id)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (warehouse_id, close_date) DO UPDATE
         SET declared_qty = EXCLUDED.declared_qty,
             declared_revenue = EXCLUDED.declared_revenue,
             cash_amount = EXCLUDED.cash_amount,
             online_amount = EXCLUDED.online_amount,
             expenses = EXCLUDED.expenses,
             wastage_qty = EXCLUDED.wastage_qty,
             note = EXCLUDED.note, closed_by = EXCLUDED.closed_by, closed_at = now(),
             receipt_id = COALESCE(centre_day_close.receipt_id, EXCLUDED.receipt_id)
       RETURNING *`,
      [req.actor.companyId, w[0].id, date, sys[0].qty, sys[0].revenue,
       i.declaredQty, i.declaredRevenue, i.cashAmount, i.onlineAmount,
       i.expenses, i.wastageQty, i.note ?? null, req.actor.userId, receiptId]);
    const close = rows[0];

    const variance = Number(close.variance);
    if (Math.abs(variance) > 0.01) {
      await raiseAlert(tx, req.actor, {
        alertType: 'CENTRE_DAY_VARIANCE',
        severity: Math.abs(variance) > Number(sys[0].revenue) * 0.05 ? 'HIGH' : 'MEDIUM',
        branchId: w[0].branch_id, entityType: 'centre_day_close', entityId: close.id,
        title: `${w[0].name} ${date}: declared ${i.declaredRevenue}, system says ${sys[0].revenue}`,
        message: `${variance > 0 ? 'More' : 'Less'} than the bills by ${Math.abs(variance)}. ${i.note ?? ''}`,
      });
    }

    await emit(tx, req.actor, 'centre_day_close', close.id, 'centre.day.closed',
      { centre: w[0].name, date, declared: i.declaredRevenue, system: sys[0].revenue });

    return {
      ...close,
      message: Math.abs(variance) < 0.01
        ? `${w[0].name} closed for ${date}. Everything ties.`
        : `${w[0].name} closed for ${date} — ${variance > 0 ? 'over' : 'short'} by ${Math.abs(variance)}.`,
    };
  });
}));

/* -------------------------------------------------------- how they compare */

centreRouter.get('/performance', requires('centre.performance.view'), h(async (req) => {
  const days = Math.min(Number(req.query.days ?? 30), 365);

  const rows = await query(req.actor,
    `SELECT w.id, w.name, w.city, w.monthly_rent,
            COALESCE(s.bills, 0)     AS bills,
            COALESCE(s.qty, 0)       AS qty_sold,
            COALESCE(s.revenue, 0)   AS revenue,
            COALESCE(s.cogs, 0)      AS cogs,
            COALESCE(s.revenue, 0) - COALESCE(s.cogs, 0) AS margin,
            COALESCE(t.sent, 0)      AS qty_sent,
            COALESCE(t.transport, 0) AS transport_cost,
            COALESCE(e.expenses, 0)  AS expenses,
            COALESCE(waste.qty, 0)   AS wastage,
            COALESCE(st.qty, 0)      AS stock_now,
            (SELECT count(*)::int FROM customers c
              WHERE c.warehouse_id = w.id AND c.is_active) AS customers,
            (SELECT count(*)::int FROM centre_day_close d
              WHERE d.warehouse_id = w.id AND d.close_date > CURRENT_DATE - $2::int) AS days_closed,
            COALESCE((SELECT SUM(abs(d.variance)) FROM centre_day_close d
                       WHERE d.warehouse_id = w.id
                         AND d.close_date > CURRENT_DATE - $2::int), 0) AS cash_variance
       FROM warehouses w
       LEFT JOIN (SELECT si.warehouse_id, count(*)::int AS bills,
                         SUM(si.total_qty) AS qty, SUM(si.total_value) AS revenue,
                         SUM((SELECT COALESCE(SUM(sl.qty * COALESCE(b.landed_rate,0)),0)
                                FROM stock_issue_lines sl
                                LEFT JOIN batches b ON b.id = sl.batch_id
                               WHERE sl.issue_id = si.id)) AS cogs
                    FROM stock_issues si
                   WHERE si.reason='SALE' AND si.status IN ('POSTED','RECEIVED')
                     AND si.issue_date > CURRENT_DATE - $2::int
                   GROUP BY si.warehouse_id) s ON s.warehouse_id = w.id
       LEFT JOIN (SELECT dest_warehouse_id, SUM(total_qty) AS sent,
                         SUM(COALESCE(transport_cost,0)) AS transport
                    FROM stock_issues
                   WHERE dest_warehouse_id IS NOT NULL
                     AND issue_date > CURRENT_DATE - $2::int
                   GROUP BY dest_warehouse_id) t ON t.dest_warehouse_id = w.id
       LEFT JOIN (SELECT warehouse_id, SUM(paid_amount) AS expenses
                    FROM payment_requests
                   WHERE warehouse_id IS NOT NULL AND paid_amount > 0
                     AND requested_at > now() - ($2::int || ' days')::interval
                   GROUP BY warehouse_id) e ON e.warehouse_id = w.id
       LEFT JOIN (SELECT warehouse_id, SUM(total_qty) AS qty FROM stock_issues
                   WHERE reason='WASTAGE' AND issue_date > CURRENT_DATE - $2::int
                   GROUP BY warehouse_id) waste ON waste.warehouse_id = w.id
       LEFT JOIN (SELECT warehouse_id, SUM(qty) AS qty FROM stock_balances
                   GROUP BY warehouse_id) st ON st.warehouse_id = w.id
      WHERE w.company_id = $1 AND w.is_centre AND w.is_active
      ORDER BY COALESCE(s.revenue,0) DESC`,
    [req.actor.companyId, days]);

  /* Ranking belongs here, not in each screen that shows it — otherwise the
   * dashboard and the report can rank the same centres differently. */
  const ranked = rows.map((r: any, n: number) => ({
    ...r,
    rank: n + 1,
    /* What is actually left after the shop has paid for itself. Revenue alone
     * flatters a centre with high rent and heavy wastage. */
    netMargin: money(Number(r.margin) - Number(r.expenses) - Number(r.transport_cost)),
    sellThrough: Number(r.qty_sent) > 0
      ? Math.round((Number(r.qty_sold) / Number(r.qty_sent)) * 1000) / 10 : null,
  }));

  return { days, centres: ranked };
}));
