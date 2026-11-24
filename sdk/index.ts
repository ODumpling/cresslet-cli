// The `cresslet` SDK: `import { db, files, secrets, app } from "cresslet"` in an app's server code.
// Bundled into the app (platform-neutral, no imports). Each Cresslet runtime (platform sandbox, `cresslet dev`, studio
// preview) publishes the app's env on globalThis[Symbol.for("cresslet.runtime")]:
//   { contract: number, runtime: string, paramStyle: "?" | "$n", env: Env | null }
// `env` is null while the app's module evaluates (bindings exist once a handler runs). `contract` grows by one with
// each addition to the env the SDK relies on; FEATURES says which contract each part of the SDK needs, so a new SDK on
// an older runtime fails with a message saying what to update. Keep in sync with docs/app-format.md (cresslet repo).
//
// One self-contained file with erasable TypeScript only: the cresslet repo vendors it into the studio by stripping its
// types (node:module stripTypeScriptTypes), and its declarations are the package's published types.
// Types: the SDK, the `env` handler argument, and the Workers globals the runtime provides. See
// https://github.com/ODumpling/cresslet/blob/main/docs/app-format.md

/** A value that can be a SQL parameter. */
export type SQLValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  /** SQLite's last_insert_rowid(). For portable code, use `INSERT ... RETURNING id` with db.first instead. */
  lastInsertRowid: number;
}
/** One statement's result in db.batch: its rows (if it returns any), and the rows it changed. */
export interface BatchResult<T = Row> extends RunResult {
  rows: T[];
}
/** A statement for env.db.batch. */
export interface Statement {
  sql: string;
  params?: SQLValue[];
  /** Its rows as arrays of values in column order (as db.raw), not objects (runtime contract 2). */
  raw?: boolean;
}

/** The database as the `env` argument has it: SQL strings with `?` parameters. */
export interface EnvDatabase {
  query<T = Row>(sql: string, ...params: SQLValue[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: SQLValue[]): Promise<T | null>;
  run(sql: string, ...params: SQLValue[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /** Runs the statements in one transaction (all or none), with no other statement in between. */
  batch(statements: Statement[]): Promise<BatchResult[]>;
  /** Rows as arrays of values in column order: columns with the same name (a join's `id`s) each keep theirs. Contract 2. */
  raw?(sql: string, ...params: SQLValue[]): Promise<unknown[][]>;
}

export interface Files {
  put(
    key: string,
    body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<void>;
  get(key: string): Promise<Response | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; size: number; contentType: string; updatedAt: number }[]>;
}

export interface AppInfo {
  id: string;
  name: string;
  url: string;
  deployId: string;
  /** The environment serving this request: "production", or "staging" (on `<app>--staging.<domain>`). */
  env?: string;
}

/** The `env` argument of fetch(req, env, ctx) and scheduled(event, env, ctx). */
export interface Env {
  /** Per-app SQLite database. */
  db: EnvDatabase;
  /** Per-app file storage. */
  files: Files;
  /** Set with `cresslet secrets set KEY=value` (claimed apps only). */
  secrets: Readonly<Record<string, string>>;
  app: AppInfo;
}

/** Argument of `scheduled(event, env, ctx)`, run for each `crons` entry in cresslet.json (UTC). */
export interface ScheduledEvent {
  type: "scheduled";
  /** The cresslet.json expression that fired. */
  cron: string;
  /** Scheduled minute, ms since epoch. */
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A parameterized statement from db.sql`...`: each `${value}` is a parameter, never SQL text, written as the
 * database's placeholder when it runs. Awaiting it runs it (the rows, like db.query).
 */
export interface Query<T = Row> extends PromiseLike<T[]> {
  readonly strings: readonly string[];
  readonly values: readonly SQLValue[];
  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T[] | R>;
  finally(onfinally?: (() => void) | null): Promise<T[]>;
}

// `Query<any>` (public API, as published before): a query of any row type is accepted where its rows aren't used.
export interface Database {
  /**
   * Tagged template: db.sql`SELECT * FROM todos WHERE id = ${id}`. Values become parameters; a nested db.sql`...` is
   * spliced in (with its parameters). Pass it to query / first / run / batch, or await it for the rows.
   */
  sql<T = Row>(strings: TemplateStringsArray, ...values: (SQLValue | Query<any>)[]): Query<T>;
  query<T = Row>(query: Query<T>): Promise<T[]>;
  query<T = Row>(sql: string, ...params: SQLValue[]): Promise<T[]>;
  first<T = Row>(query: Query<T>): Promise<T | null>;
  first<T = Row>(sql: string, ...params: SQLValue[]): Promise<T | null>;
  run(query: Query<any>): Promise<RunResult>;
  run(sql: string, ...params: SQLValue[]): Promise<RunResult>;
  /**
   * The rows as arrays of values in column order, not objects: columns with the same name (`a.id` and `b.id` in a
   * join) each keep their value. What query builders (cresslet/drizzle) use.
   */
  raw(query: Query<any>): Promise<unknown[][]>;
  raw(sql: string, ...params: SQLValue[]): Promise<unknown[][]>;
  /** Several statements, no parameters (DDL, schema setup). */
  exec(sql: string): Promise<void>;
  /**
   * Runs the statements in one transaction: all of them or (if one fails) none, with no other request's statement in
   * between. One result per statement, in order. Each item is a single statement (SQL after its first statement isn't run); no BEGIN/COMMIT/
   * SAVEPOINT, PRAGMA, ATTACH or DETACH inside. A `{ sql, params, raw: true }` statement's rows are arrays (as db.raw).
   */
  batch(statements: (Query<any> | string | Statement)[]): Promise<BatchResult[]>;
}

export interface Secrets {
  /** The secret's value; throws an error naming it if it isn't set. */
  get(name: string): string;
  /** The secret's value, or undefined if it isn't set. */
  optional(name: string): string | undefined;
}

export interface KVEntry<T = unknown> {
  key: string;
  value: T;
  /** ms since epoch, or null when it doesn't expire */
  expiresAt: number | null;
}
/** Key → JSON value store with optional TTLs, kept in the app's own database (table `_cresslet_kv`). */
export interface KV {
  /** The stored value (JSON round-tripped), or null when missing or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** `ttl`: seconds until it expires. */
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic add (default 1); missing/expired/non-number counts as 0. `ttl` applies when the counter starts (fixed window). */
  incr(key: string, by?: number, options?: { ttl?: number }): Promise<number>;
  /** Live entries with this key prefix, in key order (at most `limit`, max 1000). */
  list<T = unknown>(prefix?: string, options?: { limit?: number }): Promise<KVEntry<T>[]>;
}

declare global {
  interface Body {
    json<T = unknown>(): Promise<T>;
  }
  /** WebSockets: `const [client, server] = Object.values(new WebSocketPair()); server.accept();` */
  class WebSocketPair {
    0: WebSocket;
    1: WebSocket & { accept(): void };
  }
  interface WebSocket {
    accept(): void;
  }
  interface ResponseInit {
    /** With status 101: hand the client end of a WebSocketPair back to the caller. */
    webSocket?: WebSocket;
  }
}

/** What a runtime publishes on globalThis[KEY] (checked at each use: it may be missing, older, or not set up yet). */
interface Runtime {
  contract: number;
  runtime?: string;
  paramStyle?: string;
  env: Env | null;
}
/** A runtime whose bindings are there (a handler is running). */
type ActiveRuntime = Runtime & { env: Env };

/** This SDK's version. */
const VERSION: string = "0.5.0";
const KEY = Symbol.for("cresslet.runtime");
/**
 * Runtime contract each SDK feature needs. 1: env published for the SDK, db.batch, paramStyle. 2: env.db.raw and
 * `raw` batch statements (rows as arrays).
 */
const FEATURES: Record<string, number> = { db: 1, "db.batch": 1, "db.raw": 2, kv: 1, files: 1, secrets: 1, app: 1 };
/** The runtime contract this SDK needs for all of its features. */
const CONTRACT: number = Math.max(...Object.values(FEATURES));

/** Thrown for SDK misuse: no runtime, used at module top level, a runtime too old for a feature, a missing secret. */
class CressletError extends Error {
  override name = "CressletError";
}

function runtime(feature: string): ActiveRuntime {
  const rt = (globalThis as unknown as Record<symbol, unknown>)[KEY];
  const need = FEATURES[feature] ?? FEATURES[feature.split(".")[0]] ?? CONTRACT;
  if (!rt || typeof rt !== "object") {
    throw new CressletError(
      `cresslet: \`${feature}\` from "cresslet" needs a Cresslet runtime that supports the SDK (runtime contract ${need}, ` +
        `cresslet SDK ${VERSION}), and none was found. The platform, \`cresslet dev\` or the studio preview running this app ` +
        `is older than the SDK (update it: e.g. \`npm i -D cresslet@latest\` for \`cresslet dev\`), or this code isn't ` +
        `running on Cresslet. The \`env\` argument of fetch(req, env) works on every version.`,
    );
  }
  const r = rt as Partial<Runtime>;
  if (!((r.contract ?? NaN) >= need)) {
    throw new CressletError(
      `cresslet: \`${feature}\` needs Cresslet runtime contract ${need}, but this runtime (${r.runtime ?? "unknown"}) ` +
        `provides contract ${r.contract}. Update the platform / \`cresslet dev\` / studio, or use an older cresslet SDK.`,
    );
  }
  if (!r.env) {
    throw new CressletError(
      `cresslet: \`${feature}\` was used while the app's module was loading. Bindings (db, files, secrets, app) exist ` +
        `only once a handler runs: call them inside fetch() / scheduled() or code they call, not at module top level.`,
    );
  }
  return r as ActiveRuntime; // contract and env checked above
}
const env = (feature: string): Env => runtime(feature).env;

// ---- db

/** A parameterized statement built by db.sql`...`; placeholders are written for the runtime's provider when it runs. */
// Brand, not instanceof: a query from another copy of the SDK (one a dependency bundled) is still a query.
const QUERY: unique symbol = Symbol.for("cresslet.query");
const isQuery = (q: unknown): q is SqlQuery => !!q && (q as { [QUERY]?: unknown })[QUERY] === true;

class SqlQuery<T = Row> implements Query<T> {
  declare readonly strings: readonly string[];
  declare readonly values: readonly SQLValue[];
  get [QUERY](): true {
    return true;
  }
  constructor(strings: readonly string[], values: readonly unknown[]) {
    // Nested queries (db.sql fragments) are spliced in, their values kept as parameters.
    const s = [strings[0]];
    const v: SQLValue[] = [];
    values.forEach((value, i) => {
      if (isQuery(value)) {
        s[s.length - 1] += value.strings[0];
        for (let j = 0; j < value.values.length; j++) {
          v.push(value.values[j]);
          s.push(value.strings[j + 1]);
        }
        s[s.length - 1] += strings[i + 1];
      } else {
        if (value === undefined) throw new CressletError(`cresslet: db.sql value ${i + 1} is undefined (use null for SQL NULL)`);
        v.push(value as SQLValue); // other values are the runtime's to accept or refuse, as with db.query params
        s.push(strings[i + 1]);
      }
    });
    this.strings = Object.freeze(s);
    this.values = Object.freeze(v);
    Object.freeze(this);
  }
  /** SQL text with placeholders in `style` ("?" or "$n"), and its parameters. */
  compile(style = "?"): { sql: string; params: SQLValue[] } {
    if (style !== "?" && style !== "$n") throw new CressletError(`cresslet: unknown placeholder style ${style}`);
    const sql = this.strings.reduce((acc, part, i) => acc + (style === "?" ? "?" : `$${i}`) + part);
    return { sql, params: [...this.values] };
  }
  /** `await db.sql\`...\`` runs it like db.query: the rows. */
  then<R1 = T[], R2 = never>(
    resolve?: ((rows: T[]) => R1 | PromiseLike<R1>) | null,
    reject?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return db.query(this).then(resolve, reject);
  }
  catch<R = never>(reject?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T[] | R> {
    return db.query(this).catch(reject);
  }
  finally(f?: (() => void) | null): Promise<T[]> {
    return db.query(this).finally(f);
  }
}

/** (sql, params) for a call: a db.sql query (no extra params), or a SQL string and its params. */
function statement(feature: string, q: unknown, params: SQLValue[]): [ActiveRuntime, { sql: string; params: SQLValue[] }] {
  const rt = runtime(feature);
  if (isQuery(q)) {
    if (params.length) throw new CressletError(`cresslet: ${feature}(db.sql\`...\`) takes no extra parameters; interpolate them`);
    return [rt, q.compile(rt.paramStyle ?? "?")];
  }
  if (typeof q !== "string") throw new CressletError(`cresslet: ${feature} takes a SQL string or a db.sql\`...\` query`);
  return [rt, { sql: q, params }];
}

function sql<T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Query<T> {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new CressletError("cresslet: db.sql is a tagged template: db.sql`SELECT * FROM t WHERE id = ${id}`");
  }
  // (an invalid escape sequence's cooked string is undefined)
  if ((strings as readonly (string | undefined)[]).includes(undefined)) {
    throw new CressletError("cresslet: db.sql has an invalid escape sequence in its SQL text");
  }
  return new SqlQuery<T>(strings, values);
}

/** The app's database. SQL is the provider's own dialect (SQLite). */
export const db: Database = Object.freeze({
  sql,
  async query<T>(q: Query<T> | string, ...params: SQLValue[]): Promise<T[]> {
    const [rt, s] = statement("db.query", q, params);
    return rt.env.db.query<T>(s.sql, ...s.params);
  },
  async first<T>(q: Query<T> | string, ...params: SQLValue[]): Promise<T | null> {
    const [rt, s] = statement("db.first", q, params);
    return rt.env.db.first<T>(s.sql, ...s.params);
  },
  async run(q: Query<unknown> | string, ...params: SQLValue[]): Promise<RunResult> {
    const [rt, s] = statement("db.run", q, params);
    return rt.env.db.run(s.sql, ...s.params);
  },
  async raw(q: Query<unknown> | string, ...params: SQLValue[]): Promise<unknown[][]> {
    const [rt, s] = statement("db.raw", q, params);
    if (typeof rt.env.db.raw !== "function") {
      throw new CressletError(`cresslet: db.raw isn't supported by this runtime (${rt.runtime ?? "unknown"}); update it`);
    }
    return rt.env.db.raw(s.sql, ...s.params);
  },
  async exec(q: string): Promise<void> {
    if (typeof q !== "string") throw new CressletError("cresslet: db.exec takes a SQL string (no parameters)");
    return env("db.exec").db.exec(q);
  },
  /** Runs the statements in one transaction (all or none), with no other statement in between. */
  async batch(statements: (Query<unknown> | string | Statement)[]): Promise<BatchResult[]> {
    if (!Array.isArray(statements)) throw new CressletError("cresslet: db.batch takes an array of statements");
    const raw = statements.some((q) => !!q && typeof q === "object" && !isQuery(q) && (q as Statement).raw === true);
    const rt = runtime(raw ? "db.raw" : "db.batch");
    const list = statements.map((q: unknown, i): Statement => {
      if (isQuery(q)) return q.compile(rt.paramStyle ?? "?");
      if (typeof q === "string") return { sql: q, params: [] };
      const st = q as Partial<Statement> | null;
      if (st && typeof st.sql === "string") {
        if (st.params !== undefined && !Array.isArray(st.params)) {
          throw new CressletError(`cresslet: db.batch statement ${i + 1}: params must be an array`);
        }
        return st.raw === true ? { sql: st.sql, params: [...(st.params ?? [])], raw: true } : { sql: st.sql, params: [...(st.params ?? [])] };
      }
      throw new CressletError(`cresslet: db.batch statement ${i + 1} is not a db.sql query, SQL string or { sql, params }`);
    });
    if (typeof rt.env.db.batch !== "function") {
      throw new CressletError(`cresslet: db.batch isn't supported by this runtime (${rt.runtime ?? "unknown"}); update it`);
    }
    return rt.env.db.batch(list);
  },
});

// ---- kv: keys → JSON values with an optional TTL, kept in the app's own database (table _cresslet_kv), so it needs
// nothing from the runtime beyond db (contract 1) and lives, is backed up and is rolled back with the app's data.

const KV_TABLE = "_cresslet_kv";
const kvSchema = new WeakMap<EnvDatabase, Promise<void>>(); // env.db → Promise (once per runtime env)
const kvKey = (key: unknown): string => {
  if (typeof key !== "string" || key === "" || key.length > 512) {
    throw new CressletError("cresslet: kv keys are non-empty strings of up to 512 characters");
  }
  return key;
};
const kvTtl = (opts: { ttl?: unknown } | undefined): number | null => {
  const ttl = opts?.ttl;
  if (ttl === undefined || ttl === null) return null;
  if (typeof ttl !== "number" || !(ttl > 0) || !Number.isFinite(ttl)) throw new CressletError("cresslet: kv ttl is a number of seconds > 0");
  return Date.now() + Math.round(ttl * 1000);
};
async function kvDb(feature: string): Promise<Database> {
  const e = env(feature);
  let ready = kvSchema.get(e.db);
  if (!ready) {
    ready = e.db.exec(
      `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
       CREATE INDEX IF NOT EXISTS ${KV_TABLE}_expires ON ${KV_TABLE} (expires_at)`,
    );
    kvSchema.set(e.db, ready);
    ready.catch(() => kvSchema.delete(e.db));
  }
  await ready;
  return db;
}
/** A _cresslet_kv row as SQLite returns it. */
interface KvRow {
  key: string;
  value: string;
  expires_at: number | null;
}
const live = (now: number) => sql`(expires_at IS NULL OR expires_at > ${now})`;
// Each write also drops a few expired entries, so they don't pile up.
const sweep = (now: number) =>
  sql`DELETE FROM _cresslet_kv WHERE key IN (SELECT key FROM _cresslet_kv WHERE expires_at <= ${now} LIMIT 20)`;

export const kv: KV = Object.freeze({
  /** The value stored under `key` (as set: JSON round-tripped), or null when missing or expired. */
  async get<T>(key: string): Promise<T | null> {
    const d = await kvDb("kv.get");
    const row = await d.first(sql<Pick<KvRow, "value">>`SELECT value FROM _cresslet_kv WHERE key = ${kvKey(key)} AND ${live(Date.now())}`);
    return row ? (JSON.parse(row.value) as T) : null;
  },
  /** Stores a JSON-serializable value; `{ ttl }` (seconds) makes it expire. */
  async set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
    const k = kvKey(key);
    const text: string | undefined = JSON.stringify(value);
    if (text === undefined) throw new CressletError("cresslet: kv.set value must be JSON-serializable (not undefined)");
    const expires = kvTtl(opts);
    const d = await kvDb("kv.set");
    await d.batch([
      sql`INSERT INTO _cresslet_kv (key, value, expires_at) VALUES (${k}, ${text}, ${expires})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      sweep(Date.now()),
    ]);
  },
  /** Removes `key` (no error when it isn't there). */
  async delete(key: string): Promise<void> {
    const d = await kvDb("kv.delete");
    await d.run(sql`DELETE FROM _cresslet_kv WHERE key = ${kvKey(key)}`);
  },
  /**
   * Adds `by` (default 1) to the number under `key` atomically and returns the result; a missing, expired or
   * non-number value counts as 0. `{ ttl }` applies when the counter starts (a fixed window: rate limits).
   */
  async incr(key: string, by: number = 1, opts?: { ttl?: number }): Promise<number> {
    if (typeof by !== "number" || !Number.isFinite(by)) throw new CressletError("cresslet: kv.incr amount must be a finite number");
    const k = kvKey(key);
    const now = Date.now();
    const expires = kvTtl(opts);
    // the platform binds JS numbers as REAL: keep whole-number counters INTEGER
    const step = Number.isInteger(by) ? sql`CAST(${by} AS INTEGER)` : sql`${by}`;
    const d = await kvDb("kv.incr");
    const [res] = await d.batch([
      sql`INSERT INTO _cresslet_kv (key, value, expires_at) VALUES (${k}, ${JSON.stringify(by)}, ${expires})
          ON CONFLICT (key) DO UPDATE SET
            value = CASE WHEN expires_at <= ${now} OR json_valid(value) = 0 OR json_type(value) NOT IN ('integer', 'real')
                         THEN excluded.value ELSE CAST(value AS NUMERIC) + ${step} END,
            expires_at = CASE WHEN expires_at <= ${now} THEN excluded.expires_at ELSE expires_at END
          RETURNING value`,
      sweep(now),
    ]);
    return Number(res.rows[0].value);
  },
  /** Live entries whose key starts with `prefix`, in key order: `{ key, value, expiresAt }[]` (at most `limit`, 1000). */
  async list<T>(prefix: string = "", { limit = 1000 }: { limit?: number } = {}): Promise<KVEntry<T>[]> {
    if (typeof prefix !== "string") throw new CressletError("cresslet: kv.list prefix must be a string");
    const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 1000)));
    const d = await kvDb("kv.list");
    const like = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const rows = await d.query(
      sql<KvRow>`SELECT key, value, expires_at FROM _cresslet_kv WHERE key LIKE ${like} ESCAPE '\\' AND ${live(Date.now())}
          ORDER BY key LIMIT ${n}`,
    );
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as T, expiresAt: r.expires_at ?? null }));
  },
});

// ---- files

/** The app's file storage. */
export const files: Files = Object.freeze<Files>({
  put: (key, body, opts) => env("files").files.put(key, body, opts),
  get: (key) => env("files").files.get(key),
  delete: (key) => env("files").files.delete(key),
  list: (prefix) => env("files").files.list(prefix),
});

// ---- secrets: secrets.get(name) (required), secrets.optional(name), and plain record access (secrets.NAME)

const own = (o: object, k: PropertyKey): k is string => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const methods: Secrets = {
  get(name) {
    const all = env("secrets").secrets;
    if (!own(all, name)) {
      throw new CressletError(
        `cresslet: secret ${JSON.stringify(name)} is not set. Set it with \`cresslet secrets set ${name}=…\` ` +
          `(claimed apps), or in .env.cresslet for \`cresslet dev\` and the studio preview.`,
      );
    }
    return all[name];
  },
  optional(name) {
    const all = env("secrets").secrets;
    return own(all, name) ? all[name] : undefined;
  },
};
// The target stays empty and extensible: every trap answers from the live env.secrets.
/**
 * The app's secrets: `secrets.get("NAME")` (throws if unset), `secrets.optional("NAME")`, or record access
 * (`secrets.NAME`, `Object.keys(secrets)`). A secret named `get` or `optional` is read with secrets.get(name).
 */
export const secrets = new Proxy<object>(Object.create(null) as object, {
  get(_t, k) {
    if (k === "get" || k === "optional") return methods[k];
    if (typeof k !== "string") return undefined;
    const all = env("secrets").secrets;
    return own(all, k) ? all[k] : undefined;
  },
  has: (_t, k) => own(env("secrets").secrets, k),
  ownKeys: () => Object.keys(env("secrets").secrets),
  getOwnPropertyDescriptor(_t, k) {
    const all = env("secrets").secrets;
    return own(all, k) ? { value: all[k], enumerable: true, configurable: true, writable: false } : undefined;
  },
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
  preventExtensions: () => false, // Object.freeze(secrets) throws instead of breaking the proxy's other traps
}) as Secrets & Readonly<Record<string, string>>; // the traps above provide both

// ---- app

/** The app's id, name, public URL and current deploy id. */
export const app: Readonly<AppInfo> & { toJSON(): AppInfo } = Object.freeze({
  get id() {
    return env("app").app.id;
  },
  get name() {
    return env("app").app.name;
  },
  get url() {
    return env("app").app.url;
  },
  get deployId() {
    return env("app").app.deployId;
  },
  /** "production", or the environment (`staging`); older servers and `cresslet dev`: "production". */
  get env() {
    return env("app").app.env ?? "production";
  },
  toJSON(): AppInfo {
    return { ...env("app").app };
  },
});

export { CressletError, VERSION, CONTRACT };
