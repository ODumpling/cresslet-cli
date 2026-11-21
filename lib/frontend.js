// Studio parity for client builds: what cresslet-container compiles in the browser, the CLI compiles with esbuild.
// Sass / Less, PostCSS (project config), Tailwind CSS v4, CSS modules, Vue and Svelte single-file components (all with
// the project's own packages, through the container's compilers vendored in ./compilers.cjs), `?raw` / `?url` imports,
// root-relative `url()`s and `%VITE_X%` in index.html.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as esbuild from "esbuild";

const compilers = createRequire(import.meta.url)("./compilers.cjs");

/** Every stylesheet extension treated as CSS; Sass/Less are compiled first. */
export const STYLE_RE = /\.(css|s[ac]ss|less)$/;
const PREPROCESSED_RE = /\.(s[ac]ss|less)$/;
const CSS_MODULE_RE = /\.module\.(css|s[ac]ss|less)$/;
/** `.vue`, `.svelte`, and Svelte's rune modules `.svelte.js` / `.svelte.ts`. */
export const SFC_RE = /\.(?:vue|svelte)$|\.svelte\.[cm]?[jt]s$/;
const POSTCSS_CONFIGS = ["postcss.config.js", "postcss.config.mjs", "postcss.config.cjs", "postcss.config.ts",
  "postcss.config.mts", ".postcssrc.js", ".postcssrc.cjs", ".postcssrc.mjs", ".postcssrc.json"];

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
}
const depsOf = (root) => {
  const j = readPackage(root);
  return { ...j.devDependencies, ...j.dependencies };
};

/** Which CSS processing a project gets (as the container's detectCssMode). */
export function detectCssMode(root) {
  const postcssConfig = POSTCSS_CONFIGS.map((f) => path.join(root, f)).find((p) => fs.existsSync(p)) ?? null;
  const d = depsOf(root);
  return { postcssConfig, tailwind: !!(d.tailwindcss || d["@tailwindcss/postcss"] || d["@tailwindcss/vite"] || d["@tailwindcss/cli"]) };
}

/**
 * esbuild resolve conditions, as the Studio's: the mode's (`development` / `production`), and in Svelte projects
 * packages' `svelte` export (component libraries ship sources there). (browser/import/default are esbuild's own.)
 */
export function resolveConditions(root, mode) {
  return [...(depsOf(root).svelte ? ["svelte"] : []), "module", mode];
}

/** `%VITE_X%` / `%CRESSLET_PUBLIC_X%` / `%MODE%` in index.html, from the public env (unknown names left as written). */
export function htmlEnv(html, env) {
  return html.replace(/%(\w+)%/g, (m, k) => (Object.hasOwn(env, k) ? String(env[k]) : m));
}

// The compilers keep module-level state (caches, require.cache, NODE_ENV) and expect one request at a time, as the
// container's worker process runs them: esbuild's concurrent onLoad callbacks are queued.
// They also set process.env.NODE_ENV for plugins: the caller's value is put back after each request.
let queue = Promise.resolve();
const serial = (f) => {
  const p = queue.then(async () => {
    const had = Object.hasOwn(process.env, "NODE_ENV");
    const before = process.env.NODE_ENV;
    try {
      return await f();
    } finally {
      if (had) process.env.NODE_ENV = before;
      else delete process.env.NODE_ENV;
    }
  });
  queue = p.catch(() => {});
  return p;
};
let sessions = 0;

const splitQuery = (p) => {
  const from = p.startsWith("#") ? 1 : 0;
  const j = p.slice(from).search(/[?#]/);
  return j < 0 ? [p, ""] : [p.slice(0, j + from), p.slice(j + from)];
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const errorResult = (e) => ({ errors: [{ text: compilers.formatError(e) }], watchFiles: e?.deps ?? [], watchDirs: e?.dirs ?? [] });

/** A short stable id for a component (Vue's scope id), from its root-relative path (as the container's sfcId). */
export function sfcId(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * esbuild plugins for a client build: `dev` compiles in development mode (Svelte/Vue dev builds, NODE_ENV for PostCSS
 * plugins), else production. `release()` frees the compilers' state for this build.
 */
export function frontendPlugins(root, { dev = false } = {}) {
  const env = dev ? "development" : "production";
  const session = `cli-${env}-${++sessions}`;
  const scanCache = new Map(); // file -> { sig, candidates }
  const styles = new Map(); // component file -> its style blocks' CSS

  /** Stylesheet text -> CSS (Sass/Less, then PostCSS/Tailwind), plus what to watch. null: plain CSS, nothing to do. */
  async function processCss(file, css) {
    const mode = detectCssMode(root); // (re-read each time: package.json / config may change during dev)
    if (!PREPROCESSED_RE.test(file) && !mode.postcssConfig && !(mode.tailwind && compilers.TAILWIND_RE.test(css))) return null;
    const req = { root, file, css, candidates: [], postcssConfig: mode.postcssConfig, env, tailwind: mode.tailwind, plugins: true, session };
    const watchFiles = mode.postcssConfig ? [mode.postcssConfig] : [];
    const watchDirs = [];
    // Tailwind: first learn the stylesheet's sources (`@source`, `source(...)`), then build with their candidates
    let r = await serial(() => compilers.handle({ ...req, discover: mode.tailwind }));
    if (mode.tailwind && r.tailwind.length) {
      const scan = scanSources(r.tailwind, root, scanCache);
      watchFiles.push(...scan.files);
      watchDirs.push(...scan.dirs);
      r = await serial(() => compilers.handle({ ...req, candidates: scan.candidates }));
    }
    return { css: r.css, watchFiles: [...watchFiles, ...r.deps], watchDirs: [...watchDirs, ...r.dirs], warnings: r.warnings };
  }

  const css = {
    name: "cresslet-css",
    setup(b) {
      b.onLoad({ filter: STYLE_RE, namespace: "file" }, async (a) => {
        const text = await fs.promises.readFile(a.path, "utf8");
        try {
          const r = await processCss(a.path, text);
          if (!r) return undefined; // plain CSS: esbuild's own loader (`.module.css` is local-css)
          return {
            contents: r.css,
            loader: CSS_MODULE_RE.test(a.path) ? "local-css" : "css",
            resolveDir: path.dirname(a.path),
            watchFiles: r.watchFiles,
            watchDirs: r.watchDirs,
            warnings: r.warnings.map((text) => ({ text: `${a.path}: ${text}` })),
          };
        } catch (e) {
          return errorResult(e);
        }
      });
    },
  };

  const STYLE_NS = "cresslet-sfc-style";
  const sfc = {
    name: "cresslet-sfc",
    setup(b) {
      b.onLoad({ filter: SFC_RE, namespace: "file" }, async (a) => {
        let source = await fs.promises.readFile(a.path, "utf8");
        try {
          // Svelte's compileModule takes JavaScript
          if (/\.svelte\.[cm]?ts$/.test(a.path)) source = (await esbuild.transform(source, { loader: "ts", sourcefile: a.path })).code;
          const url = "/" + path.relative(root, a.path).split(path.sep).join("/");
          const r = await serial(() => compilers.compileSfc({ op: "sfc", root, file: a.path, source, hmrId: sfcId(url), session, env, plugins: true }));
          styles.set(a.path, r.styles ?? []);
          // each style block is a CSS module the component imports (bundled into the entry's stylesheet)
          const imports = (r.styles ?? []).map((_, i) => `import ${JSON.stringify(`${STYLE_NS}:${i}:${a.path}`)};\n`).join("");
          return {
            contents: r.code + "\n" + imports,
            loader: r.lang,
            resolveDir: path.dirname(a.path),
            watchFiles: r.deps,
            warnings: r.warnings.map((text) => ({ text: `${a.path}: ${text}` })),
          };
        } catch (e) {
          return errorResult(e);
        }
      });
      b.onResolve({ filter: /^cresslet-sfc-style:/ }, (a) => ({ path: a.path.slice(STYLE_NS.length + 1), namespace: STYLE_NS }));
      b.onLoad({ filter: /.*/, namespace: STYLE_NS }, async (a) => {
        const [, i, file] = /^(\d+):(.*)$/s.exec(a.path);
        const text = styles.get(file)?.[+i] ?? "";
        try {
          // named as a stylesheet beside the component (the container's styleFile), for PostCSS / Tailwind
          const r = await processCss(`${file}.${i}.css`, text);
          return {
            contents: r ? r.css : text,
            loader: "css",
            resolveDir: path.dirname(file),
            watchFiles: r?.watchFiles,
            watchDirs: r?.watchDirs,
            warnings: r?.warnings.map((text) => ({ text: `${file}: ${text}` })),
          };
        } catch (e) {
          return errorResult(e);
        }
      });
    },
  };

  const queries = {
    name: "cresslet-import-queries",
    setup(b) {
      // `import text from "./a.md?raw"`, `import href from "./logo.svg?url"` (as vite)
      b.onResolve({ filter: /\?(?:raw|url)$/ }, async (a) => {
        if (a.kind !== "import-statement" && a.kind !== "dynamic-import") return undefined;
        const [clean, query] = splitQuery(a.path);
        // `/src/a.md?raw`: from the project root, as the Studio resolves it
        const r = clean.startsWith("/") && isFile(path.join(root, clean))
          ? { path: path.join(root, clean), errors: [] }
          : await b.resolve(clean, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer });
        if (r.errors.length) return { errors: r.errors };
        return { path: r.path, namespace: query === "?raw" ? "cresslet-raw" : "cresslet-url" };
      });
      b.onLoad({ filter: /.*/, namespace: "cresslet-raw" }, async (a) => ({ contents: await fs.promises.readFile(a.path, "utf8"), loader: "text", watchFiles: [a.path] }));
      b.onLoad({ filter: /.*/, namespace: "cresslet-url" }, async (a) => ({ contents: await fs.promises.readFile(a.path), loader: "file", resolveDir: path.dirname(a.path), watchFiles: [a.path] }));
    },
  };

  const rootUrls = {
    name: "cresslet-root-urls",
    setup(b) {
      // `url(/src/logo.svg)` in a stylesheet: a project file, from the root (dev SFC styles are written so, and the dev
      // server serves the root); one in public/ is copied to the output root and stays a URL
      b.onResolve({ filter: /^\// }, (a) => {
        if (a.kind !== "url-token" && a.kind !== "import-rule") return undefined;
        const [clean, query] = splitQuery(a.path);
        if (isFile(path.join(root, "public", clean))) return { path: a.path, external: true };
        const abs = clean.startsWith("/@fs/") ? clean.slice(4) : path.join(root, clean);
        return isFile(abs) ? { path: abs, suffix: query } : undefined;
      });
    },
  };

  return { plugins: [rootUrls, queries, sfc, css], release: () => compilers.release(session) };
}

// ---- Tailwind content scanning (the container's scan.ts, over the real filesystem) ----

const SKIP_EXT = /\.(css|scss|sass|less|styl|lock|log|map|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|flac|pdf|zip|gz|tgz|br|wasm|exe|dll|so|dylib|node|db|sqlite)$/i;
const SKIP_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "npm-shrinkwrap.json"]);
const SKIP_ROOT_DIRS = new Set(["dist", "build", "coverage", "out"]);
const MAX_FILE = 2_000_000;

/** Class-candidate tokens in a source file (over-extraction is harmless: Tailwind ignores non-utilities). */
export function extractCandidates(text, into = new Set()) {
  const add = (tok) => {
    let t = tok.replace(/^[,:(]+/, "").replace(/[,.:]+$/, "");
    if (!t.includes("(")) t = t.replace(/\)+$/, "").replace(/[,.:]+$/, "");
    if (t && /[a-z]/i.test(t)) into.add(t);
  };
  for (const raw of text.split(/[\s"'`{};\\]+/)) {
    if (!raw || raw.length > 200) continue;
    add(raw);
    if (/[(),=<>]/.test(raw)) for (const p of raw.split(/[(),=<>]+/)) if (p !== raw) add(p);
  }
  return into;
}

/** Minimal glob -> RegExp (`**`, `*`, `?`, `{a,b}`), matched against an absolute path. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = end;
      }
    } else re += /[.+^$()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp("^" + re + "$");
}

const posix = (p) => p.split(path.sep).join("/");
const trimDir = (p) => p.replace(/(?<=.)\/+$/, "");
function compileSource(base, pattern) {
  const abs = trimDir(posix(path.resolve(base, pattern)));
  const segs = abs.split("/");
  const k = segs.findIndex((s) => /[*?{]/.test(s));
  if (k < 0) return { dir: abs, match: null };
  return { dir: segs.slice(0, k).join("/") || "/", match: globToRegExp(abs) };
}

/**
 * Candidates in a stylesheet's Tailwind sources: its `source(...)` root (or the project root; `source(none)`: none)
 * and its `@source` paths / globs, minus `@source not`. Auto-detected scopes skip node_modules, dot-directories and
 * dist/build/out/coverage at their root; explicit `@source` paths are scanned as given. Also returns what was read.
 */
export function scanSources(rules, root, cache = new Map()) {
  const scopes = [];
  const excludes = [];
  for (const r of rules) {
    if (r.root === null) scopes.push({ dir: trimDir(posix(root)), match: null, auto: true });
    else if (r.root !== "none") scopes.push({ dir: trimDir(posix(path.resolve(r.root.base, r.root.pattern))), match: null, auto: true });
    for (const s of r.sources) {
      const c = compileSource(s.base, s.pattern);
      if (!s.negated) scopes.push({ ...c, auto: false });
      else excludes.push(c.match ?? new RegExp("^" + c.dir.replace(/[.+^$()|[\]\\*?{}]/g, "\\$&") + "(?:/|$)"));
    }
  }
  const candidates = new Set();
  const files = new Set();
  const dirs = new Set();
  const visit = (s, p) => {
    const name = p.slice(p.lastIndexOf("/") + 1);
    if (files.has(p) || SKIP_EXT.test(name) || SKIP_NAMES.has(name) || (s.match && !s.match.test(p)) || excludes.some((r) => r.test(p))) return;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.size > MAX_FILE) return;
    files.add(p);
    const sig = `${st.mtimeMs}:${st.size}`;
    let hit = cache.get(p);
    if (!hit || hit.sig !== sig) {
      try {
        cache.set(p, (hit = { sig, candidates: extractCandidates(fs.readFileSync(p, "utf8")) }));
      } catch {
        return;
      }
    }
    for (const t of hit.candidates) candidates.add(t);
  };
  for (const s of scopes) {
    let st;
    try {
      st = fs.statSync(s.dir);
    } catch {
      continue;
    }
    if (st.isFile()) {
      visit(s, s.dir);
      continue;
    }
    const seen = new Set(); // per scope: two `@source` globs under one directory both walk it
    const stack = [{ dir: s.dir, top: true }];
    while (stack.length) {
      const d = stack.pop();
      let real;
      try {
        real = fs.realpathSync(d.dir);
      } catch {
        continue;
      }
      if (seen.has(real)) continue; // a symlink loop, or a second path to a tree already walked
      seen.add(real);
      dirs.add(d.dir);
      let entries;
      try {
        entries = fs.readdirSync(d.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = d.dir === "/" ? "/" + e.name : d.dir + "/" + e.name;
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          try {
            isDir = fs.statSync(p).isDirectory();
          } catch {
            continue; // dangling
          }
        }
        if (isDir) {
          if (s.auto && (e.name === "node_modules" || e.name.startsWith(".") || (d.top && SKIP_ROOT_DIRS.has(e.name)))) continue;
          stack.push({ dir: p, top: false });
        } else if (!(s.auto && e.name.startsWith("."))) visit(s, p); // (never .env files and the like)
      }
    }
  }
  return { candidates: [...candidates], files: [...files], dirs: [...dirs] };
}
