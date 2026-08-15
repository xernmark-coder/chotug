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

mastersRouter.get('/vehicles', h(async (req) =>
  query(req.actor,
    `SELECT id, reg_no, vehicle_type, capacity_kg, is_reefer, tare_reference_kg,
            fitness_expiry, insurance_expiry, puc_expiry, status, transporter_name,
            (fitness_expiry < CURRENT_DATE OR insurance_expiry < CURRENT_DATE
             OR puc_expiry < CURRENT_DATE) AS compliance_expired
       FROM vehicles WHERE company_id = $1 ORDER BY reg_no`,
    [req.actor.companyId])));

mastersRouter.get('/drivers', h(async (req) =>
  query(req.actor,
    `SELECT id, full_name, phone, dl_number, dl_expiry, status
       FROM drivers WHERE company_id = $1 AND status <> 'BLOCKED' ORDER BY full_name`,
    [req.actor.companyId])));

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
