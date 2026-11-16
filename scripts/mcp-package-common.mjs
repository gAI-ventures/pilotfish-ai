// Shared by packages/mcp/scripts/package.mjs and packages/mcp-managed/scripts/package.mjs: the release settings, the
// user-doc checks, and writing a package folder (cli.js, package.json, README.md, LICENSE, server.json). docs/PUBLISHING.md.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** release.json of a package, with --version overriding its version. Throws on a bad version or description. */
export function readRelease(pkgDir) {
  const { values } = parseArgs({ options: { version: { type: "string" } }, strict: false });
  const release = JSON.parse(readFileSync(join(pkgDir, "release.json"), "utf8"));
  const version = typeof values.version === "string" ? values.version : release.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);
  if (release.description.length > 100) throw new Error(`release.json description is ${release.description.length} characters; the MCP Registry takes 100`);
  return { ...release, version };
}

/** The dependency ranges the workspace's packages declare (the first package.json that lists each). */
export function declaredRanges(root) {
  const declared = {};
  for (const name of readdirSync(join(root, "packages"))) {
    const file = join(root, "packages", name, "package.json");
    if (!existsSync(file)) continue;
    for (const [dep, range] of Object.entries(JSON.parse(readFileSync(file, "utf8")).dependencies ?? {})) if (!dep.startsWith("@pilotfish/")) declared[dep] ??= range;
  }
  return declared;
}

/** The rows of a markdown table under a heading: the backticked names in each row's first cell. */
export function namesInTable(markdown, heading, pattern) {
  markdown = lf(markdown);
  const at = markdown.indexOf(`\n## ${heading}\n`);
  if (at < 0) throw new Error(`No "## ${heading}" section`);
  const section = markdown.slice(at + heading.length + 5).split(/\n## /)[0];
  const names = new Set();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    for (const m of line.split("|")[1].matchAll(/`([^`\s]+)/g)) if (pattern.test(m[1])) names.add(m[1]);
  }
  return names;
}

/** The user docs list exactly what the server has: throws with what to add or remove. */
export function checkDocs({ readmePath, heading, documented, actual, what, where }) {
  const missing = [...actual].filter((n) => !documented.has(n)).sort();
  const extra = [...documented].filter((n) => !actual.has(n)).sort();
  if (missing.length || extra.length) {
    throw new Error(
      `${readmePath} "## ${heading}" does not match the ${what} in ${where}.` +
        `${missing.length ? ` Add: ${missing.join(", ")}.` : ""}${extra.length ? ` Remove: ${extra.join(", ")}.` : ""}`,
    );
  }
}

/** Writes the package folder. `files` maps a name in the folder to its contents. */
export function writePackage(out, files) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(out, name), contents);
}

/** Text with LF line ends: a Windows checkout has CRLF, and the package must not depend on where it is built. */
export const lf = (text) => text.replaceAll("\r\n", "\n");
/** A text file of the repository as it ships (LF line ends). */
export const copy = (from) => lf(readFileSync(from, "utf8"));
/** A text file of the repository, read with LF line ends. */
export const readText = (from) => lf(readFileSync(from, "utf8"));
export const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
export { copyFileSync };

/**
 * The public source repository of both packages (docs/PUBLISHING.md, "Public mirror"): their code, issues and releases. The
 * mirror export writes the repository it exports to here.
 */
export const SOURCE_REPO = "https://github.com/gAI-ventures/pilotfish-mcp";

/**
 * package.json fields both packages share. `release.npmDescriptionNote`, when set, is added to the npm description
 * only (a marketplace's ownership token: mcprush reads it from npm's latest version); the MCP Registry's server.json
 * keeps `release.description`, which the registry caps at 100 characters.
 */
export function packageJson(release, { bin, dependencies, directory, homepage, keywords }) {
  return {
    name: release.name,
    version: release.version,
    description: release.npmDescriptionNote ? `${release.description} ${release.npmDescriptionNote}` : release.description,
    license: "MIT",
    type: "module",
    bin,
    files: ["cli.js", "README.md", "LICENSE"],
    engines: { node: ">=22" },
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [z]) => a.localeCompare(z))),
    mcpName: release.mcpName,
    // The public repository, which publishes both packages (npm checks this against the repository a provenance
    // statement names). The homepage is the package's product docs; the source and issues are on GitHub.
    repository: { type: "git", url: `git+${SOURCE_REPO}.git`, directory },
    homepage,
    bugs: { url: `${SOURCE_REPO}/issues` },
    keywords,
    // npm's provenance ("built from this commit"), from this public repository.
    publishConfig: { access: "public", provenance: true },
  };
}

export const SERVER_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/**
 * The links of an MCP Registry entry (server.json, by SERVER_SCHEMA): the website, the package's folder in the public
 * source repository, and the icons the website serves from apps/web/public (a square PNG for clients that take PNG or
 * JPEG only, and the SVG favicon).
 */
export const serverLinks = (subfolder) => ({
  websiteUrl: "https://pilotfish.gai.ventures",
  repository: { url: SOURCE_REPO, source: "github", subfolder },
  icons: [
    { src: "https://pilotfish.gai.ventures/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
    { src: "https://pilotfish.gai.ventures/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ],
});

/** Names that must never ship. The maintainers' repository checks them before every sync, so none are listed here. */
export const PROVIDER_MARKERS = [];
