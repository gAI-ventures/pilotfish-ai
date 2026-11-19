// The API's errors as typed exceptions. Every error response is `{error, code, hint?, docs?, fields?, retryAfterS?}`
// (https://pilotfish.gai.ventures/docs/api#errors): the class says what kind it is, `code` exactly which.

/** One invalid field of a request (400 `invalid_request`, `invalid_schema`). */
export interface FieldError {
  path: string;
  message: string;
}

/** Any error the API answered with, or a request that never got an answer (`status` 0). */
export class PilotfishError extends Error {
  /** HTTP status (0 when the request never got an answer). */
  readonly status: number;
  /** The error's code, e.g. `no_credits`, `one_session`, `not_found` (the HTTP status as text when the body had none). */
  readonly code: string;
  /** What to do about it, when the API says. */
  readonly hint: string | undefined;
  /** The documentation page for this error. */
  readonly docs: string | undefined;
  /** The invalid fields of a 400. */
  readonly fields: FieldError[] | undefined;
  /** Seconds to wait before trying again (429). */
  readonly retryAfterS: number | undefined;
  /** The whole response body (other figures some errors carry: `balanceUsd`, `limitUsd`, `threadId`…). */
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>, message?: string) {
    const text = message ?? (typeof body["error"] === "string" ? body["error"] : `HTTP ${status}`);
    super(text);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
    this.code = typeof body["code"] === "string" && body["code"] ? body["code"] : String(status);
    this.hint = typeof body["hint"] === "string" ? body["hint"] : undefined;
    this.docs = typeof body["docs"] === "string" ? body["docs"] : undefined;
    this.fields = Array.isArray(body["fields"]) ? (body["fields"] as FieldError[]) : undefined;
    this.retryAfterS = typeof body["retryAfterS"] === "number" ? body["retryAfterS"] : undefined;
  }
}

/** 400: the request is not valid (`fields` says which parts). */
export class BadRequestError extends PilotfishError {}
/** 401: no API key, or one that is wrong or revoked. */
export class AuthenticationError extends PilotfishError {}
/** 402: out of credits (`no_credits`), an allowance used (`allocation_used`), or the org's monthly limit (`org_limit`). */
export class PaymentRequiredError extends PilotfishError {}
/** 403: not allowed for this key or person (`admins_only`, `shared_project`…). */
export class PermissionDeniedError extends PilotfishError {}
/** 404: no such task, batch or identity, or not one this key may see. */
export class NotFoundError extends PilotfishError {}
/** 409: a task is already running (`one_session`, `identity_busy`), or the thing is not in a state for that. */
export class ConflictError extends PilotfishError {}
/** 429: too many requests or tasks waiting (`rate_limited`, `queue_full`, `start_rate`); `retryAfterS` says when to try again. */
export class RateLimitError extends PilotfishError {}
/** 5xx: the server failed. Safe to retry a read. */
export class ServerError extends PilotfishError {}
/** The request never got an answer: the network, or the client's own timeout. */
export class ConnectionError extends PilotfishError {
  constructor(message: string, readonly cause?: unknown) {
    super(0, { error: message, code: "connection_error" });
  }
}
/** `wait()` gave up before the task or batch ended (the task carries on). */
export class WaitTimeoutError extends PilotfishError {
  constructor(message: string) {
    super(0, { error: message, code: "wait_timeout" });
  }
}

/** The error class for a status. */
export function errorFor(status: number, body: Record<string, unknown>): PilotfishError {
  if (status === 400 || status === 422) return new BadRequestError(status, body);
  if (status === 401) return new AuthenticationError(status, body);
  if (status === 402) return new PaymentRequiredError(status, body);
  if (status === 403) return new PermissionDeniedError(status, body);
  if (status === 404 || status === 410) return new NotFoundError(status, body);
  if (status === 409) return new ConflictError(status, body);
  if (status === 429) return new RateLimitError(status, body);
  if (status >= 500) return new ServerError(status, body);
  return new PilotfishError(status, body);
}
