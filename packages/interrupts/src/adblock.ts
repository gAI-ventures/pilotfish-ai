// AdBlockEngine: ads and trackers handled deterministically per frame session.
//
//   Tier A (always): Network.setBlockedURLs with whole-host rules (block:false allow entries first).
//     Blocking happens inside Chrome with no round trip, but Chrome checks each request against
//     every pattern, in order, on the renderer main thread while the document parses: ~1 µs per
//     pattern per request, plus ~0.08 ms per pattern to install (Chrome 151, measured). The
//     2000-host list this used to install cost ~2.4 ms per request: +0.5 s DOMContentLoaded on a
//     local 180-request page. So a session installs only a short head (30 hosts, the major ad
//     networks first) plus the listed hosts its site's documents have actually requested
//     ("learned": the first request to such a host goes through, the patterns are re-installed
//     within milliseconds, and later documents of that site block it from their first byte).
//     An out-of-process iframe attaches before its URL is known, so until it commits its head
//     leaves out hosts blocked only as third parties (otherwise Google's safeframes lose their
//     own ext.js). Hosts touching the allow-list are never in the list, so it needs no patterns.
//   Tier B (opt-in): Fetch.enable on subresources and the full engine per request, with uBO
//     surrogate scripts where the lists redirect. Exact, but every intercepted request waits for a
//     CDP round trip to Node (measured cost in the package report).
//   Cosmetics: on each frame navigation the engine's CSS for that URL is adopted as a stylesheet
//     from an isolated world (never the main world), then refined from the DOM's ids/classes/hrefs
//     at DOMContentLoaded and load. Scriptlets and procedural selectors are never used.

import { EventEmitter } from "node:events";
import { RequestInterceptor, type FrameSession, type Page } from "@pilotfish/browser";
import { CDPError, SessionClosedError, type CDPSession, type Protocol } from "@pilotfish/cdp";
import { Request, type FiltersEngine, type RequestType } from "@ghostery/adblocker";
import { extractFeaturesFromDOM } from "@ghostery/adblocker-content";
import { parse as parseUrl } from "tldts-experimental";
import { hostIsUnder, hostLegacyPatterns, hostTouchesProtected, hostUrlPattern, isNeverBlocked } from "./hosts.js";
import { SEED_HOSTS, loadLists, type ListSource, type LoadListsOptions, type TierA } from "./lists.js";

export interface AdBlockOptions extends LoadListsOptions {
  /** Fetch-domain interception with the full engine and surrogates. Default false. */
  tierB?: boolean;
  /** CSS element hiding. Default true. */
  cosmetic?: boolean;
  /**
   * Tier A hosts installed up front in a tab's session, major ad networks first. Default 30. Each
   * pattern costs every request ~1 µs of renderer main-thread time, so keep this small.
   */
  maxHostPatterns?: number;
  /** Tier A hosts installed up front in an out-of-process iframe session. Default 30. */
  maxFramePatterns?: number;
  /**
   * Block any other listed host once a document of the site has requested it (that first request
   * goes through). Default true; false installs the head only.
   */
  learn?: boolean;
  /** Learned hosts kept per site. Default 200. */
  maxLearnedPerSite?: number;
}

export interface AdBlockStats {
  /** Requests blocked since the page's last main-frame navigation. */
  blocked: number;
  /** Requests answered with a surrogate (Tier B). */
  redirected: number;
  /** Blocked requests per host. */
  byHost: Record<string, number>;
  /** Cosmetic selectors injected into this page's frames. */
  hiddenSelectors: number;
  /** Listed hosts added to this page's Tier A patterns after the page first requested them. */
  learnedHosts: number;
  /** Blocked requests over the page's lifetime. */
  totalBlocked: number;
  /** Start of the current document (ms epoch). */
  since: number;
}

export interface AdBlockEvents {
  blocked: (e: { page: Page; url: string; tier: "A" | "B"; type: string; redirected: boolean }) => void;
  error: (e: { page?: Page; where: string; error: string }) => void;
}

const WORLD = "pf_ab";
/** Learned hosts arriving within this window are installed together (one re-install). */
const LEARN_BATCH_MS = 5;
/** Sites whose learned hosts are kept (least recently used dropped first). */
const MAX_LEARNED_SITES = 500;
/** Subresource types Tier B intercepts. Documents are never intercepted. */
const TIER_B_TYPES: Protocol.Network.ResourceType[] = ["Script", "Image", "Stylesheet", "Font", "Media", "XHR", "Fetch", "Ping", "EventSource", "Other"];

/** In-page helper (isolated world): adopt or extend our stylesheet, falling back to a <style> element. */
const CSS_HELPER = `(() => {
  if (globalThis.__pfAbCss) return;
  let css = "", sheet = null, el = null;
  globalThis.__pfAbCss = (add) => {
    if (add) css += "\\n" + add;
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      if (!el) el = document.createElement("style");
      el.textContent = css;
      if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
    }
    return css.length;
  };
})()`;

export class AdBlockEngine {
  private readonly emitter = new EventEmitter();
  private readonly stats_ = new WeakMap<Page, AdBlockStats>();
  private readonly disposers = new Set<() => void>();
  private readonly refreshers = new WeakMap<FrameSession, () => Promise<void>>();
  private readonly armed = new WeakSet<CDPSession>();
  /** Connections whose Chrome predates `urlPatterns` (legacy wildcard `urls`). */
  private readonly legacy = new WeakSet<object>();
  /** Tier A hosts in rank order, without any that could touch a protected host. */
  private readonly hosts: string[];
  private readonly listed: Set<string>;
  private readonly thirdPartyOnly: Set<string>;
  /** Host -> its allow URLPatterns (generic exceptions, surrogate-served URLs), deduplicated. */
  private readonly holes = new Map<string, string[]>();
  /** Site -> listed hosts its documents requested (insertion order: least recently used first). */
  private readonly learned = new Map<string, Set<string>>();

  private constructor(
    readonly engine: FiltersEngine,
    readonly tierA: TierA,
    readonly source: ListSource,
    private readonly opts: AdBlockOptions,
  ) {
    // deriveTierA already drops these; a host under or over a protected one would need the
    // allow-list installed in front of every session's patterns, at ~1 µs per entry per request.
    const hosts = tierA.hosts.filter((h) => !hostTouchesProtected(h));
    // The rank (rules per domain) favours big platforms' subdomains (googleapis, cloudfront, qq);
    // the head should be the ad networks most pages load, so those go first.
    const major = (h: string) => SEED_HOSTS.some((d) => hostIsUnder(h, d));
    this.hosts = [...hosts.filter(major), ...hosts.filter((h) => !major(h))];
    this.listed = new Set(this.hosts);
    // `$third-party` hosts: allowed on their own site (deriveTierA lists them under it).
    this.thirdPartyOnly = new Set(this.hosts.filter((h) => tierA.siteAllow[parseUrl(h).domain ?? h]?.includes(h)));
    for (const { host, pattern } of tierA.allow) {
      const list = this.holes.get(host) ?? this.holes.set(host, []).get(host)!;
      if (!list.includes(pattern)) list.push(pattern);
    }
  }

  /** Load lists (cache, upstream, mirror, seed) and build the engine. */
  static async create(opts: AdBlockOptions = {}): Promise<AdBlockEngine> {
    const lists = await loadLists(opts);
    return new AdBlockEngine(lists.engine, lists.tierA, lists.source, opts);
  }

  on<E extends keyof AdBlockEvents>(event: E, listener: AdBlockEvents[E]): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /** Blocking stats for a page's current document. */
  stats(page: Page): AdBlockStats {
    const s = this.pageStats(page);
    return { ...s, byHost: { ...s.byHost } };
  }

  /** The engine's decision for one request, as Tier B applies it. Protected hosts are never blocked. */
  match(url: string, sourceUrl: string, type: string): { block: boolean; redirect?: { body: string; contentType: string } } {
    if (isNeverBlocked(url)) return { block: false };
    // CDP resource types lowercased are the engine's Puppeteer request types.
    const res = this.engine.match(Request.fromRawDetails({ url, sourceUrl, type: type.toLowerCase() as RequestType }));
    if (res.redirect) return { block: true, redirect: { body: res.redirect.body, contentType: res.redirect.contentType } };
    return { block: res.match && !res.exception };
  }

  /** Cosmetic CSS for a URL (hostname rules plus generic rules, or rules matching DOM features). */
  cosmeticCss(url: string, features?: { classes: string[]; ids: string[]; hrefs: string[] }): string {
    const { hostname, domain } = parseUrl(url);
    if (!hostname) return "";
    const res = this.engine.getCosmeticsFilters({
      url,
      hostname,
      domain: domain ?? hostname,
      getBaseRules: !features,
      getRulesFromHostname: !features,
      getRulesFromDOM: !!features,
      getInjectionRules: false,
      getExtendedRules: false,
      ...(features ?? {}),
    });
    return res.active ? res.styles : "";
  }

  /** Re-scan every frame of the page and hide newly matching elements (e.g. before a snapshot). */
  async refreshCosmetics(page: Page): Promise<void> {
    await Promise.all(page.frames().map((f) => this.refreshers.get(f)?.()));
  }

  /** Remove listeners and Fetch interception from every session this engine touched. */
  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.clear();
  }

  /** Session initializer (see Browser.addSessionInitializer). Runs before the frame's scripts start. */
  readonly initSession = async (frame: FrameSession): Promise<void> => {
    const s = frame.session;
    const page = frame.page;
    // Once per session: a page still initializing when the initializer is registered gets it twice.
    if (this.armed.has(s)) return;
    this.armed.add(s);
    const offs: Array<() => void> = [];
    const dispose = () => {
      for (const o of offs) o();
      this.armed.delete(s);
      // Chrome keeps the last setBlockedURLs list until it is cleared: undo it so detach() actually
      // stops blocking on this session, as its doc promises (the listeners above are already removed).
      void s.send("Network.setBlockedURLs", { urls: [] }).catch(() => undefined);
    };
    this.disposers.add(dispose);
    offs.push(() => this.disposers.delete(dispose));

    const head = this.hosts.slice(0, frame.isMain ? this.opts.maxHostPatterns ?? 30 : this.opts.maxFramePatterns ?? 30);
    const learn = this.opts.learn !== false;
    let site = siteOf(frame.url); // the current document's
    // A tab learns its next site before the document request; an OOPIF only when it commits.
    let siteKnown = frame.isMain || !!frame.url;
    let installed = new Set<string>();
    let applied: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const queued = new Set<string>(); // learned, waiting for the re-install
    // The head plus what this document's site has learned, and that site's exceptions.
    const apply = async (): Promise<void> => {
      const first = siteKnown ? head : head.filter((h) => !this.thirdPartyOnly.has(h));
      const hosts = [...new Set([...first, ...(this.learned.get(site) ?? [])])];
      const active = new Set(hosts);
      const extra = (this.tierA.siteAllow[site] ?? []).filter((h) => coveredBy(h, active));
      const key = `${hosts.join(",")}|${extra.join(",")}`;
      if (key === applied) return;
      applied = key;
      installed = active;
      await this.setBlocked(s, hosts, extra);
    };
    const reapply = () => void apply().catch((e: unknown) => this.error(page, "setBlockedURLs", e));
    // Sent now, answered later: the listeners and cosmetics below go in first, so a tab that answers only once
    // it is released (a noopener popup, Browser.sessionInitializers) has all of it from its first document.
    const installedFirst = apply().catch((e: unknown) => this.error(page, "setBlockedURLs", e));
    offs.push(() => clearTimeout(timer));
    // Site-specific exceptions and learned hosts: swap the patterns before the document request goes out.
    offs.push(
      s.on("Page.frameStartedNavigating", (e) => {
        if (e.frameId !== frame.frameId || e.navigationType === "sameDocument" || e.navigationType === "historySameDocument") return;
        site = siteOf(e.url);
        siteKnown = true;
        reapply();
      }),
      // A redirect can end on another site; an OOPIF's site is known from here on.
      s.on("Page.frameNavigated", (e) => {
        if (e.frame.id !== frame.frameId || (siteKnown && siteOf(e.frame.url) === site)) return;
        site = siteOf(e.frame.url);
        siteKnown = true;
        reapply();
      }),
    );

    // Stats: Tier A blocks show up as loadingFailed with blockedReason "inspector" (so do Tier B
    // failRequest calls, which armTierB counts itself and marks in `tierBFailed`).
    const urls = new Map<string, { url: string; type: string }>();
    const tierBFailed = new Set<string>();
    offs.push(
      s.on("Network.requestWillBeSent", (e) => {
        urls.set(e.requestId, { url: e.request.url, type: e.type ?? "Other" });
        if (urls.size > 2000) urls.delete(urls.keys().next().value!);
        // A listed host the patterns lack: learn it, and re-install once this burst of events is in.
        if (!learn || (e.type === "Document" && e.frameId === frame.frameId)) return;
        const host = this.learn(e.request.url, site, installed);
        if (!host || queued.has(host)) return;
        queued.add(host);
        this.pageStats(page).learnedHosts++;
        timer ??= setTimeout(() => {
          timer = undefined;
          queued.clear();
          reapply();
        }, LEARN_BATCH_MS);
      }),
      s.on("Network.loadingFinished", (e) => void urls.delete(e.requestId)),
      s.on("Network.loadingFailed", (e) => {
        const r = urls.get(e.requestId);
        urls.delete(e.requestId);
        if (tierBFailed.delete(e.requestId)) return;
        if (e.blockedReason === "inspector" && r) this.count(page, r.url, "A", r.type, false);
      }),
      s.on("Page.frameNavigated", (e) => {
        if (frame.isMain && !e.frame.parentId) this.resetPage(page);
      }),
    );

    if (this.opts.cosmetic !== false) this.armCosmetics(frame, offs);
    if (this.opts.tierB) this.armTierB(frame, offs, tierBFailed);
    await installedFirst;
  };

  // ---------------------------------------------------------------- Tier A

  /**
   * Current Chrome takes ordered `urlPatterns` (URLPattern syntax, block:false entries win). Older
   * Chrome requires `urls` (wildcards), so it rejects the modern call with invalid params; we then
   * use `urls` for that browser from then on. No separate probe: a probe on a session that never
   * answers (a wedged tab) would stall every later session.
   */
  private async setBlocked(s: CDPSession, hosts: string[], siteAllow: string[]): Promise<void> {
    const conn = s.connection as object;
    if (!this.legacy.has(conn)) {
      const holes = new Set(hosts.flatMap((h) => this.holes.get(h) ?? []));
      const allow = [...holes, ...siteAllow.map(hostUrlPattern)].map((urlPattern) => ({ urlPattern, block: false }));
      const block = hosts.map((h) => ({ urlPattern: hostUrlPattern(h), block: true }));
      try {
        await s.send("Network.setBlockedURLs", { urlPatterns: [...allow, ...block] });
        return;
      } catch (e) {
        if (!(e instanceof CDPError) || !/invalid param|urls/i.test(e.message)) throw e;
        this.legacy.add(conn);
      }
    }
    // No allow entries in the legacy form: drop every host that needs one.
    const skip = new Set(siteAllow);
    await s.send("Network.setBlockedURLs", { urls: hosts.filter((h) => !skip.has(h) && !this.holes.has(h)).flatMap(hostLegacyPatterns) });
  }

  /**
   * Record a request's host for `site` when a listed host covers it and the session's patterns do
   * not (`installed`). Returns that listed host (the session should re-install), or null.
   */
  private learn(url: string, site: string, installed: Set<string>): string | null {
    const host = safeHost(url);
    if (!host || coveredBy(host, installed)) return null;
    // The broadest listed host covering it: one pattern for all its subdomains.
    let listed = "";
    for (let h = host; h; h = h.slice(h.indexOf(".") + 1 || h.length)) if (this.listed.has(h)) listed = h;
    if (!listed) return null;
    // Allowed on this site anyway (e.g. a `$third-party` host on its own site).
    if ((this.tierA.siteAllow[site] ?? []).some((a) => hostIsUnder(host, a))) return null;
    let hosts = this.learned.get(site);
    if (hosts) this.learned.delete(site); // re-inserted below: most recently used last
    else hosts = new Set();
    this.learned.set(site, hosts);
    if (this.learned.size > MAX_LEARNED_SITES) this.learned.delete(this.learned.keys().next().value!);
    if (!hosts.has(listed)) {
      if (hosts.size >= (this.opts.maxLearnedPerSite ?? 200)) return null;
      hosts.add(listed);
    }
    return listed; // possibly learned by another session of the site since this one installed
  }

  // ---------------------------------------------------------------- Tier B

  private armTierB(frame: FrameSession, offs: Array<() => void>, failed: Set<string>): void {
    const s = frame.session;
    const frameUrls = new Map<string, string>([[frame.frameId, frame.url]]);
    offs.push(s.on("Page.frameNavigated", (e) => void frameUrls.set(e.frame.id, e.frame.url)));
    // On the session's shared interceptor: other features (write guards) pause requests too.
    const reg = RequestInterceptor.for(s).add({
      types: TIER_B_TYPES,
      onRequest: (e) => {
        const sourceUrl = frameUrls.get(e.frameId) ?? frame.url;
        let decision: ReturnType<AdBlockEngine["match"]> = { block: false };
        try {
          decision = this.match(e.request.url, sourceUrl, e.resourceType);
        } catch (err) {
          this.error(frame.page, "match", err);
        }
        if (decision.redirect) {
          const { body, contentType } = decision.redirect;
          const base64 = contentType.endsWith(";base64");
          this.count(frame.page, e.request.url, "B", e.resourceType, true);
          return {
            action: "fulfill",
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: base64 ? contentType.slice(0, -7) : contentType }, { name: "Access-Control-Allow-Origin", value: "*" }],
            body: base64 ? body : Buffer.from(body).toString("base64"),
          };
        }
        if (decision.block) {
          if (e.networkId) failed.add(e.networkId);
          this.count(frame.page, e.request.url, "B", e.resourceType, false);
          return { action: "fail", reason: "BlockedByClient" };
        }
        return undefined;
      },
    });
    offs.push(() => reg.remove());
    // Not awaited: on a target paused by waitForDebuggerOnStart, Fetch.enable only replies once the
    // renderer runs, i.e. after Runtime.runIfWaitingForDebugger. Session order still puts it first.
    reg.enabled.catch((e: unknown) => this.error(frame.page, "Fetch.enable", e));
  }

  // ---------------------------------------------------------------- cosmetics

  private armCosmetics(frame: FrameSession, offs: Array<() => void>): void {
    const s = frame.session;
    const urls = new Map<string, string>();
    const seen = new Map<string, Set<string>>(); // frameId -> selectors already injected in this document
    const inject = async (frameId: string, css: string): Promise<void> => {
      const fresh = newRules(css, seen.get(frameId) ?? seen.set(frameId, new Set()).get(frameId)!);
      if (!fresh.css) return;
      const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false });
      await s.send("Runtime.evaluate", { contextId: executionContextId, expression: `${CSS_HELPER}; __pfAbCss(${JSON.stringify(fresh.css)})`, returnByValue: true });
      this.pageStats(frame.page).hiddenSelectors += fresh.count;
    };
    const refine = async (frameId: string): Promise<void> => {
      const url = urls.get(frameId);
      if (!url) return;
      const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false });
      const res = await s.send("Runtime.evaluate", { contextId: executionContextId, expression: `(${extractFeaturesFromDOM.toString()})()`, returnByValue: true });
      const features = res.result.value as { classes: string[]; ids: string[]; hrefs: string[] } | undefined;
      if (features && urls.get(frameId) === url) await inject(frameId, this.cosmeticCss(url, features));
    };
    this.refreshers.set(frame, () => Promise.all([...urls.keys()].map((id) => refine(id).catch(() => undefined))).then(() => undefined));
    offs.push(
      s.on("Page.frameNavigated", (e) => {
        seen.delete(e.frame.id);
        if (!/^https?:/.test(e.frame.url)) return;
        urls.set(e.frame.id, e.frame.url);
        void inject(e.frame.id, this.cosmeticCss(e.frame.url)).catch(() => undefined);
      }),
      // Generic rules match ids/classes/hrefs found in the DOM: at DOMContentLoaded, load, and once
      // more shortly after load for late ad slots (refreshCosmetics() re-runs it on demand).
      s.on("Page.lifecycleEvent", (e) => {
        if (e.name === "DOMContentLoaded" || e.name === "load") void refine(e.frameId).catch(() => undefined);
        if (e.name === "load") setTimeout(() => void refine(e.frameId).catch(() => undefined), 2_000).unref();
      }),
      s.on("Page.frameDetached", (e) => {
        urls.delete(e.frameId);
        seen.delete(e.frameId);
      }),
    );
  }

  // ---------------------------------------------------------------- stats

  private pageStats(page: Page): AdBlockStats {
    let st = this.stats_.get(page);
    if (!st) {
      st = { blocked: 0, redirected: 0, byHost: {}, hiddenSelectors: 0, learnedHosts: 0, totalBlocked: 0, since: Date.now() };
      this.stats_.set(page, st);
    }
    return st;
  }

  private resetPage(page: Page): void {
    const st = this.pageStats(page);
    Object.assign(st, { blocked: 0, redirected: 0, byHost: {}, hiddenSelectors: 0, learnedHosts: 0, since: Date.now() });
  }

  private count(page: Page, url: string, tier: "A" | "B", type: string, redirected: boolean): void {
    const st = this.pageStats(page);
    if (redirected) st.redirected++;
    else {
      st.blocked++;
      st.totalBlocked++;
    }
    const host = safeHost(url);
    st.byHost[host] = (st.byHost[host] ?? 0) + 1;
    this.emitter.emit("blocked", { page, url, tier, type, redirected });
  }

  private error(page: Page | undefined, where: string, e: unknown): void {
    if (e instanceof SessionClosedError) return; // the frame went away: nothing to report
    // An "error" nobody listens to would be thrown by EventEmitter and take the process down.
    if (this.emitter.listenerCount("error") === 0) return;
    this.emitter.emit("error", { page, where, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Registrable domain of a URL ("" for about:blank and the like). */
function siteOf(url: string): string {
  return parseUrl(url).domain ?? "";
}

/** True when `host` is one of `active` or under one of them. */
function coveredBy(host: string, active: Set<string>): boolean {
  for (let h = host; h; h = h.slice(h.indexOf(".") + 1 || h.length)) if (active.has(h)) return true;
  return false;
}

/**
 * The rules of `css` ("a, b { style }" blocks) whose selectors are not in `seen`, one rule per
 * selector (one selector Chrome cannot parse would otherwise void a whole comma list); records them.
 */
export function newRules(css: string, seen: Set<string>): { css: string; count: number } {
  const out: string[] = [];
  for (const block of css.split("}")) {
    const open = block.indexOf("{");
    if (open < 0) continue;
    const body = block.slice(open + 1).trim();
    // Selectors are split on top-level commas only (":is(a, b)" stays whole).
    for (const sel of splitSelectors(block.slice(0, open))) {
      if (seen.has(sel)) continue;
      seen.add(sel);
      out.push(`${sel} { ${body} }`);
    }
  }
  return { css: out.join("\n"), count: out.length };
}

function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) {
      if (c === quote && list[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
