import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API = "https://cresslet.dev";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n: number) => (s: unknown): string => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const color = { dim: c(2), bold: c(1), green: c(32), red: c(31), yellow: c(33), cyan: c(36) };

export class CliError extends Error {
  declare hint: string | undefined;
  declare code: string | undefined;
  constructor(message: string, hint?: string, code?: string) {
    super(message);
    this.hint = hint;
    this.code = code; // server error code, e.g. "too_large"
  }
}

/** A flag's value: `--x v` / `--x=v`, or true for a flag without one (`--x`, or a `bool` flag). */
export type Flags = Record<string, string | true | undefined>;
export interface Args {
  _: string[];
  flags: Flags;
}

/** Parse argv into { _: positional[], flags }. `bool` lists flags that never take a value. */
export function parseArgs(argv: string[], { bool = [], alias = {} }: { bool?: string[]; alias?: Record<string, string> } = {}): Args {
  const out: Args = { _: [], flags: {} };
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

/** ~/.config/cresslet/config.json. */
export interface GlobalConfig {
  api?: string;
  /** API base → token */
  tokens?: Record<string, string>;
}

export function readGlobal(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeGlobal(cfg: GlobalConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

// ---- project (cresslet.json + .cresslet/app.json)
const linkPath = (root: string) => path.join(root, ".cresslet", "app.json");

/** .cresslet/app.json: the deployed app this project is (and the server and deploy key it was deployed with). */
export interface Link {
  name?: string;
  api?: string;
  deployKey?: string;
}

/** cresslet.json (only what the CLI reads; the rest is the server's). */
export interface ProjectConfig {
  name?: string;
  routes?: string[];
  crons?: string[];
  /** checked by frameworkBuild (lib/build.ts) */
  build?: unknown;
  [key: string]: unknown;
}

export interface Project {
  root: string;
  config: ProjectConfig;
  link: Link;
  saveLink(data: Link, options?: { replace?: boolean }): void;
  saveConfig(patch: ProjectConfig): void;
}

/** `root`'s .cresslet/app.json, or {} when there's none. */
export function readLink(root: string): Link {
  try {
    return JSON.parse(fs.readFileSync(linkPath(root), "utf8"));
  } catch {
    return {};
  }
}

/** Nearest dir with cresslet.json, or with its own link (a linked static app, e.g. pulled into a subdir). */
export function findRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "cresslet.json")) || fs.existsSync(linkPath(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `here`: only `cwd` itself (no walking up); a static project (index.html, no cresslet.json) counts. */
export function loadProject(cwd?: string, options?: { required?: true; here?: boolean }): Project;
export function loadProject(cwd?: string, options?: { required?: boolean; here?: boolean }): Project | null;
export function loadProject(cwd: string = process.cwd(), { required = true, here = false }: { required?: boolean; here?: boolean } = {}): Project | null {
  const root = here ? (fs.existsSync(path.join(cwd, "cresslet.json")) ? path.resolve(cwd) : null) : findRoot(cwd);
  if (!root) {
    if (here && (fs.existsSync(path.join(cwd, "index.html")) || fs.existsSync(linkPath(cwd)))) return project(path.resolve(cwd), {});
    if (!required) return null;
    if (fs.existsSync(path.join(cwd, "index.html"))) return project(path.resolve(cwd), {});
    throw new CliError("no cresslet.json found", "run `cresslet init` here, or `cresslet new <dir>`");
  }
  if (!fs.existsSync(path.join(root, "cresslet.json"))) return project(root, {}); // linked static app
  let json: ProjectConfig;
  try {
    json = JSON.parse(fs.readFileSync(path.join(root, "cresslet.json"), "utf8"));
  } catch (e) {
    throw new CliError(`invalid cresslet.json: ${(e as Error).message}`); // JSON.parse / fs errors
  }
  return project(root, json);
}

function project(root: string, json: ProjectConfig): Project {
  const linkFile = linkPath(root);
  const link = readLink(root); // {}: not deployed yet
  return {
    root,
    config: json,
    link,
    /** `replace`: drop the old link (e.g. another app's deployKey) instead of merging into it. */
    saveLink(data, { replace = false } = {}) {
      if (replace) for (const k of Object.keys(link) as (keyof Link)[]) delete link[k];
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

export function ensureGitignore(root: string): void {
  const f = path.join(root, ".gitignore");
  const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (!/^\.cresslet\/?$/m.test(cur)) fs.writeFileSync(f, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".cresslet\n");
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readDotenv(file: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
