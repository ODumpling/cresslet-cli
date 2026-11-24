import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { CONNECT_TOOLS, relayWsUrl, runConnectServer } from "../lib/connect.ts";

test("relayWsUrl converts http/https API bases to ws/wss relay URLs and refuses remote cleartext", () => {
  assert.equal(relayWsUrl("https://cresslet.dev"), "wss://cresslet.dev/v1/workspace/relay");
  assert.equal(relayWsUrl("http://localhost:8787/"), "ws://localhost:8787/v1/workspace/relay");
  assert.throws(() => relayWsUrl("http://remote.example.com"), /cleartext/i);
  assert.equal(relayWsUrl("http://remote.example.com", { allowInsecure: true }), "ws://remote.example.com/v1/workspace/relay");
  assert.throws(() => relayWsUrl("not-a-url"), /invalid API URL/i);
});

test("stdio MCP server handles initialize, tools/list, lazy pairing, tool calls, and cancellation", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/v1/workspace/relay" });
  const seen: Record<string, unknown>[] = [];
  let relaySocket: import("ws").WebSocket | null = null;

  wss.on("connection", (ws) => {
    relaySocket = ws;
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString("utf8")) as Record<string, unknown>;
      seen.push(msg);
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ v: 1, type: "code", code: "BCDF-GHJK", expiresIn: 300 }));
      } else if (msg.type === "tool_call" && msg.name === "read_file") {
        ws.send(JSON.stringify({ v: 1, type: "tool_result", id: msg.id, text: "hello from studio" }));
      } else if (msg.type === "tool_cancel") {
        ws.send(JSON.stringify({ v: 1, type: "tool_result", id: msg.id, text: "Cancelled.", error: true }));
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const replies: Record<string, unknown>[] = [];
  let waitReply: ((m: Record<string, unknown>) => void) | null = null;

  let outBuf = "";
  output.on("data", (c: Buffer) => {
    outBuf += c.toString("utf8");
    for (;;) {
      const nl = outBuf.indexOf("\n");
      if (nl < 0) break;
      const msg = JSON.parse(outBuf.slice(0, nl)) as Record<string, unknown>;
      outBuf = outBuf.slice(nl + 1);
      if (waitReply) {
        const fn = waitReply;
        waitReply = null;
        fn(msg);
      } else replies.push(msg);
    }
  });

  const nextReply = () => replies.length
    ? Promise.resolve(replies.shift()!)
    : new Promise<Record<string, unknown>>((r) => (waitReply = r));

  const send = (msg: Record<string, unknown>) => input.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  const done = runConnectServer({
    wsUrl: `ws://127.0.0.1:${port}/v1/workspace/relay`,
    token: "clv_acct_test",
    version: "0.3.0",
    eager: false,
    input,
    output,
    log: (line) => logs.push(line),
  });

  try {
    // 1. initialize succeeds immediately without opening WS yet.
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "claude-code", version: "1.0" } } });
    const init = await nextReply();
    assert.equal(init.id, 1);
    const initRes = init.result as { protocolVersion: string; instructions: string };
    assert.equal(initRes.protocolVersion, "2025-03-26");
    assert.match(initRes.instructions, /commit_change/);
    assert.equal(seen.length, 0); // lazy: no WS opened yet

    send({ method: "notifications/initialized" });

    // 2. tools/list returns all 8 tools.
    send({ id: 2, method: "tools/list" });
    const list = await nextReply();
    const listed = (list.result as { tools: typeof CONNECT_TOOLS }).tools;
    assert.deepEqual(listed.map((t) => t.name), CONNECT_TOOLS.map((t) => t.name));

    // 3. First tools/call while unpaired opens WS, prints code to stderr (not stdout), and returns code in isError.
    send({ id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "index.html" } } });
    const unpaired = await nextReply();
    const uRes = unpaired.result as { isError: boolean; content: { text: string }[] };
    assert.equal(uRes.isError, true);
    assert.match(uRes.content[0].text, /BCDF-GHJK/);
    assert.ok(logs.some((l) => l.includes("BCDF-GHJK")));
    assert.equal(seen[0]?.agent, "claude-code"); // picked up from initialize clientInfo

    // 4. Server completes pairing -> tools/call succeeds.
    relaySocket!.send(JSON.stringify({ v: 1, type: "paired", projectName: "demo" }));
    await new Promise((r) => setTimeout(r, 30));

    send({ id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "index.html" } } });
    const ok = await nextReply();
    const okRes = ok.result as { isError?: boolean; content: { text: string }[] };
    assert.equal(okRes.isError, undefined);
    assert.equal(okRes.content[0].text, "hello from studio");

    // 5. notifications/cancelled sends tool_cancel and suppresses the MCP reply (per MCP spec).
    send({ id: 5, method: "tools/call", params: { name: "run_command", arguments: { command: "sleep 60" } } });
    await new Promise((r) => setTimeout(r, 30));
    send({ method: "notifications/cancelled", params: { requestId: 5 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.some((m) => m.type === "tool_cancel"));
    // Next request still works cleanly and receives its own reply (not id 5's).
    send({ id: 6, method: "ping" });
    const pong = await nextReply();
    assert.equal(pong.id, 6);

    input.end();
    await done;
  } finally {
    wss.close();
    await new Promise((r) => server.close(r));
  }
});

test("connect ignores the workspace .cresslet/app.json API origin (CRESSLET_TOKEN set)", async () => {
  const { connectClient } = await import("../lib/connect.ts");
  const { client } = await import("../lib/api.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-connect-"));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-config-"));
  fs.mkdirSync(path.join(dir, ".cresslet"));
  fs.writeFileSync(path.join(dir, "cresslet.json"), "{}");
  fs.writeFileSync(path.join(dir, ".cresslet", "app.json"), JSON.stringify({ name: "x", api: "https://evil.example" }));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ api: "https://configured.example" }));
  const saved = { cwd: process.cwd(), token: process.env.CRESSLET_TOKEN, api: process.env.CRESSLET_API, dir: process.env.CRESSLET_CONFIG_DIR };
  try {
    process.chdir(dir);
    process.env.CRESSLET_TOKEN = "clv_acct_env";
    delete process.env.CRESSLET_API;
    process.env.CRESSLET_CONFIG_DIR = cfgDir;
    const c = connectClient({});
    assert.equal(c.base, "https://configured.example");
    assert.equal(c.token, "clv_acct_env");
    assert.equal(connectClient({ api: "https://flag.example" }).base, "https://flag.example");
    // Other commands still honour the project's link.
    const { findRoot, readLink } = await import("../lib/util.ts");
    assert.equal(client({ project: { link: readLink(findRoot()!) } }).base, "https://evil.example");
  } finally {
    process.chdir(saved.cwd);
    for (const [k, v] of [["CRESSLET_TOKEN", saved.token], ["CRESSLET_API", saved.api], ["CRESSLET_CONFIG_DIR", saved.dir]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
