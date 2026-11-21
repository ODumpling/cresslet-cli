// The `cresslet` SDK (sdk/index.js): the shared contract cases (test/contract/app.js) on `cresslet dev`, how it fails
// without a runtime, at module top level or on an older runtime, and that builds bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../lib/build.js";
import { dev } from "../lib/dev.js";
import { loadProject } from "../lib/util.js";
import * as sdk from "cresslet"; // the package's own export (self-reference)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const KEY = Symbol.for("cresslet.runtime");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** The fixture with `server` as server/index.js and this package installed as `cresslet`. */
function project(server, secrets = "CONTRACT_SECRET=s3cret\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-sdk-"));
  fs.cpSync(path.join(HERE, "fixture"), dir, { recursive: true });
  fs.rmSync(path.join(dir, "server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(path.join(dir, "server", "index.js"), server);
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.symlinkSync(ROOT, path.join(dir, "node_modules", "cresslet"), "dir");
  fs.writeFileSync(path.join(dir, ".env.cresslet"), secrets);
  return dir;
}

const withRuntime = async (rt, fn) => {
  const prev = globalThis[KEY];
  globalThis[KEY] = rt;
  try {
    return await fn();
  } finally {
    globalThis[KEY] = prev;
  }
};

test("contract cases pass on cresslet dev", async () => {
  const dir = project(fs.readFileSync(path.join(HERE, "contract", "app.js"), "utf8"));
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    // a cron run first: before any request
    const cron = await fetch(`${d.url}/__cresslet/scheduled?cron=${encodeURIComponent("* * * * *")}`, {
      method: "POST",
      headers: { "x-cresslet-dev": "1" },
    });
    assert.equal(cron.status, 204, await cron.text());
    assert.deepEqual(await (await fetch(`${d.url}/api/contract/cron`)).json(), [{ cron: "* * * * *", secret: "s3cret" }]);
    const { results } = await (await fetch(`${d.url}/api/contract`)).json();
    assert.ok(results.length >= 14, `${results.length} cases`);
    for (const r of results) assert.ok(r.ok, `${r.name}: ${r.error}`);
  } finally {
    await d.close();
  }
  assert.equal(globalThis[KEY], undefined, "dev's runtime removed on close");
});

test("package exports the SDK (types too); its version is the package's", () => {
  assert.deepEqual(PKG.exports["."], { types: "./sdk/index.d.ts", default: "./sdk/index.js" });
  assert.ok(PKG.files.includes("sdk"));
  assert.equal(sdk.VERSION, PKG.version);
  assert.deepEqual(Object.keys(sdk).sort(), ["CONTRACT", "CressletError", "VERSION", "app", "db", "files", "secrets"]);
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
  // a runtime claiming the contract without env.db.batch
  await withRuntime({ contract: 1, runtime: "x", env: { db: {} } }, async () => {
    await assert.rejects(sdk.db.batch(["SELECT 1"]), /isn't supported by this runtime \(x\)/);
  });
});

test("db.sql: placeholders follow the runtime's style; values are never SQL text", async () => {
  const calls = [];
  const rec = (op) => async (...a) => (calls.push([op, ...a]), op === "batch" ? [] : []);
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
  assert.throws(() => sdk.db.sql("SELECT 1"), /tagged template/);
});

test("secrets: live record access, read-only", async () => {
  const env = { secrets: Object.freeze({ A: "1" }) };
  await withRuntime({ contract: 1, env }, () => {
    assert.deepEqual({ ...sdk.secrets }, { A: "1" });
    assert.equal(JSON.stringify(sdk.secrets), '{"A":"1"}');
    env.secrets = Object.freeze({ B: "2" }); // `cresslet dev` reloads .env.cresslet this way
    assert.equal(sdk.secrets.get("B"), "2");
    assert.equal(sdk.secrets.A, undefined);
    assert.throws(() => (sdk.secrets.B = "x"), TypeError);
  });
});

test("cresslet build bundles the SDK into the server (no imports left, no CLI code)", async () => {
  const dir = project(`import { db, secrets } from "cresslet";
export default { async fetch() { return Response.json(await db.query(db.sql\`SELECT \${secrets.get("A")} AS a\`)); } };`);
  const { serverFile } = await build(dir);
  const code = fs.readFileSync(serverFile, "utf8");
  assert.doesNotMatch(code, /\bimport\b[^(]/);
  assert.doesNotMatch(code, /esbuild|node:/);
  assert.match(code, /cresslet\.runtime/);
});
