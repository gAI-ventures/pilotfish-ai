#!/usr/bin/env node
// Decides and prepares a release of one public npm package (the two MCPs and the SDK), for the publish workflows
// (docs/PUBLISHING.md):
//   node scripts/mcp-release.mjs <mcp|mcp-managed|sdk> [--against <tarball>]
//
// 1. The version: release.json's when it is above the latest on npm (a deliberate bump of the minor or major), else
//    the latest on npm plus one patch.
// 2. Builds the package with it: packages/<name>/scripts/package.mjs, with all its checks (classified code only,
//    nothing hosted-only, user docs that match the server).
// 3. Compares what would ship (every file: cli.js or dist/, README.md, LICENSE, and package.json but its version) with
//    the latest on npm.
//    Unchanged: nothing to publish, whatever the push changed elsewhere.
//
// Prints a summary and writes name, version, on_npm and changed to $GITHUB_OUTPUT when it is set. --against compares
// with a local tarball instead of npm's latest (a test of this script).

import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: { against: { type: "string" } } });
const which = positionals[0];
if (!["mcp", "mcp-managed", "sdk"].includes(which)) throw new Error("Usage: node scripts/mcp-release.mjs <mcp|mcp-managed|sdk> [--against <tarball>]");
const pkgDir = join(root, "packages", which);
const release = JSON.parse(readFileSync(join(pkgDir, "release.json"), "utf8"));

const parts = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const tmp = mkdtempSync(join(tmpdir(), "mcp-release-"));

/** The latest published tarball, unpacked: its folder and version; null when the package is not on npm. */
function latest() {
  let tarball = values.against ? resolve(values.against) : null;
  if (!tarball) {
    let version;
    try {
      version = JSON.parse(execSync(`npm view ${release.name} version --json`, { stdio: ["ignore", "pipe", "pipe"] }).toString());
    } catch (e) {
      if (/E404|404 Not Found/.test(String(e.stderr ?? e.message))) return null;
      throw e;
    }
    const packed = JSON.parse(execSync(`npm pack ${release.name}@${version} --json --pack-destination "${tmp}"`, { stdio: ["ignore", "pipe", "pipe"] }).toString());
    tarball = join(tmp, packed[0].filename);
  }
  // Unpacked by its bare name from inside the folder: GNU tar reads "C:" in a Windows path as a remote host.
  if (dirname(tarball) !== tmp) copyFileSync(tarball, join(tmp, basename(tarball)));
  execFileSync("tar", ["-xzf", basename(tarball)], { cwd: tmp });
  const dir = join(tmp, "package");
  return { dir, version: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version };
}

const published = latest();
const version = !published || newer(release.version, published.version) ? release.version : `${parts(published.version).slice(0, 2).join(".")}.${parts(published.version)[2] + 1}`;
execFileSync(process.execPath, [join(pkgDir, "scripts", "package.mjs"), "--version", version], { stdio: "inherit", cwd: root });

const built = join(pkgDir, "npm-package");
/** package.json without the fields a release changes by itself. */
const manifestOf = (dir) => {
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  delete p.version;
  delete p.gitHead;
  return JSON.stringify(p);
};
/**
 * A shipped file as text, its own version set aside: the build writes the version it publishes into cli.js (what
 * the server reports, and --version), so a build that changes nothing else still differs from the published one.
 */
const contentOf = (dir, f, v) => {
  const file = join(dir, f);
  return existsSync(file) ? readFileSync(file, "utf8").replaceAll(JSON.stringify(v), '"<version>"') : null;
};
/** Every file a package folder ships (its package.json `files`) but package.json, as paths with forward slashes. */
const shipped = (dir, sub = "", files = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).files ?? []) =>
  readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((e) => {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) return shipped(dir, rel, files);
    return rel !== "package.json" && files.some((f) => rel === f || rel.startsWith(`${f}/`)) ? [rel] : [];
  });
let changed = [];
if (published) {
  for (const f of [...new Set([...shipped(built), ...shipped(published.dir)])].sort()) {
    const a = contentOf(built, f, version);
    const b = contentOf(published.dir, f, published.version);
    if (a === null || b === null || a !== b) changed.push(f);
  }
  if (manifestOf(built) !== manifestOf(published.dir)) changed.push("package.json");
  if (newer(release.version, published.version)) changed.push(`release.json version ${release.version}`);
}
rmSync(tmp, { recursive: true, force: true });

const summary = !published
  ? `${release.name} is not on npm yet: the first version (${version}) is published by hand, then its trusted publisher is set (docs/PUBLISHING.md).`
  : changed.length
    ? `${release.name}: npm has ${published.version}; ${version} changes ${changed.join(", ")}.`
    : `${release.name}: what would ship is the same as ${published.version} on npm; nothing to publish.`;
process.stdout.write(`${summary}\n`);
if (process.env["GITHUB_OUTPUT"]) {
  appendFileSync(process.env["GITHUB_OUTPUT"], `name=${release.name}\nversion=${version}\non_npm=${!!published}\nchanged=${changed.length > 0}\n`);
}
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summary}\n`);
