/** Vite plugin: the app's Cresslet bindings (db, kv, files, secrets, app) for server code under `vite dev`. */
export declare function cresslet(options?: {
  /** Where the local db and files live. Default: .cresslet/dev/data (shared with `cresslet dev`). */
  dataDir?: string;
}): { name: string; apply: "serve"; [hook: string]: unknown };
export default cresslet;
