// Crons, source sync (deploy + pull), domains, egress, WebSockets in dev.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadProject } from "../lib/util.ts";
import { agentStore } from "../lib/agents.ts";
import { dev } from "../lib/dev.ts";

// Runs compiled, from dist/test/ (npm test): the built CLI is dist/bin/cresslet.js, the fixture in the repo's test/.
const CLI = fileURLToPath(new URL("../bin/cresslet.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../test/fixture", import.meta.url));
const run = promisify(execFile);
/** What a failed `run` rejects with. */
type ExecError = Error & { code?: number; stdout: string; stderr: string };

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * JSON as the CLI sent it to the fake API, or as a route answers. Unchecked: the untyped boundary of these tests
 * (each test reads the fields it asserts on).
 */
type Wire = any;
type Route = (body: Wire, url: URL) => Wire;
/** A file in a deploy / upload body. */
type WireFile = { path: string; data: string; encoding: BufferEncoding };
/** The globals these tests look at: the dev server's WebSocket polyfill, and one a test app sets. */
const globals = globalThis as typeof globalThis & { WebSocketPair?: typeof WebSocketPair; lastCron?: string };

/** Fake Cresslet API: `routes["METHOD /path"] = (body, url) => json` (`$status` sets the status); records every request. */
async function fakeApi(routes: Record<string, Route | undefined>) {
  const calls: Wire[] = []; // { method, path, body, headers }
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, path: url.pathname + url.search, body, headers: req.headers });
    const h = routes[`${req.method} ${url.pathname}`];
    const { $status = h ? 200 : 404, ...json } = h ? h(body, url) : { error: "not_found", message: "not found" };
    res.writeHead($status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const cliEnv = (env: Record<string, string>) => (cwd: string, api: { url: string } | string, ...args: string[]) =>
  run(process.execPath, [CLI, ...args, "--api", typeof api === "string" ? api : api.url], {
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
    const paths = body.sources.map((s: WireFile) => s.path);
    for (const p of ["cresslet.json", "index.html", "server/index.ts", "src/main.ts", "src/logo.bin", ".gitignore"]) {
      assert.ok(paths.includes(p), `missing ${p} in ${paths}`);
    }
    for (const p of paths) assert.doesNotMatch(p, /^(node_modules|dist|\.cresslet|logs)\/|secret|\.log$|\.env\.cresslet|\.cfg-test|\.local$/);
    for (const p of [".env", ".env.production"]) {
      const f = body.sources.find((s: WireFile) => s.path === p);
      assert.equal(Buffer.from(f.data, f.encoding).toString(), "VITE_A=1\nexport CRESSLET_PUBLIC_B=2\n", p); // comments dropped (as the server)
    }
    const bin = body.sources.find((s: WireFile) => s.path === "src/logo.bin");
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
    assert.deepEqual(files.map((f: WireFile) => f.path), ["index.html"]);
    assert.ok(sources.some((s: WireFile) => s.path === "cresslet.json"));
    assert.ok(!sources.some((s: WireFile) => s.path.startsWith("out/")), sources.map((s: WireFile) => s.path).join());

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

const sourceApi = (files: (string | { path: string; data: string; encoding: string })[], app = "a") => fakeApi({
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
  const link = (d: string) => JSON.parse(fs.readFileSync(path.join(d, ".cresslet", "app.json"), "utf8"));
  const setLink = (d: string, l: object) => {
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
  const view = (verified: boolean) => ({
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

async function devWith(server: string, log: (message: string) => void = () => {}) {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "server", "index.ts"), server);
  return dev(loadProject(dir), { port: 0, log });
}

test("dev: POST /__cresslet/scheduled runs the scheduled() export", async () => {
  const d = await devWith(SERVER);
  try {
    const cron = encodeURIComponent("*/5 * * * *");
    const post = (c: string, headers: Record<string, string> = { "x-cresslet-dev": "1" }) => fetch(`${d.url}/__cresslet/scheduled?cron=${c}`, { method: "POST", headers });
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
    const next = () => new Promise((r) => ws.once("message", (data: Buffer, isBinary) => r(isBinary ? [...data] : data.toString())));
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
  const logs: string[] = [];
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
  assert.equal(globals.WebSocketPair, undefined);
});

// ---------------------------------------------------------------- review round 2
test("deploy source: .cresslet/ at any depth, .envrc, .dev.vars left out; comments dropped from dotenv", async () => {
  const dir = copyFixture();
  for (const f of ["nested/.cresslet/app.json", "nested/index.html", ".envrc", "sub/.envrc", ".dev.vars", "sub/.dev.vars"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f.endsWith("app.json") ? '{"deployKey":"key_nested"}' : "SECRET=x");
  }
  fs.writeFileSync(path.join(dir, ".env"), "# keep me\n# STRIPE_SECRET=sk_live_1\n#export DB_PASSWORD = x\nVITE_A=1\n\n# VITE_B=2 too\n");
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy");
    const { sources } = api.calls.at(-1).body;
    const paths = sources.map((s: WireFile) => s.path);
    assert.ok(paths.includes("nested/index.html"), paths.join());
    for (const p of paths) assert.doesNotMatch(p, /(^|\/)(\.cresslet\/|\.envrc$|\.dev\.vars$)/);
    const env = sources.find((s: WireFile) => s.path === ".env");
    assert.equal(Buffer.from(env.data, env.encoding).toString(), "VITE_A=1\n\n");
  } finally {
    await api.close();
  }
});

test("deploy --dir . sends no sources field (nothing left after filtering)", async () => {
  const dir = copyFixture();
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy", "--dir", ".");
    assert.ok(!("sources" in api.calls.at(-1).body), Object.keys(api.calls.at(-1).body).join());
  } finally {
    await api.close();
  }
});

test("deploy --dir never uploads CLI metadata, secrets, .git or node_modules (any depth)", async () => {
  const dir = copyFixture();
  const skipped = [".cresslet/app.json", ".env", ".env.production", ".envrc", ".dev.vars", ".git/config",
    "node_modules/x/index.js", "sub/.cresslet/app.json", "sub/.env.local", "sub/.dev.vars", "sub/.git/HEAD", "sub/node_modules/y.js"];
  for (const f of [...skipped, "sub/ok.txt"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "secret");
  }
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    const { stderr } = await cli(dir, api, "deploy", "--dir", ".");
    const paths = api.calls.at(-1).body.files.map((f: WireFile) => f.path);
    for (const f of skipped) assert.ok(!paths.includes(f), f);
    assert.ok(!paths.some((p: string) => /(^|\/)(\.cresslet|\.git|node_modules)\//.test(p)), paths.join());
    assert.ok(paths.includes("sub/ok.txt") && paths.includes("index.html"), paths.join());
    assert.equal(stderr.match(/not uploaded/g)?.length, 1, stderr);
    assert.match(stderr, /\.cresslet\/.*\.env\b.*node_modules\//s);
  } finally {
    await api.close();
  }
});

test("pull --dir works through a symlinked ancestor (macOS /tmp); a symlink at or inside the destination is refused", async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-real-"));
  const via = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-via-")), "tmp"); // like /tmp → /private/tmp
  fs.symlinkSync(real, via);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
  const api = await sourceApi(["ok.txt", "d/f.txt"]);
  try {
    await cli(cwd, api, "pull", "a", "--dir", path.join(via, "x"));
    assert.equal(fs.readFileSync(path.join(real, "x", "d", "f.txt"), "utf8"), "x");

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-outside-"));
    fs.symlinkSync(outside, path.join(real, "y")); // AT the destination, reached via the symlinked ancestor
    await assert.rejects(cli(cwd, api, "pull", "a", "--dir", path.join(via, "y")), /refusing to write through a symlink/);
    fs.mkdirSync(path.join(real, "z"));
    fs.symlinkSync(outside, path.join(real, "z", "d")); // inside it
    await assert.rejects(cli(cwd, api, "pull", "a", "--dir", path.join(via, "z"), "--force"), /refusing to write through a symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await api.close();
  }
});

test("pull refuses a destination that is a symlink", async () => {
  for (const mk of [
    (cwd: string, outside: string) => { fs.symlinkSync(outside, path.join(cwd, "a")); return ["pull", "a"]; },
    (cwd: string, outside: string) => { fs.symlinkSync(outside, path.join(cwd, "a")); return ["pull", "a", "--dir", "a"]; },
  ]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-outside-"));
    const api = await sourceApi(["ok.txt"]);
    try {
      await assert.rejects(cli(cwd, api, ...mk(cwd, outside)), /refusing to write through a symlink/);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      await api.close();
    }
  }
});

test("pull refuses .cresslet/ paths from the server; deploy key only from a link that existed before", async () => {
  for (const bad of [".cresslet/app.json", "sub/.cresslet/app.json", ".Cresslet./app.json"]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
    const api = await sourceApi(["ok.txt", { path: bad, data: '{"name":"a","deployKey":"evil"}', encoding: "utf8" }]);
    try {
      await assert.rejects(cli(cwd, api, "pull", "a"), /refusing to pull/, bad);
      assert.ok(!fs.existsSync(path.join(cwd, "a")), bad);
    } finally {
      await api.close();
    }
  }
  // A pre-existing link in the destination for the same app + API keeps its key.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
  const api = await sourceApi([{ path: "cresslet.json", data: '{"name":"a"}', encoding: "utf8" }]);
  try {
    fs.mkdirSync(path.join(cwd, "a", ".cresslet"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "a", ".cresslet", "app.json"), JSON.stringify({ name: "a", api: api.url, deployKey: "key_a" }));
    await cli(cwd, api, "pull", "a", "--force");
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "a", ".cresslet", "app.json"), "utf8")).deployKey, "key_a");
  } finally {
    await api.close();
  }
});

test("a pulled static app nested in another project is its own project root", async () => {
  const proj = copyFixture();
  fs.mkdirSync(path.join(proj, ".cresslet"), { recursive: true });
  const api = await fakeApi({
    "GET /v1/apps/s/source": () => ({ app: "s", deployId: "dep_1", files: [{ path: "index.html", data: "<p>s</p>", encoding: "utf8" }] }),
    "GET /v1/apps/s/domains": () => ({ domains: [] }),
  });
  try {
    fs.writeFileSync(path.join(proj, ".cresslet", "app.json"), JSON.stringify({ name: "a", api: api.url, deployKey: "key_a" }));
    await cli(proj, api, "pull", "s");
    fs.mkdirSync(path.join(proj, "s", "deep"));
    for (const cwd of [path.join(proj, "s"), path.join(proj, "s", "deep")]) {
      await cli(cwd, api, "domains");
      assert.equal(api.calls.at(-1).path, "/v1/apps/s/domains", cwd);
      assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], undefined);
    }
  } finally {
    await api.close();
  }
});

test("domains / egress --app <other>: the project's deploy key isn't sent", async () => {
  const dir = copyFixture();
  const api = await fakeApi({
    "GET /v1/apps/a/domains": () => ({ domains: [] }),
    "GET /v1/apps/x/domains": () => ({ domains: [] }),
    "GET /v1/apps/a/egress": () => ({ allow: [] }),
    "GET /v1/apps/x/egress": () => ({ allow: [] }),
  });
  try {
    fs.mkdirSync(path.join(dir, ".cresslet"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cresslet", "app.json"), JSON.stringify({ name: "a", api: api.url, deployKey: "key_a" }));
    for (const cmd of ["domains", "egress"]) {
      await cli(dir, api, cmd);
      assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], "key_a", cmd);
      await cli(dir, api, cmd, "--app", "x");
      assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], undefined, `${cmd} --app x`);
      await cli(dir, api.url.replace("127.0.0.1", "localhost"), cmd);
      assert.equal(api.calls.at(-1).headers["x-cresslet-deploy-key"], undefined, `${cmd} other api`);
    }
  } finally {
    await api.close();
  }
});

test("dev: a failed startup restores the globals", async () => {
  const NativeResponse = globalThis.Response;
  const busy = http.createServer();
  await new Promise<void>((r) => busy.listen(0, "localhost", r));
  try {
    const dir = copyFixture();
    fs.writeFileSync(path.join(dir, "server", "index.ts"), SERVER);
    await assert.rejects(dev(loadProject(dir), { port: (busy.address() as AddressInfo).port, log: () => {} }), /EADDRINUSE/);
    assert.equal(globalThis.Response, NativeResponse);
    assert.equal(globals.WebSocketPair, undefined);
  } finally {
    await new Promise((r) => busy.close(r));
  }
});

test("Response shim: instanceof compat only for the shim itself; error reporter reset on uninstall", async () => {
  const { installWebSocketPolyfill } = await import("../lib/websocket.ts");
  const NativeResponse = globalThis.Response;
  const seen: string[] = [];
  let uninstall = installWebSocketPolyfill({ onListenerError: (type) => seen.push(type) });
  try {
    const Shim = globalThis.Response;
    class Sub extends Shim {}
    assert.ok(new NativeResponse("x") instanceof Shim);
    assert.ok(!(new NativeResponse("x") instanceof Sub));
    assert.ok(!(new Shim("x") instanceof Sub));
    assert.ok(new Sub("x") instanceof Sub);
    assert.ok(new Sub("x") instanceof Shim);
  } finally {
    uninstall();
  }
  uninstall = installWebSocketPolyfill();
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    const [a, b] = Object.values(new globals.WebSocketPair!()) as WebSocketPair[1][];
    a.accept();
    b.accept();
    a.addEventListener("message", () => { throw new Error("x"); });
    b.send("hi");
    assert.deepEqual(seen, []);
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
    uninstall();
  }
});

test("pull re-checks the destination after the API response (now a symlink, or an ancestor swapped → refused)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-pull-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-outside-"));
  let swap = () => {};
  const api = await fakeApi({
    "GET /v1/apps/a/source": () => (swap(), { app: "a", deployId: "dep_1", files: [{ path: "ok.txt", data: "x", encoding: "utf8" }] }),
  });
  try {
    swap = () => fs.symlinkSync(outside, path.join(cwd, "a")); // the destination itself
    await assert.rejects(cli(cwd, api, "pull", "a"), /refusing to write through a symlink/);
    fs.mkdirSync(path.join(cwd, "p"));
    swap = () => { fs.rmdirSync(path.join(cwd, "p")); fs.symlinkSync(outside, path.join(cwd, "p")); }; // an ancestor
    await assert.rejects(cli(cwd, api, "pull", "a", "--dir", path.join(cwd, "p", "x")), /changed while pulling/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await api.close();
  }
});

test("deploy filters match names case-insensitively; --dir inside .cresslet/.git/node_modules is refused", async () => {
  const dir = copyFixture();
  const secret = ["sub/.CRESSLET/app.json", "sub/.ENV.LOCAL", "sub/.EnvRC", "sub/.Dev.Vars", "sub/Node_Modules/x.js", "sub/.GIT/HEAD"];
  for (const f of [...secret, "sub/ok.txt", "node_modules/foo/a.js", ".git/b"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "SECRET=x");
  }
  fs.writeFileSync(path.join(dir, "sub", ".ENV"), "SECRET=x\nVITE_A=1\n");
  fs.writeFileSync(path.join(dir, "sub", ".ENV_BACKUP"), "SECRET=x\nVITE_B=1\n");
  fs.writeFileSync(path.join(dir, "sub", ".environment.js"), "export const x = 1;\n");
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy");
    const { sources } = api.calls.at(-1).body;
    const paths = sources.map((s: WireFile) => s.path);
    assert.ok(paths.includes("sub/ok.txt"), paths.join());
    for (const f of secret) assert.ok(!paths.includes(f), f);
    const env = sources.find((s: WireFile) => s.path === "sub/.ENV");
    assert.equal(Buffer.from(env.data, env.encoding).toString(), "VITE_A=1\n");
    const backup = sources.find((s: WireFile) => s.path === "sub/.ENV_BACKUP");
    assert.equal(Buffer.from(backup.data, backup.encoding).toString(), "VITE_B=1\n"); // any .env-style name is sanitized
    const code = sources.find((s: WireFile) => s.path === "sub/.environment.js");
    assert.equal(Buffer.from(code.data, code.encoding).toString(), ""); // any .env* name, as the server sanitizes it

    await cli(dir, api, "deploy", "--dir", "sub");
    const files = api.calls.at(-1).body.files.map((f: WireFile) => f.path);
    assert.deepEqual(files, ["ok.txt"]);

    const n = api.calls.length;
    for (const d of [".cresslet", "node_modules/foo", ".git", "sub/Node_Modules"]) {
      await assert.rejects(cli(dir, api, "deploy", "--dir", d), /refusing to deploy --dir/, d);
    }
    // Also outside this project (e.g. a sibling project's deps).
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "sib-"));
    fs.mkdirSync(path.join(sibling, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(sibling, "node_modules", "pkg", "index.html"), "x");
    await assert.rejects(cli(dir, api, "deploy", "--dir", path.join(sibling, "node_modules", "pkg")), /refusing to deploy --dir/);
    assert.equal(api.calls.length, n);
  } finally {
    await api.close();
  }
});

test("dev: a failed startup while another dev runs restores that instance's WebSocket error reporter", async () => {
  const logs: { a: string[]; b: string[] } = { a: [], b: [] };
  const a = await devWith(SERVER, (m) => logs.a.push(m));
  try {
    const dir = copyFixture();
    fs.writeFileSync(path.join(dir, "server", "index.ts"), SERVER);
    const port = Number(new URL(a.url).port);
    await assert.rejects(dev(loadProject(dir), { port, log: (m) => logs.b.push(m) }), /EADDRINUSE/);
    const [x, y] = Object.values(new globals.WebSocketPair!()) as WebSocketPair[1][];
    x.accept();
    y.accept();
    x.addEventListener("message", () => { throw new Error("boom"); });
    y.send("hi");
    assert.ok(logs.a.some((m) => /WebSocket message listener error/.test(m)), logs.a.join("\n"));
    assert.ok(!logs.b.some((m) => /listener error/.test(m)), logs.b.join("\n"));
  } finally {
    await a.close();
  }
});

test("page: upload a file or folder with settings, set / update / open / rm; settings defaults", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-pages-"));
  fs.writeFileSync(path.join(dir, "notes.html"), "<h1>notes</h1>");
  fs.mkdirSync(path.join(dir, "site/img"), { recursive: true });
  fs.mkdirSync(path.join(dir, "site/node_modules"));
  fs.writeFileSync(path.join(dir, "site/index.html"), "<h1>site</h1>");
  fs.writeFileSync(path.join(dir, "site/img/a.png"), Buffer.from([137, 80]));
  fs.writeFileSync(path.join(dir, "site/.env"), "SECRET=1");
  fs.writeFileSync(path.join(dir, "site/node_modules/x.js"), "x");
  fs.writeFileSync(path.join(dir, "readme.txt"), "x");
  fs.mkdirSync(path.join(dir, "noindex"));
  fs.writeFileSync(path.join(dir, "noindex/a.html"), "x");
  const page = (over: Wire = {}) => ({ id: "app_1", name: "pg-1", title: "notes", url: "http://pg-1.x", visibility: "link", retentionDays: 7, expiresAt: "2026-12-01T00:00:00.000Z", files: 1, bytes: 14, ...over });
  const settings = (pages: Wire) => ({ pages, defaults: { pages: { visibility: "private", retentionDays: 30 } } });
  const api = await fakeApi({
    "POST /v1/pages": (b) => ({ $status: 201, page: page({ title: b.title }) }),
    "GET /v1/pages": () => ({ pages: [page(), page({ name: "pg-2", title: null, retentionDays: null, expiresAt: null })] }),
    "PATCH /v1/pages/pg-1": (b) => ({ page: page({ ...b }) }),
    "PUT /v1/pages/pg-1": () => ({ page: page() }),
    "GET /v1/pages/pg-1": () => ({ page: page() }),
    "POST /v1/pages/pg-1/view": () => ({ url: "http://pg-1.x/?cresslet_view=pvt_1", expiresIn: 120 }),
    "DELETE /v1/pages/pg-1": () => ({ deleted: "pg-1" }),
    "GET /v1/me/settings": () => settings({ visibility: "private", retentionDays: 30 }),
    "PUT /v1/me/settings": (b) => settings(b.pages ?? { visibility: "private", retentionDays: 30 }),
  });
  try {
    // One file: its text as `html`; settings only when given.
    assert.match((await cli(dir, api, "page", "upload", "notes.html")).stdout, /uploaded[\s\S]*http:\/\/pg-1\.x[\s\S]*anyone with the link[\s\S]*7 days/);
    assert.deepEqual(api.calls.at(-1).body, { title: "notes", html: "<h1>notes</h1>", source: "cli" });
    // A folder: base64 files, hidden files and node_modules left out.
    await cli(dir, api, "page", "upload", "site", "--visibility", "public", "--keep", "forever", "--title", "Site");
    const up = api.calls.at(-1).body;
    assert.equal(up.title, "Site");
    assert.equal(up.visibility, "public");
    assert.equal(up.retentionDays, null);
    assert.deepEqual(up.files.map((f: WireFile) => f.path).sort(), ["img/a.png", "index.html"]);
    assert.equal(Buffer.from(up.files.find((f: WireFile) => f.path === "img/a.png").data, "base64").length, 2);
    for (const [args, msg] of [
      [["upload", "readme.txt"], /isn't an \.html file/],
      [["upload", "noindex"], /has no index\.html/],
      [["upload", "notes.html", "--visibility", "secret"], /--visibility must be one of/],
      [["upload", "notes.html", "--keep", "0"], /--keep must be a number of days/],
      [["set", "pg-1"], /nothing to change/],
    ] as [string[], RegExp][]) await assert.rejects(cli(dir, api, "page", ...args), (e: ExecError) => msg.test(e.stderr), args.join(" "));

    assert.match((await cli(dir, api, "page", "ls")).stdout, /notes\s+link\s+until 2026-12-01\s+http:\/\/pg-1\.x\n.*pg-2\s+link\s+forever/);
    await cli(dir, api, "page", "set", "http://pg-1.x/", "--visibility", "private", "--keep", "3");
    assert.deepEqual(api.calls.at(-1).body, { visibility: "private", retentionDays: 3 });
    await cli(dir, api, "page", "update", "pg-1", "notes.html", "--keep", "30");
    assert.deepEqual(api.calls.slice(-2).map((c) => [c.method, c.path, c.body]), [
      ["PATCH", "/v1/pages/pg-1", { retentionDays: 30 }],
      ["PUT", "/v1/pages/pg-1", { html: "<h1>notes</h1>", source: "cli" }],
    ]);
    assert.equal(JSON.parse((await cli(dir, api, "page", "open", "pg-1", "--json")).stdout).url, "http://pg-1.x/?cresslet_view=pvt_1");
    await cli(dir, api, "page", "rm", "pg-1", "-y");
    assert.equal(api.calls.at(-1).method, "DELETE");

    assert.match((await cli(dir, api, "settings")).stdout, /private[\s\S]*30 days[\s\S]*server default: private, 30 days/);
    assert.match((await cli(dir, api, "settings", "--page-visibility", "link", "--page-keep", "forever")).stdout, /anyone with the link[\s\S]*forever/);
    assert.deepEqual(api.calls.at(-1).body, { pages: { visibility: "link", retentionDays: null } });
    await cli(dir, api, "settings", "--reset");
    assert.deepEqual(api.calls.at(-1).body, { pages: null });
  } finally {
    await api.close();
  }
});

test("deploy: an .html file or --artifact folder becomes an artifact, linked so the next deploy updates it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-artifacts-"));
  fs.writeFileSync(path.join(dir, "notes.html"), "<h1>notes</h1>");
  fs.mkdirSync(path.join(dir, "site"));
  fs.writeFileSync(path.join(dir, "site/index.html"), "<h1>site</h1>");
  fs.mkdirSync(path.join(dir, "static"));
  fs.writeFileSync(path.join(dir, "static/index.html"), "<h1>static</h1>");
  const proj = copyFixture();
  // Artifacts by name, as the server keeps them.
  const pages: Record<string, Wire> = {};
  let ids = 0;
  const page = (p: Wire) => ({ title: "notes", url: `http://${p.name}.x`, visibility: "private", retentionDays: 30, expiresAt: "2026-12-01T00:00:00.000Z", files: 1, bytes: 14, ...p });
  const one = (fn: (name: string, b: Wire) => Wire): Route => (b, url) => {
    const name = url.pathname.split("/")[3];
    return pages[name] ? fn(name, b) : { $status: 404, error: "not_found", message: `artifact not found: ${name}` };
  };
  const routes: Record<string, Route | undefined> = {
    "POST /v1/pages": (b) => {
      const name = b.name ?? `pg-${++ids}`;
      pages[name] = page({ id: `app_${name}`, name, title: b.title, ...(b.visibility ? { visibility: b.visibility } : {}) });
      return { $status: 201, page: pages[name] };
    },
    "POST /v1/deploys": (b) => ({ $status: 201, app: { name: b.app ?? "quiet-1", url: "http://quiet-1.x", claimed: true }, deploy: { id: "dep_1" } }),
  };
  const api = await fakeApi(new Proxy(routes, {
    get: (t, k: string) => t[k] ?? (/^(GET|PUT|PATCH) \/v1\/pages\/[^/]+$/.test(k) ? one((name, b) => {
      if (k.startsWith("PATCH")) Object.assign(pages[name], b);
      return { page: pages[name] };
    }) : undefined),
  }));
  const calls = () => api.calls.splice(0).map((c) => [c.method, c.path, ...(c.body?.name ? [c.body.name] : [])]);
  try {
    // A single .html file: a new artifact, then the same one again.
    const first = await cli(dir, api, "deploy", "notes.html");
    assert.match(first.stdout, /deployed artifact pg-1 \(new\)[\s\S]*http:\/\/pg-1\.x[\s\S]*private[\s\S]*share it: .*#\/share\/pg-1/);
    assert.deepEqual(api.calls.at(-1).body, { title: "notes", html: "<h1>notes</h1>", source: "cli" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".cresslet/artifacts.json"), "utf8")), { "notes.html": { name: "pg-1", id: "app_pg-1", api: api.url } });
    assert.ok(!fs.existsSync(path.join(dir, ".gitignore")), "no .gitignore outside a git repo");
    calls();
    const again = JSON.parse((await cli(dir, api, "deploy", "notes.html", "--keep", "3", "--json")).stdout);
    assert.deepEqual([again.kind, again.created, again.artifact.retentionDays], ["artifact", false, 3]);
    assert.deepEqual(calls(), [["GET", "/v1/pages/pg-1"], ["PATCH", "/v1/pages/pg-1"], ["PUT", "/v1/pages/pg-1"]], "settings before the new files");
    // A wider visibility only once the new files are live; a narrower one before them.
    await cli(dir, api, "deploy", "notes.html", "--visibility", "public", "--title", "N");
    assert.deepEqual(api.calls.slice(1).map((c) => [c.method, c.body?.title ?? c.body?.visibility ?? "files"]), [["PATCH", "N"], ["PUT", "files"], ["PATCH", "public"]]);
    assert.equal(api.calls[1].body.visibility, "private", "widening: the current visibility first (checks the token may change it)");
    calls();
    await cli(dir, api, "deploy", "notes.html", "--visibility", "link");
    assert.deepEqual(api.calls.slice(1).map((c) => [c.method, c.body?.visibility ?? "files"]), [["PATCH", "link"], ["PUT", "files"]]);
    calls();

    // A folder with --artifact and an address of your own: created under it, then updated from inside the folder.
    assert.match((await cli(dir, api, "deploy", "site", "--artifact", "--name", "my-site")).stdout, /deployed artifact my-site \(new\)/);
    assert.deepEqual(api.calls.map((c) => [c.method, c.path, c.body?.name]), [["GET", "/v1/pages/my-site", undefined], ["POST", "/v1/pages", "my-site"]]);
    assert.deepEqual(api.calls.at(-1).body.files.map((f: WireFile) => f.path), ["index.html"]);
    calls();
    assert.match((await cli(path.join(dir, "site"), api, "deploy")).stdout, /deployed artifact my-site \(updated, same link\)/);
    assert.deepEqual(calls(), [["GET", "/v1/pages/my-site"], ["PUT", "/v1/pages/my-site"]]);
    // The link lives next to the folder: rebuilding it (as a build does with dist/) keeps it.
    fs.rmSync(path.join(dir, "site"), { recursive: true });
    fs.mkdirSync(path.join(dir, "site"));
    fs.writeFileSync(path.join(dir, "site/index.html"), "<h1>site 2</h1>");
    assert.match((await cli(dir, api, "deploy", "site")).stdout, /deployed artifact my-site \(updated, same link\)/);
    assert.deepEqual(calls(), [["GET", "/v1/pages/my-site"], ["PUT", "/v1/pages/my-site"]]);

    // A linked artifact that's gone, or whose address another artifact has now: a new one at a new address, said so.
    delete pages["pg-1"];
    const redo = await cli(dir, api, "deploy", "notes.html", "--json");
    assert.deepEqual(JSON.parse(redo.stdout).gone, "pg-1");
    assert.deepEqual(calls(), [["GET", "/v1/pages/pg-1"], ["POST", "/v1/pages"]]);
    pages["pg-2"].id = "app_someone_else";
    assert.match((await cli(dir, api, "deploy", "notes.html")).stdout, /pg-2 is gone[\s\S]*new address[\s\S]*deployed artifact pg-3 \(new\)/);
    assert.deepEqual(calls(), [["GET", "/v1/pages/pg-2"], ["POST", "/v1/pages"]]);
    // Another account's (403): gone too, for a linked one; --name sends it to POST (the server says it's taken).
    routes["GET /v1/pages/theirs"] = () => ({ $status: 403, error: "forbidden", message: "no access" });
    routes["POST /v1/pages"] = ((post: Route): Route => (b, url) => (b.name === "theirs" ? { $status: 409, error: "conflict", message: "name unavailable: theirs" } : post(b, url)))(routes["POST /v1/pages"]!);
    await assert.rejects(cli(dir, api, "deploy", "notes.html", "--name", "theirs"), (e: ExecError) => /name unavailable: theirs/.test(e.stderr));
    calls();
    // Redeploys go to the server it was deployed to, without --api.
    await run(process.execPath, [CLI, "deploy", "notes.html"], {
      cwd: dir, env: { ...process.env, CRESSLET_API: "", CRESSLET_TOKEN: "tok", CRESSLET_CONFIG_DIR: path.join(dir, ".cfg-test"), NO_COLOR: "1" },
    });
    assert.deepEqual(calls(), [["GET", "/v1/pages/pg-3"], ["PUT", "/v1/pages/pg-3"]]);

    // Any other folder is still a public app, and says so up front (also with --name).
    const app = await cli(dir, api, "deploy", "static", "--name", "my-static");
    assert.match(app.stderr, /static has no cresslet\.json: it goes live as a public app/);
    assert.match(app.stdout, /deployed app my-static[\s\S]*cresslet deploy static --artifact --api \S+, then take this app down: cd static && cresslet delete/);
    assert.deepEqual(calls(), [["POST", "/v1/deploys"]]);

    // --dir: the hint names the folder that was uploaded; a linked app folder deploys its --dir output from outside it.
    fs.mkdirSync(path.join(dir, "linked/out"), { recursive: true });
    fs.writeFileSync(path.join(dir, "linked/index.html"), "<h1>src</h1>");
    fs.writeFileSync(path.join(dir, "linked/out/index.html"), "<h1>out</h1>");
    assert.match((await cli(dir, api, "deploy", "linked", "--dir", "linked/out")).stdout, new RegExp(`cresslet deploy linked/out --artifact --api ${api.url}, then take this app down: cd linked && cresslet delete`));
    fs.rmSync(path.join(dir, "linked/index.html"));
    await cli(dir, api, "deploy", "linked", "--dir", "linked/out");
    assert.equal(api.calls.at(-1).body.app, "quiet-1");
    calls();

    // In a git repo, .cresslet/ is gitignored.
    fs.mkdirSync(path.join(dir, ".git"));
    await cli(dir, api, "deploy", "notes.html");
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.cresslet$/m);
    calls();

    // A folder inside an app project (its build output) isn't an app of its own.
    fs.mkdirSync(path.join(proj, "dist"), { recursive: true });
    fs.writeFileSync(path.join(proj, "dist/index.html"), "<h1>built</h1>");
    await assert.rejects(cli(proj, api, "deploy", "dist"), (e: ExecError) => /dist is inside the app project \.[\s\S]*cresslet deploy dist --artifact/.test(e.stderr));
    assert.ok(!api.calls.length);
    // A new artifact in a project goes to the project's server, as its app does.
    fs.mkdirSync(path.join(proj, ".cresslet"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".cresslet/app.json"), JSON.stringify({ api: api.url }));
    const r = await run(process.execPath, [CLI, "deploy", "dist", "--artifact"], {
      cwd: proj, env: { ...process.env, CRESSLET_API: "", CRESSLET_TOKEN: "tok", CRESSLET_CONFIG_DIR: path.join(proj, ".cfg-test"), NO_COLOR: "1" },
    });
    assert.match(r.stdout, /deployed artifact pg-\d+ \(new\)/);
    calls();
    // An enclosing cresslet.json that doesn't parse doesn't stop an artifact.
    fs.writeFileSync(path.join(proj, "cresslet.json"), "{oops");
    assert.match((await cli(proj, api, "deploy", "dist", "--artifact")).stdout, /deployed artifact/);
    calls();

    for (const [cwd, args, msg] of [
      [proj, ["--visibility", "link"], /app project \(cresslet\.json\): apps are always public[\s\S]*cresslet deploy dist --visibility/],
      [dir, ["notes.html", "--dir", "site"], /--dir and --server are for apps/],
      [dir, ["readme.txt"], /not found: readme\.txt/],
      [dir, ["notes.html", "--name="], /--name <address>/],
    ] as [string, string[], RegExp][]) await assert.rejects(cli(cwd, api, "deploy", ...args), (e: ExecError) => msg.test(e.stderr), args.join(" "));
    const anon = cliEnv({ CRESSLET_TOKEN: "" });
    await assert.rejects(anon(dir, api, "deploy", "notes.html"), (e: ExecError) => /artifacts need a login[\s\S]*cresslet login/.test(e.stderr));
    assert.ok(!api.calls.length, "nothing sent when refused");
  } finally {
    await api.close();
  }
});

test("artifact upload --name sends the address; page is the old name of artifact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-artifacts-"));
  fs.writeFileSync(path.join(dir, "notes.html"), "<h1>notes</h1>");
  const page = { id: "app_1", name: "q4", title: "notes", url: "http://q4.x", visibility: "link", retentionDays: 7, expiresAt: "2026-12-01T00:00:00.000Z", files: 1, bytes: 14 };
  const settings = (pages: Wire) => ({ pages, defaults: { pages: { visibility: "private", retentionDays: 30 } } });
  const api = await fakeApi({
    "POST /v1/pages": () => ({ $status: 201, page }),
    "GET /v1/pages": () => ({ pages: [] }),
    "PUT /v1/me/settings": (b) => settings(b.pages),
  });
  try {
    await cli(dir, api, "artifact", "upload", "notes.html", "--name", "q4");
    assert.equal(api.calls.at(-1).body.name, "q4");
    assert.match((await cli(dir, api, "page", "ls")).stdout, /no artifacts yet \(cresslet deploy/);
    assert.match((await cli(dir, api, "settings", "--artifact-visibility", "public", "--artifact-keep", "9")).stdout, /new artifacts[\s\S]*public/);
    assert.deepEqual(api.calls.at(-1).body, { pages: { visibility: "public", retentionDays: 9 } });
  } finally {
    await api.close();
  }
});

test("auth login: browser approval or --token; auth status / logout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-"));
  const { CRESSLET_TOKEN: _, ...env } = process.env;
  const noToken = (cwd: string, api: { url: string }, ...args: string[]) => run(process.execPath, [CLI, ...args, "--api", api.url], {
    cwd,
    env: { ...env, CRESSLET_CONFIG_DIR: path.join(cwd, ".cfg-test"), NO_COLOR: "1" },
  });
  let polls = 0;
  const account = { id: "acct_1", email: "o@x.dev", github: "octo" };
  const api = await fakeApi({
    "GET /v1": () => ({ auth: { github: true, cli: true } }),
    "POST /v1/auth/cli": () => ({
      deviceCode: "cli_dc",
      userCode: "BCDF-GHJK",
      verificationUri: "http://studio.test/#/cli",
      expiresIn: 60,
      interval: 0.01,
    }),
    "POST /v1/auth/cli/token": () => (++polls < 2 ? { status: "pending" } : { status: "complete", account, token: "clv_acct_new" }),
    "GET /v1/me": () => ({ account }),
  });
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, ".cfg-test", "config.json"), "utf8"));
  try {
    const r = await noToken(dir, api, "auth", "login");
    assert.match(r.stderr, /open http:\/\/studio\.test\/#\/cli and enter BCDF-GHJK\n/);
    assert.match(r.stdout, /logged in as octo \(o@x\.dev\)/);
    assert.deepEqual(api.calls.filter((c) => c.path === "/v1/auth/cli/token").map((c) => c.body), [
      { deviceCode: "cli_dc" },
      { deviceCode: "cli_dc" },
    ]);
    assert.equal(config().tokens[api.url], "clv_acct_new");

    await noToken(dir, api, "auth", "login", "--token=clv_acct_pasted");
    assert.equal(api.calls.at(-1).headers.authorization, "Bearer clv_acct_pasted");
    assert.equal(config().tokens[api.url], "clv_acct_pasted");

    assert.match((await noToken(dir, api, "auth", "status")).stdout, /octo \(o@x\.dev\)/);
    assert.equal(api.calls.at(-1).headers.authorization, "Bearer clv_acct_pasted");
    await noToken(dir, api, "auth", "logout");
    assert.equal(config().tokens[api.url], undefined);
    await assert.rejects(noToken(dir, api, "auth", "nope"), (e: ExecError) => /unknown auth command: nope/.test(e.stderr));
    assert.match((await noToken(dir, api, "auth", "--help")).stdout, /usage: cresslet auth login/);
    await noToken(dir, api, "auth", "login", "--token=clv_acct_kept");
    const n = api.calls.length;
    assert.match((await noToken(dir, api, "auth", "logout", "-h")).stdout, /usage: cresslet auth/);
    await noToken(dir, api, "auth", "login", "--help");
    assert.equal(api.calls.length, n); // help only: no login started
    assert.equal(config().tokens[api.url], "clv_acct_kept"); // nor logged out
    await assert.rejects(noToken(dir, api, "auth", "--token=x"), (e: ExecError) => /usage: cresslet auth/.test(e.stderr));
    await noToken(dir, api, "auth", "login", "--token=clv_acct_pasted");
    const before = api.calls.length;
    await assert.rejects(noToken(dir, api, "auth", "login", "--token="), (e: ExecError) => /usage: cresslet auth login --token/.test(e.stderr));
    assert.equal(api.calls.length, before); // nothing sent, saved token kept
    assert.equal(config().tokens[api.url], "clv_acct_pasted");
  } finally {
    await api.close();
  }
});

test("config: default server is cresslet.dev; set/get/unset api; --api and CRESSLET_API win", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-cfg-"));
  const { CRESSLET_TOKEN: _t, CRESSLET_API: _a, ...env } = process.env;
  const cli = (args: string[], extra: Record<string, string> = {}) => run(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...env, CRESSLET_CONFIG_DIR: path.join(dir, ".cfg-test"), NO_COLOR: "1", ...extra },
  });
  const account = { id: "acct_1", email: "o@x.dev", github: "octo" };
  const api = await fakeApi({ "GET /v1/me": () => ({ account }) });
  try {
    assert.equal((await cli(["config", "get", "api"])).stdout.trim(), "https://cresslet.dev");
    assert.deepEqual(JSON.parse((await cli(["config", "--json"])).stdout).api, { value: "https://cresslet.dev", from: "default" });

    const set = await cli(["config", "set", "api", api.url + "/"]);
    assert.match(set.stdout, /api set to http:\/\/127\.0\.0\.1:\d+\n/);
    assert.match(set.stdout, /not logged in there yet/);
    assert.deepEqual(JSON.parse((await cli(["config", "get", "api", "--json"])).stdout), { key: "api", value: api.url, from: "config" });

    // commands now use it without --api
    await cli(["login", "--token=clv_acct_cfg"]);
    assert.match((await cli(["whoami"])).stdout, new RegExp(`octo \\(o@x\\.dev\\) \\(${api.url.replace(/\./g, "\\.")}\\)`));

    assert.equal((await cli(["config", "get", "api", "--api", "http://flag.test"])).stdout.trim(), "http://flag.test");
    assert.match((await cli(["config", "get", "api", "--json"], { CRESSLET_API: "http://env.test" })).stdout, /"from": "CRESSLET_API"/);
    assert.match((await cli(["config", "set", "api", "http://x.test"], { CRESSLET_API: "http://env.test" })).stdout, /CRESSLET_API overrides it here/);

    await assert.rejects(cli(["config", "set", "api", "nope"]), (e: ExecError) => /not a URL: nope/.test(e.stderr));
    await assert.rejects(cli(["config", "set", "api", "ftp://x"]), (e: ExecError) => /not an http\(s\) URL/.test(e.stderr));
    await assert.rejects(cli(["config", "set", "colour", "red"]), (e: ExecError) => /unknown config key: colour/.test(e.stderr));
    await assert.rejects(cli(["config", "frob"]), (e: ExecError) => /unknown config command: frob/.test(e.stderr));

    assert.match((await cli(["config", "unset", "api"])).stdout, /api reset to https:\/\/cresslet\.dev/);
    assert.equal((await cli(["config", "get", "api"])).stdout.trim(), "https://cresslet.dev");
  } finally {
    await api.close();
  }
});

test("new against a non-default server records it in the project, so deploy goes there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-new-"));
  const { CRESSLET_TOKEN: _t, CRESSLET_API: _a, ...env } = process.env;
  const cli = (cwd: string, args: string[]) => run(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...env, CRESSLET_CONFIG_DIR: path.join(dir, ".cfg-test"), NO_COLOR: "1" },
  });
  const api = await fakeApi({
    "GET /v1/templates/vanilla": () => ({ files: [{ path: "cresslet.json", data: "{}" }, { path: "index.html", data: "<h1>hi</h1>" }] }),
  });
  try {
    await cli(dir, ["new", "my-app", "--template", "vanilla", "--api", api.url]);
    const app = path.join(dir, "my-app");
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, ".cresslet", "app.json"), "utf8")).api, api.url);
    assert.deepEqual(JSON.parse((await cli(app, ["config", "get", "api", "--json"])).stdout), { key: "api", value: api.url, from: ".cresslet/app.json" });
  } finally {
    await api.close();
  }
});

/** Routes for inspect / logs / db / secrets / rollback / delete / open of `name`, under its encoded path. */
function appRoutes(name: string): Record<string, Route> {
  const p = `/v1/apps/${encodeURIComponent(name)}`;
  const app = { name, url: "ftp://not-opened", claimed: true, config: {}, currentDeployId: "dep_1" };
  return {
    [`GET ${p}`]: () => ({ app, runtime: {}, secrets: [], deploys: [] }),
    [`GET ${p}/logs`]: () => ({}),
    [`GET ${p}/db`]: () => ({ tables: {} }),
    [`GET ${p}/secrets`]: () => ({ keys: [] }),
    [`POST ${p}/rollback`]: () => ({ app }),
    [`DELETE ${p}`]: () => ({ ok: true }),
  };
}
const APP_CMDS = [["inspect"], ["logs"], ["db"], ["secrets"], ["rollback", "dep_1"], ["delete", "--yes"], ["open"]];

test("app commands --app work outside a project", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-noproj-"));
  const api = await fakeApi(appRoutes("x"));
  try {
    for (const [cmd, ...rest] of APP_CMDS) {
      await cli(cwd, api, cmd, ...rest, "--app", "x");
      assert.equal(api.calls.at(-1).path.split("?")[0].replace(/\/(logs|db|secrets|rollback)$/, ""), "/v1/apps/x", cmd);
    }
  } finally {
    await api.close();
  }
});

test("app commands: the project's deploy key only for its own app + API", async () => {
  const dir = copyFixture();
  const api = await fakeApi({ ...appRoutes("a"), ...appRoutes("x") });
  const setLink = () => {
    fs.mkdirSync(path.join(dir, ".cresslet"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cresslet", "app.json"), JSON.stringify({ name: "a", api: api.url, deployKey: "key_a" }));
  };
  const key = () => api.calls.at(-1).headers["x-cresslet-deploy-key"];
  try {
    for (const [cmd, ...rest] of APP_CMDS) {
      setLink();
      await cli(dir, api, cmd, ...rest);
      assert.equal(key(), "key_a", cmd);
      setLink();
      await cli(dir, api, cmd, ...rest, "--app", "x");
      assert.equal(key(), undefined, `${cmd} --app x`);
      if (cmd === "inspect" || cmd === "logs") {
        await cli(dir, api, cmd, "x");
        assert.equal(key(), undefined, `${cmd} x`);
      }
      await cli(dir, api.url.replace("127.0.0.1", "localhost"), cmd, ...rest);
      assert.equal(key(), undefined, `${cmd} other api`);
    }
  } finally {
    await api.close();
  }
});

test("delete unlinks the project only when the deleted app (and server) is the linked one", async () => {
  const dir = copyFixture();
  const api = await fakeApi({ ...appRoutes("a"), ...appRoutes("x") });
  const linkFile = path.join(dir, ".cresslet", "app.json");
  fs.mkdirSync(path.dirname(linkFile), { recursive: true });
  fs.writeFileSync(linkFile, JSON.stringify({ name: "a", api: api.url, deployKey: "key_a" }));
  try {
    await cli(dir, api, "delete", "--yes", "--app", "x");
    assert.ok(fs.existsSync(linkFile), "--app other kept the link");
    await cli(dir, api.url.replace("127.0.0.1", "localhost"), "delete", "--yes");
    assert.ok(fs.existsSync(linkFile), "other server kept the link");
    await cli(dir, api, "delete", "--yes");
    assert.ok(!fs.existsSync(linkFile), "deleting the linked app unlinks");
  } finally {
    await api.close();
  }
});

test("app names are URL-encoded in app command paths", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-noproj-"));
  const name = "a b/c";
  const api = await fakeApi(appRoutes(name));
  try {
    for (const [cmd, ...rest] of APP_CMDS) {
      await cli(cwd, api, cmd, ...rest, "--app", name);
      assert.ok(api.calls.at(-1).path.startsWith("/v1/apps/a%20b%2Fc"), `${cmd}: ${api.calls.at(-1).path}`);
    }
  } finally {
    await api.close();
  }
});

const ENV_SERVER = `export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let frozen = Object.isFrozen(env.secrets);
    try { env.secrets.X = "mutated"; } catch { /* strict mode: frozen */ }
    return Response.json({ path: url.pathname, secrets: env.secrets, frozen, appUrl: env.app.url });
  },
  async scheduled(event) { globalThis.lastCron = event.cron; },
};
`;

const until = async (check: () => unknown, what: string) => {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("dev: --port 0 gives env.app.url the bound port", async () => {
  const d = await devWith(ENV_SERVER);
  try {
    assert.doesNotMatch(d.url, /:0$/);
    assert.equal(((await (await fetch(d.url + "/api/x")).json()) as { appUrl: string }).appUrl, d.url);
  } finally {
    await d.close();
  }
});

test("dev: editing .env.cresslet updates env.secrets live, still frozen", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "server", "index.ts"), ENV_SERVER);
  fs.writeFileSync(path.join(dir, ".env.cresslet"), "TOKEN=one\n");
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    const get = async () => (await (await fetch(d.url + "/api/x")).json()) as { secrets: Record<string, string>; frozen: boolean };
    assert.deepEqual(await get(), { path: "/api/x", secrets: { TOKEN: "one" }, frozen: true, appUrl: d.url });
    fs.writeFileSync(path.join(dir, ".env.cresslet"), "TOKEN=two\nOTHER=3\n");
    await until(async () => (await get()).secrets.TOKEN === "two", "TOKEN=two");
    const body = await get();
    assert.deepEqual(body.secrets, { TOKEN: "two", OTHER: "3" });
    assert.equal(body.frozen, true);
  } finally {
    await d.close();
  }
});

test("dev: editing cresslet.json updates routes and crons live; invalid JSON keeps the previous ones", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "server", "index.ts"), ENV_SERVER);
  const cfg = (c: object) => fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify(c));
  cfg({ name: "", routes: ["/api/*"], crons: ["0 * * * *"] });
  const logs: string[] = [];
  const d = await dev(loadProject(dir), { port: 0, log: (m) => logs.push(m) });
  const isApi = async (p: string) => (await fetch(d.url + p)).headers.get("content-type")?.includes("application/json");
  const cron = async () => {
    const r = await fetch(d.url + "/__cresslet/scheduled", { method: "POST", headers: { "x-cresslet-dev": "1" } });
    assert.equal(r.status, 204);
  };
  try {
    assert.equal(await isApi("/hooks/a"), false);
    cfg({ name: "", routes: ["/api/*", "/hooks/*"], crons: ["*/5 * * * *"] });
    await until(() => isApi("/hooks/a"), "/hooks/* routed");
    // the scheduled() export runs in this process (dev imports the bundle), so its global is visible here
    await cron();
    assert.equal(globals.lastCron, "*/5 * * * *");

    fs.writeFileSync(path.join(dir, "cresslet.json"), '{"routes": ["/api/*"'); // a save caught half-written
    await until(() => logs.some((l) => /cresslet\.json/.test(l)), "invalid JSON logged");
    assert.equal(await isApi("/hooks/a"), true, "previous routes kept");
    await cron();
    assert.equal(globals.lastCron, "*/5 * * * *", "previous crons kept");

    cfg({ name: "", routes: ["/api/*"] });
    await until(async () => !(await isApi("/hooks/a")), "/hooks/* unrouted");
    assert.equal((await fetch(d.url + "/__cresslet/scheduled", { method: "POST", headers: { "x-cresslet-dev": "1" } })).status, 400);
  } finally {
    await d.close();
    delete globals.lastCron;
  }
});

const gitIn = (dir: string, ...args: string[]) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });

test("deploy records the git commit it was built from (a clean checkout only)", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  await gitIn(dir, "init", "-q", "-b", "main");
  await gitIn(dir, "remote", "add", "origin", "git@github.com:octo/shop.git");
  await gitIn(dir, "add", "-A");
  await gitIn(dir, "commit", "-qm", "init");
  const sha = (await gitIn(dir, "rev-parse", "HEAD")).stdout.trim();
  const api = await fakeApi({ "POST /v1/deploys": DEPLOYED });
  try {
    await cli(dir, api, "deploy");
    assert.deepEqual(api.calls.at(-1).body.git, { sha, branch: "main", repo: "octo/shop" });
    fs.writeFileSync(path.join(dir, "index.html"), "changed");
    const r = await cli(dir, api, "deploy");
    assert.equal(api.calls.at(-1).body.git, undefined);
    assert.match(r.stderr, /uncommitted changes/);
    // Not a git checkout: nothing sent.
    const plain = copyFixture();
    fs.writeFileSync(path.join(plain, "cresslet.json"), JSON.stringify({ name: "a" }));
    await cli(plain, api, "deploy");
    assert.equal(api.calls.at(-1).body.git, undefined);
  } finally {
    await api.close();
  }
});

test("git status / connect / sync talk to the app's repository endpoints; sync only on top of GitHub's head", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  await gitIn(dir, "init", "-q", "-b", "main");
  await gitIn(dir, "add", "-A");
  await gitIn(dir, "commit", "-qm", "init");
  const sha = (await gitIn(dir, "rev-parse", "HEAD")).stdout.trim();
  const status = () => ({
    repo: { fullName: "octo/shop", url: "https://github.com/octo/shop", defaultBranch: "main", subdir: "" },
    defaultBranch: "main", mainSha: sha, branches: [{ name: "main", sha, protected: false }],
  });
  const api = await fakeApi({
    "GET /v1/apps/a/git/status": status,
    "POST /v1/apps/a/git/connect": (b) => ({ $status: 201, repo: { fullName: `${b.owner}/${b.repo}`, url: "u" }, sha }),
    "POST /v1/apps/a/git/sync": () => ({ branch: "main", sha: "f".repeat(40), changed: true }),
  });
  try {
    assert.match((await cli(dir, api, "git", "status")).stdout, /octo\/shop[\s\S]*● main/);
    await cli(dir, api, "git", "connect", "https://github.com/octo/shop.git", "--push");
    const connect = api.calls.find((c) => c.path === "/v1/apps/a/git/connect").body;
    assert.equal(connect.owner, "octo");
    assert.equal(connect.initialSync, "push");
    assert.ok(connect.files.some((f: WireFile) => f.path === "cresslet.json"));
    const s = await cli(dir, api, "git", "sync", "-m", "from the CLI");
    assert.match(s.stdout, /committed to main: fffffff/);
    const sync = api.calls.find((c) => c.path === "/v1/apps/a/git/sync").body;
    assert.deepEqual([sync.branch, sync.baseSha, sync.message], ["main", sha, "from the CLI"]);
    // This checkout is behind GitHub: refused, nothing sent.
    await gitIn(dir, "commit", "-qm", "local", "--allow-empty");
    const err = await cli(dir, api, "git", "sync").catch((e: ExecError) => e);
    assert.match((err as ExecError).stderr, /git pull first/);
    assert.equal(api.calls.filter((c) => c.path.endsWith("/git/sync")).length, 1);
  } finally {
    await api.close();
  }
});

test("git sync / connect --push: only what git would commit, never an empty or partial snapshot, only for the app's folder", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "credentials.json\n");
  fs.writeFileSync(path.join(dir, "nested", "credentials.json"), "{\"secret\":1}");
  fs.writeFileSync(path.join(dir, "nested", "ok.txt"), "ok");
  // Git's rules, not a simplified reading: a negation re-includes a file.
  fs.appendFileSync(path.join(dir, ".gitignore"), "\n*.keep\n!wanted.keep\n");
  fs.writeFileSync(path.join(dir, "wanted.keep"), "w");
  fs.writeFileSync(path.join(dir, "other.keep"), "o");
  await gitIn(dir, "init", "-q", "-b", "main");
  await gitIn(dir, "add", "-A");
  await gitIn(dir, "commit", "-qm", "init");
  const sha = (await gitIn(dir, "rev-parse", "HEAD")).stdout.trim();
  let subdir = "";
  const api = await fakeApi({
    "GET /v1/apps/a/git/status": () => ({ repo: { fullName: "octo/shop", url: "u", defaultBranch: "main", subdir }, defaultBranch: "main", mainSha: sha, branches: [{ name: "main", sha, protected: false }] }),
    "POST /v1/apps/a/git/connect": () => ({ $status: 201, repo: { fullName: "octo/shop", url: "u" }, sha }),
    "POST /v1/apps/a/git/sync": () => ({ branch: "main", sha, changed: false }),
  });
  try {
    await cli(dir, api, "git", "connect", "octo/shop.git", "--push");
    const connect = api.calls.find((c) => c.path.endsWith("/git/connect")).body;
    assert.equal(connect.repo, "shop");
    const paths = connect.files.map((f: WireFile) => f.path);
    assert.ok(paths.includes("nested/ok.txt"));
    assert.ok(!paths.includes("nested/credentials.json"), "git-ignored file pushed");
    assert.ok(paths.includes("wanted.keep") && !paths.includes("other.keep"));
    // The app lives elsewhere in the repository: refused.
    subdir = "apps/shop";
    const wrong = await cli(dir, api, "git", "sync").catch((e: ExecError) => e);
    assert.match((wrong as ExecError).stderr, /lives in apps\/shop/);
    subdir = "";
    // Over the limits: refused, nothing sent (never an empty snapshot).
    const over = await cliEnv({ CRESSLET_MAX_DEPLOY_FILES: "1" })(dir, api, "git", "sync").catch((e: ExecError) => e);
    assert.match((over as ExecError).stderr, /more than the 1/);
    assert.equal(api.calls.filter((c) => c.path.endsWith("/git/sync")).length, 0);
    // An ignored folder that can't be read isn't walked.
    fs.appendFileSync(path.join(dir, ".gitignore"), "\npgdata/\n");
    fs.mkdirSync(path.join(dir, "pgdata"));
    fs.chmodSync(path.join(dir, "pgdata"), 0o000);
    try {
      assert.equal((await cli(dir, api, "git", "connect", "octo/shop", "--push")).stderr.includes("EACCES"), false);
    } finally {
      fs.chmodSync(path.join(dir, "pgdata"), 0o755);
    }
    // Committed build output would be deleted: refused.
    fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a", build: { command: "true", static: "out" } }));
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "index.html"), "built");
    await gitIn(dir, "add", "-A");
    const built = await cli(dir, api, "git", "connect", "octo/shop", "--push").catch((e: ExecError) => e);
    assert.match((built as ExecError).stderr, /out\/ \(build output\) is committed/);
  } finally {
    await api.close();
  }
});

test("logout: revokes the login's remembered agents (and a browser-login token); an imported token stays; CRESSLET_TOKEN untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-cli-"));
  const cfgDir = path.join(dir, ".cfg-test");
  const { CRESSLET_TOKEN: _, ...env } = process.env;
  const cmd = (extra: Record<string, string>, ...args: string[]) => run(process.execPath, [CLI, ...args, "--api", api.url], {
    cwd: dir, env: { ...env, CRESSLET_CONFIG_DIR: cfgDir, NO_COLOR: "1", ...extra },
  });
  const account = { id: "acct_1", email: "o@x.dev", github: null };
  let polls = 0;
  const api = await fakeApi({
    "GET /v1": () => ({ auth: { cli: true } }),
    "POST /v1/auth/cli": () => ({ deviceCode: "dc", userCode: "BCDF-GHJK", verificationUri: "http://studio.test/cli", expiresIn: 60, interval: 0.01 }),
    "POST /v1/auth/cli/token": () => (++polls % 2 ? { status: "pending" } : { status: "complete", account, token: "clv_acct_minted" }),
    "GET /v1/me": () => ({ account }),
    "POST /v1/me/agents/revoke": () => ({ revoked: ["agt_1"] }),
    "POST /v1/me/token/revoke": () => ({ revoked: "tok_1" }),
  });
  const remembered = (token: string) => {
    const store = agentStore({ dir: cfgDir, api: api.url, token });
    store.save({ id: "agt_1", secret: "s".repeat(43), label: "Claude Code" });
    return store;
  };
  try {
    // Browser login: logout revokes its agents and the token, with that token.
    await cmd({}, "login", "--no-browser");
    let store = remembered("clv_acct_minted");
    const out1 = await cmd({ CRESSLET_TOKEN: "clv_acct_env" }, "logout");
    assert.match(out1.stdout, /token revoked/);
    assert.match(out1.stdout, /CRESSLET_TOKEN is set: logout doesn't touch it/);
    const posts = api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/me/"));
    assert.deepEqual(posts.map((c) => [c.path, c.headers.authorization]), [
      ["/v1/me/agents/revoke", "Bearer clv_acct_minted"],
      ["/v1/me/token/revoke", "Bearer clv_acct_minted"],
    ]);
    assert.deepEqual(store.list(), []);

    // An imported token: its agents go, the token stays valid.
    await cmd({}, "login", "--token=clv_acct_pasted");
    store = remembered("clv_acct_pasted");
    const n = api.calls.length;
    const out2 = await cmd({}, "logout");
    assert.doesNotMatch(out2.stdout, /token revoked/);
    assert.deepEqual(api.calls.slice(n).map((c) => c.path), ["/v1/me/agents/revoke"]);
    assert.deepEqual(store.list(), []);
  } finally {
    await api.close();
  }
});

test("environments: deploy --env staging (its own route, never /v1/deploys), promote, rollback/logs/secrets/db --env, env seed/rm", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a", routes: ["/api/*"] }));
  const p = "/v1/apps/a";
  let staging: string | null = "dep_s1";
  const envs = () => ({ environments: [
    { name: "production", url: "http://a.test", private: false, currentDeployId: "dep_p1" },
    { name: "staging", url: "http://a--staging.test", private: true, currentDeployId: staging },
  ] });
  const api = await fakeApi({
    [`POST ${p}/envs/staging/deploys`]: () => ({ $status: 201, app: { name: "a", url: "http://a.test" }, environment: { name: "staging", url: "http://a--staging.test" }, deploy: { id: "dep_s1" } }),
    [`GET ${p}/envs`]: envs,
    [`POST ${p}/promote`]: (b) => ({ app: { url: "http://a.test", currentDeployId: b.deployId }, deploy: { id: b.deployId, tag: "v3" }, promoted: true }),
    [`POST ${p}/rollback`]: (b) => ({ app: { currentDeployId: "dep_p1" }, environment: { currentDeployId: b.env ? "dep_s0" : null } }),
    [`GET ${p}/logs`]: () => ({}),
    [`GET ${p}/secrets`]: () => ({ keys: ["B"], env: "staging", secrets: [{ key: "A", source: "production" }, { key: "B", source: "staging" }] }),
    [`PUT ${p}/secrets`]: () => ({ keys: ["B"] }),
    [`POST ${p}/db/query`]: () => ({ rows: [] }),
    [`POST ${p}/envs/staging/seed`]: () => ({ seeded: "staging", from: "production", bytes: 2048 }),
    [`DELETE ${p}/envs/staging`]: () => ({ deleted: "staging" }),
  });
  try {
    const d = await cli(dir, api, "deploy", "--env", "staging");
    const call = api.calls.find((c: Wire) => c.method === "POST" && c.path.includes("/deploys"));
    assert.equal(call.path, `${p}/envs/staging/deploys`);
    assert.equal(call.body.app, undefined);
    assert.ok(call.body.files.length && call.body.source === "cli");
    assert.ok(!api.calls.some((c: Wire) => c.path === "/v1/deploys"));
    assert.match(d.stdout, /deployed a to staging/);
    assert.match(d.stdout, /a--staging\.test/);
    // An artifact has no environments.
    fs.writeFileSync(path.join(dir, "x.html"), "<p>x</p>");
    await assert.rejects(cli(dir, api, "deploy", "x.html", "--env", "staging"), (e: ExecError) => /--env is for apps/.test(e.stderr));

    // Promote sends the deploy staging serves (the server refuses a stale one).
    const pr = await cli(dir, api, "promote", "-y");
    assert.deepEqual(api.calls.at(-1).body, { from: "staging", deployId: "dep_s1", expectProduction: "dep_p1" });
    assert.match(pr.stdout, /promoted dep_s1 from staging to production as v3/);
    staging = null;
    await assert.rejects(cli(dir, api, "promote", "-y"), (e: ExecError) => /nothing is deployed to a's staging/.test(e.stderr));

    await cli(dir, api, "rollback", "--env", "staging");
    assert.deepEqual(api.calls.at(-1).body, { env: "staging" });
    await cli(dir, api, "logs", "--env", "staging");
    assert.equal(api.calls.at(-1).path, `${p}/logs?n=100&env=staging`);
    const s = await cli(dir, api, "secrets", "--env", "staging");
    assert.equal(api.calls.at(-1).path, `${p}/secrets?env=staging`);
    assert.match(s.stdout, /A \(from production\)\nB/);
    await cli(dir, api, "secrets", "set", "B=2", "--env", "staging");
    assert.equal(api.calls.at(-1).path, `${p}/secrets?env=staging`);
    await cli(dir, api, "db", "select 1", "--env", "staging");
    assert.equal(api.calls.at(-1).path, `${p}/db/query?env=staging`);
    const seeded = await cli(dir, api, "env", "seed", "staging");
    assert.deepEqual(api.calls.at(-1).body, { from: "production" });
    assert.match(seeded.stdout, /snapshot of production's/);
    await cli(dir, api, "env", "rm", "staging", "-y");
    assert.equal(api.calls.at(-1).method, "DELETE");
    // `--env=` isn't production, and a command without environments refuses --env (delete would take the whole app).
    for (const args of [["deploy", "--env="], ["secrets", "set", "A=1", "--env="], ["rollback", "--env="]]) {
      await assert.rejects(cli(dir, api, ...args), (e: ExecError) => /--env needs an environment/.test(e.stderr), args.join(" "));
    }
    await assert.rejects(cli(dir, api, "delete", "-y", "--env", "staging"), (e: ExecError) => /--env isn't an option of delete/.test(e.stderr));
    assert.ok(!api.calls.some((c: Wire) => c.method === "DELETE" && c.path === p));
    const ls = await cli(dir, api, "env");
    assert.match(ls.stdout, /production +http:\/\/a\.test +dep_p1/);
  } finally {
    await api.close();
  }
});

test("environments: a server without them refuses every --env command; nothing reaches production", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  const p = "/v1/apps/a";
  // An older server: no environments routes ("no such endpoint"), and its other routes ignore `env`.
  const old = () => ({ $status: 404, error: "not_found", message: "no such endpoint" });
  const api = await fakeApi({
    "POST /v1/deploys": () => ({ $status: 201 }),
    [`GET ${p}/envs`]: old,
    [`PUT ${p}/secrets`]: () => ({ keys: [] }),
    [`POST ${p}/rollback`]: () => ({ app: { currentDeployId: "dep_0" } }),
    [`GET ${p}/logs`]: () => ({}),
    [`GET ${p}/db`]: () => ({ tables: {} }),
  });
  try {
    await assert.rejects(cli(dir, api, "deploy", "--env", "staging"), (e: ExecError) => e.code === 1);
    for (const args of [["secrets", "set", "A=1"], ["secrets", "unset", "A"], ["rollback"], ["logs"], ["db"]]) {
      await assert.rejects(cli(dir, api, ...args, "--env", "staging"), (e: ExecError) => /doesn't have environments/.test(e.stderr), args.join(" "));
    }
    await assert.rejects(cli(dir, api, "promote", "-y"), (e: ExecError) => /doesn't have environments/.test(e.stderr));
    assert.ok(!api.calls.some((c: Wire) => c.path === "/v1/deploys" || c.method === "PUT" || c.path.includes("/rollback") || c.path.includes("/logs") || c.path.includes("/db")),
      JSON.stringify(api.calls.map((c: Wire) => `${c.method} ${c.path}`)));
  } finally {
    await api.close();
  }
});
