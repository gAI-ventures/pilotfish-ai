#!/usr/bin/env node
// Builds the public npm package of the open local MCP, @gaiventures/pilotfish-mcp, in packages/mcp/npm-package/:
//   cli.js        the CLI with the workspace packages (@pilotfish/*) bundled in, minified; third-party packages stay
//                 dependencies, at the ranges the workspace declares
//   package.json  name, version and MCP Registry name from release.json
//   README.md     README.npm.md (the user docs)
//   LICENSE       MIT
//   server.json   the MCP Registry entry (not part of the tarball)
//
// Run after `npm run build` at the repository root:  node packages/mcp/scripts/package.mjs [--version 0.1.1]
// scripts/mcp-release.mjs runs it on every push that can change the package (docs/PUBLISHING.md).
//
// The build fails unless:
// - no hosted module is reached at all: nothing under packages/*/src/hosted/ (the hosted service's browser build and
//   settings, proxy routing, CAPTCHA handling, profiles, model providers), which the core never imports (the hosted server plugs it in
//   through hooks at startup), whatever bundle.json says;
// - every module of another workspace package that reaches the bundle is classified in bundle.json: under ships (may
//   be public) or stubbed (a safety net, empty today: a core module replaced by a stub with the same export names whose
//   functions refuse);
// - nothing of a hosted or stubbed module ships: none of its code, none of its text literals, no provider name;
// - no model SDK ships (the agent's SDK imports resolve to a client that refuses to be built);
// - README.npm.md lists exactly the tools the server registers, and every setting it reads.

import { createRequire, builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDER_MARKERS, SERVER_LINKS, SERVER_SCHEMA, checkDocs, copy, declaredRanges, json, namesInTable, packageJson, readRelease, readText, writePackage } from "../../../scripts/mcp-package-common.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(pkgDir, "../..");
const packagesDir = join(root, "packages");
const out = join(pkgDir, "npm-package");
const esbuild = createRequire(join(root, "package.json"))("esbuild");

const release = readRelease(pkgDir);
const manifest = JSON.parse(readFileSync(join(pkgDir, "bundle.json"), "utf8"));
const entry = join(pkgDir, "dist", "cli.js");
if (!existsSync(entry)) throw new Error(`${entry} is missing: run npm run build at the repository root first.`);

// bundle.json names source files; the bundler reads their build output.
const toDist = (src) => src.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
const toSrc = (dist) => dist.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
const STUBBED = Object.fromEntries(Object.entries(manifest.stubbed).map(([src, spec]) => [toDist(src), spec]));
const SHIPS = new Set(manifest.ships);
/** A path relative to packages/, with forward slashes; null outside it. */
const relOf = (abs) => (abs.startsWith(packagesDir) ? abs.slice(packagesDir.length + 1).replaceAll("\\", "/") : null);
/** Hosted-only code: a workspace package's hosted/ folder (packages/<name>/src/hosted/, built to dist/hosted/). */
const isHosted = (rel) => /^[^/]+\/dist\/hosted\//.test(rel ?? "");
/** Every hosted module the bundler resolved, with the module that imported it. */
const hostedReached = [];

const MODEL_SDKS = new Set(["@anthropic-ai/sdk", "openai"]);
const NO_MODEL = `// The open MCP makes no model calls: the MCP client's own model drives the browser. Nothing builds a model client.
const refuse = () => { throw new Error("pilotfish's open MCP makes no model calls: the MCP client's own model drives the browser"); };
export class BadRequestError extends Error {}
export default class NoModelClient { constructor() { refuse(); } }
NoModelClient.BadRequestError = BadRequestError;
`;

/** The stubs' own text (their export names), which the leak check does not count. */
const stubs = [];
/** A stub with the real module's export names: functions and classes refuse, values are empty. */
async function stubFor(abs, spec) {
  const real = await import(pathToFileURL(abs).href);
  const q = JSON.stringify;
  const lines = ['const refuse = (name) => { throw new Error(name + " is not part of the open pilotfish MCP (the hosted service only)"); };'];
  for (const [name, v] of Object.entries(real)) {
    if (spec.keep?.includes(name)) lines.push(`export { ${name} } from ${q(`real:${abs}`)};`);
    else if (spec.values?.[name]) lines.push(`export const ${name} = ${spec.values[name]};`);
    else if (typeof v === "function")
      lines.push(/^class[\s{]/.test(Function.prototype.toString.call(v)) ? `export class ${name} { constructor() { refuse(${q(name)}); } }` : `export function ${name}() { return refuse(${q(name)}); }`);
    else if (v instanceof Set) lines.push(`export const ${name} = new Set();`);
    else if (v instanceof Map) lines.push(`export const ${name} = new Map();`);
    else if (Array.isArray(v)) lines.push(`export const ${name} = [];`);
    else if (v instanceof RegExp) lines.push(`export const ${name} = /(?!)/;`);
    else if (typeof v === "string") lines.push(`export const ${name} = "";`);
    else if (typeof v === "number") lines.push(`export const ${name} = 0;`);
    else if (typeof v === "boolean") lines.push(`export const ${name} = false;`);
    else if (v && typeof v === "object") lines.push(`export const ${name} = {};`);
    else lines.push(`export const ${name} = undefined;`);
  }
  const stub = lines.join("\n");
  stubs.push(stub);
  return stub;
}

const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
const isBare = (p) => /^[^./]/.test(p) && !/^[A-Za-z]:[\\/]/.test(p);

const result = await esbuild.build({
  entryPoints: [entry],
  outfile: join(out, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  metafile: true,
  // Metafile paths relative to the repository root, wherever this runs from.
  absWorkingDir: root,
  // No comments, short local names; function and class names kept for error messages and stack traces.
  minify: true,
  keepNames: true,
  // The version the server reports to clients and prints for --version (src/version.ts).
  define: { __PILOTFISH_MCP_VERSION__: JSON.stringify(release.version) },
  legalComments: "none",
  logLevel: "warning",
  plugins: [
    {
      name: "open-mcp",
      setup(b) {
        b.onResolve({ filter: /.*/ }, async (args) => {
          if (args.kind === "entry-point" || args.pluginData?.resolving) return undefined;
          // An export a stub keeps from the real module.
          if (args.path.startsWith("real:")) return { path: args.path.slice(5), sideEffects: false };
          if (MODEL_SDKS.has(packageOf(args.path))) return { path: args.path, namespace: "no-model" };
          if (isBare(args.path) && !args.path.startsWith("@pilotfish/")) return { path: args.path, external: true };
          const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { resolving: true } });
          if (r.errors.length) return { errors: r.errors };
          const rel = relOf(r.path);
          // Resolved, even if nothing of it would be kept: the core must not import hosted code at all.
          if (isHosted(rel)) hostedReached.push({ rel, from: relOf(args.importer) });
          if (rel && STUBBED[rel]) return { path: r.path, namespace: "hosted-only", sideEffects: false };
          // Workspace modules are free of side effects: one nothing uses is left out.
          return { path: r.path, sideEffects: !rel };
        });
        b.onLoad({ filter: /.*/, namespace: "no-model" }, () => ({ contents: NO_MODEL, loader: "js" }));
        b.onLoad({ filter: /.*/, namespace: "hosted-only" }, async (args) => ({ contents: await stubFor(args.path, STUBBED[relOf(args.path)]), loader: "js", resolveDir: dirname(args.path) }));
      },
    },
  ],
});
if (hostedReached.length) {
  throw new Error(
    `Hosted-only code reached the open MCP's bundle: ${hostedReached.map(({ rel, from }) => `${toSrc(rel)}${from ? ` (imported by ${toSrc(from)})` : ""}`).join(", ")}. ` +
      `The core never imports packages/*/src/hosted/: plug hosted code in through a hook (setLaunchExtension, registerModelProvider; docs/PUBLISHING.md).`,
  );
}
const output = Object.values(result.metafile.outputs)[0];
const bundleText = result.outputFiles[0].text;
const shipped = Object.entries(output.inputs).filter(([file, info]) => info.bytesInOutput && !/^[a-z-]+:/.test(file));

// 1. Every workspace module in the bundle is classified; a stubbed one ships only the exports it keeps.
const unclassified = [];
for (const [file, info] of shipped) {
  const rel = relOf(resolve(root, file));
  if (!rel || rel.startsWith("mcp/")) continue;
  const spec = STUBBED[rel];
  if (spec && !spec.keep) throw new Error(`Hosted-only code reached the bundle: ${toSrc(rel)}`);
  if (spec?.keep && info.bytesInOutput > 4_000) throw new Error(`More of ${toSrc(rel)} than ${spec.keep.join(", ")} reached the bundle (${info.bytesInOutput} bytes)`);
  if (!spec && !SHIPS.has(toSrc(rel))) unclassified.push(toSrc(rel));
}
if (unclassified.length) {
  throw new Error(
    `New code reaches the open MCP's package: ${unclassified.join(", ")}. Classify it in packages/mcp/bundle.json: under ` +
      `"ships" if it may be public, or under "stubbed" if it is hosted-only (proxy, CAPTCHA, profiles...). ` +
      `The app is not affected; only this package waits for it (docs/PUBLISHING.md).`,
  );
}

// 2. No text of a hosted or stubbed module, unless the bundled modules' own sources carry the same text; no provider name.
const around = (at) => `…${bundleText.slice(Math.max(0, at - 200), at + 120)}…`;
for (const m of PROVIDER_MARKERS) {
  const at = bundleText.search(m);
  if (at >= 0) throw new Error(`The bundle names a hosted-only provider ${m}: ${around(at)}`);
}
const literalsOf = (src) => new Set([...src.matchAll(/(["'`])([A-Za-z0-9 _.,:;/()=+-]{12,})\1/g)].map((m) => m[2]));
const ownText = shipped.map(([file]) => readFileSync(resolve(root, file), "utf8")).join("\n");
/** Every built hosted module (packages/<name>/dist/hosted/**.js), relative to packages/. */
const hostedBuilt = (dir = packagesDir, rel = "") =>
  readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) return name === "node_modules" || name === "npm-package" ? [] : hostedBuilt(abs, r);
    return isHosted(r) && r.endsWith(".js") ? [r] : [];
  });
const textChecked = { ...Object.fromEntries(hostedBuilt().map((rel) => [rel, {}])), ...STUBBED };
for (const [rel, spec] of Object.entries(textChecked)) {
  const file = join(packagesDir, rel);
  if (spec.keep || !existsSync(file)) continue;
  for (const l of literalsOf(readFileSync(file, "utf8"))) {
    if (ownText.includes(l) || stubs.some((s) => s.includes(l))) continue;
    // As a literal of its own (the bundler prints strings in double quotes, templates in backticks).
    const at = Math.max(bundleText.indexOf(`"${l}"`), bundleText.indexOf(`\`${l}\``));
    if (at >= 0) throw new Error(`Text of ${toSrc(rel)} reached the bundle ("${l}"): ${around(at)}`);
  }
}

// 3. Third-party packages the bundle imports become dependencies; never a model SDK.
const declared = declaredRanges(root);
const builtins = new Set(builtinModules);
const dependencies = {};
for (const imp of output.imports) {
  if (!imp.external || imp.path.startsWith("node:") || builtins.has(imp.path)) continue;
  const name = packageOf(imp.path);
  if (MODEL_SDKS.has(name)) throw new Error(`The bundle still imports ${name}`);
  if (!declared[name]) throw new Error(`No workspace package declares ${name}, which the bundle imports`);
  dependencies[name] = declared[name];
}

// 4. The user docs match the server: every tool it registers, every setting it reads.
const readmePath = join(pkgDir, "README.npm.md");
const readme = readText(readmePath);
const { Inputs } = await import(pathToFileURL(join(pkgDir, "dist", "server.js")).href);
checkDocs({ readmePath: "packages/mcp/README.npm.md", heading: "Tools", documented: namesInTable(readme, "Tools", /^browser_/), actual: new Set(Object.keys(Inputs)), what: "tools", where: "packages/mcp/src/server.ts" });
const settingsRead = new Set();
for (const f of readdirSync(join(pkgDir, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  for (const m of readFileSync(join(pkgDir, "src", f), "utf8").matchAll(/env\[\s*"(PILOTFISH_[A-Z_]+)"\s*\]/g)) settingsRead.add(m[1]);
}
const settingsDocumented = namesInTable(readme, "Settings", /^PILOTFISH_/);
const undocumented = [...settingsRead].filter((s) => !settingsDocumented.has(s));
if (undocumented.length) throw new Error(`packages/mcp/README.npm.md "## Settings" does not list ${undocumented.join(", ")}, which packages/mcp/src reads`);

const pkg = packageJson(release, {
  bin: { "pilotfish-mcp": "cli.js" },
  dependencies,
  directory: "packages/mcp",
  keywords: ["mcp", "mcp-server", "model-context-protocol", "pilotfish", "browser", "browser-automation", "browser-agent", "ai-agent", "chromium", "chrome-devtools-protocol", "claude-code", "codex", "cursor"],
});
const optional = (name, description, isSecret = false) => ({ name, description, isRequired: false, format: "string", isSecret });
const server = {
  $schema: SERVER_SCHEMA,
  name: release.mcpName,
  title: release.title,
  description: release.description,
  version: release.version,
  ...SERVER_LINKS,
  packages: [
    {
      registryType: "npm",
      identifier: release.name,
      version: release.version,
      transport: { type: "stdio" },
      environmentVariables: [
        optional("PILOTFISH_HEADLESS", "1 hides the browser window (sign-ins and CAPTCHAs then cannot be done by hand)"),
        optional("PILOTFISH_ALLOWED_HOSTS", "Comma-separated hostname globs the browser may visit (default: any public host)"),
        optional("PILOTFISH_SECRETS", 'JSON of values typed as {{name}} placeholders, never shown to the model, e.g. {"pw": "..."}', true),
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

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const bySize = {};
for (const [file, info] of shipped) {
  const m = /packages[\\/]([^\\/]+)[\\/]/.exec(file);
  const key = m ? `@pilotfish/${m[1]}` : file;
  bySize[key] = (bySize[key] ?? 0) + info.bytesInOutput;
}
const unused = manifest.ships.filter((s) => !shipped.some(([file]) => relOf(resolve(root, file)) === toDist(s)));
process.stdout.write(
  `${pkg.name}@${release.version} in ${out}\n  cli.js ${kb(output.bytes)}: ${Object.entries(bySize).map(([k, v]) => `${k} ${kb(v)}`).join(", ")}\n  dependencies: ${Object.keys(pkg.dependencies).join(", ")}\n` +
    (unused.length ? `  in bundle.json "ships" but no longer in the bundle (may be removed): ${unused.join(", ")}\n` : ""),
);
