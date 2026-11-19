// WebSockets in `cresslet dev`: the platform (workerd) API — `new WebSocketPair()` and
// `new Response(null, { status: 101, webSocket: client })` — polyfilled on Node, bridged to `ws`.
import { STATUS_CODES } from "node:http";
import { WebSocketServer } from "ws";

/** Node's own Response; apps may return either it or the polyfill below. */
export const NodeResponse = globalThis.Response;

// An app's listener that throws (or rejects) is logged; it must not take down `cresslet dev`.
let reportListenerError = (type, err) => console.error(`WebSocket ${type} listener threw:`, err);
const guarded = new WeakMap(); // listener → wrapper

/** One end of a WebSocketPair; what one end sends, the other receives. */
class PairSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  #accepted = false;
  #queue = []; // events that arrived before accept()
  peer = null;

  addEventListener(type, listener, options) {
    const l = listener;
    if (typeof l === "function" || typeof l?.handleEvent === "function") {
      let w = guarded.get(l);
      if (!w) {
        w = function (e) {
          try {
            const r = typeof l === "function" ? l.call(this, e) : l.handleEvent(e);
            if (typeof r?.then === "function") r.then(undefined, (err) => reportListenerError(e.type, err));
          } catch (err) {
            reportListenerError(e.type, err);
          }
        };
        guarded.set(l, w);
      }
      listener = w;
    }
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, guarded.get(listener) ?? listener, options);
  }

  accept() {
    if (this.#accepted) return;
    this.#accepted = true;
    for (const e of this.#queue.splice(0)) this.dispatchEvent(e);
  }

  send(data) {
    if (!this.#accepted) throw new TypeError("call accept() before send()");
    if (this.readyState !== 1) throw new TypeError("WebSocket is closed");
    if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.peer._receive("message", { data });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer._receive("close", { code, reason: String(reason), wasClean: true });
    }
  }

  _receive(type, props) {
    const e = Object.assign(new Event(type), props);
    if (this.#accepted) this.dispatchEvent(e);
    else this.#queue.push(e);
  }
}

class WebSocketPair {
  constructor() {
    const a = new PairSocket();
    const b = new PairSocket();
    a.peer = b;
    b.peer = a;
    this[0] = a;
    this[1] = b;
  }
}

/** Response that also allows status 101 + `webSocket` (Node's Response rejects status < 200). */
class Response extends NodeResponse {
  // fetch(), Response.json(), clone() return Node's own Response: still `instanceof Response`.
  static [Symbol.hasInstance](v) {
    return v instanceof NodeResponse;
  }

  constructor(body, init) {
    if (init?.status !== 101) {
      super(body, init);
      return;
    }
    super(null, { ...init, status: 200 });
    Object.defineProperty(this, "status", { value: 101 });
    Object.defineProperty(this, "webSocket", { value: init.webSocket ?? null });
  }
}

let installs = 0;

/** Install the globals (refcounted); returns `uninstall`, which restores Node's own when the last user goes. */
export function installWebSocketPolyfill({ onListenerError } = {}) {
  if (onListenerError) reportListenerError = onListenerError;
  if (installs++ === 0) {
    globalThis.WebSocketPair ??= WebSocketPair;
    if (globalThis.Response === NodeResponse) globalThis.Response = Response;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--installs) return;
    if (globalThis.Response === Response) globalThis.Response = NodeResponse;
    if (globalThis.WebSocketPair === WebSocketPair) delete globalThis.WebSocketPair;
  };
}

// The app picks the subprotocol (Sec-WebSocket-Protocol response header) and may add headers.
const upgrades = new WeakMap(); // req → app Response
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (_protocols, req) => upgrades.get(req)?.headers.get("sec-websocket-protocol") ?? false,
});
wss.on("headers", (headers, req) => {
  upgrades.get(req)?.headers.forEach((v, k) => {
    if (!/^(upgrade|connection|sec-websocket-.*)$/.test(k)) headers.push(`${k}: ${v}`);
  });
});

/** Answer an http `upgrade` with the app's response: 101 + webSocket → bridge frames; else write it and close. */
export async function completeUpgrade(req, socket, head, response) {
  const client = response.status === 101 ? response.webSocket : null;
  if (!(client instanceof PairSocket)) {
    const r = response.status === 101 ? new NodeResponse("status 101 needs a webSocket\n", { status: 500 }) : response;
    const body = Buffer.from(await r.arrayBuffer());
    const lines = [`HTTP/1.1 ${r.status} ${STATUS_CODES[r.status] ?? ""}`];
    r.headers.forEach((v, k) => {
      if (!/^(connection|content-length|transfer-encoding)$/.test(k)) lines.push(`${k}: ${v}`);
    });
    lines.push(`content-length: ${body.length}`, "connection: close", "", "");
    socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
    return r.status;
  }
  upgrades.set(req, response);
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Listeners first: accept() delivers what the app sent before returning the 101 (e.g. a welcome).
    client.addEventListener("message", (e) => ws.send(e.data));
    client.addEventListener("close", (e) => {
      try {
        ws.close(e.code, e.reason);
      } catch {
        ws.close();
      }
    });
    ws.on("message", (data, isBinary) => {
      if (client.readyState !== 1) return;
      client.send(isBinary ? new Uint8Array(data) : data.toString());
    });
    ws.on("close", (code, reason) => client.close(code, reason.toString()));
    ws.on("error", (err) => client.peer._receive("error", { error: err, message: err.message }));
    client.accept();
  });
  return 101;
}
