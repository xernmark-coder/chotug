import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(here, '../../../db');

async function run(file: string) {
  const sql = readFileSync(resolve(dbDir, file), 'utf8')
    // psql meta-commands are not valid over the wire
    .replace(/^\\set .*$/gm, '');
  process.stdout.write(`  → ${file} ... `);
  await pool.query(sql);
  console.log('done');
}

async function schemaExists() {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.companies') IS NOT NULL AS exists`,
  );
  return rows[0].exists;
}

async function main() {
  console.log('Applying database schema');
  if (await schemaExists()) {
    console.log('  → 01_schema.sql ... already applied');
  } else {
    await run('01_schema.sql');
  }
  await run('03_migration_fixes.sql');
  await run('02_seed.sql');
  // Farming is additive and idempotent, so it re-applies safely every time.
  await run('04_farming.sql');
  await run('05_farming_seed.sql');
  await run('06_stock_issue.sql');
  await run('07_flow_fixes.sql');
  await run('08_fleet_masters.sql');
  console.log('\nSchema and master data are in place.');
  console.log('Next: npm run seed   (sets demo passwords and generates demand history)');
  await pool.end();
}

main().catch(async (e) => {
  console.error('\nMigration failed:', e.message);
  await pool.end();
  process.exit(1);
});
