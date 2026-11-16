// @pilotfish/mcp — pilotfish as an open Model Context Protocol server (stdio or Streamable HTTP): the client's own
// model drives the browser; no model calls and no API key here.
export { createMcpServer, Inputs } from "./server.js";
export type { PilotfishMcp, PilotfishMcpOptions } from "./server.js";
export { BrowserSession } from "./session.js";
export type { SessionOptions } from "./session.js";
export { configFromEnv, parseSecrets, parseHosts } from "./config.js";
export type { McpConfig } from "./config.js";
