#!/usr/bin/env node
// Builds the public npm package of the SDK, @gaiventures/pilotfish, in packages/sdk/npm-package/:
//   dist/         the compiled modules and their type declarations (no tests, no source maps)
//   package.json  name and version from release.json
//   README.md     README.npm.md (the user docs)
//   LICENSE       MIT
//
// Run after `npm run build` at the repository root:  node packages/sdk/scripts/package.mjs [--version 0.1.0]
// scripts/mcp-release.mjs runs it on every push that can change the package (docs/PUBLISHING.md).
//
// The SDK is an HTTP client of the public REST API plus a stdio client of the open MCP: the build fails unless it
// imports nothing but Node's own modules and its own files, names no proxy or CAPTCHA provider, and drives every
// browser tool the open MCP's README lists.

import { builtinModules } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copy, json, namesInTable, PROVIDER_MARKERS, readRelease, readText, SOURCE_REPO, writePackage } from "../../../scripts/mcp-package-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const root = resolve(pkgDir, "../..");
const dist = join(pkgDir, "dist");
const out = join(pkgDir, "npm-package");
const release = readRelease(pkgDir);

if (!existsSync(join(dist, "index.js"))) throw new Error("packages/sdk/dist is missing: run `npm run build` at the repository root first");

// The compiled modules, tests and maps left out.
const files = {};
const builtins = new Set(builtinModules);
for (const f of readdirSync(dist)) {
  if (!/\.(js|d\.ts)$/.test(f) || /\.test\.|\.e2e\./.test(f)) continue;
  let text = readText(join(dist, f)).replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  if (f === "version.js") text = text.replace(/"0\.0\.0-dev"/, JSON.stringify(release.version));
  // Only Node's own modules and the SDK's own files.
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("./") || builtins.has(spec) || builtins.has(spec.replace(/^node:/, ""))) continue;
    throw new Error(`dist/${f} imports ${spec}: the SDK may import only Node's own modules and its own files`);
  }
  for (const marker of PROVIDER_MARKERS) if (marker.test(text)) throw new Error(`dist/${f} names a provider (${marker})`);
  files[`dist/${f}`] = text;
}
if (!files["dist/version.js"]?.includes(JSON.stringify(release.version))) throw new Error("dist/version.js: the version was not written");

// Every browser tool of the open MCP has its LocalBrowser method (browser_close is close()).
const tools = namesInTable(readText(join(root, "packages/mcp/README.npm.md")), "Tools", /^browser_/);
const local = readText(join(pkgDir, "src/local.ts"));
const driven = new Set([...local.matchAll(/this\.call\("(browser_[a-z_]+)"/g)].map((m) => m[1]));
const missing = [...tools].filter((t) => !driven.has(t));
if (missing.length) throw new Error(`packages/sdk/src/local.ts has no method for ${missing.join(", ")} (packages/mcp/README.npm.md lists them)`);

const readme = copy(join(pkgDir, "README.npm.md"));
for (const marker of PROVIDER_MARKERS) if (marker.test(readme)) throw new Error(`README.npm.md names a provider (${marker})`);

const manifest = {
  name: release.name,
  version: release.version,
  description: release.description,
  license: "MIT",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md", "LICENSE"],
  engines: { node: ">=20.3" },
  // The local client starts the open MCP: the installed one when there is one, else through npx.
  peerDependencies: { "@gaiventures/pilotfish-mcp": "*" },
  peerDependenciesMeta: { "@gaiventures/pilotfish-mcp": { optional: true } },
  repository: { type: "git", url: `git+${SOURCE_REPO}.git`, directory: "packages/sdk" },
  homepage: "https://pilotfish.gai.ventures/docs/sdk",
  bugs: { url: `${SOURCE_REPO}/issues` },
  keywords: ["pilotfish", "browser-automation", "browser-agent", "web-agent", "web-automation", "web-scraping", "ai-agent", "ai-browser", "cloud-browser", "mcp", "playwright", "puppeteer", "chrome", "cdp", "llm", "sdk", "typescript"],
  publishConfig: { access: "public" },
};

writePackage(out, { "package.json": json(manifest), "README.md": readme, LICENSE: copy(join(pkgDir, "LICENSE")) });
mkdirSync(join(out, "dist"), { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
process.stdout.write(`${release.name}@${release.version}: ${Object.keys(files).length} files in ${out}\n`);
