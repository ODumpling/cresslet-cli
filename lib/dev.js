// `cresslet dev`: esbuild watch for client + server, local Env bindings, live reload.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  clientOptions,
  formatEsbuildError,
  parseHtml,
  readIndexHtml,
  rewriteHtml,
  serverEntry,
  serverOptions,
} from "./build.js";
import { createEnv, RUNTIME_CONTRACT, RUNTIME_KEY } from "./bindings.js";
import { frontendPlugins } from "./frontend.js";
import { color, readDotenv } from "./util.js";
import { completeUpgrade, installWebSocketPolyfill, NodeResponse } from "./websocket.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};

const RELOAD = `<script type="module">
const es = new EventSource("/__cresslet/reload");
es.addEventListener("reload", () => location.reload());
es.addEventListener("error-overlay", (e) => {
  let el = document.getElementById("__cresslet_err");
  if (!el) { el = document.createElement("pre"); el.id = "__cresslet_err";
    el.style.cssText = "position:fixed;inset:0;margin:0;padding:24px;background:#1a1a1aee;color:#ff8787;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647;overflow:auto";
    document.body.append(el); }
  el.textContent = JSON.parse(e.data);
});
</script>`;

/**
 * The runtime the `cresslet` SDK reads (globalThis[RUNTIME_KEY]): one per process, shared by every dev() in it. Handlers
 * run inside `inHandler` with their own server's bindings, so a request keeps them while a rebuilt module evaluates and
 * two dev servers in one process never see each other's. Outside a handler (a module's top level, timers): the most
 * recently started server's, or none while its module loads, as on the platform.
 */
const inHandler = new AsyncLocalStorage();
const instances = [];
let prevRuntime;
const devRuntime = {
  contract: RUNTIME_CONTRACT,
  runtime: "cresslet dev",
  paramStyle: "?",
  get env() {
    const handling = inHandler.getStore();
    if (handling) return handling.env; // even while a rebuild of its server loads
    const last = instances.at(-1);
    return last && !last.loading ? last.env : null;
  },
};
function installRuntime(instance) {
  if (!instances.length) {
    prevRuntime = globalThis[RUNTIME_KEY];
    globalThis[RUNTIME_KEY] = devRuntime;
  }
  instances.push(instance);
  return () => {
    const i = instances.indexOf(instance);
    if (i < 0) return;
    instances.splice(i, 1);
    if (!instances.length && globalThis[RUNTIME_KEY] === devRuntime) globalThis[RUNTIME_KEY] = prevRuntime;
  };
}

export function matchRoute(pattern, p) {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return p === base || p.startsWith(base + "/");
  }
  return p === pattern;
}

export async function dev(project, { port = 3000, host = "localhost", log = console.log } = {}) {
  const root = project.root;
  const work = path.join(root, ".cresslet", "dev");
  const clientOut = path.join(work, "client", "assets");
  const serverOut = path.join(work, "server.mjs");
  let routes = project.config.routes ?? ["/api/*"];
  let crons = project.config.crons;
  const clients = new Set();
  const sockets = new Set(); // upgraded (WebSocket) connections
  const uninstallPolyfill = installWebSocketPolyfill({
    onListenerError: (type, e) => log(color.red(`WebSocket ${type} listener error\n${e?.stack ?? e}`)),
  });
  // The env for `import { db } from "cresslet"` (sdk/index.js), one runtime per process (devRuntime below).
  const instance = { env: null, loading: true };
  const run = (fn) => inHandler.run(instance, fn);
  const uninstallRuntime = installRuntime(instance);
  const watchers = [];
  let clientCtx = null;
  let serverCtx = null;
  let env = null;
  let frontend = null;
  let clientQueue = Promise.resolve(); // client setups, one at a time (start())
  try {
    return await start();
  } catch (e) {
    // Startup failed (e.g. port in use): undo what was set up, globals included; one failing step skips none.
    const attempt = async (f) => {
      try {
        await f();
      } catch { /* keep cleaning up; `e` is what's reported */ }
    };
    for (const w of watchers) await attempt(() => w.close());
    await attempt(() => clientQueue); // a setup a watch event started: let it finish, then dispose what it made
    await attempt(() => clientCtx?.dispose());
    await attempt(() => serverCtx?.dispose());
    await attempt(() => env?.close());
    frontend?.release();
    uninstallPolyfill();
    uninstallRuntime();
    throw e;
  }

  async function start() {
    let html = null;
    let clientError = null;
    let serverError = null;
    let handler = null;
    let scheduled = null;
    let serverVersion = 0;

    const broadcast = (event, data = "") => {
      for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const reportErrors = () => {
      const err = [clientError, serverError].filter(Boolean).join("\n\n");
      if (err) broadcast("error-overlay", err);
      else broadcast("reload");
    };

    // ---- client
    let entriesKey = "";
    frontend = frontendPlugins(root, { dev: true });
    async function setupClient() {
      const htmlFile = path.join(root, "index.html");
      if (!fs.existsSync(htmlFile)) {
        html = null;
        return;
      }
      const src = readIndexHtml(root, "development");
      let entries;
      try {
        entries = parseHtml(src, root);
        clientError = null;
      } catch (e) {
        clientError = e.message;
        log(color.red(e.message));
        return;
      }
      const key = entries.map((e) => e.file).join("|");
      const render = (metafile) => {
        html = injectReload(metafile ? rewriteHtml(src, entries, metafile, clientOut, root) : src);
      };
      if (key === entriesKey && clientCtx) {
        const r = await clientCtx.rebuild().catch(() => null);
        if (r) render(r.metafile);
        return;
      }
      entriesKey = key;
      await clientCtx?.dispose();
      clientCtx = null;
      if (!entries.length) return render(null);
      fs.rmSync(path.dirname(clientOut), { recursive: true, force: true });
      clientCtx = await esbuild.context({
        ...clientOptions(root, entries, { dev: true, outdir: clientOut }),
        plugins: [...frontend.plugins, {
          name: "cresslet-reload",
          setup(b) {
            b.onEnd((r) => {
              if (r.errors.length) {
                clientError = formatEsbuildError(r);
                log(color.red("client build error:\n" + clientError));
              } else {
                clientError = null;
                render(r.metafile);
              }
              if (r.warnings.length) log(color.yellow("client build warnings:\n" + formatEsbuildError({ errors: r.warnings })));
              reportErrors();
            });
          },
        }],
      });
      await clientCtx.rebuild().catch(() => {});
      await clientCtx.watch();
    }

    // ---- server
    env = instance.env = await createEnv({
      dataDir: path.join(work, "data"),
      secrets: readDotenv(path.join(root, ".env.cresslet")),
      app: { id: "dev", name: project.config.name || path.basename(root), url: `http://${host}:${port}`, deployId: "dev" },
    });
    const secretsFile = path.join(root, ".env.cresslet");
    // Read at startup and on every save: handlers see the new values on their next request (still frozen).
    const reloadSecrets = () => {
      env.secrets = Object.freeze({ ...readDotenv(secretsFile) });
    };
    // routes / crons follow cresslet.json; a half-written save keeps the previous values until it parses.
    let configSeen = null; // one save can fire several watch events: handle (and warn about) each text once
    const reloadConfig = () => {
      let text;
      try {
        text = fs.readFileSync(path.join(root, "cresslet.json"), "utf8");
      } catch {
        return; // mid-save (or removed): keep what we have
      }
      if (text === configSeen || !text.trim()) return; // unchanged, or truncated mid-save
      configSeen = text;
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        log(color.yellow(`cresslet.json: ${e.message} (keeping the previous routes and crons)`));
        return;
      }
      routes = json?.routes ?? ["/api/*"];
      crons = json?.crons;
    };
    async function setupServer() {
      const entry = serverEntry(root);
      if (!entry || serverCtx) return;
      serverCtx = await esbuild.context({
        ...serverOptions(root, entry, serverOut, { dev: true }),
        plugins: [{
          name: "cresslet-server-reload",
          setup(b) {
            b.onEnd(async (r) => {
              if (r.errors.length) {
                serverError = formatEsbuildError(r);
                log(color.red("server build error:\n" + serverError));
                return reportErrors();
              }
              instance.loading = true; // module top level: no bindings (as on the platform)
              try {
                const mod = await import(pathToFileURL(serverOut).href + `?v=${++serverVersion}`).finally(() => {
                  instance.loading = false;
                });
                const exp = mod.default ?? mod;
                scheduled = typeof exp?.scheduled === "function" ? exp.scheduled.bind(exp) : null;
                handler = typeof exp === "function" ? exp : exp?.fetch?.bind(exp);
                if (!handler) throw new Error("server/index must `export default { fetch(req, env) {} }`");
                serverError = null;
              } catch (e) {
                serverError = `server failed to load: ${e.stack ?? e.message}`;
                log(color.red(serverError));
              }
              reportErrors();
            });
          },
        }],
      });
      await serverCtx.rebuild().catch(() => {});
      await serverCtx.watch();
    }

    await setupClient();
    await setupServer();

    // index.html isn't part of the esbuild graph; public/ is served live.
    // Client setups run one at a time (a save can fire several watch events): events while one is queued join it.
    let queued = false;
    let fresh = false;
    const queueClient = (recreate) => {
      fresh ||= recreate;
      if (queued) return;
      queued = true;
      clientQueue = clientQueue.then(async () => {
        queued = false;
        if (fresh) entriesKey = ""; // a new context: the public env is in its defines
        fresh = false;
        await setupClient();
        reportErrors();
      }).catch((e) => log(color.red(`client setup failed\n${e?.stack ?? e}`)));
    };
    // the env files dev reads (publicEnv), whose values are in the client defines and in index.html
    const ENV_FILES = new Set([".env", ".env.local", ".env.development", ".env.development.local"]);
    const htmlWatch = (name) => {
      if (name === ".env.cresslet") reloadSecrets();
      else if (name === "cresslet.json") reloadConfig();
      else if (name === "index.html") queueClient(false);
      else if (ENV_FILES.has(name)) queueClient(true);
      if (name === "server" || name?.startsWith("server" + path.sep)) setupServer();
    };
    watchers.push(fs.watch(root, (_e, name) => htmlWatch(name)));
    // saves made while the first builds ran had no watcher yet
    reloadSecrets();
    reloadConfig();
    const pub = path.join(root, "public");
    if (fs.existsSync(pub)) watchers.push(fs.watch(pub, { recursive: true }, () => broadcast("reload")));

    const server = http.createServer(async (req, res) => {
      const started = performance.now();
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      try {
        if (url.pathname === "/__cresslet/reload") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": ok\n\n");
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        if (url.pathname === "/__cresslet/scheduled") return await runScheduled(req, res, url);
        if (routes.some((r) => matchRoute(r, url.pathname)) && serverEntry(root)) {
          if (!handler) {
            res.writeHead(503, { "content-type": "text/plain" });
            return res.end(serverError ?? "server is building");
          }
          // the response body too: a stream pulled after the handler returned still has its bindings
          const response = await run(async () => {
            let r = await handler(toRequest(req, url), env, { waitUntil() {} });
            if (r?.status === 101) r = new NodeResponse("101 needs an upgrade request\n", { status: 500 });
            await send(res, r);
            return r;
          });
          log(color.dim(`${req.method} ${url.pathname} ${response.status} ${Math.round(performance.now() - started)}ms`));
          return;
        }
        serveStatic(req, res, url);
      } catch (e) {
        log(color.red(`${req.method} ${url.pathname} 500\n${e.stack ?? e}`));
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end(`Internal Server Error\n\n${e.stack ?? e}`);
      }
    });

    // Cron triggers, by hand: POST /__cresslet/scheduled?cron=<expr> runs the server's scheduled() export.
    async function runScheduled(req, res, url) {
      const started = performance.now();
      const cron = url.searchParams.get("cron") ?? crons?.[0];
      const reply = (status, text = "") => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
        log((status < 300 ? color.dim : color.red)(`scheduled "${cron}" ${status} ${Math.round(performance.now() - started)}ms`));
      };
      if (req.method !== "POST") return reply(405, "POST /__cresslet/scheduled?cron=<expr>\n");
      // A custom header means a cross-site page can't trigger this with a CORS "simple" request.
      if (req.headers["x-cresslet-dev"] !== "1") return reply(403, "send header x-cresslet-dev: 1\n");
      if (!cron) return reply(400, "pass ?cron=<expr>\n");
      if (!scheduled) return reply(handler ? 501 : 503, handler ? "server/index has no scheduled() export\n" : (serverError ?? "server is building"));
      const pending = [];
      const ctx = {
        waitUntil(p) {
          const q = Promise.resolve(p);
          q.catch(() => {}); // handled below; not an unhandled rejection meanwhile
          pending.push(q);
        },
        passThroughOnException() {},
      };
      let failed = false;
      let error;
      try {
        await run(() => scheduled({ type: "scheduled", cron, scheduledTime: Math.floor(Date.now() / 60000) * 60000 }, env, ctx));
      } catch (e) {
        failed = true;
        error = e;
      }
      // waitUntil() work may register more work: drain until none is left.
      while (pending.length) {
        for (const r of await Promise.allSettled(pending.splice(0))) {
          if (r.status === "rejected" && !failed) {
            failed = true;
            error = r.reason;
          }
        }
      }
      if (failed) {
        log(color.red(error?.stack ?? String(error)));
        return reply(500, `${error?.stack ?? error}\n`);
      }
      reply(204);
    }

    // WebSockets: upgrades on server routes reach fetch(); a 101 + webSocket response is bridged to the client.
    server.on("upgrade", async (req, socket, head) => {
      const started = performance.now();
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      try {
        let response;
        if (!routes.some((r) => matchRoute(r, url.pathname)) || !serverEntry(root)) {
          response = new NodeResponse("Not Found", { status: 404 });
        } else if (!handler) response = new NodeResponse(serverError ?? "server is building", { status: 503 });
        else response = await run(() => handler(toRequest(req, url), env, { waitUntil() {} }));
        if (!(response instanceof NodeResponse)) throw new Error("fetch handler must return a Response");
        const status = await run(() => completeUpgrade(req, socket, head, response)); // its socket callbacks too
        log(color.dim(`WS ${url.pathname} ${status} ${Math.round(performance.now() - started)}ms`));
      } catch (e) {
        log(color.red(`WS ${url.pathname} 500\n${e.stack ?? e}`));
        socket.end("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      }
    });

    function serveStatic(req, res, url) {
      let rel;
      try {
        rel = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
      } catch {
        res.writeHead(400);
        return res.end();
      }
      // Never serve dotfiles (.env.cresslet, .cresslet/) or server source.
      if (rel.startsWith("..") || rel.split("/").some((s) => s.startsWith(".")) || rel.startsWith("server/")) {
        res.writeHead(404);
        return res.end();
      }
      const sendHtml = () => {
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        res.end(html ?? "<!doctype html><p>No index.html</p>" + RELOAD);
      };
      if (rel === "" || rel === "index.html") return sendHtml();
      const candidates = [
        path.join(pub, rel),
        rel.startsWith("assets/") ? path.join(clientOut, rel.slice(7)) : null,
        path.join(root, rel), // unbundled files referenced directly (e.g. /src/img.png)
      ].filter(Boolean);
      for (const f of candidates) {
        try {
          if (fs.statSync(f).isFile()) {
            res.writeHead(200, { "content-type": MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
            return fs.createReadStream(f).pipe(res);
          }
        } catch { /* next */ }
      }
      if (!path.posix.basename(rel).includes(".")) return sendHtml(); // SPA fallback
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    }

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const addr = server.address();
    const url = `http://${host}:${addr.port}`;
    env.app = Object.freeze({ ...env.app, url }); // the bound port (`--port 0` picks one)
    return {
      url,
      async close() {
        for (const w of watchers) w.close();
        for (const c of clients) c.end();
        server.closeAllConnections?.();
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
        await clientQueue; // a setup in flight: let it finish, then dispose what it made
        await clientCtx?.dispose();
        await serverCtx?.dispose();
        frontend.release();
        env.close();
        uninstallPolyfill();
        uninstallRuntime();
      },
    };
  }
}

function injectReload(html) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, RELOAD + "\n</body>") : html + RELOAD;
}

function toRequest(req, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function send(res, response) {
  if (!(response instanceof NodeResponse)) throw new Error("fetch handler must return a Response");
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}
