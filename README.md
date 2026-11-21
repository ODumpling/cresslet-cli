# cresslet-cli

CLI for [Cresslet](https://github.com/ODumpling/cresslet): create, run and deploy small web apps. Built for humans and coding agents (`--json` everywhere).

```sh
npx cresslet new my-app     # or: init (current dir); or install it: npm i -g cresslet
cd my-app && npm install                       # templates depend on this CLI
npm run dev                                    # http://localhost:3000, live reload, local SQLite
npx cresslet deploy                              # prints URL
```

Requires Node ≥ 22.13. Server: `https://cresslet.dev` by default; change it with `cresslet config set api <url>` (e.g. `http://localhost:8787` for a local server), or per command with `--api <url>` / `CRESSLET_API`.

## Commands

| | |
|---|---|
| `new <dir> [--template react\|vanilla]`, `init`, `templates` | scaffold |
| `dev [--port 3000]` | esbuild watch, live reload, server handler with local `env.db`/`env.files`, secrets from `.env.cresslet`. WebSockets (`WebSocketPair`) work on server routes; run a cron by hand with `curl -X POST -H 'x-cresslet-dev: 1' 'localhost:3000/__cresslet/scheduled?cron=<expr>'` |
| `build` | client → `dist/`, server → `.cresslet/build/server.js` |
| `deploy [--name n] [--no-source]` | build + upload, with `crons` from `cresslet.json` and the project source (minus `node_modules/`, `dist/`, `.cresslet/`, `.git/`, `.env.cresslet*`, `.env*.local`, files matching top-level `.gitignore` simple patterns; other `.env*` files keep only single-line `CRESSLET_PUBLIC_*`/`VITE_*` entries, and nothing after the first line that isn't a plain `NAME=value` (a multi-line value), as the server does). Source shares the deploy's file/size limits; if it doesn't fit, the deploy goes without it. First deploy stores the deploy key in `.cresslet/app.json` (gitignored) |
| `deploy --dir <static> [--server <bundle.js>]` | deploy prebuilt output (any toolchain) |
| `pull [app\|url] [--dir d] [--deploy id] [--force]` | download the source of the current (or given) deploy into `./<app>` and link it |
| `logs [app\|url] [-f] [-n N]` | server stdout/stderr, request log, system events |
| `db [sql]` | dump tables or run read-only SQL |
| `secrets [list \| set K=V… \| unset K…]` | claimed apps only |
| `domains [add \| verify \| rm <domain>]` | custom domains (claimed apps). `add` prints the CNAME + TXT records to create, then `verify` |
| `egress [allow <host…> \| clear]` | outbound `fetch` allowlist (claimed apps). `allow` sets the whole list (`*.` = subdomains); `clear` = any public host |
| `inspect [app\|url]`, `rollback [deployId]`, `open`, `delete [-y]` | |
| `page upload <file.html\|dir> [--visibility private\|link\|public] [--keep <days>\|forever] [--title t]` | upload a static page (account login); prints its URL. Settings left out come from your defaults |
| `page ls \| show <page> \| update <page> <file\|dir> \| set <page> [--visibility v] [--keep d] \| open <page> \| rm <page>` | manage pages (`<page>` = name or URL). `update` keeps the link and restarts the retention clock; `open` signs you in to a private page |
| `config [list] \| get api \| set api <url> \| unset api` | CLI settings in `~/.config/cresslet/config.json`. `list` shows the server in use and where it comes from (`--api` > `CRESSLET_API` > project link > config > default) |
| `settings [--page-visibility v] [--page-keep d\|forever] [--reset]` | your defaults for new pages (`--reset`: the server's) |
| `auth login [--token t] [--no-browser]`, `auth logout`, `auth status`, `claim`, `apps` | accounts. `auth login` opens the studio to approve the CLI (older servers: GitHub device code); `--token` = token from studio Settings. `login` / `logout` / `whoami` work too |

Global: `--api <url>`, `--json`, `--app <name>`. Env: `CRESSLET_API`, `CRESSLET_TOKEN`, `CRESSLET_DEPLOY_KEY` (CI).

Client builds (`dev`, `build`, `deploy`) compile what the studio does, with the project's own packages: Tailwind CSS v4 (`tailwindcss`), PostCSS (`postcss.config.*`), Sass/Less (`sass`/`less`), CSS modules (`*.module.css/scss/less`), Vue SFCs (`vue`) and Svelte 5 components / `.svelte.js` modules (`svelte`), `?raw` / `?url` imports, and `%VITE_X%` in `index.html`.

App format: [docs/app-format.md](https://github.com/ODumpling/cresslet/blob/main/docs/app-format.md).

## Develop

```sh
npm install && npm test
```

MIT
