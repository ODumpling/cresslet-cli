// Crons, source sync (deploy + pull), domains, egress, WebSockets in dev.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadProject } from "../lib/util.js";
import { dev } from "../lib/dev.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "cresslet.js");
const run = promisify(execFile);

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-"));
  fs.cpSync(path.join(HERE, "fixture"), dir, { recursive: true });
  return dir;
}

/** Fake Cresslet API: `routes["METHOD /path"] = (body, url) => json`; records every request. */
async function fakeApi(routes) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const h = routes[`${req.method} ${url.pathname}`];
    res.writeHead(h ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(h ? h(body, url) : { error: "not_found", message: "not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const cli = (cwd, api, ...args) =>
  run(process.execPath, [CLI, ...args, "--api", api.url], {
    cwd,
    env: { ...process.env, CRESSLET_TOKEN: "tok", CRESSLET_CONFIG_DIR: path.join(cwd, ".cfg-test"), NO_COLOR: "1" },
  });

test("deploy sends crons and project source (minus deps, build output, secrets, .gitignore'd)", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a", routes: ["/api/*"], crons: ["*/5 * * * *"] }));
  fs.writeFileSync(path.join(dir, ".gitignore"), "# c\n/secret.txt\nlogs/\n*.log\n");
  for (const f of ["node_modules/x/i.js", "secret.txt", "logs/a.txt", "src/debug.log", ".env.cresslet", "src/logo.bin"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === "src/logo.bin" ? Buffer.from([0, 255, 1]) : "x");
  }
  const api = await fakeApi({
    "POST /v1/deploys": () => ({ app: { name: "a", url: "http://a.test", claimed: true }, deploy: { id: "dep_1" } }),
  });
  try {
    await cli(dir, api, "deploy");
    const { body } = api.calls.find((c) => c.path === "/v1/deploys");
    assert.deepEqual(body.config, { routes: ["/api/*"], crons: ["*/5 * * * *"] });
    const paths = body.sources.map((s) => s.path);
    for (const p of ["cresslet.json", "index.html", "server/index.ts", "src/main.ts", "src/logo.bin", ".gitignore"]) {
      assert.ok(paths.includes(p), `missing ${p} in ${paths}`);
    }
    for (const p of paths) assert.doesNotMatch(p, /^(node_modules|dist|\.cresslet|logs)\/|secret|\.log$|\.env\.cresslet|\.cfg-test/);
    const bin = body.sources.find((s) => s.path === "src/logo.bin");
    assert.deepEqual([...Buffer.from(bin.data, bin.encoding)], [0, 255, 1]);

    await cli(dir, api, "deploy", "--no-source");
    assert.equal(api.calls.at(-1).body.sources, undefined);
  } finally {
    await api.close();
  }
});

test("pull writes the source (utf8 + base64), links the app, refuses a non-empty dir", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
  const api = await fakeApi({
    "GET /v1/apps/a/source": (_b, url) => ({
      app: "a",
      deployId: url.searchParams.get("deploy") ?? "dep_2",
      files: [
        { path: "cresslet.json", data: '{"name":"a"}', encoding: "utf8" },
        { path: "public/x.bin", data: Buffer.from([9, 0, 200]).toString("base64"), encoding: "base64" },
      ],
    }),
  });
  try {
    const { stdout } = await cli(cwd, api, "pull", "a", "--deploy", "dep_1");
    assert.match(stdout, /pulled a \(dep_1, 2 files\)/);
    assert.equal(api.calls[0].path, "/v1/apps/a/source?deploy=dep_1");
    const out = path.join(cwd, "a");
    assert.equal(fs.readFileSync(path.join(out, "cresslet.json"), "utf8"), '{"name":"a"}');
    assert.deepEqual([...fs.readFileSync(path.join(out, "public/x.bin"))], [9, 0, 200]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, ".cresslet/app.json"), "utf8")), { name: "a", api: api.url });
    await assert.rejects(cli(cwd, api, "pull", "a"), /is not empty/);
    await cli(cwd, api, "pull", "a", "--force");
  } finally {
    await api.close();
  }
});

test("domains: list / add (prints DNS records) / verify / rm", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  const view = (verified) => ({
    domain: "ex.com",
    verified,
    dns: [{ type: "CNAME", name: "ex.com", value: "a.cresslet.test" }, { type: "TXT", name: "_cresslet.ex.com", value: "tok123" }],
  });
  const api = await fakeApi({
    "GET /v1/apps/a/domains": () => ({ domains: [view(false)] }),
    "POST /v1/apps/a/domains": () => ({ domain: view(false) }),
    "POST /v1/apps/a/domains/ex.com/verify": () => ({ domain: view(true) }),
    "DELETE /v1/apps/a/domains/ex.com": () => ({ domains: [] }),
  });
  try {
    assert.match((await cli(dir, api, "domains")).stdout, /ex\.com\s+pending[\s\S]*TXT\s+_cresslet\.ex\.com\s+→\s+tok123/);
    const add = (await cli(dir, api, "domains", "add", "ex.com")).stdout;
    assert.match(add, /CNAME\s+ex\.com\s+→\s+a\.cresslet\.test/);
    assert.match(add, /cresslet domains verify ex\.com/);
    assert.deepEqual(api.calls.at(-1).body, { domain: "ex.com" });
    assert.match((await cli(dir, api, "domains", "verify", "ex.com")).stdout, /ex\.com verified/);
    assert.match((await cli(dir, api, "domains", "rm", "ex.com")).stdout, /removed ex\.com/);
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
      "GET /v1/apps/a/domains",
      "POST /v1/apps/a/domains",
      "POST /v1/apps/a/domains/ex.com/verify",
      "DELETE /v1/apps/a/domains/ex.com",
    ]);
  } finally {
    await api.close();
  }
});

test("egress: show / allow / clear", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  const api = await fakeApi({
    "GET /v1/apps/a/egress": () => ({ allow: null }),
    "PUT /v1/apps/a/egress": (b) => ({ allow: b.allow }),
  });
  try {
    assert.match((await cli(dir, api, "egress")).stdout, /any public host/);
    assert.match((await cli(dir, api, "egress", "allow", "api.stripe.com", "*.openai.com")).stdout, /api\.stripe\.com, \*\.openai\.com/);
    assert.deepEqual(api.calls.at(-1).body, { allow: ["api.stripe.com", "*.openai.com"] });
    await cli(dir, api, "egress", "clear");
    assert.deepEqual(api.calls.at(-1).body, { allow: null });
  } finally {
    await api.close();
  }
});

const SERVER = `
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/ws") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (e) => {
        if (e.data === "bye") return server.close(4000, "done");
        server.send(typeof e.data === "string" ? "echo " + e.data : new Uint8Array(e.data).reverse());
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/api/ran") return Response.json(globalThis.ran ?? null);
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async scheduled(event, env, ctx) {
    if (event.cron === "fail") throw new Error("cron failed");
    ctx.waitUntil(new Promise((r) => setTimeout(r, 10)).then(() => { globalThis.ran = { cron: event.cron, type: event.type, t: typeof event.scheduledTime }; }));
  },
};
`;

async function devWith(server) {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "server", "index.ts"), server);
  return dev(loadProject(dir), { port: 0, log: () => {} });
}

test("dev: POST /__cresslet/scheduled runs the scheduled() export", async () => {
  const d = await devWith(SERVER);
  try {
    const cron = encodeURIComponent("*/5 * * * *");
    assert.equal((await fetch(`${d.url}/__cresslet/scheduled?cron=${cron}`)).status, 405);
    assert.equal((await fetch(`${d.url}/__cresslet/scheduled?cron=${cron}`, { method: "POST" })).status, 204);
    assert.deepEqual(await (await fetch(d.url + "/api/ran")).json(), { cron: "*/5 * * * *", type: "scheduled", t: "number" });
    const fail = await fetch(`${d.url}/__cresslet/scheduled?cron=fail`, { method: "POST" });
    assert.equal(fail.status, 500);
    assert.match(await fail.text(), /cron failed/);
  } finally {
    await d.close();
  }
});

test("dev: WebSocketPair upgrades are bridged (text, binary, close code; non-101 refused)", async () => {
  const d = await devWith(SERVER);
  try {
    const ws = new WebSocket(d.url.replace("http", "ws") + "/api/ws");
    const next = () => new Promise((r) => ws.once("message", (data, isBinary) => r(isBinary ? [...data] : data.toString())));
    await new Promise((r, j) => ws.once("open", r).once("error", j));
    ws.send("hi");
    assert.equal(await next(), "echo hi");
    ws.send(Buffer.from([1, 2, 3]));
    assert.deepEqual(await next(), [3, 2, 1]);
    const closed = new Promise((r) => ws.once("close", (code, reason) => r([code, reason.toString()])));
    ws.send("bye");
    assert.deepEqual(await closed, [4000, "done"]);

    for (const p of ["/api/missing", "/not-a-route"]) {
      const bad = new WebSocket(d.url.replace("http", "ws") + p);
      const status = await new Promise((r) => bad.once("unexpected-response", (_req, res) => r(res.statusCode)).once("error", () => {}));
      assert.equal(status, 404);
    }
  } finally {
    await d.close();
  }
});
