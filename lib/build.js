// Client + server builds with esbuild. Client entry is index.html (vite-style):
// local <script type="module" src> and <link rel="stylesheet" href> outside public/ are bundled.
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { CliError, readDotenv } from "./util.js";

const ASSET_EXT = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".woff", ".woff2",
  ".ttf", ".otf", ".mp3", ".mp4", ".webm", ".wav"];

const TAG_RE = /<script\b[^>]*\btype=["']module["'][^>]*>\s*<\/script>|<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
const ATTR_RE = (name) => new RegExp(`\\b${name}=["']([^"']+)["']`, "i");

/** Find bundleable entries in index.html. */
export function parseHtml(html, root) {
  const entries = [];
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

export function publicEnv(root, mode) {
  const vars = { ...readDotenv(path.join(root, ".env")), ...readDotenv(path.join(root, `.env.${mode}`)) };
  const env = { MODE: mode, DEV: mode === "development", PROD: mode === "production", BASE_URL: "/" };
  for (const [k, v] of Object.entries({ ...vars, ...process.env })) {
    if (k.startsWith("CRESSLET_PUBLIC_") || k.startsWith("VITE_")) env[k] = v;
  }
  return env;
}

function hasTsconfigJsx(root) {
  try {
    return /"jsx"\s*:/.test(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  } catch {
    return false;
  }
}

export function clientOptions(root, entries, { dev, outdir }) {
  const mode = dev ? "development" : "production";
  return {
    absWorkingDir: root,
    entryPoints: entries.map((e) => e.file),
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
    define: {
      "import.meta.env": JSON.stringify(publicEnv(root, mode)),
      "process.env.NODE_ENV": JSON.stringify(mode),
    },
    metafile: true,
    logLevel: "silent",
  };
}

/** Rewrite index.html to point at built outputs. */
export function rewriteHtml(html, entries, metafile, outdir, root) {
  const byEntry = new Map();
  for (const [out, info] of Object.entries(metafile.outputs)) {
    if (!info.entryPoint) continue;
    byEntry.set(path.resolve(root, info.entryPoint), {
      js: "/assets/" + path.relative(outdir, path.resolve(root, out)).split(path.sep).join("/"),
      css: info.cssBundle
        ? "/assets/" + path.relative(outdir, path.resolve(root, info.cssBundle)).split(path.sep).join("/")
        : null,
    });
  }
  const css = [];
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

export function serverEntry(root) {
  for (const f of ["server/index.ts", "server/index.tsx", "server/index.js", "server/index.mjs"]) {
    if (fs.existsSync(path.join(root, f))) return path.join(root, f);
  }
  return null;
}

export function serverOptions(root, entry, outfile, { dev = false } = {}) {
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

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

export function formatEsbuildError(e) {
  if (!e.errors?.length) return e.message;
  return e.errors.map((m) =>
    m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ${m.text}` : m.text
  ).join("\n");
}

/** Production build → { outDir, serverFile|null, files } */
export async function build(root, { outDir = path.join(root, "dist") } = {}) {
  const htmlFile = path.join(root, "index.html");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copyDir(path.join(root, "public"), outDir);

  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, "utf8");
    const entries = parseHtml(html, root);
    let out = html;
    if (entries.length) {
      const assets = path.join(outDir, "assets");
      try {
        const r = await esbuild.build(clientOptions(root, entries, { dev: false, outdir: assets }));
        out = rewriteHtml(html, entries, r.metafile, assets, root);
      } catch (e) {
        throw new CliError(`client build failed:\n${formatEsbuildError(e)}`);
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
export function listFiles(dir, { skip } = {}) {
  const out = [];
  const walk = (d) => {
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
export function listSources(root, { exclude = [] } = {}) {
  const real = (p) => {
    try {
      return fs.realpathSync(p); // e.g. macOS /var → /private/var
    } catch {
      return path.resolve(p);
    }
  };
  root = real(root);
  const skip = exclude.map(real);
  const excluded = (abs) => skip.some((x) => abs === x || abs.startsWith(x + path.sep));
  if (excluded(root)) return [];
  const ignored = gitignore(root);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (NOT_SOURCE(rel) || /(^|\/)(node_modules|\.git)$/i.test(rel) || SECRET_ENV.test(rel)) continue;
      if (excluded(full) || ignored(rel, e.isDirectory())) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/** Never served from `deploy --dir`: CLI metadata (deploy key), VCS, deps, secrets; at any depth. */
export const notStatic = (rel, isDir) => {
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  return isDir ? [".cresslet", ".git", "node_modules"].includes(name) : /^\.env/.test(name) || name === ".dev.vars";
};

/** A source file's contents as uploaded: dotenv files keep only public (client-exposed) lines. */
export function readSource(root, rel) {
  const data = fs.readFileSync(path.join(root, rel));
  if (!DOTENV.test(rel)) return data;
  const keep = data.toString("utf8").split(/\r?\n/)
    .filter((l) => (/^\s*(#|$)/.test(l) && !COMMENTED_VAR.test(l)) || /^\s*(?:export\s+)?(?:CRESSLET_PUBLIC_|VITE_)[A-Za-z0-9_]*\s*=/.test(l));
  return Buffer.from(keep.join("\n"));
}

// .cresslet/ at any depth: a nested app's link holds its deploy key.
const NOT_SOURCE = (rel) => rel === "dist" || /(^|\/)\.cresslet$/i.test(rel);
// Same rules as the server (docs/api.md): secrets never leave the machine.
const SECRET_ENV = /(^|\/)\.env(\.[^/]*)?\.(local|cresslet[^/]*)$|(^|\/)\.env\.cresslet[^/]*$|(^|\/)(\.envrc|\.dev\.vars)$/i;
// A commented-out assignment (`# STRIPE_SECRET=sk_live_…`) is a secret too.
const COMMENTED_VAR = /^\s*#\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;
const DOTENV = /(^|\/)\.env(\.[^/]*)?$/i;

/** Simple top-level .gitignore patterns (globs, `/`-anchored, trailing `/`); negations are ignored. */
function gitignore(root) {
  let lines = [];
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
  return (rel, isDir) => rules.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));
}
