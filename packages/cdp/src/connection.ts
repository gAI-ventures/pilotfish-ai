// CDP connection: one multiplexed transport, many flat sessions.
//
// Design rules (owning the protocol is the point: no automation library sits between the agent and Chrome):
//   * Every command is typed against devtools-protocol's ProtocolMapping, so
//     regenerating bindings per Chrome release is `npm update devtools-protocol`.
//   * Sessions are "flat" (Target.setAutoAttach({flatten: true})): each message
//     carries a sessionId, and a child target (OOPIF, worker, popup) is just
//     another CDPSession on the same socket. No nested Target.sendMessageToTarget.
//   * The client never sends Runtime.enable or Console.enable on its own. Those
//     two domains are the decisive automation tell in 2026 anti-bot stacks, and
//     everything we need (evaluate, callFunctionOn, addBinding) works without them.
//     A guard below throws if a caller tries.

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import type { Protocol } from "devtools-protocol";
import type { Transport } from "./transport.js";
import { EventEmitter } from "node:events";

export type Commands = ProtocolMapping.Commands;
export type Events = ProtocolMapping.Events;
export type CommandName = keyof Commands;
export type EventName = keyof Events;
export type CommandParams<C extends CommandName> = Commands[C]["paramsType"][0];
export type CommandResult<C extends CommandName> = Commands[C]["returnType"];
export type EventParams<E extends EventName> = Events[E][0];

export class CDPError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
    public readonly data?: string,
    public readonly sessionId?: string,
  ) {
    super(`${method}: ${message}${data ? ` (${data})` : ""}`);
    this.name = "CDPError";
  }
}

export class SessionClosedError extends Error {
  constructor(public readonly method: string, public readonly reason: string) {
    super(`${method}: session closed (${reason})`);
    this.name = "SessionClosedError";
  }
}

const FORBIDDEN_METHODS = new Set<string>(["Runtime.enable", "Console.enable"]);

interface Pending {
  method: string;
  sessionId?: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface SendOptions {
  /** Per-command timeout in ms. Default 30s. 0 disables. */
  timeoutMs?: number;
  /**
   * Permit Runtime.enable / Console.enable for this one command. Used by the
   * CDP proxy for sessions created with allowRuntimeEnable (Playwright and
   * Puppeteer cannot work without it).
   */
  allowForbiddenMethods?: boolean;
}

export interface ConnectionOptions {
  defaultTimeoutMs?: number;
  /** Debug hook; receives raw wire messages. */
  onWire?: (direction: "send" | "recv", message: string) => void;
  /**
   * Escape hatch for tooling that must enable Runtime (e.g. a DevTools frontend
   * attached for debugging). Off by default: pages can detect it, and protocol hygiene.
   */
  allowRuntimeEnable?: boolean;
}

/**
 * A single CDP session (browser-level or target-level). Typed `send` and
 * typed `on`/`once`/`waitFor` over the devtools-protocol event map.
 */
export class CDPSession {
  private readonly emitter = new EventEmitter({ captureRejections: false });
  private closedReason: string | null = null;

  constructor(
    public readonly connection: Connection,
    /** undefined for the root browser session */
    public readonly sessionId: string | undefined,
    public readonly targetInfo: Protocol.Target.TargetInfo | null,
    /** Session that received the attachedToTarget event (undefined = browser root). */
    public readonly parentSessionId?: string,
  ) {
    this.emitter.setMaxListeners(200);
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send<C extends CommandName>(
    method: C,
    params?: Commands[C]["paramsType"][0],
    options?: SendOptions,
  ): Promise<CommandResult<C>> {
    if (this.closedReason) {
      return Promise.reject(new SessionClosedError(method, this.closedReason));
    }
    return this.connection.rawSend(method, params, this.sessionId, options) as Promise<CommandResult<C>>;
  }

  on<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  once<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): () => void {
    this.emitter.once(event, listener);
    return () => this.emitter.off(event, listener);
  }

  off<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): void {
    this.emitter.off(event, listener);
  }

  /** Resolve on the first event satisfying `predicate` (or any, if omitted). */
  waitFor<E extends EventName>(
    event: E,
    predicate?: (params: EventParams<E>) => boolean,
    timeoutMs = 30_000,
  ): Promise<EventParams<E>> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          off();
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${event}`));
        }, timeoutMs)
        : undefined;
      const onClose = () => {
        if (timer) clearTimeout(timer);
        off();
        reject(new SessionClosedError(event, this.closedReason ?? "closed"));
      };
      const listener = (params: EventParams<E>) => {
        if (predicate && !predicate(params)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(params);
      };
      const off = () => {
        this.emitter.off(event, listener);
        this.emitter.off("__closed", onClose);
      };
      this.emitter.on(event, listener);
      this.emitter.once("__closed", onClose);
    });
  }

  /** Called by Connection. */
  _dispatchEvent(method: string, params: unknown): void {
    this.emitter.emit(method, params);
  }

  /** Called by Connection when the target detaches or the socket dies. */
  _close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.emitter.emit("__closed", reason);
    this.emitter.removeAllListeners();
  }
}

/**
 * Owns the transport, message ids, pending-command map and the session table.
 */
export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, CDPSession>();
  readonly rootSession: CDPSession;
  private closedReason: string | null = null;
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly sessionListeners = new Set<(session: CDPSession, kind: "attached" | "detached") => void>();
  private readonly rawListeners = new Set<(raw: string) => void>();

  constructor(private readonly transport: Transport, private readonly options: ConnectionOptions = {}) {
    this.rootSession = new CDPSession(this, undefined, null);
    transport.onMessage = (m) => this.onMessage(m);
    transport.onClose = (reason) => this.onTransportClose(reason ?? "transport closed");
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  session(sessionId: string): CDPSession | undefined {
    return this.sessions.get(sessionId);
  }

  allSessions(): CDPSession[] {
    return [this.rootSession, ...this.sessions.values()];
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Receive every raw frame from the browser (used by the CDP proxy to fan out events). */
  onRawMessage(listener: (raw: string) => void): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  /** Fires for every Target.attachedToTarget / detachedFromTarget with the session object. */
  onSession(listener: (session: CDPSession, kind: "attached" | "detached") => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  rawSend(method: string, params: unknown, sessionId: string | undefined, options?: SendOptions): Promise<unknown> {
    if (FORBIDDEN_METHODS.has(method) && !this.options.allowRuntimeEnable && !options?.allowForbiddenMethods) {
      return Promise.reject(
        new Error(
          `${method} is disabled: it is a well-known sign of automation and nothing in pilotfish requires it. ` +
            `Pass allowRuntimeEnable: true to the Connection if you really need it.`,
        ),
      );
    }
    if (this.closedReason) {
      return Promise.reject(new SessionClosedError(method, this.closedReason));
    }
    const id = this.nextId++;
    const message = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, sessionId, resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new CDPError(method, -1, `timed out after ${timeoutMs}ms`, undefined, sessionId));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.options.onWire?.("send", message);
      try {
        this.transport.send(message);
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(reason = "closed by client"): void {
    if (this.closedReason) return;
    this.transport.close();
    this.onTransportClose(reason);
  }

  private onMessage(raw: string): void {
    this.options.onWire?.("recv", raw);
    for (const l of this.rawListeners) l(raw);
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // never let a malformed frame kill the connection
    }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new CDPError(entry.method, msg.error.code, msg.error.message, msg.error.data, entry.sessionId));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;

    // Session bookkeeping happens before dispatch so listeners see a live table.
    if (msg.method === "Target.attachedToTarget") {
      const p = msg.params as Protocol.Target.AttachedToTargetEvent;
      const session = new CDPSession(this, p.sessionId, p.targetInfo, msg.sessionId);
      this.sessions.set(p.sessionId, session);
      for (const l of this.sessionListeners) l(session, "attached");
    } else if (msg.method === "Target.detachedFromTarget") {
      const p = msg.params as Protocol.Target.DetachedFromTargetEvent;
      const session = this.sessions.get(p.sessionId);
      if (session) {
        this.sessions.delete(p.sessionId);
        // Reject this session's in-flight commands now: once the target detaches Chrome never answers
        // them, so they would otherwise hang until their timeout (or forever, for a timeoutMs:0 proxied
        // call) and leak their pending entry.
        for (const [id, entry] of this.pending) {
          if (entry.sessionId !== p.sessionId) continue;
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(new SessionClosedError(entry.method, "detached"));
          this.pending.delete(id);
        }
        session._close("detached");
        for (const l of this.sessionListeners) l(session, "detached");
      }
    }

    const target = msg.sessionId ? this.sessions.get(msg.sessionId) : this.rootSession;
    target?._dispatchEvent(msg.method, msg.params);
    // Also surface target-level attach/detach on the parent session that issued setAutoAttach.
    if (!msg.sessionId) return;
    if (msg.method === "Target.attachedToTarget" || msg.method === "Target.detachedFromTarget") {
      // already dispatched to the parent session above (msg.sessionId is the parent)
    }
  }

  private onTransportClose(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new SessionClosedError(entry.method, reason));
      this.pending.delete(id);
    }
    for (const session of this.sessions.values()) session._close(reason);
    this.sessions.clear();
    this.rootSession._close(reason);
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}
