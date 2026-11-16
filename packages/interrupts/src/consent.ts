// ConsentEngine: DuckDuckGo autoconsent (MPL-2.0) over raw CDP, reject-only, no Runtime.enable.
//
// Channel, per frame session:
//   1. Runtime.addBinding({name: "__pfAc", executionContextName: "pf_ac"}) once. Without
//      Runtime.enable, V8 does not install name-scoped bindings into contexts created later, but it
//      does deliver Runtime.bindingCalled for any context the binding was installed in.
//   2. Page.addScriptToEvaluateOnNewDocument({worldName: "pf_ac", runImmediately: true}) with a shim
//      plus the autoconsent content script. It runs in an isolated world before page scripts; the
//      shim queues outgoing messages until the binding exists.
//   3. On every Page.frameNavigated: Page.createIsolatedWorld({frameId, worldName: "pf_ac"}) returns
//      the same named world's context in the new document, Runtime.addBinding({executionContextId})
//      installs the binding there, and a Runtime.evaluate flushes the queue.
//   4. Replies go back with Runtime.evaluate({contextId}) calling autoconsentReceiveMessage.
//
// Privacy invariant: consent is only ever refused. autoAction is "optOut", the heuristic runs in
// "reject" mode (tier1/tier2 click Acknowledge/Accept), rules are the compact opt-out-only encoding
// (it carries no optIn steps), opt-in eval snippets are refused, and a click guard in the isolated
// world refuses to click anything labelled as an accept button.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isAdFrameUrl, type FrameSession, type Page } from "@pilotfish/browser";
import type { CDPSession, Protocol } from "@pilotfish/cdp";
import { evalSnippets, filterCompactRules } from "@duckduckgo/autoconsent";
import type { Config, IndexedCMPRuleset } from "@duckduckgo/autoconsent";
import { isCmpRequest } from "./hosts.js";

const require = createRequire(import.meta.url);
const WORLD = "pf_ac";
const BINDING = "__pfAc";

export interface ConsentOptions {
  /** CMP rule names to skip. */
  disabledCmps?: string[];
  /** Reject-only heuristic for banners no rule knows. Default true. */
  heuristics?: boolean;
  /** Run the rule's self-test after opting out. Default true. */
  selfTest?: boolean;
}

export type ConsentOutcome = "opted_out" | "no_cmp" | "failed" | "pending";

export interface ConsentStatus {
  /** CMP rule that handled (or was detected on) the page, e.g. "Onetrust", "HEURISTIC-REJECT". */
  cmp: string | null;
  /** `no_cmp` also covers a CMP that showed no banner (consent already stored, or not required). */
  outcome: ConsentOutcome;
  /** From the main-frame navigation to the outcome (or until now while pending). */
  ms: number;
  url: string;
  /** The banner was hidden by a cosmetic rule rather than answered. */
  cosmetic?: boolean;
  /** Result of the rule's self-test, when one ran. */
  selfTest?: boolean;
  /** Clicks the guard refused because the target read as an accept button. */
  refusedClicks: number;
  /** Frames (top, same-process and out-of-process iframes) where autoconsent started on this document. */
  frames: number;
}

interface FrameEvent {
  page: Page;
  frameId: string;
  url: string;
}

export interface ConsentEvents {
  cmpDetected: (e: FrameEvent & { cmp: string }) => void;
  popupFound: (e: FrameEvent & { cmp: string }) => void;
  optOutResult: (e: FrameEvent & { cmp: string; result: boolean }) => void;
  autoconsentDone: (e: FrameEvent & { cmp: string; cosmetic: boolean; durationMs: number; clicks: number }) => void;
  selfTestResult: (e: FrameEvent & { cmp: string; result: boolean }) => void;
  error: (e: Partial<FrameEvent> & { error: string; details?: unknown }) => void;
}

// ------------------------------------------------------------------ library assets

const distDir = dirname(require.resolve("@duckduckgo/autoconsent"));

/** Opt-out-only compact rules shipped with the package (updated with each autoconsent release). */
const COMPACT_RULES = JSON.parse(readFileSync(require.resolve("@duckduckgo/autoconsent/rules/compact-rules.json"), "utf8")) as IndexedCMPRuleset;

/**
 * Eval snippets that only an opt-in flow uses: referenced by an `optIn` step in the full rules and by
 * nothing in the opt-out-only compact rules, plus code-CMP opt-in snippets and anything named accept.
 */
export const OPT_IN_SNIPPETS: ReadonlySet<string> = (() => {
  const full = JSON.parse(readFileSync(require.resolve("@duckduckgo/autoconsent/rules/rules.json"), "utf8")) as { autoconsent: Array<{ optIn?: unknown }> };
  const ids = (v: unknown) => new Set(JSON.stringify(v ?? null).match(/EVAL_[A-Z0-9_]+/g) ?? []);
  const optOut = ids(COMPACT_RULES);
  const out = new Set<string>(["EVAL_CONSENTMANAGER_4"]); // consentmanager.ts optIn(): __cmp('setConsent', 1)
  for (const r of full.autoconsent) for (const id of ids(r.optIn)) if (!optOut.has(id)) out.add(id);
  for (const id of Object.keys(evalSnippets)) if (/ACCEPT|OPT_?IN/.test(id)) out.add(id);
  return out;
})();

/** Reject-only configuration. Not user-overridable where it matters for privacy. */
function makeConfig(opts: ConsentOptions): Config {
  return {
    enabled: true,
    autoAction: "optOut",
    disabledCmps: opts.disabledCmps ?? [],
    enablePrehide: true,
    enableCosmeticRules: true,
    enableGeneratedRules: true,
    enableHeuristicDetection: true,
    enablePopupMutationObserver: false,
    detectRetries: 20,
    isMainWorld: false,
    prehideTimeout: 2000,
    visualTest: false,
    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
    performanceLoggingEnabled: false,
    heuristicPopupSearchTimeout: 100,
    heuristicMode: opts.heuristics === false ? "off" : "reject",
  };
}

/**
 * autoconsent's own button classifier (DOM-free, multilingual), wrapped for the isolated world.
 * Falls back to a small regex if the bundle's shape ever changes.
 */
function classifierSource(): string {
  const fallback = `const __pfClassify = (t) => /\\b(accept|allow|agree|consent)\\b/i.test(t) && !/\\b(reject|decline|deny|refuse|only|necessary|essential)\\b/i.test(t) ? "accept" : "other";`;
  try {
    const src = readFileSync(join(distDir, "heuristics.mjs"), "utf8");
    const cut = src.lastIndexOf("\nexport {");
    if (cut < 0) return fallback;
    const wrapped = `const __pfClassify = (() => {\n${src.slice(0, cut)}\nreturn classifyButtonTextRegex;\n})();`;
    const ok = new Function(`${wrapped}\nreturn __pfClassify("Accept all") === "accept" && __pfClassify("Reject all") === "reject";`)();
    return ok ? wrapped : fallback;
  } catch {
    return fallback;
  }
}

/** Shim + click guard + autoconsent content script, evaluated in the "pf_ac" world of every document. */
const CONTENT_SCRIPT = `(() => {
  if (globalThis.__pfAcLoaded) return;
  globalThis.__pfAcLoaded = true;
  const queue = [];
  const flush = () => {
    if (typeof globalThis.${BINDING} !== "function") return false;
    while (queue.length) globalThis.${BINDING}(queue.shift());
    return true;
  };
  const send = (m) => { try { queue.push(JSON.stringify(m)); } catch (e) { return Promise.resolve(); } flush(); return Promise.resolve(); };
  globalThis.__pfAcFlush = flush;
  globalThis.autoconsentSendMessage = send;
  // Click guard: this world's HTMLElement.prototype (the page's is untouched). Opt-out finalizers
  // like "Allow selection" or "Save preferences" read as accept to the classifier and stay allowed.
  ${classifierSource()}
  const KEEP = /select|s[eé]lection|selecci|selezion|auswahl|save|speicher|enregistr|guardar|salva|opslaan|zapisz|spara|preferen|choice|choix|setting|einstellung|confirm|best[aä]tig|conferm|bevestig|custom|manage/i;
  const click = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function () {
    const label = String(this.innerText || this.value || this.getAttribute("aria-label") || this.title || this.textContent || "").trim().slice(0, 200);
    if (label && __pfClassify(label) === "accept" && !KEEP.test(label)) {
      send({ type: "pfRefusedClick", text: label.slice(0, 80) });
      return;
    }
    return click.call(this);
  };
})();
${readFileSync(join(distDir, "autoconsent.playwright.js"), "utf8")}`;

// ------------------------------------------------------------------ per-page state

interface PageConsent {
  navAt: number;
  url: string;
  cmp: string | null;
  detectedAt?: number;
  popupAt?: number;
  optOut?: boolean;
  optOutAt?: number;
  doneAt?: number;
  cosmetic?: boolean;
  selfTest?: boolean;
  /** Frame whose opt-out scheduled a self-test (sent after autoconsentDone, as the reference extension does). */
  selfTestTarget?: { s: CDPSession; contextId: number };
  cmpRequestAt?: number;
  refused: number;
  frames: Set<string>;
  /** Top frame, from autoconsent's report messages. */
  topInitAt?: number;
  topAttempts: number;
  topLifecycle?: string;
  /** First time the top frame's text matched autoconsent's cookie-banner patterns. */
  patternsAt?: number;
  /** Top-frame scan round when the CMP request / banner text was first seen. */
  roundAtCmpRequest?: number;
  roundAtPatterns?: number;
}

/** Scan rounds after a signal with nothing found: the banner is not coming (heuristic runs on even rounds). */
const QUIET_ROUNDS = 3;
const QUIET_MS = 2_500;

/** After cmpDetected, autoconsent looks for a visible popup for ~5 s (10 x 500 ms). */
const POPUP_SEARCH_MS = 6_500;
/** A CMP script was requested but nothing detected yet: allow it this long to render. */
const CMP_LOAD_MS = 6_000;
/** Intermediate opt-out steps hand over to another rule/frame; wait this long for autoconsentDone. */
const HANDOVER_MS = 3_000;
/** autoconsent announces itself (init) within a few ms of commit on an http(s) document. */
const INIT_MS = 1_500;
/** The first detection round starts when the page is idle after DOMContentLoaded. */
const FIRST_SCAN_MS = 3_000;
/** Banner-like text but no rule matched yet: the reject heuristic runs every other round (~0.5-1 s apart). */
const HEURISTIC_MS = 4_000;

function outcomeOf(st: PageConsent, now: number): ConsentOutcome {
  if (st.doneAt) return "opted_out";
  if (st.optOut === false) return "failed";
  if (st.optOut === true) return now - st.optOutAt! > HANDOVER_MS ? "opted_out" : "pending";
  if (st.popupAt) return "pending";
  if (st.detectedAt) return now - st.detectedAt < POPUP_SEARCH_MS ? "pending" : "no_cmp";
  const scanning = st.topLifecycle !== "nothingDetected";
  // Nothing found for QUIET_ROUNDS scan rounds and QUIET_MS since the signal: stop waiting.
  const quiet = (at: number, round: number | undefined) => now - at >= QUIET_MS && round !== undefined && st.topAttempts >= round + QUIET_ROUNDS;
  if (st.cmpRequestAt && now - st.cmpRequestAt < CMP_LOAD_MS && scanning && !quiet(st.cmpRequestAt, st.roundAtCmpRequest)) return "pending";
  if (!st.topInitAt && /^https?:/.test(st.url) && now - st.navAt < INIT_MS) return "pending";
  // Rounds are counted when they start; banner patterns are known once round 2 begins.
  if (st.topInitAt && st.topAttempts < 2 && now - st.topInitAt < FIRST_SCAN_MS) return "pending";
  if (st.patternsAt && now - st.patternsAt < HEURISTIC_MS && scanning && !quiet(st.patternsAt, st.roundAtPatterns)) return "pending";
  return "no_cmp";
}

interface ContextInfo {
  frameId: string;
  mainFrame: boolean;
}

// ------------------------------------------------------------------ engine

export class ConsentEngine {
  private readonly emitter = new EventEmitter();
  private readonly pages = new WeakMap<Page, PageConsent>();
  private readonly disposers = new Set<() => void>();
  private readonly armed = new WeakSet<CDPSession>();
  private readonly retried = new WeakSet<CDPSession>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private disposed = false;
  private readonly config: Config;

  constructor(private readonly opts: ConsentOptions = {}) {
    this.config = makeConfig(opts);
    if (this.config.autoAction !== "optOut" || !["off", "reject"].includes(this.config.heuristicMode)) {
      throw new Error("ConsentEngine only ever opts out"); // guard against future edits
    }
  }

  on<E extends keyof ConsentEvents>(event: E, listener: ConsentEvents[E]): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /** Consent outcome for the page's current document. */
  consentStatus(page: Page): ConsentStatus {
    const st = this.state(page);
    const now = Date.now();
    const outcome = outcomeOf(st, now);
    const end = outcome === "opted_out" ? (st.doneAt ?? st.optOutAt!) : now;
    return {
      cmp: st.cmp,
      outcome,
      ms: Math.max(0, end - st.navAt),
      url: st.url,
      ...(st.cosmetic !== undefined ? { cosmetic: st.cosmetic } : {}),
      ...(st.selfTest !== undefined ? { selfTest: st.selfTest } : {}),
      refusedClicks: st.refused,
      frames: st.frames.size,
    };
  }

  /**
   * Resolve when autoconsent has finished with the page (opted out, failed, or no banner) or after
   * `timeoutMs`. Returns at once unless a CMP was detected or a known CMP script was requested.
   */
  async waitForConsent(page: Page, timeoutMs = 10_000): Promise<ConsentStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = this.consentStatus(page);
      if (status.outcome !== "pending" || Date.now() >= deadline || page.closed) return status;
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }

  dispose(): void {
    // A queued re-arm must not bring consent handling back after detach.
    this.disposed = true;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    for (const d of this.disposers) d();
    this.disposers.clear();
  }

  /** Session initializer (see Browser.addSessionInitializer). Runs before the frame's scripts start. */
  readonly initSession = async (frame: FrameSession): Promise<void> => {
    const s = frame.session;
    const page = frame.page;
    // Ad and tracking frames (pixels, safeframes) never hold a consent banner, and some never answer
    // CDP at all: arming them only keeps them paused.
    if (!frame.isMain && isAdFrameUrl(frame.url)) return;
    // Once per session: a page still initializing when the initializer is registered gets it twice.
    if (this.armed.has(s)) return;
    this.armed.add(s);
    const contexts = new Map<number, ContextInfo>();
    const offs: Array<() => void> = [() => this.armed.delete(s)];
    // The frame stays paused until this returns: a session that does not answer gets 5 s, not 30.
    let script: Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse;
    try {
      [, script] = await Promise.all([
        s.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }, { timeoutMs: 5_000 }),
        s.send("Page.addScriptToEvaluateOnNewDocument", { source: CONTENT_SCRIPT, worldName: WORLD, runImmediately: true }, { timeoutMs: 5_000 }),
      ]);
    } catch (e) {
      // Not armed after all (a busy or paused session): forget it and try once more shortly, so the
      // tab does not silently go without consent handling.
      this.armed.delete(s);
      if (frame.isMain && !this.retried.has(s) && !this.disposed) {
        this.retried.add(s);
        const t = setTimeout(() => {
          this.retryTimers.delete(t);
          if (!this.disposed) void this.initSession(frame).catch(() => undefined);
        }, 2_000);
        t.unref?.();
        this.retryTimers.add(t);
      }
      throw e;
    }
    const dispose = () => {
      for (const o of offs) o();
      void s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script.identifier }).catch(() => undefined);
      void s.send("Runtime.removeBinding", { name: BINDING }).catch(() => undefined);
    };
    this.disposers.add(dispose);
    offs.push(() => this.disposers.delete(dispose));

    const arm = async (frameId: string, url: string, mainFrame: boolean): Promise<void> => {
      if (!/^https?:/.test(url) || (!mainFrame && isAdFrameUrl(url))) return;
      const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false }, { timeoutMs: 5_000 });
      contexts.set(executionContextId, { frameId, mainFrame });
      await s.send("Runtime.addBinding", { name: BINDING, executionContextId }, { timeoutMs: 5_000 });
      await s.send("Runtime.evaluate", { contextId: executionContextId, expression: "globalThis.__pfAcFlush && __pfAcFlush()", returnByValue: true }, { timeoutMs: 5_000 });
    };
    const armSafe = (frameId: string, url: string, mainFrame: boolean) =>
      void arm(frameId, url, mainFrame).catch((e: unknown) => {
        // Frames come and go mid-arm (ad safeframes, redirects): only report other failures.
        if (!/not found|Cannot find|No frame|detached|closed|destroyed|navigated/i.test(String(e))) this.emit("error", { page, frameId, url, error: `arm: ${String(e)}` });
      });

    offs.push(
      s.on("Page.frameNavigated", (e) => {
        const top = frame.isMain && !e.frame.parentId;
        if (top) this.reset(page, e.frame.url);
        armSafe(e.frame.id, e.frame.url, top);
      }),
      s.on("Runtime.bindingCalled", (e) => {
        if (e.name !== BINDING) return;
        const ctx = contexts.get(e.executionContextId);
        if (ctx) void this.onMessage(s, page, e.executionContextId, ctx, e.payload).catch(() => undefined);
      }),
      s.on("Network.requestWillBeSent", (e) => {
        if (!isCmpRequest(e.request.url)) return;
        const st = this.state(page);
        if (st.cmpRequestAt !== undefined) return;
        st.cmpRequestAt = Date.now();
        st.roundAtCmpRequest = st.topAttempts;
      }),
    );
    // Frames that already have a document (attach to a running browser, runImmediately).
    const { frameTree } = await s.send("Page.getFrameTree");
    const walk = (t: Protocol.Page.FrameTree, top: boolean): void => {
      armSafe(t.frame.id, t.frame.url, top);
      for (const c of t.childFrames ?? []) walk(c, false);
    };
    walk(frameTree, frame.isMain);
  };

  // ---------------------------------------------------------------- messages

  private async onMessage(s: CDPSession, page: Page, contextId: number, ctx: ContextInfo, payload: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const st = this.state(page);
    const url = typeof msg.url === "string" ? msg.url : "";
    const base = { page, frameId: ctx.frameId, url };
    const cmp = typeof msg.cmp === "string" ? msg.cmp : "";
    switch (msg.type) {
      case "init": {
        st.frames.add(ctx.frameId);
        if (ctx.mainFrame) st.topInitAt ??= Date.now();
        const rules = { autoconsent: [], compact: filterCompactRules(COMPACT_RULES, { url, mainFrame: ctx.mainFrame }) };
        await this.reply(s, contextId, { type: "initResp", config: this.config, rules });
        return;
      }
      case "eval":
        await this.reply(s, contextId, { type: "evalResp", id: msg.id, result: await this.runSnippet(s, page, contextId, ctx, msg.snippetId) });
        return;
      case "cmpDetected":
        st.cmp ??= cmp;
        st.detectedAt ??= Date.now();
        this.emit("cmpDetected", { ...base, cmp });
        return;
      case "popupFound":
        st.cmp = cmp;
        st.popupAt ??= Date.now();
        this.emit("popupFound", { ...base, cmp });
        return;
      case "optOutResult":
        st.cmp = cmp || st.cmp;
        st.optOut = msg.result === true;
        st.optOutAt = Date.now();
        if (msg.result === true && msg.scheduleSelfTest === true) st.selfTestTarget = { s, contextId };
        this.emit("optOutResult", { ...base, cmp, result: msg.result === true });
        return;
      case "autoconsentDone": {
        st.cmp = cmp || st.cmp;
        st.doneAt = Date.now();
        st.cosmetic = msg.isCosmetic === true;
        this.emit("autoconsentDone", { ...base, cmp, cosmetic: st.cosmetic, durationMs: Number(msg.duration) || 0, clicks: Number(msg.totalClicks) || 0 });
        const target = st.selfTestTarget;
        st.selfTestTarget = undefined;
        if (this.opts.selfTest !== false && target) await this.reply(target.s, target.contextId, { type: "selfTest" });
        return;
      }
      case "selfTestResult":
        st.selfTest = msg.result === true;
        this.emit("selfTestResult", { ...base, cmp, result: st.selfTest });
        return;
      case "optInResult":
        // Never requested; reported loudly if it ever happens.
        this.emit("error", { ...base, error: "unexpected optInResult", details: msg });
        return;
      case "autoconsentError":
        this.emit("error", { ...base, error: "autoconsent", details: msg.details });
        return;
      case "pfRefusedClick":
        st.refused++;
        this.emit("error", { ...base, error: `refused to click an accept button: "${String(msg.text)}"` });
        return;
      case "report": {
        // Progress of the top frame's scan: decides whether waiting for a banner is worthwhile.
        const state = (msg.state ?? {}) as { lifecycle?: string; findCmpAttempts?: number; heuristicPatterns?: unknown[] };
        if (!ctx.mainFrame || msg.mainFrame !== true) return;
        st.topLifecycle = state.lifecycle;
        st.topAttempts = Math.max(st.topAttempts, Number(state.findCmpAttempts) || 0);
        if (state.heuristicPatterns?.length && st.patternsAt === undefined) {
          st.patternsAt = Date.now();
          st.roundAtPatterns = st.topAttempts;
        }
        return;
      }
      default:
        return; // visualDelay
    }
  }

  private reply(s: CDPSession, contextId: number, message: unknown): Promise<unknown> {
    return s
      .send("Runtime.evaluate", { contextId, expression: `autoconsentReceiveMessage(${JSON.stringify(message)})`, returnByValue: true })
      .catch(() => undefined);
  }

  /**
   * Run a vetted library snippet (by id, never the page-supplied code) in the main world of the
   * requesting frame: the isolated world's `document` -> backendNodeId -> DOM.resolveNode without a
   * context id resolves in that frame's main world -> Runtime.callFunctionOn there.
   */
  private async runSnippet(s: CDPSession, page: Page, contextId: number, ctx: ContextInfo, snippetId: unknown): Promise<boolean> {
    const fn = typeof snippetId === "string" ? (evalSnippets as Record<string, (() => unknown) | undefined>)[snippetId] : undefined;
    if (!fn || OPT_IN_SNIPPETS.has(snippetId as string)) {
      this.emit("error", { page, frameId: ctx.frameId, error: `refused eval snippet ${String(snippetId)}` });
      return false;
    }
    const doc = await s.send("Runtime.evaluate", { contextId, expression: "document", returnByValue: false });
    if (!doc.result.objectId) return false;
    try {
      const { node } = await s.send("DOM.describeNode", { objectId: doc.result.objectId });
      const { object } = await s.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
      if (!object.objectId) return false;
      try {
        const res = await s.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `async function () { try { return !!(await (${fn.toString()}).call(window)); } catch (e) { return false; } }`,
          returnByValue: true,
          awaitPromise: true,
        });
        return res.result.value === true;
      } finally {
        void s.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
      }
    } catch {
      return false;
    } finally {
      void s.send("Runtime.releaseObject", { objectId: doc.result.objectId }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- state

  private state(page: Page): PageConsent {
    let st = this.pages.get(page);
    if (!st) {
      st = { navAt: Date.now(), url: page.url, cmp: null, refused: 0, frames: new Set(), topAttempts: 0 };
      this.pages.set(page, st);
    }
    return st;
  }

  private reset(page: Page, url: string): void {
    this.pages.set(page, { navAt: Date.now(), url, cmp: null, refused: 0, frames: new Set(), topAttempts: 0 });
  }

  private emit<E extends keyof ConsentEvents>(event: E, payload: Parameters<ConsentEvents[E]>[0]): void {
    // An "error" nobody listens to would be thrown by EventEmitter and take the process down.
    if (event === "error" && this.emitter.listenerCount("error") === 0) return;
    this.emitter.emit(event, payload);
  }
}
