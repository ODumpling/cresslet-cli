// Types for Cresslet app server code: the SDK (`import { db, files, secrets, app } from "cresslet"`), the `env`
// handler argument, and the Workers globals the runtime provides. See
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
}

/** The database as the `env` argument has it: SQL strings with `?` parameters. */
export interface EnvDatabase {
  query<T = Row>(sql: string, ...params: SQLValue[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: SQLValue[]): Promise<T | null>;
  run(sql: string, ...params: SQLValue[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /** Runs the statements in one transaction (all or none), with no other statement in between. */
  batch(statements: Statement[]): Promise<BatchResult[]>;
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
  /** Several statements, no parameters (DDL, schema setup). */
  exec(sql: string): Promise<void>;
  /**
   * Runs the statements in one transaction: all of them or (if one fails) none, with no other request's statement in
   * between. One result per statement, in order.
   */
  batch(statements: (Query<any> | string | Statement)[]): Promise<BatchResult[]>;
}

export interface Secrets {
  /** The secret's value; throws an error naming it if it isn't set. */
  get(name: string): string;
  /** The secret's value, or undefined if it isn't set. */
  optional(name: string): string | undefined;
}

/** The app's database. SQL is the provider's own dialect (SQLite). */
export declare const db: Database;
/** The app's file storage. */
export declare const files: Files;
/**
 * The app's secrets: `secrets.get("NAME")` (throws if unset), `secrets.optional("NAME")`, or record access
 * (`secrets.NAME`, `Object.keys(secrets)`). A secret named `get` or `optional` is read with secrets.get(name).
 */
export declare const secrets: Secrets & Readonly<Record<string, string>>;
/** The app's id, name, public URL and current deploy id. */
export declare const app: Readonly<AppInfo> & { toJSON(): AppInfo };

/** Thrown for SDK misuse: no runtime, used at module top level, a runtime too old for a feature, a missing secret. */
export declare class CressletError extends Error {}
/** This SDK's version. */
export declare const VERSION: string;
/** The runtime contract this SDK needs for all of its features. */
export declare const CONTRACT: number;

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
