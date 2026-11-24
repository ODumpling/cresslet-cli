// `cresslet connect`: stdio MCP server that bridges a desktop coding agent (Claude Code, Codex,
// T3 Code) to an open Cresslet Studio project tab over `/v1/workspace/relay`.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { type AgentStore, agentStore, newSecret, secretHash } from "./agents.ts";
import { client } from "./api.ts";
import { type Args, CliError, color, textFlag } from "./util.ts";

const SUPPORTED_MCP_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_MCP_VERSION = "2025-03-26";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_LIVENESS_MS = 90_000;
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60_000;

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

/** Live Link v2 (remembered agents): choosing the project. Answered here, not by a Studio tab. */
export const PROJECT_TOOLS: McpTool[] = [
  tool("list_projects", "List the Cresslet Studio projects this agent is approved for that are open now (a handle, a name, whether one is in use). Use use_project(handle) to pick one."),
  tool("use_project", "Work on another approved, open project. The first pick of a session connects at once; switching away from the current project asks the user to confirm in that project's Studio tab (you keep working on the current one until then; call use_project(<current handle>) to withdraw).", { handle: str("The project's handle, from list_projects.") }),
  tool("confirm_project", "Confirm the project picked automatically (restored for this folder, or the only one open): pass the code from the notice the first tool call returned.", { ack: str("The confirmation code from the notice.") }),
];
export const ALL_TOOLS: McpTool[] = [...CONNECT_TOOLS, ...PROJECT_TOOLS];

const TOOL_NAMES = new Set(CONNECT_TOOLS.map((t) => t.name));
const PROJECT_TOOL_NAMES = new Set(PROJECT_TOOLS.map((t) => t.name));

export const CONNECT_INSTRUCTIONS = [
  "You are connected to an open project in Cresslet Studio via Live Link.",
  "- Paths are relative to the project root; local secret files (.env*, .dev.vars, .envrc) and .git are blocked from file tools.",
  "- The dev server (`cresslet dev`) is already running in the studio's terminal and reloads the preview on save. Do not start another long-running server (commands time out after 120s); use read_dev_log to inspect build errors and server logs.",
  "- Running `cresslet deploy` via run_command requires the user to click Approve deploy in the studio tab.",
  "- Call `commit_change(title)` when you finish a logical change to record a turn boundary (and commit a stack change on GitHub-linked apps).",
  "- A remembered agent reconnects without a code. If a tool call answers \"Connected to project … call confirm_project(…)\", tell the user which project it is and confirm only if it's the one they meant; otherwise call list_projects and use_project(handle). Switching projects needs the user's click in that project's Studio tab.",
].join("\n");

export interface ConnectSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open" | "ping", fn: () => void): void;
  on(event: "message", fn: (data: Buffer | string) => void): void;
  on(event: "close", fn: (code: number, reason: Buffer) => void): void;
  on(event: "error", fn: (err: Error) => void): void;
}

export interface ConnectServerOptions {
  wsUrl: string;
  token: string;
  /** Remembered agents for this origin + login (agents.ts): without one, only code pairing (as before v2). */
  store?: AgentStore;
  /** The folder the agent works in (its project pin). */
  cwd?: string;
  /** The login now (re-read before each reconnect): a change or none stops the bridge. */
  currentToken?: () => string | undefined;
  /** Reconnect backoff: 1 s doubling to 30 s, jittered. */
  minDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  /** How long an unsent call waits for the connection (or its project's tab) to come back. */
  reconnectWaitMs?: number;
  /** Undispatched calls queued here (beyond: "busy" at once). */
  maxQueued?: number;
  agent?: string;
  version: string;
  eager?: boolean;
  handshakeTimeoutMs?: number;
  livenessMs?: number;
  callTimeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
  createSocket?: (url: string) => ConnectSocket;
}

interface PendingCall {
  callId: string;
  rpcId: string | number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: { text: string; error?: boolean; cancelled?: boolean }) => void;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function relayWsUrl(apiBase: string, { allowInsecure = false } = {}): string {
  let u: URL;
  try {
    u = new URL(apiBase);
  } catch {
    throw new CliError(`invalid API URL: ${apiBase}`, "check --api, CRESSLET_API, or `cresslet config get api`");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "wss:" && u.protocol !== "ws:") {
    throw new CliError(`unsupported API URL scheme: ${u.protocol}`, "use https:// (or http:// for localhost)");
  }
  const insecure = u.protocol === "http:" || u.protocol === "ws:";
  if (insecure && !allowInsecure && !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
    throw new CliError(
      `refusing to send account token over cleartext ${u.protocol}//${u.host}`,
      "use https:// for remote servers (or pass --allow-insecure for local testing)",
    );
  }
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/v1/workspace/relay";
  u.search = "";
  u.hash = "";
  return u.toString();
}

type ToolReply = { text: string; error?: boolean; cancelled?: boolean };
type Msg = Record<string, unknown>;

const OUTCOME_UNKNOWN = "Studio disconnected while this tool call was running. Do not assume whether a write or commit completed; reconnect and check.";

/** The reconnect delay before attempt `n`: 1 s doubling to 30 s, each between half and all of that. */
export const backoffDelay = (n: number, rand = Math.random, min = 1000, max = 30_000) => Math.min(max, min * 2 ** n) * (0.5 + rand() / 2);

interface LinkOptions {
  wsUrl: string;
  token: string;
  store: AgentStore;
  cwd: string;
  agentName: () => string;
  currentToken: () => string | undefined;
  createSocket: (url: string) => ConnectSocket;
  log: (line: string) => void;
  handshakeTimeoutMs: number;
  livenessMs: number;
  callTimeoutMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  reconnectWaitMs: number;
  maxQueued: number;
}

interface LinkCall {
  rpcKey: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** The binding it was made under: never sent to another project, nor after a Disconnect / switch (epoch). */
  handle: string;
  epoch: number;
  /** When it started waiting for the connection or its project's tab (unsent). */
  waitingSince: number | null;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (r: ToolReply) => void;
}

/**
 * Live Link v2: a remembered agent's connection (token + credential secrets + this process's instance id). It
 * reconnects with backoff and its pin after drops, binds to one approved, open project at a time, announces a project
 * it picked by itself before acting, queues calls here (one in flight), and never replays a dispatched one.
 */
function createAgentLink(o: LinkOptions) {
  const instanceId = randomBytes(9).toString("base64url");
  let ws: ConnectSocket | null = null;
  let phase: "idle" | "connecting" | "ready" | "stopped" = "idle";
  let stopReason: string | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let readyWaiters: ((err?: string) => void)[] = [];
  let projects: Msg[] = [];
  let binding: { handle: string; epoch: number; projectName: string; credentialId: string } | null = null;
  /** Unbound because the tab isn't open: what to tell queued calls if it doesn't come back. */
  let unboundText: string | null = null;
  /** The project this session works on; `confirmed` once the user (or agent, explicitly) chose it. */
  let pin: { handle: string; credentialId: string; projectName: string; confirmed: boolean; ack?: string } | null = null;
  let pendingSwitch: { handle: string; projectName: string } | null = null;
  /** Projects bound this session: when their tab is away (a reload, a server restart), a call waits for it. */
  const everBound = new Set<string>();
  const bindWaiters = new Map<string, ((m: Msg) => void)[]>();
  let listWaiters: ((m: Msg[]) => void)[] = [];
  const queue: LinkCall[] = [];
  let active: LinkCall | null = null;
  /** A dispatched call cancelled here: the tab is still stopping it, so the next one waits for its result. */
  let stopping: string | null = null;
  let seq = 0;
  const startToken = o.token;

  const sendWs = (msg: Msg) => {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ v: 1, ...msg }));
      return true;
    } catch {
      return false;
    }
  };
  const savePin = () => {
    if (!pin) return;
    try {
      o.store.setPin(o.cwd, { handle: pin.handle, credentialId: pin.credentialId, projectName: pin.projectName });
    } catch (e) {
      o.log(`Couldn't save this folder's project: ${(e as Error).message}`);
    }
  };
  const settle = (c: LinkCall, r: ToolReply) => {
    clearTimeout(c.timer);
    const i = queue.indexOf(c);
    if (i >= 0) queue.splice(i, 1);
    if (active === c) active = null;
    c.resolve(r);
  };
  const resolveBind = (handle: string, m: Msg) => {
    const ws_ = bindWaiters.get(handle);
    bindWaiters.delete(handle);
    for (const w of ws_ ?? []) w(m);
  };
  const bumpLiveness = (sock: ConnectSocket) => {
    clearTimeout(livenessTimer);
    if (o.livenessMs <= 0) return;
    livenessTimer = setTimeout(() => {
      if (ws !== sock) return;
      if (sock.terminate) sock.terminate();
      else sock.close(1001, "liveness timeout");
    }, o.livenessMs);
    livenessTimer.unref();
  };

  /** Calls waiting too long for the connection or the project's tab: failed, never run. */
  const sweepTimer = setInterval(() => {
    const t = Date.now();
    for (const c of [...queue]) {
      if (c.waitingSince !== null && t - c.waitingSince > o.reconnectWaitMs) {
        settle(c, { error: true, text: unboundText ?? "Not connected to Cresslet Studio (reconnecting): this call was not run. Retry in a moment." });
      }
    }
  }, Math.min(1000, Math.max(50, o.reconnectWaitMs / 4)));
  sweepTimer.unref();

  function drain() {
    if (active || stopping || !binding || phase !== "ready") {
      for (const c of queue) c.waitingSince ??= Date.now();
      return;
    }
    while (queue.length && !active) {
      const c = queue[0]!;
      if (c.handle !== binding.handle) {
        settle(c, { error: true, text: `This call was made for project ${pin?.projectName ?? "another project"} before a switch: not run.` });
        continue;
      }
      if (c.epoch !== binding.epoch) {
        settle(c, { error: true, text: "Cancelled in Studio (Disconnect, Take over or a project switch since this call was made): not run." });
        continue;
      }
      c.waitingSince = null;
      if (!sendWs({ type: "tool_call", id: c.callId, name: c.name, arguments: c.args, handle: c.handle, epoch: c.epoch })) {
        c.waitingSince = Date.now();
        return;
      }
      queue.shift(); // the queue holds unsent calls only
      active = c;
      c.timer = setTimeout(() => {
        sendWs({ type: "tool_cancel", id: c.callId });
        settle(c, { error: true, text: "Tool call timed out waiting for Cresslet Studio (cancellation sent; an in-flight write or commit may already have completed)." });
        drain();
      }, o.callTimeoutMs);
      c.timer.unref();
    }
  }

  function stop(reason: string) {
    phase = "stopped";
    stopReason = reason;
    o.log(reason);
    for (const w of readyWaiters.splice(0)) w(reason);
    for (const c of [...queue]) settle(c, { error: true, text: `${reason} This call was not run.` });
  }

  function connect() {
    if (phase === "stopped" || phase === "connecting" || phase === "ready") return;
    // The login and credentials, read again: logout (or another login) since stops this bridge.
    const now = o.currentToken();
    if (now !== startToken) return stop(now ? "The CLI's login changed: restart the agent to use the new one." : "Logged out (cresslet logout): Live Link stopped. Run `cresslet login`, then restart the agent.");
    const creds = o.store.list();
    if (!creds.length) return stop("No remembered agent left for this login: pair again with a code.");
    phase = "connecting";
    let lastError: { code?: string; message?: string } | null = null;
    const sock = o.createSocket(o.wsUrl);
    ws = sock;
    handshakeTimer = setTimeout(() => {
      if (ws !== sock || phase !== "connecting") return;
      if (sock.terminate) sock.terminate();
      else sock.close(1001, "handshake timeout");
    }, o.handshakeTimeoutMs);
    handshakeTimer.unref();
    sock.on("open", () => {
      if (ws !== sock) return;
      bumpLiveness(sock);
      sendWs({
        type: "hello", role: "agent", token: startToken, agent: o.agentName(), instanceId,
        credentials: creds.map((c) => ({ id: c.id, secret: c.secret })),
        ...(pin ? { bind: pin.handle, quiet: true, ...(pin.confirmed ? { confirmed: true } : {}) } : {}),
      });
    });
    sock.on("ping", () => {
      if (ws === sock) bumpLiveness(sock);
    });
    sock.on("message", (raw) => {
      if (ws !== sock) return;
      bumpLiveness(sock);
      let m: Msg;
      try {
        const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        m = parsed as Msg;
      } catch {
        return;
      }
      onMessage(m);
      if (m.type === "error") lastError = { code: typeof m.code === "string" ? m.code : undefined, message: typeof m.message === "string" ? m.message : undefined };
    });
    sock.on("error", () => { /* close follows */ });
    sock.on("close", () => {
      if (ws !== sock) return;
      ws = null;
      clearTimeout(handshakeTimer);
      clearTimeout(livenessTimer);
      const wasReady = phase === "ready";
      if (phase !== "stopped") phase = "idle";
      binding = null;
      stopping = null;
      // Dispatched: cancelled best-effort by the relay, reported as unknown here. Never sent again.
      if (active) settle(active, { error: true, text: OUTCOME_UNKNOWN });
      for (const [h] of bindWaiters) resolveBind(h, { type: "bind_error", code: "disconnected", message: "Lost the connection to Cresslet Studio." });
      for (const w of listWaiters.splice(0)) w([]);
      const code = lastError?.code;
      if (code === "unauthorized_agent") {
        if (!o.store.list().length) return stop(lastError?.message ?? "This remembered agent was forgotten or expired: pair again with a code.");
      } else if (code === "unauthorized") {
        return stop("The CLI's login was revoked or the account disabled: run `cresslet login`, then restart the agent.");
      } else if (code === "replaced") {
        return stop("Another connection from this agent replaced this one.");
      }
      if (phase === "stopped") return;
      for (const w of readyWaiters.splice(0)) w(lastError?.message ?? "Couldn't reach the Cresslet relay.");
      if (wasReady) o.log("Disconnected from Cresslet Studio: reconnecting.");
      for (const c of queue) c.waitingSince ??= Date.now();
      const delay = backoffDelay(attempt++, o.random, o.minDelayMs, o.maxDelayMs);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
      reconnectTimer.unref();
    });
  }

  function onMessage(m: Msg) {
    switch (m.type) {
      case "ready": {
        clearTimeout(handshakeTimer);
        phase = "ready";
        attempt = 0;
        projects = Array.isArray(m.projects) ? m.projects as Msg[] : [];
        for (const id of Array.isArray(m.revoked) ? m.revoked : []) if (typeof id === "string") o.store.remove(id);
        for (const w of readyWaiters.splice(0)) w();
        drain();
        return;
      }
      case "revoked":
        for (const id of Array.isArray(m.credentials) ? m.credentials : []) if (typeof id === "string") o.store.remove(id);
        return;
      case "projects":
        projects = Array.isArray(m.projects) ? m.projects as Msg[] : [];
        for (const w of listWaiters.splice(0)) w(projects);
        return;
      case "bound": {
        const handle = String(m.handle), epoch = Number(m.epoch), projectName = String(m.projectName ?? "project"), credentialId = String(m.credentialId ?? "");
        binding = { handle, epoch, projectName, credentialId };
        everBound.add(handle);
        unboundText = null;
        if (!pin || pin.handle !== handle) {
          // Moved by the user's click (Use with, Take over, Allow): their choice, so confirmed.
          pin = { handle, credentialId, projectName, confirmed: true };
          savePin();
          o.log(m.switched ? `Switched to Cresslet Studio project "${projectName}".` : `Connected to Cresslet Studio project "${projectName}".`);
        } else {
          pin.projectName = projectName;
          pin.credentialId = credentialId;
        }
        if (pendingSwitch?.handle === handle) pendingSwitch = null;
        resolveBind(handle, m);
        drain();
        return;
      }
      case "bind_error":
      case "switch_pending":
        if (m.type === "switch_pending") pendingSwitch = { handle: String(m.handle), projectName: String(m.projectName ?? "project") };
        else if (pendingSwitch?.handle === m.handle) pendingSwitch = null;
        resolveBind(String(m.handle), m);
        return;
      case "switch_expired":
        if (pendingSwitch?.handle === m.handle) pendingSwitch = null;
        o.log(`The switch to "${String(m.projectName ?? "project")}" wasn't confirmed (${String(m.reason ?? "expired")}).`);
        return;
      case "unbound": {
        binding = null;
        const reason = String(m.reason ?? ""), text = typeof m.message === "string" ? m.message : "Disconnected from the Studio project.";
        o.log(text);
        if (reason === "not_open") {
          // Its tab may be reloading: unsent calls wait a little, then fail (never sent elsewhere).
          unboundText = `${text} This call was not run.`;
          for (const c of queue) c.waitingSince ??= Date.now();
          return;
        }
        for (const c of [...queue]) settle(c, { error: true, text: `${text} This call was not run.` });
        return;
      }
      case "tool_result": {
        if (stopping === m.id) {
          stopping = null;
          return drain();
        }
        if (!active || active.callId !== m.id) return;
        const c = active;
        settle(c, { text: typeof m.text === "string" ? m.text : "(no output)", ...(m.error ? { error: true } : {}) });
        drain();
        return;
      }
    }
  }

  /** Connected and authenticated (waits for a reconnect under way, up to the reconnect wait). */
  function ready(): Promise<string | undefined> {
    if (phase === "ready") return Promise.resolve(undefined);
    if (phase === "stopped") return Promise.resolve(stopReason ?? "Live Link stopped.");
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        readyWaiters = readyWaiters.filter((w) => w !== done);
        resolve("Couldn't reach Cresslet Studio's relay: retry in a moment.");
      }, o.reconnectWaitMs);
      t.unref();
      const done = (err?: string) => {
        clearTimeout(t);
        resolve(err);
      };
      readyWaiters.push(done);
      if (phase === "idle") {
        clearTimeout(reconnectTimer);
        connect();
      }
    });
  }

  /** Asks to bind (or switch) to `handle`; resolves with the relay's answer (bound, bind_error, switch_pending). */
  function askBind(handle: string, confirm = false): Promise<Msg> {
    if (binding?.handle === handle && !pendingSwitch) return Promise.resolve({ type: "bound", ...binding });
    return new Promise((resolve) => {
      const list = bindWaiters.get(handle) ?? [];
      bindWaiters.set(handle, list);
      let t: ReturnType<typeof setTimeout>;
      const done = (m: Msg) => {
        clearTimeout(t);
        resolve(m);
      };
      t = setTimeout(() => {
        const l = bindWaiters.get(handle);
        if (l) bindWaiters.set(handle, l.filter((w) => w !== done));
        resolve({ type: "bind_error", code: "timeout", message: "Cresslet Studio didn't answer: retry in a moment." });
      }, 10_000);
      t.unref();
      list.push(done);
      if (!sendWs({ type: "bind", handle, ...(confirm ? { confirm: true } : {}) })) done({ type: "bind_error", code: "disconnected", message: "Not connected to Cresslet Studio: retry in a moment." });
    });
  }

  /** Waits for the relay to bind `handle` by itself (its tab came back: the relay binds pinned agents again). */
  function waitBound(handle: string, ms: number): Promise<boolean> {
    if (binding?.handle === handle) return Promise.resolve(true);
    return new Promise((resolve) => {
      const list = bindWaiters.get(handle) ?? [];
      bindWaiters.set(handle, list);
      const done = (m: Msg) => {
        clearTimeout(t);
        resolve(m.type === "bound");
      };
      const t = setTimeout(() => {
        const l = bindWaiters.get(handle);
        if (l) bindWaiters.set(handle, l.filter((w) => w !== done));
        resolve(false);
      }, ms);
      t.unref();
      list.push(done);
    });
  }

  function listProjects(): Promise<Msg[]> {
    return new Promise((resolve) => {
      listWaiters.push(resolve);
      if (!sendWs({ type: "list" })) {
        listWaiters = listWaiters.filter((w) => w !== resolve);
        resolve(projects);
      }
    });
  }

  const describe = (p: Msg) => {
    const hints: string[] = [];
    const folder = path.basename(o.cwd).toLowerCase();
    if (folder && (String(p.name).toLowerCase() === folder || String(p.app ?? "").toLowerCase() === folder)) hints.push("matches this folder");
    if (p.current) hints.push("current");
    if (p.inUse) hints.push(`in use by ${String(p.inUse)}`);
    if (p.paused) hints.push("disconnected in Studio");
    return `- ${String(p.handle)}: ${String(p.name)}${p.app ? ` (app ${String(p.app)})` : ""}${hints.length ? ` [${hints.join(", ")}]` : ""}`;
  };
  const listText = (ps: Msg[]) => ps.length
    ? `Approved Cresslet Studio projects open now:\n${ps.map(describe).join("\n")}\nCall use_project(handle) with the one the user means.`
    : "No approved Cresslet Studio project is open now. Ask the user to open the project in Cresslet Studio (in the browser that approved this agent), or to allow this agent there: Connect agent → Allow.";

  /** The notice a workspace call gets until the automatically picked project is confirmed. */
  const announce = () => {
    pin!.ack ??= randomBytes(4).toString("hex");
    return `Connected to project "${pin!.projectName}". If that's the project the user meant, call confirm_project("${pin!.ack}"); otherwise call list_projects. (This tool call did not run.)`;
  };

  async function workspaceCall(rpcKey: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const err = await ready();
    if (err) return { error: true, text: err };
    if (!binding) {
      if (!pin) {
        const stored = o.store.pin(o.cwd);
        if (stored) pin = { ...stored, confirmed: false };
        else {
          const open = projects.length ? projects : await listProjects();
          if (open.length !== 1) return { error: true, text: listText(open) };
          const p = open[0]!;
          pin = { handle: String(p.handle), credentialId: String(p.credentialId), projectName: String(p.name), confirmed: false };
        }
      }
      const r = await askBind(pin.handle);
      if (r.type !== "bound") {
        // Bound before this session and its tab is away: a reload or a restart, most likely. Wait for it a little.
        const back = r.code === "not_open" && everBound.has(pin.handle) && await waitBound(pin.handle, o.reconnectWaitMs);
        if (!back) return { error: true, text: String(r.message ?? "Couldn't connect to the project.") };
      }
    }
    if (!pin?.confirmed) return { error: true, text: announce() };
    if (queue.length + (active ? 1 : 0) >= o.maxQueued) return { error: true, text: "Too many tool calls queued for Cresslet Studio: wait for earlier calls to finish." };
    const b = binding!;
    return new Promise<ToolReply>((resolve) => {
      queue.push({ rpcKey, callId: `c${++seq}`, name, args, handle: b.handle, epoch: b.epoch, waitingSince: null, resolve });
      drain();
    });
  }

  async function projectTool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const err = await ready();
    if (err) return { error: true, text: err };
    if (name === "list_projects") return { text: listText(await listProjects()) };
    if (name === "confirm_project") {
      if (pin && !pin.confirmed && pin.ack && args.ack === pin.ack) {
        pin.confirmed = true;
        savePin();
        sendWs({ type: "confirm", handle: pin.handle }); // moving away from it needs the user's click from now on
        return { text: `Confirmed: working on project "${pin.projectName}". Retry your tool calls.` };
      }
      if (pin?.confirmed) return { text: `Already working on project "${pin.projectName}".` };
      return { error: true, text: "That confirmation code doesn't match: call list_projects and use_project(handle)." };
    }
    // use_project
    const handle = typeof args.handle === "string" ? args.handle : "";
    if (!handle) return { error: true, text: "use_project needs a handle from list_projects." };
    if (binding && binding.handle === handle) {
      if (pendingSwitch) await askBind(handle, true); // withdraws the pending switch
      else if (!pin?.confirmed) sendWs({ type: "confirm", handle }); // its own explicit choice now
      pin = { handle, credentialId: binding.credentialId, projectName: binding.projectName, confirmed: true };
      savePin();
      return { text: `Working on project "${binding.projectName}".` };
    }
    const current = binding;
    const r = await askBind(handle, true);
    if (r.type === "bound") {
      pin = { handle, credentialId: String(r.credentialId ?? ""), projectName: String(r.projectName ?? "project"), confirmed: true };
      savePin();
      return { text: `Connected to project "${pin.projectName}".` };
    }
    if (r.type === "switch_pending") {
      return {
        text: `Waiting for the user to confirm in "${String(r.projectName)}": ask them to click "Use with ${o.agentName()}" in that project's Studio tab (it expires in ${Math.round(Number(r.expiresIn ?? 300) / 60)} min). Keep working on "${current?.projectName ?? "the current project"}" meanwhile; call use_project("${handle}") again to check, or use_project("${current?.handle ?? ""}") to withdraw.`,
      };
    }
    return { error: true, text: String(r.message ?? "Couldn't switch to that project.") };
  }

  return {
    /** Remembered agents exist for this login (else code pairing). */
    get usable() {
      return phase !== "stopped" && o.store.list().length > 0;
    },
    start(initial?: { handle: string; credentialId: string; projectName: string; confirmed: boolean }) {
      if (initial) {
        pin = { ...initial };
        savePin();
      }
      else if (!pin) {
        const stored = o.store.pin(o.cwd);
        if (stored) pin = { ...stored, confirmed: false };
      }
      if (phase === "stopped") {
        phase = "idle";
        stopReason = null;
      }
      clearTimeout(reconnectTimer);
      attempt = 0;
      connect();
    },
    workspaceCall,
    projectTool,
    /** MCP notifications/cancelled: an unsent call is dropped; the one in flight is cancelled in the tab. */
    cancel(rpcKey: string): boolean {
      const c = active?.rpcKey === rpcKey ? active : queue.find((q) => q.rpcKey === rpcKey);
      if (!c) return false;
      if (c === active && sendWs({ type: "tool_cancel", id: c.callId })) stopping = c.callId;
      settle(c, { text: "Cancelled.", error: true, cancelled: true });
      drain();
      return true;
    },
    close() {
      phase = "stopped";
      clearTimeout(reconnectTimer);
      clearTimeout(livenessTimer);
      clearTimeout(handshakeTimer);
      clearInterval(sweepTimer);
      try {
        ws?.close(1000, "cli exiting");
      } catch { /* closed */ }
      ws = null;
      for (const c of [...queue]) settle(c, { error: true, text: "CLI closed." });
    },
  };
}

export async function runConnectServer({
  wsUrl,
  token,
  store,
  cwd = process.cwd(),
  currentToken = () => token,
  minDelayMs = 1000,
  maxDelayMs = 30_000,
  random = Math.random,
  reconnectWaitMs = 15_000,
  maxQueued = 32,
  agent: explicitAgent,
  version,
  eager = false,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  livenessMs = DEFAULT_LIVENESS_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  input = process.stdin,
  output = process.stdout,
  log = (line) => process.stderr.write(`${line}\n`),
  createSocket = (url) => new WebSocket(url, { handshakeTimeout: handshakeTimeoutMs }) as unknown as ConnectSocket,
}: ConnectServerOptions): Promise<void> {
  let agentName = explicitAgent?.trim() || "Desktop agent";
  let ws: ConnectSocket | null = null;
  let state: "idle" | "connecting" | "pending" | "paired" = "idle";
  let currentCode: string | null = null;
  let lastError: string | null = null;
  let codeWaiters: Array<(res: { paired?: boolean; code?: string; error?: string }) => void> = [];
  let seq = 0;
  let finished = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;

  // Live Link v2: remembered agents (credential files for this origin + login) reconnect without a code.
  const link = store ? createAgentLink({
    wsUrl, token, store, cwd, agentName: () => agentName, currentToken, createSocket, log, handshakeTimeoutMs, livenessMs,
    callTimeoutMs, minDelayMs, maxDelayMs, random, reconnectWaitMs, maxQueued,
  }) : null;
  /** The secret offered while a code pairing is pending (only its hash goes to the server). */
  let enrollSecret: string | null = null;
  let enrolledNow = false;

  const byCallId = new Map<string, PendingCall>();
  const byRpcId = new Map<string, string>(); // JSON.stringify(rpcId) → callId
  const cancelledRpcIds = new Set<string>(); // requests cancelled while awaiting ensureRelay()

  const clearTimers = () => {
    clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    clearTimeout(livenessTimer);
    livenessTimer = undefined;
  };

  const bumpLiveness = (sock: ConnectSocket) => {
    clearTimeout(livenessTimer);
    if (livenessMs <= 0) return;
    livenessTimer = setTimeout(() => {
      if (ws !== sock) return;
      lastError = "Relay connection timed out (no response from server).";
      if (sock.terminate) sock.terminate();
      else sock.close(1001, "liveness timeout");
    }, livenessMs);
    livenessTimer.unref();
  };

  const writeRpc = (msg: Record<string, unknown>) => {
    output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const resolveCodeWaiters = (res: { paired?: boolean; code?: string; error?: string }) => {
    for (const fn of codeWaiters.splice(0)) fn(res);
  };

  const settleCall = (callId: string, result: { text: string; error?: boolean; cancelled?: boolean }) => {
    const p = byCallId.get(callId);
    if (!p) return;
    clearTimeout(p.timer);
    byCallId.delete(callId);
    byRpcId.delete(JSON.stringify(p.rpcId));
    p.resolve(result);
  };

  const failPendingCalls = (reason: string) => {
    for (const callId of [...byCallId.keys()]) {
      settleCall(callId, { text: reason, error: true });
    }
  };

  function ensureRelay(): Promise<{ paired?: boolean; code?: string; error?: string }> {
    if (finished) return Promise.resolve({ error: "CLI closed." });
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

      handshakeTimer = setTimeout(() => {
        if (ws !== sock || state !== "connecting") return;
        lastError = "Timed out waiting for Cresslet relay handshake.";
        if (sock.terminate) sock.terminate();
        else sock.close(1001, "handshake timeout");
      }, handshakeTimeoutMs);
      handshakeTimer.unref();

      sock.on("open", () => {
        if (ws !== sock) return;
        bumpLiveness(sock);
        try {
          if (link) enrollSecret = newSecret();
          sock.send(JSON.stringify({
            v: 1, type: "hello", role: "cli", token, agent: agentName,
            ...(link && enrollSecret ? { enroll: { secretHash: secretHash(enrollSecret), instanceId: randomBytes(9).toString("base64url") } } : {}),
          }));
        } catch (e) {
          lastError = `Failed to send hello: ${(e as Error).message}`;
          sock.close();
        }
      });

      sock.on("ping", () => {
        if (ws === sock) bumpLiveness(sock);
      });

      sock.on("message", (raw) => {
        if (ws !== sock) return;
        bumpLiveness(sock);
        let msg: Record<string, unknown>;
        try {
          const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === "code" && typeof msg.code === "string") {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
          state = "pending";
          currentCode = msg.code;
          log(`Pairing code: ${color.bold(msg.code)} (expires in ${typeof msg.expiresIn === "number" ? Math.round(msg.expiresIn / 60) : 5} min)`);
          log("Open your project in Cresslet Studio, click Connect agent, enter the code, and click Allow.");
          resolveCodeWaiters({ code: msg.code });
          return;
        }
        if (msg.type === "paired") {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
          state = "paired";
          currentCode = null;
          const proj = typeof msg.projectName === "string" ? msg.projectName : "project";
          log(`Connected to Cresslet Studio project "${proj}".`);
          resolveCodeWaiters({ paired: true });
          return;
        }
        if (msg.type === "enrolled" && link && enrollSecret && store) {
          // Remember this agent: the credential file, this folder's pin (the user just approved it), then reconnect
          // with it (the relay closes this pairing socket).
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
          const credentialId = String(msg.credentialId), handle = String(msg.handle), projectName = String(msg.projectName ?? "project");
          try {
            store.save({ id: credentialId, secret: enrollSecret, label: agentName });
          } catch (e) {
            log(`Couldn't save the remembered agent (${(e as Error).message}): the next session needs a code again.`);
          }
          enrollSecret = null;
          enrolledNow = true;
          log(`Remembered by Cresslet Studio: connected to project "${projectName}". Restarts reconnect without a code.`);
          link.start({ handle, credentialId, projectName, confirmed: true });
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
          settleCall(msg.id, {
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
        clearTimers();
        if (enrolledNow) {
          enrolledNow = false;
          ws = null;
          state = "idle";
          currentCode = null;
          lastError = null;
          return;
        }
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
        const key = JSON.stringify(reqId);
        if (link?.cancel(key)) return;
        const callId = byRpcId.get(key);
        if (callId) {
          if (ws && state === "paired" && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ v: 1, type: "tool_cancel", id: callId })); } catch { /* closing */ }
          }
          // Settle and remove locally so cancelled calls never hang (MCP spec: no response sent).
          settleCall(callId, { text: "Cancelled.", error: true, cancelled: true });
        } else {
          cancelledRpcIds.add(key);
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
      writeRpc({ id, result: { tools: link ? ALL_TOOLS : CONNECT_TOOLS } });
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
      const rpcKey = JSON.stringify(id);
      const reply = (res: ToolReply) => {
        if (res.cancelled) return; // MCP spec: do not reply to a cancelled request
        writeRpc({ id, result: { content: [{ type: "text", text: res.text }], ...(res.error ? { isError: true } : {}) } });
      };
      if (link && PROJECT_TOOL_NAMES.has(name)) {
        if (!link.usable) return reply({ error: true, text: "No remembered agent yet: pair once with a code (call any workspace tool) and tick Remember this agent in the Studio." });
        return reply(await link.projectTool(name, args));
      }
      if (!TOOL_NAMES.has(name)) {
        writeRpc({ id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } });
        return;
      }
      // A remembered agent (not mid code pairing): through its own connection, no code.
      if (link?.usable && state !== "paired") return reply(await link.workspaceCall(rpcKey, name, args));

      if (state !== "paired") {
        const r = await ensureRelay();
        if (cancelledRpcIds.delete(rpcKey)) return;
        if (!r.paired) {
          const text = r.code
            ? `Not paired with Cresslet Studio yet. Ask the user to open their project in Cresslet Studio, click Connect agent, enter code ${r.code}, and click Allow — then retry this tool call.`
            : (r.error ?? "Not paired with Cresslet Studio yet.");
          writeRpc({ id, result: { content: [{ type: "text", text }], isError: true } });
          return;
        }
      }
      if (cancelledRpcIds.delete(rpcKey)) return;

      if (!ws || ws.readyState !== 1) {
        writeRpc({ id, result: { content: [{ type: "text", text: "Not connected to Cresslet Studio." }], isError: true } });
        return;
      }

      const callId = `c${++seq}`;
      const resultP = new Promise<{ text: string; error?: boolean; cancelled?: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          if (ws && state === "paired" && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ v: 1, type: "tool_cancel", id: callId })); } catch { /* closing */ }
          }
          settleCall(callId, {
            text: "Tool call timed out waiting for Cresslet Studio (cancellation sent; an in-flight write or commit may already have completed).",
            error: true,
          });
        }, callTimeoutMs);
        timer.unref();
        byCallId.set(callId, { callId, rpcId: id, timer, resolve });
        byRpcId.set(rpcKey, callId);
      });
      try {
        ws.send(JSON.stringify({ v: 1, type: "tool_call", id: callId, name, arguments: args }));
      } catch (e) {
        settleCall(callId, { text: `Failed to send tool call: ${(e as Error).message}`, error: true });
      }
      const res = await resultP;
      if (res.cancelled) return; // MCP spec: do not reply to a cancelled request
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

  if (link?.usable) link.start();
  else if (eager) void ensureRelay();

  const decoder = new StringDecoder("utf8");
  let buf = "";

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimers();
      try { ws?.close(1000, "cli exiting"); } catch { /* already closed */ }
      ws = null;
      resolveCodeWaiters({ error: "CLI closed." });
      failPendingCalls("CLI closed.");
      link?.close();
      resolve();
    };
    const dispatch = (line: string) => {
      void handleRpc(line).catch((e) => log(`MCP handler error: ${(e as Error).message}`));
    };
    input.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        dispatch(line);
      }
    });
    input.on("end", () => {
      const rest = (buf + decoder.end()).trim();
      if (rest) dispatch(rest);
      finish();
    });
    input.on("close", finish);
  });
}

/**
 * Where `connect` sends the account token: `--api` > `CRESSLET_API` > global config > default. Never the workspace's
 * `.cresslet/app.json`: a cloned repo could name another server and receive the token in the relay hello.
 */
export function connectClient(flags: Args["flags"]) {
  return client({ flags });
}

export async function cmdConnect(args: Args, version: string): Promise<void> {
  const c = connectClient(args.flags);
  if (!c.token) {
    throw new CliError(
      "not logged in",
      "run `cresslet login` (or set CRESSLET_TOKEN) before `cresslet connect`",
    );
  }
  const agent = textFlag(args.flags, "agent");
  const eager = !!args.flags.eager || !!process.stdin.isTTY;
  const allowInsecure = !!args.flags["allow-insecure"] || process.env.CRESSLET_ALLOW_INSECURE === "1";
  await runConnectServer({
    wsUrl: relayWsUrl(c.base, { allowInsecure }),
    token: c.token,
    store: agentStore({ api: c.base, token: c.token }),
    cwd: process.cwd(),
    currentToken: () => connectClient(args.flags).token,
    agent,
    version,
    eager,
  });
}
