// Studio parity: Tailwind v4, PostCSS, Sass/Less, CSS modules, Vue/Svelte SFCs, ?raw/?url, %VITE_X% in build and dev;
// and the fail-closed dotenv sanitizer for uploaded sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, listSources, publicDotenvText, publicEnv, readSource } from "../lib/build.js";
import { dev } from "../lib/dev.js";
import { extractCandidates, globToRegExp, htmlEnv, scanSources } from "../lib/frontend.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A project in a temp dir; `modules`: link this repo's node_modules (tailwindcss, sass, less, vue, svelte, postcss). */
function project(files, { modules = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-fe-"));
  if (modules) fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const html = (head, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const pkg = (deps) => JSON.stringify({ name: "x", type: "module", dependencies: deps });
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const outputs = (dir, ext) =>
  fs.readdirSync(path.join(dir, "dist", "assets")).filter((f) => f.endsWith(ext)).map((f) => read(dir, `dist/assets/${f}`)).join("\n");

// ---- dotenv sanitizer

test("publicDotenvText keeps public single-line entries verbatim, drops comments and secrets", () => {
  const src = [
    "# a comment",
    "VITE_A=1",
    "export CRESSLET_PUBLIC_B='two'",
    'VITE_C="three" # trailing',
    "DB_PASSWORD=hunter2",
    "# STRIPE_SECRET=sk_live_commented",
    "",
    "  VITE_D = spaced  ",
  ].join("\n");
  assert.equal(publicDotenvText(src), ["VITE_A=1", "export CRESSLET_PUBLIC_B='two'", 'VITE_C="three" # trailing', "", "  VITE_D = spaced  "].join("\n"));
});

test("publicDotenvText fails closed on multi-line values: nothing after them leaves the machine", () => {
  const cases = {
    // a quoted value that runs on: its continuation lines look like public entries / comments
    'double-quoted continuation': 'VITE_OK=1\nPRIVATE_KEY="-----BEGIN KEY-----\nVITE_LEAK=sk_live_1\n-----END KEY-----"\nVITE_AFTER=2',
    "single-quoted continuation": "VITE_OK=1\nSECRET='line1\n# sk_live_2\nline3'\nVITE_AFTER=2",
    "public quoted value opening a continuation": 'VITE_OK=1\nVITE_X="start\n# sk_live_3\n"',
    "backtick value": "VITE_OK=1\nSECRET=`a\nVITE_LEAK=sk_live_4\n`",
    "escaped quote keeps the string open": 'VITE_OK=1\nSECRET="a\\"\nVITE_LEAK=sk_live_5\n"',
    "unquoted backslash continuation": "VITE_OK=1\nSECRET=abc\\\nVITE_LEAK=sk_live_6",
    "value on the next line": "VITE_OK=1\nSECRET=\n  VITE_LEAK=sk_live_7",
    "yaml-style KEY: value": "VITE_OK=1\nSECRET: sk_live_8\nVITE_AFTER=2",
    "unterminated quote": 'VITE_OK=1\nVITE_X="never closed\nVITE_LEAK=sk_live_9',
    "lone CR is a line break to some parsers": "VITE_OK=1\nSECRET=a\rVITE_LEAK=sk_live_10",
    "U+2028 is a line break to some parsers": "VITE_OK=1\nSECRET=a VITE_LEAK=sk_live_11",
    "garbage line": "VITE_OK=1\n!!!\nVITE_AFTER=2",
  };
  for (const [name, src] of Object.entries(cases)) {
    const out = publicDotenvText(src);
    assert.equal(out, "VITE_OK=1", name);
    assert.doesNotMatch(out, /sk_live|LEAK|AFTER/, name);
  }
});

test("publicDotenvText: BOM and CRLF", () => {
  assert.equal(publicDotenvText("﻿VITE_A=1\r\nSECRET=x\r\nVITE_B=2\r\n"), "VITE_A=1\nVITE_B=2\n");
});

test("readSource sanitizes every .env* name (as the server), leaves other files byte-for-byte", () => {
  const secret = 'VITE_A=1\nKEY="-----BEGIN\nVITE_LEAK=sk_live\n-----END"\nVITE_B=2\n';
  const names = [".env", ".env.production", "sub/.ENV_backup", ".env~", ".env copy", ".envbak", "src/.environment.js"];
  const dir = project({ ...Object.fromEntries(names.map((f) => [f, secret])), "src/env.js": secret }, { modules: false });
  for (const f of names) assert.equal(readSource(dir, f).toString(), "VITE_A=1", f);
  assert.equal(readSource(dir, "src/env.js").toString(), secret);
});

test("listSources leaves out what the server never stores as source", () => {
  const out = [".env.local", ".env.production.local", ".env.cresslet", ".env.cresslet.prod", "sub/.env.local.bak", ".envrc", ".envrc.bak",
    ".dev.vars", ".dev.vars.bak", ".envs/prod.txt", "sub/.env.d/x"];
  const kept = [".env", ".env~", "src/a.js"];
  const dir = project(Object.fromEntries([...out, ...kept].map((f) => [f, "SECRET=x"])), { modules: false });
  assert.deepEqual(listSources(dir), [...kept].sort());
});

// ---- build parity

test("build: Tailwind v4 utilities from the project's sources only", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "x", type: "module", devDependencies: { tailwindcss: "^4" } }),
    "index.html": html('<link rel="stylesheet" href="/src/style.css">', '<div class="p-4"></div><script type="module" src="/src/main.js"></script>'),
    "src/style.css": '@import "tailwindcss";\n@theme { --color-brand: #123456; }\n',
    "src/main.js": 'document.body.className = "bg-brand text-red-500";\n',
    "dist/old.js": 'x = "bg-green-900"', // build output is not a source
    ".hidden/x.html": '<p class="bg-yellow-900"></p>', // dot-directories are not sources
  });
  await build(dir);
  const css = outputs(dir, ".css");
  for (const c of [".p-4", ".bg-brand", ".text-red-500", "#123456"]) assert.ok(css.includes(c), c);
  for (const c of ["bg-green-900", "bg-yellow-900", ".m-8"]) assert.ok(!css.includes(c), c);
});

test("build: PostCSS config plugins run (Tailwind first when the config has no Tailwind plugin)", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "x", type: "module", devDependencies: { tailwindcss: "^4", postcss: "^8" } }),
    "postcss.config.cjs": 'module.exports = { plugins: [require("./mark.cjs")] }\n',
    "mark.cjs": 'module.exports = { postcssPlugin: "mark", Once(root) { root.append({ selector: ".marked", nodes: [{ prop: "color", value: "red" }] }) } }\n',
    "index.html": html('<link rel="stylesheet" href="/src/style.css">', '<p class="underline"></p>'),
    "src/style.css": '@import "tailwindcss";\n',
  });
  await build(dir);
  const css = outputs(dir, ".css");
  assert.match(css, /\.marked\{color:red\}/);
  assert.match(css, /\.underline\{/);
});

test("build: Sass (with partials and rebased url()s), Less, CSS modules", async () => {
  const dir = project({
    "package.json": pkg({}),
    "index.html": html(
      '<link rel="stylesheet" href="/src/main.scss"><link rel="stylesheet" href="/src/theme.less">',
      '<script type="module" src="/src/main.js"></script>',
    ),
    "src/main.scss": '@use "parts/colors" as c;\n.a { color: c.$main; .b { margin: 1px; } }\n',
    "src/parts/_colors.scss": "$main: #abcdef;\n.bg { background: url(../img/dot.png); }\n",
    "src/img/dot.png": "PNG",
    "src/theme.less": "@c: #fedcba;\n.l { color: @c; }\n",
    "src/card.module.scss": "$p: 3px;\n.title { padding: $p; }\n",
    "src/main.js": 'import s from "./card.module.scss";\nwindow.cls = s.title;\n',
  });
  const r = await build(dir);
  const css = outputs(dir, ".css");
  assert.match(css, /\.a\{color:#abcdef\}/);
  assert.match(css, /\.a \.b\{margin:1px\}/);
  assert.match(css, /\.l\{color:#fedcba\}/);
  assert.match(css, /url\("?\/assets\/dot-[A-Z0-9]+\.png"?\)/); // a partial's url() is relative to the partial
  assert.ok(r.files.some((f) => /^assets\/dot-.*\.png$/.test(f)));
  const local = css.match(/\.([\w-]+)\{padding:3px\}/)?.[1]; // local-css: a renamed class, exported to JS
  assert.ok(local);
  assert.ok(outputs(dir, ".js").includes(JSON.stringify(local)));
});

test("build: Vue SFC (script setup + TS, scoped Sass style, template asset) and Svelte 5 (runes, .svelte.ts)", async () => {
  const dir = project({
    "package.json": pkg({ vue: "^3", svelte: "^5" }),
    "index.html": html("", '<div id="app"></div><script type="module" src="/src/main.ts"></script>'),
    "src/main.ts": [
      'import { createApp } from "vue";',
      'import { mount } from "svelte";',
      'import App from "./App.vue";',
      'import Counter from "./Counter.svelte";',
      'import { store } from "./store.svelte.ts";',
      'createApp(App).mount("#app");',
      "mount(Counter, { target: document.body, props: { store } });",
    ].join("\n"),
    "src/App.vue": [
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      "const n = ref<number>(1);",
      "</script>",
      '<template><button class="btn" @click="n++">{{ n }}</button><img src="./logo.svg"></template>',
      '<style scoped lang="scss">$c: #010203; .btn { color: $c; }</style>',
    ].join("\n"),
    "src/logo.svg": "<svg/>",
    "src/Counter.svelte": '<script>let { store } = $props(); let c = $state(0);</script>\n<button onclick={() => c++}>{c} {store.n}</button>\n<style>button { margin: 7px; }</style>\n',
    "src/store.svelte.ts": "export const store = $state({ n: 1 as number });\n",
  });
  const r = await build(dir);
  const css = outputs(dir, ".css");
  assert.match(css, /\.btn\[data-v-[0-9a-f]{8}\]\{color:#010203\}/);
  assert.match(css, /button\.svelte-[a-z0-9]+\{margin:7px\}/);
  assert.ok(r.files.some((f) => /^assets\/logo-.*\.svg$/.test(f)), "template asset bundled");
  const out = read(dir, "dist/index.html");
  assert.match(out, /<link rel="stylesheet" href="\/assets\/main-[A-Z0-9]+\.css">/);
  const js = outputs(dir, ".js");
  assert.ok(!js.includes("__hmrId"), "production output has no HMR code");
  assert.ok(!js.includes("as number"), "TypeScript stripped (.vue lang=ts, .svelte.ts)");
});

test("build: ?raw and ?url imports, %VITE_X% in index.html", async () => {
  const dir = project({
    "package.json": pkg({}),
    ".env": "VITE_TITLE=Hello there\nSECRET=nope\n",
    "index.html": html("<title>%VITE_TITLE% %MODE% %SECRET% %NOPE%</title>", '<script type="module" src="/src/main.js"></script>'),
    "src/main.js": 'import t from "./notes.md?raw";\nimport u from "./logo.svg?url";\nwindow.x = [t, u];\n',
    "src/notes.md": "# raw text 123\n",
    "src/logo.svg": "<svg/>",
  });
  const r = await build(dir);
  const out = read(dir, "dist/index.html");
  assert.match(out, /<title>Hello there production %SECRET% %NOPE%<\/title>/);
  const js = outputs(dir, ".js");
  assert.ok(js.includes("# raw text 123"));
  assert.match(js, /"\/assets\/logo-[A-Z0-9]+\.svg"/);
  assert.ok(r.files.some((f) => /^assets\/logo-.*\.svg$/.test(f)));
});

test("publicEnv: Studio's files, precedence and value syntax; fail closed on multi-line values", () => {
  const dir = project({
    // (a backslash is not understood by every parser: it ends the file, as on the server)
    ".env": 'VITE_A=base\nVITE_B="quoted" # note\nVITE_C=plain # note\nSECRET=x\nVITE_N="a\\nb"\nVITE_Z=after\n',
    ".env.local": "VITE_A=local\n",
    ".env.production": "VITE_P=prod\n",
    ".env.production.local": 'VITE_P=prodlocal\nKEY="-----BEGIN\nVITE_LEAK=sk_live\n-----END"\nVITE_AFTER=1\n',
  }, { modules: false });
  const env = publicEnv(dir, "production");
  assert.deepEqual(
    { A: env.VITE_A, B: env.VITE_B, C: env.VITE_C, P: env.VITE_P },
    { A: "local", B: '"quoted"', C: "plain", P: "prodlocal" }, // (Studio keeps a quoted value's quotes before a comment)
  );
  for (const k of ["SECRET", "VITE_N", "VITE_Z", "VITE_LEAK", "VITE_AFTER"]) assert.ok(!(k in env), k);
});

test("build: a multi-line secret's continuation never reaches index.html or the bundle", async () => {
  const dir = project({
    "package.json": pkg({}),
    ".env": 'VITE_OK=yes\nPRIVATE="-----BEGIN\nVITE_LEAK=sk_live_html\n-----END"\n',
    "index.html": html("<title>%VITE_OK% %VITE_LEAK%</title>", '<script type="module" src="/src/main.js"></script>'),
    "src/main.js": "window.e = import.meta.env;\n",
  }, { modules: false });
  await build(dir);
  const out = read(dir, "dist/index.html") + outputs(dir, ".js");
  assert.match(out, /<title>yes %VITE_LEAK%<\/title>/);
  assert.ok(!out.includes("sk_live_html"));
});

test("build: root-relative ?raw / ?url, two @source globs under one directory, NODE_ENV left as it was", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "x", type: "module", devDependencies: { tailwindcss: "^4" } }),
    "index.html": html('<link rel="stylesheet" href="/src/style.css">', '<script type="module" src="/src/main.js"></script>'),
    "src/style.css": '@import "tailwindcss" source(none);\n@source "./views/**/*.html";\n@source "./views/**/*.vue";\n',
    "src/views/a.html": '<p class="bg-pink-300"></p>',
    "src/views/b.vue": '<template><p class="bg-teal-300"></p></template>',
    "src/main.js": 'import t from "/src/notes.txt?raw";\nimport u from "/src/logo.svg?url";\nwindow.x = [t, u];\n',
    "src/notes.txt": "root raw 42",
    "src/logo.svg": "<svg/>",
  });
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    await build(dir);
    assert.equal(process.env.NODE_ENV, "test");
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
  const css = outputs(dir, ".css");
  assert.ok(css.includes("bg-pink-300") && css.includes("bg-teal-300"));
  const js = outputs(dir, ".js");
  assert.ok(js.includes("root raw 42"));
  assert.match(js, /"\/assets\/logo-[A-Z0-9]+\.svg"/);
});

test("build: compile errors name the file and line; a missing compiler says what to install", async () => {
  const bad = project({
    "package.json": pkg({ svelte: "^5" }),
    "index.html": html("", '<script type="module" src="/src/main.js"></script>'),
    "src/main.js": 'import C from "./C.svelte";\nwindow.c = C;\n',
    "src/C.svelte": "<script>let x = ;</script>\n",
  });
  await assert.rejects(build(bad), /client build failed:[\s\S]*C\.svelte:1:\d+/);
  const none = project({
    "package.json": pkg({}),
    "index.html": html('<link rel="stylesheet" href="/src/a.scss">'),
    "src/a.scss": "$x: 1px;\n",
  }, { modules: false });
  await assert.rejects(build(none), /needs the `sass` package/);
});

test("build: plain CSS projects are untouched (no Tailwind/PostCSS: esbuild's own CSS)", async () => {
  const dir = project({
    "package.json": pkg({}),
    "index.html": html('<link rel="stylesheet" href="/src/a.css">'),
    "src/a.css": "@theme { --x: 1 }\n.a { color: red }\n", // Tailwind syntax, but the project doesn't use Tailwind
  }, { modules: false });
  await build(dir);
  assert.match(outputs(dir, ".css"), /@theme/);
});

// ---- dev parity

test("dev: Tailwind classes added to a source (even a new file) rebuild the stylesheet; SFCs compile", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "x", type: "module", dependencies: { vue: "^3" }, devDependencies: { tailwindcss: "^4" } }),
    ".env": "VITE_NAME=dev-app\n",
    "index.html": html('<title>%VITE_NAME%</title><link rel="stylesheet" href="/src/style.css">', '<div id="app"></div><script type="module" src="/src/main.js"></script>'),
    "src/style.css": '@import "tailwindcss";\n',
    "src/main.js": 'import { createApp } from "vue";\nimport App from "./App.vue";\ncreateApp(App).mount("#app");\n',
    "src/App.vue": '<template><p class="text-sky-500">hi</p></template>\n<style scoped>p { margin: 5px }</style>\n',
    "src/parts/keep.txt": "",
  });
  const s = await dev({ root: dir, config: {} }, { port: 0, log: () => {} });
  try {
    const get = async (p) => (await fetch(s.url + p)).text();
    const page = await get("/");
    assert.match(page, /<title>dev-app<\/title>/);
    const css = () => get("/assets/src/style.css.css");
    assert.match(page, /href="\/assets\/src\/style\.css\.css"/);
    assert.ok((await css()).includes("text-sky-500"));
    const bundleCss = await get(page.match(/href="(\/assets\/src\/main\.css)"/)[1]);
    assert.match(bundleCss, /p\[data-v-[0-9a-f]{8}\]/);
    fs.writeFileSync(path.join(dir, "src/parts/new.html"), '<b class="bg-lime-400"></b>');
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ok = (await css()).includes("bg-lime-400");
    }
    assert.ok(ok, "new class picked up");
  } finally {
    await s.close();
  }
});

// ---- scanner units

test("extractCandidates / globToRegExp / htmlEnv", () => {
  const c = extractCandidates('<div class="p-4 hover:bg-[#fff] w-[calc(100%-1rem)]">cn("flex",x)</div>');
  for (const t of ["p-4", "hover:bg-[#fff]", "w-[calc(100%-1rem)]", "flex"]) assert.ok(c.has(t), t);
  assert.ok(globToRegExp("/a/**/*.{js,vue}").test("/a/b/c/x.vue"));
  assert.ok(!globToRegExp("/a/*.js").test("/a/b/x.js"));
  assert.equal(htmlEnv("%A% %B% 100%", { A: "1" }), "1 %B% 100%");
});

test("scanSources: source(none), @source paths and @source not", () => {
  const dir = project({ "a/x.html": "flex", "b/y.html": "grid", "b/skip.html": "hidden", "node_modules/z.js": "" }, { modules: false });
  const rules = [{ root: "none", sources: [{ base: dir, pattern: "b", negated: false }, { base: dir, pattern: "b/skip.html", negated: true }] }];
  const { candidates } = scanSources(rules, dir);
  assert.ok(candidates.includes("grid"));
  assert.ok(!candidates.includes("flex") && !candidates.includes("hidden"));
  const auto = scanSources([{ root: null, sources: [] }], dir).candidates;
  assert.ok(auto.includes("flex") && auto.includes("grid"));
});
