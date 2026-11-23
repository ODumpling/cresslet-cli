// `cresslet connect`: stdio MCP server that bridges a desktop coding agent (Claude Code, Codex,
// T3 Code) to an open Cresslet Studio project tab over `/v1/workspace/relay`.
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { client } from "./api.ts";
import { type Args, CliError, color, textFlag } from "./util.ts";

const SUPPORTED_MCP_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_MCP_VERSION = "2025-03-26";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

const str = (description: string) => ({ type: "string", description });
const tool = (name: string, description: string, properties: Record<string, { type: string; description: string }> = {}, required = Object.keys(properties)): McpTool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

/** Mirrors `BRIDGE_TOOLS` in the Cresslet studio (`studio/builder.ts` + `studio/mcp-bridge.ts`). */
export const CONNECT_TOOLS: McpTool[] = [
  tool("list_files", "List the project's files (recursively, without node_modules, dist and .cresslet).", { dir: str("Directory to list, relative to the project root. Omit for the whole project.") }, []),
  tool("read_file", "Read a text file.", { path: str("File path, relative to the project root.") }),
  tool("write_file", "Create or overwrite a file with the given contents (parent directories are created).", { path: str("File path, relative to the project root."), content: str("The whole new file contents.") }),
  tool("edit_file", "Replace one exact occurrence of old_text in a file with new_text. old_text must appear exactly once: include enough surrounding lines to make it unique.", { path: str("File path, relative to the project root."), old_text: str("Exact text to replace, whitespace included."), new_text: str("Replacement text.") }),
  tool("delete_file", "Delete a file.", { path: str("File path, relative to the project root.") }),
  tool("run_command", "Run a shell command in the project root (the in-browser shell: npm, node, cresslet build|deploy, ls, cat, and the like) and get its exit code and output. Stopped after 120 seconds.", { command: str("The command line.") }),
  tool("read_dev_log", "Read the latest output of the studio's terminal, where the dev server runs (build errors, server logs)."),
  tool("commit_change", "End a turn and record the workspace's changes as a stack change (when linked to GitHub) or a local turn boundary. Does not run automatically; call it when a logical change is complete.", { title: str("Short summary of the change (1 line, up to 200 characters).") }),
];

export const CONNECT_INSTRUCTIONS = [
  "You are connected to an open project in Cresslet Studio via Live Link.",
  "- Paths are relative to the project root; local secret files (.env*, .dev.vars, .envrc) and .git are blocked from file tools.",
  "- The dev server (`cresslet dev`) is already running in the studio's terminal and reloads the preview on save. Do not start another long-running server (commands time out after 120s); use read_dev_log to inspect build errors and server logs.",
  "- Running `cresslet deploy` via run_command requires the user to click Approve deploy in the studio tab.",
  "- Call `commit_change(title)` when you finish a logical change to record a turn boundary (and commit a stack change on GitHub-linked apps).",
].join("\n");

export interface ConnectSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", fn: () => void): void;
  on(event: "message", fn: (data: Buffer | string) => void): void;
  on(event: "close", fn: (code: number, reason: Buffer) => void): void;
  on(event: "error", fn: (err: Error) => void): void;
}

export interface ConnectServerOptions {
  wsUrl: string;
  token: string;
  agent?: string;
  version: string;
  eager?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
  createSocket?: (url: string) => ConnectSocket;
}

interface PendingCall {
  callId: string;
  rpcId: string | number;
  resolve: (result: { text: string; error?: boolean }) => void;
}

export function relayWsUrl(apiBase: string): string {
  const u = new URL(apiBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/v1/workspace/relay";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export async function runConnectServer({
  wsUrl,
  token,
  agent: explicitAgent,
  version,
  eager = false,
  input = process.stdin,
  output = process.stdout,
  log = (line) => process.stderr.write(`${line}\n`),
  createSocket = (url) => new WebSocket(url) as unknown as ConnectSocket,
}: ConnectServerOptions): Promise<void> {
  let agentName = explicitAgent?.trim() || "Desktop agent";
  let ws: ConnectSocket | null = null;
  let state: "idle" | "connecting" | "pending" | "paired" = "idle";
  let currentCode: string | null = null;
  let lastError: string | null = null;
  let codeWaiters: Array<(res: { paired?: boolean; code?: string; error?: string }) => void> = [];
  let seq = 0;

  const byCallId = new Map<string, PendingCall>();
  const byRpcId = new Map<string, string>(); // JSON.stringify(rpcId) → callId

  const writeRpc = (msg: Record<string, unknown>) => {
    output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const resolveCodeWaiters = (res: { paired?: boolean; code?: string; error?: string }) => {
    for (const fn of codeWaiters.splice(0)) fn(res);
  };

  const failPendingCalls = (reason: string) => {
    for (const p of byCallId.values()) {
      p.resolve({ text: reason, error: true });
    }
    byCallId.clear();
    byRpcId.clear();
  };

  function ensureRelay(): Promise<{ paired?: boolean; code?: string; error?: string }> {
    if (state === "paired") return Promise.resolve({ paired: true });
    if (state === "pending" && currentCode) return Promise.resolve({ code: currentCode });
    return new Promise((resolve) => {
      codeWaiters.push(resolve);
      if (state === "connecting") return;
      state = "connecting";
      currentCode = null;
      lastError = null;
      const sock = createSocket(wsUrl);
      ws = sock;

      sock.on("open", () => {
        if (ws !== sock) return;
        sock.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token, agent: agentName }));
      });

      sock.on("message", (raw) => {
        if (ws !== sock) return;
        let msg: Record<string, unknown>;
        try {
          const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === "code" && typeof msg.code === "string") {
          state = "pending";
          currentCode = msg.code;
          log(`Pairing code: ${color.bold(msg.code)} (expires in ${typeof msg.expiresIn === "number" ? Math.round(msg.expiresIn / 60) : 5} min)`);
          log("Open your project in Cresslet Studio, click Connect agent, enter the code, and click Allow.");
          resolveCodeWaiters({ code: msg.code });
          return;
        }
        if (msg.type === "paired") {
          state = "paired";
          currentCode = null;
          const proj = typeof msg.projectName === "string" ? msg.projectName : "project";
          log(`Connected to Cresslet Studio project "${proj}".`);
          resolveCodeWaiters({ paired: true });
          return;
        }
        if (msg.type === "denied") {
          lastError = typeof msg.message === "string" ? msg.message : "Connection denied in Cresslet Studio.";
          log(lastError);
          return;
        }
        if (msg.type === "error") {
          lastError = typeof msg.message === "string" ? msg.message : "Relay error.";
          log(`Relay error: ${lastError}`);
          return;
        }
        if (msg.type === "tool_result" && typeof msg.id === "string") {
          const pending = byCallId.get(msg.id);
          if (!pending) return;
          byCallId.delete(msg.id);
          byRpcId.delete(JSON.stringify(pending.rpcId));
          pending.resolve({
            text: typeof msg.text === "string" ? msg.text : "(no output)",
            ...(msg.error ? { error: true } : {}),
          });
        }
      });

      sock.on("error", (err) => {
        if (ws !== sock) return;
        lastError ??= `Could not reach Cresslet relay (${err.message})`;
        log(lastError);
      });

      sock.on("close", () => {
        if (ws !== sock) return;
        const wasPaired = state === "paired";
        const err = lastError;
        ws = null;
        state = "idle";
        currentCode = null;
        lastError = null;
        resolveCodeWaiters({ error: err ?? "Relay connection closed before pairing." });
        if (wasPaired) {
          log("Disconnected from Cresslet Studio.");
          failPendingCalls("Studio disconnected while this tool call was running. Do not assume whether a write or commit completed; reconnect and check.");
        }
      });
    });
  }

  async function handleRpc(line: string) {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
      msg = parsed as Record<string, unknown>;
    } catch {
      writeRpc({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const id = (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : undefined;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (msg.params && typeof msg.params === "object" && !Array.isArray(msg.params))
      ? msg.params as Record<string, unknown>
      : {};

    if (method === "notifications/initialized") return;

    if (method === "notifications/cancelled") {
      const reqId = params.requestId;
      if (typeof reqId === "string" || typeof reqId === "number") {
        const callId = byRpcId.get(JSON.stringify(reqId));
        if (callId && ws && state === "paired" && ws.readyState === 1) {
          ws.send(JSON.stringify({ v: 1, type: "tool_cancel", id: callId }));
        }
      }
      return;
    }

    if (id === undefined) return; // other notifications need no reply

    if (method === "initialize") {
      if (!explicitAgent) {
        const ci = params.clientInfo as { name?: unknown } | undefined;
        if (typeof ci?.name === "string" && ci.name.trim()) agentName = ci.name.trim().slice(0, 64);
      }
      const reqVer = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_MCP_VERSIONS.has(reqVer) ? reqVer : DEFAULT_MCP_VERSION;
      writeRpc({
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "cresslet", version },
          instructions: CONNECT_INSTRUCTIONS,
        },
      });
      return;
    }

    if (method === "ping") {
      writeRpc({ id, result: {} });
      return;
    }

    if (method === "tools/list") {
      writeRpc({ id, result: { tools: CONNECT_TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {};
      if (!name) {
        writeRpc({ id, error: { code: -32602, message: "Missing tool name" } });
        return;
      }

      if (state !== "paired") {
        const r = await ensureRelay();
        if (!r.paired) {
          const text = r.code
            ? `Not paired with Cresslet Studio yet. Ask the user to open their project in Cresslet Studio, click Connect agent, enter code ${r.code}, and click Allow — then retry this tool call.`
            : (r.error ?? "Not paired with Cresslet Studio yet.");
          writeRpc({ id, result: { content: [{ type: "text", text }], isError: true } });
          return;
        }
      }

      if (!ws || ws.readyState !== 1) {
        writeRpc({ id, result: { content: [{ type: "text", text: "Not connected to Cresslet Studio." }], isError: true } });
        return;
      }

      const callId = `c${++seq}`;
      const resultP = new Promise<{ text: string; error?: boolean }>((resolve) => {
        byCallId.set(callId, { callId, rpcId: id, resolve });
        byRpcId.set(JSON.stringify(id), callId);
      });
      ws.send(JSON.stringify({ v: 1, type: "tool_call", id: callId, name, arguments: args }));
      const res = await resultP;
      writeRpc({
        id,
        result: {
          content: [{ type: "text", text: res.text }],
          ...(res.error ? { isError: true } : {}),
        },
      });
      return;
    }

    writeRpc({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  if (eager) void ensureRelay();

  const decoder = new StringDecoder("utf8");
  let buf = "";

  await new Promise<void>((resolve) => {
    const finish = () => {
      try { ws?.close(1000, "cli exiting"); } catch { /* already closed */ }
      ws = null;
      failPendingCalls("CLI closed.");
      resolve();
    };
    input.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        void handleRpc(line);
      }
    });
    input.on("end", () => {
      const rest = (buf + decoder.end()).trim();
      if (rest) void handleRpc(rest);
      finish();
    });
    input.on("close", finish);
  });
}

export async function cmdConnect(args: Args, version: string): Promise<void> {
  const c = client({ flags: args.flags });
  if (!c.token) {
    throw new CliError(
      "not logged in",
      "run `cresslet login` (or set CRESSLET_TOKEN) before `cresslet connect`",
    );
  }
  const agent = textFlag(args.flags, "agent");
  const eager = !!args.flags.eager || !!process.stdin.isTTY;
  await runConnectServer({
    wsUrl: relayWsUrl(c.base),
    token: c.token,
    agent,
    version,
    eager,
  });
}
