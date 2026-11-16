// @pilotfish/mcp-managed — the managed pilotfish MCP for stdio clients (a relay to the hosted /mcp).
export { check, checkKey, DEFAULT_URL, endpointOf, explain, relay } from "./bridge.js";
export type { ManagedOptions } from "./bridge.js";
export { apiBaseOf, CLI_CLIENT_ID, deviceLogin, logout, readSaved, tokenFileOf, TokenSource } from "./auth.js";
export type { LoginOptions, SavedSignIn } from "./auth.js";
