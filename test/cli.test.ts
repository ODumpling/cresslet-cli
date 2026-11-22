import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDotenv, loadProject } from "../lib/util.ts";
import { EventEmitter } from "node:events";
import { build, parseHtml } from "../lib/build.ts";
import { dev, matchRoute, serverRoute } from "../lib/dev.ts";
import { cresslet as vitePlugin } from "../lib/vite.ts";
import * as sdk from "cresslet";

// Runs compiled, from dist/test/ (npm test): the fixture is in the repo's test/.
const FIXTURE = fileURLToPath(new URL("../../test/fixture", import.meta.url));

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["new", "x", "--template", "react", "-f", "--json", "--n=5"], { bool: ["json", "f"] }), {
    _: ["new", "x"],
    flags: { template: "react", f: true, json: true, n: "5" },
  });
});

test("parseDotenv", () => {
  assert.deepEqual(parseDotenv("A=1\n# c\nexport B='two'\nC=\"x=y\"\nbad line"), { A: "1", B: "two", C: "x=y" });
});

test("matchRoute", () => {
  assert.ok(matchRoute("/api/*", "/api"));
  assert.ok(matchRoute("/api/*", "/api/x/y"));
  assert.ok(!matchRoute("/api/*", "/apix"));
  assert.ok(matchRoute("/hook", "/hook"));
  assert.ok(!matchRoute("/hook", "/hook/2"));
});

test("serverRoute: `!pattern` exclusions win", () => {
  const routes = ["/*", "!/assets/*", "!/favicon.ico"];
  assert.ok(serverRoute(routes, "/"));
  assert.ok(serverRoute(routes, "/boards/1"));
  assert.ok(!serverRoute(routes, "/assets/x.js"));
  assert.ok(!serverRoute(routes, "/favicon.ico"));
  assert.ok(serverRoute(undefined, "/api/x") && !serverRoute(undefined, "/x"));
  assert.ok(!serverRoute(["!/api/private", "/api/*"], "/api/private") && serverRoute(["!/api/private", "/api/*"], "/api/x"));
});

/** A project whose cresslet.json `build` runs its own build (as `vite build` would): chunks, a bare import, a dotfile. */
function frameworkProject(build: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-fw-"));
  fs.mkdirSync(path.join(dir, "node_modules", "greet"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "greet", "package.json"), JSON.stringify({ name: "greet", type: "module", exports: { worker: "./worker.js", default: "./node.js" } }));
  fs.writeFileSync(path.join(dir, "node_modules", "greet", "worker.js"), `export const greet = (p) => "worker " + p;`);
  fs.writeFileSync(path.join(dir, "node_modules", "greet", "node.js"), `export const greet = (p) => "node " + p;`);
  fs.writeFileSync(path.join(dir, "build.mjs"), `import fs from "node:fs";
fs.mkdirSync("out/client/assets", { recursive: true });
fs.mkdirSync("out/server/assets", { recursive: true });
fs.writeFileSync("out/client/assets/app.js", "console.log(" + JSON.stringify(process.env.NODE_ENV) + ")");
fs.writeFileSync("out/client/.env.local", "SECRET=1");
fs.writeFileSync("out/server/assets/chunk.js", 'import { greet } from "greet"; export const page = (p) => greet(p);');
fs.writeFileSync("out/server/server.js", 'export default { async fetch(req) { const { page } = await import("./assets/chunk.js"); return new Response(page(new URL(req.url).pathname)); } };');
console.log("built");`);
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({
    name: "fw",
    routes: ["/*", "!/assets/*"],
    build: { command: "node build.mjs", static: "out/client", server: "out/server/server.js", ...build },
  }));
  return dir;
}

test("framework build (cresslet.json build): runs the command, serves its static dir, bundles its server", async () => {
  const dir = frameworkProject();
  const r = await build(dir, { config: loadProject(dir).config });
  assert.equal(r.outDir, path.join(dir, "out", "client"));
  assert.deepEqual(r.files, ["assets/app.js"]); // .env* never served
  assert.equal(fs.readFileSync(path.join(r.outDir, "assets", "app.js"), "utf8"), 'console.log("production")');
  const code = fs.readFileSync(r.serverFile!, "utf8"); // (build.server is set)
  assert.doesNotMatch(code, /\bimport\s*\(|from\s*["'](?!node:)/, "one module: chunks and node_modules inlined");
  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  assert.equal(await (await mod.default.fetch(new Request("http://x/boards/1"))).text(), "worker /boards/1");
});

test("framework build: a failing command, a missing output or a path outside the project is an error", async () => {
  const fail = frameworkProject({ command: "node -e \"process.exit(3)\"" });
  await assert.rejects(build(fail, { config: loadProject(fail).config }), /exited with 3/);
  const missing = frameworkProject({ static: "nope" });
  await assert.rejects(build(missing, { config: loadProject(missing).config }), /didn't write nope/);
  const outside = frameworkProject({ static: "../x" });
  await assert.rejects(build(outside, { config: loadProject(outside).config }), /inside the project/);
  const hidden = frameworkProject({ static: ".cresslet/out" });
  await assert.rejects(build(hidden, { config: loadProject(hidden).config }), /can't be inside \.cresslet/);
  await assert.rejects(build(outside, { config: { build: { command: "x" } } }), /"build" must be/);
});

test("cresslet/vite plugin: the SDK works under vite dev (db, kv, secrets, app), removed on close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-vite-"));
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "vt" }));
  fs.writeFileSync(path.join(dir, ".env.cresslet"), "TOKEN=one\n");
  const watcher = Object.assign(new EventEmitter(), { add() {} });
  const httpServer = new EventEmitter();
  const server = { config: { root: dir, server: { port: 5199 } }, watcher, httpServer, resolvedUrls: null as { local: string[] } | null };
  const plugin = vitePlugin();
  assert.equal(plugin.apply, "serve");
  // (the plugin's published type leaves its Vite hooks `unknown`)
  await (plugin as unknown as { configureServer(s: typeof server): Promise<void> }).configureServer(server);
  try {
    await sdk.db.exec("CREATE TABLE t (n INTEGER)");
    await sdk.db.run(sdk.db.sql`INSERT INTO t VALUES (${7})`);
    assert.deepEqual((await sdk.db.query("SELECT n FROM t")).map((r) => ({ ...r })), [{ n: 7 }]);
    await sdk.kv.set("k", { a: 1 });
    assert.deepEqual(await sdk.kv.get("k"), { a: 1 });
    assert.equal(sdk.secrets.get("TOKEN"), "one");
    fs.writeFileSync(path.join(dir, ".env.cresslet"), "TOKEN=two\n");
    watcher.emit("change", path.join(dir, ".env.cresslet"));
    assert.equal(sdk.secrets.get("TOKEN"), "two");
    assert.deepEqual([sdk.app.name, sdk.app.url], ["vt", "http://localhost:5199"]);
    server.resolvedUrls = { local: ["http://localhost:5200/"] };
    assert.equal(sdk.app.url, "http://localhost:5200");
    assert.ok(fs.existsSync(path.join(dir, ".cresslet", "dev", "data", "db.sqlite")));
  } finally {
    httpServer.emit("close");
  }
  assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for("cresslet.runtime")], undefined);
});

test("parseHtml skips public and remote refs", () => {
  const dir = copyFixture();
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8") +
    '<script type="module" src="https://cdn.example/x.js"></script>';
  const entries = parseHtml(html, dir);
  assert.deepEqual(entries.map((e) => [e.kind, e.ref]), [["js", "/src/main.ts"]]); // /style.css is in public/
});

test("build produces hashed client + server bundle", async () => {
  const dir = copyFixture();
  const r = await build(dir);
  assert.ok(r.files.includes("index.html"));
  assert.ok(r.files.includes("style.css"));
  const js = r.files.find((f) => /^assets\/main-[A-Z0-9]+\.js$/.test(f));
  assert.ok(js, `no hashed js in ${r.files}`);
  const html = fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  assert.match(html, new RegExp(`src="/${js}"`));
  assert.ok(fs.readFileSync(r.serverFile!, "utf8").includes("export")); // (the fixture has a server)
});

test("dev server: static, api with sqlite, dotfiles hidden", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, ".env.cresslet"), "SECRET=1\n");
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    const home = await (await fetch(d.url + "/")).text();
    assert.match(home, /\/assets\/src\/main\.js/);
    assert.match(home, /__cresslet\/reload/);
    const visits = async () => ((await (await fetch(d.url + "/api/visits", { method: "POST" })).json()) as { visits: number }).visits;
    assert.equal(await visits(), 1);
    assert.equal(await visits(), 2);
    assert.equal((await fetch(d.url + "/.env.cresslet")).status, 404);
    assert.equal((await fetch(d.url + "/server/index.ts")).status, 404);
    assert.equal((await fetch(d.url + "/assets/src/main.js")).status, 200);
    assert.match(await (await fetch(d.url + "/some/route")).text(), /<main>/);
  } finally {
    await d.close();
  }
});

test("githubRepo: github.com remotes only, in any form", async () => {
  const { githubRepo } = await import("../lib/commands.ts");
  assert.equal(githubRepo("git@github.com:octo/shop.git"), "octo/shop");
  assert.equal(githubRepo("https://github.com/octo/shop"), "octo/shop");
  assert.equal(githubRepo("ssh://git@github.com:22/octo/shop.git"), "octo/shop");
  assert.equal(githubRepo("https://GitHub.com/octo/shop.git/"), "octo/shop");
  assert.equal(githubRepo("https://notgithub.com/octo/shop.git"), null);
  assert.equal(githubRepo("git@gitlab.com:octo/shop.git"), null);
  assert.equal(githubRepo(null), null);
});
