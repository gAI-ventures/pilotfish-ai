#!/usr/bin/env node
// Builds the public npm package of the managed MCP's stdio relay, @gaiventures/pilotfish-mcp-managed, in
// packages/mcp-managed/npm-package/:
//   cli.js        the relay, bundled; @modelcontextprotocol/sdk stays a dependency
//   package.json  name, version and MCP Registry name from release.json
//   README.md     README.npm.md (the user docs)
//   LICENSE       MIT
//   server.json   the MCP Registry entry: the hosted endpoint, and this package for stdio-only clients
//
// Run after `npm run build` at the repository root:  node packages/mcp-managed/scripts/package.mjs [--version 0.1.1]
// scripts/mcp-release.mjs runs it on every push that can change the package (docs/PUBLISHING.md).
//
// The relay only carries MCP messages between a stdio client and pilotfish's hosted endpoint: the tools, the browser,
// its routing and CAPTCHA handling all run in pilotfish's cloud (packages/server/src/mcp-hosted.ts,
// deployed with the app). The build fails unless only the relay's own modules and the MCP SDK ship, and unless
// README.npm.md lists exactly the tools the hosted endpoint registers and the settings the relay reads.

import { createRequire, builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_MARKERS, SERVER_SCHEMA, checkDocs, copy, json, namesInTable, packageJson, readRelease, readText, serverLinks, writePackage } from "../../../scripts/mcp-package-common.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(pkgDir, "../..");
const out = join(pkgDir, "npm-package");
const esbuild = createRequire(join(root, "package.json"))("esbuild");

const release = readRelease(pkgDir);
const entry = join(pkgDir, "dist", "cli.js");
if (!existsSync(entry)) throw new Error(`${entry} is missing: run npm run build at the repository root first.`);
const own = join(pkgDir, "dist");
const builtins = new Set(builtinModules);
const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
/** The only third-party package the relay may use. */
const ALLOWED = { "@modelcontextprotocol/sdk": JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).dependencies["@modelcontextprotocol/sdk"] };

const result = await esbuild.build({
  entryPoints: [entry],
  outfile: join(out, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  metafile: true,
  absWorkingDir: root,
  // The version --version prints and --check sends (src/version.ts).
  define: { __PILOTFISH_MCP_MANAGED_VERSION__: JSON.stringify(release.version) },
  legalComments: "none",
  logLevel: "warning",
  packages: "external",
});

const output = Object.values(result.metafile.outputs)[0];
for (const [file, info] of Object.entries(output.inputs)) {
  if (info.bytesInOutput && !resolve(root, file).startsWith(own)) throw new Error(`Only the relay's own modules may ship, not ${file}`);
}
const dependencies = {};
for (const imp of output.imports) {
  if (!imp.external || imp.path.startsWith("node:") || builtins.has(imp.path)) continue;
  const name = packageOf(imp.path);
  if (!ALLOWED[name]) throw new Error(`The relay imports ${name}; only ${Object.keys(ALLOWED).join(", ")} may ship`);
  dependencies[name] = ALLOWED[name];
}
for (const m of PROVIDER_MARKERS) if (m.test(result.outputFiles[0].text)) throw new Error(`The relay names a hosted-only provider: ${m}`);

// The user docs match the hosted endpoint's tools and the relay's settings.
const readme = readText(join(pkgDir, "README.npm.md"));
// The public mirror has no packages/server: there the maintainers' repository has checked the tools before the sync.
if (existsSync(join(root, "packages", "server"))) {
  const hosted = readFileSync(join(root, "packages", "server", "src", "mcp-hosted.ts"), "utf8");
  const hostedTools = new Set([...hosted.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  if (hostedTools.size < 5) throw new Error(`Found only ${hostedTools.size} tools in packages/server/src/mcp-hosted.ts: has the way it registers them changed?`);
  checkDocs({ readmePath: "packages/mcp-managed/README.npm.md", heading: "Tools", documented: namesInTable(readme, "Tools", /^[a-z_]+$/), actual: hostedTools, what: "tools", where: "packages/server/src/mcp-hosted.ts" });
}
const settingsRead = new Set([...readFileSync(join(pkgDir, "src", "cli.ts"), "utf8").matchAll(/env\[\s*"(PILOTFISH_[A-Z_]+)"\s*\]/g)].map((m) => m[1]));
checkDocs({ readmePath: "packages/mcp-managed/README.npm.md", heading: "Settings", documented: namesInTable(readme, "Settings", /^PILOTFISH_/), actual: settingsRead, what: "settings", where: "packages/mcp-managed/src/cli.ts" });

const pkg = packageJson(release, {
  bin: { "pilotfish-mcp-managed": "cli.js" },
  dependencies,
  directory: "packages/mcp-managed",
  homepage: "https://pilotfish.gai.ventures/docs/managed",
  keywords: ["mcp", "mcp-server", "model-context-protocol", "pilotfish", "browser-automation", "browser-agent", "ai-agent", "cloud-browser", "web-automation", "claude-code", "codex", "cursor"],
});
const server = {
  $schema: SERVER_SCHEMA,
  name: release.mcpName,
  title: release.title,
  description: release.description,
  version: release.version,
  ...serverLinks("packages/mcp-managed"),
  remotes: [
    {
      type: "streamable-http",
      url: "https://pilotfish-be.gai.ventures/mcp",
      headers: [{ name: "Authorization", description: "Bearer pf_... (an API key from the app's Org settings → API keys). Leave out to sign in with OAuth.", isRequired: false, isSecret: true }],
    },
  ],
  packages: [
    {
      registryType: "npm",
      identifier: release.name,
      version: release.version,
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "PILOTFISH_KEY", description: "An API key (pf_...) from the pilotfish app's Org settings → API keys. Leave it out after running `npx @gaiventures/pilotfish-mcp-managed login` once, to use your own sign-in.", isRequired: false, format: "string", isSecret: true },
        { name: "PILOTFISH_URL", description: "The pilotfish API (default https://pilotfish-be.gai.ventures)", isRequired: false, format: "string", isSecret: false },
      ],
    },
  ],
};
writePackage(out, {
  "cli.js": result.outputFiles[0].contents,
  "package.json": json(pkg),
  "README.md": readme,
  LICENSE: copy(join(pkgDir, "LICENSE")),
  "server.json": json(server),
});
process.stdout.write(`${pkg.name}@${release.version} in ${out}\n  cli.js ${(output.bytes / 1024).toFixed(0)} KB; dependencies: ${Object.keys(dependencies).join(", ")}\n`);
