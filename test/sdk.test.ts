// The `cresslet` SDK (sdk/index.ts): the shared contract cases (test/contract/app.js) on `cresslet dev`, how it fails
// without a runtime, at module top level or on an older runtime, and that builds bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { build } from "../lib/build.ts";
import { dev } from "../lib/dev.ts";
import { loadProject } from "../lib/util.ts";
import * as sdk from "cresslet"; // the package's own export (self-reference)

// Runs compiled, from dist/test/ (npm test): the repo is two levels up.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEST = path.join(ROOT, "test");
const KEY = Symbol.for("cresslet.runtime");
const g = globalThis as typeof globalThis & { [KEY]?: unknown };
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, unknown>;
  files: string[];
};

/** The fixture with `server` as server/index.js and this package installed as `cresslet`. */
function project(server: string, secrets = "CONTRACT_SECRET=s3cret\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-sdk-"));
  fs.cpSync(path.join(TEST, "fixture"), dir, { recursive: true });
  fs.rmSync(path.join(dir, "server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(path.join(dir, "server", "index.js"), server);
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.symlinkSync(ROOT, path.join(dir, "node_modules", "cresslet"), "dir");
  fs.writeFileSync(path.join(dir, ".env.cresslet"), secrets);
  return dir;
}

/** Runs `fn` with `rt` as the runtime the SDK finds (anything: the SDK checks what it gets). */
const withRuntime = async <T>(rt: unknown, fn: () => T | Promise<T>): Promise<T> => {
  const prev = g[KEY];
  g[KEY] = rt;
  try {
    return await fn();
  } finally {
    g[KEY] = prev;
  }
};

test("contract cases pass on cresslet dev", async () => {
  const dir = project(fs.readFileSync(path.join(TEST, "contract", "app.js"), "utf8"));
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    // a cron run first: before any request
    const cron = await fetch(`${d.url}/__cresslet/scheduled?cron=${encodeURIComponent("* * * * *")}`, {
      method: "POST",
      headers: { "x-cresslet-dev": "1" },
    });
    assert.equal(cron.status, 204, await cron.text());
    assert.deepEqual(await (await fetch(`${d.url}/api/contract/cron`)).json(), [{ cron: "* * * * *", secret: "s3cret" }]);
    const { results } = (await (await fetch(`${d.url}/api/contract`)).json()) as { results: { name: string; ok: boolean; error?: string }[] };
    assert.ok(results.length >= 14, `${results.length} cases`);
    for (const r of results) assert.ok(r.ok, `${r.name}: ${r.error}`);
  } finally {
    await d.close();
  }
  assert.equal(g[KEY], undefined, "dev's runtime removed on close");
});

test("dev: a request on the previous build keeps its bindings while a rebuilt module loads", async () => {
  const v1 = `import { db } from "cresslet";
export default { async fetch() {
  await new Promise((r) => setTimeout(r, 400));
  return Response.json(await db.first("SELECT 1 AS x"));
} };`;
  // the new module stays loading (top-level await) for a second: the in-flight request wakes up meanwhile
  const v2 = `import { db } from "cresslet";
await new Promise((r) => setTimeout(r, 1500));
export default { async fetch() { return Response.json(await db.first("SELECT 2 AS x")); } };`;
  const dir = project(v1);
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    const pending = fetch(`${d.url}/api/x`);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, "server", "index.js"), v2);
    const res = await pending;
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { x: 1 });
    // and once it has loaded, the new build serves with bindings
    for (let i = 0; i < 150; i++) {
      const r = await (await fetch(`${d.url}/api/x`)).text();
      if (r === '{"x":2}') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail("the rebuilt module never served");
  } finally {
    await d.close();
  }
});

test("dev: a streamed response and a WebSocket keep their bindings while a rebuilt module loads", async () => {
  const v1 = `import { db } from "cresslet";
export default { async fetch(req) {
  if (req.headers.get("upgrade") === "websocket") {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", async () => server.send(JSON.stringify(await db.first("SELECT 3 AS x"))));
    return new Response(null, { status: 101, webSocket: client });
  }
  return new Response(new ReadableStream({ async pull(c) {
    await new Promise((r) => setTimeout(r, 400));
    c.enqueue(new TextEncoder().encode(JSON.stringify(await db.first("SELECT 1 AS x"))));
    c.close();
  } }));
} };`;
  const v2 = `await new Promise((r) => setTimeout(r, 1500));
export default { fetch: () => new Response("v2") };`;
  const dir = project(v1);
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    const ws = new WebSocket(d.url.replace("http", "ws") + "/api/ws");
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const pending = fetch(`${d.url}/api/x`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, "server", "index.js"), v2);
    assert.equal(await pending, '{"x":1}', "streamed body");
    // the new module is still loading: the socket's message listener (old build) runs with its bindings
    const reply = new Promise((r, j) => {
      ws.onmessage = (e) => r(e.data);
      setTimeout(() => j(new Error("no reply from the socket's listener")), 3000);
    });
    ws.send("hi");
    assert.equal(await reply, '{"x":3}');
    ws.close();
  } finally {
    await d.close();
  }
});

test("dev: two dev servers in one process each see their own bindings", async () => {
  const app = (name: string) => `import { app, db } from "cresslet";
export default { async fetch() {
  await new Promise((r) => setTimeout(r, 200)); // overlapping requests
  return Response.json({ name: app.name, n: (await db.first("SELECT ${name === "one" ? 1 : 2} AS n")).n });
} };`;
  const dirs = [project(app("one")), project(app("two"))];
  fs.writeFileSync(path.join(dirs[0], "cresslet.json"), '{"name":"one"}');
  fs.writeFileSync(path.join(dirs[1], "cresslet.json"), '{"name":"two"}');
  const [a, b] = [await dev(loadProject(dirs[0]), { port: 0, log: () => {} }), await dev(loadProject(dirs[1]), { port: 0, log: () => {} })];
  let bOpen = true;
  try {
    const [ra, rb] = await Promise.all([a, b].map(async (d) => (await fetch(`${d.url}/api/x`)).json()));
    assert.deepEqual([ra, rb], [{ name: "one", n: 1 }, { name: "two", n: 2 }]);
    // rebuilding the older one (rebuilds polled for up to 15 s: other test files load the machine): its new module's top level sees no bindings, not the newer server's
    fs.writeFileSync(path.join(dirs[0], "server", "index.js"), `import { app } from "cresslet";
let top;
try { top = app.name; } catch (e) { top = e.name; }
const name = () => { try { return app.name; } catch (e) { return e.name; } };
export default { get fetch() { const got = name(); return () => Response.json({ top, getter: got }); } };`);
    type Seen = { top?: string; getter?: string; name?: string; n?: number } | undefined;
    let seen: Seen;
    for (let i = 0; i < 150 && !seen?.top; i++) {
      await new Promise((r) => setTimeout(r, 100));
      seen = (await (await fetch(`${a.url}/api/x`)).json()) as Seen;
    }
    assert.deepEqual(seen, { top: "CressletError", getter: "CressletError" }); // reading the export: no bindings either
    fs.writeFileSync(path.join(dirs[0], "server", "index.js"), app("one"));
    for (let i = 0; i < 150 && (seen as Seen)?.name !== "one"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      seen = (await (await fetch(`${a.url}/api/x`)).json()) as Seen;
    }
    await b.close();
    bOpen = false;
    assert.ok(g[KEY], "still installed while one dev server runs");
    assert.deepEqual(await (await fetch(`${a.url}/api/x`)).json(), { name: "one", n: 1 });
  } finally {
    if (bOpen) await b.close();
    await a.close();
  }
  assert.equal(g[KEY], undefined);
});

test("package exports the SDK (types too); its version is the package's", () => {
  assert.deepEqual(PKG.exports["."], { types: "./dist/sdk/index.d.ts", default: "./dist/sdk/index.js" });
  assert.deepEqual(PKG.exports["./drizzle"], { types: "./dist/sdk/drizzle.d.ts", default: "./dist/sdk/drizzle.js" });
  assert.ok(PKG.files.includes("dist/sdk"));
  assert.equal(sdk.VERSION, PKG.version);
  assert.deepEqual(Object.keys(sdk).sort(), ["CONTRACT", "CressletError", "VERSION", "app", "db", "files", "kv", "secrets"]);
});

test("without a runtime, in module scope, or on an older runtime: errors that say so", async () => {
  await withRuntime(undefined, async () => {
    await assert.rejects(sdk.db.query("SELECT 1"), (e) =>
      e instanceof sdk.CressletError && /none was found/.test(e.message) && /older than the SDK/.test(e.message) &&
      /env` argument/.test(e.message));
    assert.throws(() => sdk.secrets.get("X"), /none was found/);
    assert.throws(() => sdk.app.name, /none was found/);
  });
  await withRuntime({ contract: 0, runtime: "old", env: { db: {} } }, async () => {
    await assert.rejects(sdk.db.batch([]), /db\.batch` needs Cresslet runtime contract 1.*\(old\) provides contract 0/);
  });
  await withRuntime({ contract: 1, runtime: "x", env: null }, async () => {
    await assert.rejects(sdk.db.query("SELECT 1"), /module was loading.*not at module top level/s);
    assert.throws(() => sdk.secrets.STRIPE, /only once a handler runs/);
  });
  // db.raw and raw batch statements need contract 2 (a contract 1 runtime would answer objects)
  await withRuntime({ contract: 1, runtime: "one", env: { db: { batch: async () => [] } } }, async () => {
    await assert.rejects(sdk.db.raw("SELECT 1"), /db\.raw` needs Cresslet runtime contract 2.*\(one\) provides contract 1/);
    await assert.rejects(sdk.db.batch([{ sql: "SELECT 1", raw: true }]), /db\.raw` needs Cresslet runtime contract 2/);
    assert.deepEqual(await sdk.db.batch([{ sql: "SELECT 1" }]), []);
  });
  await withRuntime({ contract: 2, runtime: "x", env: { db: {} } }, async () => {
    await assert.rejects(sdk.db.raw("SELECT 1"), /db\.raw isn't supported by this runtime \(x\)/);
  });
  // a runtime claiming the contract without env.db.batch
  await withRuntime({ contract: 1, runtime: "x", env: { db: {} } }, async () => {
    await assert.rejects(sdk.db.batch(["SELECT 1"]), /isn't supported by this runtime \(x\)/);
  });
});

test("db.sql: placeholders follow the runtime's style; values are never SQL text", async () => {
  const calls: unknown[][] = [];
  const rec = (op: string) => async (...a: unknown[]) => (calls.push([op, ...a]), op === "batch" ? [] : []);
  const env = { db: { query: rec("query"), first: rec("first"), run: rec("run"), batch: rec("batch") } };
  const name = "'; DROP TABLE t; --";
  await withRuntime({ contract: 1, runtime: "pg-ish", paramStyle: "$n", env }, async () => {
    const where = sdk.db.sql`a = ${1} AND b = ${name}`;
    await sdk.db.query(sdk.db.sql`SELECT * FROM t WHERE ${where} OR c = ${3}`);
    await sdk.db.sql`SELECT ${"x"}`;
    await sdk.db.batch([sdk.db.sql`DELETE FROM t WHERE id = ${2}`, "SELECT 1", { sql: "SELECT $1", params: [5] }]);
  });
  await withRuntime({ contract: 1, runtime: "sqlite", paramStyle: "?", env }, () => sdk.db.run(sdk.db.sql`UPDATE t SET a = ${1} WHERE b = ${2}`));
  assert.deepEqual(calls, [
    ["query", "SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $3", 1, name, 3],
    ["query", "SELECT $1", "x"],
    ["batch", [{ sql: "DELETE FROM t WHERE id = $1", params: [2] }, { sql: "SELECT 1", params: [] }, { sql: "SELECT $1", params: [5] }]],
    ["run", "UPDATE t SET a = ? WHERE b = ?", 1, 2],
  ]);
  // @ts-expect-error -- misuse on purpose: called as a function, not a tag
  assert.throws(() => sdk.db.sql("SELECT 1"), /tagged template/);
  assert.throws(() => sdk.db.sql`SELECT '\unicode'`, /invalid escape/);
  await withRuntime({ contract: 1, runtime: "sqlite", env }, async () => {
    // @ts-expect-error -- misuse on purpose: params not an array
    await assert.rejects(sdk.db.batch([{ sql: "SELECT ?", params: "abc" }]), /statement 1: params must be an array/);
    // a query from another copy of the SDK (bundled by a dependency) is still a query
    const other = (await import(new URL("../sdk/index.js?copy=2", import.meta.url).href)) as typeof sdk; // dist/sdk
    assert.notEqual(other.db, sdk.db);
    calls.length = 0;
    await sdk.db.query(sdk.db.sql`SELECT * FROM t WHERE ${other.db.sql`a = ${1}`}`);
    await sdk.db.run(other.db.sql`DELETE FROM t WHERE id = ${2}`);
    assert.deepEqual(calls, [["query", "SELECT * FROM t WHERE a = ?", 1], ["run", "DELETE FROM t WHERE id = ?", 2]]);
  });
});

test("secrets: live record access, read-only", async () => {
  const env: { secrets: Readonly<Record<string, string>> } = { secrets: Object.freeze({ A: "1" }) };
  await withRuntime({ contract: 1, env }, () => {
    assert.deepEqual({ ...sdk.secrets }, { A: "1" });
    assert.equal(JSON.stringify(sdk.secrets), '{"A":"1"}');
    env.secrets = Object.freeze({ B: "2" }); // `cresslet dev` reloads .env.cresslet this way
    assert.equal(sdk.secrets.get("B"), "2");
    assert.equal(sdk.secrets.A, undefined);
    // @ts-expect-error -- misuse on purpose: secrets are read-only
    assert.throws(() => (sdk.secrets.B = "x"), TypeError);
    assert.throws(() => Object.freeze(sdk.secrets), TypeError);
    assert.deepEqual(Object.keys(sdk.secrets), ["B"]); // still works after a failed freeze
  });
});

test("cresslet build bundles the SDK into the server (no imports left, no CLI code)", async () => {
  const dir = project(`import { db, secrets } from "cresslet";
export default { async fetch() { return Response.json(await db.query(db.sql\`SELECT \${secrets.get("A")} AS a\`)); } };`);
  const { serverFile } = await build(dir);
  const code = fs.readFileSync(serverFile!, "utf8"); // (the project has a server)
  assert.doesNotMatch(code, /\bimport\b[^(]/);
  assert.doesNotMatch(code, /esbuild|node:/);
  assert.match(code, /cresslet\.runtime/);
});
