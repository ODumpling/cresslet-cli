import { CliError, DEFAULT_API, readGlobal } from "./util.js";

/** Resolve API base and where it came from: --api > CRESSLET_API > project link > global config > default. */
export function apiSource(flags = {}, project) {
  const [value, from] =
    flags.api != null ? [flags.api, "--api"]
    : process.env.CRESSLET_API ? [process.env.CRESSLET_API, "CRESSLET_API"]
    : project?.link?.api ? [project.link.api, ".cresslet/app.json"]
    : readGlobal().api ? [readGlobal().api, "config"]
    : [DEFAULT_API, "default"];
  return { value: String(value).replace(/\/+$/, ""), from };
}

export const apiBase = (flags, project) => apiSource(flags, project).value;

export function client({ flags = {}, project } = {}) {
  const base = apiBase(flags, project);
  const token = process.env.CRESSLET_TOKEN ?? readGlobal().tokens?.[base];
  const deployKey = process.env.CRESSLET_DEPLOY_KEY ?? project?.link?.deployKey;

  async function request(method, path, body, { stream = false, auth = true, token: explicit } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (explicit) headers.authorization = `Bearer ${explicit}`;
    else if (auth && token) headers.authorization = `Bearer ${token}`;
    if (auth && deployKey) headers["x-cresslet-deploy-key"] = deployKey;
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CliError(
        `cannot reach Cresslet at ${base} (${e.cause?.code ?? e.message})`,
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
    get: (p, o) => request("GET", p, undefined, o),
    post: (p, b, o) => request("POST", p, b ?? {}, o),
    put: (p, b, o) => request("PUT", p, b, o),
    patch: (p, b, o) => request("PATCH", p, b, o),
    del: (p, o) => request("DELETE", p, undefined, o),
  };
}

async function toError(res) {
  let msg = `${res.status} ${res.statusText}`;
  let code;
  try {
    const j = await res.json();
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
