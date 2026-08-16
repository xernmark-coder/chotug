# Deploying to Render

Three resources: a Postgres database, the Node API, and the React app as a static site.
`render.yaml` at the repo root describes all three.

Everything below assumes the repo is pushed to GitHub and Render has access to it.


## The one thing that breaks every first attempt

The web app reads its API address from `VITE_API_URL`, and **Vite bakes that value into the
JavaScript bundle at build time**. It is not read at runtime. So:

- Setting `VITE_API_URL` and clicking *Restart* does nothing. You must **redeploy** the static site.
- If it is unset at build time, the bundle falls back to `http://localhost:4000` and the deployed
  site tries to call the visitor's own machine. Every request fails with a connection error and
  nothing in the Render logs mentions it, because the request never reaches Render.

The API's `WEB_ORIGIN` is the mirror of it: the API refuses cross-origin browser requests from any
origin not listed there. Both values are only knowable after the first deploy, which is why the
blueprint marks them `sync: false`.


## Path A — Blueprint (what render.yaml is for)

1. **New → Blueprint** in the Render dashboard, pick this repo.
   Render reads `render.yaml` and prompts for the `sync: false` values. Leave `VITE_API_URL` and
   `WEB_ORIGIN` as placeholders for now — you cannot know them yet. `AI_API_KEY`, `AI_MODEL` and
   `AI_VISION_MODEL` can stay empty while `AI_PROVIDER` is `rules`.

2. **Apply.** The database is created first, then the API builds, then the static site.
   The first API deploy runs `node dist/scripts/migrate.js`, which applies all eight files in
   `db/` and leaves the schema and master data in place.

3. **Note the two URLs Render assigns** — typically
   `https://chotug-api.onrender.com` and `https://chotug-web.onrender.com`.
   If either name was taken, Render appends a suffix; use whatever it actually shows.

4. **Fill in the two cross-references:**
   - On `chotug-api` → Environment → `WEB_ORIGIN` = the web URL, no trailing slash.
   - On `chotug-web` → Environment → `VITE_API_URL` = the API URL, no trailing slash.

5. **Redeploy the static site** (Manual Deploy → Deploy latest commit). The API only needs a
   restart, but a redeploy is fine.

6. **Seed the demo data** — one time only. On `chotug-api` → Shell:
   ```
   node dist/scripts/seed.js
   ```
   This sets the demo passwords (`chotug123`) and generates 90 days of demand history so the
   planning screens have something to forecast from. Without it, the users exist but cannot
   log in.

7. **Check it.** `https://chotug-api.onrender.com/api/health` should return
   `{"ok":true,"db":"chotug_erp",...}`. Then open the web URL and sign in as `owner@chotug.in`.


## Path B — Dashboard, no blueprint

Blueprint validation is strict about plan names, and those names change. If step 1 above fails to
validate, create the three resources by hand instead — the settings are identical:

**Postgres:** New → Postgres. Name `chotug-postgres`, database `chotug_erp`, user `chotug`,
region Singapore.

**API:** New → Web Service, same repo.

| Setting | Value |
|---|---|
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Pre-deploy command | `node dist/scripts/migrate.js` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Environment: `DATABASE_URL` (paste the **Internal** connection string from the database page),
`JWT_SECRET` (any long random string), `WEB_ORIGIN`, `NODE_VERSION=20`, `AI_PROVIDER=rules`.

**Web:** New → Static Site, same repo.

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm ci --include=dev && npm run build` |
| Publish directory | `dist` |
| Redirect/Rewrite | Source `/*` → Destination `/index.html`, type **Rewrite** |

Environment: `VITE_API_URL`.


## Why `--include=dev` is in both build commands

Render sets `NODE_ENV=production`. npm reads that and omits `devDependencies` by default, which
removes `typescript` — and the build fails with `tsc: not found`. `--include=dev` overrides it.
This is the single most common Render build failure for a TypeScript service.


## If you are on the free instance plan

`preDeployCommand` and Shell access both require a paid instance. On the free plan:

- Replace the start command with `node dist/scripts/migrate.js && npm start`. Migrations are
  idempotent, so re-running them on every cold start is safe — just slower to wake.
- Seed from your own machine instead, using the database's **External** connection string:
  ```
  cd server
  PGSSL=require DATABASE_URL='<external-url>' node dist/scripts/seed.js
  ```
  `PGSSL=require` is needed for any connection from outside Render's network; the internal URL
  used by the deployed API does not need it.

Also note: free web services sleep after 15 minutes idle and take ~30 seconds to wake, and a free
Postgres database is **deleted after 30 days**. Neither is suitable for a client demo you cannot
babysit.


## Before this carries anything real

- `JWT_SECRET` must be generated, not the dev default. The blueprint uses `generateValue: true`.
- Rotate the Groq API key currently sitting in `server/.env` if that file has ever left your machine.
- Move the database to a paid plan and turn on backups.
- QC and farm photos are stored as base64 text inside Postgres. That is fine for a demo and becomes
  a backup problem quickly — see the AI cost notes for the object-storage migration.
