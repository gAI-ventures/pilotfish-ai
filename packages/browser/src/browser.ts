// Browser: owns the root CDP session, the target table, browser contexts and
// download events. Pages are created from auto-attach events, never polled.

import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Connection, CDPSession, Protocol } from "@pilotfish/cdp";
import { Page, addWorkerInitializer, initWorkerSession } from "./page.js";
import type { LaunchOptions, LaunchedProcess } from "./launcher.js";
import { CHROME_SERVICE_HOSTS } from "./network.js";

/** Whether a page's traffic to a host takes a paid route (Browser.route; an extension's routing answers it). */
export interface RouteOracle {
  proxiedHost(host: string): boolean;
}

/** A per-context proxy's local forwarder, from an extension (Browser.contextProxy). */
export interface ContextProxy {
  /** Give this to Chrome: "http://127.0.0.1:<port>". */
  url: string;
  /** The context exists (called once Target.createBrowserContext answered). */
  attached?(): void;
  close(): Promise<void>;
}

/** The hand input is modelled on (Browser.inputProfile): a seed for its habits, and the OS whose wheel it scrolls like. */
export interface InputProfile {
  seed?: number;
  os?: "windows" | "macos";
}

/** Whether a proxy URL carries credentials (Chromium ignores them in --proxy-server: they need a local forwarder). */
export function proxyHasCredentials(proxy: string): boolean {
  try {
    const u = new URL(proxy);
    return !!(u.username || u.password);
  } catch {
    return false;
  }
}

export interface DownloadEvent {
  guid: string;
  url: string;
  suggestedFilename: string;
  frameId: string;
  state: "inProgress" | "completed" | "canceled";
  receivedBytes: number;
  totalBytes: number;
  /** When the download began (ms epoch). */
  startedAt: number;
  /** Where the file is saved (`<downloadsDir>/<guid>`), when the browser saves downloads. */
  path?: string;
}

export interface BrowserContextOptions {
  /** Per-context proxy ("http://host:port"). Lets one browser serve many sessions with different egress. */
  proxyServer?: string;
  proxyBypassList?: string;
}

export interface BrowserEvents {
  page: (page: Page) => void;
  pageClosed: (page: Page) => void;
  download: (download: DownloadEvent) => void;
  disconnected: (reason: string) => void;
}

export class Browser {
  private readonly pages = new Map<string, Page>(); // targetId -> Page
  // Every agent session on this browser listens for tabs; a server runs many of them.
  private readonly emitter = new EventEmitter().setMaxListeners(500);
  private readonly downloadsByGuid = new Map<string, DownloadEvent>();
  private closedReason: string | null = null;
  private cleanedUp = false;
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private readonly contextForwarders = new Map<string, ContextProxy>();
  /** Set by an extension (the hosted paid exit): a context proxy with credentials goes through the forwarder it starts. */
  contextProxy: ((proxyServer: string) => Promise<ContextProxy>) | null = null;
  /**
   * Set by an extension: whether a page's traffic to a host takes a paid route (the hosted paid exit). Undefined: none
   * does.
   */
  route?: RouteOracle;
  /** Set by an extension: the hand input is modelled on (a seed for its habits, the OS its scrolling follows). */
  inputProfile?: InputProfile;
  readonly viewport: { width: number; height: number };
  /**
   * Run on every frame session (each tab's main frame and every OOPIF) after its domains are
   * enabled and before its scripts start: the place to register init scripts, bindings and
   * request blocking that must be in effect for the very first byte of a document. Each sends what the
   * first document needs before it first awaits anything: a tab whose opener Chrome cut off (a noopener
   * popup) answers nothing until it is released, so there they all start at once, after the domains are
   * sent (not answered), and the tab is released once each has sent its first commands (Page.initFrameSession).
   */
  readonly sessionInitializers: Array<(frame: import("./page.js").FrameSession) => Promise<void>> = [];

  /** Initializers running on frames that were open when they were registered (initialized() waits for them). */
  private readonly initializing = new Set<Promise<void>>();

  /**
   * Register a session initializer; it also runs once on the frames that already exist, without the caller
   * waiting (see initialized). Returns an unsubscribe.
   */
  addSessionInitializer(init: (frame: import("./page.js").FrameSession) => Promise<void>): () => void {
    this.sessionInitializers.push(init);
    for (const p of this.pages.values())
      for (const f of p.frames()) {
        const run: Promise<void> = init(f)
          .catch(() => undefined)
          .finally(() => this.initializing.delete(run));
        this.initializing.add(run);
      }
    return () => {
      const i = this.sessionInitializers.indexOf(init);
      if (i >= 0) this.sessionInitializers.splice(i, 1);
    };
  }

  /**
   * Settles once the initializers registered while pages were open have run on those pages' frames. A tab
   * already open (the first one) gets them with no wait, so its next navigation can commit before they land:
   * await this before it, and the document has them (an extension's overrides and scripts, the routing).
   */
  async initialized(): Promise<void> {
    while (this.initializing.size) await Promise.all([...this.initializing]);
  }

  constructor(
    readonly connection: Connection,
    readonly launched: LaunchedProcess | null,
    readonly options: LaunchOptions,
  ) {
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    connection.onClose((reason) => {
      this.closedReason = reason;
      if (this.clockTimer) clearTimeout(this.clockTimer);
      for (const p of this.pages.values()) p._markClosed(reason);
      this.pages.clear();
      this.emitter.emit("disconnected", reason);
    });
    // The clock and language go to EVERY frame session, each tab and each out-of-process iframe, before its
    // document runs: an iframe from another site renders in a process of its own, which a tab's session never
    // reaches (it would show the launch's TZ zone on Linux, the host's own on Windows). First, so nothing
    // else runs in a frame before its clock is right.
    this.addSessionInitializer((frame) => this.applyClock(frame.session));
    // Shared and service workers too, on each of their sessions: one can outlive every frame of its renderer
    // process (a tab that left the site; Chrome never idle-stops a worker DevTools is attached to), and that
    // process then has no frame session left to hold its clock: it would fall back to the launch's TZ zone
    // and Chrome's default en-US ICU locale while every page shows the session's. A dedicated worker lives
    // and dies with its frame's process, which a frame session holds. Not awaited: a paused service worker
    // answers nothing until it is released, and what its session sent first still applies before its first line.
    addWorkerInitializer(this, async (session) => {
      const type = session.targetInfo?.type;
      if (type !== "shared_worker" && type !== "service_worker") return;
      this.clockWorkers.add(session);
      void this.applyClock(session);
    });
  }

  /** Shared and service worker sessions, which hold their process's clock like frame sessions (see reapplyClock). */
  private readonly clockWorkers = new Set<CDPSession>();

  /**
   * Send the browser's timezone and locale overrides to one frame or worker session (an override it does not
   * own is a no-op). Bounded: a paused or hung worker never holds up a caller (an exit change) that awaits it.
   */
  private async applyClock(s: CDPSession): Promise<void> {
    const timezoneId = this.options.timezoneId;
    const locale = this.options.locale;
    const bounded = { timeoutMs: 5_000 };
    await Promise.all([
      timezoneId ? s.send("Emulation.setTimezoneOverride", { timezoneId }, bounded).catch(() => undefined) : undefined,
      // Answered "Another locale override is already in effect" where another session in the same process
      // set it first: expected, that process already has it.
      locale ? s.send("Emulation.setLocaleOverride", { locale }, bounded).catch(() => undefined) : undefined,
    ]);
  }

  private clockTimer: NodeJS.Timeout | null = null;

  /**
   * Send the clock (timezone, locale) to every frame session, and every shared and service worker session,
   * again. A renderer process has one timezone and one ICU locale, and the override that sets each belongs to
   * the session that set it first; another session in the same process changes nothing by sending it (the
   * same zone) or is refused (another zone, until the owner moves it). Twice, so a session refused in the
   * first pass, while its process's owner had not moved yet, records the new zone in the second (the one it
   * restores if its frame moves process). Sent synchronously: a caller that only needs them on the wire need
   * not await it.
   */
  reapplyClock(): Promise<void> {
    const sessions = () => [...this.allPages().flatMap((p) => p.frames().map((f) => f.session)), ...[...this.clockWorkers].filter((s) => !s.closed)];
    const first = Promise.all(sessions().map((s) => this.applyClock(s)));
    return first.then(() => Promise.all(sessions().map((s) => this.applyClock(s)))).then(() => undefined);
  }

  /**
   * @internal A frame or worker session went away or its frame moved to another process (its tab closed, an
   * iframe was removed or navigated, a shared or service worker ended): when it owned its process's timezone
   * and locale overrides, every other frame and worker in that process fell back to the launch's zone (the
   * host's, on Windows) and the default locale. Give them to every session again, shortly (the old process
   * lets go of its frame just after the event).
   */
  _clockOwnerMayHaveLeft(): void {
    if (this.clockTimer || this.closed) return;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = null;
      if (!this.closed) void this.reapplyClock();
    }, 100);
    this.clockTimer.unref?.();
  }

  /** Directory downloads are saved to (files are named by download guid), if any. */
  get downloadsDir(): string | undefined {
    return this.options.downloadsPath ?? (this.launched ? join(this.launched.userDataDir, "downloads") : undefined);
  }

  /** Downloads that began at or after `since` (ms epoch). */
  downloadsSince(since: number): DownloadEvent[] {
    return [...this.downloadsByGuid.values()].filter((d) => d.startedAt >= since);
  }

  get root(): CDPSession {
    return this.connection.rootSession;
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  on<E extends keyof BrowserEvents>(event: E, listener: BrowserEvents[E]): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /** @internal */
  async _initialize(): Promise<void> {
    this.connection.onSession((session, kind) => {
      if (kind === "attached") this.onAttached(session);
      // A shared or service worker that held its process's clock took it along: the frames and workers left there need it again.
      else if (kind === "detached" && this.clockWorkers.delete(session)) this._clockOwnerMayHaveLeft();
    });
    this.root.on("Target.targetDestroyed", (e) => {
      const page = this.pages.get(e.targetId);
      if (page) {
        this.pages.delete(e.targetId);
        page._markClosed("target destroyed");
        this.emitter.emit("pageClosed", page);
        // Its frames may have owned the clock of a process another tab's frames share (a popup, say).
        this._clockOwnerMayHaveLeft();
      }
    });
    this.root.on("Target.targetCrashed", (e) => {
      this.pages.get(e.targetId)?._markCrashed(`${e.status} (${e.errorCode})`);
    });
    this.root.on("Browser.downloadWillBegin", (e) => {
      const d: DownloadEvent = {
        guid: e.guid,
        url: e.url,
        suggestedFilename: e.suggestedFilename,
        frameId: e.frameId,
        state: "inProgress",
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        path: this.downloadsDir ? join(this.downloadsDir, e.guid) : undefined,
      };
      this.downloadsByGuid.set(e.guid, d);
      this.emitter.emit("download", d);
    });
    this.root.on("Browser.downloadProgress", (e) => {
      const d = this.downloadsByGuid.get(e.guid);
      if (!d) return;
      d.state = e.state;
      d.receivedBytes = e.receivedBytes;
      d.totalBytes = e.totalBytes;
      if (e.state !== "inProgress") this.emitter.emit("download", d);
    });

    await this.root.send("Target.setDiscoverTargets", { discover: true });
    // flatten:true gives us one WebSocket, many sessions. waitForDebuggerOnStart
    // lets us enable domains before the page runs any script.
    await this.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const downloadsPath = this.downloadsDir;
    if (downloadsPath) {
      // Chrome cancels downloads into a directory that does not exist.
      try {
        mkdirSync(downloadsPath, { recursive: true });
      } catch {}
      await this.root
        .send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadsPath, eventsEnabled: true })
        .catch(() => undefined);
    }
    // Wait until the initial page has attached AND finished initializing. The attach event can land
    // before setAutoAttach's reply resolves, so a Page may already exist here but still be mid-init
    // (its timezone/locale overrides not yet applied); returning now would let the first navigate race
    // them. Bounded so connect() to a browser with no page does not hang forever.
    const ready = (p: Page) => Promise.race([p.whenReady, new Promise<void>((r) => setTimeout(r, 15_000).unref?.())]);
    const first = this.allPages()[0];
    if (first) {
      await ready(first);
    } else {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15_000);
        timer.unref?.();
        const off = this.on("page", (p) => {
          off();
          clearTimeout(timer);
          void ready(p).then(resolve);
        });
      });
    }
  }

  private onAttached(session: CDPSession): void {
    const info = session.targetInfo;
    if (!info) return;
    // Only targets auto-attached to our own root session are ours. External
    // CDP clients (via the proxy) attach the same targets under their own
    // browser session; those must not become Page objects here.
    if (session.parentSessionId !== undefined) return;
    if (info.type === "page") {
      const page = new Page(this, session, info);
      this.pages.set(info.targetId, page);
      void page._initialize().then(
        () => this.emitter.emit("page", page),
        (err: unknown) => {
          // The target may have gone away mid-init (popup closed instantly); drop it quietly.
          this.pages.delete(info.targetId);
          page._markClosed(`init failed: ${(err as Error).message}`);
        },
      );
      return;
    }
    if (info.type === "iframe") {
      // OOPIF: the owning Page sees Target.attachedToTarget on its own (parent)
      // session and adopts the child there. Nothing to do at browser level.
      return;
    }
    // A shared or service worker: a page's, from an http(s), blob: or data: URL alike, gets the worker
    // initializers (an extension's scripts, the clock) before it starts; the browser's own (isBrowserOwnUrl) is
    // released untouched. A service worker also attaches under the page it serves; initWorkerSession makes the
    // two agree.
    if (info.type === "shared_worker" || info.type === "service_worker") {
      initWorkerSession(this, session);
      return;
    }
    // Background pages, other: resume and ignore.
    void session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
  }

  allPages(): Page[] {
    return [...this.pages.values()].filter((p) => !p.closed);
  }

  /** The most recently created non-closed page, or the first. */
  async newPage(opts: { url?: string; browserContextId?: string; background?: boolean } = {}): Promise<Page> {
    const { targetId } = await this.root.send("Target.createTarget", {
      url: opts.url ?? "about:blank",
      browserContextId: opts.browserContextId,
      ...(opts.background ? { background: true } : {}),
    });
    return this.waitForPage(targetId);
  }

  async waitForPage(targetId: string, timeoutMs = 15_000): Promise<Page> {
    const existing = this.pages.get(targetId);
    if (existing?.ready) return existing;
    return new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Page ${targetId} did not initialize within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on("page", (p) => {
        if (p.targetId === targetId) {
          clearTimeout(timer);
          off();
          resolve(p);
        }
      });
    });
  }

  /** Isolated cookie jar / storage / cache, optionally with its own proxy. */
  async createContext(opts: BrowserContextOptions = {}): Promise<string> {
    // A proxy with credentials goes through a local forwarder (Chromium ignores them in the URL): an extension's (contextProxy).
    const forwarder = opts.proxyServer && proxyHasCredentials(opts.proxyServer) ? await this.startContextProxy(opts.proxyServer) : null;
    try {
      const { browserContextId } = await this.root.send("Target.createBrowserContext", {
        disposeOnDetach: true,
        proxyServer: forwarder?.url ?? opts.proxyServer,
        // Chrome's own services go direct (see CHROME_SERVICE_HOSTS), as for the launch's proxy.
        ...(opts.proxyServer ? { proxyBypassList: [...CHROME_SERVICE_HOSTS, ...(opts.proxyBypassList ? [opts.proxyBypassList] : [])].join(";") } : opts.proxyBypassList ? { proxyBypassList: opts.proxyBypassList } : {}),
      });
      if (forwarder) {
        this.contextForwarders.set(browserContextId, forwarder);
        forwarder.attached?.();
      }
      return browserContextId;
    } catch (e) {
      await forwarder?.close();
      throw e;
    }
  }

  private startContextProxy(proxyServer: string): Promise<ContextProxy> {
    if (!this.contextProxy) throw new Error("A context proxy with credentials needs a local forwarder, which only a launch extension provides (Chromium ignores credentials in a proxy URL)");
    return this.contextProxy(proxyServer);
  }

  async disposeContext(browserContextId: string): Promise<void> {
    await this.root.send("Target.disposeBrowserContext", { browserContextId });
    await this.contextForwarders.get(browserContextId)?.close();
    this.contextForwarders.delete(browserContextId);
  }

  /** Run when the browser closes (local proxy forwarders and the like). */
  addCleanup(fn: () => Promise<void> | void): void {
    this.cleanups.push(fn);
  }

  /** Stop a download that has begun (its bytes stop flowing; the file is not kept). */
  async cancelDownload(guid: string): Promise<void> {
    await this.root.send("Browser.cancelDownload", { guid }).catch(() => undefined);
  }

  async version(): Promise<Protocol.Browser.GetVersionResponse> {
    return this.root.send("Browser.getVersion");
  }

  async close(): Promise<void> {
    // Clean up exactly once, but DO clean up even after a crash: when Chrome dies the connection's
    // onClose sets closedReason, and returning here on that would leak the proxy forwarders, the temp
    // profile dir and (if it is still alive) the process, once per crash.
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (!this.closedReason) {
      try {
        await Promise.race([
          this.root.send("Browser.close", undefined, { timeoutMs: 3_000 }),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      } catch {
        /* ignore */
      }
    }
    this.connection.close("browser closed");
    const proc = this.launched?.process;
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 3_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    for (const f of this.contextForwarders.values()) await f.close().catch(() => undefined);
    this.contextForwarders.clear();
    for (const fn of this.cleanups.splice(0)) await Promise.resolve(fn()).catch(() => undefined);
    if (this.launched?.ownsUserDataDir) {
      // On Windows, Chrome's helper processes hold profile files for a moment after the main one exits, so
      // the removal retries; asynchronously, as a synchronous retry loop (up to about 11 s) would stall every
      // other task in the process, a server shutdown's own work included.
      await rm(this.launched.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {
        /* a temp profile left behind is not worth failing close() over */
      });
    }
  }
}
