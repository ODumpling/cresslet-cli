// `cresslet connect`, Live Link v2 (lib/connect.ts, lib/agents.ts): Remember this agent saves a credential and
// reconnects with it, a restarted harness gets its folder's project back under announce/confirm, unsent calls survive
// a drop while a dispatched one is never replayed, epochs fence calls queued before a Disconnect, project tools, the
// bounded queue, and logout stopping the bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { agentStore } from "../lib/agents.ts";
import { ALL_TOOLS, backoffDelay, runConnectServer } from "../lib/connect.ts";

type Msg = Record<string, unknown>;

async function fakeRelay() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/v1/workspace/relay" });
  const hellos: Msg[] = [];
  const frames: Msg[] = [];
  let current: WebSocket | null = null;
  let onHello: (ws: WebSocket, m: Msg) => void = () => {};
  let onFrame: (ws: WebSocket, m: Msg) => void = () => {};
  wss.on("connection", (ws) => {
    current = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString("utf8")) as Msg;
      if (m.type === "hello") {
        hellos.push(m);
        onHello(ws, m);
      } else {
        frames.push(m);
        onFrame(ws, m);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/v1/workspace/relay`,
    hellos, frames,
    get ws() {
      return current!;
    },
    send: (m: Msg) => current!.send(JSON.stringify({ v: 1, ...m })),
    set onHello(fn: (ws: WebSocket, m: Msg) => void) {
      onHello = fn;
    },
    set onFrame(fn: (ws: WebSocket, m: Msg) => void) {
      onFrame = fn;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A harness session: stdio MCP into runConnectServer. */
function harness(url: string, store: ReturnType<typeof agentStore>, cwd: string, extra: Partial<Parameters<typeof runConnectServer>[0]> = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const replies = new Map<unknown, Msg>();
  let wake: (() => void)[] = [];
  let buf = "";
  output.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, nl)) as Msg;
      buf = buf.slice(nl + 1);
      replies.set(m.id, m);
      for (const w of wake.splice(0)) w();
    }
  });
  const logs: string[] = [];
  const done = runConnectServer({
    wsUrl: url, token: "clv_acct_t", version: "test", store, cwd, input, output, log: (l) => logs.push(l),
    minDelayMs: 20, maxDelayMs: 60, random: () => 0, reconnectWaitMs: 1500, ...extra,
  });
  let id = 0;
  const reply = async (rid: number, ms = 3000) => {
    const end = Date.now() + ms;
    while (!replies.has(rid)) {
      if (Date.now() > end) throw new Error(`no reply ${rid}; logs ${logs.join(" | ")}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 50);
        wake.push(() => (clearTimeout(t), r()));
      });
    }
    return replies.get(rid)!;
  };
  const call = (name: string, args: Msg = {}) => {
    const rid = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return rid;
  };
  const text = async (rid: number) => {
    const r = (await reply(rid)).result as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, error: !!r.isError };
  };
  return {
    logs, call, reply, text,
    raw: (m: Msg) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"),
    async end() {
      input.end();
      await done;
    },
  };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition never met");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-v2-"));

test("backoff: 1 s doubling to 30 s, jittered", () => {
  assert.equal(backoffDelay(0, () => 1), 1000);
  assert.equal(backoffDelay(0, () => 0), 500);
  assert.equal(backoffDelay(20, () => 1), 30_000);
});

test("Remember this agent: credential saved (0600, atomic), reconnects with it, no announce for the project just approved", async () => {
  const relay = await fakeRelay();
  const dir = tmp(), cwd = tmp();
  const store = agentStore({ dir, api: "http://x", token: "clv_acct_t" });
  relay.onHello = (ws, m) => {
    if (m.role === "cli") ws.send(JSON.stringify({ type: "code", code: "BCDF-GHJK", expiresIn: 300 }));
    if (m.role === "agent") {
      ws.send(JSON.stringify({ type: "ready", credentials: ["agt_1"], revoked: [], projects: [{ handle: "inst:p1", name: "Demo", credentialId: "agt_1" }] }));
      if (m.bind) ws.send(JSON.stringify({ type: "bound", handle: m.bind, epoch: 1, projectName: "Demo", credentialId: "agt_1" }));
    }
  };
  relay.onFrame = (ws, m) => {
    if (m.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: m.id, text: `ran ${m.name} in ${m.handle}` }));
  };
  const h = harness(relay.url, store, cwd);
  try {
    h.raw({ id: 100, method: "tools/list" });
    assert.deepEqual(((await h.reply(100)).result as { tools: { name: string }[] }).tools.map((t) => t.name), ALL_TOOLS.map((t) => t.name));
    const first = await h.text(h.call("read_file", { path: "a" }));
    assert.match(first.text, /BCDF-GHJK/);
    const cliHello = relay.hellos[0]!;
    const enroll = cliHello.enroll as { secretHash: string };
    assert.match(enroll.secretHash, /^[0-9a-f]{64}$/);
    // The user ticks Remember and clicks Allow.
    relay.send({ type: "enrolled", credentialId: "agt_1", handle: "inst:p1", projectName: "Demo" });
    relay.ws.close(1000, "enrolled");
    await until(() => relay.hellos.some((x) => x.role === "agent"));
    const agentHello = relay.hellos.find((x) => x.role === "agent")!;
    const creds = agentHello.credentials as { id: string; secret: string }[];
    assert.equal(creds[0]!.id, "agt_1");
    assert.equal(createHash("sha256").update(creds[0]!.secret).digest("hex"), enroll.secretHash);
    assert.equal(agentHello.bind, "inst:p1");
    const file = path.join(dir, "agents", "agt_1.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(dir, "agents")), ["agt_1.json"]); // no temp files left
    assert.equal(store.pin(cwd)?.handle, "inst:p1");
    const ok = await h.text(h.call("read_file", { path: "a" }));
    assert.deepEqual(ok, { text: "ran read_file in inst:p1", error: false });
  } finally {
    await h.end();
    await relay.close();
  }
});

test("harness restart: the folder's project comes back, announced; nothing runs (parallel calls too) until confirm_project", async () => {
  const relay = await fakeRelay();
  const dir = tmp(), cwd = tmp();
  const store = agentStore({ dir, api: "http://x", token: "clv_acct_t" });
  store.save({ id: "agt_1", secret: "s".repeat(43), label: "Claude Code" });
  store.setPin(cwd, { handle: "inst:p1", credentialId: "agt_1", projectName: "Demo" });
  relay.onHello = (ws, m) => {
    ws.send(JSON.stringify({ type: "ready", credentials: ["agt_1"], revoked: [], projects: [{ handle: "inst:p1", name: "Demo", credentialId: "agt_1" }, { handle: "inst:p2", name: "Other", credentialId: "agt_1" }] }));
    if (m.bind) ws.send(JSON.stringify({ type: "bound", handle: m.bind, epoch: 3, projectName: "Demo", credentialId: "agt_1" }));
  };
  relay.onFrame = (ws, m) => {
    if (m.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: m.id, text: "ran" }));
  };
  const h = harness(relay.url, store, cwd);
  try {
    const [a, b] = [h.call("write_file", { path: "x", content: "1" }), h.call("read_file", { path: "x" })];
    const ra = await h.text(a), rb = await h.text(b);
    assert.match(ra.text, /Connected to project "Demo"\. If that's the project the user meant, call confirm_project\("([0-9a-f]+)"\)/);
    assert.equal(rb.text, ra.text);
    assert.equal(relay.frames.filter((f) => f.type === "tool_call").length, 0);
    const ack = /confirm_project\("([0-9a-f]+)"\)/.exec(ra.text)![1];
    assert.equal((await h.text(h.call("confirm_project", { ack: "nope" }))).error, true);
    assert.match((await h.text(h.call("confirm_project", { ack }))).text, /Confirmed/);
    assert.deepEqual(await h.text(h.call("read_file", { path: "x" })), { text: "ran", error: false });
    const sent = relay.frames.find((f) => f.type === "tool_call")!;
    assert.equal(sent.handle, "inst:p1");
    assert.equal(sent.epoch, 3);
  } finally {
    await h.end();
    await relay.close();
  }
});

test("drops: a dispatched call is reported unknown (never replayed); unsent calls go after reconnect; older epochs fail; busy past the queue", async () => {
  const relay = await fakeRelay();
  const dir = tmp(), cwd = tmp();
  const store = agentStore({ dir, api: "http://x", token: "clv_acct_t" });
  store.save({ id: "agt_1", secret: "s".repeat(43), label: "Claude Code" });
  let epoch = 1, answer = true;
  relay.onHello = (ws, m) => {
    ws.send(JSON.stringify({ type: "ready", credentials: ["agt_1"], revoked: [], projects: [{ handle: "inst:p1", name: "Demo", credentialId: "agt_1" }] }));
    if (m.bind) ws.send(JSON.stringify({ type: "bound", handle: m.bind, epoch, projectName: "Demo", credentialId: "agt_1" }));
  };
  relay.onFrame = (ws, m) => {
    if (m.type === "bind") ws.send(JSON.stringify({ type: "bound", handle: m.handle, epoch, projectName: "Demo", credentialId: "agt_1" }));
    if (m.type === "tool_call" && answer) ws.send(JSON.stringify({ type: "tool_result", id: m.id, text: `ran ${m.name}` }));
  };
  const h = harness(relay.url, store, cwd, { maxQueued: 3 });
  try {
    // Only one approved project open: picked, announced, confirmed.
    const notice = await h.text(h.call("list_files"));
    const ack = /confirm_project\("([0-9a-f]+)"\)/.exec(notice.text)![1];
    await h.text(h.call("confirm_project", { ack }));

    // A write in flight when the socket drops: "outcome unknown", and not sent again after reconnect.
    answer = false;
    const w = h.call("write_file", { path: "x", content: "1" });
    await until(() => relay.frames.some((f) => f.type === "tool_call" && f.name === "write_file"));
    const queued = h.call("read_file", { path: "x" }); // waits behind it
    relay.ws.terminate();
    const lost = await h.text(w);
    assert.equal(lost.error, true);
    assert.match(lost.text, /Do not assume whether a write or commit completed/);
    answer = true;
    assert.deepEqual(await h.text(queued), { text: "ran read_file", error: false });
    assert.equal(relay.frames.filter((f) => f.type === "tool_call" && f.name === "write_file").length, 1);
    assert.ok(relay.hellos.length >= 2);

    // Calls queued before a Disconnect + Resume (epoch bumped) aren't run.
    answer = false;
    const slow = h.call("run_command", { command: "x" });
    await until(() => relay.frames.some((f) => f.type === "tool_call" && f.name === "run_command"));
    const before = h.call("write_file", { path: "y", content: "2" });
    await new Promise((r) => setTimeout(r, 30));
    // (the relay's order: unbound, then the dispatched call's result)
    relay.send({ type: "unbound", handle: "inst:p1", reason: "paused", message: "Disconnected in Cresslet Studio." });
    relay.send({ type: "tool_result", id: relay.frames.findLast((f) => f.type === "tool_call")!.id, error: true, text: "Disconnected in Cresslet Studio." });
    assert.match((await h.text(slow)).text, /Disconnected/);
    assert.match((await h.text(before)).text, /not run/);
    epoch = 2;
    relay.send({ type: "bound", handle: "inst:p1", epoch: 2, projectName: "Demo", credentialId: "agt_1" });
    answer = true;
    assert.deepEqual(await h.text(h.call("read_file", { path: "z" })), { text: "ran read_file", error: false });
    assert.equal(relay.frames.filter((f) => f.type === "tool_call" && f.name === "write_file" && (f.arguments as Msg).path === "y").length, 0);

    // Bounded queue: past it, "busy" at once.
    answer = false;
    const ids = [h.call("read_file"), h.call("read_file"), h.call("read_file")];
    await until(() => relay.frames.filter((f) => f.type === "tool_call").length > 0);
    const over = await h.text(h.call("read_file"));
    assert.match(over.text, /Too many tool calls queued/);
    void ids;
  } finally {
    await h.end();
    await relay.close();
  }
});

test("project tools: list with hints, switch waits for the click, a closed pinned tab never redirects", async () => {
  const relay = await fakeRelay();
  const dir = tmp(), cwd = path.join(tmp(), "other");
  fs.mkdirSync(cwd);
  const store = agentStore({ dir, api: "http://x", token: "clv_acct_t" });
  store.save({ id: "agt_1", secret: "s".repeat(43), label: "Claude Code" });
  const projects = [{ handle: "inst:p1", name: "Demo", credentialId: "agt_1" }, { handle: "inst:p2", name: "Other", app: "other", credentialId: "agt_1" }];
  relay.onHello = (ws) => ws.send(JSON.stringify({ type: "ready", credentials: ["agt_1"], revoked: [], projects }));
  let p2Open = true;
  relay.onFrame = (ws, m) => {
    if (m.type === "list") ws.send(JSON.stringify({ type: "projects", projects }));
    if (m.type === "bind" && m.handle === "inst:p2" && !p2Open) {
      ws.send(JSON.stringify({ type: "bind_error", handle: m.handle, code: "not_open", message: "Project Other isn't open in Cresslet Studio (http://studio/p/p2)." }));
    } else if (m.type === "bind" && m.handle === "inst:p1" && !relay.frames.some((f) => f.type === "bind" && f.handle === "inst:p2")) {
      ws.send(JSON.stringify({ type: "bound", handle: "inst:p1", epoch: 1, projectName: "Demo", credentialId: "agt_1" }));
    } else if (m.type === "bind") ws.send(JSON.stringify({ type: "switch_pending", handle: m.handle, projectName: "Other", expiresIn: 300 }));
    if (m.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: m.id, text: `ran in ${m.handle}` }));
  };
  const h = harness(relay.url, store, cwd);
  try {
    // Several open: the list, no auto-pick.
    const listed = await h.text(h.call("read_file"));
    assert.match(listed.text, /inst:p1: Demo/);
    assert.match(listed.text, /inst:p2: Other \(app other\) \[matches this folder\]/);
    assert.match((await h.text(h.call("use_project", { handle: "inst:p1" }))).text, /Connected to project "Demo"/);
    assert.equal(store.pin(cwd)?.handle, "inst:p1");
    assert.equal((await h.text(h.call("read_file"))).text, "ran in inst:p1");
    // A switch: pending until the click; work continues on p1.
    const sw = await h.text(h.call("use_project", { handle: "inst:p2" }));
    assert.match(sw.text, /Waiting for the user to confirm in "Other"/);
    assert.equal((await h.text(h.call("read_file"))).text, "ran in inst:p1");
    // Clicked: bound to p2 (switched), pin saved.
    relay.send({ type: "unbound", handle: "inst:p1", reason: "switched", message: "Switched to project Other." });
    relay.send({ type: "bound", handle: "inst:p2", epoch: 1, projectName: "Other", credentialId: "agt_1", switched: true });
    await until(() => store.pin(cwd)?.handle === "inst:p2");
    assert.equal((await h.text(h.call("read_file"))).text, "ran in inst:p2");
    // The pinned tab closes: the call fails after the wait, never sent to p1.
    p2Open = false;
    relay.send({ type: "unbound", handle: "inst:p2", reason: "not_open", message: "Project Other isn't open in Cresslet Studio." });
    await new Promise((r) => setTimeout(r, 50));
    const sentBefore = relay.frames.filter((f) => f.type === "tool_call").length;
    const r = await h.text(h.call("write_file", { path: "a", content: "b" }));
    assert.equal(r.error, true);
    assert.match(r.text, /isn't open in Cresslet Studio/);
    assert.equal(relay.frames.filter((f) => f.type === "tool_call").length, sentBefore);
  } finally {
    await h.end();
    await relay.close();
  }
});

test("logout: a running bridge stops reconnecting once its login or credentials are gone", async () => {
  const relay = await fakeRelay();
  const dir = tmp(), cwd = tmp();
  const store = agentStore({ dir, api: "http://x", token: "clv_acct_t" });
  store.save({ id: "agt_1", secret: "s".repeat(43), label: "Claude Code" });
  let token: string | undefined = "clv_acct_t";
  relay.onHello = (ws) => ws.send(JSON.stringify({ type: "ready", credentials: ["agt_1"], revoked: [], projects: [] }));
  const h = harness(relay.url, store, cwd, { currentToken: () => token });
  try {
    await until(() => relay.hellos.length === 1);
    // cresslet logout: the token and the credential files go.
    token = undefined;
    store.removeAll();
    relay.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(relay.hellos.length, 1);
    assert.ok(h.logs.some((l) => /Logged out/.test(l)));
  } finally {
    await h.end();
    await relay.close();
  }
});
