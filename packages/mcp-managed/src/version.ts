// The relay's own version, printed for --version and sent as its client version by --check. The npm package's build
// (scripts/package.mjs) replaces __PILOTFISH_MCP_MANAGED_VERSION__ with the version it publishes; a build from this
// repository reports 0.0.0-dev. (Over stdio, clients see the hosted server's own name and version.)

declare const __PILOTFISH_MCP_MANAGED_VERSION__: string | undefined;

export const VERSION: string = typeof __PILOTFISH_MCP_MANAGED_VERSION__ === "string" ? __PILOTFISH_MCP_MANAGED_VERSION__ : "0.0.0-dev";
