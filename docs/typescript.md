# TypeScript

The CLI, the SDK and the tests are TypeScript, checked with `strict` and compiled by `tsc` to `dist/`, which is what
npm publishes. Develop on Node ≥ 22.18 (the build scripts are `.ts`, run with Node's type stripping); the published
package runs on Node ≥ 22.13 (`engines`).

```sh
npm run typecheck   # tsc (everything), tsc (the SDK without Node's types), scripts/check-ts.ts
npm run build       # fresh dist/
npm test            # build, then node --test dist/test/*.test.js
```

## Layout

| source | compiled to | what |
| --- | --- | --- |
| `bin/cresslet.ts` | `dist/bin/cresslet.js` | the `cresslet` bin |
| `lib/*.ts` | `dist/lib/*.js` | the CLI; `lib/vite.ts` is `cresslet/vite` |
| `sdk/index.ts` | `dist/sdk/index.js` + `.d.ts` | `import … from "cresslet"` |
| `test/*.test.ts` | `dist/test/*.test.js` | tests (not published) |
| `scripts/*.ts` | (run as is) | `build`, `check-ts` |

Relative imports name the `.ts` file (`import { x } from "./util.ts"`); `rewriteRelativeImportExtensions` turns them
into `.js` in `dist/`. tsconfig.json checks everything (no emit); tsconfig.build.json emits `dist/` with declarations;
tsconfig.sdk.json checks the SDK with the DOM's types and not Node's, since it runs in app servers (workerd, the studio's
container), not in Node.

## How the package is built

`npm run build` (scripts/build.ts) deletes `dist/`, runs `tsc -p tsconfig.build.json`, and copies `lib/compilers.cjs`
to `dist/lib/` (lib/frontend.ts loads it by relative path). `prepack` runs it, so `npm pack` / `npm publish` always ship
a fresh build; `files` is `dist/bin`, `dist/lib`, `dist/sdk` (not `dist/test`). `bin` and `exports` point into `dist/`.
The published types are the declarations tsc emits from `sdk/index.ts` and `lib/vite.ts`: the docs and types there are
the only copy.

Paths at runtime: `bin` reads its version from `cresslet/package.json` (the package's self-reference, so it doesn't
matter where the file is); the tests run from `dist/test/` and find the fixtures two levels up.

## What stays JavaScript, and why

scripts/check-ts.ts fails on any other JavaScript file in the repo (its `JS_ALLOWED` list, with these reasons):

- `lib/compilers.cjs`: vendored verbatim from cresslet-container (`src/css/worker.cjs`). Change it there and copy it
  again; the code that uses it types the part it calls (lib/frontend.ts).
- `test/contract/app.js`: the shared SDK contract cases, an app's server module. The cresslet repo vendors it as
  JavaScript (tests/fixtures/sdk-contract.js).
- `test/fixture/**`: an app project the tests copy and build: its content, not this package's code.

## Rules

- `strict`, plus `noImplicitOverride`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly` (no enums, namespaces,
  parameter properties, `import x = require`, `<T>x` casts) and `verbatimModuleSyntax` (`import type` for types).
- No `@ts-ignore` / `@ts-nocheck`. `@ts-expect-error` only with a reason (`// @ts-expect-error -- why`): the tests use it
  where they misuse the SDK on purpose, which also checks that its types refuse that use.
- No `any` except at a real untyped boundary, with a comment: the SDK's public `Query<any>` parameters (as published
  before), and the fake API's JSON in test/platform.test.ts. Elsewhere `unknown` and a check, or a type for what's read.
- Server replies (lib/api.ts) aren't validated: each call names the shape it reads (`api.get<{ app: … }>(…)`).
- `!` only where something guarantees the value (it says what, in a comment).

## The SDK and the cresslet repo

`sdk/index.ts` is one self-contained file with no imports and only erasable TypeScript: the cresslet repo's
scripts/vendor-sdk.ts strips its types with `node:module`'s `stripTypeScriptTypes` and serves the result as the
studio's `cresslet` module (and copies `test/contract/app.js`). Keep it that way: no relative imports, nothing that
needs more than type stripping. The cresslet repo picks up a change when it vendors again (from this repo's main, or
`$CRESSLET_CLI_DIR`).

## Follow-ups

- `noUncheckedIndexedAccess`: not on yet (it would add a check or `!` to most array/record reads).
- Validate the server's replies (or share their types with the cresslet repo) instead of describing them per call.
- Flags given without a value are `true`; a few commands pass a flag on as text without checking (`--dir`, `--host`,
  `--app` …: `flags.x as string` in lib/commands.ts).
- The internal modules' `.d.ts` files are published too (only `cresslet` and `cresslet/vite` are exported).
