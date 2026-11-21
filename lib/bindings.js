// Local-dev implementation of the Cresslet server Env (same API as the platform sandbox).
import fs from "node:fs";
import path from "node:path";

let DatabaseSync;
async function sqlite() {
  if (!DatabaseSync) {
    // node:sqlite prints an ExperimentalWarning on some Node versions; keep dev output clean.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
    ({ DatabaseSync } = await import("node:sqlite"));
  }
  return DatabaseSync;
}

const num = (v) => (typeof v === "bigint" ? Number(v) : v);

export function safeKey(key) {
  const k = path.posix.normalize(String(key)).replace(/^\/+/, "");
  if (!k || k.startsWith("..") || k.includes("\0") || k.length > 512) throw new Error(`invalid file key: ${key}`);
  return k;
}

/**
 * True if `sql` starts with transaction control (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE), after comments and empty statements (SQLite skips a leading `;`).
 * A batch refuses those: one could commit or drop the batch's savepoint and leave a failing batch half applied.
 * Same in server/bindings.ts and studio/server-worker.js (cresslet repo).
 */
export function isTxControl(sql) {
  const rest = sql.replace(/^(?:[\s;]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/, "");
  return /^(?:begin|commit|end|rollback|savepoint|release)\b/i.test(rest);
}

/**
 * env.db.batch: the statements in one transaction (a savepoint, so it also nests in one the app opened with exec), run
 * synchronously so nothing else runs in between. Each result: rows (statements that return any), changes,
 * lastInsertRowid. Same in server/bindings.ts and studio/server-worker.js (cresslet repo).
 */
export function batch(db, statements) {
  if (!Array.isArray(statements)) throw new TypeError("batch takes an array of { sql, params }");
  const list = statements.map((s, i) => {
    if (typeof s?.sql !== "string") throw new TypeError(`batch statement ${i + 1}: sql required`);
    if (s.params !== undefined && !Array.isArray(s.params)) throw new TypeError(`batch statement ${i + 1}: params must be an array`);
    if (isTxControl(s.sql)) throw new TypeError(`batch statement ${i + 1}: transaction control isn't allowed in a batch (it is one transaction)`);
    return { sql: s.sql, params: s.params ?? [] };
  });
  const total = db.prepare("SELECT total_changes() n");
  const counts = db.prepare("SELECT changes() changes, last_insert_rowid() id");
  db.exec("SAVEPOINT cresslet_batch");
  try {
    const out = list.map(({ sql, params }, i) => {
      try {
        const before = total.get().n;
        const rows = db.prepare(sql).all(...params); // runs any statement; [] when it returns no rows
        const c = counts.get();
        return { rows, changes: total.get().n === before ? 0 : num(c.changes), lastInsertRowid: num(c.id) };
      } catch (e) {
        e.message = `batch statement ${i + 1}: ${e.message}`;
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

/** Where the `cresslet` SDK finds the env (sdk/index.js). Contract 1: env published, db.batch, "?" placeholders. */
export const RUNTIME_KEY = Symbol.for("cresslet.runtime");
export const RUNTIME_CONTRACT = 1;

export async function createEnv({ dataDir, secrets = {}, app }) {
  const DB = await sqlite();
  fs.mkdirSync(path.join(dataDir, "files", "blobs"), { recursive: true });
  const db = new DB(path.join(dataDir, "db.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const meta = new DB(path.join(dataDir, "files", "index.sqlite"));
  meta.exec(`CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const blob = (k) => path.join(dataDir, "files", "blobs", k);

  return {
    db: {
      query: async (sql, ...p) => db.prepare(sql).all(...p),
      first: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
      run: async (sql, ...p) => {
        const r = db.prepare(sql).run(...p);
        return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
      },
      exec: async (sql) => void db.exec(sql),
      batch: async (statements) => batch(db, statements),
    },
    files: {
      async put(key, body, opts = {}) {
        const k = safeKey(key);
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        fs.mkdirSync(path.dirname(blob(k)), { recursive: true });
        fs.writeFileSync(blob(k), bytes);
        const type = opts.contentType ?? (body instanceof Blob && body.type) ?? "application/octet-stream";
        meta.prepare(`INSERT INTO files (key, size, content_type, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`)
          .run(k, bytes.byteLength, type || "application/octet-stream", Date.now());
      },
      async get(key) {
        const k = safeKey(key);
        const row = meta.prepare("SELECT * FROM files WHERE key = ?").get(k);
        if (!row) return null;
        return new Response(fs.readFileSync(blob(k)), {
          headers: { "content-type": row.content_type, "content-length": String(row.size) },
        });
      },
      async delete(key) {
        const k = safeKey(key);
        meta.prepare("DELETE FROM files WHERE key = ?").run(k);
        fs.rmSync(blob(k), { force: true });
      },
      async list(prefix = "") {
        return meta.prepare(
          "SELECT key, size, content_type, updated_at FROM files WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000",
        ).all(prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%")
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
