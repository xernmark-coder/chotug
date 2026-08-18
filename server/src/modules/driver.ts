import { Router } from 'express';
import { z } from 'zod';
import { pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit, pushTask, resolveTask } from '../platform/services.js';

/* ===========================================================================
 * DRIVER APP
 *
 * Outside users, same shape as the supplier portal: scoped on the server by
 * the driver_id on their own user row, never by a parameter they send.
 *
 * A driver sees two things — jobs going spare, and their own jobs. Everything
 * they do to a pickup is a state transition the buyer and the gate can watch.
 * ======================================================================== */

export const driverRouter = Router();
driverRouter.use(authenticate);
driverRouter.use(requires('driver.portal.access'));

/** A malformed id in the URL is a 404, not a 500 from the uuid cast. */
function uuidParam(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw ApiError.notFound('No such pickup');
  }
  return s;
}

async function myDriver(actor: any): Promise<string> {
  const { rows } = await pool.query(`SELECT driver_id FROM users WHERE id = $1`, [actor.userId]);
  const id = rows[0]?.driver_id;
  if (!id) {
    throw ApiError.forbidden(
      'This login is not linked to a driver. Ask the person who invited you to set it up again.');
  }
  return id;
}

const PICKUP_COLUMNS = `
  p.id, p.pickup_no, p.status, p.pickup_on, p.window_start, p.window_end,
  p.pickup_address, p.notes, p.reported_crates,
  s.trade_name AS supplier_name, s.phone AS supplier_phone,
  o.po_no, o.expected_date,
  w.name AS warehouse_name,
  b.name AS branch_name,
  (SELECT count(*) FROM po_lines l WHERE l.po_id = o.id) AS item_count`;

driverRouter.get('/me', h(async (req) => {
  const driverId = await myDriver(req.actor);
  const [d] = await query(req.actor,
    `SELECT d.id, d.full_name, d.phone, d.status, c.trade_name AS company_name
       FROM drivers d JOIN companies c ON c.id = d.company_id
      WHERE d.id = $1 AND d.company_id = $2`, [driverId, req.actor.companyId]);
  if (!d) throw ApiError.notFound('Driver not found');
  return d;
}));

/** Jobs nobody has taken yet, plus everything already mine. */
driverRouter.get('/pickups', requires('driver.pickup.view'), h(async (req) => {
  const driverId = await myDriver(req.actor);
  const offered = await query(req.actor,
    `SELECT ${PICKUP_COLUMNS}
       FROM pickups p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN purchase_orders o ON o.id = p.po_id
       JOIN branches b ON b.id = p.branch_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
      WHERE p.company_id = $1 AND p.status = 'OFFERED' AND p.driver_id IS NULL
      ORDER BY p.pickup_on, p.window_start NULLS LAST LIMIT 50`,
    [req.actor.companyId]);

  const mine = await query(req.actor,
    `SELECT ${PICKUP_COLUMNS}
       FROM pickups p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN purchase_orders o ON o.id = p.po_id
       JOIN branches b ON b.id = p.branch_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
      WHERE p.company_id = $1 AND p.driver_id = $2
        AND p.status <> 'CANCELLED'
      ORDER BY (p.status = 'DELIVERED'), p.pickup_on DESC LIMIT 50`,
    [req.actor.companyId, driverId]);

  return { offered, mine };
}));

/** Take a job that is going spare. First to accept gets it. */
driverRouter.post('/pickups/:id/accept', requires('driver.pickup.update'), h(async (req) => {
  const driverId = await myDriver(req.actor);
  return withTx(req.actor, async (tx) => {
    /* The WHERE clause is the race condition's answer: two drivers tapping at
     * once, only the row still OFFERED and unassigned updates. */
    const { rows } = await tx.query(
      `UPDATE pickups
          SET driver_id = $3, status = 'ASSIGNED', assigned_at = now(),
              accepted_at = now(), updated_by = $4, updated_at = now()
        WHERE id = $1 AND company_id = $2 AND status = 'OFFERED' AND driver_id IS NULL
        RETURNING *`,
      [uuidParam(req.params.id), req.actor.companyId, driverId, req.actor.userId]);
    if (!rows.length) {
      throw ApiError.conflict('Somebody else has already taken that one.');
    }
    await emit(tx, req.actor, 'pickup', rows[0].id, 'pickup.accepted',
      { pickupNo: rows[0].pickup_no, driverId });
    return { ok: true, status: 'ASSIGNED' };
  });
}));

const DRIVER_FLOW: Record<string, string> = {
  'start':   'EN_ROUTE',
  'loaded':  'LOADED',
  'delivered': 'DELIVERED',
};
const ALLOWED_FROM: Record<string, string[]> = {
  EN_ROUTE:  ['ASSIGNED'],
  LOADED:    ['EN_ROUTE', 'ASSIGNED'],
  DELIVERED: ['LOADED'],
};

/** Progress. Each step is a fact the buyer and the gate can act on. */
driverRouter.post('/pickups/:id/:step', requires('driver.pickup.update'), h(async (req) => {
  const target = DRIVER_FLOW[String(req.params.step)];
  if (!target) throw ApiError.notFound('No such step');
  const input = body(z.object({
    crates: z.coerce.number().int().nonnegative().nullable().optional(),
    note: z.string().trim().optional(),
  }), req.body ?? {});

  const driverId = await myDriver(req.actor);
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `SELECT p.*, s.trade_name AS supplier_name, o.po_no
         FROM pickups p
         JOIN suppliers s ON s.id = p.supplier_id
         JOIN purchase_orders o ON o.id = p.po_id
        WHERE p.id = $1 AND p.company_id = $2 AND p.driver_id = $3 FOR UPDATE OF p`,
      [uuidParam(req.params.id), req.actor.companyId, driverId]);
    const p = rows[0];
    if (!p) throw ApiError.notFound('That pickup is not one of yours.');
    if (!ALLOWED_FROM[target].includes(p.status)) {
      throw ApiError.rule(`A pickup that is ${p.status.toLowerCase().replace('_', ' ')} cannot be marked ${target.toLowerCase().replace('_', ' ')}.`);
    }

    const stamp = { EN_ROUTE: 'en_route_at', LOADED: 'loaded_at', DELIVERED: 'delivered_at' }[target]!;
    await tx.query(
      `UPDATE pickups SET status=$2, ${stamp}=now(),
              reported_crates = COALESCE($3, reported_crates),
              reported_note = COALESCE($4, reported_note),
              updated_by=$5, updated_at=now()
        WHERE id=$1`,
      [p.id, target, input.crates ?? null, input.note ?? null, req.actor.userId]);

    /* The gate needs to know a vehicle is on its way, and needs it before the
     * vehicle is at the barrier — that is the whole point of the driver app. */
    if (target === 'LOADED') {
      await pushTask(tx, req.actor, {
        branchId: p.branch_id, warehouseId: p.warehouse_id,
        queueKey: 'EXPECTED_ARRIVAL', docType: 'PICKUP', docId: p.id, docNo: p.pickup_no,
        title: `${p.po_no} loaded and on the way`,
        subtitle: `From ${p.supplier_name}`
          + (input.crates ? ` · driver reports ${input.crates} crate(s)` : ''),
        severity: 'normal',
        requiredPermission: 'receiving.gate.create',
      });
    }
    if (target === 'DELIVERED') {
      await resolveTask(tx, req.actor, 'EXPECTED_ARRIVAL', 'PICKUP', p.id);
    }

    await emit(tx, req.actor, 'pickup', p.id, `pickup.${target.toLowerCase()}`,
      { pickupNo: p.pickup_no, crates: input.crates ?? null });
    return { ok: true, status: target };
  });
}));
