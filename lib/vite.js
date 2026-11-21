// `import { cresslet } from "cresslet/vite"`: a Vite plugin that gives the dev server the app's bindings, so server code
// (TanStack Start server functions and routes, any Vite SSR framework) can `import { db, kv, files, secrets, app } from
// "cresslet"` under `vite dev` as it does on the platform. Same local data as `cresslet dev` (.cresslet/dev/data),
// secrets from .env.cresslet (re-read on save). Production builds don't use it: the platform provides the bindings.
import fs from "node:fs";
import path from "node:path";
import { createEnv, RUNTIME_CONTRACT, RUNTIME_KEY } from "./bindings.js";
import { readDotenv } from "./util.js";

function appName(root) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, "cresslet.json"), "utf8")).name;
    if (typeof name === "string" && name) return name;
  } catch { /* none or invalid: the folder name */ }
  return path.basename(root);
}

/** @param {{ dataDir?: string }} [options] `dataDir`: where the local db and files live (default .cresslet/dev/data). */
export function cresslet(options = {}) {
  let env = null;
  let previous;
  let runtime = null;
  const close = () => {
    if (!env) return;
    if (globalThis[RUNTIME_KEY] === runtime) globalThis[RUNTIME_KEY] = previous;
    env.close();
    env = runtime = null;
  };
  return {
    name: "cresslet",
    apply: "serve",
    async configureServer(server) {
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
      previous = globalThis[RUNTIME_KEY];
      runtime = { contract: RUNTIME_CONTRACT, runtime: "cresslet vite", paramStyle: "?", env };
      globalThis[RUNTIME_KEY] = runtime;
      server.watcher.add(secretsFile);
      const reload = (file) => {
        if (env && path.resolve(file) === secretsFile) env.secrets = Object.freeze({ ...readDotenv(secretsFile) });
      };
      server.watcher.on("change", reload).on("add", reload).on("unlink", reload);
      server.httpServer?.once("close", close);
    },
  };
}

export default cresslet;
