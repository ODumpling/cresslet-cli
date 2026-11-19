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
