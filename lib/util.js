import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API = "http://localhost:8787";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const color = { dim: c(2), bold: c(1), green: c(32), red: c(31), yellow: c(33), cyan: c(36) };

export class CliError extends Error {
  constructor(message, hint, code) {
    super(message);
    this.hint = hint;
    this.code = code; // server error code, e.g. "too_large"
  }
}

/** Parse argv into { _: positional[], flags }. `bool` lists flags that never take a value. */
export function parseArgs(argv, { bool = [], alias = {} } = {}) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      let [k, v] = a.replace(/^--?/, "").split(/=(.*)/s, 2);
      k = alias[k] ?? k;
      if (v === undefined && !bool.includes(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
        v = argv[++i];
      }
      out.flags[k] = v === undefined ? true : v;
    } else out._.push(a);
  }
  return out;
}

// ---- global config (~/.config/cresslet/config.json)
export const configDir = () => process.env.CRESSLET_CONFIG_DIR ?? path.join(os.homedir(), ".config", "cresslet");
const configFile = () => path.join(configDir(), "config.json");

export function readGlobal() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeGlobal(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

// ---- project (cresslet.json + .cresslet/app.json)
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "cresslet.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `here`: only `cwd` itself (no walking up); a static project (index.html, no cresslet.json) counts. */
export function loadProject(cwd = process.cwd(), { required = true, here = false } = {}) {
  const root = here ? (fs.existsSync(path.join(cwd, "cresslet.json")) ? path.resolve(cwd) : null) : findRoot(cwd);
  if (!root) {
    if (here && fs.existsSync(path.join(cwd, "index.html"))) return project(path.resolve(cwd), {});
    if (!required) return null;
    if (fs.existsSync(path.join(cwd, "index.html"))) return project(path.resolve(cwd), {});
    throw new CliError("no cresslet.json found", "run `cresslet init` here, or `cresslet new <dir>`");
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.join(root, "cresslet.json"), "utf8"));
  } catch (e) {
    throw new CliError(`invalid cresslet.json: ${e.message}`);
  }
  return project(root, json);
}

function project(root, json) {
  const linkFile = path.join(root, ".cresslet", "app.json");
  let link = {};
  try {
    link = JSON.parse(fs.readFileSync(linkFile, "utf8"));
  } catch { /* not deployed yet */ }
  return {
    root,
    config: json,
    link,
    /** `replace`: drop the old link (e.g. another app's deployKey) instead of merging into it. */
    saveLink(data, { replace = false } = {}) {
      if (replace) for (const k of Object.keys(link)) delete link[k];
      fs.mkdirSync(path.dirname(linkFile), { recursive: true });
      fs.writeFileSync(linkFile, JSON.stringify({ ...link, ...data }, null, 2) + "\n", { mode: 0o600 });
      Object.assign(link, data);
      ensureGitignore(root);
    },
    saveConfig(patch) {
      const file = path.join(root, "cresslet.json");
      if (!fs.existsSync(file)) return;
      Object.assign(json, patch);
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    },
  };
}

function ensureGitignore(root) {
  const f = path.join(root, ".gitignore");
  const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (!/^\.cresslet\/?$/m.test(cur)) fs.writeFileSync(f, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".cresslet\n");
}

export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readDotenv(file) {
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
