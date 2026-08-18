import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config, pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, loadActor, requires, signToken, verifyPassword, hashPassword } from '../platform/auth.js';
import { encryptSecret, inviteEmail, loadSmtp, sendMail, sendTestMail } from '../platform/mailer.js';
import { emit } from '../platform/services.js';

export const authRouter = Router();

authRouter.post('/login', h(async (req) => {
  const input = body(z.object({
    email: z.string().min(3, 'Enter your email or phone'),
    password: z.string().min(1, 'Enter your password'),
  }), req.body);

  const { rows } = await pool.query(
    `SELECT id, password_hash, status, locked_until, failed_login_count
       FROM users WHERE lower(email) = lower($1) OR phone = $1 LIMIT 1`,
    [input.email.trim()],
  );
  const u = rows[0];
  const fail = () => { throw ApiError.unauthorized('Email or password is not correct'); };
  if (!u) fail();
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw ApiError.forbidden('This account is temporarily locked. Try again later.');
  }

  const ok = await verifyPassword(input.password, u.password_hash);
  if (!ok) {
    await pool.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= 5
                                  THEN now() + interval '15 minutes' ELSE locked_until END
        WHERE id = $1`, [u.id]);
    fail();
  }
  if (u.status !== 'ACTIVE') throw ApiError.forbidden('This account is not active.');

  await pool.query(
    `UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
    [u.id]);

  const actor = await loadActor(u.id);
  if (!actor) fail();
  return { token: signToken(actor!.userId, actor!.companyId), user: await profile(actor!.userId) };
}));

async function profile(userId: string) {
  const actor = await loadActor(userId);
  if (!actor) throw ApiError.unauthorized();
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.employee_code, u.locale, u.default_branch_id,
            c.trade_name AS company_name,
            (SELECT json_agg(json_build_object('id',b.id,'code',b.code,'name',b.name,'type',b.type)
                             ORDER BY b.code)
               FROM branches b WHERE b.company_id = u.company_id AND b.is_active) AS branches,
            (SELECT json_agg(json_build_object('id',w.id,'code',w.code,'name',w.name,'branchId',w.branch_id)
                             ORDER BY w.code)
               FROM warehouses w WHERE w.company_id = u.company_id AND w.is_active) AS warehouses
       FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  return {
    id: r.id, fullName: r.full_name, email: r.email, employeeCode: r.employee_code,
    locale: r.locale, companyName: r.company_name,
    defaultBranchId: r.default_branch_id,
    branches: r.branches ?? [], warehouses: r.warehouses ?? [],
    roles: actor.roleCodes, permissions: [...actor.permissions], limits: actor.limits,
  };
}

authRouter.get('/me', authenticate, h(async (req) => profile(req.actor.userId)));

authRouter.post('/change-password', authenticate, h(async (req) => {
  const input = body(z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, 'Use at least 8 characters'),
  }), req.body);
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.actor.userId]);
  if (!(await verifyPassword(input.currentPassword, rows[0]?.password_hash))) {
    throw ApiError.badRequest('Your current password is not correct');
  }
  await pool.query(
    'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1',
    [req.actor.userId, await hashPassword(input.newPassword)]);
  return { ok: true };
}));

/* ------------------------------------------------------- invite tokens --- */

const INVITE_TTL_DAYS = 7;

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** The link the invited person opens. WEB_ORIGIN may hold a comma-separated
 *  list for CORS; the first entry is the canonical site. */
export function inviteUrl(rawToken: string) {
  const origin = config.webOrigin.split(',')[0].trim().replace(/\/$/, '');
  return `${origin}/accept-invite?token=${rawToken}`;
}

/** Issues a fresh token and retires any earlier unused one for that user, so a
 *  re-send always invalidates the link that was sent before it. */
export async function issueInvite(userId: string, createdBy: string | null) {
  const raw = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM user_invites WHERE user_id = $1 AND accepted_at IS NULL', [userId]);
  await pool.query(
    `INSERT INTO user_invites (user_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [userId, hashToken(raw), String(INVITE_TTL_DAYS), createdBy],
  );
  return { token: raw, url: inviteUrl(raw) };
}

async function findInvite(rawToken: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.user_id, i.expires_at, i.accepted_at,
            u.full_name, u.email, u.status, u.company_id,
            c.trade_name AS company_name,
            (SELECT r.name FROM user_role_assignments ura
               JOIN roles r ON r.id = ura.role_id
              WHERE ura.user_id = u.id ORDER BY ura.created_at LIMIT 1) AS role_name
       FROM user_invites i
       JOIN users u     ON u.id = i.user_id
       JOIN companies c ON c.id = u.company_id
      WHERE i.token_hash = $1`,
    [hashToken(rawToken)],
  );
  const inv = rows[0];
  // One message for every failure mode on purpose: a stranger poking at tokens
  // learns nothing about which ones exist.
  const dead = () => {
    throw ApiError.badRequest('This invite link is no longer valid. Ask your admin to send a new one.');
  };
  if (!inv) dead();
  if (inv.accepted_at) dead();
  if (new Date(inv.expires_at) <= new Date()) dead();
  if (inv.status !== 'INVITED') dead();
  return inv;
}

/** Public — the invited person has no account yet, so this cannot be gated. */
authRouter.get('/invite/:token', h(async (req) => {
  const inv = await findInvite(String(req.params.token));
  return {
    fullName: inv.full_name,
    email: inv.email,
    companyName: inv.company_name,
    roleName: inv.role_name,
  };
}));

authRouter.post('/invite/:token/accept', h(async (req) => {
  const input = body(z.object({
    password: z.string().min(8, 'Use at least 8 characters'),
  }), req.body);

  const inv = await findInvite(String(req.params.token));
  const hash = await hashPassword(input.password);

  await withTx({ companyId: inv.company_id, userId: inv.user_id }, async (tx) => {
    await tx.query(
      `UPDATE users
          SET password_hash = $2, password_changed_at = now(), status = 'ACTIVE',
              failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [inv.user_id, hash],
    );
    await tx.query('UPDATE user_invites SET accepted_at = now() WHERE id = $1', [inv.id]);
  });

  // Sign them straight in — making someone log in again immediately after
  // choosing a password is a step that exists only for the developer.
  const actor = await loadActor(inv.user_id);
  if (!actor) throw ApiError.badRequest('This account is not active yet. Ask your admin.');
  return { token: signToken(actor.userId, actor.companyId), user: await profile(actor.userId) };
}));

/* ======================================================================== */

export const mastersRouter = Router();
mastersRouter.use(authenticate);
// Outside supplier logins never reach staff data — see staffOnly().
mastersRouter.use(staffOnly);

mastersRouter.get('/products', h(async (req) => {
  const search = String(req.query.search ?? '').trim();
  return query(req.actor,
    `SELECT p.id, p.sku, p.name, p.name_hi, p.variety, p.base_uom, p.purchase_uom,
            p.is_variable_weight, p.is_perishable, p.shelf_life_days, p.storage_type,
            p.rotation_rule, p.min_stock, p.max_stock, p.reorder_point,
            p.safety_stock_days, p.lead_time_days, p.moq, p.order_multiple,
            p.default_wastage_pct, p.grades_allowed, p.qc_template_id,
            c.name AS category_name, c.segment,
            COALESCE(sb.qty, 0) AS current_stock
       FROM products p
       JOIN product_categories c ON c.id = p.category_id
       LEFT JOIN (SELECT product_id, SUM(qty) qty FROM stock_balances GROUP BY product_id) sb
              ON sb.product_id = p.id
      WHERE p.company_id = $1 AND p.is_active
        AND ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%'
             OR COALESCE(p.name_hi,'') ILIKE '%'||$2||'%')
      ORDER BY c.segment, p.name`,
    [req.actor.companyId, search]);
}));

mastersRouter.get('/suppliers', h(async (req) => {
  const sourceType = String(req.query.sourceType ?? '');
  // Pickers want only the suppliers you may actually order from; the manage
  // screen passes ?includeBlocked=1 to see the ones that were taken out.
  const includeBlocked = String(req.query.includeBlocked ?? '') === '1';
  return query(req.actor,
    `SELECT s.id, s.code, s.legal_name, s.trade_name, s.source_type, s.gstin, s.pan,
            s.is_unregistered, s.phone, s.email, s.district, s.state_code, s.payment_terms_days,
            s.status, s.status_reason, s.trust_score, s.performance_score,
            s.first_purchase_at, s.last_purchase_at,
            a.commission_pct, a.settlement_cycle_days,
            m.name AS mandi_name,
            (SELECT count(*) FROM purchase_orders o
              WHERE o.supplier_id = s.id AND o.status NOT IN ('DRAFT','CANCELLED')) AS order_count,
            (SELECT count(*) FROM users u WHERE u.supplier_id = s.id) AS login_count
       FROM suppliers s
       LEFT JOIN aadhtis a ON a.supplier_id = s.id
       LEFT JOIN mandis   m ON m.id = a.mandi_id
      WHERE s.company_id = $1
        AND ($2 = '' OR s.source_type = $2)
        AND ($3 OR s.status <> 'BLOCKED')
      ORDER BY (s.status = 'PREFERRED') DESC, s.performance_score DESC NULLS LAST, s.legal_name`,
    [req.actor.companyId, sourceType, includeBlocked]);
}));

mastersRouter.post('/suppliers', requires('master.supplier.manage'), h(async (req) => {
  const input = body(z.object({
    code: z.string().min(2), legalName: z.string().min(2), tradeName: z.string().optional(),
    sourceType: z.enum(['FARMER', 'MANDI', 'AADHTI', 'WHOLESALER']),
    gstin: z.string().optional(), phone: z.string().optional(),
    district: z.string().optional(), paymentTermsDays: z.number().int().min(0).default(0),
    isUnregistered: z.boolean().default(false),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO suppliers (company_id, code, legal_name, trade_name, source_type, gstin,
                              phone, district, payment_terms_days, is_unregistered, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE') RETURNING id, code`,
      [req.actor.companyId, input.code, input.legalName, input.tradeName ?? null, input.sourceType,
       input.gstin ?? null, input.phone ?? null, input.district ?? null,
       input.paymentTermsDays, input.isUnregistered, req.actor.userId]);
    return rows[0];
  });
}));

/* ---------------------------------------------------------------------------
 *  Editing and retiring a supplier.
 *
 *  Nothing here deletes. Purchase orders, receipts, batches and invoices point
 *  at a supplier for years, and a farmer who stops selling this season often
 *  comes back the next one. "Remove" therefore sets status = BLOCKED with a
 *  reason, which takes the row out of every picker and leaves the history — and
 *  the trust score it earned — exactly where it was.
 * ------------------------------------------------------------------------ */
const supplierFields = z.object({
  legalName: z.string().trim().min(2, 'Enter the registered name'),
  tradeName: z.string().trim().optional().or(z.literal('')),
  sourceType: z.enum(['FARMER', 'MANDI', 'AADHTI', 'WHOLESALER']),
  gstin: z.string().trim().optional().or(z.literal('')),
  phone: z.string().trim().optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  district: z.string().trim().optional().or(z.literal('')),
  paymentTermsDays: z.number().int().min(0).max(180).default(0),
  isUnregistered: z.boolean().default(false),
});

mastersRouter.put('/suppliers/:id', requires('master.supplier.manage'), h(async (req) => {
  const input = body(supplierFields, req.body);
  const blank = (v?: string) => (v && v.trim() ? v.trim() : null);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE suppliers
          SET legal_name=$2, trade_name=$3, source_type=$4, gstin=$5, phone=$6, email=$7,
              district=$8, payment_terms_days=$9, is_unregistered=$10, updated_by=$11
        WHERE id=$1 AND company_id=$12
        RETURNING id, code, legal_name, status`,
      [req.params.id, input.legalName, blank(input.tradeName), input.sourceType,
       blank(input.gstin), blank(input.phone), blank(input.email), blank(input.district),
       input.paymentTermsDays, input.isUnregistered, req.actor.userId, req.actor.companyId]);
    if (!rows[0]) throw ApiError.notFound('Supplier not found');
    return rows[0];
  });
}));

/** Take a supplier out of the pickers. Their history is untouched. */
mastersRouter.post('/suppliers/:id/block', requires('master.supplier.block', 'master.supplier.manage'),
  h(async (req) => {
    const input = body(z.object({
      reason: z.string().trim().min(4, 'Say why this supplier is being removed'),
    }), req.body);

    return withTx(req.actor, async (tx) => {
      const { rows: open } = await tx.query(
        `SELECT count(*)::int c FROM purchase_orders
          WHERE supplier_id=$1 AND status IN ('SUBMITTED','APPROVED','CONFIRMED','PART_RECEIVED')`,
        [req.params.id]);
      if (open[0].c > 0) {
        throw ApiError.rule(
          `This supplier still has ${open[0].c} order(s) on the way. Close or cancel them first — `
          + 'blocking them now would leave deliveries nobody can receive.');
      }
      const { rows } = await tx.query(
        `UPDATE suppliers SET status='BLOCKED', status_reason=$2, status_changed_at=now(),
                status_changed_by=$3, updated_by=$3
          WHERE id=$1 AND company_id=$4 RETURNING id, code, legal_name, status`,
        [req.params.id, input.reason, req.actor.userId, req.actor.companyId]);
      if (!rows[0]) throw ApiError.notFound('Supplier not found');
      await emit(tx, req.actor, 'supplier', rows[0].id, 'supplier.blocked',
        { code: rows[0].code, reason: input.reason });
      return rows[0];
    });
  }));

mastersRouter.post('/suppliers/:id/restore', requires('master.supplier.block', 'master.supplier.manage'),
  h(async (req) =>
    withTx(req.actor, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE suppliers SET status='ACTIVE', status_reason=NULL, status_changed_at=now(),
                status_changed_by=$2, updated_by=$2
          WHERE id=$1 AND company_id=$3 AND status='BLOCKED'
          RETURNING id, code, legal_name, status`,
        [req.params.id, req.actor.userId, req.actor.companyId]);
      if (!rows[0]) throw ApiError.notFound('Supplier not found, or not blocked.');
      return rows[0];
    })));

mastersRouter.get('/warehouses', h(async (req) =>
  query(req.actor,
    `SELECT w.id, w.code, w.name, w.branch_id, w.storage_types, w.has_weighbridge,
            b.name AS branch_name
       FROM warehouses w JOIN branches b ON b.id = w.branch_id
      WHERE w.company_id = $1 AND w.is_active ORDER BY w.code`,
    [req.actor.companyId])));

/* ===========================================================================
 * FLEET — vehicles and drivers.
 *
 * These two lists feed the gate-entry dropdowns, so they are read by everyone
 * and written by whoever holds master.vehicle.manage (gate and warehouse).
 *
 * Nothing here ever deletes a row: gate entries and their receipts point at
 * these records for years. "Remove" sets is_active = false, which takes the
 * row out of the dropdowns and leaves history intact (see 08_fleet_masters).
 * ======================================================================== */

/** ?includeRetired=1 is the management view: retired and blocked rows too. */
const managing = (req: any) => req.query.includeRetired === '1' || req.query.includeRetired === 'true';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31').nullable().optional();

/** The same shape the vehicle_reg_t domain enforces, checked before the DB
 *  rejects it, so the gate sees a sentence instead of a constraint name. */
const REG_OK = /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/;
const regNo = z.string()
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
  .refine((s) => REG_OK.test(s), 'Enter a number like MH12AB1234 or 22BH1234AB');

const vehicleFields = z.object({
  regNo,
  vehicleType: z.enum(['TRUCK', 'TEMPO', 'PICKUP', 'TRACTOR', 'REEFER', 'CONTAINER', 'TWO_WHEELER']).default('TRUCK'),
  makeModel: z.string().max(80).nullable().optional(),
  capacityKg: z.number().nonnegative().nullable().optional(),
  isReefer: z.boolean().default(false),
  reeferMinTempC: z.number().nullable().optional(),
  tareReferenceKg: z.number().nonnegative().nullable().optional(),
  fitnessExpiry: dateStr,
  insuranceExpiry: dateStr,
  pucExpiry: dateStr,
  permitExpiry: dateStr,
  transporterName: z.string().max(120).nullable().optional(),
  ownerSupplierId: z.string().uuid().nullable().optional(),
  status: z.enum(['ACTIVE', 'WATCH', 'BLOCKED']).default('ACTIVE'),
  statusReason: z.string().max(300).nullable().optional(),
});

/** Blocking a truck stops it at the gate, so it needs a reason on the record. */
function assertBlockReason(input: { status: string; statusReason?: string | null }) {
  if (input.status !== 'ACTIVE' && !input.statusReason) {
    throw ApiError.rule(`Say why this vehicle is marked ${input.status}. The gate will show it.`);
  }
}

const vehicleCols = `id, reg_no, vehicle_type, make_model, capacity_kg, is_reefer,
            reefer_min_temp_c, tare_reference_kg, fitness_expiry, insurance_expiry,
            puc_expiry, permit_expiry, status, status_reason, transporter_name,
            owner_supplier_id, is_active, retired_at, retired_reason, trips_90d,
            (fitness_expiry < CURRENT_DATE OR insurance_expiry < CURRENT_DATE
             OR puc_expiry < CURRENT_DATE) AS compliance_expired`;

mastersRouter.get('/vehicles', h(async (req) =>
  query(req.actor,
    `SELECT ${vehicleCols}
       FROM vehicles
      WHERE company_id = $1 AND ($2::boolean OR is_active)
      ORDER BY is_active DESC, reg_no`,
    [req.actor.companyId, managing(req)])));

mastersRouter.post('/vehicles', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(vehicleFields, req.body);
  assertBlockReason(input);

  return withTx(req.actor, async (tx) => {
    /* One registration, one row, forever (uq: company_id, reg_no). A truck
     * that was retired and has come back is brought onto the roster again
     * rather than refused — its old receipts stay attached to the same row. */
    const { rows: prior } = await tx.query(
      `SELECT id, is_active FROM vehicles WHERE company_id=$1 AND reg_no=$2`,
      [req.actor.companyId, input.regNo]);

    if (prior[0]?.is_active) {
      throw ApiError.conflict(`Vehicle ${input.regNo} is already on the list.`);
    }

    const values = [
      req.actor.companyId, input.regNo, input.vehicleType, input.makeModel ?? null,
      input.capacityKg ?? null, input.isReefer, input.reeferMinTempC ?? null,
      input.tareReferenceKg ?? null, input.fitnessExpiry ?? null, input.insuranceExpiry ?? null,
      input.pucExpiry ?? null, input.permitExpiry ?? null, input.status, input.statusReason ?? null,
      input.transporterName ?? null, input.ownerSupplierId ?? null, req.actor.userId,
    ];

    if (prior[0]) {
      const { rows } = await tx.query(
        `UPDATE vehicles
            SET vehicle_type=$3, make_model=$4, capacity_kg=$5, is_reefer=$6,
                reefer_min_temp_c=$7, tare_reference_kg=$8, fitness_expiry=$9,
                insurance_expiry=$10, puc_expiry=$11, permit_expiry=$12,
                status=$13, status_reason=$14, transporter_name=$15, owner_supplier_id=$16,
                is_active=true, retired_at=NULL, retired_by=NULL, retired_reason=NULL,
                updated_by=$17
          WHERE company_id=$1 AND reg_no=$2
          RETURNING ${vehicleCols}`, values);
      return { ...rows[0], restored: true };
    }

    const { rows } = await tx.query(
      `INSERT INTO vehicles (company_id, reg_no, vehicle_type, make_model, capacity_kg, is_reefer,
              reefer_min_temp_c, tare_reference_kg, fitness_expiry, insurance_expiry, puc_expiry,
              permit_expiry, status, status_reason, transporter_name, owner_supplier_id,
              created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
       RETURNING ${vehicleCols}`, values);
    return rows[0];
  });
}));

mastersRouter.put('/vehicles/:id', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(vehicleFields, req.body);
  assertBlockReason(input);

  return withTx(req.actor, async (tx) => {
    const { rows: clash } = await tx.query(
      `SELECT 1 FROM vehicles WHERE company_id=$1 AND reg_no=$2 AND id <> $3`,
      [req.actor.companyId, input.regNo, req.params.id]);
    if (clash.length) throw ApiError.conflict(`Another vehicle is already recorded as ${input.regNo}.`);

    const { rows } = await tx.query(
      `UPDATE vehicles
          SET reg_no=$3, vehicle_type=$4, make_model=$5, capacity_kg=$6, is_reefer=$7,
              reefer_min_temp_c=$8, tare_reference_kg=$9, fitness_expiry=$10,
              insurance_expiry=$11, puc_expiry=$12, permit_expiry=$13,
              status=$14, status_reason=$15, transporter_name=$16, owner_supplier_id=$17,
              updated_by=$18
        WHERE id=$1 AND company_id=$2
        RETURNING ${vehicleCols}`,
      [req.params.id, req.actor.companyId, input.regNo, input.vehicleType, input.makeModel ?? null,
       input.capacityKg ?? null, input.isReefer, input.reeferMinTempC ?? null,
       input.tareReferenceKg ?? null, input.fitnessExpiry ?? null, input.insuranceExpiry ?? null,
       input.pucExpiry ?? null, input.permitExpiry ?? null, input.status, input.statusReason ?? null,
       input.transporterName ?? null, input.ownerSupplierId ?? null, req.actor.userId]);
    if (!rows[0]) throw ApiError.notFound('Vehicle not found');
    return rows[0];
  });
}));

/** Off the roster. The row and every receipt that names it stay exactly as they are. */
mastersRouter.post('/vehicles/:id/retire', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    // A truck standing in the yard mid-chain must not vanish from the screen
    // the gate staff are working on.
    const { rows: open } = await tx.query(
      `SELECT gate_no FROM gate_entries
        WHERE vehicle_id=$1 AND company_id=$2
          AND status NOT IN ('COMPLETED','REJECTED_AT_GATE','CANCELLED')
        LIMIT 1`, [req.params.id, req.actor.companyId]);
    if (open.length) {
      throw ApiError.rule(
        `This vehicle is still inside the yard on ${open[0].gate_no}. ` +
        'Finish or reject that gate entry first.');
    }

    const { rows } = await tx.query(
      `UPDATE vehicles
          SET is_active=false, retired_at=now(), retired_by=$3, retired_reason=$4, updated_by=$3
        WHERE id=$1 AND company_id=$2 AND is_active
        RETURNING ${vehicleCols}`,
      [req.params.id, req.actor.companyId, req.actor.userId, input.reason ?? null]);
    if (!rows[0]) throw ApiError.notFound('Vehicle not found, or already removed');
    return rows[0];
  });
}));

mastersRouter.post('/vehicles/:id/restore', requires('master.vehicle.manage'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE vehicles
          SET is_active=true, retired_at=NULL, retired_by=NULL, retired_reason=NULL, updated_by=$3
        WHERE id=$1 AND company_id=$2
        RETURNING ${vehicleCols}`,
      [req.params.id, req.actor.companyId, req.actor.userId]);
    if (!rows[0]) throw ApiError.notFound('Vehicle not found');
    return rows[0];
  })));

/* ---------------------------------------------------------------- drivers */

const driverFields = z.object({
  fullName: z.string().min(2, 'Enter the driver’s name').max(120),
  phone: z.string().max(20).nullable().optional(),
  dlNumber: z.string().max(30).nullable().optional(),
  dlExpiry: dateStr,
  status: z.enum(['ACTIVE', 'WATCH', 'BLOCKED']).default('ACTIVE'),
  /** DPDP §: a driver's licence and phone are personal data. */
  consentObtained: z.boolean().default(false),
});

const driverCols = `id, full_name, phone, dl_number, dl_expiry, status, is_active,
            retired_at, retired_reason, consent_obtained_at,
            (dl_expiry < CURRENT_DATE) AS licence_expired`;

/* The default list is the roster the gate picks from — active, not blocked.
 * The management screen asks for everything with ?includeRetired=1. */
mastersRouter.get('/drivers', h(async (req) =>
  query(req.actor,
    `SELECT ${driverCols}
       FROM drivers
      WHERE company_id = $1
        AND ($2::boolean OR (is_active AND status <> 'BLOCKED'))
      ORDER BY is_active DESC, full_name`,
    [req.actor.companyId, managing(req)])));

mastersRouter.post('/drivers', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(driverFields, req.body);

  return withTx(req.actor, async (tx) => {
    /* dl_number is unique per company where it is given. A driver who left and
     * came back is restored on the same row so his history follows him. */
    if (input.dlNumber) {
      const { rows: prior } = await tx.query(
        `SELECT id, is_active, full_name FROM drivers WHERE company_id=$1 AND dl_number=$2`,
        [req.actor.companyId, input.dlNumber]);
      if (prior[0]?.is_active) {
        throw ApiError.conflict(`${prior[0].full_name} is already on the list with this licence number.`);
      }
      if (prior[0]) {
        const { rows } = await tx.query(
          `UPDATE drivers
              SET full_name=$3, phone=$4, dl_expiry=$5, status=$6,
                  consent_obtained_at = CASE WHEN $7 THEN now() ELSE consent_obtained_at END,
                  is_active=true, retired_at=NULL, retired_by=NULL, retired_reason=NULL,
                  updated_by=$8
            WHERE company_id=$1 AND dl_number=$2
            RETURNING ${driverCols}`,
          [req.actor.companyId, input.dlNumber, input.fullName, input.phone ?? null,
           input.dlExpiry ?? null, input.status, input.consentObtained, req.actor.userId]);
        return { ...rows[0], restored: true };
      }
    }

    const { rows } = await tx.query(
      `INSERT INTO drivers (company_id, full_name, phone, dl_number, dl_expiry, status,
                            consent_obtained_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN now() ELSE NULL END, $8,$8)
       RETURNING ${driverCols}`,
      [req.actor.companyId, input.fullName, input.phone ?? null, input.dlNumber ?? null,
       input.dlExpiry ?? null, input.status, input.consentObtained, req.actor.userId]);
    return rows[0];
  });
}));

mastersRouter.put('/drivers/:id', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(driverFields, req.body);

  return withTx(req.actor, async (tx) => {
    if (input.dlNumber) {
      const { rows: clash } = await tx.query(
        `SELECT 1 FROM drivers WHERE company_id=$1 AND dl_number=$2 AND id <> $3`,
        [req.actor.companyId, input.dlNumber, req.params.id]);
      if (clash.length) throw ApiError.conflict('Another driver already has this licence number.');
    }

    const { rows } = await tx.query(
      `UPDATE drivers
          SET full_name=$3, phone=$4, dl_number=$5, dl_expiry=$6, status=$7,
              consent_obtained_at = CASE WHEN $8 THEN COALESCE(consent_obtained_at, now())
                                         ELSE consent_obtained_at END,
              updated_by=$9
        WHERE id=$1 AND company_id=$2
        RETURNING ${driverCols}`,
      [req.params.id, req.actor.companyId, input.fullName, input.phone ?? null,
       input.dlNumber ?? null, input.dlExpiry ?? null, input.status,
       input.consentObtained, req.actor.userId]);
    if (!rows[0]) throw ApiError.notFound('Driver not found');
    return rows[0];
  });
}));

mastersRouter.post('/drivers/:id/retire', requires('master.vehicle.manage'), h(async (req) => {
  const input = body(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});

  return withTx(req.actor, async (tx) => {
    const { rows: open } = await tx.query(
      `SELECT gate_no FROM gate_entries
        WHERE driver_id=$1 AND company_id=$2
          AND status NOT IN ('COMPLETED','REJECTED_AT_GATE','CANCELLED')
        LIMIT 1`, [req.params.id, req.actor.companyId]);
    if (open.length) {
      throw ApiError.rule(
        `This driver is still inside the yard on ${open[0].gate_no}. ` +
        'Finish or reject that gate entry first.');
    }

    const { rows } = await tx.query(
      `UPDATE drivers
          SET is_active=false, retired_at=now(), retired_by=$3, retired_reason=$4, updated_by=$3
        WHERE id=$1 AND company_id=$2 AND is_active
        RETURNING ${driverCols}`,
      [req.params.id, req.actor.companyId, req.actor.userId, input.reason ?? null]);
    if (!rows[0]) throw ApiError.notFound('Driver not found, or already removed');
    return rows[0];
  });
}));

mastersRouter.post('/drivers/:id/restore', requires('master.vehicle.manage'), h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE drivers
          SET is_active=true, retired_at=NULL, retired_by=NULL, retired_reason=NULL, updated_by=$3
        WHERE id=$1 AND company_id=$2
        RETURNING ${driverCols}`,
      [req.params.id, req.actor.companyId, req.actor.userId]);
    if (!rows[0]) throw ApiError.notFound('Driver not found');
    return rows[0];
  })));

mastersRouter.get('/container-types', h(async (req) =>
  query(req.actor,
    `SELECT id, code, name, container_kind, tare_kg, is_returnable, owner
       FROM container_types WHERE company_id = $1 AND is_active ORDER BY code`,
    [req.actor.companyId])));

mastersRouter.get('/charge-types', h(async (req) =>
  query(req.actor,
    `SELECT id, code, name, name_hi, allocation_basis, is_creditable, affects_landing_cost, borne_by
       FROM charge_types WHERE company_id = $1 AND is_active ORDER BY code`,
    [req.actor.companyId])));

mastersRouter.get('/bins', h(async (req) =>
  query(req.actor,
    `SELECT b.id, b.code, b.capacity_kg, b.current_fill_kg, b.is_pickface,
            r.code AS rack_code, z.code AS zone_code, z.storage_type, z.warehouse_id
       FROM bins b
       JOIN racks r ON r.id = b.rack_id
       JOIN zones z ON z.id = r.zone_id
      WHERE b.company_id = $1 AND b.is_active
        AND ($2::uuid IS NULL OR z.warehouse_id = $2)
      ORDER BY z.code, r.code, b.code`,
    [req.actor.companyId, req.query.warehouseId ?? null])));

/* This endpoint is open to every signed-in user, so it must never hand back a
 * credential. The SMTP block is excluded here and served by /smtp below, which
 * is permission-gated and redacts the password. */
mastersRouter.get('/settings', h(async (req) =>
  query(req.actor,
    `SELECT key, value, data_type FROM settings
      WHERE company_id = $1 AND key NOT LIKE 'smtp.%' ORDER BY key`,
    [req.actor.companyId])));

mastersRouter.put('/settings/:key', requires('admin.settings.manage'), h(async (req) => {
  const input = body(z.object({ value: z.any() }), req.body);
  if (req.params.key.startsWith('smtp.')) {
    throw ApiError.badRequest('Use the email settings form — the password is encrypted on the way in.');
  }
  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO settings (company_id, scope, key, value, updated_by)
       VALUES ($1,'COMPANY',$2,$3,$4)
       ON CONFLICT (company_id, branch_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value`,
      [req.actor.companyId, req.params.key, JSON.stringify(input.value), req.actor.userId]);
    return rows[0];
  });
}));

mastersRouter.get('/qc-templates', h(async (req) =>
  query(req.actor,
    `SELECT t.id, t.code, t.name, t.version, t.sampling_rule, t.scoring_rule,
            (SELECT json_agg(json_build_object(
                'id',p.id,'code',p.code,'label',p.label,'labelHi',p.label_hi,
                'paramType',p.param_type,'unit',p.unit,'minOk',p.min_ok,'maxOk',p.max_ok,
                'options',p.options,'isCritical',p.is_critical,'isMandatory',p.is_mandatory,
                'weight',p.weight,'requiresPhoto',p.requires_photo,'aiAssisted',p.ai_assisted,
                'helpText',p.help_text) ORDER BY p.seq)
               FROM qc_parameters p WHERE p.template_id = t.id) AS parameters
       FROM qc_templates t
      WHERE t.company_id = $1 AND t.is_active ORDER BY t.code`,
    [req.actor.companyId])));

mastersRouter.get('/audit', requires('admin.audit.view'), h(async (req) =>
  query(req.actor,
    `SELECT a.id, a.entity_type, a.entity_id, a.action, a.actor_id, a.actor_role,
            a.occurred_at, a.diff, a.reason_code, a.reason_text,
            u.full_name AS actor_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.company_id = $1
        AND ($2 = '' OR a.entity_type = $2)
        AND ($3::uuid IS NULL OR a.entity_id = $3)
      ORDER BY a.occurred_at DESC LIMIT 200`,
    [req.actor.companyId, String(req.query.table ?? ''), req.query.recordId ?? null])));

/* ===========================================================================
   PEOPLE & ACCESS

   Adding a person is an invitation, never a password. The admin supplies a
   name, an email and one role; the person supplies their own password through
   the one-time link. §25 — every gate below is a server-side permission check,
   because the UI hiding a button is not access control.
   ======================================================================== */

mastersRouter.get('/roles', requires('admin.rbac.manage'), h(async (req) =>
  query(req.actor,
    `SELECT id, code, name, description
       FROM roles WHERE company_id = $1 ORDER BY name`,
    [req.actor.companyId])));

mastersRouter.get('/users', requires('admin.rbac.manage'), h(async (req) =>
  query(req.actor,
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.last_login_at, u.created_at,
            COALESCE(array_agg(r.name ORDER BY r.name)
                     FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
            (SELECT i.expires_at FROM user_invites i
              WHERE i.user_id = u.id AND i.accepted_at IS NULL
              ORDER BY i.created_at DESC LIMIT 1) AS invite_expires_at,
            u.supplier_id, u.driver_id,
            sup.trade_name AS supplier_name, drv.full_name AS driver_name
       FROM users u
       LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
       LEFT JOIN roles r ON r.id = ura.role_id
       LEFT JOIN suppliers sup ON sup.id = u.supplier_id
       LEFT JOIN drivers drv ON drv.id = u.driver_id
      WHERE u.company_id = $1
      GROUP BY u.id, sup.trade_name, drv.full_name
      ORDER BY u.full_name`,
    [req.actor.companyId])));

mastersRouter.post('/users/invite', requires('admin.rbac.manage'), h(async (req) => {
  const input = body(z.object({
    fullName: z.string().trim().min(2, 'Enter their full name'),
    email: z.string().trim().email('Enter a valid email address'),
    roleId: z.string().uuid('Choose a role'),
    // Set only for an OUTSIDE contact at a supplier. Everything the supplier
    // portal shows is scoped by this column, so it is the whole of their
    // access — which is why it is set once, here, and never by them.
    supplierId: z.string().uuid().nullable().optional(),
    driverId: z.string().uuid().nullable().optional(),
  }), req.body);

  const email = input.email.toLowerCase();

  const existing = await pool.query(
    'SELECT id, status FROM users WHERE company_id = $1 AND lower(email) = $2',
    [req.actor.companyId, email]);
  if (existing.rowCount) {
    throw ApiError.conflict(
      existing.rows[0].status === 'INVITED'
        ? 'That person has already been invited. Use "Send new link" instead.'
        : 'Someone with that email already has an account.');
  }

  const role = await pool.query(
    'SELECT id, code FROM roles WHERE id = $1 AND company_id = $2',
    [input.roleId, req.actor.companyId]);
  if (!role.rowCount) throw ApiError.badRequest('That role does not exist.');

  /* The supplier link and the SUPPLIER role travel together. A supplier login
   * with no supplier sees nothing and is confusing; an inside role carrying a
   * supplier link would quietly scope a colleague to one vendor. Refuse both. */
  const isSupplierRole = role.rows[0].code === 'SUPPLIER';
  const isDriverRole = role.rows[0].code === 'DRIVER';
  if (isSupplierRole && !input.supplierId) {
    throw ApiError.badRequest('Choose which supplier this person belongs to.');
  }
  if (!isSupplierRole && input.supplierId) {
    throw ApiError.badRequest('Only the Supplier role can be linked to a supplier.');
  }
  if (isDriverRole && !input.driverId) {
    throw ApiError.badRequest('Choose which driver this login belongs to.');
  }
  if (!isDriverRole && input.driverId) {
    throw ApiError.badRequest('Only the Driver role can be linked to a driver.');
  }
  if (input.driverId) {
    const drv = await pool.query(
      'SELECT id FROM drivers WHERE id = $1 AND company_id = $2',
      [input.driverId, req.actor.companyId]);
    if (!drv.rowCount) throw ApiError.badRequest('That driver does not exist.');
  }
  if (input.supplierId) {
    const sup = await pool.query(
      'SELECT id FROM suppliers WHERE id = $1 AND company_id = $2',
      [input.supplierId, req.actor.companyId]);
    if (!sup.rowCount) throw ApiError.badRequest('That supplier does not exist.');
  }

  const userId = await withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO users (company_id, full_name, email, status, default_branch_id,
              supplier_id, driver_id, created_by)
       VALUES ($1, $2, $3, 'INVITED', $4, $5, $6, $7) RETURNING id`,
      [req.actor.companyId, input.fullName, email, req.actor.branchId,
       input.supplierId ?? null, input.driverId ?? null, req.actor.userId]);
    await tx.query(
      `INSERT INTO user_role_assignments (company_id, user_id, role_id, created_by)
       VALUES ($1, $2, $3, $4)`,
      [req.actor.companyId, rows[0].id, input.roleId, req.actor.userId]);
    return rows[0].id as string;
  });

  const invite = await issueInvite(userId, req.actor.userId);
  const delivery = await deliverInvite(req.actor.companyId, userId, invite.url);
  return { id: userId, email, inviteUrl: invite.url, expiresInDays: 7, ...delivery };
}));

/** Emails the link if SMTP is configured. Never throws: a mail server having a
 *  bad day must not lose the invite that was just created — the admin still
 *  gets the link on screen and can send it by hand. */
async function deliverInvite(companyId: string, userId: string, url: string) {
  const { rows } = await pool.query(
    `SELECT u.full_name, u.email, c.trade_name AS company_name,
            (SELECT r.name FROM user_role_assignments ura
               JOIN roles r ON r.id = ura.role_id
              WHERE ura.user_id = u.id ORDER BY ura.created_at LIMIT 1) AS role_name
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
    [userId]);
  const u = rows[0];
  if (!u?.email) return { emailSent: false, emailError: 'No email address on file' };

  const mail = inviteEmail(u.full_name, u.company_name, u.role_name, url);
  const r = await sendMail(companyId, u.email, mail.subject, mail.html, mail.text);
  return { emailSent: r.sent, emailError: r.sent ? undefined : r.reason };
}

/** Re-issues the link — for an invite that expired, or one that never arrived. */
mastersRouter.post('/users/:id/reinvite', requires('admin.rbac.manage'), h(async (req) => {
  const { rows } = await pool.query(
    'SELECT id, status, email FROM users WHERE id = $1 AND company_id = $2',
    [req.params.id, req.actor.companyId]);
  const u = rows[0];
  if (!u) throw ApiError.notFound('No such person');
  if (u.status === 'ACTIVE') {
    throw ApiError.badRequest('They have already set a password. Nothing to send.');
  }
  if (u.status !== 'INVITED') {
    await withTx(req.actor, (tx) =>
      tx.query(`UPDATE users SET status = 'INVITED', updated_at = now() WHERE id = $1`, [u.id]));
  }
  const invite = await issueInvite(u.id, req.actor.userId);
  const delivery = await deliverInvite(req.actor.companyId, u.id, invite.url);
  return { inviteUrl: invite.url, email: u.email, expiresInDays: 7, ...delivery };
}));

/** Suspend or restore access. Deleting a person is deliberately not offered:
 *  their name is on documents that must stay readable. */
mastersRouter.post('/users/:id/status', requires('admin.rbac.manage'), h(async (req) => {
  const input = body(z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
  }), req.body);

  if (req.params.id === req.actor.userId) {
    throw ApiError.badRequest('You cannot change your own access.');
  }
  const { rows } = await pool.query(
    'SELECT id, status, password_hash FROM users WHERE id = $1 AND company_id = $2',
    [req.params.id, req.actor.companyId]);
  const u = rows[0];
  if (!u) throw ApiError.notFound('No such person');
  if (input.status === 'ACTIVE' && !u.password_hash) {
    throw ApiError.badRequest('They have not set a password yet. Send them a new link instead.');
  }

  await withTx(req.actor, (tx) =>
    tx.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1',
      [u.id, input.status]));
  return { ok: true, status: input.status };
}));

/* ---------------------------------------------------------------- email --- */

/** Never returns the password — only whether one is on file. */
mastersRouter.get('/smtp', requires('admin.settings.manage'), h(async (req) => {
  const rows = await query<{ key: string; value: any }>(req.actor,
    `SELECT key, value FROM settings WHERE company_id = $1 AND key LIKE 'smtp.%'`,
    [req.actor.companyId]);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, any>;
  return {
    host: v['smtp.host'] ?? '',
    port: Number(v['smtp.port'] ?? 587),
    secure: v['smtp.secure'] === true || v['smtp.secure'] === 'true',
    user: v['smtp.user'] ?? '',
    fromName: v['smtp.from_name'] ?? '',
    fromEmail: v['smtp.from_email'] ?? '',
    hasPassword: !!v['smtp.password'],
    ready: !!(await loadSmtp(req.actor.companyId)),
  };
}));

mastersRouter.put('/smtp', requires('admin.settings.manage'), h(async (req) => {
  const input = body(z.object({
    host: z.string().trim().min(1, 'Enter the mail server address'),
    port: z.coerce.number().int().min(1).max(65535),
    secure: z.boolean().default(false),
    user: z.string().trim().default(''),
    // Omitted means "keep what is already stored", so an admin editing the
    // port does not have to retype the password. Empty string clears it.
    password: z.string().optional(),
    fromName: z.string().trim().default('ChotuG'),
    fromEmail: z.string().trim().email('Enter the address mail should come from'),
  }), req.body);

  const pairs: [string, any][] = [
    ['smtp.host', input.host],
    ['smtp.port', input.port],
    ['smtp.secure', input.secure],
    ['smtp.user', input.user],
    ['smtp.from_name', input.fromName],
    ['smtp.from_email', input.fromEmail],
  ];
  if (input.password !== undefined) {
    pairs.push(['smtp.password', input.password ? encryptSecret(input.password) : '']);
  }

  await withTx(req.actor, async (tx) => {
    for (const [key, value] of pairs) {
      await tx.query(
        `INSERT INTO settings (company_id, scope, key, value, updated_by)
         VALUES ($1,'COMPANY',$2,$3,$4)
         ON CONFLICT (company_id, branch_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.actor.companyId, key, JSON.stringify(value), req.actor.userId]);
    }
  });
  return { ok: true, ready: !!(await loadSmtp(req.actor.companyId)) };
}));

mastersRouter.post('/smtp/test', requires('admin.settings.manage'), h(async (req) => {
  const input = body(z.object({
    to: z.string().trim().email('Enter an address to send the test to'),
  }), req.body);
  const r = await sendTestMail(req.actor.companyId, input.to);
  if (!r.sent) throw ApiError.badRequest(r.reason ?? 'The test email could not be sent');
  return { ok: true };
}));

/* ------------------------------------------------- quantity-change reasons */

/* §5 — changing a suggested quantity demands a reason. The seven below are the
 * ones that come up constantly; anything else a buyer types is kept so the next
 * person can pick it instead of retyping it. Company-wide on purpose: this is
 * shared vocabulary, and it is what the AI feedback loop reads back. */
const QTY_REASON_KEY = 'planning.qty_change_reasons';
const QTY_REASON_PRESETS = [
  'Festival / event demand expected',
  'Supplier has limited stock',
  'Price is unusually good today',
  'Price is too high, buying less',
  'Storage space is limited',
  'Quality issues expected this week',
  'Known upcoming order',
];

async function savedReasons(actor: any): Promise<string[]> {
  const rows = await query<{ value: any }>(actor,
    `SELECT value FROM settings WHERE company_id = $1 AND key = $2`,
    [actor.companyId, QTY_REASON_KEY]);
  const v = rows[0]?.value;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

mastersRouter.get('/qty-change-reasons', h(async (req) => {
  const saved = await savedReasons(req.actor);
  const seen = new Set(QTY_REASON_PRESETS.map((r) => r.toLowerCase()));
  // Newest additions first among the custom ones — the reason someone just
  // added is usually the one the next person wants.
  const custom = [...saved].reverse().filter((r) => {
    const k = r.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...QTY_REASON_PRESETS, ...custom];
}));

mastersRouter.post('/qty-change-reasons', requires('purchase.requirement.create'), h(async (req) => {
  const input = body(z.object({
    reason: z.string().trim().min(3, 'Give a few words at least').max(120, 'Keep it short'),
  }), req.body);

  const saved = await savedReasons(req.actor);
  const known = [...QTY_REASON_PRESETS, ...saved].map((r) => r.toLowerCase());
  if (known.includes(input.reason.toLowerCase())) return { ok: true, added: false };

  // Capped so a typo-prone month cannot turn the dropdown into a scroll of 500.
  const next = [...saved, input.reason].slice(-40);
  await withTx(req.actor, (tx) => tx.query(
    `INSERT INTO settings (company_id, scope, key, value, updated_by)
     VALUES ($1,'COMPANY',$2,$3,$4)
     ON CONFLICT (company_id, branch_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [req.actor.companyId, QTY_REASON_KEY, JSON.stringify(next), req.actor.userId]));

  return { ok: true, added: true };
}));
