// The version this server reports to MCP clients (initialize) and prints for --version. The npm package's build
// (scripts/package.mjs) replaces __PILOTFISH_MCP_VERSION__ with the version it publishes; a build from this
// repository has no such value and reports 0.0.0-dev.

declare const __PILOTFISH_MCP_VERSION__: string | undefined;

export const VERSION: string = typeof __PILOTFISH_MCP_VERSION__ === "string" ? __PILOTFISH_MCP_VERSION__ : "0.0.0-dev";
