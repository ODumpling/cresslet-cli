// Contract cases for the `cresslet` SDK, shared by every runtime: `cresslet dev` (test/sdk.test.js here) and the
// platform sandbox (tests/sdk_test.ts in the cresslet repo, which vendors this file with `npm run vendor:sdk`).
// An app: GET /api/contract runs every case and answers { results: [{ name, ok, error? }] }. Its scheduled() writes
// through the SDK (run it before any request: a cron can be the first thing a sandbox does); GET /api/contract/cron
// lists those runs.
// Expects the secret CONTRACT_SECRET=s3cret and no secret named CONTRACT_MISSING.
import { app, CONTRACT, CressletError, db, files, secrets } from "cresslet";

// Module top level runs before any handler: the SDK says so instead of failing on an undefined property.
let topLevel = "no error";
try {
  secrets.optional("CONTRACT_SECRET");
} catch (e) {
  topLevel = `${e.name}: ${e.message}`;
}

const eq = (a, b, what = "value") => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${what}: expected ${y}, got ${x}`);
};
const rejects = async (p, re, what) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (!re.test(e.message)) throw new Error(`${what}: wrong error: ${e.message}`);
    return e;
  }
  throw new Error(`${what}: no error`);
};

const cases = {
  "module top level fails with a message saying so": () => {
    if (!/CressletError/.test(topLevel) || !/module top level/.test(topLevel)) throw new Error(topLevel);
  },
  "runtime contract covers the SDK": () => {
    if (!(globalThis[Symbol.for("cresslet.runtime")]?.contract >= CONTRACT)) throw new Error("contract too old");
  },
  "db.exec, db.sql parameters (text, null, numbers, bigint, blob) round-trip": async () => {
    await db.exec(`DROP TABLE IF EXISTS contract_t; CREATE TABLE contract_t (id INTEGER PRIMARY KEY, s TEXT, n REAL, b BLOB);`);
    const hostile = "x'); DROP TABLE contract_t; --";
    const r = await db.run(db.sql`INSERT INTO contract_t (s, n, b) VALUES (${hostile}, ${1.5}, ${new Uint8Array([1, 2, 255])})`);
    eq(r, { changes: 1, lastInsertRowid: 1 }, "run result");
    await db.run(db.sql`INSERT INTO contract_t (s, n) VALUES (${null}, ${10n})`);
    const rows = await db.query(db.sql`SELECT id, s, n FROM contract_t ORDER BY id`);
    eq(rows, [{ id: 1, s: hostile, n: 1.5 }, { id: 2, s: null, n: 10 }], "rows");
    const blob = (await db.first(db.sql`SELECT b FROM contract_t WHERE id = ${1}`)).b;
    eq([blob instanceof Uint8Array, [...blob]], [true, [1, 2, 255]], "blob");
  },
  "awaiting db.sql gives the rows; first gives null when none": async () => {
    eq(await db.sql`SELECT count(*) AS c FROM contract_t WHERE n > ${1}`, [{ c: 2 }], "awaited query");
    eq(await db.first(db.sql`SELECT id FROM contract_t WHERE id = ${999}`), null, "first");
  },
  "nested db.sql fragments keep their parameters": async () => {
    const where = db.sql`n > ${2} AND s IS ${null}`;
    eq(await db.query(db.sql`SELECT id FROM contract_t WHERE ${where} ORDER BY id`), [{ id: 2 }], "rows");
  },
  "string SQL with ? parameters still works": async () => {
    eq(await db.query("SELECT id FROM contract_t WHERE id = ?", 1), [{ id: 1 }], "query");
    eq((await db.first("SELECT count(*) c FROM contract_t")).c, 2, "first");
  },
  "db.sql refuses undefined and extra parameters": async () => {
    await rejects(async () => db.query(db.sql`SELECT ${undefined}`), /undefined/, "undefined");
    await rejects(() => db.query(db.sql`SELECT 1`, 2), /no extra parameters/, "extra");
  },
  "db.batch runs in order, with per-statement results": async () => {
    await db.exec("DROP TABLE IF EXISTS contract_b; CREATE TABLE contract_b (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const out = await db.batch([
      db.sql`INSERT INTO contract_b (v) VALUES (${"a"})`,
      { sql: "INSERT INTO contract_b (v) VALUES (?)", params: ["b"] },
      "UPDATE contract_b SET v = v || '!'",
      db.sql`SELECT v FROM contract_b ORDER BY id`,
    ]);
    eq(out, [
      { rows: [], changes: 1, lastInsertRowid: 1 },
      { rows: [], changes: 1, lastInsertRowid: 2 },
      { rows: [], changes: 2, lastInsertRowid: 2 },
      { rows: [{ v: "a!" }, { v: "b!" }], changes: 0, lastInsertRowid: 2 },
    ], "batch results");
  },
  "db.batch is all or nothing": async () => {
    await rejects(
      db.batch([db.sql`INSERT INTO contract_b (v) VALUES (${"c"})`, db.sql`INSERT INTO contract_b (v) VALUES (${null})`]),
      /statement 2/,
      "failing batch",
    );
    eq(await db.query("SELECT v FROM contract_b ORDER BY id"), [{ v: "a!" }, { v: "b!" }], "rows after rollback");
  },
  "db.batch refuses transaction control, PRAGMA, ATTACH, DETACH (it is one transaction; the others aren't rolled back)": async () => {
    await rejects(
      db.batch([db.sql`INSERT INTO contract_b (v) VALUES (${"c"})`, " /* x */ COMMIT", db.sql`INSERT INTO contract_b (v) VALUES (${null})`]),
      /statement 2: transaction control/,
      "COMMIT in a batch",
    );
    for (const sql of ["BEGIN", "end", "ROLLBACK", "SAVEPOINT s", "RELEASE s", ";COMMIT", " ; /*x*/ END", "PRAGMA ignore_check_constraints = ON", "EXPLAIN /* x */ QUERY PLAN PRAGMA cache_size = -12345", "ATTACH ':memory:' AS aux", "DETACH aux"]) await rejects(db.batch([sql]), /transaction control/, sql);
    eq(await db.query("SELECT v FROM contract_b ORDER BY id"), [{ v: "a!" }, { v: "b!" }], "nothing written");
  },
  "db.batch after a rowid past 2^53": async () => {
    await db.exec("DROP TABLE IF EXISTS contract_big; CREATE TABLE contract_big (id INTEGER PRIMARY KEY, v TEXT)");
    await db.run("INSERT INTO contract_big VALUES (9007199254740993, 'big')");
    eq((await db.batch([db.sql`SELECT v FROM contract_big`]))[0].rows, [{ v: "big" }], "rows");
  },
  "concurrent batches don't interleave": async () => {
    await db.exec("DROP TABLE IF EXISTS contract_c; CREATE TABLE contract_c (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    await db.run("INSERT INTO contract_c VALUES ('x', 0)");
    // Each batch reads n then writes n + 1 via a temp copy: interleaving would lose increments.
    await Promise.all(Array.from({ length: 20 }, () =>
      db.batch([
        "INSERT INTO contract_c SELECT 'tmp', n FROM contract_c WHERE k = 'x'",
        "UPDATE contract_c SET n = (SELECT n FROM contract_c WHERE k = 'tmp') + 1 WHERE k = 'x'",
        "DELETE FROM contract_c WHERE k = 'tmp'",
      ])));
    eq(await db.first("SELECT n FROM contract_c WHERE k = 'x'"), { n: 20 }, "counter");
  },
  "secrets.get, optional, record access": async () => {
    eq(secrets.get("CONTRACT_SECRET"), "s3cret", "get");
    eq(secrets.CONTRACT_SECRET, "s3cret", "record");
    eq(secrets.optional("CONTRACT_MISSING"), undefined, "optional");
    eq(secrets.CONTRACT_MISSING, undefined, "record missing");
    eq(["CONTRACT_SECRET" in secrets, Object.keys(secrets).includes("CONTRACT_SECRET")], [true, true], "keys");
    const e = await rejects(() => secrets.get("CONTRACT_MISSING"), /CONTRACT_MISSING.*not set/, "missing");
    if (!(e instanceof CressletError)) throw new Error("not a CressletError");
  },
  "files put, get, list, delete": async () => {
    await files.put("contract/a.txt", "hello", { contentType: "text/plain" });
    const got = await files.get("contract/a.txt");
    eq([await got.text(), got.headers.get("content-type")], ["hello", "text/plain"], "get");
    eq((await files.list("contract/")).map((f) => [f.key, f.size]), [["contract/a.txt", 5]], "list");
    await files.delete("contract/a.txt");
    eq(await files.get("contract/a.txt"), null, "deleted");
  },
};

export default {
  async scheduled(event) {
    await db.exec("CREATE TABLE IF NOT EXISTS contract_cron (cron TEXT NOT NULL, secret TEXT NOT NULL)");
    await db.run(db.sql`INSERT INTO contract_cron VALUES (${event.cron}, ${secrets.get("CONTRACT_SECRET")})`);
  },
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/api/contract/cron") {
      await db.exec("CREATE TABLE IF NOT EXISTS contract_cron (cron TEXT NOT NULL, secret TEXT NOT NULL)");
      return Response.json(await db.sql`SELECT cron, secret FROM contract_cron`);
    }
    if (path !== "/api/contract") return new Response("not found", { status: 404 });
    // Cases that compare the SDK with the env argument (same bindings, both work).
    const all = {
      ...cases,
      "app matches env.app": () => {
        eq(app.toJSON(), { ...env.app }, "app");
        eq([app.id, app.name, app.url, app.deployId], [env.app.id, env.app.name, env.app.url, env.app.deployId], "fields");
      },
      "the env argument works as before, on the same bindings": async () => {
        await env.db.run("INSERT INTO contract_b (v) VALUES (?)", "env");
        eq(await db.first(db.sql`SELECT v FROM contract_b WHERE v = ${"env"}`), { v: "env" }, "SDK sees env's write");
        eq(env.secrets.CONTRACT_SECRET, "s3cret", "env.secrets");
        eq((await env.db.batch([{ sql: "SELECT ? AS x", params: [7] }]))[0].rows, [{ x: 7 }], "env.db.batch");
      },
    };
    const results = [];
    for (const [name, run] of Object.entries(all)) {
      try {
        await run();
        results.push({ name, ok: true });
      } catch (e) {
        results.push({ name, ok: false, error: e?.stack ?? String(e) });
      }
    }
    return Response.json({ results });
  },
};
