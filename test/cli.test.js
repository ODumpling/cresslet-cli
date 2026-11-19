import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDotenv, loadProject } from "../lib/util.js";
import { build, parseHtml } from "../lib/build.js";
import { dev, matchRoute } from "../lib/dev.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clover-cli-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["new", "x", "--template", "react", "-f", "--json", "--n=5"], { bool: ["json", "f"] }), {
    _: ["new", "x"],
    flags: { template: "react", f: true, json: true, n: "5" },
  });
});

test("parseDotenv", () => {
  assert.deepEqual(parseDotenv("A=1\n# c\nexport B='two'\nC=\"x=y\"\nbad line"), { A: "1", B: "two", C: "x=y" });
});

test("matchRoute", () => {
  assert.ok(matchRoute("/api/*", "/api"));
  assert.ok(matchRoute("/api/*", "/api/x/y"));
  assert.ok(!matchRoute("/api/*", "/apix"));
  assert.ok(matchRoute("/hook", "/hook"));
  assert.ok(!matchRoute("/hook", "/hook/2"));
});

test("parseHtml skips public and remote refs", () => {
  const dir = copyFixture();
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8") +
    '<script type="module" src="https://cdn.example/x.js"></script>';
  const entries = parseHtml(html, dir);
  assert.deepEqual(entries.map((e) => [e.kind, e.ref]), [["js", "/src/main.ts"]]); // /style.css is in public/
});

test("build produces hashed client + server bundle", async () => {
  const dir = copyFixture();
  const r = await build(dir);
  assert.ok(r.files.includes("index.html"));
  assert.ok(r.files.includes("style.css"));
  const js = r.files.find((f) => /^assets\/main-[A-Z0-9]+\.js$/.test(f));
  assert.ok(js, `no hashed js in ${r.files}`);
  const html = fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  assert.match(html, new RegExp(`src="/${js}"`));
  assert.ok(fs.readFileSync(r.serverFile, "utf8").includes("export"));
});

test("dev server: static, api with sqlite, dotfiles hidden", async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, ".env.clover"), "SECRET=1\n");
  const d = await dev(loadProject(dir), { port: 0, log: () => {} });
  try {
    const home = await (await fetch(d.url + "/")).text();
    assert.match(home, /\/assets\/src\/main\.js/);
    assert.match(home, /__clover\/reload/);
    assert.equal((await (await fetch(d.url + "/api/visits", { method: "POST" })).json()).visits, 1);
    assert.equal((await (await fetch(d.url + "/api/visits", { method: "POST" })).json()).visits, 2);
    assert.equal((await fetch(d.url + "/.env.clover")).status, 404);
    assert.equal((await fetch(d.url + "/server/index.ts")).status, 404);
    assert.equal((await fetch(d.url + "/assets/src/main.js")).status, 200);
    assert.match(await (await fetch(d.url + "/some/route")).text(), /<main>/);
  } finally {
    await d.close();
  }
});
