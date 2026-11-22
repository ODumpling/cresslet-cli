import { CliError, DEFAULT_API, type Flags, type Link, readGlobal } from "./util.ts";

/** Only the link matters here: a loaded project, or just where an app was deployed. */
type ProjectLike = { link?: Link } | null | undefined;

/** Resolve API base and where it came from: --api > CRESSLET_API > project link > global config > default. */
export function apiSource(flags: Flags = {}, project?: ProjectLike): { value: string; from: string } {
  const [value, from] =
    flags.api != null ? [flags.api, "--api"]
    : process.env.CRESSLET_API ? [process.env.CRESSLET_API, "CRESSLET_API"]
    : project?.link?.api ? [project.link.api, ".cresslet/app.json"]
    : readGlobal().api ? [readGlobal().api, "config"]
    : [DEFAULT_API, "default"];
  return { value: String(value).replace(/\/+$/, ""), from };
}

export const apiBase = (flags?: Flags, project?: ProjectLike): string => apiSource(flags, project).value;

export interface RequestOptions {
  /** the Response itself (e.g. a log stream), not its JSON */
  stream?: boolean;
  /** send the login token / deploy key (default) */
  auth?: boolean;
  /** this token instead of the stored one */
  token?: string;
}

/**
 * `T`: the reply's JSON as the caller reads it. It isn't validated (the API is the server's, cresslet repo): each call
 * names the fields it uses.
 */
export interface Client {
  base: string;
  token: string | undefined;
  deployKey: string | undefined;
  get<T = unknown>(path: string, options?: RequestOptions & { stream?: false }): Promise<T>;
  get(path: string, options: RequestOptions & { stream: true }): Promise<Response>;
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  del<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
}

export function client({ flags = {}, project }: { flags?: Flags; project?: ProjectLike } = {}): Client {
  const base = apiBase(flags, project);
  const token = process.env.CRESSLET_TOKEN ?? readGlobal().tokens?.[base];
  const deployKey = process.env.CRESSLET_DEPLOY_KEY ?? project?.link?.deployKey;

  async function request(method: string, path: string, body: unknown, { stream = false, auth = true, token: explicit }: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (explicit) headers.authorization = `Bearer ${explicit}`;
    else if (auth && token) headers.authorization = `Bearer ${token}`;
    if (auth && deployKey) headers["x-cresslet-deploy-key"] = deployKey;
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } }; // fetch's TypeError, its cause the network error
      throw new CliError(
        `cannot reach Cresslet at ${base} (${err.cause?.code ?? err.message})`,
        "check the server URL: `cresslet config set api <url>`, --api <url> or CRESSLET_API",
      );
    }
    if (stream) {
      if (!res.ok) throw await toError(res);
      return res;
    }
    if (!res.ok) throw await toError(res);
    return res.json();
  }

  return {
    base,
    token,
    deployKey,
    // (unchecked: the server's reply as the caller describes it)
    get: (p: string, o?: RequestOptions) => request("GET", p, undefined, o) as Promise<never>,
    post: (p, b, o) => request("POST", p, b ?? {}, o) as Promise<never>,
    put: (p, b, o) => request("PUT", p, b, o) as Promise<never>,
    patch: (p, b, o) => request("PATCH", p, b, o) as Promise<never>,
    del: (p, o) => request("DELETE", p, undefined, o) as Promise<never>,
  };
}

async function toError(res: Response): Promise<CliError> {
  let msg = `${res.status} ${res.statusText}`;
  let code: string | undefined;
  try {
    const j = (await res.json()) as { message?: string; error?: string };
    msg = j.message ?? msg;
    code = j.error;
  } catch { /* not json */ }
  const hint = code === "unclaimed"
    ? "run `cresslet login` then `cresslet claim`"
    : code === "is_page"
    ? "it's an artifact: update it with `cresslet artifact update <name> <file|dir>`, manage it with `cresslet artifact`"
    : res.status === 401 || res.status === 403
    ? "run `cresslet login`, or check .cresslet/app.json has this app's deployKey"
    : undefined;
  return new CliError(msg, hint, code);
}
