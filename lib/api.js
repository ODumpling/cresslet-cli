import { CliError, DEFAULT_API, readGlobal } from "./util.js";

/** Resolve API base: --api > CRESSLET_API > project link > global config > default. */
export function apiBase(flags = {}, project) {
  return String(
    flags.api ?? process.env.CRESSLET_API ?? project?.link?.api ?? readGlobal().api ?? DEFAULT_API,
  ).replace(/\/+$/, "");
}

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
        "start a server (`npm run dev` in the cresslet repo) or pass --api <url> / set CRESSLET_API",
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
    : res.status === 401 || res.status === 403
    ? "run `cresslet login`, or check .cresslet/app.json has this app's deployKey"
    : undefined;
  return new CliError(msg, hint, code);
}
