// Local-dev implementation of the Cresslet server Env (same API as the platform sandbox).
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as Sqlite } from "node:sqlite";
import type { AppInfo, BatchResult, Env, Row, SQLValue } from "../sdk/index.ts";

/** The SDK's Env, plus close() for the dev server / Vite plugin that made it. */
export type DevEnv = Env & { close(): void };

let DatabaseSync: typeof Sqlite | undefined;
async function sqlite(): Promise<typeof Sqlite> {
  if (!DatabaseSync) {
    // node:sqlite prints an ExperimentalWarning on some Node versions; keep dev output clean.
    const emit = process.emitWarning;
    // (emitWarning's overloads: the arguments are passed through as given)
    process.emitWarning = ((w: string | Error, ...a: unknown[]) =>
      String(w).includes("SQLite") ? undefined : Reflect.apply(emit, process, [w, ...a])) as typeof process.emitWarning;
    ({ DatabaseSync } = await import("node:sqlite"));
  }
  return DatabaseSync;
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number)); // an INTEGER column / changes()

export function safeKey(key: unknown): string {
  const k = path.posix.normalize(String(key)).replace(/^\/+/, "");
  if (!k || k.startsWith("..") || k.includes("\0") || k.length > 512) throw new Error(`invalid file key: ${key}`);
  return k;
}

/**
 * True if `sql` is transaction control (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE), PRAGMA, ATTACH or DETACH,
 * after comments, empty statements (SQLite skips a leading `;`) and an EXPLAIN prefix. A batch refuses those: transaction
 * control could commit or drop the batch's savepoint and leave a failing batch half applied, and the others' effects
 * aren't rolled back with it.
 * Same in server/bindings.ts and studio/server-worker.js (cresslet repo).
 */
export function notInBatch(sql: string): boolean {
  // comments out (between tokens too), leading `;`, and an EXPLAIN [QUERY PLAN] prefix (EXPLAIN PRAGMA x = 1 sets it)
  const rest = sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, " ").replace(/^[\s;]+/, "")
    .replace(/^explain\s+(?:query\s+plan\s+)?/i, "");
  return /^(?:begin|commit|end|rollback|savepoint|release|pragma|attach|detach)\b/i.test(rest);
}

/**
 * env.db.batch: the statements in one transaction (a savepoint, so it also nests in one the app opened with exec), run
 * synchronously so nothing else runs in between. Each result: rows (statements that return any), changes,
 * lastInsertRowid. Same in server/bindings.ts and studio/server-worker.js (cresslet repo).
 */
export function batch(db: Sqlite, statements: unknown): BatchResult[] {
  if (!Array.isArray(statements)) throw new TypeError("batch takes an array of { sql, params }");
  const list = statements.map((s: { sql?: unknown; params?: unknown } | null | undefined, i) => {
    if (typeof s?.sql !== "string") throw new TypeError(`batch statement ${i + 1}: sql required`);
    if (s.params !== undefined && !Array.isArray(s.params)) throw new TypeError(`batch statement ${i + 1}: params must be an array`);
    if (notInBatch(s.sql)) throw new TypeError(`batch statement ${i + 1}: transaction control, PRAGMA, ATTACH and DETACH aren't allowed in a batch (it is one transaction; the others aren't rolled back with it)`);
    return { sql: s.sql, params: (s.params ?? []) as SQLValue[] }; // the values are SQLite's to accept or refuse
  });
  const total = db.prepare("SELECT total_changes() n");
  const counts = db.prepare("SELECT changes() changes, last_insert_rowid() id");
  counts.setReadBigInts(true); // a rowid past 2^53 would throw otherwise
  db.exec("SAVEPOINT cresslet_batch");
  try {
    const out = list.map(({ sql, params }, i) => {
      try {
        const before = total.get()!.n; // (one row, always)
        const rows: Row[] = db.prepare(sql).all(...params); // runs any statement; [] when it returns no rows
        const c = counts.get()!;
        return { rows, changes: total.get()!.n === before ? 0 : num(c.changes), lastInsertRowid: num(c.id) };
      } catch (e) {
        const err = e as Error; // node:sqlite throws Errors
        err.message = `batch statement ${i + 1}: ${err.message}`;
        throw e;
      }
    });
    db.exec("RELEASE cresslet_batch");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK TO cresslet_batch; RELEASE cresslet_batch");
    } catch { /* SQLite already rolled back (e.g. after SQLITE_FULL): report the statement's error */ }
    throw e;
  }
}

/** A row of the files index (files/index.sqlite). */
interface FileRow {
  key: string;
  size: number;
  content_type: string;
  updated_at: number;
}

/** Where the `cresslet` SDK finds the env (sdk/index.js). Contract 1: env published, db.batch, "?" placeholders. */
export const RUNTIME_KEY = Symbol.for("cresslet.runtime");
export const RUNTIME_CONTRACT = 1;
/** What a runtime publishes there (sdk/index.ts reads it). */
export interface PublishedRuntime {
  contract: number;
  runtime: string;
  paramStyle: "?" | "$n";
  env: Env | null;
}
/** globalThis, with the slot the SDK reads. */
export const runtimeGlobal = globalThis as typeof globalThis & { [RUNTIME_KEY]?: unknown };

export async function createEnv({ dataDir, secrets = {}, app }: { dataDir: string; secrets?: Record<string, string>; app: AppInfo }): Promise<DevEnv> {
  const DB = await sqlite();
  fs.mkdirSync(path.join(dataDir, "files", "blobs"), { recursive: true });
  const db = new DB(path.join(dataDir, "db.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const meta = new DB(path.join(dataDir, "files", "index.sqlite"));
  meta.exec(`CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const blob = (k: string) => path.join(dataDir, "files", "blobs", k);

  return {
    db: {
      // rows as SQLite returns them; `T` is the caller's description of them (as on the platform)
      query: async <T>(sql: string, ...p: SQLValue[]) => db.prepare(sql).all(...p) as T[],
      first: async <T>(sql: string, ...p: SQLValue[]) => (db.prepare(sql).get(...p) ?? null) as T | null,
      run: async (sql: string, ...p: SQLValue[]) => {
        const r = db.prepare(sql).run(...p);
        return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
      },
      exec: async (sql: string) => void db.exec(sql),
      batch: async (statements: unknown) => batch(db, statements),
    },
    files: {
      async put(key: string, body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>, opts: { contentType?: string } = {}) {
        const k = safeKey(key);
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        fs.mkdirSync(path.dirname(blob(k)), { recursive: true });
        fs.writeFileSync(blob(k), bytes);
        const type = opts.contentType ?? (body instanceof Blob && body.type) ?? "application/octet-stream";
        meta.prepare(`INSERT INTO files (key, size, content_type, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`)
          .run(k, bytes.byteLength, type || "application/octet-stream", Date.now());
      },
      async get(key: string) {
        const k = safeKey(key);
        const row = meta.prepare("SELECT * FROM files WHERE key = ?").get(k) as unknown as FileRow | undefined;
        if (!row) return null;
        return new Response(fs.readFileSync(blob(k)), {
          headers: { "content-type": row.content_type, "content-length": String(row.size) },
        });
      },
      async delete(key: string) {
        const k = safeKey(key);
        meta.prepare("DELETE FROM files WHERE key = ?").run(k);
        fs.rmSync(blob(k), { force: true });
      },
      async list(prefix = "") {
        return (meta.prepare(
          "SELECT key, size, content_type, updated_at FROM files WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000",
        ).all(prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%") as unknown as FileRow[])
          .map((r) => ({ key: r.key, size: r.size, contentType: r.content_type, updatedAt: r.updated_at }));
      },
    },
    secrets: Object.freeze({ ...secrets }),
    app: Object.freeze(app),
    close() {
      db.close();
      meta.close();
    },
  };
}
