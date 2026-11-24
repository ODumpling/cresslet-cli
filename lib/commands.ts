import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, spawn } from "node:child_process";
import { agentStore } from "./agents.ts";
import { apiBase, apiSource, type Client, client } from "./api.ts";
import { build, type FrameworkBuild, frameworkBuild, listFiles, listSources, notStatic, readSource, runCommand } from "./build.ts";
import { dev } from "./dev.ts";
import {
  type Args,
  CliError,
  color,
  configDir,
  DEFAULT_API,
  ensureGitignore,
  findRoot,
  type Flags,
  formatBytes,
  type GlobalConfig,
  type Link,
  loadProject,
  type Project,
  readGlobal,
  readLink,
  textFlag,
  writeGlobal,
} from "./util.ts";

// Flags given without a value are `true` (util.ts parseArgs): read ones that take a value with textFlag().

// ---- the server's replies, as the commands read them (the API is the server's: cresslet repo)
/** A file in a template, a deploy's source or an upload. */
interface WireFile {
  path: string;
  data: string;
  encoding?: string;
}
interface Account {
  email: string;
  github?: string;
}
type Visibility = "private" | "link" | "public";
/** An artifact (the API's "page"). */
interface Page {
  id: string;
  name: string;
  title: string | null;
  url: string;
  visibility: Visibility;
  retentionDays: number | null;
  expiresAt: string;
  files: number;
  bytes: number;
  access?: string;
}
interface Domain {
  domain: string;
  verified: boolean;
  dns: { type: string; name: string; value: string }[];
}
/** A device-code login's start (`/v1/auth/cli`, `/v1/auth/github/device`) and its polls. */
interface DeviceCode {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresIn?: number;
  interval?: number;
}
type LoginPoll = { status: "complete"; token: string; account: Account } | { status: string; interval?: number };
interface Login {
  token: string;
  account: Account;
}
/** Artifact settings (the account's defaults for new ones: `pages`). */
interface PageSettings {
  visibility: Visibility;
  retentionDays: number | null;
}

const out = (flags: Flags, human: string | (() => void), json?: unknown) => {
  if (flags.json) console.log(JSON.stringify(json ?? human, null, 2));
  else if (typeof human === "function") human();
  else console.log(human);
};

const appName = (project: Pick<Project, "link" | "config">, flags: Flags): string => {
  const name = textFlag(flags, "app") ?? project.link.name ?? (project.config.name || undefined);
  if (!name) throw new CliError("this app has not been deployed yet", "run `cresslet deploy` first or pass --app <name>");
  return name;
};

async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- new / init
export async function cmdNew({ _: [dir], flags }: Args): Promise<void> {
  if (!dir) throw new CliError("usage: cresslet new <dir> [--template react|vanilla|tanstack-start]");
  return scaffold(path.resolve(dir), flags, true);
}

export async function cmdInit({ flags }: Args): Promise<void> {
  return scaffold(process.cwd(), flags, false);
}

async function scaffold(dest: string, flags: Flags, isNew: boolean) {
  const template = textFlag(flags, "template") ?? textFlag(flags, "t") ?? "react";
  if (fs.existsSync(dest) && fs.readdirSync(dest).filter((f) => f !== ".git").length && !flags.force) {
    throw new CliError(`${dest} is not empty`, "use an empty directory or pass --force");
  }
  const api = client({ flags });
  const t = await api.get<{ files: WireFile[] }>(`/v1/templates/${encodeURIComponent(template)}`, { auth: false });
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

export async function cmdTemplates({ flags }: Args): Promise<void> {
  const r = await client({ flags }).get<{ templates: { name: string; description?: string }[] }>("/v1/templates", { auth: false });
  out(flags, () => {
    for (const t of r.templates) console.log(`${color.bold(t.name.padEnd(16))} ${t.description ?? ""}`);
  }, r);
}

// ---------------------------------------------------------------- dev / build
export async function cmdDev({ flags }: Args): Promise<void> {
  const project = loadProject();
  const fw = frameworkBuild(project.config);
  if (fw) return frameworkDev(project, fw, flags);
  const port = Number(flags.port ?? flags.p ?? process.env.PORT ?? 3000);
  const d = await dev(project, { port, host: textFlag(flags, "host") ?? "localhost" });
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

/** A framework project (cresslet.json `build`): its own dev server (Vite + `cresslet/vite` gives it db, files, …). */
async function frameworkDev(project: Project, fw: FrameworkBuild, flags: Flags) {
  if (!fw.dev) {
    throw new CliError('cresslet.json "build" has no "dev" command', 'add e.g. "dev": "vite dev", or run your framework\'s dev server');
  }
  const port = flags.port ?? flags.p;
  const command = port ? `${fw.dev} --port ${Number(port)}` : fw.dev;
  const { child, done } = runCommand(command, project.root, { stdio: "inherit", env: port ? { PORT: String(Number(port)) } : {} });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.exitCode = await done;
}

export async function cmdBuild({ flags }: Args): Promise<void> {
  const project = loadProject();
  const t = performance.now();
  const r = await build(project.root, { config: project.config });
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
export async function cmdDeploy({ _: [target], flags }: Args): Promise<void> {
  const env = envFrom(flags);
  const art = artifactTarget(target, flags);
  if (art && env) throw new CliError("--env is for apps: an artifact has no environments");
  if (art) return deployArtifact(art, flags);
  const nameFlag = textFlag(flags, "name"); // a bare --name fails before any build
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

  const warn = (msg: string) => !flags.json && process.stderr.write(color.yellow(msg + "\n"));
  // Before building: its output isn't an uncommitted change.
  const git = gitProvenance(project.root, warn);
  if (staticFirst) warn(`${target ?? "this folder"} has no cresslet.json: it goes live as a public app that anyone can open`);
  let staticDir: string, serverFile: string | null;
  const dir = textFlag(flags, "dir");
  if (dir) {
    staticDir = path.resolve(dir);
    if (!fs.existsSync(staticDir)) throw new CliError(`--dir not found: ${flags.dir}`);
    // Every component of the resolved path (also outside this project, e.g. a sibling's node_modules).
    const bad = fs.realpathSync(staticDir).split(path.sep).find((s) => s && notStatic(s, true));
    if (bad) throw new CliError(`refusing to deploy --dir ${flags.dir}: inside ${bad}/ (never served)`);
    const server = textFlag(flags, "server");
    serverFile = server ? path.resolve(server) : null;
  } else {
    const r = await build(project.root, { config: project.config });
    staticDir = r.outDir;
    serverFile = r.serverFile;
  }

  let fileBytes = 0;
  const skipped: string[] = [];
  // --dir is any folder (often `.`), a framework's output folder may hold anything: never serve a deploy key,
  // secrets, .git or deps.
  const skip = flags.dir || frameworkBuild(project.config)
    ? (rel: string, isDir: boolean) => notStatic(rel, isDir) && skipped.push(isDir ? `${rel}/` : rel)
    : undefined;
  const files = listFiles(staticDir, { skip }).map((p) => {
    const data = fs.readFileSync(path.join(staticDir, p));
    fileBytes += data.length;
    return { path: p, data: data.toString("base64"), encoding: "base64" };
  });
  if (skipped.length) warn(`not uploaded from --dir (never served): ${skipped.join(", ")}`);
  const server = serverFile ? fs.readFileSync(serverFile, "utf8") : null;
  const bytes = fileBytes + (server?.length ?? 0);
  const name = nameFlag ?? project.link.name ?? (project.config.name || undefined);
  if (env && !name) throw new CliError(`deploy the app to production once first, then --env ${env}`, "cresslet deploy");
  // A static folder (no cresslet.json) has no project source to keep.
  const sources = flags["no-source"] || !fs.existsSync(path.join(project.root, "cresslet.json"))
    ? undefined
    : readSources(project.root, { exclude: [staticDir, configDir()], used: { files: files.length, bytes: fileBytes }, warn });

  if (!flags.json) process.stderr.write(color.dim(`deploying ${files.length} files (${formatBytes(bytes)}) to ${env ? `${name}'s ${env} on ` : ""}${api.base}…\n`));
  if (env) {
    // Its own route: a server without environments answers 404 (never a deploy to production).
    type EnvDeployed = { app: { name: string }; environment: { name: string; url: string }; deploy: { id: string; warning?: string } };
    const envBody = { files, server, config: { routes: project.config.routes, crons: project.config.crons }, source: "cli", sources, ...(git ? { git } : {}) };
    const to = `/v1/apps/${encodeURIComponent(name!)}/envs/${encodeURIComponent(env)}/deploys`;
    const r = await api.post<EnvDeployed>(to, envBody).catch(async (e: CliError) => {
      if (e.code === "not_found" && /no such endpoint/.test(e.message)) throw new CliError(`${api.base} doesn't have environments (update the server)`);
      // As for production: a server with lower limits takes it without the source.
      if (!sources || e.code !== "too_large" || !/source included/.test(e.message)) throw e;
      warn(`source not uploaded (${e.message}); \`cresslet pull\` won't have this deploy`);
      return api.post<EnvDeployed>(to, { ...envBody, sources: undefined });
    });
    return out(flags, () => {
      console.log(`${color.green("✔")} deployed ${color.bold(r.app.name)} to ${color.bold(r.environment.name)} ${color.dim(`(${r.deploy.id}, ${Math.round(performance.now() - t0)}ms)`)}`);
      console.log(`  ${color.cyan(r.environment.url)} ${color.dim("(private: you, its collaborators and organization)")}`);
      if (r.deploy.warning) console.log(color.yellow(`  ${r.deploy.warning}`));
      console.log(color.dim(`  to production: cresslet promote${r.environment.name === "staging" ? "" : ` --from ${r.environment.name}`}`));
    }, { kind: "app", env: r.environment.name, ...r });
  }
  const body = {
    app: name,
    files,
    server,
    config: { routes: project.config.routes, crons: project.config.crons },
    source: "cli",
    sources,
    ...(git ? { git } : {}),
  };
  type Deployed = {
    deployKey?: string;
    app: { name: string; url: string; claimed: boolean; expiresAt: string };
    deploy: { id: string };
  };
  let r: Deployed;
  try {
    r = await api.post<Deployed>("/v1/deploys", body);
  } catch (e) {
    // A server with lower limits than the defaults: deploy without the source rather than fail.
    const err = e as CliError; // the API's errors
    if (!sources || err.code !== "too_large" || !/source included/.test(err.message)) throw e;
    warn(`source not uploaded (${err.message}); \`cresslet pull\` won't have this deploy`);
    r = await api.post<Deployed>("/v1/deploys", { ...body, sources: undefined });
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
      const t = flags.dir ?? target; // what was uploaded
      const on = api.base === apiBase({}) ? "" : ` --api ${api.base}`; // the server this app went to, if not the usual one
      console.log(color.dim(`  private, link-only or expiring instead? cresslet deploy${t ? ` ${t}` : ""} --artifact${on}, then take this app down: ${target ? `cd ${target} && ` : ""}cresslet delete`));
    }
  }, { kind: "app", ...r });
}

/** `git …` in `dir`, or null (no git, not a repository). */
function gitOut(dir: string, ...args: string[]): string | null {
  return gitRaw(dir, ...args)?.trim() ?? null;
}
/** `git …` output as is (`-z` lists: names can start or end with spaces), or null. */
function gitRaw(dir: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** `owner/name` of a github.com remote URL (https, ssh://, or git's `[user@]host:path`), or null. */
export function githubRepo(url: string | null): string | null {
  if (!url) return null;
  let host: string, p: string;
  if (url.includes("://")) {
    try {
      const u = new URL(url);
      [host, p] = [u.hostname, u.pathname];
    } catch {
      return null;
    }
  } else {
    const m = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/); // git's scp-like form
    if (!m) return null;
    [host, p] = [m[1], m[2]];
  }
  if (host.toLowerCase() !== "github.com") return null;
  const m = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The checkout's branch (`refs/heads/…` stripped: a tag of the same name doesn't change it), or null. */
const gitBranch = (dir: string) => gitOut(dir, "symbolic-ref", "-q", "HEAD")?.replace(/^refs\/heads\//, "") || null;

/**
 * The commit a deploy is built from, when the project is a git checkout with nothing uncommitted (else the commit
 * wouldn't be what's deployed): shown with the deploy (`cresslet inspect`, the studio).
 */
function gitProvenance(dir: string, warn: (msg: string) => void): { sha: string; branch?: string; repo?: string } | null {
  const sha = gitOut(dir, "rev-parse", "HEAD");
  if (!sha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) return null;
  const status = gitOut(dir, "status", "--porcelain", "--untracked-files=all", "--", ".");
  if (status !== "") {
    if (status) warn("uncommitted changes: this deploy isn't recorded as a commit");
    return null;
  }
  const branch = gitBranch(dir);
  const repo = githubRepo(gitOut(dir, "config", "--get", "remote.origin.url"));
  return { sha, ...(branch ? { branch } : {}), ...(repo ? { repo } : {}) };
}

/**
 * This project's source for a commit (`git connect --push`, `git sync`): the deploy filter, minus build output and
 * anything git ignores (any .gitignore, .git/info/exclude, global excludes) in a git checkout. Never empty, never
 * partial: the server makes the branch hold exactly these files.
 */
function commitSources(project: Project): WireFile[] {
  const root = project.root;
  const fw = frameworkBuild(project.config);
  const out = fw ? path.relative(root, path.resolve(root, fw.static)).split(path.sep).join("/") : null;
  const inGit = gitOut(root, "rev-parse", "--is-inside-work-tree") === "true";
  // In a checkout git's own ignore rules decide (all of them, negations too), not the deploy filter's simple reading.
  // Folders git ignores aren't walked at all (big, or unreadable: a database's bind mount, say). Exact: git can't
  // re-include a file inside an ignored folder.
  const ignoredDirs = inGit
    ? (gitRaw(root, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--", ".") ?? "").split("\0").filter((p) => p.endsWith("/")).map((p) => path.join(root, p))
    : [];
  let paths = listSources(root, { exclude: [configDir(), path.join(root, "dist"), ...(fw ? [path.resolve(root, fw.static)] : []), ...ignoredDirs], gitignore: !inGit });
  if (inGit) {
    const listed = gitRaw(root, "ls-files", "-z", "-co", "--exclude-standard", "--", ".");
    if (listed === null) throw new CliError("couldn't list this checkout's files with git");
    const ok = new Set(listed.split("\0").filter(Boolean));
    paths = paths.filter((p) => ok.has(p));
    // Committed build output would be deleted from the branch (the commit holds exactly what's sent).
    if (out && !out.startsWith("..") && out !== "dist" && !out.startsWith("dist/")) { // the server never deletes dist/
      const tracked = (gitRaw(root, "ls-files", "-z", "-c", "--", out) ?? "").split("\0").filter(Boolean);
      if (tracked.length) throw new CliError(`${out}/ (build output) is committed: a commit from here would delete it`, `git --literal-pathspecs rm -r --cached -- '${out.replace(/'/g, "'\\''")}' and add it to .gitignore first`);
    }
  }
  if (!paths.length) throw new CliError("no source files to commit here");
  if (paths.length > maxFiles()) throw new CliError(`${paths.length} source files: more than the ${maxFiles()} a commit may hold`);
  let bytes = 0;
  for (const p of paths) {
    bytes += fs.statSync(path.join(root, p)).size;
    if (bytes > maxBytes()) throw new CliError(`the source is over ${formatBytes(maxBytes())}: too big to commit`);
  }
  return paths.map((p) => ({ path: p, data: readSource(root, p).toString("base64"), encoding: "base64" }));
}

// ---------------------------------------------------------------- git: the app's GitHub repository (server-side)
type GitStatus = {
  repo: { fullName: string; url: string; defaultBranch: string; subdir: string };
  defaultBranch: string;
  mainSha: string | null;
  branches: { name: string; sha: string; protected: boolean }[];
};

/**
 * `cresslet git status|connect <owner/repo> [--push|--pull]|sync [-m msg] [--branch b]`: the app's linked GitHub
 * repository, as the logged-in user (the server holds their GitHub token: connect GitHub once in the studio).
 */
export async function cmdGit({ _: [sub = "status", repoArg], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const base = `/v1/apps/${encodeURIComponent(name)}/git`;
  if (sub === "status") {
    const r = await api.get<GitStatus>(`${base}/status`);
    return out(flags, () => {
      console.log(`${color.bold(r.repo.fullName)}  ${color.cyan(r.repo.url)}${r.repo.subdir ? color.dim(` (in ${r.repo.subdir}/)`) : ""}`);
      for (const b of r.branches) {
        console.log(`  ${b.name === r.defaultBranch ? color.green("●") : " "} ${b.name}  ${color.dim(b.sha.slice(0, 7))}${b.protected ? color.dim(" protected") : ""}`);
      }
    }, r);
  }
  if (sub === "connect") {
    const m = (githubRepo(repoArg ?? null) ?? repoArg?.replace(/\.git$/, ""))?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) throw new CliError("usage: cresslet git connect <owner/repo> [--push]", "the GitHub repository to link this app to");
    if (flags.pull) throw new CliError("--pull isn't supported here: link, then `git clone` the repository");
    const push = !!flags.push;
    if (push && !project) throw new CliError("--push needs a project here (its files are pushed)");
    const files = push ? commitSources(project!) : undefined;
    const r = await api.post<{ repo: { fullName: string; url: string }; sha: string }>(`${base}/connect`, {
      owner: m[1], repo: m[2], initialSync: push ? "push" : "none", ...(files ? { files } : {}),
    });
    return out(flags, `${color.green("✔")} ${name} linked to ${r.repo.fullName}${push ? ` (pushed: ${r.sha.slice(0, 7)})` : ""}  ${color.cyan(r.repo.url)}`, r);
  }
  if (sub === "sync") {
    if (!project) throw new CliError("run it in the project: its files are what's committed");
    const st = await api.get<GitStatus>(`${base}/status`);
    // The project must be where the app lives in the repository (its subdir): its files replace that folder.
    const prefix = gitOut(project.root, "rev-parse", "--show-prefix");
    if (prefix !== null && prefix.replace(/\/$/, "") !== st.repo.subdir) {
      throw new CliError(`${name} lives in ${st.repo.subdir || "the root"} of ${st.repo.fullName}, but this project is ${prefix ? `in ${prefix.replace(/\/$/, "")}` : "at the root"} of its checkout`);
    }
    const branch = textFlag(flags, "branch") ?? gitBranch(project.root) ?? st.defaultBranch;
    const head = st.branches.find((b) => b.name === branch)?.sha;
    if (!head) throw new CliError(`no branch ${branch} in ${st.repo.fullName}`, "push it with git first, or pass --branch <an existing one>");
    // On top of what this checkout last had from GitHub: never over commits it hasn't seen.
    const local = gitOut(project.root, "rev-parse", "HEAD");
    const baseSha = textFlag(flags, "base") ?? local;
    if (baseSha !== head) {
      throw new CliError(`${branch} on GitHub is at ${head.slice(0, 7)}, this checkout at ${baseSha?.slice(0, 7) ?? "no commit"}`,
        "git pull first (--base <sha> stands in for this checkout's commit outside a git checkout; it must be GitHub's head too)");
    }
    const files = commitSources(project);
    const r = await api.post<{ sha: string; changed: boolean }>(`${base}/sync`, { branch, baseSha, files, message: textFlag(flags, "m") ?? textFlag(flags, "message") });
    return out(flags, r.changed ? `${color.green("✔")} committed to ${branch}: ${r.sha.slice(0, 7)}` : "nothing to commit", r);
  }
  throw new CliError(`unknown git command: ${sub}`, "use status | connect <owner/repo> [--push] | sync [-m message]");
}

// ---------------------------------------------------------------- deploy: artifacts
const ARTIFACT_FLAGS = ["artifact", "visibility", "keep", "title"];

/**
 * Links from a file or folder to the artifact it was deployed as, in `.cresslet/artifacts.json` next to it (keyed by its
 * name): outside a folder, so rebuilding it (e.g. `dist/`) keeps the link.
 */
/** An artifact a file or folder was deployed as, in .cresslet/artifacts.json. */
interface ArtifactLinkData {
  name: string;
  id?: string;
  api?: string;
}
interface ArtifactLink {
  get: ArtifactLinkData | undefined;
  save(data: ArtifactLinkData): void;
}

function artifactLink(abs: string): ArtifactLink {
  const dir = path.dirname(abs);
  const key = path.basename(abs);
  const file = path.join(dir, ".cresslet", "artifacts.json");
  let all: Record<string, ArtifactLinkData> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* none yet */ }
  return {
    get: Object.hasOwn(all, key) ? all[key] : undefined,
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...all, [key]: data }, null, 2) + "\n");
      try {
        if (inGitRepo(dir)) ensureGitignore(dir); // not a .gitignore in e.g. ~/Downloads
      } catch { /* the link is saved: a .gitignore that can't be written isn't worth failing for */ }
    },
  };
}

const inGitRepo = (dir: string): boolean => {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
};

/** What `deploy [target]` publishes as an artifact, or null for an app. */
function artifactTarget(target: string | undefined, flags: Flags): { target: string; link: ArtifactLink } | null {
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
async function deployArtifact({ target, link }: { target: string; link: ArtifactLink }, flags: Flags) {
  // The server it went to; a new one: the enclosing project's (e.g. `deploy dist --artifact` in a project made with --api).
  const root = link.get?.api ? null : findRoot(path.dirname(path.resolve(target)));
  const via = link.get?.api ?? (root ? readLink(root).api : undefined);
  const api = client({ flags, project: via ? { link: { api: via } } : undefined });
  if (!api.token) {
    const on = api.base === apiBase({}) ? "" : ` --api ${api.base}`;
    throw new CliError("artifacts need a login", `run \`cresslet login${on}\` (apps can deploy without one: cresslet deploy <folder> without artifact flags)`);
  }
  const { content, title } = pageContent(target);
  const settings = pageSettings(flags);
  if (flags.name === true || flags.name === "") throw new CliError("usage: cresslet deploy <file.html|dir> --name <address>");
  const linked = link.get?.api === api.base ? link.get : undefined;
  const name = flags.name === undefined ? linked?.name : String(flags.name);
  let cur: Page | undefined, r: { page: Page }, gone = false;
  if (name) {
    try {
      cur = (await api.get<{ page: Page }>(`/v1/pages/${encodeURIComponent(name)}`)).page;
    } catch (e) {
      // 403: someone else's (a token that can't create artifacts is refused by the POST below).
      if ((e as CliError).code !== "not_found" && (e as CliError).code !== "forbidden") throw e;
    }
    // The linked artifact expired or was deleted (its address may even be another artifact's by now).
    // (no --name: `name` is the linked one's)
    if (flags.name === undefined && (!cur || (linked!.id && cur.id !== linked!.id))) [cur, gone] = [undefined, true];
  }
  if (cur) r = await replaceArtifact(api, cur, content, settings);
  else {
    // `--name`: made under that address. A linked one that's gone: a new one (its old address and who could open it
    // aren't reused without asking: pass --name to take the address again).
    r = await api.post<{ page: Page }>("/v1/pages", { ...(name && !gone ? { name } : {}), title, ...settings, ...content, source: "cli" });
  }
  let saved = true;
  try {
    link.save({ name: r.page.name, id: r.page.id, api: api.base });
  } catch (e) {
    saved = false; // it's live anyway: say where, and how to update it
    const err = e as NodeJS.ErrnoException; // fs errors
    if (!flags.json) process.stderr.write(color.yellow(`couldn't save the link (${err.code ?? err.message}): deploy it again with --name ${r.page.name}\n`));
  }
  out(flags, () => {
    if (gone) console.log(color.yellow(`${name} is gone (expired, deleted, or not this account's): this is a new artifact at a new address (--name ${name} to take the old one again)`));
    console.log(`${color.green("✔")} deployed artifact ${color.bold(r.page.name)} ${color.dim(cur ? "(updated, same link)" : "(new)")}`);
    showPage(r.page);
    if (r.page.visibility === "private") console.log(color.dim(`  share it: ${api.base}/#/share/${encodeURIComponent(r.page.name)}`));
  }, { kind: "artifact", created: !cur, ...(gone ? { gone: name } : {}), ...(saved ? {} : { linked: false }), artifact: r.page });
}

const VIS_RANK: Record<Visibility, number> = { private: 0, link: 1, public: 2 };
/**
 * New files and settings for an existing artifact (`cur`, as GET returns it). Settings go before the files (a token
 * that can't change them uploads nothing), except a wider visibility, which goes after: the files are never open to
 * more people than the owner asked for, also when the upload fails.
 */
async function replaceArtifact(api: Client, cur: Page, content: PageContent, settings: PageSettingsChange): Promise<{ page: Page }> {
  const at = `/v1/pages/${encodeURIComponent(cur.name)}`;
  const { visibility, ...rest } = settings;
  const first: PageSettingsChange = rest;
  const widen = visibility !== undefined && VIS_RANK[visibility] > VIS_RANK[cur.visibility];
  // Widening: the same visibility for now, so a token that can't change it is refused before the upload.
  if (visibility !== undefined) first.visibility = widen ? cur.visibility : visibility;
  if (Object.keys(first).length) await api.patch(at, first);
  const r = await api.put<{ page: Page }>(at, { ...content, source: "cli" });
  return widen ? api.patch<{ page: Page }>(at, { visibility }) : r;
}

// Server defaults (CRESSLET_MAX_DEPLOY_FILES / _MB); built files and source share them.
// The source is skipped, not the deploy, when both don't fit.
const maxFiles = () => Number(process.env.CRESSLET_MAX_DEPLOY_FILES) || 2000;
const maxBytes = () => (Number(process.env.CRESSLET_MAX_DEPLOY_MB) || 25) * 1024 * 1024;

function readSources(
  root: string,
  { exclude, used, warn }: { exclude: string[]; used: { files: number; bytes: number }; warn: (msg: string) => void },
): WireFile[] | undefined {
  const paths = listSources(root, { exclude });
  if (!paths.length) return undefined; // e.g. `--dir .`: omit `sources`, not `[]`
  const skip = (why: string) => {
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
const keyOf = (link: Link | undefined, app: string, base: string) => (link?.name === app && link?.api === base ? link.deployKey : undefined);

/** Client for `app`: the project's deploy key only if its link is for that app on that server. */
function appClient(flags: Flags, project: Project | null, app: string): Client {
  const base = apiBase(flags, project);
  return client({ flags, project: { link: { api: base, deployKey: keyOf(project?.link, app, base) } } });
}

/** `cresslet pull [app|url] [--dir d] [--deploy id]`: write the source uploaded with a deploy. */
export async function cmdPull({ _: [target], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  // (no target or --app: `project` is required above)
  let dest = path.resolve(textFlag(flags, "dir") ?? (target || flags.app ? name : project!.root));
  dest = realDest(dest);
  const before = readLink(dest); // CLI metadata as it was before the pull (never from the response)
  if (fs.existsSync(dest) && fs.readdirSync(dest).filter((f) => f !== ".git").length && !flags.force) {
    throw new CliError(`${dest} is not empty`, "pass --dir <new dir> or --force to overwrite");
  }
  const q = flags.deploy ? `?deploy=${encodeURIComponent(flags.deploy)}` : "";
  const r = await api.get<{ app: string; deployId: string; files: WireFile[] }>(`/v1/apps/${encodeURIComponent(name)}/source${q}`);
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
export function pullPath(p: unknown): string {
  const bad = (why: string) => new CliError(`refusing to pull ${JSON.stringify(p)}: ${why}`);
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
function realDest(dest: string): string {
  const rest: string[] = [];
  for (let p = dest; ; p = path.dirname(p)) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT" || p === path.dirname(p)) throw new CliError(`cannot check ${p} before writing: ${err.code ?? err.message}`);
      rest.unshift(path.basename(p));
      continue;
    }
    if (p === dest && st.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${p}`);
    return path.join(fs.realpathSync(p), ...rest);
  }
}

/** Refuse to write through a symlink (or junction) at or above `rel` inside `dest`. */
function noSymlink(dest: string, rel: string): void {
  let p = dest;
  for (const s of rel.split(/[\\/]/).filter(Boolean)) {
    p = path.join(p, s);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return; // doesn't exist yet: nothing below it does either
      throw new CliError(`cannot check ${p} before writing: ${err.code ?? err.message}`);
    }
    if (st.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${p}`);
  }
}

// ---------------------------------------------------------------- auth
export async function cmdLogin({ flags }: Args): Promise<void> {
  const api = client({ flags });
  let r: Login;
  if (flags.token === "") throw new CliError("usage: cresslet auth login --token <token>");
  if (typeof flags.token === "string") {
    // Token from the studio's Settings page.
    const me = await api.get<{ account: Account }>("/v1/me", { token: flags.token });
    r = Object.assign(me, { token: flags.token });
  } else {
    if (flags.token) throw new CliError("usage: cresslet login --token <token>");
    const meta = await api.get<{ auth?: { cli?: boolean; github?: boolean } }>("/v1", { auth: false });
    if (meta.auth?.cli) r = await browserLogin(api, flags);
    else if (meta.auth?.github) r = await githubLogin(api, flags); // servers from before browser login
    else throw new CliError(`${api.base} has no login configured`, "use `cresslet login --token <token>` or set CRESSLET_TOKEN");
  }
  const g = readGlobal();
  g.tokens = { ...g.tokens, [api.base]: r.token };
  // Minted for this login (logout revokes it), or brought in with --token (logout leaves it valid).
  const minted = { ...g.minted };
  if (typeof flags.token === "string") delete minted[api.base];
  else minted[api.base] = "browser";
  g.minted = minted;
  writeGlobal(g);
  out(flags, `${color.green("✔")} logged in as ${color.bold(who(r.account))} on ${api.base}`, { account: r.account, api: api.base });
}

const who = (a: Account) => (a.github ? `${a.github} (${a.email})` : a.email);

/** Browser login: open the studio, the user enters the code there, poll until they do. */
async function browserLogin(api: Client, flags: Flags): Promise<Login> {
  const d = await api.post<DeviceCode>("/v1/auth/cli", {}, { auth: false });
  process.stderr.write(`open ${color.cyan(d.verificationUri)} and enter ${color.bold(d.userCode)}\n`);
  if (!flags["no-browser"] && process.stderr.isTTY) openUrl(d.verificationUri);
  process.stderr.write(color.dim("waiting for the browser…\n"));
  const deadline = Date.now() + (d.expiresIn || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, (d.interval || 2) * 1000));
    const p = await api.post<LoginPoll>("/v1/auth/cli/token", { deviceCode: d.deviceCode }, { auth: false });
    if (p.status === "complete") return p as Login;
  }
  throw new CliError("login expired", "run `cresslet login` again");
}

/** GitHub device flow, proxied by the server: show a code, poll until the user approves it. */
async function githubLogin(api: Client, flags: Flags): Promise<Login> {
  const d = await api.post<DeviceCode>("/v1/auth/github/device", {}, { auth: false });
  process.stderr.write(`open ${color.cyan(d.verificationUri)} and enter ${color.bold(d.userCode)}\n`);
  if (!flags["no-browser"] && process.stderr.isTTY) openUrl(d.verificationUri);
  process.stderr.write(color.dim("waiting for GitHub…\n"));
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + (d.expiresIn || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, interval));
    const p = await api.post<LoginPoll>("/v1/auth/github/device/token", { deviceCode: d.deviceCode }, { auth: false });
    if (p.status === "complete") return p as Login;
    if (p.status === "slow_down") interval = ((p as { interval?: number }).interval ?? interval / 1000 + 5) * 1000;
  }
  throw new CliError("code expired", "run `cresslet login` again");
}

function openUrl(url: string): void {
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

/**
 * Logs out of the saved login only (never CRESSLET_TOKEN: named if set, left alone): its remembered Live Link agents
 * are revoked on the server (with that token) and their files deleted; the token itself is revoked only if
 * `cresslet login` minted it (an imported one, `login --token`, stays valid). Remote failures are reported.
 */
export async function cmdLogout({ flags }: Args): Promise<void> {
  const base = apiBase(flags);
  const g = readGlobal();
  const saved = g.tokens?.[base];
  const notes: string[] = [];
  if (process.env.CRESSLET_TOKEN) notes.push("CRESSLET_TOKEN is set: logout doesn't touch it (unset it to stop using it)");
  let revokedAgents: string[] = [];
  let tokenRevoked = false;
  const failures: string[] = [];
  if (saved) {
    const api = client({ flags: { ...flags, api: base } });
    const store = agentStore({ api: base, token: saved });
    if (store.list().length) {
      try {
        revokedAgents = (await api.post<{ revoked: string[] }>("/v1/me/agents/revoke", {}, { token: saved })).revoked;
      } catch (e) {
        failures.push(`couldn't revoke this login's remembered agents on ${base} (${(e as Error).message}); forget them in Studio → Settings → Connected agents`);
      }
    }
    const removed = store.removeAll();
    if (removed.length) notes.push(`deleted ${removed.length} remembered agent${removed.length === 1 ? "" : "s"}`);
    if (g.minted?.[base] === "browser") {
      try {
        await api.post("/v1/me/token/revoke", {}, { token: saved });
        tokenRevoked = true;
      } catch (e) {
        failures.push(`couldn't revoke the login's token on ${base} (${(e as Error).message}); revoke it in Studio → Settings → API tokens`);
      }
    }
  }
  if (g.tokens) delete g.tokens[base];
  if (g.minted) delete g.minted[base];
  writeGlobal(g);
  out(flags, () => {
    console.log(saved ? `logged out of ${base}${tokenRevoked ? " (token revoked)" : ""}` : `not logged in to ${base}`);
    for (const n of notes) console.log(color.dim(n));
    for (const f of failures) console.error(`${color.yellow("!")} ${f}`);
  }, { api: base, tokenRevoked, revokedAgents, failures });
  if (failures.length) process.exitCode = 1;
}

export async function cmdWhoami({ flags }: Args): Promise<void> {
  const api = client({ flags });
  if (!api.token) throw new CliError(`not logged in to ${api.base}`, "run `cresslet login`");
  const r = await api.get<{ account: Account }>("/v1/me");
  out(flags, `${who(r.account)} ${color.dim(`(${api.base})`)}`, { ...r, api: api.base });
}

export async function cmdClaim({ flags }: Args): Promise<void> {
  const project = loadProject();
  const api = client({ flags, project });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  const name = appName(project, flags);
  const r = await api.post(`/v1/apps/${encodeURIComponent(name)}/claim`, { deployKey: project.link.deployKey });
  out(flags, `${color.green("✔")} claimed ${color.bold(name)}: no expiry, outbound fetch + secrets enabled`, r);
}

// ---------------------------------------------------------------- inspect
export async function cmdApps({ flags }: Args): Promise<void> {
  const api = client({ flags });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  const r = await api.get<{ apps: { name: string; url: string; updatedAt: string }[] }>("/v1/apps");
  out(flags, () => {
    if (!r.apps.length) return console.log("no apps yet");
    for (const a of r.apps) console.log(`${color.bold(a.name.padEnd(28))} ${a.url}  ${color.dim(a.updatedAt)}`);
  }, r);
}

export async function cmdInspect({ _: [target], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const env = envFrom(flags, target);
  const api = appClient(flags, project, name);
  await assertEnv(api, name, env);
  const r = await api.get<{
    app: { name: string; url: string; claimed: boolean; expiresAt: string; config: { routes?: string[]; server?: unknown } };
    runtime: { running: boolean; pid?: number };
    secrets: string[];
    deploys: { current: boolean; id: string; createdAt: string; files: number; bytes: number; server: unknown; source: string; git?: { sha: string; branch: string | null } | null }[];
    repo?: { fullName: string } | null;
    environments?: { name: string; url: string; currentDeployId: string | null; config?: { routes?: string[]; server?: unknown } | null }[];
  }>(withEnv(`/v1/apps/${encodeURIComponent(name)}`, env));
  out(flags, () => {
    const a = r.app;
    const here = env ? r.environments?.find((e) => e.name === env) : undefined;
    console.log(`${color.bold(a.name)}${env ? ` (${env})` : ""}  ${color.cyan(here?.url ?? a.url)}`);
    console.log(`  claimed: ${a.claimed ? "yes" : `no (expires ${a.expiresAt})`}`);
    const config = (env ? here?.config : null) ?? a.config; // the environment's own (its deploy's routes and server)
    console.log(`  routes:  ${(config.routes ?? []).join(", ")}${config.server ? "" : " (no server)"}`);
    console.log(`  runtime: ${r.runtime.running ? `running (pid ${r.runtime.pid})` : "idle"}`);
    console.log(`  secrets: ${r.secrets.length ? r.secrets.join(", ") : "none"}`);
    if (r.repo) console.log(`  repo:    ${r.repo.fullName}`);
    if ((r.environments?.length ?? 0) > 1) {
      console.log(`  envs:    ${r.environments!.map((e) => `${e.name}${e.currentDeployId ? ` (${e.currentDeployId})` : ""}`).join(", ")}`);
    }
    console.log("  deploys:");
    for (const d of r.deploys) {
      const g = d.git ? `  ${d.git.branch ?? "commit"} @ ${d.git.sha.slice(0, 7)}` : "";
      console.log(`    ${d.current ? color.green("●") : " "} ${d.id}  ${d.createdAt}  ${d.files} files ${formatBytes(d.bytes)}${d.server ? " +server" : ""}  ${color.dim(d.source + g)}`);
    }
  }, r);
}

function nameFrom(target: string): string {
  try {
    // `https://shop--staging.<domain>`: the app (its environment comes from envFrom).
    return new URL(target).hostname.split(".")[0].split("--")[0];
  } catch {
    return target;
  }
}

/** The environment a command acts on: `--env staging`, or a staging URL; undefined: production. */
function envFrom(flags: Flags, target?: string): string | undefined {
  const flag = textFlag(flags, "env");
  if (flag !== undefined) return flag === "production" ? undefined : flag;
  try {
    const label = target ? new URL(target).hostname.split(".")[0] : "";
    const i = label.indexOf("--");
    return i > 0 ? label.slice(i + 2) : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Before a command acts on an environment: the server must have environments (an older one ignores `?env=` and
 * `env` in a body, so the command would read or change production) and the app this one.
 */
async function assertEnv(api: Client, name: string, env: string | undefined): Promise<void> {
  if (!env) return;
  const r = await api.get<{ environments: { name: string }[] }>(`/v1/apps/${encodeURIComponent(name)}/envs`).catch((e: CliError) => {
    if (e.code === "not_found" && /no such endpoint/.test(e.message)) throw new CliError(`${api.base} doesn't have environments (update the server): nothing was done`);
    throw e;
  });
  if (!r.environments.some((e) => e.name === env)) throw new CliError(`${name} has no ${env} environment`, `deploy to it first: cresslet deploy --env ${env}`);
}
/** `path` of one of the app's environments (`?env=`; production: as is). */
const withEnv = (p: string, env: string | undefined) => (env ? `${p}${p.includes("?") ? "&" : "?"}env=${encodeURIComponent(env)}` : p);

export async function cmdLogs({ _: [target], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !target && !flags.app });
  const name = target ? nameFrom(target) : appName(project ?? { link: {}, config: {} }, flags);
  const env = envFrom(flags, target);
  const api = appClient(flags, project, name);
  await assertEnv(api, name, env);
  const follow = !!(flags.follow ?? flags.f);
  const res = await api.get(withEnv(`/v1/apps/${encodeURIComponent(name)}/logs?n=${Number(flags.n ?? 100)}${follow ? "&follow=1" : ""}`, env), { stream: true });
  const dec = new TextDecoder();
  let buf = "";
  const kindColor: Record<string, (s: unknown) => string> = { stderr: color.red, system: color.yellow, request: color.dim, stdout: (s) => s as string };
  for await (const chunk of res.body!) { // (an ok reply to GET has a body)
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
      const l = JSON.parse(line) as { t: number | string; kind: string; msg: string };
      const time = new Date(l.t).toISOString().slice(11, 23);
      console.log(`${color.dim(time)} ${(kindColor[l.kind] ?? String)(l.msg)}`);
    }
  }
}

export async function cmdDb({ _: [sql], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const env = envFrom(flags);
  const api = appClient(flags, project, name);
  await assertEnv(api, name, env);
  if (sql) {
    const r = await api.post<{ rows: unknown[] }>(withEnv(`/v1/apps/${encodeURIComponent(name)}/db/query`, env), { sql });
    return out(flags, () => console.table(r.rows), r);
  }
  const r = await api.get<{ tables: Record<string, { count: number; schema: string; rows: unknown[] }> }>(
    withEnv(`/v1/apps/${encodeURIComponent(name)}/db?limit=${Number(flags.limit ?? 20)}`, env),
  );
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

export async function cmdSecrets({ _: [sub, ...rest], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  // `--env staging`: its own secrets, overriding production's (which it sees too).
  const env = envFrom(flags);
  const api = appClient(flags, project, name);
  await assertEnv(api, name, env);
  const at = withEnv(`/v1/apps/${encodeURIComponent(name)}/secrets`, env);
  if (!sub || sub === "list" || sub === "ls") {
    const r = await api.get<{ keys: string[]; secrets?: { key: string; source: string }[] }>(at);
    if (r.secrets) {
      return out(flags, r.secrets.length ? r.secrets.map((x) => `${x.key}${x.source === env ? "" : color.dim(` (from ${x.source})`)}`).join("\n") : "no secrets", r);
    }
    return out(flags, r.keys.length ? r.keys.join("\n") : "no secrets", r);
  }
  if (sub === "set") {
    if (!rest.length) throw new CliError("usage: cresslet secrets set KEY=value [KEY2=value2…]");
    const body: Record<string, string> = {};
    for (const kv of rest) {
      const i = kv.indexOf("=");
      if (i < 1) throw new CliError(`expected KEY=value, got ${kv}`);
      body[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const r = await api.put(at, body);
    return out(flags, `${color.green("✔")} set ${Object.keys(body).join(", ")}${env ? ` in ${env}` : ""}`, r);
  }
  if (sub === "unset" || sub === "rm") {
    const body = Object.fromEntries(rest.map((k) => [k, null]));
    const r = await api.put(at, body);
    return out(flags, `${color.green("✔")} removed ${rest.join(", ")}${env ? ` from ${env}` : ""}`, r);
  }
  throw new CliError(`unknown secrets command: ${sub}`, "use list | set KEY=value | unset KEY");
}

export async function cmdDomains({ _: [sub, domain], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const base = `/v1/apps/${encodeURIComponent(name)}/domains`;
  const show = (d: Domain) => {
    console.log(`${color.bold(d.domain)}  ${d.verified ? color.green("verified") : color.yellow("pending")}`);
    if (!d.verified) for (const x of d.dns) console.log(`  ${x.type.padEnd(5)} ${x.name}  →  ${x.value}`);
  };
  if (!sub || sub === "list" || sub === "ls") {
    const r = await api.get<{ domains: Domain[] }>(base);
    return out(flags, () => (r.domains.length ? r.domains.forEach(show) : console.log("no custom domains")), r);
  }
  if (!domain) throw new CliError(`usage: cresslet domains ${sub} <domain>`);
  const d = encodeURIComponent(domain);
  if (sub === "add") {
    const r = await api.post<{ domain: Domain }>(base, { domain });
    return out(flags, () => {
      show(r.domain);
      if (!r.domain.verified) console.log(color.dim(`  create these DNS records, then: cresslet domains verify ${r.domain.domain}`));
    }, r);
  }
  if (sub === "verify") {
    const r = await api.post<{ domain: Domain }>(`${base}/${d}/verify`);
    return out(flags, `${color.green("✔")} ${r.domain.domain} verified`, r);
  }
  if (sub === "rm" || sub === "remove") {
    const r = await api.del(`${base}/${d}`);
    return out(flags, `${color.green("✔")} removed ${domain}`, r);
  }
  throw new CliError(`unknown domains command: ${sub}`, "use list | add <domain> | verify <domain> | rm <domain>");
}

export async function cmdEgress({ _: [sub, ...hosts], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const p = `/v1/apps/${encodeURIComponent(name)}/egress`;
  type Egress = { allow: string[] | null };
  const show = (r: Egress) => (r.allow ? (r.allow.length ? r.allow.join("\n") : "no outbound hosts allowed") : "any public host (no allowlist)");
  if (!sub || sub === "show") {
    const r = await api.get<Egress>(p);
    return out(flags, show(r), r);
  }
  if (sub === "allow") {
    if (!hosts.length) throw new CliError("usage: cresslet egress allow <host…>", "e.g. api.stripe.com '*.openai.com'");
    const r = await api.put<{ allow: string[] }>(p, { allow: hosts });
    return out(flags, `${color.green("✔")} allowlist: ${r.allow.join(", ")}`, r);
  }
  if (sub === "clear") {
    const r = await api.put<Egress>(p, { allow: null });
    return out(flags, `${color.green("✔")} ${show(r)}`, r);
  }
  throw new CliError(`unknown egress command: ${sub}`, "use show | allow <host…> | clear");
}

export async function cmdRollback({ _: [deployId], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const env = envFrom(flags);
  const api = appClient(flags, project, name);
  await assertEnv(api, name, env);
  const r = await api.post<{ app: { currentDeployId: string }; environment?: { currentDeployId: string } }>(
    `/v1/apps/${encodeURIComponent(name)}/rollback`, { deployId, ...(env ? { env } : {}) },
  );
  out(flags, `${color.green("✔")} ${name}${env ? ` (${env})` : ""} now serving ${(env ? r.environment?.currentDeployId : null) ?? r.app.currentDeployId}`, r);
}

/**
 * `cresslet promote [--from staging] [-y]`: production serves what staging does (the same deploy, not rebuilt). On a
 * GitHub-linked app the server first moves the default branch to that deploy's commit (fast-forward only) and tags it.
 */
export async function cmdPromote({ flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const from = textFlag(flags, "from") ?? "staging";
  const api = appClient(flags, project, name);
  type Env = { name: string; url: string; currentDeployId: string | null };
  const envs = await api.get<{ environments: Env[] }>(`/v1/apps/${encodeURIComponent(name)}/envs`).catch((e: CliError) => {
    if (e.code === "not_found" && /no such endpoint/.test(e.message)) throw new CliError(`${api.base} doesn't have environments (update the server)`);
    throw e;
  });
  const src = envs.environments.find((e) => e.name === from);
  const prod = envs.environments.find((e) => e.name === "production");
  if (!src?.currentDeployId) throw new CliError(`nothing is deployed to ${name}'s ${from}`, `cresslet deploy --env ${from}`);
  if (src.currentDeployId === prod?.currentDeployId) return out(flags, `${name}: production already serves ${src.currentDeployId}`, { promoted: false, deployId: src.currentDeployId });
  if (!flags.yes && !flags.y) {
    const a = await ask(`promote ${src.currentDeployId} from ${from} to production (${name})? [y/N] `);
    if (!/^y(es)?$/i.test(a)) throw new CliError("aborted");
  }
  const r = await api.post<{ app: { url: string; currentDeployId: string }; deploy: { id: string; tag?: string; warning?: string }; promoted: boolean }>(
    `/v1/apps/${encodeURIComponent(name)}/promote`, { from, deployId: src.currentDeployId },
  );
  out(flags, () => {
    console.log(`${color.green("✔")} promoted ${color.bold(r.deploy.id)} from ${from} to production${r.deploy.tag ? ` as ${color.bold(r.deploy.tag)}` : ""}`);
    console.log(`  ${color.cyan(r.app.url)}`);
    if (r.deploy.warning) console.log(color.yellow(`  ${r.deploy.warning}`));
  }, r);
}

/** `cresslet env [ls] | seed <env> [--from production] | rm <env> [-y]`: the app's environments. */
export async function cmdEnv({ _: [sub = "ls", env], flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const base = `/v1/apps/${encodeURIComponent(name)}/envs`;
  if (sub === "ls" || sub === "list") {
    const r = await api.get<{ environments: { name: string; url: string; private: boolean; currentDeployId: string | null }[] }>(base);
    return out(flags, () => {
      for (const e of r.environments) {
        console.log(`${color.bold(e.name.padEnd(12))} ${color.cyan(e.url)}  ${e.currentDeployId ?? color.dim("nothing deployed")}${e.private ? color.dim("  private") : ""}`);
      }
      if (r.environments.length === 1) console.log(color.dim("  staging: cresslet deploy --env staging"));
    }, r);
  }
  if (!env || env === "production") throw new CliError(`usage: cresslet env ${sub} <env>`, "e.g. cresslet env " + sub + " staging");
  if (sub === "seed" || sub === "clone") {
    const from = textFlag(flags, "from") ?? "production";
    const r = await api.post<{ bytes: number }>(`${base}/${encodeURIComponent(env)}/seed`, { from });
    return out(flags, `${color.green("✔")} ${env}'s database replaced by a snapshot of ${from}'s (${formatBytes(r.bytes)}; files not copied)`, r);
  }
  if (sub === "rm" || sub === "delete") {
    if (!flags.yes && !flags.y) {
      const a = await ask(`delete ${name}'s ${env} (its data and deploys)? type ${env} to confirm: `);
      if (a !== env) throw new CliError("aborted");
    }
    const r = await api.del(`${base}/${encodeURIComponent(env)}`);
    return out(flags, `${color.green("✔")} deleted ${name}'s ${env}`, r);
  }
  throw new CliError(`unknown env command: ${sub}`, "use ls | seed <env> | rm <env>");
}

export async function cmdDelete({ flags }: Args): Promise<void> {
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

export async function cmdOpen({ flags }: Args): Promise<void> {
  const project = loadProject(process.cwd(), { required: !flags.app });
  const name = appName(project ?? { link: {}, config: {} }, flags);
  const api = appClient(flags, project, name);
  const r = await api.get<{ app: { url: string } }>(`/v1/apps/${encodeURIComponent(name)}`);
  openUrl(r.app.url);
  console.log(r.app.url);
}

// ---------------------------------------------------------------- artifacts (static HTML with a visibility and retention; API: /v1/pages)
const VISIBILITIES: string[] = ["private", "link", "public"] satisfies Visibility[];
const VIS_TEXT: Record<string, string> = { private: "private (you + people you share it with)", link: "anyone with the link", public: "public" };
const keepText = (d: number | null) => (d === null ? "forever" : `${d} day${d === 1 ? "" : "s"}`);

/** `--visibility` / `--keep` (days or "forever") / `--title`, as the API's fields; only the ones given. */
/** Settings to change (only the ones given); `title`: null for the server's default. */
interface PageSettingsChange {
  visibility?: Visibility;
  retentionDays?: number | null;
  title?: string | null;
}

function pageSettings(flags: Flags, prefix = ""): PageSettingsChange {
  const out: PageSettingsChange = {};
  const vis = flags[`${prefix}visibility`];
  if (vis !== undefined) {
    if (!VISIBILITIES.includes(vis as string)) throw new CliError(`--${prefix}visibility must be one of ${VISIBILITIES.join(", ")}`);
    out.visibility = vis as Visibility; // one of VISIBILITIES
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
/** What an artifact upload sends: one HTML file, or a folder's files. */
type PageContent = { html: string } | { files: WireFile[] };

function pageContent(target: string): { content: PageContent; title: string } {
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
  const files: WireFile[] = [];
  const walk = (dir: string, rel: string) => {
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

const accountClient = (flags: Flags): Client => {
  const api = client({ flags });
  if (!api.token) throw new CliError("login required", "run `cresslet login`");
  return api;
};

function showPage(p: Page): void {
  console.log(`${color.bold(p.title ?? p.name)}  ${color.cyan(p.url)}`);
  console.log(`  who can open: ${VIS_TEXT[p.visibility] ?? p.visibility}`);
  console.log(`  kept:         ${p.retentionDays === null ? "forever" : `${keepText(p.retentionDays)} (until ${p.expiresAt})`}`);
  console.log(`  ${color.dim(`${p.name} · ${p.files} file${p.files === 1 ? "" : "s"}, ${formatBytes(p.bytes)}${p.access && p.access !== "owner" ? ` · you: ${p.access}` : ""}`)}`);
}

export async function cmdArtifact({ _: [sub, target, file], flags }: Args): Promise<void> {
  const api = accountClient(flags);
  const page = (t: string | undefined) => {
    if (!t) throw new CliError(`usage: cresslet artifact ${sub} <name|url>${sub === "update" ? " <file|dir>" : ""}`);
    return encodeURIComponent(nameFrom(t));
  };
  if (!sub || sub === "ls" || sub === "list") {
    const r = await api.get<{ pages: Page[] }>("/v1/pages");
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
    const r = await api.post<{ page: Page }>("/v1/pages", { ...name, title, ...pageSettings(flags), ...content, source: "cli" });
    return out(flags, () => {
      console.log(`${color.green("✔")} uploaded`);
      showPage(r.page);
    }, r);
  }
  if (sub === "show" || sub === "info") {
    const r = await api.get<{ page: Page }>(`/v1/pages/${page(target)}`);
    return out(flags, () => showPage(r.page), r);
  }
  if (sub === "update") {
    if (!file) throw new CliError("usage: cresslet artifact update <name|url> <file.html|dir>");
    const { content } = pageContent(file);
    const settings = pageSettings(flags);
    const cur = (await api.get<{ page: Page }>(`/v1/pages/${page(target)}`)).page;
    const r = await replaceArtifact(api, cur, content, settings);
    return out(flags, () => {
      console.log(`${color.green("✔")} updated (same link)`);
      showPage(r.page);
    }, r);
  }
  if (sub === "set") {
    const change = pageSettings(flags);
    if (!Object.keys(change).length) throw new CliError("nothing to change", "pass --visibility, --keep and/or --title");
    const r = await api.patch<{ page: Page }>(`/v1/pages/${page(target)}`, change);
    return out(flags, () => showPage(r.page), r);
  }
  if (sub === "open") {
    // Private artifacts: a one-time sign-in link (the browser keeps a session cookie for that artifact).
    const r = await api.post<{ url: string }>(`/v1/pages/${page(target)}/view`, {});
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
export async function cmdSettings({ flags }: Args): Promise<void> {
  const api = accountClient(flags);
  const f = { ...flags };
  for (const k of ["visibility", "keep"]) f[`artifact-${k}`] ??= flags[`page-${k}`];
  const change = pageSettings(f, "artifact-");
  type Settings = { pages: PageSettings; defaults: { pages: PageSettings } };
  const r = flags.reset
    ? await api.put<Settings>("/v1/me/settings", { pages: null })
    : Object.keys(change).length
    ? await api.put<Settings>("/v1/me/settings", { pages: change })
    : await api.get<Settings>("/v1/me/settings");
  out(flags, () => {
    console.log(color.bold("new artifacts"));
    console.log(`  who can open: ${VIS_TEXT[r.pages.visibility]}`);
    console.log(`  kept:         ${keepText(r.pages.retentionDays)}`);
    console.log(color.dim(`  server default: ${r.defaults.pages.visibility}, ${keepText(r.defaults.pages.retentionDays)}`));
  }, r);
}

// ---------------------------------------------------------------- config
const CONFIG_KEYS: Record<string, string> = { api: "Cresslet server URL" };

/** `config [list] | get <key> | set <key> <value> | unset <key>`, stored in ~/.config/cresslet/config.json. */
export async function cmdConfig({ _: [sub = "list", key, value], flags }: Args): Promise<void> {
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
    delete g[key as keyof GlobalConfig]; // a CONFIG_KEYS key
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
