import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, requires } from '../platform/auth.js';
import { emit } from '../platform/services.js';
import { createRequest } from './finance.js';

export const hrRouter = Router();
hrRouter.use(authenticate);

const money = (n: number) => Math.round(n * 100) / 100;

/* ===========================================================================
 * HR — the people who do the work
 *
 * Wages already reached Finance; what was missing was the person behind the
 * payment. A worker is deliberately not a user: most of the people paid here
 * will never log in, and requiring an account to be paid is how half a
 * workforce ends up off the books.
 *
 * Everything here feeds one number — what somebody is owed at the end of a
 * period — and that number is worked out from the attendance rather than
 * typed. Then it goes to Finance as an ordinary payment request, because there
 * is one place money leaves from.
 * ======================================================================== */

hrRouter.get('/workers', requires('hr.report.view'), h(async (req) =>
  query(req.actor,
    `SELECT w.*, wh.name AS place_name, u.full_name AS login_name,
            o.boxes_weighed, o.kg_weighed, o.boxes_packed, o.audits_done,
            a.present_30d, a.absent_30d, a.leave_30d, a.hours_30d,
            (SELECT wr.period_end FROM wage_runs wr
              WHERE wr.worker_id = w.id ORDER BY wr.period_end DESC LIMIT 1) AS paid_upto,
            (SELECT COALESCE(SUM(wr.net_amount),0) FROM wage_runs wr
              WHERE wr.worker_id = w.id
                AND wr.period_start > CURRENT_DATE - 365) AS paid_12m
       FROM workers w
       LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
       LEFT JOIN users u ON u.id = w.user_id
       LEFT JOIN v_worker_output o ON o.worker_id = w.id
       LEFT JOIN (SELECT worker_id,
                         count(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY'))::int AS present_30d,
                         count(*) FILTER (WHERE status = 'ABSENT')::int                AS absent_30d,
                         count(*) FILTER (WHERE status = 'LEAVE')::int                 AS leave_30d,
                         COALESCE(SUM(hours),0) AS hours_30d
                    FROM worker_attendance
                   WHERE on_date > CURRENT_DATE - 30
                   GROUP BY worker_id) a ON a.worker_id = w.id
      WHERE w.company_id = $1
        AND ($2 = 'all' OR w.is_active)
        AND ($3::uuid IS NULL OR w.warehouse_id = $3)
      ORDER BY w.is_active DESC, w.full_name`,
    [req.actor.companyId, String(req.query.include ?? 'active'),
     req.query.warehouseId || null])));

hrRouter.post('/workers', requires('hr.worker.manage'), h(async (req) => {
  const i = body(z.object({
    fullName: z.string().trim().min(1, "What is their name?").max(80),
    code: z.string().trim().max(20).optional(),
    phone: z.string().trim().max(20).optional(),
    designation: z.string().trim().max(60).optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
    employment: z.enum(['PERMANENT', 'DAILY', 'CONTRACT', 'SEASONAL']).default('DAILY'),
    wageType: z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'PIECE']).default('DAILY'),
    wageRate: z.coerce.number().nonnegative().default(0),
    overtimeRate: z.coerce.number().nonnegative().optional(),
    standardHours: z.coerce.number().positive().max(24).default(8),
    joinedOn: z.string().optional(),
    idProof: z.string().trim().max(40).optional(),
    address: z.string().trim().max(200).optional(),
    note: z.string().trim().max(300).optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const branchId = req.actor.branchId;
    if (!branchId) throw ApiError.badRequest('No branch on your login.');

    /* A readable code they can be called by, generated when nobody supplies
     * one — asking a warehouse manager to invent employee numbers is how the
     * field ends up holding "1", "1a" and "new". */
    let code = i.code?.toUpperCase();
    if (!code) {
      const { rows } = await tx.query(
        `SELECT count(*)::int + 1 AS n FROM workers WHERE company_id = $1`,
        [req.actor.companyId]);
      code = `EMP-${String(rows[0].n).padStart(3, '0')}`;
    }

    const { rows } = await tx.query(
      `INSERT INTO workers (company_id, branch_id, warehouse_id, user_id, code, full_name,
              phone, designation, employment, wage_type, wage_rate, overtime_rate,
              standard_hours, joined_on, id_proof, address, note, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
       RETURNING *`,
      [req.actor.companyId, branchId, i.warehouseId ?? null, i.userId ?? null, code,
       i.fullName, i.phone ?? null, i.designation ?? null, i.employment, i.wageType,
       i.wageRate, i.overtimeRate ?? null, i.standardHours, i.joinedOn ?? null,
       i.idProof ?? null, i.address ?? null, i.note ?? null, req.actor.userId]);

    return { ...rows[0], message: `${i.fullName} added as ${code}.` };
  });
}));

hrRouter.patch('/workers/:id', requires('hr.worker.manage'), h(async (req) => {
  const i = body(z.object({
    fullName: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(20).optional(),
    designation: z.string().trim().max(60).optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    wageRate: z.coerce.number().nonnegative().optional(),
    overtimeRate: z.coerce.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
    leftOn: z.string().optional(),
    note: z.string().trim().max(300).optional(),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE workers SET
          full_name    = COALESCE($2, full_name),
          phone        = COALESCE($3, phone),
          designation  = COALESCE($4, designation),
          warehouse_id = COALESCE($5, warehouse_id),
          wage_rate    = COALESCE($6, wage_rate),
          overtime_rate = COALESCE($7, overtime_rate),
          is_active    = COALESCE($8, is_active),
          left_on      = COALESCE($9::date, left_on),
          note         = COALESCE($10, note),
          updated_by = $11, updated_at = now(), version = version + 1
        WHERE id = $1 AND company_id = $12 RETURNING *`,
      [req.params.id, i.fullName ?? null, i.phone ?? null, i.designation ?? null,
       i.warehouseId ?? null, i.wageRate ?? null, i.overtimeRate ?? null,
       i.isActive ?? null, i.leftOn ?? null, i.note ?? null,
       req.actor.userId, req.actor.companyId]);
    if (!rows[0]) throw ApiError.notFound('No such worker.');
    return { ...rows[0], message: `${rows[0].full_name} updated.` };
  });
}));

/* ---------------------------------------------------------- attendance --- */

/** Who is on the list for a day, and what has been marked so far. */
hrRouter.get('/attendance', requires('hr.report.view'), h(async (req) => {
  const on = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  const rows = await query(req.actor,
    `SELECT w.id AS worker_id, w.code, w.full_name, w.designation, w.wage_type,
            w.wage_rate, w.standard_hours, wh.name AS place_name, w.warehouse_id,
            a.id AS attendance_id, a.status, a.hours, a.overtime_hours,
            a.is_paid_leave, a.note, u.full_name AS marked_by_name, a.marked_at
       FROM workers w
       LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
       LEFT JOIN worker_attendance a ON a.worker_id = w.id AND a.on_date = $2::date
       LEFT JOIN users u ON u.id = a.marked_by
      WHERE w.company_id = $1 AND w.is_active
        AND ($3::uuid IS NULL OR w.warehouse_id = $3)
      ORDER BY wh.name NULLS FIRST, w.full_name`,
    [req.actor.companyId, on, req.query.warehouseId || null]);

  return {
    date: on,
    workers: rows,
    marked: rows.filter((r: any) => r.status).length,
    present: rows.filter((r: any) => ['PRESENT', 'HALF_DAY'].includes(r.status)).length,
    absent: rows.filter((r: any) => r.status === 'ABSENT').length,
    onLeave: rows.filter((r: any) => r.status === 'LEAVE').length,
  };
}));

/**
 * Marking the day. Sent as a batch because that is how it is taken — somebody
 * walks the floor once, not sixty times. Marking again corrects it.
 */
hrRouter.post('/attendance', requires('hr.attendance.mark'), h(async (req) => {
  const i = body(z.object({
    date: z.string().optional(),
    entries: z.array(z.object({
      workerId: z.string().uuid(),
      status: z.enum(['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY']),
      hours: z.coerce.number().nonnegative().max(24).optional(),
      overtimeHours: z.coerce.number().nonnegative().max(16).default(0),
      isPaidLeave: z.boolean().default(false),
      note: z.string().trim().max(200).optional(),
    })).min(1, 'Nobody to mark'),
  }), req.body);

  const on = i.date ?? new Date().toISOString().slice(0, 10);
  if (on > new Date().toISOString().slice(0, 10)) {
    throw ApiError.rule('That day has not happened yet.');
  }

  return withTx(req.actor, async (tx) => {
    let marked = 0;
    for (const e of i.entries) {
      const { rows: w } = await tx.query(
        `SELECT standard_hours FROM workers WHERE id=$1 AND company_id=$2`,
        [e.workerId, req.actor.companyId]);
      if (!w[0]) continue;
      /* A present day with no hours typed is a full day — the common case
       * should not need typing. */
      const hours = e.hours ?? (e.status === 'PRESENT' ? Number(w[0].standard_hours)
        : e.status === 'HALF_DAY' ? Number(w[0].standard_hours) / 2 : 0);

      await tx.query(
        `INSERT INTO worker_attendance (company_id, worker_id, on_date, status, hours,
                overtime_hours, is_paid_leave, note, marked_by)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (worker_id, on_date) DO UPDATE
           SET status = EXCLUDED.status, hours = EXCLUDED.hours,
               overtime_hours = EXCLUDED.overtime_hours,
               is_paid_leave = EXCLUDED.is_paid_leave, note = EXCLUDED.note,
               marked_by = EXCLUDED.marked_by, marked_at = now()`,
        [req.actor.companyId, e.workerId, on, e.status, hours,
         e.overtimeHours, e.isPaidLeave, e.note ?? null, req.actor.userId]);
      marked += 1;
    }
    return { ok: true, date: on, marked,
      message: `${marked} marked for ${on}.` };
  });
}));

/* --------------------------------------------------------------- wages --- */

/** What a period comes to, worked out from the attendance. Nothing is saved. */
async function computeWages(actor: any, workerId: string, from: string, to: string) {
  const [w] = await query(actor,
    `SELECT * FROM workers WHERE id=$1 AND company_id=$2`, [workerId, actor.companyId]);
  if (!w) throw ApiError.notFound('No such worker.');

  const [a] = await query(actor,
    `SELECT count(*) FILTER (WHERE status = 'PRESENT')::numeric
              + 0.5 * count(*) FILTER (WHERE status = 'HALF_DAY')::numeric  AS days_present,
            count(*) FILTER (WHERE status = 'ABSENT')::numeric              AS days_absent,
            count(*) FILTER (WHERE status = 'LEAVE')::numeric               AS days_leave,
            count(*) FILTER (WHERE status = 'LEAVE' AND is_paid_leave)::numeric AS paid_leave,
            COALESCE(SUM(hours),0)          AS hours,
            COALESCE(SUM(overtime_hours),0) AS overtime
       FROM worker_attendance
      WHERE worker_id = $1 AND on_date BETWEEN $2::date AND $3::date`,
    [workerId, from, to]);

  const rate = Number(w.wage_rate);
  const present = Number(a.days_present);
  const paidLeave = Number(a.paid_leave);
  const hours = Number(a.hours);
  const overtime = Number(a.overtime);

  /* Monthly pay is a salary — it does not shrink because February is short.
   * What it does lose is unpaid absence, priced at a day of it. */
  let base = 0;
  if (w.wage_type === 'MONTHLY') {
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000 + 1;
    const perDay = rate / Math.max(days, 1);
    const unpaid = Number(a.days_absent) + (Number(a.days_leave) - paidLeave);
    base = money(rate - perDay * unpaid);
  } else if (w.wage_type === 'HOURLY') {
    base = money(rate * hours);
  } else {
    base = money(rate * (present + paidLeave));
  }

  const otRate = w.overtime_rate != null
    ? Number(w.overtime_rate)
    /* No overtime rate set: an hour of overtime is worth an hour of the normal
     * day. Assuming zero would quietly pay people nothing for it. */
    : (w.wage_type === 'HOURLY' ? rate : rate / Math.max(Number(w.standard_hours), 1));
  const overtimeAmount = money(otRate * overtime);

  return {
    worker: w,
    daysPresent: present, daysAbsent: Number(a.days_absent), daysLeave: Number(a.days_leave),
    paidLeave, hours, overtime,
    baseAmount: base, overtimeAmount, overtimeRate: money(otRate),
    subtotal: money(base + overtimeAmount),
  };
}

hrRouter.get('/wages/preview', requires('hr.wages.run'), h(async (req) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!from || !to) throw ApiError.badRequest('Which period?');
  if (from > to) throw ApiError.badRequest('That period runs backwards.');

  const workers = await query(req.actor,
    `SELECT w.id FROM workers w
      WHERE w.company_id = $1 AND w.is_active
        AND ($2::uuid IS NULL OR w.warehouse_id = $2)
      ORDER BY w.full_name`,
    [req.actor.companyId, req.query.warehouseId || null]);

  const rows = [];
  for (const { id } of workers) {
    const c = await computeWages(req.actor, id, from, to);
    const [already] = await query(req.actor,
      `SELECT id, request_id, net_amount FROM wage_runs
        WHERE worker_id=$1 AND period_start=$2::date AND period_end=$3::date`,
      [id, from, to]);
    rows.push({
      workerId: id, name: c.worker.full_name, code: c.worker.code,
      designation: c.worker.designation, wageType: c.worker.wage_type,
      wageRate: Number(c.worker.wage_rate),
      daysPresent: c.daysPresent, daysAbsent: c.daysAbsent, daysLeave: c.daysLeave,
      hours: c.hours, overtime: c.overtime,
      baseAmount: c.baseAmount, overtimeAmount: c.overtimeAmount,
      subtotal: c.subtotal, alreadyRun: already ?? null,
    });
  }
  return { from, to, workers: rows,
    total: money(rows.reduce((a, r) => a + r.subtotal, 0)) };
}));

/**
 * Run the wages. One request per worker so Finance can hold one without
 * holding everybody, and so a bonus has a name against it.
 */
hrRouter.post('/wages/run', requires('hr.wages.run'), h(async (req) => {
  const i = body(z.object({
    from: z.string(),
    to: z.string(),
    entries: z.array(z.object({
      workerId: z.string().uuid(),
      bonus: z.coerce.number().nonnegative().default(0),
      bonusReason: z.string().trim().max(200).optional(),
      deductions: z.coerce.number().nonnegative().default(0),
      deductionReason: z.string().trim().max(200).optional(),
      note: z.string().trim().max(200).optional(),
    })).min(1, 'Nobody to pay'),
  }), req.body);

  return withTx(req.actor, async (tx) => {
    const done: any[] = [];
    for (const e of i.entries) {
      const c = await computeWages(req.actor, e.workerId, i.from, i.to);
      const net = money(c.subtotal + e.bonus - e.deductions);
      if (net <= 0) continue;
      if (e.bonus > 0 && !e.bonusReason) {
        throw ApiError.rule(`Say what ${c.worker.full_name}'s bonus is for.`);
      }
      if (e.deductions > 0 && !e.deductionReason) {
        throw ApiError.rule(`Say what is being deducted from ${c.worker.full_name}.`);
      }

      const { rows: existing } = await tx.query(
        `SELECT id, request_id FROM wage_runs
          WHERE worker_id=$1 AND period_start=$2::date AND period_end=$3::date`,
        [e.workerId, i.from, i.to]);
      if (existing[0]?.request_id) {
        /* Paying the same period twice is the mistake this whole table exists
         * to prevent. */
        done.push({ workerId: e.workerId, name: c.worker.full_name,
          skipped: 'already sent to Finance' });
        continue;
      }

      const { rows } = await tx.query(
        `INSERT INTO wage_runs (company_id, worker_id, period_start, period_end,
                days_present, days_absent, days_leave, hours_worked, overtime_hours,
                base_amount, overtime_amount, bonus_amount, bonus_reason,
                deductions, deduction_reason, net_amount, note, created_by)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (worker_id, period_start, period_end) DO UPDATE
           SET bonus_amount=EXCLUDED.bonus_amount, bonus_reason=EXCLUDED.bonus_reason,
               deductions=EXCLUDED.deductions, deduction_reason=EXCLUDED.deduction_reason,
               net_amount=EXCLUDED.net_amount, note=EXCLUDED.note
         RETURNING *`,
        [req.actor.companyId, e.workerId, i.from, i.to, c.daysPresent, c.daysAbsent,
         c.daysLeave, c.hours, c.overtime, c.baseAmount, c.overtimeAmount,
         e.bonus, e.bonusReason ?? null, e.deductions, e.deductionReason ?? null,
         net, e.note ?? null, req.actor.userId]);
      const run = rows[0];

      const pr = await createRequest(tx, req.actor, {
        kind: 'WAGES',
        amount: net,
        payeeName: c.worker.full_name,
        branchId: c.worker.branch_id,
        payeeUserId: c.worker.user_id ?? null,
        warehouseId: c.worker.warehouse_id ?? null,
        note: `Wages ${i.from} to ${i.to} · ${c.daysPresent} day(s)`
          + (e.bonus > 0 ? ` · bonus ${e.bonus} (${e.bonusReason})` : ''),
        sourceType: 'wage_run',
        sourceId: run.id,
        systemRaised: true,
      });

      await tx.query(`UPDATE wage_runs SET request_id=$2 WHERE id=$1`, [run.id, pr.id]);
      done.push({ workerId: e.workerId, name: c.worker.full_name,
        net, requestNo: pr.request_no });
    }

    await emit(tx, req.actor, 'wage_run', req.actor.companyId, 'wages.run',
      { from: i.from, to: i.to, workers: done.length });

    const paid = done.filter((d) => !d.skipped);
    return { ok: true, runs: done,
      total: money(paid.reduce((a, d) => a + (d.net ?? 0), 0)),
      message: `${paid.length} wage request(s) sent to Finance.`
        + (done.length > paid.length ? ` ${done.length - paid.length} already done.` : ''),
    };
  });
}));

hrRouter.get('/summary', requires('hr.report.view'), h(async (req) => {
  const [k] = await query(req.actor,
    `SELECT
       (SELECT count(*)::int FROM workers WHERE company_id=$1 AND is_active)      AS workers,
       (SELECT count(*)::int FROM worker_attendance a JOIN workers w ON w.id=a.worker_id
         WHERE w.company_id=$1 AND a.on_date=CURRENT_DATE
           AND a.status IN ('PRESENT','HALF_DAY'))                                AS present_today,
       (SELECT count(*)::int FROM worker_attendance a JOIN workers w ON w.id=a.worker_id
         WHERE w.company_id=$1 AND a.on_date=CURRENT_DATE AND a.status='ABSENT')  AS absent_today,
       (SELECT count(*)::int FROM workers w WHERE w.company_id=$1 AND w.is_active
          AND NOT EXISTS (SELECT 1 FROM worker_attendance a
                           WHERE a.worker_id=w.id AND a.on_date=CURRENT_DATE))    AS unmarked_today,
       COALESCE((SELECT SUM(net_amount) FROM wage_runs
                  WHERE company_id=$1 AND period_start > CURRENT_DATE - 30),0)    AS wages_30d,
       COALESCE((SELECT SUM(bonus_amount) FROM wage_runs
                  WHERE company_id=$1 AND period_start > CURRENT_DATE - 90),0)    AS bonus_90d`,
    [req.actor.companyId]);

  const byPlace = await query(req.actor,
    /* Summing wage_rate across mixed wage types read a ₹16,000 salary as a
     * ₹16,000 daily cost. Everything is normalised to what one working day
     * costs before it is added up. */
    `SELECT COALESCE(wh.name,'Not assigned') AS place, count(*)::int AS workers,
            COALESCE(SUM(CASE w.wage_type
                           WHEN 'MONTHLY' THEN w.wage_rate / 26.0
                           WHEN 'HOURLY'  THEN w.wage_rate * w.standard_hours
                           ELSE w.wage_rate END), 0) AS day_cost
       FROM workers w LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
      WHERE w.company_id=$1 AND w.is_active
      GROUP BY wh.name ORDER BY workers DESC`, [req.actor.companyId]);

  const recent = await query(req.actor,
    `SELECT wr.*, w.full_name, w.code, pr.status AS payment_status, pr.request_no
       FROM wage_runs wr
       JOIN workers w ON w.id = wr.worker_id
       LEFT JOIN payment_requests pr ON pr.id = wr.request_id
      WHERE wr.company_id=$1 ORDER BY wr.created_at DESC LIMIT 40`,
    [req.actor.companyId]);

  return { kpis: k, byPlace, recent };
}));
