import { Router } from 'express';
import { z } from 'zod';
import { pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, loadActor, requires, signToken, verifyPassword, hashPassword } from '../platform/auth.js';

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

/* ======================================================================== */

export const mastersRouter = Router();
mastersRouter.use(authenticate);

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
  return query(req.actor,
    `SELECT s.id, s.code, s.legal_name, s.trade_name, s.source_type, s.gstin,
            s.is_unregistered, s.phone, s.district, s.payment_terms_days,
            s.status, s.trust_score, s.performance_score,
            a.commission_pct, a.settlement_cycle_days,
            m.name AS mandi_name
       FROM suppliers s
       LEFT JOIN aadhtis a ON a.supplier_id = s.id
       LEFT JOIN mandis   m ON m.id = a.mandi_id
      WHERE s.company_id = $1
        AND ($2 = '' OR s.source_type = $2)
      ORDER BY (s.status = 'PREFERRED') DESC, s.performance_score DESC NULLS LAST, s.legal_name`,
    [req.actor.companyId, sourceType]);
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

mastersRouter.get('/settings', h(async (req) =>
  query(req.actor,
    `SELECT key, value, data_type FROM settings WHERE company_id = $1 ORDER BY key`,
    [req.actor.companyId])));

mastersRouter.put('/settings/:key', requires('admin.settings.manage'), h(async (req) => {
  const input = body(z.object({ value: z.any() }), req.body);
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
