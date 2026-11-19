// Types for the Cresslet server runtime. See https://github.com/ODumpling/cresslet/blob/main/docs/app-format.md
type SQLValue = string | number | bigint | null | Uint8Array;

export interface Env {
  /** Per-app SQLite database. */
  db: {
    query<T = Record<string, unknown>>(sql: string, ...params: SQLValue[]): Promise<T[]>;
    first<T = Record<string, unknown>>(sql: string, ...params: SQLValue[]): Promise<T | null>;
    run(sql: string, ...params: SQLValue[]): Promise<{ changes: number; lastInsertRowid: number }>;
    exec(sql: string): Promise<void>;
  };
  /** Per-app file storage. */
  files: {
    put(
      key: string,
      body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
      opts?: { contentType?: string },
    ): Promise<void>;
    get(key: string): Promise<Response | null>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<{ key: string; size: number; contentType: string; updatedAt: number }[]>;
  };
  /** Set with `cresslet secrets set KEY=value` (claimed apps only). */
  secrets: Readonly<Record<string, string>>;
  app: { id: string; name: string; url: string; deployId: string };
}

declare global {
  interface Body {
    json<T = unknown>(): Promise<T>;
  }
}
