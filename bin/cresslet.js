#!/usr/bin/env node
import * as c from "../lib/commands.js";
import { CliError, color, parseArgs } from "../lib/util.js";

const VERSION = "0.1.0";

const COMMANDS = {
  new: [c.cmdNew, "new <dir> [--template react|vanilla]", "create an app from a template"],
  init: [c.cmdInit, "init [--template react|vanilla]", "create an app in the current directory"],
  templates: [c.cmdTemplates, "templates", "list templates"],
  dev: [c.cmdDev, "dev [--port 3000]", "run locally with live reload"],
  build: [c.cmdBuild, "build", "production build (dist/ + .cresslet/build/server.js)"],
  deploy: [c.cmdDeploy, "deploy [--name n] [--dir d --server f]", "build and deploy (+ source); prints the URL"],
  pull: [c.cmdPull, "pull [app|url] [--dir d] [--deploy id]", "download a deploy's source"],
  logs: [c.cmdLogs, "logs [app|url] [-f] [-n 100]", "show server + request logs"],
  db: [c.cmdDb, "db [sql]", "inspect the deployed database (read-only)"],
  domains: [c.cmdDomains, "domains [add|verify|rm <domain>]", "custom domains (claimed apps)"],
  egress: [c.cmdEgress, "egress [allow <host…>|clear]", "outbound fetch allowlist (claimed apps)"],
  secrets: [c.cmdSecrets, "secrets [list|set K=V|unset K]", "manage server secrets (claimed apps)"],
  inspect: [c.cmdInspect, "inspect [app|url]", "show app status and deploys"],
  rollback: [c.cmdRollback, "rollback [deployId]", "serve a previous deploy"],
  open: [c.cmdOpen, "open", "open the deployed app"],
  delete: [c.cmdDelete, "delete [-y]", "delete the app and its data"],
  login: [c.cmdLogin, "login [--token t] [--no-browser]", "log in in the browser, or with a token from studio Settings"],
  logout: [c.cmdLogout, "logout", "forget the token"],
  whoami: [c.cmdWhoami, "whoami", "show the logged-in account"],
  claim: [c.cmdClaim, "claim", "attach this app to your account (no expiry, net + secrets)"],
  apps: [c.cmdApps, "apps", "list your apps"],
  page: [c.cmdPage, "page [ls|upload|show|update|set|open|rm]", "static HTML pages: upload <file|dir> [--visibility v] [--keep days|forever]"],
  config: [c.cmdConfig, "config [get|set|unset api <url>]", "CLI settings, e.g. the server (default https://cresslet.dev)"],
  settings: [c.cmdSettings, "settings [--page-visibility|--page-keep]", "your defaults for new pages (--reset: the server's)"],
};

function help() {
  console.log(`${color.bold("cresslet")} ${VERSION} — create, run and deploy small web apps\n`);
  console.log("usage: cresslet <command> [options]\n");
  for (const [, usage, desc] of Object.values(COMMANDS)) console.log(`  ${usage.padEnd(42)} ${color.dim(desc)}`);
  console.log(`  ${"auth login|logout|status".padEnd(42)} ${color.dim("same as login, logout, whoami")}`);
  console.log(`\nglobal: --api <url> (or CRESSLET_API, or "cresslet config set api <url>"), --json (machine-readable output), --app <name>`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
  process.exit(0);
}
if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
// `auth login|logout|status`: same as login / logout / whoami.
const AUTH = { login: "login", logout: "logout", status: "whoami" };
let args = rest;
let name = cmd;
if (cmd === "auth") {
  const usage = "usage: cresslet auth login [--token t] [--no-browser] | logout | status";
  if (rest.some((a) => a === "--help" || a === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  name = AUTH[rest[0]];
  args = rest.slice(1);
  if (!name) {
    if (rest[0]) console.error(color.red(`unknown auth command: ${rest[0]}`));
    console.error(usage);
    process.exit(1);
  }
}
const entry = COMMANDS[name];
if (!entry) {
  console.error(color.red(`unknown command: ${cmd}`));
  help();
  process.exit(1);
}

try {
  await entry[0](parseArgs(args, { bool: ["json", "follow", "f", "yes", "y", "force", "no-browser", "no-source", "reset"] }));
} catch (e) {
  if (e instanceof CliError) {
    console.error(`${color.red("✖")} ${e.message}`);
    if (e.hint) console.error(color.dim(`  ${e.hint}`));
  } else console.error(e?.stack ?? e);
  process.exit(1);
}
