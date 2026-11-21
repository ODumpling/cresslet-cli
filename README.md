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
import { db, files, secrets, app } from "cresslet";

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
- `files.put/get/delete/list`, `secrets.NAME` / `Object.keys(secrets)`, `app.{id,name,url,deployId}`: as on `env`.
- Bindings exist once a handler runs: using them at module top level throws a `CressletError` that says so. The `env` argument of `fetch(req, env)` keeps working.
- Needs a runtime with SDK support (runtime contract 1): `cresslet dev` from this package ≥ 0.2.0, and a Cresslet platform / studio that ships it. On an older one the SDK throws a `CressletError` saying what to update.
- Types: `Env`, `ScheduledEvent`, `WebSocketPair` and the other runtime globals come with the package, so a project no longer needs `server/cresslet.d.ts` (delete it when you import from `"cresslet"`: its globals would be declared twice).

## Commands

| | |
|---|---|
| `new <dir> [--template react\|vanilla]`, `init`, `templates` | scaffold |
| `dev [--port 3000]` | esbuild watch, live reload, server handler with local `db`/`files` (node:sqlite; SDK and `env`), secrets from `.env.cresslet`. WebSockets (`WebSocketPair`) work on server routes; run a cron by hand with `curl -X POST -H 'x-cresslet-dev: 1' 'localhost:3000/__cresslet/scheduled?cron=<expr>'` |
| `build` | client → `dist/`, server → `.cresslet/build/server.js` |
| `deploy [--name n] [--no-source]` | build + upload, with `crons` from `cresslet.json` and the project source (minus `node_modules/`, `dist/`, `.cresslet/`, `.git/`, `.env.cresslet*`, `.env*.local`, files matching top-level `.gitignore` simple patterns; other `.env*` files keep only single-line `CRESSLET_PUBLIC_*`/`VITE_*` entries, and nothing after the first line that isn't a plain `NAME=value` (a multi-line value), as the server does). Source shares the deploy's file/size limits; if it doesn't fit, the deploy goes without it. First deploy stores the deploy key in `.cresslet/app.json` (gitignored) |
| `deploy --dir <static> [--server <bundle.js>]` | deploy prebuilt output (any toolchain) |
| `deploy <file.html> \| deploy <dir> --artifact [--name n] [--visibility private\|link\|public] [--keep <days>\|forever] [--title t]` | deploy an **artifact** (account login): a single HTML file, or a folder with an `index.html` (hidden files and `node_modules/` left out). A folder without `cresslet.json` is a public app unless you pass `--artifact` (or `--visibility` / `--keep` / `--title`). The link to it is kept in `.cresslet/artifacts.json` next to the file (gitignored), so deploying it again updates the same URL; `--name` picks the address (yours, or a new one). Settings left out come from your defaults |
| `pull [app\|url] [--dir d] [--deploy id] [--force]` | download the source of the current (or given) deploy into `./<app>` and link it |
| `logs [app\|url] [-f] [-n N]` | server stdout/stderr, request log, system events |
| `db [sql]` | dump tables or run read-only SQL |
| `secrets [list \| set K=V… \| unset K…]` | claimed apps only |
| `domains [add \| verify \| rm <domain>]` | custom domains (claimed apps). `add` prints the CNAME + TXT records to create, then `verify` |
| `egress [allow <host…> \| clear]` | outbound `fetch` allowlist (claimed apps). `allow` sets the whole list (`*.` = subdomains); `clear` = any public host |
| `inspect [app\|url]`, `rollback [deployId]`, `open`, `delete [-y]` | |
| `artifact ls \| show <a> \| set <a> [--visibility v] [--keep d] [--title t] \| open <a> \| rm <a>` | manage artifacts (`<a>` = name or URL). `open` signs you in to a private one. `artifact upload <file\|dir> [--name n]` always makes a new one; `artifact update <a> <file\|dir>` replaces one's files (same link, retention clock restarts). `page …` (their old name) works too |
| `config [list] \| get api \| set api <url> \| unset api` | CLI settings in `~/.config/cresslet/config.json`. `list` shows the server in use and where it comes from (`--api` > `CRESSLET_API` > project link > config > default) |
| `settings [--artifact-visibility v] [--artifact-keep d\|forever] [--reset]` | your defaults for new artifacts (`--reset`: the server's; `--page-*` works too) |
| `auth login [--token t] [--no-browser]`, `auth logout`, `auth status`, `claim`, `apps` | accounts. `auth login` opens the studio to approve the CLI (older servers: GitHub device code); `--token` = token from studio Settings. `login` / `logout` / `whoami` work too |

Global: `--api <url>`, `--json`, `--app <name>`. Env: `CRESSLET_API`, `CRESSLET_TOKEN`, `CRESSLET_DEPLOY_KEY` (CI).

Client builds (`dev`, `build`, `deploy`) compile what the studio does, with the project's own packages: Tailwind CSS v4 (`tailwindcss`), PostCSS (`postcss.config.*`), Sass/Less (`sass`/`less`), CSS modules (`*.module.css/scss/less`), Vue SFCs (`vue`) and Svelte 5 components / `.svelte.js` modules (`svelte`), `?raw` / `?url` imports, and `%VITE_X%` in `index.html`.

App format: [docs/app-format.md](https://github.com/ODumpling/cresslet/blob/main/docs/app-format.md).

## Develop

```sh
npm install && npm test
```

MIT
