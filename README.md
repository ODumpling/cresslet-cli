# cresslet-cli

SDK and CLI for [Cresslet](https://github.com/ODumpling/cresslet): create, run and deploy small web apps. Built for humans and coding agents (`--json` everywhere).

```sh
npx cresslet new my-app     # or: init (current dir); or install it: npm i -g cresslet
cd my-app && npm install                       # templates depend on this CLI
npm run dev                                    # http://localhost:3000, live reload, local SQLite
npx cresslet deploy                              # prints URL
```

Just want to share an HTML file or a static folder? Log in once and deploy it as an **artifact**: private unless you say otherwise, kept for 30 days by default, same URL every time you deploy it again.

```sh
npx cresslet login
npx cresslet deploy report.html --name q4-report --visibility link   # → https://q4-report.cresslet.dev
npx cresslet deploy report.html                                       # updated, same link
npx cresslet deploy ./slides --artifact                               # a folder with an index.html
```

Requires Node ≥ 22.13. Server: `https://cresslet.dev` by default; change it with `cresslet config set api <url>` (e.g. `http://localhost:8787` for a local server), or per command with `--api <url>` / `CRESSLET_API`.

## SDK

App server code imports its bindings from this package (bundled into the app; types included):

```ts
import { db, kv, files, secrets, app } from "cresslet";

export default {
  async fetch(req: Request) {
    const id = Number(new URL(req.url).searchParams.get("id"));
    const todo = await db.first(db.sql`SELECT * FROM todos WHERE id = ${id}`);
    const key = secrets.get("STRIPE_KEY"); // throws, naming it, if unset; secrets.optional("X") → string | undefined
    return Response.json({ todo, app: app.name });
  },
};
```

- ``db.sql`...` ``: each `${value}` is a parameter, never SQL text (a nested `db.sql` fragment is spliced in). Pass it to `db.query` (rows), `db.first` (row | null), `db.run` (`{changes, lastInsertRowid}`), or `await` it for the rows. `query/first/run(sql, ...params)` with `?` still work; `db.exec(sql)` runs DDL.
- `db.batch([...statements])`: one transaction, all or nothing, with no other request's statement in between; one `{rows, changes, lastInsertRowid}` per statement.
- `kv` (0.3.0): JSON values by key with optional TTL, kept in the app's own database (table `_cresslet_kv`; nothing new needed from the runtime). `kv.get(key)` → value | null, `kv.set(key, value, { ttl })` (seconds), `kv.delete(key)`, `kv.incr(key, by = 1, { ttl })` (atomic; ttl starts the window: rate limits), `kv.list(prefix, { limit })` → `{key, value, expiresAt}[]`.
- `files.put/get/delete/list`, `secrets.NAME` / `Object.keys(secrets)`, `app.{id,name,url,deployId,env}` (`env`: `"production"`, or `"staging"`): as on `env`.
- Bindings exist once a handler runs: using them at module top level throws a `CressletError` that says so. The `env` argument of `fetch(req, env)` keeps working.
- Needs a runtime with SDK support (runtime contract 1): `cresslet dev` from this package ≥ 0.2.0, and a Cresslet platform / studio that ships it. On an older one the SDK throws a `CressletError` saying what to update.
- Types: `Env`, `ScheduledEvent`, `WebSocketPair` and the other runtime globals come with the package, so a project no longer needs `server/cresslet.d.ts` (delete it when you import from `"cresslet"`: its globals would be declared twice).

## Framework apps (Vite: TanStack Start, …)

A project can use its framework's own build instead of `index.html` + `server/index.ts` (template: `tanstack-start`):

```jsonc
// cresslet.json
{
  "routes": ["/*", "!/assets/*", "!/favicon.svg"], // SSR everywhere except built assets and public files
  "build": { "command": "vite build", "static": "dist/client", "server": "dist/server/server.js", "dev": "vite dev" }
}
```

`build`/`deploy` run `command` (with `node_modules/.bin` on PATH, `NODE_ENV=production`), serve `static` as-is (minus `.env*`, `.cresslet/`, `.git/`, `node_modules/`), and bundle `server` (a module with `export default { fetch }`) and everything it imports into one `.cresslet/build/server.js`. `dev` runs the `dev` command (`--port` is passed on). Routes starting with `!` exclude paths from the server (needs a server with route exclusions).

For `vite dev`, `cresslet/vite` provides the bindings to server code in Vite's SSR process (same local data as `cresslet dev`, `.env.cresslet` re-read on save):

```ts
// vite.config.ts
import { cresslet } from "cresslet/vite";
export default defineConfig({ plugins: [cresslet(), tanstackStart(), viteReact()] });
```

## Commands

| | |
|---|---|
| `new <dir> [--template react\|vanilla\|tanstack-start]`, `init`, `templates` | scaffold |
| `dev [--port 3000]` | esbuild watch, live reload, server handler with local `db`/`files` (node:sqlite; SDK and `env`), secrets from `.env.cresslet`. WebSockets (`WebSocketPair`) work on server routes; run a cron by hand with `curl -X POST -H 'x-cresslet-dev: 1' 'localhost:3000/__cresslet/scheduled?cron=<expr>'` |
| `build` | client → `dist/`, server → `.cresslet/build/server.js` (framework apps: `build.command`, then the server bundle) |
| `deploy [--name n] [--no-source]` | build + upload, with `crons` from `cresslet.json` and the project source (minus `node_modules/`, `dist/`, `.cresslet/`, `.git/`, `.env.cresslet*`, `.env*.local`, files matching top-level `.gitignore` simple patterns; other `.env*` files keep only single-line `CRESSLET_PUBLIC_*`/`VITE_*` entries, and nothing after the first line that isn't a plain `NAME=value` (a multi-line value), as the server does). Source shares the deploy's file/size limits; if it doesn't fit, the deploy goes without it. First deploy stores the deploy key in `.cresslet/app.json` (gitignored) |
| `deploy --dir <static> [--server <bundle.js>]` | deploy prebuilt output (any toolchain) |
| `deploy --env staging` | deploy to the app's **staging** (made by its first deploy; the app must exist): `https://<app>--staging.<domain>`, private (you, the app's collaborators and its organization, signed in through the studio), its own database and files (empty to start), its own sandbox, production's secrets with its own overrides (`secrets set K=V --env staging`), crons only by Run now, never tagged. From a git checkout it records the commit as it is (nothing merged). Goes through its own route, so a server without environments refuses it rather than deploying to production |
| `promote [--from staging] [-y]` | production serves the deploy staging serves: the same bundle, not rebuilt, with production's own data and secrets. A GitHub-linked app: the server first moves the default branch to that deploy's commit (fast-forward only; refused when the default branch moved on, is protected, or the branch was pushed to since) and tags it `v<n>` |
| `env [ls] \| seed <env> [--from production] \| rm <env> [-y]` | the app's environments. `seed`: replace staging's database with a snapshot of production's (files aren't copied). `rm`: delete it, its data and its deploys (ones promoted to production stay) |
| `deploy <file.html> \| deploy <dir> --artifact [--name n] [--visibility private\|link\|public] [--keep <days>\|forever] [--title t]` | deploy an **artifact** (account login): a single HTML file, or a folder with an `index.html` (hidden files and `node_modules/` left out). A folder without `cresslet.json` is a public app unless you pass `--artifact` (or `--visibility` / `--keep` / `--title`). The link to it is kept in `.cresslet/artifacts.json` next to the file or folder (outside the folder, so a rebuilt `dist/` keeps it; gitignored inside a git repo), so deploying it again updates the same URL (if it expired, you get a new one); `--name` picks the address (yours, or a new one). Settings left out come from your defaults |
| `pull [app\|url] [--dir d] [--deploy id] [--force]` | download the source of the current (or given) deploy into `./<app>` and link it |
| `logs [app\|url] [-f] [-n N] [--env staging]` | server stdout/stderr, request log, system events (a staging URL works as `app` too) |
| `db [sql] [--env staging]` | dump tables or run read-only SQL |
| `secrets [list \| set K=V… \| unset K…] [--env staging]` | claimed apps only. `--env staging`: staging's own, overriding production's (`list` shows which it inherits) |
| `domains [add \| verify \| rm <domain>]` | custom domains (claimed apps). `add` prints the CNAME + TXT records to create, then `verify` |
| `egress [allow <host…> \| clear]` | outbound `fetch` allowlist (claimed apps). `allow` sets the whole list (`*.` = subdomains); `clear` = any public host |
| `inspect [app\|url] [--env staging]`, `rollback [deployId] [--env staging]`, `open`, `delete [-y]` | rollback per environment: production's history is what it was deployed or promoted to |
| `git status \| connect <owner/repo> [--push] \| sync [-m msg] [--branch b]` | the app's GitHub repository, through the server as you (connect GitHub once in the studio: Settings → Account). `connect` links the app (`--push`: this project's source becomes the default branch); `sync` commits this project's source to the branch, only on top of the commit this checkout is at. `deploy` from a clean git checkout records its commit (`inspect` shows `branch @ sha`) |
| `artifact ls \| show <a> \| set <a> [--visibility v] [--keep d] [--title t] \| open <a> \| rm <a>` | manage artifacts (`<a>` = name or URL). `open` signs you in to a private one. `artifact upload <file\|dir> [--name n]` always makes a new one; `artifact update <a> <file\|dir>` replaces one's files (same link, retention clock restarts). `page …` (their old name) works too |
| `config [list] \| get api \| set api <url> \| unset api` | CLI settings in `~/.config/cresslet/config.json`. `list` shows the server in use and where it comes from (`--api` > `CRESSLET_API` > project link > config > default) |
| `settings [--artifact-visibility v] [--artifact-keep d\|forever] [--reset]` | your defaults for new artifacts (`--reset`: the server's; `--page-*` works too) |
| `auth login [--token t] [--no-browser]`, `auth logout`, `auth status`, `claim`, `apps` | accounts. `auth login` opens the studio to approve the CLI (older servers: GitHub device code); `--token` = token from studio Settings. `logout` revokes the login's remembered Live Link agents (and its token, if `login` created it; a `--token` one stays valid; `CRESSLET_TOKEN` is never touched). `login` / `logout` / `whoami` work too |
| `connect [--agent <name>] [--eager]` | stdio MCP server that bridges a desktop coding agent (Claude Code, Codex, T3 Code, Cursor, VS Code) to an open Cresslet Studio project tab. Requires `cresslet login`. Prints a short pairing code to stderr (and returns it if a tool is called before pairing); enter the code in the Studio project's **Connect agent** panel, tick **Remember this agent**, and click **Allow**: it reconnects without a code from then on. Talks only to the server you logged in to (`--api`, `CRESSLET_API`, config), never one a project's `.cresslet/app.json` names |

### Live Link (`cresslet connect`)

Register `cresslet connect` as a stdio MCP server in your desktop agent (for example, `claude mcp add cresslet -- npx cresslet connect`):

- Exposes the same 7 Studio builder tools (`list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `run_command`, `read_dev_log`) plus `commit_change(title)` to mark a turn boundary (and commit a stack change on GitHub-linked apps).
- Pairs with one open Studio project tab belonging to your own account via a short one-time code (`XXXX-XXXX`). With **Remember this agent** ticked, it keeps a credential (`~/.config/cresslet/agents/<id>.json`, 0600; reconnecting needs it *and* the login token) and reconnects on its own after restarts, drops, tab reloads and server restarts, to the projects you allowed (more from a project's tab: **Connect agent → Allow**).
- A remembered agent also gets `list_projects`, `use_project(handle)` (switching away from the current project needs your click in the target tab) and `confirm_project(ack)`: a project it picked by itself (the one this folder last used, or the only one open) is announced before anything runs.
- **Disconnect** in the tab pauses the project until **Resume**; **Forget agent** (or Studio Settings → Connected agents) revokes it.
- Deploys started via `run_command` still require clicking **Approve deploy** in the Studio tab.
- Per-harness setup (Claude Code, Codex, T3 Code, Cursor, VS Code; absolute `node` + script paths for GUI apps, and Windows): [docs/live-link.md](https://github.com/ODumpling/cresslet/blob/main/docs/live-link.md).

Global: `--api <url>`, `--json`, `--app <name>`. Env: `CRESSLET_API`, `CRESSLET_TOKEN`, `CRESSLET_DEPLOY_KEY` (CI).

Client builds (`dev`, `build`, `deploy`) compile what the studio does, with the project's own packages: Tailwind CSS v4 (`tailwindcss`), PostCSS (`postcss.config.*`), Sass/Less (`sass`/`less`), CSS modules (`*.module.css/scss/less`), Vue SFCs (`vue`) and Svelte 5 components / `.svelte.js` modules (`svelte`), `?raw` / `?url` imports, and `%VITE_X%` in `index.html`.

App format: [docs/app-format.md](https://github.com/ODumpling/cresslet/blob/main/docs/app-format.md).

## Develop

```sh
npm install && npm run typecheck && npm test
```

TypeScript, compiled to `dist/` (what's published): see [docs/typescript.md](docs/typescript.md). Needs Node ≥ 22.18
to develop (the build scripts are `.ts`); the package itself runs on Node ≥ 22.13.

MIT
