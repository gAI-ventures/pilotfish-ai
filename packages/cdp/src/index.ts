// @pilotfish/cdp — thin, typed Chrome DevTools Protocol client.
export { Connection, CDPSession, CDPError, SessionClosedError } from "./connection.js";
export type {
  Commands,
  Events,
  CommandName,
  EventName,
  CommandParams,
  CommandResult,
  EventParams,
  SendOptions,
  ConnectionOptions,
} from "./connection.js";
export { PipeTransport, WebSocketTransport } from "./transport.js";
export type { Transport } from "./transport.js";
export type { Protocol } from "devtools-protocol";
