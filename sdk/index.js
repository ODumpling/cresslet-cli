// The `cresslet` SDK: `import { db, files, secrets, app } from "cresslet"` in an app's server code.
// Bundled into the app (platform-neutral, no imports). Each Cresslet runtime (platform sandbox, `cresslet dev`, studio
// preview) publishes the app's env on globalThis[Symbol.for("cresslet.runtime")]:
//   { contract: number, runtime: string, paramStyle: "?" | "$n", env: Env | null }
// `env` is null while the app's module evaluates (bindings exist once a handler runs). `contract` grows by one with
// each addition to the env the SDK relies on; FEATURES says which contract each part of the SDK needs, so a new SDK on
// an older runtime fails with a message saying what to update. Keep in sync with docs/app-format.md (cresslet repo).

const VERSION = "0.2.0";
const KEY = Symbol.for("cresslet.runtime");
/** Runtime contract each SDK feature needs. 1: env published for the SDK, db.batch, paramStyle. */
const FEATURES = { db: 1, "db.batch": 1, files: 1, secrets: 1, app: 1 };
const CONTRACT = Math.max(...Object.values(FEATURES));

class CressletError extends Error {
  name = "CressletError";
}

function runtime(feature) {
  const rt = globalThis[KEY];
  const need = FEATURES[feature] ?? FEATURES[feature.split(".")[0]] ?? CONTRACT;
  if (!rt || typeof rt !== "object") {
    throw new CressletError(
      `cresslet: \`${feature}\` from "cresslet" needs a Cresslet runtime that supports the SDK (runtime contract ${need}, ` +
        `cresslet SDK ${VERSION}), and none was found. The platform, \`cresslet dev\` or the studio preview running this app ` +
        `is older than the SDK (update it: e.g. \`npm i -D cresslet@latest\` for \`cresslet dev\`), or this code isn't ` +
        `running on Cresslet. The \`env\` argument of fetch(req, env) works on every version.`,
    );
  }
  if (!(rt.contract >= need)) {
    throw new CressletError(
      `cresslet: \`${feature}\` needs Cresslet runtime contract ${need}, but this runtime (${rt.runtime ?? "unknown"}) ` +
        `provides contract ${rt.contract}. Update the platform / \`cresslet dev\` / studio, or use an older cresslet SDK.`,
    );
  }
  if (!rt.env) {
    throw new CressletError(
      `cresslet: \`${feature}\` was used while the app's module was loading. Bindings (db, files, secrets, app) exist ` +
        `only once a handler runs: call them inside fetch() / scheduled() or code they call, not at module top level.`,
    );
  }
  return rt;
}
const env = (feature) => runtime(feature).env;

// ---- db

/** A parameterized statement built by db.sql`...`; placeholders are written for the runtime's provider when it runs. */
// Brand, not instanceof: a query from another copy of the SDK (one a dependency bundled) is still a query.
const QUERY = Symbol.for("cresslet.query");
const isQuery = (q) => !!q && q[QUERY] === true;

class Query {
  get [QUERY]() {
    return true;
  }
  constructor(strings, values) {
    // Nested queries (db.sql fragments) are spliced in, their values kept as parameters.
    const s = [strings[0]];
    const v = [];
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
        v.push(value);
        s.push(strings[i + 1]);
      }
    });
    this.strings = Object.freeze(s);
    this.values = Object.freeze(v);
    Object.freeze(this);
  }
  /** SQL text with placeholders in `style` ("?" or "$n"), and its parameters. */
  compile(style = "?") {
    if (style !== "?" && style !== "$n") throw new CressletError(`cresslet: unknown placeholder style ${style}`);
    const sql = this.strings.reduce((acc, part, i) => acc + (style === "?" ? "?" : `$${i}`) + part);
    return { sql, params: [...this.values] };
  }
  /** `await db.sql\`...\`` runs it like db.query: the rows. */
  then(resolve, reject) {
    return db.query(this).then(resolve, reject);
  }
  catch(reject) {
    return db.query(this).catch(reject);
  }
  finally(f) {
    return db.query(this).finally(f);
  }
}

/** (sql, params) for a call: a db.sql query (no extra params), or a SQL string and its params. */
function statement(feature, q, params) {
  const rt = runtime(feature);
  if (isQuery(q)) {
    if (params.length) throw new CressletError(`cresslet: ${feature}(db.sql\`...\`) takes no extra parameters; interpolate them`);
    return [rt, q.compile(rt.paramStyle ?? "?")];
  }
  if (typeof q !== "string") throw new CressletError(`cresslet: ${feature} takes a SQL string or a db.sql\`...\` query`);
  return [rt, { sql: q, params }];
}

function sql(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new CressletError("cresslet: db.sql is a tagged template: db.sql`SELECT * FROM t WHERE id = ${id}`");
  }
  if (strings.includes(undefined)) throw new CressletError("cresslet: db.sql has an invalid escape sequence in its SQL text");
  return new Query(strings, values);
}

export const db = Object.freeze({
  sql,
  async query(q, ...params) {
    const [rt, s] = statement("db.query", q, params);
    return rt.env.db.query(s.sql, ...s.params);
  },
  async first(q, ...params) {
    const [rt, s] = statement("db.first", q, params);
    return rt.env.db.first(s.sql, ...s.params);
  },
  async run(q, ...params) {
    const [rt, s] = statement("db.run", q, params);
    return rt.env.db.run(s.sql, ...s.params);
  },
  async exec(q) {
    if (typeof q !== "string") throw new CressletError("cresslet: db.exec takes a SQL string (no parameters)");
    return env("db.exec").db.exec(q);
  },
  /** Runs the statements in one transaction (all or none), with no other statement in between. */
  async batch(statements) {
    const rt = runtime("db.batch");
    if (!Array.isArray(statements)) throw new CressletError("cresslet: db.batch takes an array of statements");
    const list = statements.map((q, i) => {
      if (isQuery(q)) return q.compile(rt.paramStyle ?? "?");
      if (typeof q === "string") return { sql: q, params: [] };
      if (q && typeof q.sql === "string") {
        if (q.params !== undefined && !Array.isArray(q.params)) {
          throw new CressletError(`cresslet: db.batch statement ${i + 1}: params must be an array`);
        }
        return { sql: q.sql, params: [...(q.params ?? [])] };
      }
      throw new CressletError(`cresslet: db.batch statement ${i + 1} is not a db.sql query, SQL string or { sql, params }`);
    });
    if (typeof rt.env.db.batch !== "function") {
      throw new CressletError(`cresslet: db.batch isn't supported by this runtime (${rt.runtime ?? "unknown"}); update it`);
    }
    return rt.env.db.batch(list);
  },
});

// ---- files

export const files = Object.freeze({
  put: (key, body, opts) => env("files").files.put(key, body, opts),
  get: (key) => env("files").files.get(key),
  delete: (key) => env("files").files.delete(key),
  list: (prefix) => env("files").files.list(prefix),
});

// ---- secrets: secrets.get(name) (required), secrets.optional(name), and plain record access (secrets.NAME)

const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const methods = {
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
export const secrets = new Proxy(Object.create(null), {
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
});

// ---- app

export const app = Object.freeze({
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
  toJSON() {
    return { ...env("app").app };
  },
});

export { CressletError, VERSION, CONTRACT };
