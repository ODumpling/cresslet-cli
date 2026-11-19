# Clover app

Small web app deployed on Clover. Client: plain TS (bundled by esbuild). Server: one fetch handler in a sandbox with SQLite + file storage.

## Layout
- `index.html` — entry; `<script type="module" src="/src/main.ts">` is bundled.
- `src/` — client code. Import CSS/JSON/images directly.
- `public/` — copied as-is to the site root.
- `server/index.ts` — `export default { fetch(req, env) }`. Gets requests matching `routes` in `clover.json` (default `/api/*`). Everything else is static, with SPA fallback to `index.html`.
- `server/clover.d.ts` — `Env` types: `env.db`, `env.files`, `env.secrets`, `env.app`.
- `clover.json` — `{ name, routes }`. `name` = subdomain (blank → assigned on first deploy).

## Commands
- `npm run dev` / `npx clover dev` — local dev server (http://localhost:3000), live reload, local SQLite in `.clover/dev/`.
- `npx clover build` — production build: client → `dist/`, server → `.clover/build/server.js`.
- `npx clover deploy` — build + deploy. Prints URL. First deploy creates the app and stores a deploy key in `.clover/app.json` (gitignored; keep it).
- `npx clover logs [-f]` — server logs + request log of the deployed app.
- `npx clover db [sql]` — inspect deployed DB (read-only).
- `npx clover secrets set KEY=value` — server secrets (`env.secrets.KEY`). Needs `npx clover login` + `npx clover claim`.
- `npx clover open` — open deployed app.

## Server rules
- Web-standard APIs only: `fetch`, `Request`, `Response`, `URL`, `crypto`, `TextEncoder`, streams. No `fs`, `process`, `child_process`.
- npm packages are bundled into `server.js`; pure-JS packages only.
- DB: `await env.db.query(sql, ...params)` → rows, `first` → row|null, `run` → `{changes, lastInsertRowid}`, `exec` for DDL. Create schema with `CREATE TABLE IF NOT EXISTS` on first request (see `server/index.ts`).
- Files: `env.files.put(key, body, {contentType})`, `get(key)` → `Response|null`, `delete`, `list(prefix)`.
- Outbound `fetch` and secrets only work on claimed apps. Unclaimed deploys expire after 72h.
- Each request has a 30s limit; memory 256MB. Keep state in `env.db`/`env.files`, not globals.

## Verify
After deploy: `curl <url>/api/health` and `npx clover logs`.
