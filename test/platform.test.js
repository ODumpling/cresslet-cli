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

/** Fake Cresslet API: `routes["METHOD /path"] = (body, url) => json` (`$status` sets the status); records every request. */
async function fakeApi(routes) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const h = routes[`${req.method} ${url.pathname}`];
    const { $status = h ? 200 : 404, ...json } = h ? h(body, url) : { error: "not_found", message: "not found" };
    res.writeHead($status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const cliEnv = (env) => (cwd, api, ...args) =>
  run(process.execPath, [CLI, ...args, "--api", api.url ?? api], {
    cwd,
    env: { ...process.env, CRESSLET_TOKEN: "tok", CRESSLET_CONFIG_DIR: path.join(cwd, ".cfg-test"), NO_COLOR: "1", ...env },
  });
const cli = cliEnv({});

test("deploy sends crons and project source (minus deps, build output, secrets, .gitignore'd)", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a", routes: ["/api/*"], crons: ["*/5 * * * *"] }));
  fs.writeFileSync(path.join(dir, ".gitignore"), "# c\n/secret.txt\nlogs/\n*.log\n");
  const env = "# public\nVITE_A=1\nexport CRESSLET_PUBLIC_B=2\nDB_PASSWORD=hunter2\n\nSECRET_KEY=x";
  fs.mkdirSync(path.join(dir, ".cfg-test"));
  fs.writeFileSync(path.join(dir, ".cfg-test", "config.json"), '{"tokens":{"x":"tok_secret"}}');
  for (const f of [".env", ".env.production", ".env.local", ".env.production.local", ".env.cresslet.prod", "sub/.env.local"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), env);
  }
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
    for (const p of paths) assert.doesNotMatch(p, /^(node_modules|dist|\.cresslet|logs)\/|secret|\.log$|\.env\.cresslet|\.cfg-test|\.local$/);
    for (const p of [".env", ".env.production"]) {
      const f = body.sources.find((s) => s.path === p);
      assert.equal(Buffer.from(f.data, f.encoding).toString(), "# public\nVITE_A=1\nexport CRESSLET_PUBLIC_B=2\n", p);
    }
    const bin = body.sources.find((s) => s.path === "src/logo.bin");
    assert.deepEqual([...Buffer.from(bin.data, bin.encoding)], [0, 255, 1]);

    await cli(dir, api, "deploy", "--no-source");
    assert.equal(api.calls.at(-1).body.sources, undefined);
  } finally {
    await api.close();
  }
});

const DEPLOYED = () => ({ app: { name: "a", url: "http://a.test", claimed: true }, deploy: { id: "dep_1" } });

test("deploy: built files + source share the deploy limits; over → deploy without source", async () => {
  const dir = copyFixture();
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy");
    const { files, sources } = api.calls.at(-1).body;
    assert.ok(sources.length < files.length + sources.length);
    // Each fits alone, not together.
    const fewer = cliEnv({ CRESSLET_MAX_DEPLOY_FILES: String(files.length + sources.length - 1) });
    const { stderr } = await fewer(dir, api, "deploy");
    assert.equal(api.calls.at(-1).body.sources, undefined);
    assert.equal(api.calls.at(-1).body.files.length, files.length);
    assert.match(stderr, /source not uploaded: \d+ built \+ \d+ source files exceed/);

    // Sizes are checked before reading: a big (sparse) file is never read.
    fs.closeSync(fs.openSync(path.join(dir, "big.bin"), "w"));
    fs.truncateSync(path.join(dir, "big.bin"), 26 * 1024 * 1024);
    const big = await cli(dir, api, "deploy");
    assert.equal(api.calls.at(-1).body.sources, undefined);
    assert.match(big.stderr, /source not uploaded: build \+ source exceed 25\.0 MB/);
  } finally {
    await api.close();
  }
});

test("deploy retries without source when the server's budget (source included) is smaller", async () => {
  const dir = copyFixture();
  const api = await fakeApi({
    "POST /v1/deploys": (b) => (b.sources
      ? { $status: 413, error: "too_large", message: "too many files (max 5, source included)" }
      : DEPLOYED()),
  });
  try {
    const { stderr } = await cli(dir, api, "deploy");
    assert.deepEqual(api.calls.map((c) => !!c.body.sources), [true, false]);
    assert.match(stderr, /source not uploaded \(too many files \(max 5, source included\)\)/);
  } finally {
    await api.close();
  }
  // Other 413s aren't retried.
  const api2 = await fakeApi({ "POST /v1/deploys": () => ({ $status: 413, error: "too_large", message: "server bundle too large" }) });
  try {
    await assert.rejects(cli(dir, api2, "deploy"), /server bundle too large/);
    assert.equal(api2.calls.length, 1);
  } finally {
    await api2.close();
  }
});

test("deploy --dir leaves the output dir out of the source; a static folder uploads no source", async () => {
  const dir = copyFixture();
  fs.mkdirSync(path.join(dir, "out"));
  fs.writeFileSync(path.join(dir, "out", "index.html"), "<p>built</p>");
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy", "--dir", "out");
    const { files, sources } = api.calls.at(-1).body;
    assert.deepEqual(files.map((f) => f.path), ["index.html"]);
    assert.ok(sources.some((s) => s.path === "cresslet.json"));
    assert.ok(!sources.some((s) => s.path.startsWith("out/")), sources.map((s) => s.path).join());

    const site = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-static-"));
    fs.writeFileSync(path.join(site, "index.html"), "<p>hi</p>");
    await cli(site, api, "deploy");
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

const sourceApi = (files, app = "a") => fakeApi({
  [`GET /v1/apps/${app}/source`]: () => ({ app, deployId: "dep_1", files: files.map((p) => (typeof p === "string" ? { path: p, data: "x", encoding: "utf8" } : p)) }),
});

test("pull validates every path before writing any", async () => {
  for (const bad of ["../x", "/abs", "C:/x", "c:x", "\\\\host\\share\\x", "\\\\?\\C:\\x", "a.txt:stream", "a/../../x", "a\\..\\..\\x",
    "a//b", "./x", "src/.git/config", ".GIT/hooks/pre-commit", ".git./x", "node_modules/x/index.js", "a/Node_Modules/b"]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
    const api = await sourceApi(["ok.txt", bad]);
    try {
      await assert.rejects(cli(cwd, api, "pull", "a"), /refusing to pull/, bad);
      assert.ok(!fs.existsSync(path.join(cwd, "a", "ok.txt")), `wrote ok.txt before rejecting ${bad}`);
    } finally {
      await api.close();
    }
  }
});

test("pull refuses to write through a symlink (dir, file, .cresslet/app.json)", async () => {
  for (const [link, file] of [["sub", "sub/x.txt"], ["cresslet.json", "cresslet.json"], [".cresslet", "cresslet.json"]]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-outside-"));
    const dest = path.join(cwd, "a");
    fs.mkdirSync(dest);
    const linkTarget = link === "cresslet.json" ? path.join(outside, "f") : outside;
    if (link === "cresslet.json") fs.writeFileSync(linkTarget, "orig");
    fs.symlinkSync(linkTarget, path.join(dest, link));
    const api = await sourceApi([{ path: file, data: '{"name":"a"}', encoding: "utf8" }, "ok.txt"]);
    try {
      await assert.rejects(cli(cwd, api, "pull", "a", "--force"), /refusing to write through a symlink/, link);
      assert.ok(!fs.existsSync(path.join(dest, "ok.txt")), link);
      assert.deepEqual(fs.readdirSync(outside), link === "cresslet.json" ? ["f"] : [], link);
      if (link === "cresslet.json") assert.equal(fs.readFileSync(linkTarget, "utf8"), "orig");
    } finally {
      await api.close();
    }
  }
});

test("pull: deploy key only for the same app + API; no stale key on relink; static copies get linked", async () => {
  const proj = copyFixture();
  const api = await fakeApi({
    "GET /v1/apps/a/source": () => ({ app: "a", deployId: "dep_1", files: [{ path: "cresslet.json", data: '{"name":"a"}', encoding: "utf8" }] }),
    "GET /v1/apps/s/source": () => ({ app: "s", deployId: "dep_1", files: [{ path: "index.html", data: "<p>s</p>", encoding: "utf8" }] }),
  });
  const link = (d) => JSON.parse(fs.readFileSync(path.join(d, ".cresslet", "app.json"), "utf8"));
  const setLink = (d, l) => {
    fs.mkdirSync(path.join(d, ".cresslet"), { recursive: true });
    fs.writeFileSync(path.join(d, ".cresslet", "app.json"), JSON.stringify(l));
  };
  try {
    setLink(proj, { name: "a", api: api.url, deployKey: "key_a" });
    await cli(proj, api, "pull", "a", "--dir", "copy1");
    assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], "key_a");
    assert.deepEqual(link(path.join(proj, "copy1")), { name: "a", api: api.url, deployKey: "key_a" });

    // Same app name on another server (the fake answers on localhost too): the key isn't sent or copied.
    const other = api.url.replace("127.0.0.1", "localhost");
    await cli(proj, other, "pull", "a", "--dir", "copy2");
    assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], undefined);
    assert.deepEqual(link(path.join(proj, "copy2")), { name: "a", api: other });

    // Relinking over another app's link drops its key.
    const stale = path.join(proj, "copy3");
    setLink(stale, { name: "b", api: api.url, deployKey: "key_b" });
    await cli(proj, api, "pull", "a", "--dir", "copy3", "--force");
    assert.deepEqual(link(stale), { name: "a", api: api.url, deployKey: "key_a" });

    // Static app (index.html, no cresslet.json) — even nested inside another project.
    await cli(proj, api, "pull", "s");
    assert.deepEqual(link(path.join(proj, "s")), { name: "s", api: api.url });
    assert.equal(link(proj).name, "a"); // the enclosing project's link is untouched
  } finally {
    await api.close();
  }
});

test("domains / egress --app work outside a project", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-noproj-"));
  const api = await fakeApi({
    "GET /v1/apps/x/domains": () => ({ domains: [] }),
    "GET /v1/apps/x/egress": () => ({ allow: [] }),
  });
  try {
    assert.match((await cli(cwd, api, "domains", "--app", "x")).stdout, /no custom domains/);
    assert.match((await cli(cwd, api, "egress", "--app", "x")).stdout, /no outbound hosts allowed/);
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
      if (url.searchParams.has("welcome")) server.send("welcome");
      server.addEventListener("message", (e) => {
        if (e.data === "throw") throw new Error("sync boom");
        if (e.data === "bye") return server.close(4000, "done");
        server.send(typeof e.data === "string" ? "echo " + e.data : new Uint8Array(e.data).reverse());
      });
      server.addEventListener("message", async (e) => {
        if (e.data === "reject") throw new Error("async boom");
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/api/101") return new Response(null, { status: 101 });
    if (url.pathname === "/api/instanceof") {
      return Response.json({
        fetch: (await fetch("data:,x")) instanceof Response,
        json: Response.json(1) instanceof Response,
        clone: new Response("x").clone() instanceof Response,
        own: new Response("x") instanceof Response,
        ws: new Response(null, { status: 101, webSocket: new WebSocketPair()[0] }) instanceof Response,
      });
    }
    if (url.pathname === "/api/ran") return Response.json(globalThis.ran ?? null);
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async scheduled(event, env, ctx) {
    if (event.cron === "fail") throw new Error("cron failed");
    if (event.cron === "bg-fail") {
      ctx.waitUntil(Promise.reject(new Error("background failed")));
      return new Promise((r) => setTimeout(r, 30)); // still running when the rejection lands
    }
    if (event.cron === "nested") {
      const later = (f) => new Promise((r) => setTimeout(r, 5)).then(f);
      ctx.waitUntil(later(() => ctx.waitUntil(later(() => ctx.waitUntil(later(() => { globalThis.ran = "nested"; }))))));
      return;
    }
    ctx.waitUntil(new Promise((r) => setTimeout(r, 10)).then(() => { globalThis.ran = { cron: event.cron, type: event.type, t: typeof event.scheduledTime }; }));
  },
};
`;

async function devWith(server, log = () => {}) {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "server", "index.ts"), server);
  return dev(loadProject(dir), { port: 0, log });
}

test("dev: POST /__cresslet/scheduled runs the scheduled() export", async () => {
  const d = await devWith(SERVER);
  try {
    const cron = encodeURIComponent("*/5 * * * *");
    const post = (c, headers = { "x-cresslet-dev": "1" }) => fetch(`${d.url}/__cresslet/scheduled?cron=${c}`, { method: "POST", headers });
    assert.equal((await fetch(`${d.url}/__cresslet/scheduled?cron=${cron}`)).status, 405);
    // Without the header (what a cross-site form/fetch "simple" request would send): refused, not run.
    assert.equal((await post(cron, { "content-type": "text/plain" })).status, 403);
    assert.equal(await (await fetch(d.url + "/api/ran")).json(), null);
    assert.equal((await post(cron)).status, 204);
    assert.deepEqual(await (await fetch(d.url + "/api/ran")).json(), { cron: "*/5 * * * *", type: "scheduled", t: "number" });
    const fail = await post("fail");
    assert.equal(fail.status, 500);
    assert.match(await fail.text(), /cron failed/);
    const bg = await post("bg-fail");
    assert.equal(bg.status, 500);
    assert.match(await bg.text(), /background failed/);
    assert.equal((await post("nested")).status, 204);
    assert.equal(await (await fetch(d.url + "/api/ran")).json(), "nested");
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

    // A frame sent before the 101 is returned arrives first.
    const w = new WebSocket(d.url.replace("http", "ws") + "/api/ws?welcome");
    const first = new Promise((r) => w.once("message", (data) => r(data.toString())));
    await new Promise((r, j) => w.once("open", r).once("error", j));
    assert.equal(await first, "welcome");
    w.close();

    for (const p of ["/api/missing", "/not-a-route"]) {
      const bad = new WebSocket(d.url.replace("http", "ws") + p);
      const status = await new Promise((r) => bad.once("unexpected-response", (_req, res) => r(res.statusCode)).once("error", () => {}));
      assert.equal(status, 404);
    }
  } finally {
    await d.close();
  }
});

test("dev: a throwing (sync or async) WebSocket listener is logged, the server keeps running", async () => {
  const logs = [];
  const d = await devWith(SERVER, (m) => logs.push(m));
  try {
    const ws = new WebSocket(d.url.replace("http", "ws") + "/api/ws");
    await new Promise((r, j) => ws.once("open", r).once("error", j));
    ws.send("throw");
    ws.send("reject");
    ws.send("still here");
    assert.equal(await new Promise((r) => ws.on("message", (m) => String(m).startsWith("echo still") && r(String(m)))), "echo still here");
    assert.ok(logs.some((l) => /message listener error[\s\S]*sync boom/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /message listener error[\s\S]*async boom/.test(l)), logs.join("\n"));
    ws.close();
  } finally {
    await d.close();
  }
});

test("dev: Response stays instanceof-compatible, a 101 without upgrade is a 500, globals restored on close", async () => {
  const NativeResponse = globalThis.Response;
  const d = await devWith(SERVER);
  try {
    assert.notEqual(globalThis.Response, NativeResponse);
    assert.deepEqual(await (await fetch(d.url + "/api/instanceof")).json(), { fetch: true, json: true, clone: true, own: true, ws: true });
    const r = await fetch(d.url + "/api/101");
    assert.equal(r.status, 500);
    assert.equal(await r.text(), "101 needs an upgrade request\n");
  } finally {
    await d.close();
  }
  assert.equal(globalThis.Response, NativeResponse);
  assert.equal(globalThis.WebSocketPair, undefined);
});
