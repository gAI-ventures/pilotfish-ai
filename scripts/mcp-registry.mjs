#!/usr/bin/env node
// Lists one public MCP package's latest npm version in the MCP Registry when the registry does not have it yet, for
// .github/workflows/publish.yml (docs/PUBLISHING.md). Run after `mcp-publisher login`, with mcp-publisher on PATH or in
// MCP_PUBLISHER:
//   node scripts/mcp-registry.mjs <mcp|mcp-managed> [--expect <version>]
//
// --expect: the version this run just published; waits (up to 10 minutes) until npm serves it, since the registry
// checks the package on npm and refuses a version npm does not show yet. Without it, the latest on npm is listed
// when missing, so a listing that failed once is made by the next run.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: { expect: { type: "string" } } });
const which = positionals[0];
if (which !== "mcp" && which !== "mcp-managed") throw new Error("Usage: node scripts/mcp-registry.mjs <mcp|mcp-managed> [--expect <version>]");
const pkgDir = join(root, "packages", which);
const release = JSON.parse(readFileSync(join(pkgDir, "release.json"), "utf8"));
const REGISTRY = "https://registry.modelcontextprotocol.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The version npm serves as latest, or null. */
function npmLatest() {
  try {
    return JSON.parse(execSync(`npm view ${release.name} version --json`, { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch {
    return null;
  }
}

let version = npmLatest();
if (values.expect) {
  for (let i = 0; version !== values.expect && i < 40; i++) {
    await sleep(15_000);
    version = npmLatest();
  }
  if (version !== values.expect) throw new Error(`npm still serves ${version} for ${release.name}, not ${values.expect}, after 10 minutes`);
}
if (!version) throw new Error(`${release.name} is not on npm`);

/** Whether the registry lists this server at this version: every page of its search (30 versions a page). */
async function listed(v) {
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${REGISTRY}/v0.1/servers?search=${encodeURIComponent(release.mcpName)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!res.ok) throw new Error(`MCP Registry search answered ${res.status}`);
    const body = await res.json();
    if ((body.servers ?? []).some((s) => s.server?.name === release.mcpName && s.server?.version === v)) return true;
    cursor = body.metadata?.nextCursor ?? "";
    if (!cursor) return false;
  }
  return false;
}

if (await listed(version)) {
  process.stdout.write(`${release.mcpName} ${version} is already in the MCP Registry.\n`);
  process.exit(0);
}
// server.json for exactly that version (the package folder is rebuilt with it).
execFileSync(process.execPath, [join(pkgDir, "scripts", "package.mjs"), "--version", version], { stdio: "inherit", cwd: root });
const publisher = process.env["MCP_PUBLISHER"] || "mcp-publisher";
/**
 * A fresh registry token. The workflow's login comes before the wait for npm and the retries, and the token lives a few
 * minutes: on 11 Nov the publish came 5.5 minutes after it and was refused ("Invalid or expired Registry JWT token").
 * In CI (GitHub's OIDC token at hand) the script logs in again right before it publishes, and again when refused.
 */
const oidc = !!process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
const login = () => {
  if (oidc) execFileSync(publisher, ["login", "github-oidc"], { stdio: "pipe" });
};
login();
let relogged = false;
for (let attempt = 1; ; attempt++) {
  try {
    execFileSync(publisher, ["publish"], { cwd: join(pkgDir, "npm-package"), stdio: "pipe" });
    break;
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    // Listed already (the search missed it): 11 Nov, 0.1.37 was on the search's second page, which was not read then,
    // and the publish was refused as a duplicate. Not a failure.
    if (/duplicate version/i.test(out)) {
      process.stdout.write(`${release.mcpName} ${version} is already in the MCP Registry (its search had not shown it yet).\n`);
      process.exit(0);
    }
    // The registry's token ran out (a wait above outlived it): log in again and publish once more.
    if (oidc && !relogged && /expired|invalid.*token|status 401|unauthori[sz]ed/i.test(out)) {
      relogged = true;
      process.stdout.write("The registry token ran out; logging in again.\n");
      login();
      continue;
    }
    // The registry's own view of npm can lag behind npm's: wait and try again (with a fresh token).
    if (attempt < 6 && /not found|take a moment/i.test(out)) {
      process.stdout.write(`The registry does not see ${release.name}@${version} on npm yet; retrying in 30 s.\n`);
      await sleep(30_000);
      login();
      continue;
    }
    throw new Error(`mcp-publisher publish failed: ${out}`);
  }
}
process.stdout.write(`Listed ${release.mcpName} ${version} in the MCP Registry.\n`);
