// `cresslet dev`: esbuild watch for client + server, local Env bindings, live reload.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  clientOptions,
  formatEsbuildError,
  parseHtml,
  rewriteHtml,
  serverEntry,
  serverOptions,
} from "./build.js";
import { createEnv } from "./bindings.js";
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
  const routes = project.config.routes ?? ["/api/*"];
  const clients = new Set();
  const sockets = new Set(); // upgraded (WebSocket) connections
  const uninstallPolyfill = installWebSocketPolyfill({
    onListenerError: (type, e) => log(color.red(`WebSocket ${type} listener error\n${e?.stack ?? e}`)),
  });
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
  let clientCtx = null;
  let entriesKey = "";
  async function setupClient() {
    const htmlFile = path.join(root, "index.html");
    if (!fs.existsSync(htmlFile)) {
      html = null;
      return;
    }
    const src = fs.readFileSync(htmlFile, "utf8");
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
      plugins: [{
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
            reportErrors();
          });
        },
      }],
    });
    await clientCtx.rebuild().catch(() => {});
    await clientCtx.watch();
  }

  // ---- server
  const env = await createEnv({
    dataDir: path.join(work, "data"),
    secrets: readDotenv(path.join(root, ".env.cresslet")),
    app: { id: "dev", name: project.config.name || path.basename(root), url: `http://${host}:${port}`, deployId: "dev" },
  });
  let serverCtx = null;
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
            try {
              const mod = await import(pathToFileURL(serverOut).href + `?v=${++serverVersion}`);
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
  const watchers = [];
  const htmlWatch = (name) => {
    if (name === "index.html") setupClient().then(reportErrors);
    if (name === "server" || name?.startsWith("server" + path.sep)) setupServer();
  };
  watchers.push(fs.watch(root, (_e, name) => htmlWatch(name)));
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
        let response = await handler(toRequest(req, url), env, { waitUntil() {} });
        if (response?.status === 101) response = new NodeResponse("101 needs an upgrade request\n", { status: 500 });
        await send(res, response);
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
    const cron = url.searchParams.get("cron") ?? project.config.crons?.[0];
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
      await scheduled({ type: "scheduled", cron, scheduledTime: Math.floor(Date.now() / 60000) * 60000 }, env, ctx);
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
      else response = await handler(toRequest(req, url), env, { waitUntil() {} });
      if (!(response instanceof NodeResponse)) throw new Error("fetch handler must return a Response");
      const status = await completeUpgrade(req, socket, head, response);
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
  return {
    url,
    async close() {
      for (const w of watchers) w.close();
      for (const c of clients) c.end();
      server.closeAllConnections?.();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      await clientCtx?.dispose();
      await serverCtx?.dispose();
      env.close();
      uninstallPolyfill();
    },
  };
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
