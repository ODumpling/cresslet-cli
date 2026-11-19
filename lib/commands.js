import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { apiBase, client } from "./api.js";
import { build, listFiles, listSources, readSource } from "./build.js";
import { dev } from "./dev.js";
import { CliError, color, configDir, formatBytes, loadProject, readGlobal, writeGlobal } from "./util.js";

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
export async function cmdDeploy({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  const t0 = performance.now();

  let staticDir, serverFile;
  if (flags.dir) {
    staticDir = path.resolve(flags.dir);
    if (!fs.existsSync(staticDir)) throw new CliError(`--dir not found: ${flags.dir}`);
    serverFile = flags.server ? path.resolve(flags.server) : null;
  } else {
    const r = await build(project.root);
    staticDir = r.outDir;
    serverFile = r.serverFile;
  }

  let fileBytes = 0;
  const files = listFiles(staticDir).map((p) => {
    const data = fs.readFileSync(path.join(staticDir, p));
    fileBytes += data.length;
    return { path: p, data: data.toString("base64"), encoding: "base64" };
  });
  const server = serverFile ? fs.readFileSync(serverFile, "utf8") : null;
  const bytes = fileBytes + (server?.length ?? 0);
  const name = flags.name ?? project.link.name ?? (project.config.name || undefined);
  const warn = (msg) => !flags.json && process.stderr.write(color.yellow(msg + "\n"));
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
    console.log(`${color.green("✔")} deployed ${color.bold(r.app.name)} ${color.dim(`(${r.deploy.id}, ${Math.round(performance.now() - t0)}ms)`)}`);
    console.log(`  ${color.cyan(r.app.url)}`);
    if (!r.app.claimed) {
      console.log(color.yellow(`  unclaimed: expires ${new Date(r.app.expiresAt).toLocaleString()}; no outbound fetch or secrets.`));
      console.log(color.dim("  keep it: cresslet login && cresslet claim"));
    }
  }, r);
}

// Server defaults (CRESSLET_MAX_DEPLOY_FILES / _MB); built files and source share them.
// The source is skipped, not the deploy, when both don't fit.
const maxFiles = () => Number(process.env.CRESSLET_MAX_DEPLOY_FILES) || 2000;
const maxBytes = () => (Number(process.env.CRESSLET_MAX_DEPLOY_MB) || 25) * 1024 * 1024;

function readSources(root, { exclude, used, warn }) {
  const paths = listSources(root, { exclude });
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

/** `cresslet pull [app|url] [--dir d] [--deploy id]`: write the source uploaded with a deploy. */
export async function cmdPull({ _: [target], flags }) {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const base = apiBase(flags, project);
  // A link's deploy key is only for the app + server it was issued by.
  const keyOf = (link, app) => (link?.name === app && link?.api === base ? link.deployKey : undefined);
  const api = client({ flags, project: { link: { api: base, deployKey: keyOf(project?.link, name) } } });
  const dest = path.resolve(flags.dir ?? (target || flags.app ? name : project.root));
  if (fs.existsSync(dest) && fs.readdirSync(dest).filter((f) => f !== ".git").length && !flags.force) {
    throw new CliError(`${dest} is not empty`, "pass --dir <new dir> or --force to overwrite");
  }
  const q = flags.deploy ? `?deploy=${encodeURIComponent(flags.deploy)}` : "";
  const r = await api.get(`/v1/apps/${encodeURIComponent(name)}/source${q}`);
  // Check every path before writing anything.
  const files = r.files.map((f) => ({ ...f, rel: pullPath(f.path) }));
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
    const deployKey = keyOf(project?.link, r.app) ?? keyOf(p.link, r.app);
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
  }
  return segs.join("/");
}

/** Refuse to write through a symlink (or junction) at or above `rel` inside `dest`. */
function noSymlink(dest, rel) {
  let p = dest;
  for (const s of rel.split("/")) {
    p = path.join(p, s);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return; // doesn't exist yet: nothing below it does either
    }
    if (st.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${p}`);
  }
}

// ---------------------------------------------------------------- auth
export async function cmdLogin({ flags }) {
  const api = client({ flags });
  let r;
  if (typeof flags.token === "string") {
    // Token from the studio's Settings page.
    r = await api.get("/v1/me", { token: flags.token });
    r.token = flags.token;
  } else {
    if (flags.token) throw new CliError("usage: cresslet login --token <token>");
    const meta = await api.get("/v1", { auth: false });
    if (!meta.auth?.github) {
      throw new CliError(`${api.base} has no GitHub login configured`, "use `cresslet login --token <token>` or set CRESSLET_TOKEN");
    }
    r = await githubLogin(api, flags);
  }
  const g = readGlobal();
  g.tokens = { ...g.tokens, [api.base]: r.token };
  writeGlobal(g);
  out(flags, `${color.green("✔")} logged in as ${color.bold(who(r.account))} on ${api.base}`, { account: r.account, api: api.base });
}

const who = (a) => (a.github ? `${a.github} (${a.email})` : a.email);

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
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
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
  const r = await api.post(`/v1/apps/${name}/claim`, { deployKey: project.link.deployKey });
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
  const project = loadProject(process.cwd(), { required: !target });
  const api = client({ flags, project });
  const name = target ? nameFrom(target) : appName(project, flags);
  const r = await api.get(`/v1/apps/${name}`);
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
  const project = loadProject(process.cwd(), { required: !target });
  const api = client({ flags, project });
  const name = target ? nameFrom(target) : appName(project, flags);
  const follow = !!(flags.follow ?? flags.f);
  const res = await api.get(`/v1/apps/${name}/logs?n=${Number(flags.n ?? 100)}${follow ? "&follow=1" : ""}`, { stream: true });
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
  const api = client({ flags, project });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  if (sql) {
    const r = await api.post(`/v1/apps/${name}/db/query`, { sql });
    return out(flags, () => console.table(r.rows), r);
  }
  const r = await api.get(`/v1/apps/${name}/db?limit=${Number(flags.limit ?? 20)}`);
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
  const project = loadProject();
  const api = client({ flags, project });
  const name = appName(project, flags);
  if (!sub || sub === "list" || sub === "ls") {
    const r = await api.get(`/v1/apps/${name}/secrets`);
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
    const r = await api.put(`/v1/apps/${name}/secrets`, body);
    return out(flags, `${color.green("✔")} set ${Object.keys(body).join(", ")}`, r);
  }
  if (sub === "unset" || sub === "rm") {
    const body = Object.fromEntries(rest.map((k) => [k, null]));
    const r = await api.put(`/v1/apps/${name}/secrets`, body);
    return out(flags, `${color.green("✔")} removed ${rest.join(", ")}`, r);
  }
  throw new CliError(`unknown secrets command: ${sub}`, "use list | set KEY=value | unset KEY");
}

export async function cmdDomains({ _: [sub, domain], flags }) {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const api = client({ flags, project });
  const base = `/v1/apps/${appName(project ?? { link: {}, config: {} }, flags)}/domains`;
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
  const api = client({ flags, project });
  const p = `/v1/apps/${appName(project ?? { link: {}, config: {} }, flags)}/egress`;
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
  const project = loadProject();
  const api = client({ flags, project });
  const name = appName(project, flags);
  const r = await api.post(`/v1/apps/${name}/rollback`, { deployId });
  out(flags, `${color.green("✔")} ${name} now serving ${r.app.currentDeployId}`, r);
}

export async function cmdDelete({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  const name = appName(project, flags);
  if (!flags.yes && !flags.y) {
    const a = await ask(`delete ${name} and all its data? type the name to confirm: `);
    if (a !== name) throw new CliError("aborted");
  }
  const r = await api.del(`/v1/apps/${name}`);
  fs.rmSync(path.join(project.root, ".cresslet", "app.json"), { force: true });
  out(flags, `${color.green("✔")} deleted ${name}`, r);
}

export async function cmdOpen({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  const r = await api.get(`/v1/apps/${appName(project, flags)}`);
  openUrl(r.app.url);
  console.log(r.app.url);
}
