// pilotfish SDK for TypeScript and JavaScript (https://pilotfish.gai.ventures/docs/sdk).
//   Pilotfish     the hosted client: tasks in pilotfish's cloud browser over the REST API, with an API key.
//   LocalBrowser  Chrome on your own machine, driven through the open MCP's browser tools: no key, no model calls.
export { Pilotfish, Tasks, Batches, Identities, SavedTasks, Schedules, UsageApi, DEFAULT_BASE_URL, CONTINUE_TEXT, type ClientOptions, type WaitOptions } from "./client.js";
export { LocalBrowser, LocalToolError, type LocalOptions, type LocalQuestion, type Step, type ToolResult } from "./local.js";
export { verifyWebhook, parseWebhook, signWebhook, type WebhookEvent } from "./webhooks.js";
export {
  PilotfishError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  ConnectionError,
  WaitTimeoutError,
  type FieldError,
} from "./errors.js";
export type * from "./types.js";
export { VERSION } from "./version.js";
