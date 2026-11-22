// WebSockets in `cresslet dev`: the platform (workerd) API — `new WebSocketPair()` and
// `new Response(null, { status: 101, webSocket: client })` — polyfilled on Node, bridged to `ws`.
import { AsyncResource } from "node:async_hooks";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocketServer } from "ws";

/** Node's own Response; apps may return either it or the polyfill below. */
export const NodeResponse = globalThis.Response;

// An app's listener that throws (or rejects) is logged; it must not take down `cresslet dev`.
// One entry per live install (latest wins); ending an install restores the one before it.
type Reporter = (type: string, err: unknown) => void;
const defaultReporter: Reporter = (type, err) => console.error(`WebSocket ${type} listener threw:`, err);
const reporters: { fn: Reporter | undefined }[] = [];
const reportListenerError: Reporter = (type, err) => (reporters.findLast((r) => r.fn)?.fn ?? defaultReporter)(type, err);
type Listener = Parameters<EventTarget["addEventListener"]>[1];
const guarded = new WeakMap<Listener, (e: Event) => void>(); // listener → wrapper

/** One end of a WebSocketPair; what one end sends, the other receives. */
class PairSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  #accepted = false;
  #queue: Event[] = []; // events that arrived before accept()
  peer: PairSocket | null = null; // set by WebSocketPair

  override addEventListener(type: string, listener: Listener, options?: Parameters<EventTarget["addEventListener"]>[2]) {
    const l = listener;
    if (typeof l === "function" || typeof l?.handleEvent === "function") {
      let w = guarded.get(l);
      if (!w) {
        w = function (this: unknown, e: Event) {
          try {
            // a listener may be async (its rejection is reported too)
            const r: unknown = typeof l === "function" ? l.call(this, e) : l.handleEvent(e);
            if (typeof (r as PromiseLike<unknown> | undefined)?.then === "function") {
              (r as PromiseLike<unknown>).then(undefined, (err) => reportListenerError(e.type, err));
            }
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

  override removeEventListener(type: string, listener: Listener, options?: Parameters<EventTarget["removeEventListener"]>[2]) {
    super.removeEventListener(type, guarded.get(listener) ?? listener, options);
  }

  accept() {
    if (this.#accepted) return;
    this.#accepted = true;
    for (const e of this.#queue.splice(0)) this.dispatchEvent(e);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (!this.#accepted) throw new TypeError("call accept() before send()");
    if (this.readyState !== 1) throw new TypeError("WebSocket is closed");
    if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.peer!._receive("message", { data });
  }

  close(code = 1000, reason: unknown = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const peer = this.peer!;
    if (peer.readyState !== 3) {
      peer.readyState = 3;
      peer._receive("close", { code, reason: String(reason), wasClean: true });
    }
  }

  _receive(type: string, props: object) {
    const e = Object.assign(new Event(type), props);
    if (this.#accepted) this.dispatchEvent(e);
    else this.#queue.push(e);
  }
}

class WebSocketPair {
  declare 0: PairSocket;
  declare 1: PairSocket;
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
  // Only for the shim itself: an app's subclass keeps normal instanceof semantics.
  static override [Symbol.hasInstance](v: unknown): boolean {
    return this === Response ? v instanceof NodeResponse : Function.prototype[Symbol.hasInstance].call(this, v);
  }

  constructor(body?: ConstructorParameters<typeof NodeResponse>[0], init?: ResponseInit & { webSocket?: unknown }) {
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
/** The globals the polyfill replaces (WebSocketPair isn't one of Node's). */
const g = globalThis as unknown as { WebSocketPair?: unknown; Response: typeof NodeResponse };

/** Install the globals (refcounted); returns `uninstall`, which restores Node's own when the last user goes. */
export function installWebSocketPolyfill({ onListenerError }: { onListenerError?: Reporter } = {}): () => void {
  const reporter = { fn: onListenerError };
  reporters.push(reporter);
  if (installs++ === 0) {
    g.WebSocketPair ??= WebSocketPair;
    if (g.Response === NodeResponse) g.Response = Response;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reporters.splice(reporters.indexOf(reporter), 1);
    if (--installs) return;
    if (g.Response === Response) g.Response = NodeResponse;
    if (g.WebSocketPair === WebSocketPair) delete g.WebSocketPair;
  };
}

// The app picks the subprotocol (Sec-WebSocket-Protocol response header) and may add headers.
const upgrades = new WeakMap<IncomingMessage, Response>(); // req → app Response
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
export async function completeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, response: Response): Promise<number> {
  const client: unknown = response.status === 101 ? (response as { webSocket?: unknown }).webSocket : null;
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
  // Socket callbacks run in the context of the upgrade request (cresslet dev: the app's bindings, sdk/index.js).
  const bind = <F extends Parameters<typeof AsyncResource.bind>[0]>(fn: F): F => AsyncResource.bind(fn);
  wss.handleUpgrade(req, socket, head, bind((ws) => {
    // Listeners first: accept() delivers what the app sent before returning the 101 (e.g. a welcome).
    client.addEventListener("message", bind((e: Event) => ws.send((e as MessageEvent).data)));
    client.addEventListener("close", bind((e: Event) => {
      const { code, reason } = e as Event & { code: number; reason: string }; // from close() above
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
    }));
    ws.on("message", bind((data: RawData, isBinary: boolean) => {
      if (client.readyState !== 1) return;
      // (ws's default binaryType: a Buffer)
      client.send(isBinary ? new Uint8Array(data as Buffer) : data.toString());
    }));
    ws.on("close", bind((code: number, reason: Buffer) => client.close(code, reason.toString())));
    ws.on("error", bind((err: Error) => client.peer!._receive("error", { error: err, message: err.message })));
    client.accept();
  }));
  return 101;
}
