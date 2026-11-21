import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { apiBase, apiSource, client } from "./api.js";
import { build, listFiles, listSources, notStatic, readSource } from "./build.js";
import { dev } from "./dev.js";
import { CliError, color, configDir, DEFAULT_API, ensureGitignore, formatBytes, loadProject, readGlobal, readLink, writeGlobal } from "./util.js";

const out = (flags, human, json) => {
  if (flags.json) console.log(JSON.stringify(json ?? human, null, 2));
  else if (typeof human === "function") human();
  else console.log(human);
};

const appName = (project, flags) => {
  const name = flags.app ?? project.link.name ?? (project.config.name || undefined);
  if (!name) throw new CliError("this app has not been deployed yet", "run `cresslet deploy` first or pass --app <name>");
  return name;
};

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- new / init
export async function cmdNew({ _: [dir], flags }) {
  if (!dir) throw new CliError("usage: cresslet new <dir> [--template react|vanilla]");
  return scaffold(path.resolve(dir), flags, true);
}

export async function cmdInit({ flags }) {
  return scaffold(process.cwd(), flags, false);
}

async function scaffold(dest, flags, isNew) {
  const template = flags.template ?? flags.t ?? "react";
  if (fs.existsSync(dest) && fs.readdirSync(dest).filter((f) => f !== ".git").length && !flags.force) {
    throw new CliError(`${dest} is not empty`, "use an empty directory or pass --force");
  }
  const api = client({ flags });
  const t = await api.get(`/v1/templates/${encodeURIComponent(template)}`, { auth: false });
  for (const f of t.files) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.encoding === "base64" ? Buffer.from(f.data, "base64") : f.data);
  }
  const pkgFile = path.join(dest, "package.json");
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.name = path.basename(dest).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  }
  // A server other than the default (--api, CRESSLET_API, config): remember it, so a later
  // `deploy` in this project can't go to cresslet.dev by accident.
  if (api.base !== DEFAULT_API) loadProject(dest, { required: false, here: true })?.saveLink({ api: api.base });
  const rel = path.relative(process.cwd(), dest) || ".";
  out(flags, () => {
    console.log(`${color.green("✔")} created ${color.bold(rel)} from template ${color.cyan(template)}\n`);
    console.log("next:");
    if (isNew) console.log(`  cd ${rel}`);
    console.log("  npm install");
    console.log("  npm run dev        # http://localhost:3000");
    console.log("  npx cresslet deploy");
  }, { dir: dest, template, files: t.files.map((f) => f.path) });
}

export async function cmdTemplates({ flags }) {
  const r = await client({ flags }).get("/v1/templates", { auth: false });
  out(flags, () => {
    for (const t of r.templates) console.log(`${color.bold(t.name.padEnd(12))} ${t.description ?? ""}`);
  }, r);
}

// ---------------------------------------------------------------- dev / build
export async function cmdDev({ flags }) {
  const project = loadProject();
  const port = Number(flags.port ?? flags.p ?? process.env.PORT ?? 3000);
  const d = await dev(project, { port, host: flags.host ?? "localhost" });
  console.log(`${color.green("✔")} dev server ${color.bold(d.url)}  ${color.dim("(ctrl+c to stop)")}`);
  for (const cron of project.config.crons ?? []) {
    console.log(color.dim(`  cron "${cron}": curl -X POST -H 'x-cresslet-dev: 1' '${d.url}/__cresslet/scheduled?cron=${encodeURIComponent(cron)}'`));
  }
  const stop = async () => {
    await d.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export async function cmdBuild({ flags }) {
  const project = loadProject();
  const t = performance.now();
  const r = await build(project.root);
  out(flags, () => {
    console.log(`${color.green("✔")} built ${r.files.length} files → ${path.relative(process.cwd(), r.outDir) || "."}` +
      (r.serverFile ? ` + server` : "") + color.dim(` (${Math.round(performance.now() - t)}ms)`));
  }, { outDir: r.outDir, serverFile: r.serverFile, files: r.files });
}

// ---------------------------------------------------------------- deploy
/**
 * `deploy [target]`: one command for apps and artifacts.
 * Artifact: a single .html file, `--artifact` (or an artifact setting), or a folder deployed as one before.
 * App: a project (cresslet.json), a linked app, or any other static folder (public, as before).
 */
export async function cmdDeploy({ _: [target], flags }) {
  const art = artifactTarget(target, flags);
  if (art) return deployArtifact(art, flags);
  // e.g. `deploy dist` in a project: its build output isn't an app of its own (a linked one, e.g. pulled there, is).
  const abs = path.resolve(target ?? ".");
  if (target && !fs.existsSync(path.join(abs, "cresslet.json")) && !readLink(abs).name) {
    for (let d = path.dirname(abs); d !== path.dirname(d); d = path.dirname(d)) {
      if (!fs.existsSync(path.join(d, "cresslet.json"))) continue;
      const rel = path.relative(process.cwd(), d) || ".";
      throw new CliError(`${target} is inside the app project ${rel}`,
        `deploy the app: cresslet deploy (from ${rel}); or this folder as an artifact: cresslet deploy ${target} --artifact`);
    }
  }
  const project = target ? loadProject(path.resolve(target), { here: true }) : loadProject();
  const api = client({ flags, project });
  // A static folder's first deploy: say up front that it's public, and what to use instead.
  const staticFirst = !fs.existsSync(path.join(project.root, "cresslet.json")) && !project.link.name;
  const t0 = performance.now();

  const warn = (msg) => !flags.json && process.stderr.write(color.yellow(msg + "\n"));
  if (staticFirst) warn(`${target ?? "this folder"} has no cresslet.json: it goes live as a public app that anyone can open`);
  let staticDir, serverFile;
  if (flags.dir) {
    staticDir = path.resolve(flags.dir);
    if (!fs.existsSync(staticDir)) throw new CliError(`--dir not found: ${flags.dir}`);
    // Every component of the resolved path (also outside this project, e.g. a sibling's node_modules).
    const bad = fs.realpathSync(staticDir).split(path.sep).find((s) => s && notStatic(s, true));
    if (bad) throw new CliError(`refusing to deploy --dir ${flags.dir}: inside ${bad}/ (never served)`);
    serverFile = flags.server ? path.resolve(flags.server) : null;
  } else {
    const r = await build(project.root);
    staticDir = r.outDir;
    serverFile = r.serverFile;
  }

  let fileBytes = 0;
  const skipped = [];
  // --dir is any folder (often `.`): never serve its deploy key, secrets, .git or deps.
  const skip = flags.dir && ((rel, isDir) => notStatic(rel, isDir) && skipped.push(isDir ? `${rel}/` : rel));
  const files = listFiles(staticDir, { skip }).map((p) => {
    const data = fs.readFileSync(path.join(staticDir, p));
    fileBytes += data.length;
    return { path: p, data: data.toString("base64"), encoding: "base64" };
  });
  if (skipped.length) warn(`not uploaded from --dir (never served): ${skipped.join(", ")}`);
  const server = serverFile ? fs.readFileSync(serverFile, "utf8") : null;
  const bytes = fileBytes + (server?.length ?? 0);
  const name = flags.name ?? project.link.name ?? (project.config.name || undefined);
  // A static folder (no cresslet.json) has no project source to keep.
  const sources = flags["no-source"] || !fs.existsSync(path.join(project.root, "cresslet.json"))
    ? undefined
    : readSources(project.root, { exclude: [staticDir, configDir()], used: { files: files.length, bytes: fileBytes }, warn });

  if (!flags.json) process.stderr.write(color.dim(`deploying ${files.length} files (${formatBytes(bytes)}) to ${api.base}…\n`));
  const body = {
    app: name,
    files,
    server,
    config: { routes: project.config.routes, crons: project.config.crons },
    source: "cli",
    sources,
  };
  let r;
  try {
    r = await api.post("/v1/deploys", body);
  } catch (e) {
    // A server with lower limits than the defaults: deploy without the source rather than fail.
    if (!sources || e.code !== "too_large" || !/source included/.test(e.message)) throw e;
    warn(`source not uploaded (${e.message}); \`cresslet pull\` won't have this deploy`);
    r = await api.post("/v1/deploys", { ...body, sources: undefined });
  }
  if (r.deployKey) project.saveLink({ name: r.app.name, deployKey: r.deployKey, api: api.base });
  else if (project.link.name !== r.app.name || !project.link.api) project.saveLink({ name: r.app.name, api: api.base });
  if (!project.config.name) project.saveConfig({ name: r.app.name });

  out(flags, () => {
    console.log(`${color.green("✔")} deployed app ${color.bold(r.app.name)} ${color.dim(`(${r.deploy.id}, ${Math.round(performance.now() - t0)}ms)`)}`);
    console.log(`  ${color.cyan(r.app.url)}`);
    if (!r.app.claimed) {
      console.log(color.yellow(`  unclaimed: expires ${new Date(r.app.expiresAt).toLocaleString()}; no outbound fetch or secrets.`));
      console.log(color.dim("  keep it: cresslet login && cresslet claim"));
    }
    if (staticFirst) {
      const t = target ? ` ${target}` : "";
      console.log(color.dim(`  private, link-only or expiring instead? cresslet deploy${t} --artifact, then take this app down: ${target ? `cd ${target} && ` : ""}cresslet delete`));
    }
  }, { kind: "app", ...r });
}

// ---------------------------------------------------------------- deploy: artifacts
const ARTIFACT_FLAGS = ["artifact", "visibility", "keep", "title"];

/**
 * Links from a file or folder to the artifact it was deployed as, in `.cresslet/artifacts.json` next to it (keyed by its
 * name): outside a folder, so rebuilding it (e.g. `dist/`) keeps the link.
 */
function artifactLink(abs) {
  const dir = path.dirname(abs);
  const key = path.basename(abs);
  const file = path.join(dir, ".cresslet", "artifacts.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* none yet */ }
  return {
    get: Object.hasOwn(all, key) ? all[key] : undefined,
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...all, [key]: data }, null, 2) + "\n");
      if (inGitRepo(dir)) ensureGitignore(dir); // not a .gitignore in e.g. ~/Downloads
    },
  };
}

const inGitRepo = (dir) => {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
};

/** What `deploy [target]` publishes as an artifact, or null for an app. */
function artifactTarget(target, flags) {
  const abs = path.resolve(target ?? ".");
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new CliError(`not found: ${target}`);
  }
  const isFile = st.isFile();
  const link = artifactLink(abs);
  const asked = ARTIFACT_FLAGS.filter((k) => flags[k] !== undefined);
  if (!isFile && !asked.length && !link.get) return null;
  if (flags.dir || flags.server) throw new CliError("--dir and --server are for apps", "an artifact is the file or folder you name: cresslet deploy <file.html|dir>");
  if (!isFile && fs.existsSync(path.join(abs, "cresslet.json"))) {
    throw new CliError(`${target ?? "this folder"} is an app project (cresslet.json): apps are always public`,
      `to publish its built site as an artifact instead: cresslet build && cresslet deploy dist --${asked[0] ?? "artifact"}${asked[0] && asked[0] !== "artifact" ? " …" : ""}`);
  }
  return { target: target ?? ".", link };
}

/** Upload a file or folder as an artifact: the linked one (or `--name`) gets the new files at the same URL, else a new one. */
async function deployArtifact({ target, link }, flags) {
  const api = client({ flags, project: link.get?.api ? { link: { api: link.get.api } } : undefined }); // the server it went to
  if (!api.token) throw new CliError("artifacts need a login", "run `cresslet login` (apps can deploy without one: cresslet deploy <folder> without artifact flags)");
  const { content, title } = pageContent(target);
  const settings = pageSettings(flags);
  if (flags.name === true || flags.name === "") throw new CliError("usage: cresslet deploy <file.html|dir> --name <address>");
  const linked = link.get?.api === api.base ? link.get : undefined;
  const name = flags.name === undefined ? linked?.name : String(flags.name);
  let cur, r, gone = false;
  if (name) {
    try {
      cur = (await api.get(`/v1/pages/${encodeURIComponent(name)}`)).page;
    } catch (e) {
      // 403: someone else's (a token that can't create artifacts is refused by the POST below).
      if (e.code !== "not_found" && e.code !== "forbidden") throw e;
    }
    // The linked artifact expired or was deleted (its address may even be another artifact's by now).
    if (flags.name === undefined && (!cur || (linked.id && cur.id !== linked.id))) [cur, gone] = [undefined, true];
  }
  if (cur) r = await replaceArtifact(api, cur, content, settings);
  else {
    // `--name`: made under that address. A linked one that's gone: a new one (its old address and who could open it
    // aren't reused without asking: pass --name to take the address again).
    r = await api.post("/v1/pages", { ...(name && !gone ? { name } : {}), title, ...settings, ...content, source: "cli" });
  }
  let saved = true;
  try {
    link.save({ name: r.page.name, id: r.page.id, api: api.base });
  } catch (e) {
    saved = false; // it's live anyway: say where, and how to update it
    if (!flags.json) process.stderr.write(color.yellow(`couldn't save the link (${e.code ?? e.message}): deploy it again with --name ${r.page.name}\n`));
  }
  out(flags, () => {
    if (gone) console.log(color.yellow(`${name} is gone (expired, deleted, or not this account's): this is a new artifact at a new address (--name ${name} to take the old one again)`));
    console.log(`${color.green("✔")} deployed artifact ${color.bold(r.page.name)} ${color.dim(cur ? "(updated, same link)" : "(new)")}`);
    showPage(r.page);
    if (r.page.visibility === "private") console.log(color.dim(`  share it: ${api.base}/#/share/${encodeURIComponent(r.page.name)}`));
  }, { kind: "artifact", created: !cur, ...(gone ? { gone: name } : {}), ...(saved ? {} : { linked: false }), artifact: r.page });
}

const VIS_RANK = { private: 0, link: 1, public: 2 };
/**
 * New files and settings for an existing artifact (`cur`, as GET returns it). Settings go before the files (a token
 * that can't change them uploads nothing), except a wider visibility, which goes after: the files are never open to
 * more people than the owner asked for, also when the upload fails.
 */
async function replaceArtifact(api, cur, content, settings) {
  const at = `/v1/pages/${encodeURIComponent(cur.name)}`;
  const { visibility, ...first } = settings;
  const widen = visibility !== undefined && VIS_RANK[visibility] > VIS_RANK[cur.visibility];
  // Widening: the same visibility for now, so a token that can't change it is refused before the upload.
  if (visibility !== undefined) first.visibility = widen ? cur.visibility : visibility;
  if (Object.keys(first).length) await api.patch(at, first);
  const r = await api.put(at, { ...content, source: "cli" });
  return widen ? api.patch(at, { visibility }) : r;
}

// Server defaults (CRESSLET_MAX_DEPLOY_FILES / _MB); built files and source share them.
// The source is skipped, not the deploy, when both don't fit.
const maxFiles = () => Number(process.env.CRESSLET_MAX_DEPLOY_FILES) || 2000;
const maxBytes = () => (Number(process.env.CRESSLET_MAX_DEPLOY_MB) || 25) * 1024 * 1024;

function readSources(root, { exclude, used, warn }) {
  const paths = listSources(root, { exclude });
  if (!paths.length) return undefined; // e.g. `--dir .`: omit `sources`, not `[]`
  const skip = (why) => {
    warn(`source not uploaded: ${why}; add large files to .gitignore or pass --no-source`);
    return undefined;
  };
  if (used.files + paths.length > maxFiles()) {
    return skip(`${used.files} built + ${paths.length} source files exceed ${maxFiles()} files`);
  }
  let bytes = used.bytes;
  for (const p of paths) {
    bytes += fs.statSync(path.join(root, p)).size; // sizes first: don't read a too-big source
    if (bytes > maxBytes()) return skip(`build + source exceed ${formatBytes(maxBytes())}`);
  }
  return paths.map((p) => ({ path: p, data: readSource(root, p).toString("base64"), encoding: "base64" }));
}

/** A link's deploy key is only for the app + server it was issued by. */
const keyOf = (link, app, base) => (link?.name === app && link?.api === base ? link.deployKey : undefined);

/** Client for `app`: the project's deploy key only if its link is for that app on that server. */
function appClient(flags, project, app) {
  const base = apiBase(flags, project);
  return client({ flags, project: { link: { api: base, deployKey: keyOf(project?.link, app, base) } } });
}

/** `cresslet pull [app|url] [--dir d] [--deploy id]`: write the source uploaded with a deploy. */
export async function cmdPull({ _: [target], flags }) {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  let dest = path.resolve(flags.dir ?? (target || flags.app ? name : project.root));
  dest = realDest(dest);
  const before = readLink(dest); // CLI metadata as it was before the pull (never from the response)
  if (fs.existsSync(dest) && fs.readdirSync(dest).filter((f) => f !== ".git").length && !flags.force) {
    throw new CliError(`${dest} is not empty`, "pass --dir <new dir> or --force to overwrite");
  }
  const q = flags.deploy ? `?deploy=${encodeURIComponent(flags.deploy)}` : "";
  const r = await api.get(`/v1/apps/${encodeURIComponent(name)}/source${q}`);
  // Check every path before writing anything.
  const files = r.files.map((f) => ({ ...f, rel: pullPath(f.path) }));
  // The tree may have changed during the request: resolve again right before the first write.
  if (realDest(dest) !== dest) throw new CliError(`refusing to pull: ${dest} changed while pulling`);
  for (const rel of [...files.map((f) => f.rel), ".cresslet/app.json", ".gitignore"]) noSymlink(dest, rel);
  for (const f of files) {
    const target = path.join(dest, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.encoding === "base64" ? Buffer.from(f.data, "base64") : f.data);
  }
  // Link the copy to the app (so deploy/logs/… work there) when we're allowed to act on it.
  let linked = false;
  const p = r.app && (api.token || api.deployKey) ? loadProject(dest, { here: true, required: false }) : null;
  if (p) {
    const deployKey = keyOf(project?.link, r.app, api.base) ?? keyOf(before, r.app, api.base);
    p.saveLink({ name: r.app, api: api.base, ...(deployKey ? { deployKey } : {}) }, { replace: true });
    linked = true;
  }
  const rel = path.relative(process.cwd(), dest) || ".";
  out(flags, () => {
    console.log(`${color.green("✔")} pulled ${color.bold(name)} ${color.dim(`(${r.deployId}, ${r.files.length} files)`)} → ${rel}`);
    if (linked) console.log(color.dim(`  linked to ${r.app} on ${api.base}`));
    if (fs.existsSync(path.join(dest, "package.json"))) console.log(`  cd ${rel} && npm install`);
  }, { app: r.app, deployId: r.deployId, dir: dest, files: r.files.map((f) => f.path), linked });
}

/** A pulled file's path, relative and `/`-separated; anything that could land outside the copy is refused. */
export function pullPath(p) {
  const bad = (why) => new CliError(`refusing to pull ${JSON.stringify(p)}: ${why}`);
  if (typeof p !== "string" || !p || p.includes("\0")) throw bad("invalid path");
  if (/^[\\/]/.test(p)) throw bad("absolute path"); // also UNC \\host and \\?\ namespaces
  if (p.includes(":")) throw bad("drive letter or alternate data stream");
  const segs = p.split(/[\\/]/);
  for (const s of segs) {
    const t = s.replace(/[. ]+$/, "").toLowerCase(); // Windows drops trailing dots/spaces
    if (!t) throw bad("empty, '.' or '..' segment");
    if (t === ".git" || t === "node_modules") throw bad(`${s}/ is not source`);
    if (t === ".cresslet") throw bad(`${s}/ is CLI metadata`);
  }
  return segs.join("/");
}

/**
 * `dest` with its existing ancestors resolved (macOS /tmp → /private/tmp is fine); refuses `dest` itself
 * being a symlink/junction. What's created under it is checked by `noSymlink`.
 */
function realDest(dest) {
  const rest = [];
  for (let p = dest; ; p = path.dirname(p)) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code !== "ENOENT" || p === path.dirname(p)) throw new CliError(`cannot check ${p} before writing: ${e.code ?? e.message}`);
      rest.unshift(path.basename(p));
      continue;
    }
    if (p === dest && st.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${p}`);
    return path.join(fs.realpathSync(p), ...rest);
  }
}

/** Refuse to write through a symlink (or junction) at or above `rel` inside `dest`. */
function noSymlink(dest, rel) {
  let p = dest;
  for (const s of rel.split(/[\\/]/).filter(Boolean)) {
    p = path.join(p, s);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code === "ENOENT") return; // doesn't exist yet: nothing below it does either
      throw new CliError(`cannot check ${p} before writing: ${e.code ?? e.message}`);
    }
    if (st.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${p}`);
  }
}

// ---------------------------------------------------------------- auth
export async function cmdLogin({ flags }) {
  const api = client({ flags });
  let r;
  if (flags.token === "") throw new CliError("usage: cresslet auth login --token <token>");
  if (typeof flags.token === "string") {
    // Token from the studio's Settings page.
    r = await api.get("/v1/me", { token: flags.token });
    r.token = flags.token;
  } else {
    if (flags.token) throw new CliError("usage: cresslet login --token <token>");
    const meta = await api.get("/v1", { auth: false });
    if (meta.auth?.cli) r = await browserLogin(api, flags);
    else if (meta.auth?.github) r = await githubLogin(api, flags); // servers from before browser login
    else throw new CliError(`${api.base} has no login configured`, "use `cresslet login --token <token>` or set CRESSLET_TOKEN");
  }
  const g = readGlobal();
  g.tokens = { ...g.tokens, [api.base]: r.token };
  writeGlobal(g);
  out(flags, `${color.green("✔")} logged in as ${color.bold(who(r.account))} on ${api.base}`, { account: r.account, api: api.base });
}

const who = (a) => (a.github ? `${a.github} (${a.email})` : a.email);

/** Browser login: open the studio, the user enters the code there, poll until they do. */
async function browserLogin(api, flags) {
  const d = await api.post("/v1/auth/cli", {}, { auth: false });
  process.stderr.write(`open ${color.cyan(d.verificationUri)} and enter ${color.bold(d.userCode)}\n`);
  if (!flags["no-browser"] && process.stderr.isTTY) openUrl(d.verificationUri);
  process.stderr.write(color.dim("waiting for the browser…\n"));
  const deadline = Date.now() + (d.expiresIn || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, (d.interval || 2) * 1000));
    const p = await api.post("/v1/auth/cli/token", { deviceCode: d.deviceCode }, { auth: false });
    if (p.status === "complete") return p;
  }
  throw new CliError("login expired", "run `cresslet login` again");
}

/** GitHub device flow, proxied by the server: show a code, poll until the user approves it. */
async function githubLogin(api, flags) {
  const d = await api.post("/v1/auth/github/device", {}, { auth: false });
  process.stderr.write(`open ${color.cyan(d.verificationUri)} and enter ${color.bold(d.userCode)}\n`);
  if (!flags["no-browser"] && process.stderr.isTTY) openUrl(d.verificationUri);
  process.stderr.write(color.dim("waiting for GitHub…\n"));
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + (d.expiresIn || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, interval));
    const p = await api.post("/v1/auth/github/device/token", { deviceCode: d.deviceCode }, { auth: false });
    if (p.status === "complete") return p;
    if (p.status === "slow_down") interval = (p.interval ?? interval / 1000 + 5) * 1000;
  }
  throw new CliError("code expired", "run `cresslet login` again");
}

function openUrl(url) {
  // The URL comes from the server: only http(s), and never through a shell.
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) return;
  } catch {
    return;
  }
  const [cmd, ...args] = process.platform === "darwin" ? ["open"]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler"]
    : ["xdg-open"];
  try {
    spawn(cmd, [...args, url], { stdio: "ignore", detached: true })
      .on("error", () => {}).unref();
  } catch { /* no browser */ }
}

export async function cmdLogout({ flags }) {
  const base = apiBase(flags);
  const g = readGlobal();
  if (g.tokens) delete g.tokens[base];
  writeGlobal(g);
  out(flags, `logged out of ${base}`, { api: base });
}

export async function cmdWhoami({ flags }) {
  const api = client({ flags });
  if (!api.token) throw new CliError(`not logged in to ${api.base}`, "run `cresslet login`");
  const r = await api.get("/v1/me");
  out(flags, `${who(r.account)} ${color.dim(`(${api.base})`)}`, { ...r, api: api.base });
}

export async function cmdClaim({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  const name = appName(project, flags);
  const r = await api.post(`/v1/apps/${encodeURIComponent(name)}/claim`, { deployKey: project.link.deployKey });
  out(flags, `${color.green("✔")} claimed ${color.bold(name)}: no expiry, outbound fetch + secrets enabled`, r);
}

// ---------------------------------------------------------------- inspect
export async function cmdApps({ flags }) {
  const api = client({ flags });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  const r = await api.get("/v1/apps");
  out(flags, () => {
    if (!r.apps.length) return console.log("no apps yet");
    for (const a of r.apps) console.log(`${color.bold(a.name.padEnd(28))} ${a.url}  ${color.dim(a.updatedAt)}`);
  }, r);
}

export async function cmdInspect({ _: [target], flags }) {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const r = await api.get(`/v1/apps/${encodeURIComponent(name)}`);
  out(flags, () => {
    const a = r.app;
    console.log(`${color.bold(a.name)}  ${color.cyan(a.url)}`);
    console.log(`  claimed: ${a.claimed ? "yes" : `no (expires ${a.expiresAt})`}`);
    console.log(`  routes:  ${(a.config.routes ?? []).join(", ")}${a.config.server ? "" : " (no server)"}`);
    console.log(`  runtime: ${r.runtime.running ? `running (pid ${r.runtime.pid})` : "idle"}`);
    console.log(`  secrets: ${r.secrets.length ? r.secrets.join(", ") : "none"}`);
    console.log("  deploys:");
    for (const d of r.deploys) {
      console.log(`    ${d.current ? color.green("●") : " "} ${d.id}  ${d.createdAt}  ${d.files} files ${formatBytes(d.bytes)}${d.server ? " +server" : ""}  ${color.dim(d.source)}`);
    }
  }, r);
}

function nameFrom(target) {
  try {
    return new URL(target).hostname.split(".")[0];
  } catch {
    return target;
  }
}

export async function cmdLogs({ _: [target], flags }) {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const follow = !!(flags.follow ?? flags.f);
  const res = await api.get(`/v1/apps/${encodeURIComponent(name)}/logs?n=${Number(flags.n ?? 100)}${follow ? "&follow=1" : ""}`, { stream: true });
  const dec = new TextDecoder();
  let buf = "";
  const kindColor = { stderr: color.red, system: color.yellow, request: color.dim, stdout: (s) => s };
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (flags.json) {
        console.log(line);
        continue;
      }
      const l = JSON.parse(line);
      const time = new Date(l.t).toISOString().slice(11, 23);
      console.log(`${color.dim(time)} ${(kindColor[l.kind] ?? String)(l.msg)}`);
    }
  }
}

export async function cmdDb({ _: [sql], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  if (sql) {
    const r = await api.post(`/v1/apps/${encodeURIComponent(name)}/db/query`, { sql });
    return out(flags, () => console.table(r.rows), r);
  }
  const r = await api.get(`/v1/apps/${encodeURIComponent(name)}/db?limit=${Number(flags.limit ?? 20)}`);
  out(flags, () => {
    const names = Object.keys(r.tables);
    if (!names.length) return console.log("database is empty");
    for (const t of names) {
      console.log(`${color.bold(t)} ${color.dim(`(${r.tables[t].count} rows)`)}`);
      console.log(color.dim(r.tables[t].schema));
      if (r.tables[t].rows.length) console.table(r.tables[t].rows);
    }
  }, r);
}

export async function cmdSecrets({ _: [sub, ...rest], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  if (!sub || sub === "list" || sub === "ls") {
    const r = await api.get(`/v1/apps/${encodeURIComponent(name)}/secrets`);
    return out(flags, r.keys.length ? r.keys.join("\n") : "no secrets", r);
  }
  if (sub === "set") {
    if (!rest.length) throw new CliError("usage: cresslet secrets set KEY=value [KEY2=value2…]");
    const body = {};
    for (const kv of rest) {
      const i = kv.indexOf("=");
      if (i < 1) throw new CliError(`expected KEY=value, got ${kv}`);
      body[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const r = await api.put(`/v1/apps/${encodeURIComponent(name)}/secrets`, body);
    return out(flags, `${color.green("✔")} set ${Object.keys(body).join(", ")}`, r);
  }
  if (sub === "unset" || sub === "rm") {
    const body = Object.fromEntries(rest.map((k) => [k, null]));
    const r = await api.put(`/v1/apps/${encodeURIComponent(name)}/secrets`, body);
    return out(flags, `${color.green("✔")} removed ${rest.join(", ")}`, r);
  }
  throw new CliError(`unknown secrets command: ${sub}`, "use list | set KEY=value | unset KEY");
}

export async function cmdDomains({ _: [sub, domain], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const base = `/v1/apps/${encodeURIComponent(name)}/domains`;
  const show = (d) => {
    console.log(`${color.bold(d.domain)}  ${d.verified ? color.green("verified") : color.yellow("pending")}`);
    if (!d.verified) for (const x of d.dns) console.log(`  ${x.type.padEnd(5)} ${x.name}  →  ${x.value}`);
  };
  if (!sub || sub === "list" || sub === "ls") {
    const r = await api.get(base);
    return out(flags, () => (r.domains.length ? r.domains.forEach(show) : console.log("no custom domains")), r);
  }
  if (!domain) throw new CliError(`usage: cresslet domains ${sub} <domain>`);
  const d = encodeURIComponent(domain);
  if (sub === "add") {
    const r = await api.post(base, { domain });
    return out(flags, () => {
      show(r.domain);
      if (!r.domain.verified) console.log(color.dim(`  create these DNS records, then: cresslet domains verify ${r.domain.domain}`));
    }, r);
  }
  if (sub === "verify") {
    const r = await api.post(`${base}/${d}/verify`);
    return out(flags, `${color.green("✔")} ${r.domain.domain} verified`, r);
  }
  if (sub === "rm" || sub === "remove") {
    const r = await api.del(`${base}/${d}`);
    return out(flags, `${color.green("✔")} removed ${domain}`, r);
  }
  throw new CliError(`unknown domains command: ${sub}`, "use list | add <domain> | verify <domain> | rm <domain>");
}

export async function cmdEgress({ _: [sub, ...hosts], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const p = `/v1/apps/${encodeURIComponent(name)}/egress`;
  const show = (r) => (r.allow ? (r.allow.length ? r.allow.join("\n") : "no outbound hosts allowed") : "any public host (no allowlist)");
  if (!sub || sub === "show") {
    const r = await api.get(p);
    return out(flags, show(r), r);
  }
  if (sub === "allow") {
    if (!hosts.length) throw new CliError("usage: cresslet egress allow <host…>", "e.g. api.stripe.com '*.openai.com'");
    const r = await api.put(p, { allow: hosts });
    return out(flags, `${color.green("✔")} allowlist: ${r.allow.join(", ")}`, r);
  }
  if (sub === "clear") {
    const r = await api.put(p, { allow: null });
    return out(flags, `${color.green("✔")} ${show(r)}`, r);
  }
  throw new CliError(`unknown egress command: ${sub}`, "use show | allow <host…> | clear");
}

export async function cmdRollback({ _: [deployId], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const r = await api.post(`/v1/apps/${encodeURIComponent(name)}/rollback`, { deployId });
  out(flags, `${color.green("✔")} ${name} now serving ${r.app.currentDeployId}`, r);
}

export async function cmdDelete({ flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  if (!flags.yes && !flags.y) {
    const a = await ask(`delete ${name} and all its data? type the name to confirm: `);
    if (a !== name) throw new CliError("aborted");
  }
  const r = await api.del(`/v1/apps/${encodeURIComponent(name)}`);
  // Unlink only if the local link is for the app (and server) just deleted.
  if (project?.link.name === name && project.link.api === api.base) {
    fs.rmSync(path.join(project.root, ".cresslet", "app.json"), { force: true });
  }
  out(flags, `${color.green("✔")} deleted ${name}`, r);
}

export async function cmdOpen({ flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const r = await api.get(`/v1/apps/${encodeURIComponent(name)}`);
  openUrl(r.app.url);
  console.log(r.app.url);
}

// ---------------------------------------------------------------- artifacts (static HTML with a visibility and retention; API: /v1/pages)
const VISIBILITIES = ["private", "link", "public"];
const VIS_TEXT = { private: "private (you + people you share it with)", link: "anyone with the link", public: "public" };
const keepText = (d) => (d === null ? "forever" : `${d} day${d === 1 ? "" : "s"}`);

/** `--visibility` / `--keep` (days or "forever") / `--title`, as the API's fields; only the ones given. */
function pageSettings(flags, prefix = "") {
  const out = {};
  const vis = flags[`${prefix}visibility`];
  if (vis !== undefined) {
    if (!VISIBILITIES.includes(vis)) throw new CliError(`--${prefix}visibility must be one of ${VISIBILITIES.join(", ")}`);
    out.visibility = vis;
  }
  const keep = flags[`${prefix}keep`];
  if (keep !== undefined) {
    if (keep === "forever") out.retentionDays = null;
    else if (/^\d+$/.test(String(keep)) && Number(keep) >= 1) out.retentionDays = Number(keep);
    else throw new CliError(`--${prefix}keep must be a number of days or "forever"`);
  }
  if (!prefix && flags.title !== undefined) out.title = flags.title === true ? null : String(flags.title);
  return out;
}

/** One .html file (`html`), or a folder's files (hidden ones and node_modules left out; symlinks not followed). */
function pageContent(target) {
  const abs = path.resolve(target);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new CliError(`not found: ${target}`);
  }
  if (st.isFile()) {
    if (!/\.html?$/i.test(abs)) throw new CliError(`${target} isn't an .html file`, "upload one HTML file, or a folder with an index.html");
    return { content: { html: fs.readFileSync(abs, "utf8") }, title: path.basename(abs).replace(/\.html?$/i, "") };
  }
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push({ path: r, data: fs.readFileSync(path.join(dir, e.name)).toString("base64"), encoding: "base64" });
    }
  };
  walk(abs, "");
  if (!files.some((f) => f.path === "index.html")) throw new CliError(`${target} has no index.html`, "a folder artifact is served from its index.html");
  return { content: { files }, title: path.basename(abs) };
}

const accountClient = (flags) => {
  const api = client({ flags });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  return api;
};

function showPage(p) {
  console.log(`${color.bold(p.title ?? p.name)}  ${color.cyan(p.url)}`);
  console.log(`  who can open: ${VIS_TEXT[p.visibility] ?? p.visibility}`);
  console.log(`  kept:         ${p.retentionDays === null ? "forever" : `${keepText(p.retentionDays)} (until ${p.expiresAt})`}`);
  console.log(`  ${color.dim(`${p.name} · ${p.files} file${p.files === 1 ? "" : "s"}, ${formatBytes(p.bytes)}${p.access && p.access !== "owner" ? ` · you: ${p.access}` : ""}`)}`);
}

export async function cmdArtifact({ _: [sub, target, file], flags }) {
  const api = accountClient(flags);
  const page = (t) => {
    if (!t) throw new CliError(`usage: cresslet artifact ${sub} <name|url>${sub === "update" ? " <file|dir>" : ""}`);
    return encodeURIComponent(nameFrom(t));
  };
  if (!sub || sub === "ls" || sub === "list") {
    const r = await api.get("/v1/pages");
    return out(flags, () => {
      if (!r.pages.length) return console.log("no artifacts yet (cresslet deploy <file.html>, or a folder: cresslet deploy <dir> --artifact)");
      for (const p of r.pages) {
        const until = p.retentionDays === null ? "forever" : `until ${p.expiresAt.slice(0, 10)}`;
        console.log(`${color.bold((p.title ?? p.name).slice(0, 28).padEnd(28))} ${p.visibility.padEnd(8)} ${until.padEnd(16)} ${p.url}`);
      }
    }, r);
  }
  if (sub === "upload") {
    if (!target) throw new CliError("usage: cresslet artifact upload <file.html|dir> [--name n] [--visibility private|link|public] [--keep <days>|forever] [--title t]");
    if (flags.name === true || flags.name === "") throw new CliError("--name needs an address, e.g. --name q4-report");
    const { content, title } = pageContent(target);
    const name = flags.name === undefined ? {} : { name: String(flags.name) };
    const r = await api.post("/v1/pages", { ...name, title, ...pageSettings(flags), ...content, source: "cli" });
    return out(flags, () => {
      console.log(`${color.green("✔")} uploaded`);
      showPage(r.page);
    }, r);
  }
  if (sub === "show" || sub === "info") {
    const r = await api.get(`/v1/pages/${page(target)}`);
    return out(flags, () => showPage(r.page), r);
  }
  if (sub === "update") {
    if (!file) throw new CliError("usage: cresslet artifact update <name|url> <file.html|dir>");
    const { content } = pageContent(file);
    const settings = pageSettings(flags);
    const cur = (await api.get(`/v1/pages/${page(target)}`)).page;
    const r = await replaceArtifact(api, cur, content, settings);
    return out(flags, () => {
      console.log(`${color.green("✔")} updated (same link)`);
      showPage(r.page);
    }, r);
  }
  if (sub === "set") {
    const change = pageSettings(flags);
    if (!Object.keys(change).length) throw new CliError("nothing to change", "pass --visibility, --keep and/or --title");
    const r = await api.patch(`/v1/pages/${page(target)}`, change);
    return out(flags, () => showPage(r.page), r);
  }
  if (sub === "open") {
    // Private artifacts: a one-time sign-in link (the browser keeps a session cookie for that artifact).
    const r = await api.post(`/v1/pages/${page(target)}/view`, {});
    if (!flags.json) openUrl(r.url);
    return out(flags, r.url, r);
  }
  if (sub === "rm" || sub === "delete") {
    const name = decodeURIComponent(page(target));
    if (!flags.yes && !flags.y) {
      const a = await ask(`delete artifact ${name}? its link stops working. type the name to confirm: `);
      if (a !== name) throw new CliError("aborted");
    }
    const r = await api.del(`/v1/pages/${encodeURIComponent(name)}`);
    return out(flags, `${color.green("✔")} deleted ${name}`, r);
  }
  throw new CliError(`unknown artifact command: ${sub}`, "use ls | show <artifact> | set <artifact> | open <artifact> | rm <artifact> | upload <file|dir> | update <artifact> <file|dir> (or just: cresslet deploy <file|dir>)");
}

/** The account's defaults for new artifacts: `--artifact-visibility`, `--artifact-keep` (or the old `--page-*`); `--reset` = the server's. */
export async function cmdSettings({ flags }) {
  const api = accountClient(flags);
  const f = { ...flags };
  for (const k of ["visibility", "keep"]) f[`artifact-${k}`] ??= flags[`page-${k}`];
  const change = pageSettings(f, "artifact-");
  const r = flags.reset
    ? await api.put("/v1/me/settings", { pages: null })
    : Object.keys(change).length
    ? await api.put("/v1/me/settings", { pages: change })
    : await api.get("/v1/me/settings");
  out(flags, () => {
    console.log(color.bold("new artifacts"));
    console.log(`  who can open: ${VIS_TEXT[r.pages.visibility]}`);
    console.log(`  kept:         ${keepText(r.pages.retentionDays)}`);
    console.log(color.dim(`  server default: ${r.defaults.pages.visibility}, ${keepText(r.defaults.pages.retentionDays)}`));
  }, r);
}

// ---------------------------------------------------------------- config
const CONFIG_KEYS = { api: "Cresslet server URL" };

/** `config [list] | get <key> | set <key> <value> | unset <key>`, stored in ~/.config/cresslet/config.json. */
export async function cmdConfig({ _: [sub = "list", key, value], flags }) {
  const usage = "usage: cresslet config [list] | get <key> | set <key> <value> | unset <key>";
  const keys = `keys: ${Object.entries(CONFIG_KEYS).map(([k, d]) => `${k} (${d})`).join(", ")}`;
  const file = path.join(configDir(), "config.json");
  const effective = () => apiSource(flags, loadProject(process.cwd(), { required: false }));
  if (sub === "list" || sub === "ls") {
    const api = effective();
    return out(flags, () => {
      console.log(`api  ${api.value}  ${color.dim(`(${api.from})`)}`);
      console.log(color.dim(file));
    }, { api, file });
  }
  if (!["get", "set", "unset"].includes(sub)) throw new CliError(`unknown config command: ${sub}`, usage);
  if (!key) throw new CliError(usage, keys);
  if (!CONFIG_KEYS[key]) throw new CliError(`unknown config key: ${key}`, keys);
  if (sub === "get") {
    const api = effective();
    return out(flags, api.value, { key, ...api });
  }
  const g = readGlobal();
  if (sub === "unset") {
    delete g[key];
    writeGlobal(g);
    return out(flags, `${color.green("✔")} api reset to ${DEFAULT_API}`, { key, value: DEFAULT_API });
  }
  if (!value) throw new CliError(`usage: cresslet config set ${key} <url>`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`not a URL: ${value}`, "e.g. https://cresslet.dev or http://localhost:8787");
  }
  if (!/^https?:$/.test(url.protocol)) throw new CliError(`not an http(s) URL: ${value}`);
  const v = value.replace(/\/+$/, "");
  g.api = v;
  writeGlobal(g);
  out(flags, () => {
    console.log(`${color.green("✔")} api set to ${v}`);
    if (!g.tokens?.[v]) console.log(color.dim("  not logged in there yet: run `cresslet login`"));
    const now = effective();
    if (now.from !== "config") console.log(color.yellow(`  note: ${now.from} overrides it here (${now.value})`));
  }, { key, value: v });
}
