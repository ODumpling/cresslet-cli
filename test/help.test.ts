// `<command> --help` / `-h` prints usage without running the command; `--version` comes from package.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Runs compiled, from dist/test/ (npm test): the built CLI is dist/bin/cresslet.js, the repo two levels up.
const CLI = fileURLToPath(new URL("../bin/cresslet.js", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };
const run = promisify(execFile);

/** Runs the CLI in a scratch app dir against a server that records every request. */
async function cli(args: string[]) {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push(`${req.method} ${req.url} ${body}`.trim());
    if (req.url!.endsWith("/rollback")) res.writeHead(200).end(JSON.stringify({ app: { currentDeployId: "d1" } }));
    else res.writeHead(500).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-help-"));
  fs.writeFileSync(path.join(dir, "cresslet.json"), JSON.stringify({ name: "a" }));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
  const env = {
    ...process.env,
    CRESSLET_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    CRESSLET_CONFIG_DIR: path.join(dir, ".cfg"),
    CRESSLET_TOKEN: "t",
    NO_COLOR: "1",
  };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: dir, env, timeout: 20_000 });
    return { stdout, calls, files: fs.readdirSync(dir).sort() };
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const flag of ["--help", "-h"]) {
  for (const [cmd, usage] of [["deploy", "deploy [file|dir] [--artifact] [--name n]"], ["delete", "delete [-y]"], ["rollback", "rollback [deployId]"], ["build", "build"], ["login", "login [--token t]"]]) {
    test(`${cmd} ${flag} prints usage and does not run`, async () => {
      const { stdout, calls, files } = await cli([cmd, flag]);
      assert.match(stdout, new RegExp(`^usage: cresslet ${usage.replace(/[[\]]/g, "\\$&")}`));
      assert.deepEqual(calls, []);
      assert.deepEqual(files, ["cresslet.json", "index.html"]);
    });
  }
}

test("help flag after other args still wins", async () => {
  const { stdout, calls } = await cli(["delete", "-y", "--help"]);
  assert.match(stdout, /^usage: cresslet delete/);
  assert.deepEqual(calls, []);
});

test("--help after -- is passed through, not treated as help", async () => {
  const { stdout, calls } = await cli(["rollback", "--", "--help"]);
  assert.doesNotMatch(stdout, /^usage:/);
  assert.deepEqual(calls, ['POST /v1/apps/a/rollback {"deployId":"--help"}']);
});

test("auth login --help", async () => {
  const { stdout } = await cli(["auth", "login", "--help"]);
  assert.match(stdout, /^usage: cresslet auth login/);
});

test("unknown command (even a prototype key) with --help is an error", async () => {
  await assert.rejects(cli(["constructor", "--help"]), (e: { code?: number; stderr?: string }) => e.code === 1 && /unknown command: constructor/.test(e.stderr ?? ""));
});

test("--version / -v print package.json version", async () => {
  for (const flag of ["--version", "-v"]) assert.equal((await cli([flag])).stdout.trim(), PKG.version);
});

test("top-level help shows package.json version", async () => {
  assert.ok((await cli(["--help"])).stdout.startsWith(`cresslet ${PKG.version} `));
});
