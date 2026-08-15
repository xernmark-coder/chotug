import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config, pool, type Actor } from '../db.js';
import { ApiError, type Ctx } from './http.js';

type JwtPayload = { sub: string; company: string };

export function signToken(userId: string, companyId: string) {
  return jwt.sign({ sub: userId, company: companyId } satisfies JwtPayload, config.jwtSecret, {
    expiresIn: config.accessTtl as any,
  });
}

export async function verifyPassword(plain: string, hash: string | null) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 11);
}

/**
 * Loads the full authorisation context in one round trip: the user, every
 * permission code granted by any of their roles, and the *most permissive*
 * limit across those roles (§6.1 — limits are a ceiling, not a floor).
 */
export async function loadActor(userId: string): Promise<Actor | null> {
  const { rows } = await pool.query(
    `
    SELECT u.id, u.company_id, u.default_branch_id, u.status,
           COALESCE(array_agg(DISTINCT r.code)   FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes,
           COALESCE(array_agg(DISTINCT rp.permission_code)
                    FILTER (WHERE rp.permission_code IS NOT NULL), '{}')                  AS perms,
           MAX(rl.max_po_value)            AS max_po_value,
           MAX(rl.max_approval_level)      AS max_approval_level,
           MAX(rl.max_rate_variance_pct)   AS max_rate_variance_pct,
           MAX(rl.max_weight_variance_pct) AS max_weight_variance_pct,
           MAX(rl.max_backdate_days)       AS max_backdate_days,
           MAX(rl.max_invoice_mismatch_value) AS max_invoice_mismatch_value
      FROM users u
      LEFT JOIN user_role_assignments ura
             ON ura.user_id = u.id
            AND ura.valid_from <= CURRENT_DATE
            AND (ura.valid_to IS NULL OR ura.valid_to >= CURRENT_DATE)
      LEFT JOIN roles r            ON r.id  = ura.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN role_limits rl      ON rl.role_id = r.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [userId],
  );
  const r = rows[0];
  if (!r || r.status !== 'ACTIVE') return null;
  return {
    userId: r.id,
    companyId: r.company_id,
    branchId: r.default_branch_id,
    permissions: new Set<string>(r.perms),
    roleCodes: r.role_codes,
    limits: {
      maxPoValue: r.max_po_value,
      maxApprovalLevel: r.max_approval_level ?? 0,
      maxRateVariancePct: r.max_rate_variance_pct,
      maxWeightVariancePct: r.max_weight_variance_pct,
      maxBackdateDays: r.max_backdate_days ?? 0,
      maxInvoiceMismatchValue: r.max_invoice_mismatch_value,
    },
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req as any).cookies?.cg_token;
    if (!token) throw ApiError.unauthorized('Sign in to continue');
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    } catch {
      throw ApiError.unauthorized('Your session expired — please sign in again');
    }
    const actor = await loadActor(payload.sub);
    if (!actor) throw ApiError.unauthorized('This account is no longer active');
    (req as Ctx).actor = actor;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Server-side permission gate (§25 — RBAC is never a UI concern).
 * OWNER holds admin.override and is allowed through any gate, but the audit
 * trigger still records exactly what they did.
 */
export function requires(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = (req as Ctx).actor;
    if (!actor) return next(ApiError.unauthorized());
    const ok = codes.some((c) => actor.permissions.has(c));
    if (!ok && !actor.permissions.has('admin.override')) {
      return next(
        ApiError.forbidden(
          'Your role does not allow this action. Ask your manager or owner.',
          { needs: codes },
        ),
      );
    }
    next();
  };
}

export function can(actor: Actor, code: string) {
  return actor.permissions.has(code) || actor.permissions.has('admin.override');
}
