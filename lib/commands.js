import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { apiBase, client } from "./api.js";
import { build, listFiles } from "./build.js";
import { dev } from "./dev.js";
import { CliError, color, formatBytes, loadProject, readGlobal, writeGlobal } from "./util.js";

const out = (flags, human, json) => {
  if (flags.json) console.log(JSON.stringify(json ?? human, null, 2));
  else if (typeof human === "function") human();
  else console.log(human);
};

const appName = (project, flags) => {
  const name = flags.app ?? project.link.name ?? (project.config.name || undefined);
  if (!name) throw new CliError("this app has not been deployed yet", "run `clover deploy` first or pass --app <name>");
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
  if (!dir) throw new CliError("usage: clover new <dir> [--template react|vanilla]");
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
    console.log("  npx clover deploy");
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

  const files = listFiles(staticDir).map((p) => ({
    path: p,
    data: fs.readFileSync(path.join(staticDir, p)).toString("base64"),
    encoding: "base64",
  }));
  const server = serverFile ? fs.readFileSync(serverFile, "utf8") : null;
  const bytes = files.reduce((n, f) => n + f.data.length * 0.75, 0) + (server?.length ?? 0);
  const name = flags.name ?? project.link.name ?? (project.config.name || undefined);

  if (!flags.json) process.stderr.write(color.dim(`deploying ${files.length} files (${formatBytes(bytes)}) to ${api.base}…\n`));
  const r = await api.post("/v1/deploys", {
    app: name,
    files,
    server,
    config: { routes: project.config.routes },
    source: "cli",
  });
  if (r.deployKey) project.saveLink({ name: r.app.name, deployKey: r.deployKey, api: api.base });
  else if (project.link.name !== r.app.name || !project.link.api) project.saveLink({ name: r.app.name, api: api.base });
  if (!project.config.name) project.saveConfig({ name: r.app.name });

  out(flags, () => {
    console.log(`${color.green("✔")} deployed ${color.bold(r.app.name)} ${color.dim(`(${r.deploy.id}, ${Math.round(performance.now() - t0)}ms)`)}`);
    console.log(`  ${color.cyan(r.app.url)}`);
    if (!r.app.claimed) {
      console.log(color.yellow(`  unclaimed: expires ${new Date(r.app.expiresAt).toLocaleString()}; no outbound fetch or secrets.`));
      console.log(color.dim("  keep it: clover login && clover claim"));
    }
  }, r);
}

// ---------------------------------------------------------------- auth
export async function cmdLogin({ flags }) {
  const api = client({ flags });
  const email = flags.email ?? (await ask("email: "));
  if (!email) throw new CliError("email required");
  const r = await api.post("/v1/accounts", { email }, { auth: false });
  const g = readGlobal();
  g.tokens = { ...g.tokens, [api.base]: r.token };
  writeGlobal(g);
  out(flags, `${color.green("✔")} logged in as ${color.bold(r.account.email)} on ${api.base}`, { account: r.account, api: api.base });
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
  if (!api.token) throw new CliError(`not logged in to ${api.base}`, "run `clover login`");
  const r = await api.get("/v1/me");
  out(flags, `${r.account.email} ${color.dim(`(${api.base})`)}`, { ...r, api: api.base });
}

export async function cmdClaim({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  if (!api.token) throw new CliError("login required", "run `clover login`");
  const name = appName(project, flags);
  const r = await api.post(`/v1/apps/${name}/claim`, { deployKey: project.link.deployKey });
  out(flags, `${color.green("✔")} claimed ${color.bold(name)}: no expiry, outbound fetch + secrets enabled`, r);
}

// ---------------------------------------------------------------- inspect
export async function cmdApps({ flags }) {
  const api = client({ flags });
  if (!api.token) throw new CliError("login required", "run `clover login`");
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
    if (!rest.length) throw new CliError("usage: clover secrets set KEY=value [KEY2=value2…]");
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
  fs.rmSync(path.join(project.root, ".clover", "app.json"), { force: true });
  out(flags, `${color.green("✔")} deleted ${name}`, r);
}

export async function cmdOpen({ flags }) {
  const project = loadProject();
  const api = client({ flags, project });
  const r = await api.get(`/v1/apps/${appName(project, flags)}`);
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [r.app.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  console.log(r.app.url);
}
