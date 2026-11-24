// `import { cresslet } from "cresslet/vite"`: a Vite plugin that gives the dev server the app's bindings, so server code
// (TanStack Start server functions and routes, any Vite SSR framework) can `import { db, kv, files, secrets, app } from
// "cresslet"` under `vite dev` as it does on the platform. Same local data as `cresslet dev` (.cresslet/dev/data),
// secrets from .env.cresslet (re-read on save). Production builds use it only for `.sql` imports (text): the platform
// provides the bindings.
import fs from "node:fs";
import path from "node:path";
import { createEnv, type DevEnv, type PublishedRuntime, RUNTIME_CONTRACT, RUNTIME_KEY, runtimeGlobal } from "./bindings.ts";
import { readDotenv } from "./util.ts";

/** What the plugin uses of Vite's dev server (ViteDevServer; this package doesn't depend on Vite). */
interface ViteDevServerLike {
  config: { root: string; server: { port?: number } };
  resolvedUrls?: { local?: string[] } | null;
  watcher: {
    add(file: string): void;
    on(event: "change" | "add" | "unlink", listener: (file: string) => void): ViteDevServerLike["watcher"];
  };
  httpServer?: { once(event: "close", listener: () => void): unknown } | null;
}

function appName(root: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, "cresslet.json"), "utf8")).name;
    if (typeof name === "string" && name) return name;
  } catch { /* none or invalid: the folder name */ }
  return path.basename(root);
}

/**
 * Vite plugin: the app's Cresslet bindings (db, kv, files, secrets, app) for server code under `vite dev`, and `.sql`
 * imports as text (dev and build: drizzle-kit's drizzle/migrations.js imports its migrations so).
 */
export function cresslet(options: {
  /** Where the local db and files live. Default: .cresslet/dev/data (shared with `cresslet dev`). */
  dataDir?: string;
} = {}): { name: string; [hook: string]: unknown } {
  let env: DevEnv | null = null;
  let previous: unknown;
  let runtime: PublishedRuntime | null = null;
  const close = () => {
    if (!env) return;
    if (runtimeGlobal[RUNTIME_KEY] === runtime) runtimeGlobal[RUNTIME_KEY] = previous;
    env.close();
    env = runtime = null;
  };
  return {
    name: "cresslet",
    load(id: string) {
      if (!id.endsWith(".sql") || id.startsWith("\0")) return null; // (`?raw` and other queries: Vite's own)
      return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
    },
    // (configureServer: `vite dev` only)
    async configureServer(server: ViteDevServerLike) {
      const root = server.config.root;
      const secretsFile = path.join(root, ".env.cresslet");
      const port = server.config.server.port ?? 5173;
      env = await createEnv({
        dataDir: path.resolve(root, options.dataDir ?? path.join(".cresslet", "dev", "data")),
        secrets: readDotenv(secretsFile),
        app: {
          id: "dev",
          name: appName(root),
          // the port Vite ended up on (it moves past a busy one)
          get url() {
            return server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ?? `http://localhost:${port}`;
          },
          deployId: "dev",
        },
      });
      previous = runtimeGlobal[RUNTIME_KEY];
      runtime = { contract: RUNTIME_CONTRACT, runtime: "cresslet vite", paramStyle: "?", env };
      runtimeGlobal[RUNTIME_KEY] = runtime;
      server.watcher.add(secretsFile);
      const reload = (file: string) => {
        if (env && path.resolve(file) === secretsFile) env.secrets = Object.freeze({ ...readDotenv(secretsFile) });
      };
      server.watcher.on("change", reload).on("add", reload).on("unlink", reload);
      server.httpServer?.once("close", close);
    },
  };
}

export default cresslet;
