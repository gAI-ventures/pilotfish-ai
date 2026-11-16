// One request interceptor per CDP session, shared by everything that pauses requests (ad blocking's
// exact tier, the eval and skill-check write guards). Fetch.enable replaces the
// session's patterns and every Fetch.requestPaused listener sees every paused request, so two
// features calling Fetch on their own would answer the same request twice or switch each other off.
//
// Each paused request goes to every handler that asked for its resource type, all at once (side
// effects such as a write log still happen); then the first handler that blocked or stubbed it wins,
// and otherwise the request goes on with every header handlers set.

import type { CDPSession, Protocol } from "@pilotfish/cdp";

export type PausedRequest = Protocol.Fetch.RequestPausedEvent;

/** What a handler decides; nothing (undefined) passes the request on unchanged. */
export type Interception =
  | { action: "continue"; headers?: Record<string, string> }
  | { action: "fail"; reason?: Protocol.Network.ErrorReason }
  | { action: "fulfill"; responseCode: number; responseHeaders?: Protocol.Fetch.HeaderEntry[]; body?: string };

export interface RequestHandler {
  /** Resource types to pause ("Preflight" is not accepted by Chrome's Fetch filter). */
  types: readonly Protocol.Network.ResourceType[];
  onRequest(e: PausedRequest): Interception | void | Promise<Interception | void>;
}

export interface HandlerRegistration {
  /** Resolves once Chrome intercepts this handler's types (a paused new target answers after it resumes). */
  enabled: Promise<void>;
  remove(): void;
}

const interceptors = new WeakMap<CDPSession, RequestInterceptor>();

export class RequestInterceptor {
  private readonly handlers: RequestHandler[] = [];
  private off: (() => void) | null = null;
  private patternsKey = "";
  private current: Promise<void> = Promise.resolve();

  private constructor(private readonly session: CDPSession) {}

  /** The interceptor of a session (created on first use). */
  static for(session: CDPSession): RequestInterceptor {
    let i = interceptors.get(session);
    if (!i) {
      i = new RequestInterceptor(session);
      interceptors.set(session, i);
    }
    return i;
  }

  get size(): number {
    return this.handlers.length;
  }

  add(handler: RequestHandler): HandlerRegistration {
    this.handlers.push(handler);
    this.off ??= this.session.on("Fetch.requestPaused", (e) => void this.paused(e));
    const enabled = this.sync();
    return {
      enabled,
      remove: () => {
        const i = this.handlers.indexOf(handler);
        if (i < 0) return;
        this.handlers.splice(i, 1);
        void this.sync().catch(() => undefined);
      },
    };
  }

  /** Tell Chrome the union of the handlers' types (or stop pausing when none is left). */
  private sync(): Promise<void> {
    const types = [...new Set(this.handlers.flatMap((h) => h.types))].sort();
    const key = types.join(",");
    // Same patterns: the call already sent (perhaps still waiting on a paused target) covers them.
    if (key === this.patternsKey) return this.current;
    this.patternsKey = key;
    if (!types.length) {
      this.off?.();
      this.off = null;
      this.current = this.session.send("Fetch.disable").then(() => undefined, () => undefined);
      return this.current;
    }
    this.current = this.session.send("Fetch.enable", { patterns: types.map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" as const })) }).then(() => undefined);
    return this.current;
  }

  private async paused(e: PausedRequest): Promise<void> {
    const mine = this.handlers.filter((h) => h.types.includes(e.resourceType));
    const decisions = await Promise.all(
      mine.map(async (h) => {
        try {
          return (await h.onRequest(e)) ?? undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const s = this.session;
    try {
      const final = decisions.find((d) => d && d.action !== "continue");
      if (final?.action === "fail") return void (await s.send("Fetch.failRequest", { requestId: e.requestId, errorReason: final.reason ?? "BlockedByClient" }));
      if (final?.action === "fulfill") {
        return void (await s.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: final.responseCode, responseHeaders: final.responseHeaders ?? [], ...(final.body !== undefined ? { body: final.body } : {}) }));
      }
      const set: Record<string, string> = {};
      for (const d of decisions) if (d?.action === "continue" && d.headers) Object.assign(set, d.headers);
      if (!Object.keys(set).length) return void (await s.send("Fetch.continueRequest", { requestId: e.requestId }));
      await s.send("Fetch.continueRequest", { requestId: e.requestId, headers: mergeHeaders(e.request.headers, set) });
    } catch {
      // The request may be gone (frame navigated away, target closed). Never leave one paused.
      await s.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
    }
  }
}

/** The request's headers with `set` replacing same-named ones (names compared case-insensitively). */
export function mergeHeaders(original: Record<string, string>, set: Record<string, string>): Protocol.Fetch.HeaderEntry[] {
  const replaced = new Set(Object.keys(set).map((k) => k.toLowerCase()));
  const out = Object.entries(original)
    .filter(([k]) => !replaced.has(k.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
  for (const [name, value] of Object.entries(set)) out.push({ name, value });
  return out;
}
