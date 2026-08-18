/* ===========================================================================
 * DEVICE BRIDGE — how a weighbridge and a barcode gun get into the system.
 *
 * The schema always modelled the hardware (scale_devices, site_agents,
 * weighments.capture_mode = SCALE|MANUAL with a raw reading). Nothing joined
 * them up, so every weight in the system was typed by hand.
 *
 * The shape, and why:
 *
 *   indicator ──RS-232/Modbus──▶ site agent (small program on the gate PC)
 *                                   │  POST /api/devices/readings   (agent key)
 *                                   ▼
 *                              device_readings
 *                                   │  GET /api/devices/latest      (staff JWT)
 *                                   ▼
 *                          the weighment screen fills itself in
 *
 * A browser cannot open a serial port — WebSerial is Chrome-desktop only,
 * HTTPS only, and needs a user gesture per session — and a weighbridge
 * indicator speaks RS-232 or Modbus RTU. The agent also buffers, so the gate
 * keeps weighing when the internet drops, which is the normal case at 5 a.m.
 *
 * A USB or Bluetooth barcode gun needs none of this: it presents as a keyboard
 * and types into whatever field has focus, which is why the scan screens are
 * plain text inputs and work with a gun today.
 * ======================================================================== */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool, query, withTx } from '../db.js';
import { ApiError, body, h } from '../platform/http.js';
import { authenticate, staffOnly, requires } from '../platform/auth.js';

export const devicesRouter = Router();

/* ---------------------------------------------------------------------------
 * Agent authentication.
 *
 * An agent is a machine, not a person: it carries a long-lived key rather than
 * a JWT, and it is scoped to one warehouse. The key is stored only as a
 * SHA-256 hash, so the database is not a list of working credentials.
 * ------------------------------------------------------------------------ */
type AgentCtx = {
  id: string; companyId: string; warehouseId: string; agentCode: string;
  capabilities: string[];
};

async function authenticateAgent(req: any, _res: any, next: any) {
  try {
    const key = String(req.headers['x-agent-key'] ?? '');
    if (!key) throw ApiError.unauthorized('This endpoint is for a site agent. Send X-Agent-Key.');
    const hash = createHash('sha256').update(key).digest('hex');

    // No tenant context is set yet — the key IS the tenant claim — so this one
    // query runs outside withTx deliberately.
    const { rows } = await pool.query(
      `SELECT id, company_id, warehouse_id, agent_code, capabilities, status
         FROM site_agents WHERE api_key_hash = $1`, [hash]);
    const a = rows[0];
    if (!a) throw ApiError.unauthorized('That agent key is not recognised.');
    if (a.status === 'DISABLED') throw ApiError.forbidden('This agent has been disabled.');

    req.agent = {
      id: a.id, companyId: a.company_id, warehouseId: a.warehouse_id,
      agentCode: a.agent_code, capabilities: a.capabilities ?? [],
    } satisfies AgentCtx;
    next();
  } catch (e) { next(e); }
}

/** The agent says it is alive, and what it can currently see. */
devicesRouter.post('/heartbeat', authenticateAgent, h(async (req: any) => {
  const input = body(z.object({
    agentVersion: z.string().optional(),
    hostname: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    bufferedEvents: z.number().int().nonnegative().default(0),
  }), req.body ?? {});

  const { rows } = await pool.query(
    `UPDATE site_agents
        SET last_heartbeat_at = now(),
            agent_version = COALESCE($2, agent_version),
            hostname      = COALESCE($3, hostname),
            capabilities  = COALESCE($4::text[], capabilities),
            buffered_events = $5,
            status = CASE WHEN $5 > 200 THEN 'DEGRADED' ELSE 'ACTIVE' END
      WHERE id = $1
      RETURNING agent_code, status, last_heartbeat_at`,
    [req.agent.id, input.agentVersion ?? null, input.hostname ?? null,
     input.capabilities ?? null, input.bufferedEvents]);
  return { ok: true, ...rows[0], serverTime: new Date().toISOString() };
}));

/* ---------------------------------------------------------------------------
 * A reading from the hardware.
 *
 * The agent may post a batch, because it buffers while offline. Each frame
 * carries the time the SCALE saw it, not the time we received it — a
 * two-minute upload delay must not look like a two-minute-old weight.
 * ------------------------------------------------------------------------ */
devicesRouter.post('/readings', authenticateAgent, h(async (req: any) => {
  const input = body(z.object({
    readings: z.array(z.object({
      deviceCode: z.string().optional(),
      kind: z.enum(['WEIGHT', 'SCAN', 'TEMPERATURE']).default('WEIGHT'),
      valueKg: z.number().nullable().optional(),
      rawReading: z.string().max(500).optional(),
      /** An indicator streams continuously; only a settled frame is a weight. */
      isStable: z.boolean().default(false),
      scannedCode: z.string().max(200).nullable().optional(),
      capturedAt: z.string().optional(),
    })).min(1).max(200),
  }), req.body);

  const agent: AgentCtx = req.agent;
  const actor = { companyId: agent.companyId, userId: agent.id };

  return withTx(actor as any, async (tx) => {
    let stored = 0;
    for (const r of input.readings) {
      if (r.kind === 'WEIGHT' && (r.valueKg == null || r.valueKg < 0)) continue;

      const { rows: dev } = r.deviceCode
        ? await tx.query(
            `SELECT id FROM scale_devices
              WHERE company_id=$1 AND code=$2 AND is_active`, [agent.companyId, r.deviceCode])
        : { rows: [] as any[] };

      await tx.query(
        `INSERT INTO device_readings (company_id, warehouse_id, scale_device_id, site_agent_id,
                kind, value_kg, raw_reading, is_stable, scanned_code, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()))`,
        [agent.companyId, agent.warehouseId, dev[0]?.id ?? null, agent.id, r.kind,
         r.valueKg ?? null, r.rawReading ?? null, r.isStable, r.scannedCode ?? null,
         r.capturedAt ?? null]);
      stored++;
    }

    await tx.query(
      `UPDATE site_agents SET last_heartbeat_at = now(), status='ACTIVE' WHERE id=$1`, [agent.id]);
    return { ok: true, stored, ignored: input.readings.length - stored };
  });
}));

/* ---------------------------------------------------------------------------
 * The staff side: what is on the scale right now.
 * ------------------------------------------------------------------------ */
devicesRouter.use(authenticate);
devicesRouter.use(staffOnly);

/**
 * The freshest settled weight, for the weighment screen to offer.
 *
 * Deliberately only a few seconds of history: a weight from ten minutes ago
 * belongs to the previous lorry, and offering it is how the wrong number gets
 * saved with capture_mode = SCALE, which is worse than typing it.
 */
devicesRouter.get('/latest', h(async (req) => {
  const maxAgeSec = Math.min(Number(req.query.maxAgeSec ?? 30), 300);
  const [row] = await query(req.actor,
    `SELECT dr.id, dr.value_kg, dr.raw_reading, dr.captured_at, dr.is_stable,
            sd.id AS scale_device_id, sd.code AS device_code, sd.least_count_kg,
            sd.verification_expiry,
            EXTRACT(EPOCH FROM (now() - dr.captured_at)) AS age_seconds
       FROM device_readings dr
       LEFT JOIN scale_devices sd ON sd.id = dr.scale_device_id
      WHERE dr.company_id = $1 AND dr.kind = 'WEIGHT' AND dr.is_stable
        AND dr.consumed_at IS NULL
        AND ($2::uuid IS NULL OR dr.warehouse_id = $2)
        AND dr.captured_at > now() - ($3 || ' seconds')::interval
      ORDER BY dr.captured_at DESC LIMIT 1`,
    [req.actor.companyId, req.query.warehouseId ?? null, String(maxAgeSec)]);

  if (!row) return { available: false, reason: 'No settled reading from a scale in the last few seconds.' };

  // A scale whose Legal Metrology stamp has lapsed is not evidence of anything.
  const stampExpired = row.verification_expiry
    && String(row.verification_expiry) < new Date().toISOString().slice(0, 10);

  return {
    available: true,
    readingId: row.id,
    scaleDeviceId: row.scale_device_id,
    deviceCode: row.device_code,
    valueKg: Number(row.value_kg),
    rawReading: row.raw_reading,
    ageSeconds: Math.round(Number(row.age_seconds)),
    leastCountKg: row.least_count_kg,
    stampExpired: !!stampExpired,
    warning: stampExpired
      ? 'This scale’s verification stamp has expired. The weight can be captured but should not be billed on.'
      : null,
  };
}));

/** Mark a reading as used, so the same frame cannot back two documents. */
devicesRouter.post('/readings/:id/consume', h(async (req) =>
  withTx(req.actor, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE device_readings SET consumed_at = now(), consumed_by = $2
        WHERE id = $1 AND company_id = $3 AND consumed_at IS NULL
        RETURNING id`, [req.params.id, req.actor.userId, req.actor.companyId]);
    return { ok: !!rows[0] };
  })));

/** The registry, so somebody can see whether the gate PC is actually talking. */
devicesRouter.get('/registry', requires('device.registry.manage'), h(async (req) => {
  const [scales, agents] = await Promise.all([
    query(req.actor,
      `SELECT sd.id, sd.code, sd.device_kind, sd.make, sd.model, sd.protocol, sd.baud_rate,
              sd.parser_key, sd.capacity_kg, sd.least_count_kg, sd.verification_expiry,
              sd.is_active, w.name AS warehouse_name,
              (sd.verification_expiry IS NOT NULL AND sd.verification_expiry < CURRENT_DATE) AS stamp_expired,
              (SELECT max(captured_at) FROM device_readings dr WHERE dr.scale_device_id = sd.id) AS last_reading_at
         FROM scale_devices sd JOIN warehouses w ON w.id = sd.warehouse_id
        WHERE sd.company_id = $1 ORDER BY sd.code`, [req.actor.companyId]),
    query(req.actor,
      `SELECT sa.id, sa.agent_code, sa.hostname, sa.agent_version, sa.capabilities,
              sa.status, sa.last_heartbeat_at, sa.buffered_events, w.name AS warehouse_name,
              (sa.last_heartbeat_at IS NULL
                OR sa.last_heartbeat_at < now() - interval '5 minutes') AS is_silent
         FROM site_agents sa JOIN warehouses w ON w.id = sa.warehouse_id
        WHERE sa.company_id = $1 ORDER BY sa.agent_code`, [req.actor.companyId]),
  ]);
  return { scales, agents };
}));
