// `npm run build` (and prepare): a fresh dist/ from the TypeScript sources (tsconfig.build.json), plus the vendored
// JavaScript the compiled code loads by relative path.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
// The project's own tsc, run by this Node (no shell: paths with spaces, Windows), also outside npm's PATH.
const tscBin = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const tsc = spawnSync(process.execPath, [tscBin, "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (tsc.error) console.error(`build: ${tsc.error.message}`);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// lib/frontend.ts loads ./compilers.cjs (vendored verbatim from cresslet-container: it stays JavaScript).
fs.copyFileSync(path.join(root, "lib", "compilers.cjs"), path.join(dist, "lib", "compilers.cjs"));
fs.chmodSync(path.join(dist, "bin", "cresslet.js"), 0o755);
