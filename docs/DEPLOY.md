# Deploying to Render

Three separate resources, created in this order:

| # | Resource | Render type | Root dir |
|---|---|---|---|
| 1 | `chotug-postgres` | Postgres | — |
| 2 | `chotug-api` | Web Service (Node) | `server` |
| 3 | `chotug-web` | Static Site | `web` |

Keep all three in the **same region**, or the API reaches the database over the public
internet instead of Render's private network. `render.yaml` at the repo root describes
all three; you can either apply it as a Blueprint (Path A) or click them out by hand
(Path B). The database has no "deploy" of its own — you create it, then push the schema
into it from step 6.

Everything below assumes the repo is on GitHub and Render can read it.


## The one thing that breaks every first attempt

The web app reads its API address from `VITE_API_URL`, and **Vite bakes that value into
the JavaScript bundle at build time**. It is not read at runtime. So:

- Setting `VITE_API_URL` and clicking *Restart* does nothing. You must **redeploy** the
  static site.
- **If you leave it unset, the build does not fail — it silently uses the committed
  `web/.env.production`, which contains `https://chotug-api.onrender.com`.** If Render
  gave your API any other name (it appends a suffix when the name is taken), the deployed
  site calls a host that isn't yours and every request fails. Nothing in the Render logs
  mentions it, because the request never reaches your API. Always set `VITE_API_URL`
  explicitly on the static site; a real environment variable overrides the committed file.

The API's `WEB_ORIGIN` is the mirror image: the API rejects browser requests from any
origin not listed in it. Neither value is knowable until the first deploy has created the
URLs, which is why the blueprint marks both `sync: false`.


## Path A — Blueprint

1. **New → Blueprint**, pick this repo. Render reads `render.yaml` and prompts for the
   `sync: false` values. Leave `VITE_API_URL` and `WEB_ORIGIN` as placeholders for now.
   `AI_API_KEY` / `AI_MODEL` / `AI_VISION_MODEL` can stay empty while `AI_PROVIDER` is
   `rules`.
2. **Apply.** Database first, then the API, then the static site. The API's
   `preDeployCommand` runs the migration, so the schema lands automatically — see step 6.
3. **Note the two URLs Render assigned.** Use whatever it actually shows, not what you
   expected.
4. **Cross-wire them:**
   - `chotug-api` → Environment → `WEB_ORIGIN` = the web URL, no trailing slash.
   - `chotug-web` → Environment → `VITE_API_URL` = the API URL, no trailing slash.
5. **Redeploy the static site** (Manual Deploy → Deploy latest commit). A restart is not
   enough — see the section above.


## Path B — By hand

Blueprint validation is strict about plan names and those names change. If step 1 fails to
validate, create the three resources yourself; the settings are identical.

**Postgres:** New → Postgres. Name `chotug-postgres`, database `chotug_erp`, user
`chotug`, **PostgreSQL version 16** (match your local major version if you plan to restore
a dump — see 6C). Note both connection strings on the database page: the **Internal** one
for the API, the **External** one for your laptop.

**API:** New → Web Service, same repo.

| Setting | Value |
|---|---|
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Pre-deploy command | `node dist/scripts/migrate.js` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Environment: `DATABASE_URL` = the **Internal** connection string, `JWT_SECRET` = any long
random string, `WEB_ORIGIN`, `NODE_VERSION=20`, `AI_PROVIDER=rules`.

**Web:** New → Static Site, same repo.

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm ci --include=dev && npm run build` |
| Publish directory | `dist` |
| Redirect/Rewrite | Source `/*` → Destination `/index.html`, type **Rewrite** |

Environment: `VITE_API_URL`. The rewrite is not optional — without it every URL except
`/` returns 404 on refresh, because the router lives in the browser.


## 6. Getting the schema and data into the database

Pick **one** of A, B or C. A is the normal path; C is only for carrying real data across.

### 6A — Automatic, on deploy (recommended)

`node dist/scripts/migrate.js` runs as the API's pre-deploy command and applies all eight
files in `db/` in order. It is idempotent: `01_schema.sql` is skipped once
`public.companies` exists, and the rest re-apply safely on every deploy. That gives you
the schema **and** the master data (branches, products, roles, permissions).

Then seed the demo accounts **once**. On `chotug-api` → Shell:

```
node dist/scripts/seed.js
```

This sets every demo password to `chotug123` and generates 90 days of demand history, so
the planning and forecast screens have something to work from. **Without it the users
exist but cannot log in** — `password_hash` is null until this runs.

> Pre-deploy commands and Shell access both require a paid instance. On the free plan, use
> 6B, or change the start command to `node dist/scripts/migrate.js && npm start` — the
> migration is idempotent so running it on every cold start is safe, just slower to wake.

### 6B — From your laptop

Use the database's **External** connection string. TLS is worked out from the URL — a
host that is not on your own machine gets an encrypted connection automatically, so no
extra flag is needed. (`PGSSL=require` or `PGSSL=disable` still force it either way.)

```bash
cd server
npm ci --include=dev && npm run build
DATABASE_URL='<external-url>' node dist/scripts/migrate.js
DATABASE_URL='<external-url>' node dist/scripts/seed.js
```

Or push the raw SQL with psql, in exactly this order:

```bash
for f in 01_schema 03_migration_fixes 02_seed 04_farming 05_farming_seed \
         06_stock_issue 07_flow_fixes 08_fleet_masters; do
  psql "<external-url>?sslmode=require" -v ON_ERROR_STOP=1 -f db/$f.sql
done
```

Note the order: `03` before `02` is deliberate, not a typo — it matches `migrate.ts`.

### 6C — Copying your existing local database

Only if your local database holds real data you need. Everything the demo has is
reproducible with 6A, which is cleaner.

```bash
# 1. Dump. --no-owner --no-privileges strips OWNER/GRANT lines that reference
#    local roles Render does not have.
PGPASSWORD=chotug pg_dump -h localhost -U chotug -d chotug_erp \
  --no-owner --no-privileges -Fc -f chotug.dump

# 2. Restore into the empty Render database.
pg_restore --no-owner --no-privileges --dbname "<external-url>?sslmode=require" chotug.dump
```

Three things to know:

- **Major versions must match.** Dump from PG16, restore into PG16. Choose the version
  when you create the database; you cannot change it afterwards.
- **Restore into an empty database.** If you already ran 6A, the objects exist and the
  restore collides with every one of them.
- **A failed `CREATE EXTENSION vector` is harmless.** pgvector is reserved for future AI
  retrieval and no column or query uses it yet; `pg_restore` reports the error and carries
  on. The schema itself now skips it gracefully.

Afterwards, confirm the data actually landed:

```bash
psql "<external-url>?sslmode=require" -c "select count(*) from users"
```


## 7. Verify

1. `https://<your-api>.onrender.com/api/health` → `{"ok":true,"db":"chotug_erp",...}`.
   `ok:false` with a password error means `DATABASE_URL` is wrong; a timeout usually means
   the API and database are in different regions.
2. Open the web URL, sign in as `owner@chotug.in` / `chotug123`.
3. If the login spins and fails, open the browser console. A CORS error means `WEB_ORIGIN`
   does not exactly match the site's origin. A call going to the wrong host means
   `VITE_API_URL` was not set at build time — fix it and **redeploy**.


## Why `--include=dev` is in both build commands

Render sets `NODE_ENV=production`. npm reads that and omits `devDependencies`, which drops
`typescript` and fails the build with `tsc: not found`. `--include=dev` overrides it. This
is the single most common Render build failure for a TypeScript service.


## What a managed Postgres will not let the schema do

Both of these are handled — listed so the `NOTICE` lines in your deploy log don't alarm
you:

- **`CREATE ROLE chotug_app` / `chotug_readonly`** needs the `CREATEROLE` attribute, which
  Render does not grant the database owner. These roles are defence in depth and the
  application never connects as either, so the schema catches the privilege error and
  continues.
- **`CREATE EXTENSION vector`** may not be available. Also caught, also unused.

`pgcrypto`, `pg_trgm`, `btree_gist` and `unaccent` are standard contrib modules and are
available on Render.


## Before this carries anything real

- `JWT_SECRET` must be generated, not the dev default. The blueprint uses
  `generateValue: true`.
- **Rotate the Groq API key sitting in `server/.env`** if that file has ever left your
  machine.
- Free Postgres is **deleted after 30 days** and free web services sleep after 15 minutes
  idle (~30s to wake). Neither suits a client demo you cannot babysit. Move to a paid plan
  and turn on backups.
- QC and farm photos are stored as base64 text inside Postgres. Fine for a demo, a backup
  problem quickly.
