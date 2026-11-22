// `npm run typecheck` (after tsc): the repo stays TypeScript. Fails when
//   - a JavaScript file (.js .mjs .cjs .jsx) is in the repo (tracked, or new and not ignored) outside JS_ALLOWED, or
//   - our TypeScript turns checking off: a ts-ignore / ts-nocheck comment, or ts-expect-error without a reason after it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** JavaScript that stays JavaScript, and why. A path, or a directory ending in `/`. */
const JS_ALLOWED: Record<string, string> = {
  "lib/compilers.cjs": "vendored verbatim from cresslet-container (src/css/worker.cjs): change it there and copy it again",
  "test/contract/app.js": "the shared SDK contract cases, an app's server module: the cresslet repo vendors it as JavaScript",
  "test/fixture/": "an app project the tests copy and build (its content, not this package's code)",
};
/** TypeScript that isn't ours to hold to the rules (fixture content). */
const TS_EXEMPT = ["test/fixture/"];

// (split, so this file doesn't match itself)
const AT = "@ts-";

const root = path.join(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && fs.existsSync(path.join(root, f))); // (a deletion not yet staged)
const under = (f: string, entries: string[]) => entries.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));

const problems: string[] = [];
for (const f of files) {
  if (/\.(?:[cm]?js|jsx)$/.test(f) && !under(f, Object.keys(JS_ALLOWED))) {
    problems.push(`${f}: JavaScript; write it in TypeScript (or add it to JS_ALLOWED in scripts/check-ts.ts, with why)`);
  }
  if (/\.(?:[cm]?ts|tsx)$/.test(f) && !under(f, TS_EXEMPT)) {
    fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
      if (new RegExp(`${AT}(?:ignore|nocheck)\\b`).test(line)) problems.push(`${f}:${i + 1}: ${AT}ignore / ${AT}nocheck: fix the type instead`);
      if (new RegExp(`${AT}expect-error(?!\\s+--?\\s*\\S)`).test(line)) {
        problems.push(`${f}:${i + 1}: ${AT}expect-error needs a reason: // ${AT}expect-error -- why`);
      }
    });
  }
}
for (const entry of Object.keys(JS_ALLOWED)) {
  if (!files.some((f) => under(f, [entry]))) problems.push(`scripts/check-ts.ts: JS_ALLOWED lists ${entry}, which isn't in the repo: remove it`);
}

if (problems.length) {
  console.error(`check-ts: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-ts: ok (${files.length} files; JavaScript only in ${Object.keys(JS_ALLOWED).join(", ")})`);
