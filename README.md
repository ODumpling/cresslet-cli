# clover-cli

CLI for [Clover](https://github.com/ODumpling/clover): create, run and deploy small web apps. Built for humans and coding agents (`--json` everywhere).

```sh
npx github:ODumpling/clover-cli new my-app     # or: init (current dir)
cd my-app && npm install                       # templates depend on this CLI
npm run dev                                    # http://localhost:3000, live reload, local SQLite
npx clover deploy                              # prints URL
```

Requires Node ≥ 22.13. Server: `CLOVER_API` / `--api` (default `http://localhost:8787`).

## Commands

| | |
|---|---|
| `new <dir> [--template react\|vanilla]`, `init`, `templates` | scaffold |
| `dev [--port 3000]` | esbuild watch, live reload, server handler with local `env.db`/`env.files`, secrets from `.env.clover` |
| `build` | client → `dist/`, server → `.clover/build/server.js` |
| `deploy [--name n]` | build + upload. First deploy stores the deploy key in `.clover/app.json` (gitignored) |
| `deploy --dir <static> [--server <bundle.js>]` | deploy prebuilt output (any toolchain) |
| `logs [app\|url] [-f] [-n N]` | server stdout/stderr, request log, system events |
| `db [sql]` | dump tables or run read-only SQL |
| `secrets [list \| set K=V… \| unset K…]` | claimed apps only |
| `inspect [app\|url]`, `rollback [deployId]`, `open`, `delete [-y]` | |
| `login [--email]`, `logout`, `whoami`, `claim`, `apps` | accounts |

Global: `--api <url>`, `--json`, `--app <name>`. Env: `CLOVER_API`, `CLOVER_TOKEN`, `CLOVER_DEPLOY_KEY` (CI).

App format: [docs/app-format.md](https://github.com/ODumpling/clover/blob/main/docs/app-format.md).

## Develop

```sh
npm install && npm test
```

MIT
