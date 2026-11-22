// Client + server builds with esbuild. Client entry is index.html (vite-style):
// local <script type="module" src> and <link rel="stylesheet" href> outside public/ are bundled.
import fs from "node:fs";
import path from "node:path";
import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import * as esbuild from "esbuild";
import { CliError, type ProjectConfig } from "./util.ts";
import { frontendPlugins, htmlEnv, resolveConditions } from "./frontend.ts";

const ASSET_EXT = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".woff", ".woff2",
  ".ttf", ".otf", ".mp3", ".mp4", ".webm", ".wav"];

const TAG_RE = /<script\b[^>]*\btype=["']module["'][^>]*>\s*<\/script>|<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
const ATTR_RE = (name: string) => new RegExp(`\\b${name}=["']([^"']+)["']`, "i");

/** A `<script type="module" src>` / `<link rel="stylesheet" href>` in index.html that the build bundles. */
export interface HtmlEntry {
  /** the tag as written */
  tag: string;
  /** its src / href */
  ref: string;
  /** the file it names */
  file: string;
  kind: "js" | "css";
}

/** Find bundleable entries in index.html. */
export function parseHtml(html: string, root: string): HtmlEntry[] {
  const entries: HtmlEntry[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const tag = m[0];
    const isScript = tag.toLowerCase().startsWith("<script");
    const ref = tag.match(ATTR_RE(isScript ? "src" : "href"))?.[1];
    if (!ref || /^(https?:)?\/\//.test(ref) || ref.startsWith("data:")) continue;
    const clean = ref.split(/[?#]/)[0];
    const rel = clean.replace(/^\/+/, "");
    if (fs.existsSync(path.join(root, "public", rel))) continue; // served as-is
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new CliError(`index.html references missing file: ${ref}`);
    entries.push({ tag, ref, file, kind: isScript ? "js" : "css" });
  }
  return entries;
}

/**
 * The env the client sees (import.meta.env, %VITE_X% in index.html): Studio's files and precedence (.env, .env.local,
 * .env.[mode], .env.[mode].local) and value syntax, but read through publicDotenvText first, so nothing at or after a
 * multi-line value (whose continuation lines may look like `VITE_X=…`) can be published.
 */
export function publicEnv(root: string, mode: string): Record<string, string | boolean> {
  const vars: Record<string, string> = {};
  for (const f of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    Object.assign(vars, parseEnvValues(publicDotenvText(text)));
  }
  const env: Record<string, string | boolean> = { MODE: mode, DEV: mode === "development", PROD: mode === "production", BASE_URL: "/" };
  for (const [k, v] of Object.entries({ ...vars, ...process.env })) {
    if (k.startsWith("CRESSLET_PUBLIC_") || k.startsWith("VITE_")) env[k] = v as string; // (process.env: strings)
  }
  return env;
}

function hasTsconfigJsx(root: string): boolean {
  try {
    return /"jsx"\s*:/.test(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  } catch {
    return false;
  }
}

/** esbuild options for the client; `plugins`: frontendPlugins(root).plugins (Sass, Tailwind, SFCs, ...). */
export function clientOptions(
  root: string,
  entries: HtmlEntry[],
  { dev, outdir, plugins = [] }: { dev: boolean; outdir: string; plugins?: esbuild.Plugin[] },
): esbuild.BuildOptions & { metafile: true } {
  const mode = dev ? "development" : "production";
  const conditions = resolveConditions(root, mode);
  return {
    absWorkingDir: root,
    // dev: a stylesheet entry keeps its extension (src/main.scss -> src/main.scss.css), or it and a script's CSS
    // bundle (src/main.ts -> src/main.css) would be one file; prod names are hashed
    entryPoints: entries.map((e) =>
      dev && e.kind === "css" && !path.relative(root, e.file).startsWith("..")
        ? { in: e.file, out: path.relative(root, e.file).split(path.sep).join("/") }
        : e.file),
    bundle: true,
    outdir,
    outbase: root,
    format: "esm",
    splitting: true,
    platform: "browser",
    target: "es2022",
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    entryNames: dev ? "[dir]/[name]" : "[name]-[hash]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "[name]-[hash]",
    publicPath: "/assets/",
    loader: Object.fromEntries(ASSET_EXT.map((e) => [e, "file"])),
    ...(hasTsconfigJsx(root) ? {} : { jsx: "automatic" }),
    conditions,
    define: {
      "import.meta.env": JSON.stringify(publicEnv(root, mode)),
      "process.env.NODE_ENV": JSON.stringify(mode),
      global: "globalThis",
      // Vue's compile-time flags, as @vitejs/plugin-vue (and the Studio) set them
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    plugins,
    metafile: true,
    logLevel: "silent",
  };
}

/** index.html as built: `%VITE_X%` / `%CRESSLET_PUBLIC_X%` / `%MODE%` replaced from the public env. */
export function readIndexHtml(root: string, mode: string): string {
  return htmlEnv(fs.readFileSync(path.join(root, "index.html"), "utf8"), publicEnv(root, mode));
}

/** Rewrite index.html to point at built outputs. */
export function rewriteHtml(html: string, entries: HtmlEntry[], metafile: esbuild.Metafile, outdir: string, root: string): string {
  const byEntry = new Map<string, { js: string; css: string | null }>();
  for (const [out, info] of Object.entries(metafile.outputs)) {
    if (!info.entryPoint) continue;
    byEntry.set(path.resolve(root, info.entryPoint), {
      js: "/assets/" + path.relative(outdir, path.resolve(root, out)).split(path.sep).join("/"),
      css: info.cssBundle
        ? "/assets/" + path.relative(outdir, path.resolve(root, info.cssBundle)).split(path.sep).join("/")
        : null,
    });
  }
  const css: string[] = [];
  for (const e of entries) {
    const o = byEntry.get(path.resolve(e.file));
    if (!o) continue;
    if (e.kind === "js") {
      html = html.replace(e.tag, e.tag.replace(e.ref, o.js));
      if (o.css) css.push(o.css);
    } else {
      // esbuild emits a CSS entry as .css
      html = html.replace(e.tag, e.tag.replace(e.ref, o.js));
    }
  }
  if (css.length) {
    const links = css.map((h) => `<link rel="stylesheet" href="${h}">`).join("\n    ");
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${links}\n  </head>`) : links + html;
  }
  return html;
}

export function serverEntry(root: string): string | null {
  for (const f of ["server/index.ts", "server/index.tsx", "server/index.js", "server/index.mjs"]) {
    if (fs.existsSync(path.join(root, f))) return path.join(root, f);
  }
  return null;
}

export function serverOptions(root: string, entry: string, outfile: string, { dev = false }: { dev?: boolean } = {}): esbuild.BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["worker", "browser", "import", "default"],
    external: ["node:*"],
    minify: false,
    sourcemap: dev ? "inline" : false,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    logLevel: "silent",
  };
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

/** esbuild's errors (a BuildFailure, a result, or `{ errors: warnings }`) as text; anything else thrown: its message. */
export function formatEsbuildError(e: unknown): string {
  const { errors, message } = e as { errors?: esbuild.Message[]; message: string };
  if (!errors?.length) return message;
  return errors.map((m) =>
    m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ${m.text}` : m.text
  ).join("\n");
}

/**
 * cresslet.json `build`: the app's own framework build (Vite: TanStack Start, …) instead of index.html +
 * server/index.ts. `{ command, static, server?, dev? }`: `command` builds; `static` is the folder it writes the site to
 * (served as-is); `server` is the fetch-handler module it writes (`export default { fetch }`), bundled with its
 * imports into the one server.js the platform runs; `dev` is what `cresslet dev` runs. Null when there's none.
 */
export interface FrameworkBuild {
  command: string;
  static: string;
  server: string | null;
  dev: string | null;
}

export function frameworkBuild(config: ProjectConfig | null | undefined): FrameworkBuild | null {
  const b = config?.build;
  if (b === undefined || b === null) return null;
  const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const o = b as Record<string, unknown>; // (an object: checked next)
  if (typeof b !== "object" || Array.isArray(b) || !str(o.command) || !str(o.static)) {
    throw new CliError('cresslet.json "build" must be { "command": "…", "static": "<dir>", "server"?: "<file>", "dev"?: "…" }');
  }
  for (const k of ["server", "dev"]) {
    if (o[k] !== undefined && !str(o[k])) throw new CliError(`cresslet.json "build.${k}" must be a non-empty string`);
  }
  // server / dev: strings or absent (checked above)
  return { command: o.command, static: o.static, server: (o.server as string | undefined) ?? null, dev: (o.dev as string | undefined) ?? null };
}

/** A path from cresslet.json, inside the project (not .cresslet/, node_modules/, .git/). */
function projectPath(root: string, rel: string, what: string): string {
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new CliError(`cresslet.json "${what}" must be a path inside the project: ${rel}`);
  }
  const bad = inside.split(path.sep).find((s) => notStatic(s, true));
  if (bad) throw new CliError(`cresslet.json "${what}" can't be inside ${bad}/: ${rel}`);
  return abs;
}

/** Runs a cresslet.json command in the project (its node_modules/.bin on PATH); output goes to stderr. */
export function runCommand(
  command: string,
  root: string,
  { env = {}, stdio = ["ignore", 2, 2] }: { env?: Record<string, string>; stdio?: StdioOptions } = {},
): { child: ChildProcess; done: Promise<number> } {
  const bin = path.join(root, "node_modules", ".bin");
  const child = spawn(command, {
    cwd: root,
    shell: true,
    stdio,
    env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 128 : code ?? 0));
  });
  return { child, done };
}

async function buildFramework(root: string, fw: FrameworkBuild): Promise<BuildOutput> {
  const outDir = projectPath(root, fw.static, "build.static");
  const entry = fw.server ? projectPath(root, fw.server, "build.server") : null;
  const code = await runCommand(fw.command, root, { env: { NODE_ENV: "production" } }).done;
  if (code !== 0) throw new CliError(`build failed: \`${fw.command}\` exited with ${code}`);
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
    throw new CliError(`\`${fw.command}\` didn't write ${fw.static} (cresslet.json "build.static")`);
  }
  let serverFile = null;
  if (entry) {
    if (!fs.existsSync(entry)) throw new CliError(`\`${fw.command}\` didn't write ${fw.server} (cresslet.json "build.server")`);
    serverFile = path.join(root, ".cresslet", "build", "server.js");
    try {
      // its chunks and node_modules imports become one module (dynamic imports included: no splitting)
      await esbuild.build({ ...serverOptions(root, entry, serverFile), minify: true });
    } catch (e) {
      throw new CliError(`server build failed:\n${formatEsbuildError(e)}`);
    }
  }
  return { outDir, serverFile, files: listFiles(outDir, { skip: notStatic }) };
}

export interface BuildOutput {
  /** the static site */
  outDir: string;
  /** the bundled server (.cresslet/build/server.js), if the app has one */
  serverFile: string | null;
  /** outDir's files, relative, `/`-separated */
  files: string[];
}

/** Production build → { outDir, serverFile|null, files }. `config`: cresslet.json (its `build`, if any). */
export async function build(root: string, { outDir = path.join(root, "dist"), config }: { outDir?: string; config?: ProjectConfig } = {}): Promise<BuildOutput> {
  const fw = frameworkBuild(config);
  if (fw) return buildFramework(root, fw);
  const htmlFile = path.join(root, "index.html");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copyDir(path.join(root, "public"), outDir);

  if (fs.existsSync(htmlFile)) {
    const html = readIndexHtml(root, "production");
    const entries = parseHtml(html, root);
    let out = html;
    if (entries.length) {
      const assets = path.join(outDir, "assets");
      const frontend = frontendPlugins(root);
      try {
        const r = await esbuild.build(clientOptions(root, entries, { dev: false, outdir: assets, plugins: frontend.plugins }));
        // compiler warnings (PostCSS, Sass, Svelte a11y, ...) on stderr, as the Studio shows them
        if (r.warnings.length) console.warn(`client build warnings:\n${formatEsbuildError({ errors: r.warnings })}`);
        out = rewriteHtml(html, entries, r.metafile, assets, root);
      } catch (e) {
        throw new CliError(`client build failed:\n${formatEsbuildError(e)}`);
      } finally {
        frontend.release();
      }
    }
    fs.writeFileSync(path.join(outDir, "index.html"), out);
  } else if (!fs.existsSync(path.join(root, "public"))) {
    throw new CliError("nothing to build: no index.html or public/");
  }

  let serverFile = null;
  const entry = serverEntry(root);
  if (entry) {
    serverFile = path.join(root, ".cresslet", "build", "server.js");
    try {
      await esbuild.build(serverOptions(root, entry, serverFile));
    } catch (e) {
      throw new CliError(`server build failed:\n${formatEsbuildError(e)}`);
    }
  }
  return { outDir, serverFile, files: listFiles(outDir) };
}

/** `skip(rel, isDir)`: leave a file or a whole directory out. */
export function listFiles(dir: string, { skip }: { skip?: ((rel: string, isDir: boolean) => unknown) | undefined } = {}): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (skip?.(path.relative(dir, full).split(path.sep).join("/"), e.isDirectory())) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * Project source for `cresslet deploy` (so `cresslet pull` / the studio can open it).
 * `exclude`: absolute paths left out (build output, the CLI's own config dir).
 */
/** `gitignore: false`: don't apply the top-level .gitignore here (git decides, in a checkout: `cresslet git`). */
export function listSources(root: string, { exclude = [], gitignore: useGitignore = true }: { exclude?: string[]; gitignore?: boolean } = {}): string[] {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p); // e.g. macOS /var → /private/var
    } catch {
      return path.resolve(p);
    }
  };
  root = real(root);
  const skip = exclude.map(real);
  const excluded = (abs: string) => skip.some((x) => abs === x || abs.startsWith(x + path.sep));
  if (excluded(root)) return [];
  const ignored = useGitignore ? gitignore(root) : () => false;
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (NOT_SOURCE(rel) || /(^|\/)(node_modules|\.git)$/i.test(rel) || SECRET_ENV.test(rel)) continue;
      if (e.isDirectory() && SECRET_DIR.test(rel)) continue;
      if (excluded(full) || ignored(rel, e.isDirectory())) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/** Never served from `deploy --dir`: CLI metadata (deploy key), VCS, deps, secrets; at any depth. */
export const notStatic = (rel: string, isDir: boolean): boolean => {
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  return isDir ? [".cresslet", ".git", "node_modules"].includes(name) : /^\.env/.test(name) || name === ".dev.vars";
};

/** A source file's contents as uploaded: dotenv files keep only public (client-exposed) entries (publicDotenvText). */
export function readSource(root: string, rel: string): Buffer {
  const data = fs.readFileSync(path.join(root, rel));
  if (!DOTENV.test(rel)) return data;
  return Buffer.from(publicDotenvText(new TextDecoder().decode(data)));
}

/** The container's (Studio's) dotenv value syntax: quotes stripped, `\n` in "…", unquoted ` # comment` dropped. */
function parseEnvValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n");
    } else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

// ---- publicDotenvText: verbatim from the server (cresslet server/deploys.ts), so a secret never leaves this machine
// for the server to strip. Keep the two in sync.
/**
 * Fail closed: dotenv parsers differ (multi-line quotes, escapes, values starting on the next line, `KEY: v`), so
 * only lines that every parser reads as one complete single-line entry are understood: `NAME=value`, a non-empty
 * unquoted value or a backslash-free single-line '…' / "…", optional `# comment`. Public ones (CRESSLET_PUBLIC_*,
 * VITE_*) are kept verbatim, comments are dropped, and the first line not understood ends the file.
 */
const SAFE_ENTRY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(?:[^\s"'\x60\\#][^"'\x60\\\r\n#]*|"[^"\\\r\n]*"|'[^'\\\r\n]*')[ \t]*(?:#[^"'\x60\\\r\n]*)?$/;
export function publicDotenvText(text: string): string {
  const out: string[] = [];
  for (const l of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/[\r\u2028\u2029]/.test(l)) break; // a line break to some parsers, not to others
    if (/^[ \t]*$/.test(l)) out.push(l);
    else if (!/^[ \t]*#/.test(l)) {
      const m = SAFE_ENTRY.exec(l);
      if (!m) break; // anything else may open a value that runs on: drop it and the rest
      if (/^(?:CRESSLET_PUBLIC_|VITE_)/.test(m[1])) out.push(l);
    }
  }
  return out.join("\n");
}

// .cresslet/ at any depth: a nested app's link holds its deploy key.
const NOT_SOURCE = (rel: string) => rel === "dist" || /(^|\/)\.cresslet$/i.test(rel);
// Same rules as the server (NOT_SOURCE / DOTENV in server/deploys.ts): secrets never leave the machine. Left out:
// `.env*` directories, `.env*local*` / `.env*cresslet*` files, `.envrc*`, `.dev.vars*`.
const SECRET_ENV = /(?:^|\/)\.env[^/]*(?:local|cresslet)[^/]*$|(?:^|\/)(?:\.envrc[^/]*|\.dev\.vars(?:[._-][^/]*)?)$/i;
const SECRET_DIR = /(?:^|\/)\.env[^/]*$/i;
// Any other `.env*` name (.env, .env.production, .ENV_BACKUP, `.env~`, `.env copy`) is sanitized.
const DOTENV = /(?:^|\/)\.env[^/]*$/i;

/** Simple top-level .gitignore patterns (globs, `/`-anchored, trailing `/`); negations are ignored. */
function gitignore(root: string): (rel: string, isDir: boolean) => boolean {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/);
  } catch { /* none */ }
  const rules = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!")).map((p) => {
    const dirOnly = p.endsWith("/");
    p = p.replace(/\/+$/, "");
    const anchored = p.includes("/");
    const re = p.replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\0").replace(/\*\*/g, "\x01").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
      .replace(/\0/g, "(?:.*/)?").replace(/\x01/g, ".*");
    return { dirOnly, re: new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`) };
  });
  return (rel: string, isDir: boolean) => rules.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));
}
