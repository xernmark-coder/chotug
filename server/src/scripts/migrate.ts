import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(here, '../../../db');

/* The company every seed file writes. The schema puts row-level security on
 * each tenant table, so a migration that inserts master data has to say which
 * tenant it is acting for — exactly as the application does on every request.
 *
 * Without this the seed only works where the connecting role happens to bypass
 * RLS (a local superuser-ish role, a role with BYPASSRLS, or the table owner
 * on a table that is not FORCEd). On a managed Postgres — Render, Neon, RDS —
 * none of those hold, and 02_seed.sql dies on its very first INSERT with
 * "new row violates row-level security policy for table companies". */
const SEED_COMPANY = '01919000-0000-7000-8000-000000000001';

async function main() {
  console.log('Applying database schema');

  /* One connection for the whole run. The tenant GUC is set with is_local =
   * false so it survives each file's own BEGIN/COMMIT, and a pooled connection
   * is never handed to anything else mid-migration. */
  const client = await pool.connect();

  const run = async (file: string) => {
    const sql = readFileSync(resolve(dbDir, file), 'utf8')
      // psql meta-commands are not valid over the wire
      .replace(/^\\set .*$/gm, '');
    process.stdout.write(`  → ${file} ... `);
    await client.query(sql);
    console.log('done');
  };

  const schemaExists = async () => {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.companies') IS NOT NULL AS exists`,
    );
    return rows[0].exists;
  };

  try {
    await client.query(`SELECT set_config('app.company_id', $1, false)`, [SEED_COMPANY]);

    if (await schemaExists()) {
      console.log('  → 01_schema.sql ... already applied');
    } else {
      await run('01_schema.sql');
      // The policies only exist once the schema has been created, so the GUC
      // has to be re-asserted against a connection that now has them.
      await client.query(`SELECT set_config('app.company_id', $1, false)`, [SEED_COMPANY]);
    }
    await run('03_migration_fixes.sql');

    /* Before anything writes a row. 01_schema FORCEs row-level security on
     * every table, including the ones with no company_id and therefore no
     * policy at all — and RLS with no policy denies everything, so the seed
     * cannot insert a role limit or a permission. Relax it here, and again at
     * the end because 04 and 06 turn FORCE back on for the tables they touch. */
    await run('11_rls_managed_host.sql');

    await run('02_seed.sql');
    // Farming is additive and idempotent, so it re-applies safely every time.
    await run('04_farming.sql');
    await run('05_farming_seed.sql');
    await run('06_stock_issue.sql');
    await run('07_flow_fixes.sql');
    await run('08_fleet_masters.sql');
    await run('09_user_invites.sql');
    await run('10_po_confirm_queue.sql');
    await run('12_packing.sql');
    await run('13_supplier_portal.sql');
    await run('14_qc_lot_grades.sql');
    await run('15_driver_portal.sql');
    // Last, so the FORCE that 04 and 06 re-apply is lifted again.
    await run('11_rls_managed_host.sql');
    console.log('\nSchema and master data are in place.');
    console.log('Next: npm run seed   (sets demo passwords and generates demand history)');
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('\nMigration failed:', e.message);
  await pool.end();
  process.exit(1);
});
