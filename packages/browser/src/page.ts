// Page: a top-level target plus the constellation of out-of-process iframe
// (OOPIF) targets that render inside it. Everything an agent does to a tab goes
// through here.
//
// Key behaviours (each chosen on measured evidence):
//   * OOPIFs are flat child sessions. Page.setAutoAttach is per session and not
//     recursive, so every attached frame session re-arms it for its children.
//   * No Runtime.enable. Frame-scoped script execution uses
//     Page.createIsolatedWorld (returns an executionContextId without enabling
//     the Runtime domain) or DOM.resolveNode + Runtime.callFunctionOn.
//   * "Settled" is composite: minimum wait -> DOM mutation quiet window ->
//     bounded network idle. Network idle alone is never trusted.
//   * Clicks are hit-tested at the click point (DOM.getNodeForLocation) and
//     refused with a structured error when another element is on top, instead
//     of silently clicking the overlay.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { CDPSession, Protocol } from "@pilotfish/cdp";
import { CDPError } from "@pilotfish/cdp";
import type { Browser } from "./browser.js";
import { NetworkTracker, waitForNetworkIdle, isNoiseRequest, siteOf } from "./network.js";
import type { WriteRequest } from "./network.js";
import { describeKey, parseShortcut, type KeyDescriptor } from "./keys.js";
import { READ_ONLY_GUARD } from "./write-guard.js";
import { inputDriver, type InputDriver } from "./input-driver.js";

/** The read-only world's name: one per process, naming nothing (a world's name is not visible to the page). */
const READ_ONLY_WORLD = randomBytes(6).toString("hex");

export type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

export interface SettleOptions {
  /** Always wait at least this long after an action. Default 100ms. */
  minWaitMs?: number;
  /** DOM must be mutation-free for this long. Default 300ms. */
  mutationQuietMs?: number;
  /** Upper bound on the mutation-quiet wait. Default 2000ms. */
  mutationTimeoutMs?: number;
  /** Network must have ≤ maxPending requests for this long. Default 500ms. */
  networkQuietMs?: number;
  /** Upper bound on the network-idle wait. Default 3000ms. */
  networkTimeoutMs?: number;
  maxPending?: number;
  /**
   * Signal-based settle: wait for write requests caused by the action (since
   * `since`), then a short DOM-quiet window, and treat telemetry/third-party
   * traffic as noise for idleness. Ends as soon as the page is done instead of
   * running fixed windows to their caps on noisy sites.
   */
  fast?: boolean;
  /** Action start time (ms epoch) for attributing write requests. Default: settle start. */
  since?: number;
  /** The action may trigger a delayed reaction (autocomplete, debounced search): use a longer quiet window. */
  expectAsync?: boolean;
  /**
   * The caller already waited for the new document's content (fast navigate) or does not need the
   * server's answer (closing a popup): skip the write wait, only a short final quiet window.
   */
  contentReady?: boolean;
}

export interface WriteSummary {
  method: string;
  url: string;
  status?: number;
  failed?: string;
  /** ms from action start to response (or failure). */
  ms?: number;
  ok: boolean;
}

export interface SettleResult {
  mutationsQuiet: boolean;
  networkIdle: boolean;
  elapsedMs: number;
  /** Write requests caused by the action (fast mode only). */
  writes?: WriteSummary[];
  /** Time spent on the reply to WebSocket frames the action sent (fast mode only; absent when it touched none). */
  socketMs?: number;
}

export interface DialogInfo {
  type: Protocol.Page.DialogType;
  message: string;
  defaultPrompt?: string;
  url: string;
  handledWith: "accept" | "dismiss";
  at: number;
}

export type DialogHandler = (dialog: Omit<DialogInfo, "handledWith" | "at">) => { accept: boolean; promptText?: string } | Promise<{ accept: boolean; promptText?: string }>;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Connection-level navigation failures that a retry usually fixes (not HTTP errors, not timeouts). A
 * TLS *protocol* failure (a flaky exit mid-handshake) retries too; certificate errors (ERR_CERT_*) never.
 */
const TRANSIENT_NAV = /ERR_(CONNECTION_CLOSED|CONNECTION_RESET|EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|SSL_PROTOCOL_ERROR)\b/;

/** Failures that say the same thing however soon they are retried: never part of the quick-failure retry. */
const DETERMINISTIC_NAV = /ERR_(CERT_|BLOCKED_BY|INVALID_URL|UNSAFE_|DISALLOWED_URL_SCHEME|FILE_NOT_FOUND|ACCESS_DENIED)/;

/** What a navigation saw on the way. Timings are ms from the call; a caller that waits further fills the rest. */
export interface NavigateResult {
  timings?: {
    /** Page.navigate answered (the new document committed). */
    commitMs?: number;
    /** DOMContentLoaded of this navigation's document (or a client-side redirect's), when it was waited for. */
    dclMs?: number;
    /** Content ready (waitForContent), filled by the caller. */
    contentMs?: number;
    /** The settle after it, filled by the caller. */
    settleMs?: number;
  };
  /** The main document's HTTP status: the final response after redirects. */
  status?: number;
}

/** event.buttons for a pressed button. */
const BUTTON_MASK: Record<Protocol.Input.MouseButton, number> = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };

/**
 * Longest a history load that stopped loading is still taken as on its way: a back/forward cache restore commits after
 * its stop, later the more its page works in its pageshow (1.5-2 s past the stop with 1.5-3 s of work),
 * so the flag holds until the commit, as long as a pending load is waited for elsewhere (15 s). One the
 * page's beforeunload prompt cancelled (dismissed here) never commits: the flag drops then.
 */
const HISTORY_COMMIT_MS = 15_000;

/**
 * Runs on each session of each worker the pages of a browser start — dedicated, nested (a worker's own
 * worker), shared and service — while the worker is paused before its first line (see addWorkerInitializer).
 * `first` is true on the first session of that worker: work that must run once per worker global (a
 * script) goes there; an override that lasts as long as its session goes on every session.
 */
export type WorkerInitializer = (session: CDPSession, o: { first: boolean }) => Promise<void>;

/** Target types that get the worker initializers. Worklets and the browser's own targets are only released. */
const WORKER_TYPES = new Set(["worker", "shared_worker", "service_worker"]);

interface WorkerSetup {
  inits: WorkerInitializer[];
  /** Per worker target: its first session's initializers (the one-time work), and the sessions set up on it. */
  started: Map<string, { done: Promise<void>; sessions: Set<string> }>;
  watching: boolean;
}

const workerSetups = new WeakMap<Browser, WorkerSetup>();

function workerSetup(browser: Browser): WorkerSetup {
  let w = workerSetups.get(browser);
  if (!w) workerSetups.set(browser, (w = { inits: [], started: new Map(), watching: false }));
  return w;
}

/**
 * Run `init` on every worker the pages of `browser` start, before the worker's own script: a worker
 * auto-attaches paused (waitForDebuggerOnStart), and Runtime.evaluate on its session works without
 * Runtime.enable. Init scripts for documents (Page.addScriptToEvaluateOnNewDocument) never reach workers.
 * Returns the remover.
 */
export function addWorkerInitializer(browser: Browser, init: WorkerInitializer): () => void {
  const list = workerSetup(browser).inits;
  list.push(init);
  return () => {
    const i = list.indexOf(init);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Whether a target type is a worker that gets the worker initializers. */
export function isWorkerTarget(type: string): boolean {
  return WORKER_TYPES.has(type);
}

/**
 * Whether Chrome opened this tab with its opener cut off: it names an opener the tab cannot reach (window.open
 * with noopener or noreferrer, a link or form with target=_blank, noopener by default). Such a tab has no
 * renderer until it is released (Chrome 156; a popup with an opener, a ctrl+click tab and Target.createTarget
 * have one), see Page.initFrameSession.
 */
function openerCutOff(info: Protocol.Target.TargetInfo | null | undefined): boolean {
  return info?.type === "page" && !!info.openerId && info.canAccessOpener === false;
}

/** The browser's own scripts: extensions, internal pages, and blob: URLs one of them made. */
const BROWSER_OWN_URL = /^(?:blob:)?(?:chrome|chrome-extension|chrome-untrusted|devtools|edge|brave):/i;

/**
 * Whether a worker's script is the browser's own (see BROWSER_OWN_URL): initWorkerSession releases such a
 * worker untouched, never giving it a site's worker initializers or clock. Any other worker is a page's, whatever
 * its scheme: http(s), and the blob: and data: URLs a page builds a worker from (a one-file script can start its
 * SharedWorker that way).
 */
export function isBrowserOwnUrl(url: string): boolean {
  return BROWSER_OWN_URL.test(url);
}

/**
 * @internal Set up a worker session that attached paused (waitForDebuggerOnStart), then let the worker start.
 * The initializers run first, bounded so a hung one never keeps the worker (and the page waiting on it)
 * paused. A dedicated or shared worker also auto-attaches the workers it starts itself, paused, and each
 * gets the same, however deep (Chrome sets no limit, so neither does this: a worker one level past a limit
 * would start as the host). One worker can attach on more than one session (a service worker attaches to the
 * browser and to the page it serves): the first runs the one-time work, and every other session releases
 * only after the first has sent its commands, so whichever release starts the worker comes after them. A
 * worker of the browser's own (isBrowserOwnUrl) is only released: this is the one place that decides it,
 * for the workers a page attaches and those the browser does (shared and service).
 */
export function initWorkerSession(browser: Browser, session: CDPSession): void {
  const setup = workerSetup(browser);
  const info = session.targetInfo;
  if (isBrowserOwnUrl(info?.url ?? "")) {
    void session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
    return;
  }
  if (info && (info.type === "worker" || info.type === "shared_worker")) {
    session.on("Target.attachedToTarget", (e) => {
      const child = browser.connection.session(e.sessionId);
      if (!child) return;
      if (isWorkerTarget(e.targetInfo.type)) initWorkerSession(browser, child);
      else void child.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
    });
    void session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => undefined);
  }
  if (!setup.watching) {
    setup.watching = true;
    // A target is forgotten once every session set up on it has detached. Chrome never idle-stops a worker
    // while our sessions are attached to it (a service worker left idle 45 s stayed "running"), so a worker
    // normally attaches once. A worker stopped abnormally (its process crashed, ServiceWorker.stopAllWorkers)
    // restarts paused under the same sessions with no new attach, and nothing here releases it: the page it
    // serves then hangs until its run times out. That predates this code and is a known follow-up (release a
    // worker seen paused again, from its version's running status). Were a restart ever announced while one
    // of its old sessions stayed listed (Windows reported a detach for only one of a service worker's two),
    // its new global would get the per-session overrides but not the one-time bundle.
    browser.connection.onSession((s, kind) => {
      const id = kind === "detached" ? s.targetInfo?.targetId : undefined;
      const entry = id ? setup.started.get(id) : undefined;
      if (entry && entry.sessions.delete(s.sessionId ?? "") && entry.sessions.size === 0) setup.started.delete(id!);
    });
  }
  const id = info?.targetId ?? session.sessionId ?? "";
  const runInits = (first: boolean): Promise<unknown> =>
    setup.inits.length ? Promise.race([Promise.all(setup.inits.map((init) => init(session, { first }).catch(() => undefined))), sleep(2_000)]) : Promise.resolve();
  const before = setup.started.get(id);
  let run: Promise<unknown>;
  if (before) {
    before.sessions.add(session.sessionId ?? "");
    run = before.done.then(() => runInits(false));
  } else {
    run = runInits(true);
    setup.started.set(id, { done: run.then(() => undefined), sessions: new Set([session.sessionId ?? ""]) });
  }
  void run.then(() => session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined));
}

export class ActionError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "stale"
      | "not_visible"
      | "obscured"
      | "not_interactable"
      | "frame_detached"
      | "timeout"
      | "crashed"
      | "navigation_failed"
      | "dialog_open",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/** One CDP session rendering one frame subtree: the main frame or an OOPIF. */
export class FrameSession {
  readonly network: NetworkTracker;
  readonly children = new Map<string, FrameSession>(); // frameId -> child OOPIF session
  url: string;
  /** Execution context for DOM queries in this frame, created lazily. */
  private isolatedWorldId: number | null = null;
  /** The read-only world's context in this frame (readOnlyWorld), created lazily. */
  private readOnlyWorldId: number | null = null;

  constructor(
    readonly page: Page,
    readonly session: CDPSession,
    /** Frame id. For OOPIFs this equals the target id. */
    readonly frameId: string,
    readonly parent: FrameSession | null,
  ) {
    this.network = new NetworkTracker(session);
    this.url = session.targetInfo?.url ?? "";
    // Execution contexts belong to a document. A cross-document navigation of
    // this frame destroys the isolated world, so forget the cached id.
    session.on("Page.frameNavigated", (e) => {
      if (e.frame.id === this.frameId) this.isolatedWorldId = this.readOnlyWorldId = null;
    });
  }

  get isMain(): boolean {
    return this.parent === null;
  }

  /** Walk this frame and all descendant OOPIF frames. */
  *walk(): Generator<FrameSession> {
    yield this;
    for (const c of this.children.values()) yield* c.walk();
  }

  async isolatedWorld(): Promise<number> {
    if (this.isolatedWorldId !== null) return this.isolatedWorldId;
    const { executionContextId } = await this.session.send("Page.createIsolatedWorld", {
      frameId: this.frameId,
      worldName: "", // unnamed: avoids a framework-identifying utility-world name
      grantUniveralAccess: false,
    });
    this.isolatedWorldId = executionContextId;
    return executionContextId;
  }

  /**
   * An isolated world of its own where every call that acts on the page, sends data or changes what it shows
   * throws (READ_ONLY_GUARD): for an expression the model wrote, which must only read. Separate from
   * isolatedWorld(), whose DOM methods the tools themselves use.
   */
  async readOnlyWorld(): Promise<number> {
    if (this.readOnlyWorldId !== null) return this.readOnlyWorldId;
    const { executionContextId } = await this.session.send("Page.createIsolatedWorld", { frameId: this.frameId, worldName: READ_ONLY_WORLD, grantUniveralAccess: false });
    const res = await this.session.send("Runtime.evaluate", { expression: READ_ONLY_GUARD, contextId: executionContextId, returnByValue: true });
    if (res.exceptionDetails || res.result.value !== true) throw new Error("The read-only world could not be set up");
    this.readOnlyWorldId = executionContextId;
    return executionContextId;
  }

  /**
   * Evaluate `expression` in this frame's isolated world (`readOnly`: the read-only world). Returns the value
   * by value.
   */
  async evaluate<T = unknown>(expression: string, { awaitPromise = true, mainWorld = false, readOnly = false, timeoutMs = 10_000 } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const contextId = mainWorld ? undefined : readOnly ? await this.readOnlyWorld() : await this.isolatedWorld();
      try {
        const res = await this.session.send(
          "Runtime.evaluate",
          { expression, contextId, returnByValue: true, awaitPromise, userGesture: false },
          { timeoutMs },
        );
        if (res.exceptionDetails) throw evalError(res.exceptionDetails);
        return res.result.value as T;
      } catch (e) {
        // The document may have been replaced between creating the world and
        // using it (navigation racing with our event handler). Retry once.
        if (attempt === 0 && !mainWorld && e instanceof CDPError && /Cannot find context|Execution context was destroyed/i.test(e.message)) {
          if (readOnly) this.readOnlyWorldId = null;
          else this.isolatedWorldId = null;
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Call `fn` with `this` bound to the DOM node identified by backendNodeId; with `isolated`, in this frame's
   * isolated world, where no page script's wrapper of a DOM method sees what `fn` calls.
   */
  async callOnNode<T = unknown>(backendNodeId: number, fn: string, args: unknown[] = [], { returnByValue = true, isolated = false } = {}): Promise<T> {
    let object: { objectId?: string } | undefined;
    for (let attempt = 0; !object; attempt++) {
      const executionContextId = isolated ? await this.isolatedWorld() : undefined;
      try {
        ({ object } = await this.session.send("DOM.resolveNode", { backendNodeId, executionContextId }));
      } catch (e) {
        // A world made for a document since replaced is made again once (see evaluate); a node gone is not that.
        if (isolated && attempt === 0 && e instanceof CDPError && /Cannot find context|Execution context was destroyed|Cannot find execution context/i.test(e.message)) {
          this.isolatedWorldId = null;
          continue;
        }
        throw new ActionError("stale", `Element no longer exists in the page (backendNodeId ${backendNodeId})`, { cause: String(e) });
      }
    }
    if (!object.objectId) throw new ActionError("stale", "Element could not be resolved to an object");
    try {
      const res = await this.session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: args.map((a) => ({ value: a })),
        returnByValue,
        awaitPromise: true,
      });
      if (res.exceptionDetails) throw evalError(res.exceptionDetails);
      return (returnByValue ? res.result.value : res.result) as T;
    } finally {
      void this.session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
    }
  }

  /** Call `fn` on one node with other nodes of this frame as its arguments (returned by value). */
  async callOnNodeWith<T = unknown>(backendNodeId: number, fn: string, argNodeIds: number[]): Promise<T> {
    const ids = [backendNodeId, ...argNodeIds];
    const objs = await Promise.all(ids.map((id) => this.session.send("DOM.resolveNode", { backendNodeId: id }).then((r) => r.object.objectId)));
    if (objs.some((o) => !o)) throw new ActionError("stale", "Element could not be resolved to an object");
    try {
      const res = await this.session.send("Runtime.callFunctionOn", {
        objectId: objs[0]!,
        functionDeclaration: fn,
        arguments: objs.slice(1).map((objectId) => ({ objectId })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) throw evalError(res.exceptionDetails);
      return res.result.value as T;
    } finally {
      for (const objectId of objs) void this.session.send("Runtime.releaseObject", { objectId: objectId! }).catch(() => undefined);
    }
  }

  /** Content box in this frame's viewport coordinates. */
  async contentQuad(backendNodeId: number): Promise<Rect | null> {
    try {
      const { quads } = await this.session.send("DOM.getContentQuads", { backendNodeId });
      const q = quads.find((quad) => quadArea(quad) > 0);
      if (!q) return null;
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch (e) {
      if (e instanceof CDPError && /Could not find node|No node|not found/i.test(e.message)) {
        throw new ActionError("stale", `Element no longer exists in the page (backendNodeId ${backendNodeId})`);
      }
      if (e instanceof CDPError && /Could not compute content quads/i.test(e.message)) return null;
      throw e;
    }
  }

  /**
   * Offset of this frame's viewport origin within the top-level page viewport,
   * accumulated through every OOPIF ancestor.
   */
  async offsetInPage(): Promise<Point> {
    if (!this.parent) return { x: 0, y: 0 };
    const parentOffset = await this.parent.offsetInPage();
    const { backendNodeId } = await this.parent.session.send("DOM.getFrameOwner", { frameId: this.frameId });
    const quad = await this.parent.contentQuad(backendNodeId);
    if (!quad) return parentOffset;
    return { x: parentOffset.x + quad.x, y: parentOffset.y + quad.y };
  }

  _dispose(): void {
    this.network.dispose();
    for (const c of this.children.values()) c._dispose();
    this.children.clear();
  }
}

export interface PageEvents {
  dialog: (dialog: DialogInfo) => void;
  navigated: (url: string) => void;
  crashed: (reason: string) => void;
  closed: (reason: string) => void;
  console: (entry: { level: string; text: string }) => void;
  popup: (page: Page) => void;
}

export class Page {
  readonly targetId: string;
  readonly main: FrameSession;
  private readonly framesById = new Map<string, FrameSession>();
  private readonly emitter = new EventEmitter();
  private closedReason: string | null = null;
  private crashedReason: string | null = null;
  private _ready = false;
  private _readyResolve!: () => void;
  /** Resolves when the page has finished initializing (domains enabled, timezone/locale overrides on), or closed/crashed. */
  readonly whenReady: Promise<void> = new Promise<void>((r) => (this._readyResolve = r));
  private _url: string;
  /** Last main-frame navigation (document or same-document), ms epoch. */
  lastNavigationAt = 0;
  /**
   * Last main-frame document (a load, a reload, a restore from the back/forward cache), ms epoch, strictly
   * increasing: a same-document URL change (history API, fragment) is not one. A single-page app may rewrite its
   * URL while a check is on it, which says nothing about the check.
   */
  lastDocumentAt = 0;
  /**
   * The main frame started loading another document (Page.frameStartedNavigating: a load, a reload, a history
   * restore) that has neither committed nor stopped (a 204, a download, one replaced by the next). The browser
   * routes input to the new document from its commit, which Page.frameNavigated reports here only later, so
   * input meant for the current one stops while this is true. Chrome tells of some loads only as they commit, or
   * after: a restore from the back/forward cache, and one a service worker answers; input sent in
   * that gap reaches the new document.
   */
  navigationPending = false;
  /** A beforeunload prompt was dismissed: the history load it held, if any, will not commit. */
  private historyCancelled: () => void = () => {};
  private openDialog: Protocol.Page.JavascriptDialogOpeningEvent | null = null;
  readonly dialogs: DialogInfo[] = [];
  dialogHandler: DialogHandler | null = null;
  /** Default dialog policy: accept alerts, dismiss everything else. */
  defaultDialogPolicy: (type: Protocol.Page.DialogType) => boolean = (type) => type === "alert";
  readonly openerId: string | undefined;
  /**
   * Input through the registered input driver (input-driver.ts: paths, pauses, holds, typing pace, wheel deltas).
   * Off, or with no driver registered: one jump per move, a short press, insertText, one wheel event per scroll.
   */
  humanize = false;
  /** This page's input driver, made the first time it is needed with `humanize` on (null: plain input). */
  private get driver(): InputDriver | null {
    if (!this.humanize) return null;
    if (this._driver === undefined) this._driver = inputDriver()?.(this) ?? null;
    return this._driver;
  }
  private _driver: InputDriver | null | undefined;
  /** When a person last sent input through the live view (ms): the resting hand keeps off while they work. */
  personInputAt = 0;
  /** The mouse buttons a person holds down in the live view (MouseEvent.buttons): no resting hand meanwhile. */
  personHeld = 0;
  /**
   * Where the current input action's time went (ms, `InputPhase`): a caller clears it before an action and reads it
   * after. A click: locate (finding it and bringing it into view, the wheel apart), wheel, approach, dwell, reaim
   * (looking again before the press), press; typing adds clear and keys.
   */
  inputPhases: Partial<Record<InputPhase, number>> = {};

  /**
   * Input on its own clock: each event carries the time it is due (CDP's `timestamp`, which becomes the page's
   * event.timeStamp) and none waits for the one before to be acknowledged, so a busy renderer neither stretches a
   * movement nor bunches its events (on 2 Nov a 1 s approach took 1.8 s on Best Buy, each move waiting on its
   * acknowledgement). Events still reach the page in order; `settle()` waits for every acknowledgement and throws
   * the first failure.
   */
  private flow(): InputFlow {
    const sent: Array<Promise<unknown>> = [];
    let failure: unknown;
    const keep = (p: Promise<unknown>) => void sent.push(p.catch((e: unknown) => void (failure ??= e)));
    return {
      mouse: (params, at) => keep(this.session.send("Input.dispatchMouseEvent", { ...params, timestamp: at / 1000 })),
      key: (params, at) => keep(this.session.send("Input.dispatchKeyEvent", { ...params, timestamp: at / 1000 })),
      settle: async () => {
        await Promise.all(sent.splice(0));
        if (failure !== undefined) throw failure;
      },
    };
  }

  /** Adds the time since `since` to `phase`; returns now. */
  private spent(phase: InputPhase, since: number): number {
    const now = Date.now();
    this.inputPhases[phase] = (this.inputPhases[phase] ?? 0) + now - since;
    return now;
  }
  /** Last pointer position sent to the page (viewport CSS px): where the next path starts. */
  cursor: Point;

  constructor(
    readonly browser: Browser,
    readonly session: CDPSession,
    readonly targetInfo: Protocol.Target.TargetInfo,
  ) {
    this.targetId = targetInfo.targetId;
    this._url = targetInfo.url;
    this.openerId = targetInfo.openerId;
    this.main = new FrameSession(this, session, targetInfo.targetId, null);
    // A pointer enters from somewhere in the lower half, not from the corner at 0,0.
    const v = browser.viewport;
    this.cursor = { x: Math.round(v.width * between(0.3, 0.7)), y: Math.round(v.height * between(0.55, 0.9)) };
  }

  get url(): string {
    return this._url;
  }
  get ready(): boolean {
    return this._ready;
  }
  get closed(): boolean {
    return this.closedReason !== null;
  }
  get crashed(): string | null {
    return this.crashedReason;
  }

  on<E extends keyof PageEvents>(event: E, listener: PageEvents[E]): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  frames(): FrameSession[] {
    return [...this.main.walk()];
  }

  frameById(frameId: string): FrameSession | undefined {
    if (frameId === this.main.frameId) return this.main;
    return this.framesById.get(frameId);
  }

  /** @internal */
  async _initialize(): Promise<void> {
    // The page's own listeners go on before the tab is released (initFrameSession's last step): its first
    // document can commit, or a dialog open, while the frame tree below is still being read, and an event
    // dispatched before its listener exists is gone. A popup then reported no address until its next
    // navigation ("opened a new tab t2 ()"). The main frame's id is the target's until
    // the tree says otherwise.
    let navigated = false;
    this.session.on("Page.frameNavigated", (e) => {
      if (e.frame.id === this.main.frameId && !e.frame.parentId) {
        navigated = true;
        this._url = e.frame.url;
        this.main.url = e.frame.url;
        this.lastNavigationAt = Date.now();
        this.lastDocumentAt = Math.max(this.lastNavigationAt, this.lastDocumentAt + 1);
        this.navigationPending = false;
        this.emitter.emit("navigated", e.frame.url);
      }
    });
    // Loads started, so a stop meant for one is never taken for a later one's.
    let loads = 0;
    let history = false;
    this.session.on("Page.frameStartedNavigating", (e) => {
      if (e.frameId !== this.main.frameId || e.navigationType === "sameDocument" || e.navigationType === "historySameDocument") return;
      loads++;
      history = e.navigationType === "historyDifferentDocument";
      this.navigationPending = true;
    });
    // A navigation that never commits stops loading instead (seen for a 204, a download, and one replaced by the next).
    // A restore from the back/forward cache stops before its commit (180 of 180 measured, up to 325 ms before,
    // 1.5-2 s when the page works 1.5-3 s in its pageshow): a history load keeps the flag until
    // its commit, its beforeunload prompt dismissed (handleDialog), or HISTORY_COMMIT_MS.
    this.session.on("Page.frameStoppedLoading", (e) => {
      if (e.frameId !== this.main.frameId) return;
      if (!history) return void (this.navigationPending = false);
      const load = loads;
      setTimeout(() => {
        if (loads === load) this.navigationPending = false;
      }, HISTORY_COMMIT_MS).unref?.();
    });
    this.historyCancelled = () => {
      if (history) this.navigationPending = false;
    };
    this.session.on("Page.navigatedWithinDocument", (e) => {
      if (e.frameId === this.main.frameId) {
        navigated = true;
        this._url = e.url;
        this.main.url = e.url;
        this.lastNavigationAt = Date.now();
        this.emitter.emit("navigated", e.url);
      }
    });
    this.session.on("Page.javascriptDialogOpening", (e) => void this.handleDialog(e));
    this.session.on("Page.javascriptDialogClosed", () => {
      this.openDialog = null;
    });
    this.session.on("Inspector.targetCrashed", () => this._markCrashed("renderer crashed"));
    this.session.on("Page.windowOpen", () => {
      /* popup target will auto-attach; Browser emits "page" */
    });
    await this.initFrameSession(this.main);
    // Main frame id can differ from target id on some builds; fetch the tree.
    const { frameTree } = await this.session.send("Page.getFrameTree");
    (this.main as { frameId: string }).frameId = frameTree.frame.id;
    // A navigation seen meanwhile is at least as new as the tree.
    if (!navigated) this._url = frameTree.frame.url;
    // The timezone and locale overrides went on with the browser's session initializers (every frame
    // session gets them, see the Browser constructor), before this tab's first document ran.
    // Headless pages are not "focused"; without this, focus() and key events may be dropped.
    await this.session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    this._ready = true;
    this._readyResolve();
  }

  private async initFrameSession(frame: FrameSession): Promise<void> {
    const s = frame.session;
    // Child OOPIF sessions announce their own children on *their* session.
    s.on("Target.attachedToTarget", (e) => {
      const childSession = this.browser.connection.session(e.sessionId);
      if (e.targetInfo.type !== "iframe") {
        // A worker or worklet auto-attaches PAUSED (waitForDebuggerOnStart). It must be released or it —
        // and the page that is waiting on it (search, maps, WASM decoders) — hangs forever. A worker (a
        // dedicated one, or the service worker serving this page) gets the worker initializers (the
        // extensions' scripts) first, bounded, so a hung one never keeps it paused.
        if (!childSession) return;
        if (isWorkerTarget(e.targetInfo.type)) return initWorkerSession(this.browser, childSession);
        void childSession.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
        return;
      }
      if (!childSession) return;
      const child = new FrameSession(this, childSession, e.targetInfo.targetId, frame);
      frame.children.set(child.frameId, child);
      this.framesById.set(child.frameId, child);
      void this.initFrameSession(child).catch(() => {
        frame.children.delete(child.frameId);
        this.framesById.delete(child.frameId);
      });
    });
    s.on("Target.detachedFromTarget", (e) => {
      for (const [fid, child] of frame.children) {
        if (child.session.sessionId === e.sessionId) {
          child._dispose();
          frame.children.delete(fid);
          this.framesById.delete(fid);
          // The iframe may have owned its process's clock, which other frames there still show.
          this.browser._clockOwnerMayHaveLeft();
        }
      }
    });
    s.on("Page.frameNavigated", (e) => {
      if (e.frame.id !== frame.frameId) return;
      frame.url = e.frame.url;
      // A navigation can move the frame to another process; the one it left loses the clock it owned.
      this.browser._clockOwnerMayHaveLeft();
    });
    const enabled = Promise.all([
      s.send("Page.enable"),
      s.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      s.send("Network.enable", { maxPostDataSize: 0 }),
      s.send("Accessibility.enable").catch(() => undefined),
      s.send("Inspector.enable").catch(() => undefined),
      s.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ]);
    // Init scripts, bindings and blocking rules go in before the document runs (see Browser.sessionInitializers).
    if (!openerCutOff(s.targetInfo)) {
      await enabled;
      for (const init of this.browser.sessionInitializers) await init(frame).catch(() => undefined);
      await s.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
      return;
    }
    // A tab whose opener Chrome cut off has no renderer until it is released, and answers nothing its renderer
    // handles (Page, Network, Emulation, Runtime) before that: waiting for those answers kept it paused for good,
    // with no "page" event and no initializer applied. So everything goes out first: the domains above, every initializer at
    // once, in order (each sends what the first document needs before it awaits anything), then the release.
    // Chrome hands the new renderer what was sent, in order, before it commits the tab's first document.
    const inits = this.browser.sessionInitializers.map((init) => init(frame).catch(() => undefined));
    const released = s.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
    await Promise.all([enabled, ...inits, released]);
  }

  private async handleDialog(e: Protocol.Page.JavascriptDialogOpeningEvent): Promise<void> {
    this.openDialog = e;
    let decision: { accept: boolean; promptText?: string };
    try {
      decision = this.dialogHandler
        ? await this.dialogHandler({ type: e.type, message: e.message, defaultPrompt: e.defaultPrompt, url: e.url })
        : { accept: this.defaultDialogPolicy(e.type) };
    } catch {
      decision = { accept: false };
    }
    const info: DialogInfo = {
      type: e.type,
      message: e.message,
      defaultPrompt: e.defaultPrompt,
      url: e.url,
      handledWith: decision.accept ? "accept" : "dismiss",
      at: Date.now(),
    };
    this.dialogs.push(info);
    if (this.dialogs.length > 20) this.dialogs.shift();
    await this.session
      .send("Page.handleJavaScriptDialog", { accept: decision.accept, promptText: decision.promptText })
      .catch(() => undefined);
    // Leaving the page refused: the history load that asked never commits (input waits no longer for it).
    if (e.type === "beforeunload" && !decision.accept) this.historyCancelled();
    this.openDialog = null;
    this.emitter.emit("dialog", info);
  }

  /** Dialogs recorded since `since` (ms epoch). */
  dialogsSince(since: number): DialogInfo[] {
    return this.dialogs.filter((d) => d.at >= since);
  }

  /** @internal */
  _markClosed(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this._readyResolve(); // never leave a whenReady waiter hanging if the page died mid-init
    this.main._dispose();
    this.emitter.emit("closed", reason);
  }

  /** @internal */
  _markCrashed(reason: string): void {
    this.crashedReason = reason;
    this.emitter.emit("crashed", reason);
  }

  private assertUsable(): void {
    if (this.closedReason) throw new ActionError("frame_detached", `Page is closed (${this.closedReason})`);
    if (this.crashedReason) throw new ActionError("crashed", `Page crashed (${this.crashedReason}); call page.recover()`);
  }

  /** After a renderer crash: reload the current URL in a fresh renderer. */
  async recover(): Promise<void> {
    if (!this.crashedReason) return;
    const url = this._url;
    this.crashedReason = null;
    await this.navigate(url && url !== "about:blank" ? url : "about:blank").catch((e: unknown) => {
      this.crashedReason = `recover failed: ${(e as Error).message}`;
      throw e;
    });
  }

  // ---------------------------------------------------------------- navigation

  /**
   * Navigate, retrying (twice, within the same deadline) only when the connection itself failed —
   * a proxy dropping a tunnel, a reset — never on an HTTP error or a timeout. A navigation
   * is a GET, so a retry is safe. A navigation refused within 200 ms with nothing committed and no
   * response (an exit switching routes mid-request: ERR_ABORTED in 36 ms) is retried once, whatever
   * the error, unless the error is one a retry cannot change (certificates, blocked by policy).
   */
  async navigate(url: string, opts: { waitUntil?: WaitUntil; timeoutMs?: number } = {}): Promise<NavigateResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let quickRetried = false;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        return await this.navigateOnce(url, { ...opts, timeoutMs: Math.max(1_000, deadline - Date.now()) });
      } catch (e) {
        const failed = e instanceof ActionError && e.code === "navigation_failed";
        const errorText = failed ? String(e.details?.["errorText"] ?? "") : "";
        const transient = failed && TRANSIENT_NAV.test(errorText);
        const quick = failed && !quickRetried && Date.now() - started <= 200 && e.details?.["committed"] === false && !DETERMINISTIC_NAV.test(errorText);
        if ((!transient && !quick) || attempt >= 2 || Date.now() + 1_500 > deadline) throw e;
        if (!transient) quickRetried = true;
        await sleep(!transient ? 150 : attempt === 0 ? 400 : 1_200);
      }
    }
  }

  private async navigateOnce(url: string, { waitUntil = "load", timeoutMs = 30_000 }: { waitUntil?: WaitUntil; timeoutMs?: number } = {}): Promise<NavigateResult> {
    this.assertUsable();
    const started = Date.now();
    const deadline = started + timeoutMs;
    const wanted = waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "load";
    // Record lifecycle events from before Page.navigate returns: the load event
    // of a fast page can arrive before the response. Match on the loaderId of
    // *this* navigation; the previous document (e.g. the initial about:blank)
    // fires its own late "load" with a different loaderId, which must not count.
    const seen: Array<{ name: string; loaderId: string; at: number }> = [];
    const off = this.session.on("Page.lifecycleEvent", (e) => {
      if (e.frameId === this.main.frameId) seen.push({ name: e.name, loaderId: e.loaderId, at: Date.now() });
    });
    // The main document's response per loaderId (the final one: redirects arrive as redirectResponse).
    const statuses = new Map<string, number>();
    const offResponse = this.session.on("Network.responseReceived", (e) => {
      if (e.type === "Document" && e.frameId === this.main.frameId) statuses.set(e.loaderId, e.response.status);
    });
    // A client-side redirect (location.replace in the first document) commits a new document with
    // its own loaderId; the first one never reaches DOMContentLoaded. Its successors count too.
    // This navigation's document, and documents committed after it (client-side redirects). A commit
    // that arrives before Page.navigate answers belongs to an earlier navigation and does not count.
    const loaders = new Set<string>();
    let answered = false;
    // Every main-frame commit during this call, by loaderId: a server redirect commits another URL than
    // the one asked for, and its frameNavigated can arrive before Page.navigate answers.
    const committed = new Map<string, string>();
    const offNav = this.session.on("Page.frameNavigated", (e) => {
      if (e.frame.id !== this.main.frameId || e.frame.parentId) return;
      committed.set(e.frame.loaderId, e.frame.url);
      if (answered) loaders.add(e.frame.loaderId);
    });
    // The latest of this navigation's documents that got a response, and the phases seen so far.
    const result = (commitMs: number): NavigateResult => {
      let status: number | undefined;
      for (const id of loaders) status = statuses.get(id) ?? status;
      const dcl = seen.find((e) => loaders.has(e.loaderId) && e.name === "DOMContentLoaded");
      return { timings: { commitMs, ...(dcl ? { dclMs: dcl.at - started } : {}) }, ...(status !== undefined ? { status } : {}) };
    };
    try {
      const res = await this.session.send("Page.navigate", { url }, { timeoutMs });
      answered = true;
      const commitMs = Date.now() - started;
      if (res.errorText) {
        // Chrome commits its own error page for most failures; that is not the site answering.
        const committedDoc = statuses.size > 0 || [...committed.values()].some((u) => !u.startsWith("chrome-error:"));
        throw new ActionError("navigation_failed", `Navigation to ${url} failed: ${res.errorText}`, { errorText: res.errorText, committed: committedDoc });
      }
      // The asked-for URL until a commit says otherwise — never over a commit already seen, which
      // would put the pre-redirect URL back.
      this._url = (res.loaderId && committed.get(res.loaderId)) || url;
      // Same-document navigations (hash changes) have no loaderId and no load event.
      if (!res.loaderId) return result(commitMs);
      loaders.add(res.loaderId);
      if (waitUntil === "commit") return result(commitMs);
      if (!seen.some((e) => loaders.has(e.loaderId) && e.name === wanted)) {
        await this.session
          .waitFor("Page.lifecycleEvent", (e) => e.frameId === this.main.frameId && loaders.has(e.loaderId) && e.name === wanted, Math.max(1, deadline - Date.now()))
          .catch(async () => {
            const state = await this.main.evaluate<string>("document.readyState").catch(() => "unknown");
            const pending = this.frames().reduce((n, f) => n + f.network.inflightTotal(), 0);
            // A usable document whose load event never arrived (client-side redirect, or
            // ads/telemetry that never finish) is not a failed navigation.
            if (state === "complete" || state === "interactive") return;
            // The phases it did reach go with the error: the slowest navigations are the ones worth timing.
            throw new ActionError("timeout", `Page did not finish loading within ${timeoutMs} ms (readyState=${state}, ${pending} request(s) still pending). The site may be slow; the page may still be usable.`, { readyState: state, pending, timings: result(commitMs).timings });
          });
      }
      if (waitUntil === "networkidle") {
        await waitForNetworkIdle(this.frames().map((f) => f.network), { timeoutMs: Math.max(0, deadline - Date.now()) });
      }
      return result(commitMs);
    } finally {
      off();
      offNav();
      offResponse();
    }
  }

  private waitForLifecycle(name: "domcontentloaded" | "load", timeoutMs: number): Promise<void> {
    const wanted = name === "load" ? "load" : "DOMContentLoaded";
    return this.session
      .waitFor("Page.lifecycleEvent", (e) => e.frameId === this.main.frameId && e.name === wanted, timeoutMs)
      .then(() => undefined)
      .catch((e: Error) => {
        throw new ActionError("timeout", `Timed out waiting for ${name}: ${e.message}`);
      });
  }

  /** document.readyState plus pending request count: a cheap "is this page done loading?" probe. */
  /** First-party XHR/fetch requests in flight (telemetry and third parties excluded). */
  pendingData(): number {
    const host = safeHost(this.url);
    return this.frames().reduce((n, f) => n + f.network.pendingData(Date.now(), (url) => isNoiseRequest(url, host)), 0);
  }

  /** A first-party WebSocket still connecting, or with a frame either way in the last `withinMs` (third parties excluded). */
  socketBusy(withinMs = 1_000): boolean {
    const host = safeHost(this.url);
    return this.frames().some((f) => f.network.socketBusy(withinMs, (url) => isNoiseRequest(url, host)));
  }

  /** Sites whose WebSocket never went quiet within a whole wait (a price ticker): not waited for again on this page. */
  private readonly chattySockets = new Set<string>();

  /**
   * The answer to what an action sent over a first-party WebSocket. A page that opened one, or sent a frame on one,
   * during the action gets its reply before the snapshot: frames are not requests, so the network wait never saw them
   * (Wolfram|Alpha's results arrive as "pods" frames about 1.5 s after its page reads quiet, and without this wait
   * the model read an empty result page). Ends once the touched sockets have been silent for
   * `quietMs` (and any still connecting has connected), at most `capMs`; a site whose socket never goes quiet is not
   * waited for again. No touched socket: returns at once, so pages without one never wait.
   */
  private async awaitSocketReplies(since: number, { quietMs = 700, capMs = 3_000 } = {}): Promise<number> {
    const host = safeHost(this.url);
    const site = siteOf(host);
    if (this.chattySockets.has(site)) return 0;
    const noise = (url: string) => isNoiseRequest(url, host);
    const touched = () => this.frames().flatMap((f) => f.network.socketsSince(since, noise));
    if (!touched().length) return 0;
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      const list = touched();
      const connecting = list.some((s) => !s.open && now - s.createdAt < 10_000);
      const last = Math.max(...list.map((s) => Math.max(s.createdAt, s.lastSent, s.lastReceived)));
      if (!connecting && now - last >= quietMs) break;
      if (now - t0 >= capMs) {
        this.chattySockets.add(site);
        break;
      }
      await sleep(50);
    }
    // What the frames carried is drawn next: a short DOM-quiet window.
    await this.main.evaluate<boolean>(mutationQuietScript(100, 600), { timeoutMs: 2_000 }).catch(() => false);
    return Date.now() - t0;
  }

  /**
   * Let the page's own writes reach its site before the browser is let go: waits until none of its first-party write
   * requests (POST, PUT, PATCH, DELETE, a GraphQL mutation; telemetry and other sites left out) is in flight and none
   * has started for `quietMs` (a debounced save, such as a cart that syncs a moment after the click), up to
   * `timeoutMs`. `host`: the site whose writes count (default: the page's own). Live, 6 Nov: an item added to a Swiggy
   * Instamart cart showed in the agent's cart but never reached the person's account, the browser closed seconds
   * after the click.
   */
  async flushWrites({ quietMs = 1_500, timeoutMs = 3_000, host = safeHost(this.url) }: { quietMs?: number; timeoutMs?: number; host?: string } = {}): Promise<{ pending: number; waitedMs: number }> {
    const t0 = Date.now();
    // An idle page has nothing on its way: no first-party request in the last two quiet windows. It is let go at once
    // (a person's Stop closes the browser in a moment; a cancel would otherwise wait out the window for nothing).
    const noise = (url: string) => isNoiseRequest(url, host);
    const busy = (): boolean => this.frames().some((f) => f.network.requestsSince(Date.now() - quietMs * 2, noise) > 0);
    const look = () => {
      let pending = 0;
      let last = 0;
      for (const f of this.frames()) {
        for (const w of f.network.writesSince(t0 - 60_000, host)) {
          last = Math.max(last, w.startedAt);
          if (!w.endedAt && !w.failed) pending++;
        }
      }
      return { pending, last };
    };
    for (;;) {
      const s = look();
      const now = Date.now();
      if (this.closed) return { pending: s.pending, waitedMs: now - t0 };
      // Nothing in flight, and the last write (else the page's last request) is a quiet window behind.
      if (!s.pending && (now - t0 >= quietMs || !busy()) && now - s.last >= quietMs) return { pending: 0, waitedMs: now - t0 };
      if (now - t0 >= timeoutMs) return { pending: s.pending, waitedMs: now - t0 };
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Leave the page the way a person closing the tab does, so what it sends on the way out goes (a cart or draft many
   * sites save on pagehide, unload or visibilitychange, with sendBeacon or a keepalive fetch): the main frame goes
   * to about:blank, then its writes get `flushWrites`. A browser closed without this kills the page with nothing
   * sent. Never throws.
   */
  async leave(timeoutMs = 1_500): Promise<void> {
    if (this.closed) return;
    const host = safeHost(this.url);
    if (!host) return;
    await this.navigate("about:blank", { waitUntil: "commit", timeoutMs }).catch(() => undefined);
    await this.flushWrites({ host, quietMs: 500, timeoutMs }).catch(() => undefined);
  }

  async loadState(): Promise<{ readyState: string; pendingRequests: number; contentType: string }> {
    const s = await this.main
      .evaluate<{ rs: string; ct: string }>("({ rs: document.readyState, ct: document.contentType })", { timeoutMs: 3_000 })
      .catch(() => ({ rs: "unknown", ct: "" }));
    const pendingRequests = this.frames().reduce((n, f) => n + f.network.inflightTotal(), 0);
    return { readyState: s.rs, pendingRequests, contentType: s.ct };
  }

  /**
   * The bytes of the document this tab shows (a PDF in Chrome's viewer has no text in the DOM),
   * fetched again from inside the page so its cookies apply. Capped at `maxBytes`.
   */
  async documentBytes(maxBytes = 25_000_000): Promise<Buffer> {
    const b64 = await this.main.evaluate<string>(
      `(async () => {
        const r = await fetch(location.href, { credentials: "include" });
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > ${maxBytes}) throw new Error("document too large: " + buf.length + " bytes");
        let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return btoa(s);
      })()`,
      { timeoutMs: 60_000 },
    );
    return Buffer.from(b64, "base64");
  }

  /**
   * Click an element that opens a file chooser (a styled "Upload" button) and hand the chooser
   * these files, by intercepting the dialog the browser would show.
   */
  async uploadViaChooser(frame: FrameSession, backendNodeId: number, files: string[], timeoutMs = 5_000): Promise<void> {
    this.assertUsable();
    const s = frame.session;
    // Chrome opens a file chooser only for the focused tab.
    await this.session.send("Page.bringToFront").catch(() => undefined);
    await s.send("Page.setInterceptFileChooserDialog", { enabled: true });
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ActionError("not_interactable", "The click did not open a file chooser. Target the file input itself, or the button that opens it."));
        }, timeoutMs);
        off = s.on("Page.fileChooserOpened", (e) => {
          if (e.backendNodeId === undefined) reject(new ActionError("not_interactable", "The page opened a file picker that is not tied to an input (showOpenFilePicker); it cannot be filled automatically."));
          else resolve(e.backendNodeId);
        });
      });
      // Keep a rejection handler on `opened` from the start: if the click below throws, the timer
      // would otherwise reject it with nothing attached and crash the process (unhandled rejection).
      void opened.catch(() => undefined);
      await this.click(frame, backendNodeId);
      // A click that lands while the page is still busy can be swallowed: one more after a pause.
      let got = false;
      void opened.then(() => (got = true), () => undefined);
      await Promise.race([opened.catch(() => undefined), sleep(Math.min(2_500, timeoutMs / 2))]);
      if (!got) await this.click(frame, backendNodeId).catch(() => undefined);
      const inputId = await opened;
      await s.send("DOM.setFileInputFiles", { backendNodeId: inputId, files });
    } finally {
      if (timer) clearTimeout(timer);
      off();
      await s.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
    }
  }

  async goBack(): Promise<boolean> {
    return this.historyStep(-1);
  }
  async goForward(): Promise<boolean> {
    return this.historyStep(1);
  }

  private async historyStep(delta: number): Promise<boolean> {
    this.assertUsable();
    const { currentIndex, entries } = await this.session.send("Page.getNavigationHistory");
    const entry = entries[currentIndex + delta];
    if (!entry) return false;
    const nav = this.session.waitFor("Page.frameNavigated", (e) => e.frame.id === this.main.frameId, 15_000).catch(() => undefined);
    await this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await nav;
    return true;
  }

  async reload(): Promise<void> {
    this.assertUsable();
    const load = this.waitForLifecycle("load", 30_000);
    load.catch(() => undefined);
    await this.session.send("Page.reload");
    await load;
  }

  async title(): Promise<string> {
    return this.main.evaluate<string>("document.title").catch(() => "");
  }

  // ------------------------------------------------------------------- settle

  /**
   * Composite "page settled" wait. Returns which conditions were met so the
   * caller can report honest evidence ("network still busy") instead of guessing.
   */
  async settle(opts: SettleOptions = {}): Promise<SettleResult> {
    const start = Date.now();
    if (opts.fast) {
      const r = await this.settleFast(opts, start);
      const socketMs = await this.awaitSocketReplies(opts.since ?? start);
      return socketMs ? { ...r, socketMs, elapsedMs: Date.now() - start } : r;
    }
    const {
      minWaitMs = 100,
      mutationQuietMs = 300,
      mutationTimeoutMs = 2_000,
      networkQuietMs = 500,
      networkTimeoutMs = 3_000,
      maxPending = 0,
    } = opts;
    await sleep(minWaitMs);
    let mutationsQuiet = false;
    try {
      mutationsQuiet = await this.main.evaluate<boolean>(mutationQuietScript(mutationQuietMs, mutationTimeoutMs), { timeoutMs: mutationTimeoutMs + 2_000 });
    } catch {
      // Navigation mid-wait or a detached context: treat as "unknown", move on.
      mutationsQuiet = false;
    }
    const networkIdle = await waitForNetworkIdle(
      this.frames().map((f) => f.network),
      { quietMs: networkQuietMs, timeoutMs: networkTimeoutMs, maxPending },
    );
    return { mutationsQuiet, networkIdle, elapsedMs: Date.now() - start };
  }


  /** Write requests (first-party, non-telemetry) caused since `since`, across all frames. */
  writesSince(since: number): WriteRequest[] {
    const host = safeHost(this.url);
    return this.frames().flatMap((f) => f.network.writesSince(since, host));
  }

  /**
   * Adaptive settle: watch a short window (150 ms, 450 ms for debounced inputs) for the action to
   * start something: a request, a navigation, or a DOM change after the action returned. Nothing
   * started: done (what changed at once is already in the DOM). DOM changes only: wait for them to
   * stop. Requests: wait for the ones this action caused (writes get their server answer), then a
   * short render window. Fixed quiet windows used to cost every no-op step ~160 ms.
   */
  private async settleFast(opts: SettleOptions, start: number): Promise<SettleResult> {
    const since = opts.since ?? start;
    const host = () => safeHost(this.url);
    const noise = (url: string) => isNoiseRequest(url, host());
    const frames = () => this.frames().map((f) => f.network);
    const busy = () => frames().reduce((n, t) => n + t.requestsSince(since, noise), 0) > 0 || this.lastNavigationAt >= since;
    let mutationsQuiet = true;
    let networkIdle = true;
    if (!busy()) {
      const windowMs = Math.max(0, (opts.expectAsync ? 450 : 150) - (Date.now() - since));
      let mutated = false;
      const probe = this.main
        .evaluate<boolean>(firstMutationScript(windowMs), { timeoutMs: windowMs + 1_500 })
        .then((m) => (mutated = m))
        .catch(() => false);
      let probing = true;
      void probe.finally(() => (probing = false));
      while (probing && !busy()) await sleep(15);
      if (!busy()) {
        if (!mutated) return { mutationsQuiet, networkIdle, elapsedMs: Date.now() - start, writes: [] };
        // Rendering without requests (a menu, a toggle, a client-side filter): let it finish.
        mutationsQuiet = await this.main.evaluate<boolean>(mutationQuietScript(100, opts.expectAsync ? 1_500 : 600), { timeoutMs: 2_500 }).catch(() => false);
        if (!busy()) return { mutationsQuiet, networkIdle, elapsedMs: Date.now() - start, writes: [] };
      }
    }
    // Something happened: wait for the write(s) this action caused to get their server response.
    let writes = this.writesSince(since);
    const writeDeadline = Date.now() + (opts.contentReady ? 0 : 6_000);
    while (writes.some((w) => !w.endedAt && !w.failed) && Date.now() < writeDeadline) {
      await sleep(40);
      writes = this.writesSince(since);
    }
    // A navigation: wait for the new document to have content (not just DOMContentLoaded).
    if (this.lastNavigationAt >= since && !opts.contentReady) await this.waitForContent(4_000);
    // The requests this action started, then a short render window. Other traffic (polling, ads,
    // analytics) is not waited for: on busy pages a whole-page quiet window ran to its cap.
    const cap = opts.contentReady ? 700 : 1_500;
    const deadline = Date.now() + cap;
    const caused = () => frames().reduce((n, t) => n + t.pendingSince(since, noise), 0);
    while (caused() > 0 && Date.now() < deadline) await sleep(25);
    networkIdle = caused() === 0;
    mutationsQuiet = await this.main.evaluate<boolean>(mutationQuietScript(100, Math.max(200, deadline - Date.now())), { timeoutMs: cap + 1_500 }).catch(() => false);
    writes = this.writesSince(since);
    const summary: WriteSummary[] = writes.map((w) => ({
      method: w.method,
      url: w.url,
      status: w.status,
      failed: w.failed,
      ms: w.endedAt ? w.endedAt - since : undefined,
      ok: !w.failed && w.status !== undefined && w.status >= 200 && w.status < 400,
    }));
    return { mutationsQuiet, networkIdle, elapsedMs: Date.now() - start, writes: summary };
  }

  /**
   * Wait until the document shows real content: some text and interactive elements, with the
   * amount of text no longer growing. Single-page apps render after DOMContentLoaded, and the
   * load event can be seconds later (or never) on ad-heavy pages. Resolves true when ready.
   */
  async waitForContent(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let prev = -1;
    let stable = 0;
    const noise = (url: string) => isNoiseRequest(url, safeHost(this.url));
    while (Date.now() < deadline) {
      const m = await this.main
        .evaluate<{ len: number; n: number; rs: string; ct: string }>(
          `(() => ({ len: document.body ? document.body.innerText.length : 0, n: document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link]').length, rs: document.readyState, ct: document.contentType }))()`,
          { timeoutMs: 1_500 },
        )
        .catch(() => null);
      // Single-page apps render results from XHR/fetch after DOMContentLoaded (Airbnb: 1 card at 2.3 s,
      // 18 at 3.3 s): text that stopped growing is not ready while first-party data is still in flight.
      // A request held open for seconds (session checks, bot sensors) is not data on its way to the page.
      const dataPending = this.main.network.pendingData(Date.now(), noise, 3_000) > 0;
      // A PDF (Chrome's viewer) or other non-HTML document has no body text to wait for.
      if (m && m.ct && m.ct !== "text/html" && m.ct !== "application/xhtml+xml" && m.rs !== "loading") return true;
      // A fully loaded document is ready even without controls (JSON responses, confirmation pages).
      if (m && m.rs === "complete" && (m.len > 0 || m.n > 0) && !dataPending) return true;
      if (m && m.len > 150 && m.n >= 3) {
        stable = prev >= 0 && Math.abs(m.len - prev) <= Math.max(50, prev * 0.03) ? stable + 1 : 0;
        // Text and controls unchanged for about a second: ready, whatever is still in flight.
        if ((stable >= 2 && !dataPending) || stable >= 6) return true;
        prev = m.len;
      }
      await sleep(150);
    }
    return false;
  }

  // ------------------------------------------------------------------- input

  /** Resolve the frame session a backendNodeId belongs to. Callers normally know it; this is the fallback. */
  frameForSession(session: CDPSession): FrameSession {
    for (const f of this.main.walk()) if (f.session === session) return f;
    throw new ActionError("frame_detached", "Frame session is no longer attached");
  }

  /**
   * Scroll the element into view, compute its center in page coordinates and
   * verify that point actually hits the element (or a descendant/ancestor).
   */
  async locate(frame: FrameSession, backendNodeId: number): Promise<{ point: Point; rect: Rect }> {
    this.assertUsable();
    if (this.openDialog) throw new ActionError("dialog_open", `A ${this.openDialog.type} dialog is open: ${this.openDialog.message}`);
    // A driver may wheel a target below the fold toward the viewport; the jump below then only finishes the job.
    if (this.driver?.wheelIntoView && frame === this.main) {
      const wheeling = Date.now();
      await this.wheelToward(frame, backendNodeId).catch(() => undefined);
      this.spent("wheel", wheeling);
    }
    try {
      await frame.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch (e) {
      // "Node is detached from document": the page drew it again since it was resolved (the same as gone).
      if (e instanceof CDPError && /Could not find node|No node with given id|not found|detached from document/i.test(e.message)) {
        throw new ActionError("stale", `Element no longer exists in the page (backendNodeId ${backendNodeId})`);
      }
      if (e instanceof CDPError && /Node does not have a layout object|not visible/i.test(e.message)) {
        throw new ActionError("not_visible", "Element has no layout box (display:none or detached)");
      }
      throw e;
    }
    try {
      return await this.measureAndHitTest(frame, backendNodeId);
    } catch (e) {
      if (!(e instanceof ActionError && e.code === "obscured")) throw e;
      // scrollIntoViewIfNeeded can leave the element under a sticky header or a floating bar at the
      // viewport edge: centre it and test again once before calling it covered.
      await frame
        .callOnNode(backendNodeId, "function(){ this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }")
        .catch(() => undefined);
      await sleep(60);
      return await this.measureAndHitTest(frame, backendNodeId);
    }
  }

  /**
   * Wheel the page until a main-frame element that is wholly out of view comes into it: up to four flicks of at
   * most 1,500 px, each as the input driver sends a wheel, from a spot over plain page content (`plainSpot`), and
   * stopping when the page no longer moves. Not for an element in a panel that scrolls on its own, or fixed or
   * sticky (wheeling the page cannot bring those, and could carry the panel away): the jump that follows does it.
   */
  private async wheelToward(frame: FrameSession, backendNodeId: number): Promise<void> {
    const d = this.driver;
    if (!d) return;
    const { height: vh } = this.browser.viewport;
    // At most WHEEL_BUDGET_MS of wheeling: on a heavy page each notch waits on a busy renderer, and one click spent
    // 27 s getting its target into view on a large retail results page. The jump that follows finishes the job.
    const until = Date.now() + WHEEL_BUDGET_MS;
    let before: number | null = null;
    for (let i = 0; i < 4 && Date.now() < until; i++) {
      const q = await frame.contentQuad(backendNodeId);
      if (!q) return;
      if (q.y + q.height > 0 && q.y < vh) return;
      if (i === 0 && (await frame.callOnNode<boolean>(backendNodeId, OWN_PLACE, [], { isolated: true }).catch(() => true))) return;
      const middle = q.y + q.height / 2;
      if (before !== null && Math.abs(middle - before) < 1) return;
      before = middle;
      const spot = await this.plainSpot({ x: q.x + q.width / 2, y: vh / 2 });
      if (!spot || Date.now() >= until) return;
      await this.wheel(d, Math.max(-1_500, Math.min(1_500, middle - vh * d.wheelLand())), 0, spot, until);
      // Smooth scrolling lands over a few frames.
      if (Date.now() < until) await sleep(d.pause("scroll-follow"));
    }
  }

  /**
   * A viewport point a wheel can go over without doing anything but scroll the page: plain content, not a form
   * control (a number input steps its value), editable text, an iframe, a canvas or video, a map, a slider or
   * listbox, or a box that scrolls on its own. The pointer where it rests first, then `prefer`, then points
   * near the middle; null when none is plain. Hit tests only; the check runs in the isolated world.
   */
  async plainSpot(prefer?: Point): Promise<Point | null> {
    const { width: vw, height: vh } = this.browser.viewport;
    const inside = (p: Point) => p.x > 0 && p.y > 0 && p.x < vw - 1 && p.y < vh - 1;
    const tries = [this.cursor, ...(prefer ? [prefer] : []), ...[[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5]].map(([x, y]) => ({ x: Math.round(vw * x!), y: Math.round(vh * y!) }))];
    for (const p of tries.filter(inside)) {
      const hit = await this.nodeAt(p);
      if (!hit || hit.frame !== this.main) continue;
      if (await this.main.callOnNode<boolean>(hit.backendNodeId, PLAIN_SPOT, [], { isolated: true }).catch(() => false)) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  }

  private async measureAndHitTest(frame: FrameSession, backendNodeId: number): Promise<{ point: Point; rect: Rect }> {
    const quad = await frame.contentQuad(backendNodeId);
    if (!quad || quad.width === 0 || quad.height === 0) {
      throw new ActionError("not_visible", "Element has a zero-size box or is not rendered");
    }
    const offset = await frame.offsetInPage();
    const rect: Rect = { x: quad.x + offset.x, y: quad.y + offset.y, width: quad.width, height: quad.height };
    // Clamp the click point inside the viewport in case the element is partially off-screen.
    const { width: vw, height: vh } = this.browser.viewport;
    const point: Point = {
      x: Math.min(Math.max(rect.x + rect.width / 2, 1), vw - 1),
      y: Math.min(Math.max(rect.y + rect.height / 2, 1), vh - 1),
    };
    // Hit test at the click point. DOM.getNodeForLocation takes coordinates in the document of the
    // session's frame (viewport + scroll): the main document for the main frame and its in-process
    // iframes, the iframe's own document for an out-of-process one.
    const viaMain = frame.session === this.session;
    const at = await this.toDocument(frame.session, viaMain ? point : { x: point.x - offset.x, y: point.y - offset.y });
    let hit: Protocol.DOM.GetNodeForLocationResponse | null = null;
    try {
      hit = await frame.session.send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    } catch {
      hit = null; // e.g. point lands in another OOPIF; let the click go through
    }
    if (hit && hit.backendNodeId !== backendNodeId) {
      const related = await this.nodesRelated(frame, backendNodeId, hit.backendNodeId);
      if (!related) {
        const desc = await frame.session.send("DOM.describeNode", { backendNodeId: hit.backendNodeId }).catch(() => null);
        throw new ActionError("obscured", `Click point is covered by another element: <${desc?.node.localName ?? "unknown"}${describeAttrs(desc?.node.attributes)}>`, {
          obscuredBy: desc?.node.localName,
          obscuredByBackendNodeId: hit.backendNodeId,
        });
      }
    }
    return { point, rect };
  }

  /** A viewport point of the session's frame in that frame's document coordinates (CSS px, scroll added). */
  private async toDocument(session: CDPSession, p: Point): Promise<Point> {
    const m = await session.send("Page.getLayoutMetrics").catch(() => null);
    const v = m?.cssLayoutViewport;
    return v ? { x: p.x + v.pageX, y: p.y + v.pageY } : p;
  }

  private async nodesRelated(frame: FrameSession, a: number, b: number): Promise<boolean> {
    try {
      const [ra, rb] = await Promise.all([
        frame.session.send("DOM.resolveNode", { backendNodeId: a }),
        frame.session.send("DOM.resolveNode", { backendNodeId: b }),
      ]);
      if (!ra.object.objectId || !rb.object.objectId) return true;
      const res = await frame.session.send("Runtime.callFunctionOn", {
        objectId: ra.object.objectId,
        functionDeclaration:
          // Related = same node, ancestor/descendant, a <label> for the target, or the target's own
          // visible label inside the same small widget (aria-labelledby, or an aria-hidden copy of its
          // text, as on Amazon's buttons). A sibling overlay with no such link still counts as covering.
          // A pseudo-element (::before/::after) resolves to a CSSPseudoElement, not a node: the click goes to
          // the element it belongs to (.element). It is related when that element is the target, inside it, or a
          // label for it (a custom checkbox's box drawn by its label); an ancestor's (a wrapper's overlay, a
          // modal backdrop on body) takes the click from the target and still covers it. Without this every
          // pseudo-element counted as covering: 35 of 55 "obscured" clicks in a sample of recorded runs.
          "function(hit){ if (hit && typeof hit.contains !== 'function' && hit.element && hit.element.nodeType === 1) {" +
          "   var own = hit.element; if (this===own || this.contains(own)) return true;" +
          "   var l = own.closest && own.closest('label'); return !!(l && l.control === this); }" +
          " if (this===hit || this.contains(hit) || hit.contains(this)) return true;" +
          " var lab = hit.closest && hit.closest('label'); if (lab && lab.control === this) return true;" +
          " var a = this.parentElement, d = 0; while (a && d < 3 && !a.contains(hit)) { a = a.parentElement; d++; }" +
          " if (!a || !a.contains(hit) || a === document.body || a === document.documentElement) return false;" +
          " var r1 = this.getBoundingClientRect(), r2 = a.getBoundingClientRect();" +
          " if (r2.width * r2.height > Math.max(1, r1.width * r1.height) * 4) return false;" +
          " var ids = (this.getAttribute('aria-labelledby') || '').split(' ').filter(Boolean);" +
          " var own = ((this.getAttribute('aria-label') || this.value || this.title || this.textContent || '') + '').trim().toLowerCase();" +
          " for (var n = hit; n && n !== a; n = n.parentElement) {" +
          "   if (n.id && ids.indexOf(n.id) >= 0) return true;" +
          "   if (n.getAttribute && n.getAttribute('aria-hidden') === 'true' && own && (n.textContent || '').trim().toLowerCase() === own) return true;" +
          " } return false; }",
        arguments: [{ objectId: rb.object.objectId }],
        returnByValue: true,
      });
      void frame.session.send("Runtime.releaseObject", { objectId: ra.object.objectId }).catch(() => undefined);
      void frame.session.send("Runtime.releaseObject", { objectId: rb.object.objectId }).catch(() => undefined);
      return res.result.value === true;
    } catch {
      return true;
    }
  }

  /** The element painted at a viewport point (no page JS), or null. */
  async nodeAt(point: Point): Promise<{ frame: FrameSession; backendNodeId: number } | null> {
    try {
      const at = await this.toDocument(this.session, point);
      const r = await this.session.send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
      return { frame: r.frameId ? (this.frameById(r.frameId) ?? this.main) : this.main, backendNodeId: r.backendNodeId };
    } catch {
      return null;
    }
  }

  /**
   * Drag with the mouse from one viewport point to another. Small steps pass pointer-based
   * libraries' activation distance (dnd-kit, Sortable). Native HTML5 drag-and-drop does not start
   * from synthetic mouse moves, so drags are intercepted and replayed as drag events (as Playwright does).
   */
  async drag(from: Point, to: Point, steps = 12): Promise<void> {
    this.assertUsable();
    const s = this.session;
    let data: Protocol.Input.DragData | null = null;
    let entered = false;
    await s.send("Input.setInterceptDrags", { enabled: true });
    const off = s.on("Input.dragIntercepted", (e) => {
      data = e.data;
    });
    try {
      await this.moveTo(from);
      const d = this.driver;
      if (d) await sleep(d.pause("dwell"));
      await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
      // With a driver the drag follows its path and pauses; plain, it is a straight line of `steps` moves.
      if (d) await sleep(d.pause("grip"));
      const path = d
        ? d.path(from, to, { targetWidth: 12, drag: true })
        : Array.from({ length: steps }, (_, k) => ({ x: from.x + ((to.x - from.x) * (k + 1)) / steps, y: from.y + ((to.y - from.y) * (k + 1)) / steps, delayMs: 16 }));
      const flow = this.flow();
      const start = Date.now();
      let due = 0;
      for (const { x, y, delayMs } of path) {
        if (data) {
          await flow.settle();
          await s.send("Input.dispatchDragEvent", { type: entered ? "dragOver" : "dragEnter", x, y, data });
          entered = true;
        } else {
          flow.mouse({ type: "mouseMoved", x, y, button: "left", buttons: 1, force: 0.5 }, start + due);
        }
        // On the path's own clock, as moveTo (an HTML5 drag only paces with a driver).
        if (data && !d) continue;
        due += delayMs;
        const wait = due - (Date.now() - start);
        if (delayMs && wait >= 1) await sleep(wait);
      }
      await flow.settle();
      if (d) await sleep(d.pause("release"));
      if (data) await s.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
      this.cursor = { x: to.x, y: to.y };
    } finally {
      off();
      await s.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
  }

  /**
   * While nothing else drives the pointer (the model thinking): the input driver's idle movement, until `signal`
   * aborts. Plain input (no driver, or `humanize` off) returns at once.
   */
  async idle(signal: AbortSignal): Promise<void> {
    const d = this.driver;
    if (!d?.idle) return;
    await d.idle(signal);
  }

  async mouseMove(point: Point, { targetWidth }: { targetWidth?: number } = {}): Promise<void> {
    await this.moveTo(point, { targetWidth });
  }

  /** Move the pointer to `to`: one jump, or the input driver's path for a target `targetWidth` wide. */
  private async moveTo(to: Point, { modifiers = 0, targetWidth }: { modifiers?: number; targetWidth?: number } = {}): Promise<void> {
    const d = this.driver;
    const path = d ? d.path(this.cursor, to, { targetWidth, viewport: this.browser.viewport }) : [{ x: to.x, y: to.y, delayMs: 0 }];
    // On the path's own clock (`flow`): each point goes when its time comes, so the time a send takes and a coarse
    // timer (Windows rounds a sleep up to about 15 ms) neither stretch the movement nor bunch its points.
    const flow = this.flow();
    const start = Date.now();
    let due = 0;
    for (const p of path) {
      flow.mouse({ type: "mouseMoved", x: p.x, y: p.y, modifiers }, start + due);
      this.cursor = { x: p.x, y: p.y };
      due += p.delayMs;
      const wait = due - (Date.now() - start);
      if (p.delayMs && wait >= 1) await sleep(wait);
    }
    await flow.settle();
  }

  /**
   * Click at a viewport point. The press carries the pressed button in `buttons` and pressure 0.5 (a press
   * reporting no button down, or none of a mouse's pressure, is a synthetic-input tell) and is held 40-90 ms,
   * or as long as the input driver says, after its dwell on the target.
   */
  async clickAt(point: Point, { button = "left", clickCount = 1, modifiers = 0, targetWidth, settled = false }: { button?: Protocol.Input.MouseButton; clickCount?: number; modifiers?: number; targetWidth?: number; settled?: boolean } = {}): Promise<void> {
    this.assertUsable();
    // `settled`: the pointer is on the point and has dwelt there already (click() re-aims first).
    const d = this.driver;
    if (!settled) {
      await this.moveTo(point, { modifiers, targetWidth });
      if (d) await sleep(d.pause("dwell"));
    }
    const at = this.cursor;
    // The hold is the hand's, not the time a busy page takes to acknowledge the press (`flow`).
    const flow = this.flow();
    for (let i = 1; i <= clickCount; i++) {
      const down = Date.now();
      // A mouse button down reads pressure 0.5 (CDP's default force of 0 would read as no press at all).
      flow.mouse({ type: "mousePressed", x: at.x, y: at.y, button, buttons: BUTTON_MASK[button] ?? 0, clickCount: i, modifiers, force: 0.5 }, down);
      const hold = d ? d.pressMs() : between(40, 90);
      await sleep(hold);
      flow.mouse({ type: "mouseReleased", x: at.x, y: at.y, button, buttons: 0, clickCount: i, modifiers }, Math.max(Date.now(), down + hold));
      if (d && i < clickCount) await sleep(d.pause("between-clicks"));
    }
    await flow.settle();
  }

  async click(frame: FrameSession, backendNodeId: number, opts: { button?: Protocol.Input.MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<{ point: Point; rect: Rect }> {
    let t = Date.now();
    const wheeled = this.inputPhases.wheel ?? 0;
    let loc: { point: Point; rect: Rect };
    try {
      loc = await this.locate(frame, backendNodeId);
    } finally {
      // The wheel's time inside locate is its own phase.
      t = this.spent("locate", t + ((this.inputPhases.wheel ?? 0) - wheeled));
    }
    const targetWidth = Math.min(loc.rect.width, loc.rect.height);
    const d = this.driver;
    if (!d) {
      await this.clickAt(loc.point, { ...opts, targetWidth });
      this.spent("press", t);
      return loc;
    }
    // With a driver: its point in the hit-tested box, its approach and its dwell.
    let point = d.aim(loc.point, loc.rect);
    await this.moveTo(point, { modifiers: opts.modifiers, targetWidth });
    t = this.spent("approach", t);
    await sleep(d.pause("dwell"));
    t = this.spent("dwell", t);
    // The approach and the dwell can take a second or more: a layout shift meanwhile (a lazy image, an ad
    // slot) moves the target. Look again before pressing; a cover that arrived meanwhile is reported, not clicked.
    let now: { point: Point; rect: Rect } | null;
    try {
      now = await this.measureAndHitTest(frame, backendNodeId).catch((e: unknown) => {
        if (e instanceof ActionError && e.code === "obscured") throw e;
        return null;
      });
      if (now && (Math.abs(now.rect.x - loc.rect.x) > 3 || Math.abs(now.rect.y - loc.rect.y) > 3)) {
        point = d.aim(now.point, now.rect);
        await this.moveTo(point, { modifiers: opts.modifiers, targetWidth });
        await sleep(d.pause("reaim"));
      }
    } finally {
      t = this.spent("reaim", t);
    }
    await this.clickAt(point, { ...opts, targetWidth, settled: true });
    this.spent("press", t);
    return now ?? loc;
  }

  async hover(frame: FrameSession, backendNodeId: number): Promise<Point> {
    const { point, rect } = await this.locate(frame, backendNodeId);
    await this.mouseMove(point, { targetWidth: Math.min(rect.width, rect.height) });
    return point;
  }

  async focus(frame: FrameSession, backendNodeId: number): Promise<void> {
    this.assertUsable();
    try {
      await frame.session.send("DOM.focus", { backendNodeId });
    } catch (e) {
      if (e instanceof CDPError && /not focusable/i.test(e.message)) {
        throw new ActionError("not_interactable", "Element is not focusable");
      }
      if (e instanceof CDPError && /Could not find node|not found/i.test(e.message)) {
        throw new ActionError("stale", `Element no longer exists in the page (backendNodeId ${backendNodeId})`);
      }
      throw e;
    }
  }

  /**
   * Type into an element. Default strategy: focus, select existing content,
   * then Input.insertText (fires input/beforeinput like an IME commit; fast,
   * works in inputs, textareas and contenteditable). `perKey` dispatches a
   * key event per character for widgets that listen to keydown (autocomplete,
   * masked inputs). With an input driver, text it paces (TypingPace) is typed key by key at its pace; a secret
   * (`secret`, or any password field) is always inserted in one go.
   */
  async type(frame: FrameSession, backendNodeId: number, text: string, { clear = true, perKey = false, submit = false, secret = false }: { clear?: boolean; perKey?: boolean; submit?: boolean; secret?: boolean } = {}): Promise<void> {
    // Date/time/color/range inputs ignore inserted text (their editors are
    // segmented widgets). Set the value through the native setter, which is
    // what frameworks observe, and fire input+change. Throws if the browser
    // rejects the value so the agent learns the expected format.
    const valueKind = await frame
      .callOnNode<string>(backendNodeId, "function(){ return this instanceof HTMLInputElement ? this.type : ''; }")
      .catch(() => "");
    if (["date", "time", "datetime-local", "month", "week", "color", "range"].includes(valueKind)) {
      const res = await frame.callOnNode<{ ok: boolean; value: string }>(
        backendNodeId,
        `function(v){
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          this.focus();
          setter.call(this, v);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: this.value !== '' || v === '', value: this.value };
        }`,
        [text],
      );
      if (!res.ok) {
        const formats: Record<string, string> = { date: "YYYY-MM-DD", time: "HH:MM (24h)", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", color: "#rrggbb", range: "a number within min/max" };
        throw new ActionError("not_interactable", `The ${valueKind} input rejected "${text}"; use the format ${formats[valueKind]}`);
      }
      if (submit) await this.press("Enter");
      return;
    }
    // Clicking first mimics a user and handles custom widgets that open on click; fall back to DOM.focus.
    try {
      await this.click(frame, backendNodeId);
    } catch (e) {
      if (!(e instanceof ActionError && (e.code === "obscured" || e.code === "not_visible"))) throw e;
      const focusing = Date.now();
      await this.focus(frame, backendNodeId);
      this.spent("locate", focusing);
    }
    let t = Date.now();
    if (clear) {
      await frame.callOnNode(
        backendNodeId,
        `function(){
          const el = this;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return; }
          if (el.isContentEditable) {
            const r = document.createRange(); r.selectNodeContents(el);
            const s = el.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r);
          }
        }`,
      ).catch(() => undefined);
      // If selection is non-empty, a Backspace clears it even when insertText wouldn't replace.
      const d = this.driver;
      if (d) await sleep(d.pause("keys"));
      await this.press("Backspace");
      t = this.spent("clear", t);
    }
    const driver = this.driver;
    const paced = driver && !secret && valueKind !== "password" ? driver.typing(text) : null;
    if (driver && paced) {
      // On the typist's clock (`flow`), not each key's acknowledgement.
      const flow = this.flow();
      const shift = { down: () => driver.pause("shift-down"), up: () => driver.pause("shift-up") };
      let untilPause = paced.breakEvery();
      for (const ch of text) {
        await this.typeChar(ch, paced.holdMs(), flow, shift);
        await sleep(paced.gapMs());
        if (--untilPause === 0) {
          await sleep(paced.breakMs());
          untilPause = paced.breakEvery();
        }
      }
      await flow.settle();
    } else if (perKey) {
      for (const ch of text) await this.typeChar(ch);
    } else if (text.length) {
      await this.session.send("Input.insertText", { text });
      // insertText fires `input` but no key events. Widgets that sync on keyup (jQuery date pickers
      // on Selenium's form) keep their own empty state and wipe the field on blur. A bare Shift
      // press delivers keydown/keyup without moving the caret or picking a dropdown option.
      await this.press("Shift");
    }
    if (submit) await this.press("Enter");
    this.spent("keys", t);
  }

  /**
   * One character as a real key press (keydown carrying the text, then keyup). Never parsed as a
   * shortcut, so " " and "+" type themselves; newlines press Enter; characters without a key
   * (emoji, tabs) are inserted.
   */
  private async typeChar(ch: string, holdMs = 0, into?: InputFlow, shiftPause?: { down(): number; up(): number }): Promise<void> {
    const flow = into ?? this.flow();
    if (ch === "\n" || ch === "\r") {
      await flow.settle();
      return this.press("Enter", { delayMs: holdMs });
    }
    let k: KeyDescriptor;
    try {
      if (ch === "\t" || ch.length !== 1) throw new Error("no key");
      k = describeKey(ch);
    } catch {
      // Inserted text goes after the keys before it.
      await flow.settle();
      await this.session.send("Input.insertText", { text: ch });
      return;
    }
    const text = k.text ?? ch;
    // A capital or a shifted symbol is typed with Shift held, as on a US keyboard.
    const modifiers = k.shift ? 8 : 0;
    const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 };
    if (k.shift) {
      flow.key({ type: "rawKeyDown", ...shift, modifiers }, Date.now());
      if (holdMs && shiftPause) await sleep(shiftPause.down());
    }
    const down = Date.now();
    flow.key({ type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, text, unmodifiedText: text, modifiers }, down);
    if (holdMs) await sleep(holdMs);
    flow.key({ type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers }, Math.max(Date.now(), down + holdMs));
    if (k.shift) {
      if (holdMs && shiftPause) await sleep(shiftPause.up());
      flow.key({ type: "keyUp", ...shift, modifiers: 0 }, Date.now());
    }
    if (!into) await flow.settle();
  }

  /** Press a key or shortcut like "Enter", "Control+a", "Shift+Tab". */
  async press(shortcut: string, { delayMs = 0 } = {}): Promise<void> {
    this.assertUsable();
    const { modifiers, modifierKeys, key } = parseShortcut(shortcut);
    for (const m of modifierKeys) {
      await this.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, location: m.location });
    }
    // Text is suppressed for shortcuts with Control/Meta (matches browser behaviour).
    const text = modifiers & 6 ? undefined : key.text;
    await this.session.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      text,
      unmodifiedText: text,
      modifiers,
      location: key.location,
      commands: commandsFor(shortcut),
    });
    // A key is held for a moment, never released in the same instant.
    const hold = delayMs || (this.driver?.keyHoldMs() ?? 0);
    if (hold) await sleep(hold);
    await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers, location: key.location });
    for (const m of [...modifierKeys].reverse()) {
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, location: m.location });
    }
  }

  /**
   * Scroll by wheel at a point (default viewport center) or over an element. With an input driver the distance goes
   * as its wheel events, where the pointer already is unless a point is given.
   */
  async scroll(deltaY: number, deltaX = 0, at?: Point): Promise<void> {
    this.assertUsable();
    const p = at ?? { x: this.browser.viewport.width / 2, y: this.browser.viewport.height / 2 };
    const d = this.driver;
    if (!d) {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX, deltaY });
      return;
    }
    // Where the pointer already is, unless that is over something a wheel would act on (a number field it steps, a
    // map it zooms, a panel that scrolls on its own): then over plain content.
    await this.wheel(d, deltaY, deltaX, at ?? (await this.plainSpot()) ?? p);
  }

  /** The driver's wheel events for a distance, after moving to `spot`, until `until`. */
  private async wheel(d: InputDriver, deltaY: number, deltaX: number, spot: Point, until = Infinity): Promise<void> {
    if (Date.now() >= until) return;
    if (Math.hypot(spot.x - this.cursor.x, spot.y - this.cursor.y) >= 2) await this.moveTo(spot, { targetWidth: 200 });
    const ys = d.wheel(deltaY);
    const xs = d.wheel(deltaX);
    const flow = this.flow();
    for (let i = 0; i < Math.max(ys.length, xs.length) && Date.now() < until; i++) {
      flow.mouse({ type: "mouseWheel", x: this.cursor.x, y: this.cursor.y, deltaX: xs[i] ?? 0, deltaY: ys[i] ?? 0 }, Date.now());
      await sleep(d.wheelGapMs());
    }
    await flow.settle();
  }

  /** Select <option>(s) by value or label; dispatches input+change. Returns the selected values. */
  async selectOption(frame: FrameSession, backendNodeId: number, values: string[]): Promise<string[]> {
    this.assertUsable();
    const selected = await frame.callOnNode<string[] | { error: string }>(
      backendNodeId,
      `function(values){
        const el = this;
        if (!(el instanceof HTMLSelectElement)) return { error: 'Element is a <' + el.localName + '>, not a <select>' };
        const wanted = new Set(values);
        const picked = [];
        for (const o of el.options) {
          const match = wanted.has(o.value) || wanted.has(o.label) || wanted.has(o.textContent.trim());
          o.selected = match;
          if (match) picked.push(o.value);
          if (match && !el.multiple) break;
        }
        if (!picked.length) return { error: 'No option matched ' + JSON.stringify(values) + '. Options: ' + [...el.options].slice(0,30).map(o => o.label || o.value).join(' | ') };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return picked;
      }`,
      [values],
    );
    if (!Array.isArray(selected)) throw new ActionError("not_interactable", selected.error);
    return selected;
  }

  /** Set files on an <input type=file>. Paths must be readable by the browser process. */
  async setFiles(frame: FrameSession, backendNodeId: number, files: string[]): Promise<void> {
    this.assertUsable();
    await frame.session.send("DOM.setFileInputFiles", { backendNodeId, files });
  }

  // --------------------------------------------------------------- screenshots

  async screenshot({ format = "png", quality, clip, fullPage = false }: { format?: "png" | "jpeg" | "webp"; quality?: number; clip?: Rect; fullPage?: boolean } = {}): Promise<Buffer> {
    this.assertUsable();
    const params: Protocol.Page.CaptureScreenshotRequest = { format, quality: format === "png" ? undefined : quality, captureBeyondViewport: fullPage, optimizeForSpeed: true };
    // Images are in CSS pixels whatever the screen's pixel ratio, so a point read off a screenshot
    // is a point Input.dispatchMouseEvent understands (and a 1.5x display does not cost 2.25x tokens).
    const dpr = await this.main.evaluate<number>("devicePixelRatio", { timeoutMs: 2_000 }).catch(() => 1);
    const scale = dpr > 0 ? 1 / dpr : 1;
    if (clip) params.clip = { ...clip, scale };
    else if (!fullPage && Math.abs(scale - 1) > 0.01) {
      const m = await this.session.send("Page.getLayoutMetrics");
      const v = m.cssVisualViewport;
      params.clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale };
    }
    else if (fullPage) {
      const m = await this.session.send("Page.getLayoutMetrics");
      const h = Math.min(m.cssContentSize.height, 16_000); // > ~16k px crashes some builds
      params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: h, scale: 1 };
    }
    const { data } = await this.session.send("Page.captureScreenshot", params, { timeoutMs: 20_000 });
    return Buffer.from(data, "base64");
  }

  async layoutMetrics(): Promise<{ viewport: Rect; content: { width: number; height: number }; scroll: Point }> {
    const m = await this.session.send("Page.getLayoutMetrics");
    return {
      viewport: { x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY, width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight },
      content: { width: m.cssContentSize.width, height: m.cssContentSize.height },
      scroll: { x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY },
    };
  }

  // --------------------------------------------------------------- lifecycle

  async bringToFront(): Promise<void> {
    await this.session.send("Page.bringToFront").catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closedReason) return;
    await this.browser.root.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
    this._markClosed("closed by client");
  }
}

// ------------------------------------------------------------------ helpers

function quadArea(q: number[]): number {
  // Shoelace formula on 4 points.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = q[i * 2]!, y1 = q[i * 2 + 1]!;
    const x2 = q[((i + 1) % 4) * 2]!, y2 = q[((i + 1) % 4) * 2 + 1]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function describeAttrs(attrs: string[] | undefined): string {
  if (!attrs) return "";
  const out: string[] = [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const k = attrs[i]!;
    if (k === "id" || k === "class" || k === "role" || k === "aria-label") out.push(` ${k}="${attrs[i + 1]!.slice(0, 40)}"`);
  }
  return out.join("");
}

function evalError(d: Protocol.Runtime.ExceptionDetails): Error {
  const text = d.exception?.description ?? d.exception?.value ?? d.text;
  return new Error(`Page script threw: ${String(text).split("\n")[0]}`);
}

function commandsFor(shortcut: string): string[] | undefined {
  // Editing commands Chrome expects for common shortcuts so they work in all fields on all platforms.
  const s = shortcut.toLowerCase().replace("mod", process.platform === "darwin" ? "meta" : "control");
  const table: Record<string, string[]> = {
    "control+a": ["SelectAll"],
    "meta+a": ["SelectAll"],
    "control+c": ["Copy"],
    "meta+c": ["Copy"],
    "control+v": ["Paste"],
    "meta+v": ["Paste"],
    "control+x": ["Cut"],
    "meta+x": ["Cut"],
    "control+z": ["Undo"],
    "meta+z": ["Undo"],
  };
  return table[s];
}

/** Resolves true at the first DOM mutation, false if none happens within windowMs. */
function firstMutationScript(windowMs: number): string {
  return `new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { obs.disconnect(); } catch {} resolve(v); };
    const obs = new MutationObserver(() => finish(true));
    try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch { return finish(false); }
    setTimeout(() => finish(false), ${windowMs});
  })`;
}

function mutationQuietScript(quietMs: number, timeoutMs: number): string {
  // Resolves true when no DOM mutations for quietMs; false if timeoutMs elapses first.
  return `new Promise((resolve) => {
    const start = Date.now();
    let timer = null;
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { obs.disconnect(); } catch {} resolve(v); };
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(true), ${quietMs}); };
    const obs = new MutationObserver(() => {
      if (Date.now() - start > ${timeoutMs}) return finish(false);
      arm();
    });
    try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch { return finish(true); }
    arm();
    setTimeout(() => finish(false), ${timeoutMs});
  })`;
}

/** Uniform in [min, max). */
function between(min: number, max: number, rng: () => number = Math.random): number {
  return min + (max - min) * rng();
}

/**
 * Whether wheeling the page cannot bring an element into view: it sits in a box that scrolls on its own, or it
 * (or a box it is in) is fixed or sticky. Read in the isolated world.
 */
const OWN_PLACE = `function(){
  const doc = this.ownerDocument;
  for (let el = this.nodeType === 1 ? this : this.parentElement; el && el !== doc.scrollingElement && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;
    if (el !== this && (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') && el.scrollHeight > el.clientHeight + 1) return true;
  }
  return false;
}`;

/** Whether a wheel over this node only scrolls the page (see Page.plainSpot). Read in the isolated world. */
const PLAIN_SPOT = `function(){
  const doc = this.ownerDocument;
  const maps = ['leaflet-container', 'mapboxgl-map', 'maplibregl-map', 'gm-style', 'ol-viewport', 'esri-view'];
  for (let el = this.nodeType === 1 ? this : this.parentElement; el; el = el.parentElement) {
    if (['input', 'textarea', 'select', 'iframe', 'frame', 'canvas', 'video', 'audio', 'embed', 'object'].includes(el.localName)) return false;
    if (el.isContentEditable) return false;
    const role = el.getAttribute('role');
    if (role === 'application' || role === 'slider' || role === 'listbox' || role === 'spinbutton' || el.getAttribute('aria-roledescription') === 'map') return false;
    if (maps.some((c) => el.classList.contains(c))) return false;
    if (el === doc.scrollingElement || el === doc.body || el === doc.documentElement) continue;
    const o = getComputedStyle(el).overflowY;
    if ((o === 'auto' || o === 'scroll' || o === 'overlay') && el.scrollHeight > el.clientHeight + 1) return false;
  }
  return true;
}`;

/** The longest a click spends wheeling its target into view before the jump finishes the job. */
const WHEEL_BUDGET_MS = 4_000;

/** Input events sent on their own clock (Page.flow). */
interface InputFlow {
  mouse(params: Omit<Protocol.Input.DispatchMouseEventRequest, "timestamp">, atMs: number): void;
  key(params: Omit<Protocol.Input.DispatchKeyEventRequest, "timestamp">, atMs: number): void;
  settle(): Promise<void>;
}

/** The parts of an input action whose time Page.inputPhases records. */
export type InputPhase = "locate" | "wheel" | "approach" | "dwell" | "reaim" | "press" | "clear" | "keys";

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
