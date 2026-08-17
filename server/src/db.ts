import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/* ---------------------------------------------------------------------------
 * numeric(18,4) and friends arrive from pg as strings by default, which is
 * correct for money but useless for arithmetic in JS. We parse them to Number
 * ONLY at the read boundary and always send money back to Postgres as a string
 * so the value never round-trips through a float.  Anything above 2^53 paise
 * is not a realistic produce transaction.
 * ------------------------------------------------------------------------- */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8

/* A `date` is a calendar day, not an instant. Parsed into a JS Date it becomes
 * local midnight, and `.toISOString()` on that in IST (UTC+5:30) yields the
 * PREVIOUS day — which silently shifts sowing dates, harvest windows and
 * expiry comparisons by one. Hand back the 'YYYY-MM-DD' text and compare it as
 * text, which is exactly what a calendar day supports and nothing more. */
pg.types.setTypeParser(1082, (v) => v);                               // date

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://chotug:chotug@localhost:5432/chotug_erp',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  accessTtl: process.env.ACCESS_TTL ?? '8h',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  fy: process.env.FINANCIAL_YEAR ?? '2026-27',
  ai: {
    provider: (process.env.AI_PROVIDER ?? 'rules') as
      | 'rules'
      | 'openrouter'
      | 'groq'
      | 'ollama',
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free',
    visionModel: process.env.AI_VISION_MODEL ?? 'qwen/qwen2.5-vl-72b-instruct:free',
    baseUrl: process.env.AI_BASE_URL ?? '',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 20000),
  },
};

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  /* A managed Postgres reached over the public internet — Render's external
   * URL, used when running a migration from a laptop — refuses a plaintext
   * connection. The internal URL inside the provider's own network does not
   * need TLS and does not present a certificate you can verify, so this is
   * opt-in per environment rather than always on. */
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX ?? 12),
  idleTimeoutMillis: 30_000,
  application_name: 'chotug-purchase-api',
});

pool.on('error', (err) => {
  console.error('[pg] idle client error', err);
});

export type Actor = {
  userId: string;
  companyId: string;
  branchId: string | null;
  /** Set for an OUTSIDE contact at a supplier; null for our own staff. */
  supplierId: string | null;
  permissions: Set<string>;
  roleCodes: string[];
  limits: {
    maxPoValue: number | null;
    maxApprovalLevel: number;
    maxRateVariancePct: number | null;
    maxWeightVariancePct: number | null;
    maxBackdateDays: number;
    maxInvoiceMismatchValue: number | null;
  };
};

export type Tx = pg.PoolClient;

/**
 * Every write runs inside withTx. It sets the two session GUCs the schema's
 * row-level-security policies and audit trigger read (`app.company_id`,
 * `app.user_id`), so tenancy and audit attribution are impossible to forget.
 *
 * SET LOCAL is transaction-scoped, so a pooled connection handed to the next
 * request never carries a previous tenant's identity.
 */
export async function withTx<T>(
  actor: Pick<Actor, 'companyId' | 'userId'> | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (actor) {
      await client.query('SELECT set_config($1,$2,true)', [
        'app.company_id',
        actor.companyId,
      ]);
      await client.query('SELECT set_config($1,$2,true)', [
        'app.user_id',
        actor.userId,
      ]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only query with tenancy GUCs applied. */
export async function query<T = any>(
  actor: Pick<Actor, 'companyId' | 'userId'> | null,
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  return withTx(actor, async (tx) => {
    const r = await tx.query(sql, params);
    return r.rows as T[];
  });
}

export async function one<T = any>(
  actor: Pick<Actor, 'companyId' | 'userId'> | null,
  sql: string,
  params: any[] = [],
): Promise<T | null> {
  const rows = await query<T>(actor, sql, params);
  return rows[0] ?? null;
}
