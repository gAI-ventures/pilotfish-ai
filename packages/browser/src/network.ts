// Per-session network activity tracker. Feeds the "settled" heuristic and the
// per-action evidence (how many requests an action triggered, and which write
// requests it caused). Network.enable is required on the session before
// constructing.

import { BlockList, isIP } from "node:net";
import type { CDPSession, Protocol } from "@pilotfish/cdp";
import { parse as parseDomain } from "tldts";

export interface NetworkStats {
  inflight: number;
  totalRequests: number;
  failed: number;
  lastActivityAt: number;
}

/** A state-changing request (POST/PUT/PATCH/DELETE, or a GraphQL mutation) seen on this session. */
export interface WriteRequest {
  requestId: string;
  method: string;
  url: string;
  startedAt: number;
  status?: number;
  endedAt?: number;
  failed?: string;
  /** Request body mentions a GraphQL mutation. */
  mutation: boolean;
}

/** Hosts and paths that carry analytics/telemetry rather than the user's action. */
const NOISE_HOST = /(^|\.)(unagi[\w-]*|fls-[\w-]*|aax[\w-]*|[\w-]*analytics[\w-]*|[\w-]*telemetry[\w-]*|[\w-]*metrics[\w-]*|[\w-]*beacon[\w-]*|[\w-]*pixel[\w-]*|[\w-]*tracking[\w-]*|[\w-]*adsystem[\w-]*|doubleclick|googletagmanager|google-analytics|sentry|datadoghq|newrelic|hotjar|segment|mixpanel|amplitude)\./i;
const NOISE_PATH = /((^|[\/_-])(marketing|analytics|tracking|tracker|data-?layer)|\/events?(\/|$)|\/log(ging)?(\/|$)|metric|beacon|telemetry|\/track(ing)?(\/|$)|\/collect(\/|$)|\/batch(\/|$)|uedata|\/csm(\/|$)|impression|\/rd\/|\/pixel|\/ping(\/|$)|\/v\d+\/(t|e|p)(\/|$))/i;

/**
 * The site a host belongs to, as browsers draw the line: its registrable domain under the Public
 * Suffix List, private section included (each *.github.io is its own site). IP addresses and
 * single-label hosts (localhost) are their own site.
 */
export function siteOf(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return "";
  const p = parseDomain(h, { allowPrivateDomains: true });
  return p.isIp ? h : (p.domain ?? h);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const AD_FRAME_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adtrafficquality\.google|amazon-adsystem\.com|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|pubmatic\.com|rubiconproject\.com|openx\.net|casalemedia\.com|moatads\.com|scorecardresearch\.com|adsrvr\.org|teads\.tv|yieldmo\.com|3lift\.com|sharethrough\.com|indexww\.com|bidswitch\.net|smartadserver\.com|media\.net|innovid\.com|serving-sys\.com)$/i;

/**
 * An iframe that only serves ads or tracking (a 1x1 sync pixel, an ad slot). Snapshots skip them:
 * their renderers are often busy (seconds per capture) and they hold nothing a task needs.
 */
export function isAdFrameUrl(url: string): boolean {
  const host = hostOf(url);
  return !!host && (AD_FRAME_HOST.test(host) || NOISE_HOST.test(host + "."));
}

/** True for third-party or telemetry traffic relative to the page's site. */
// Static files fetched by script (animation JSON, icons, fonts): never the data a page renders results from.
const STATIC_PATH = /^\/(assets?|static|images?|img|icons?|fonts?|media|dist|build)\/.*\.(json|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|css|m?js|map)$/i;

export function isNoiseRequest(url: string, pageHost: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  if (pageHost && siteOf(host) !== siteOf(pageHost)) return true;
  if (NOISE_HOST.test(host + ".")) return true;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }
  return NOISE_PATH.test(path) || STATIC_PATH.test(path);
}

/** A WebSocket the page opened: when, whether its handshake is done, and its latest frame each way (0: none yet). */
export interface SocketActivity {
  url: string;
  createdAt: number;
  open: boolean;
  lastSent: number;
  lastReceived: number;
}

export class NetworkTracker {
  private readonly inflight = new Map<string, { url: string; type: string; startedAt: number }>();
  /** Open WebSockets (bounded): pages that get their results over one (Wolfram|Alpha's pods) send no request for them. */
  private readonly sockets = new Map<string, SocketActivity>();
  private readonly writes = new Map<string, WriteRequest>();
  /** Start times and URLs of recent requests (bounded), for "did this action cause any network activity?". */
  private readonly recent: Array<{ t: number; url: string; type: string }> = [];
  private total = 0;
  private failed = 0;
  private lastActivityAt = Date.now();
  private readonly disposers: Array<() => void> = [];
  /** Requests that have been in flight longer than this are ignored for idleness (long-poll, SSE, media). */
  longPollMs = 8_000;

  constructor(private readonly session: CDPSession) {
    this.disposers.push(
      session.on("Network.requestWillBeSent", (e) => {
        this.inflight.set(e.requestId, { url: e.request.url, type: e.type ?? "Other", startedAt: Date.now() });
        this.recent.push({ t: Date.now(), url: e.request.url, type: e.type ?? "Other" });
        if (this.recent.length > 400) this.recent.shift();
        this.total++;
        this.lastActivityAt = Date.now();
        const method = e.request.method.toUpperCase();
        const post = e.request.postData ?? "";
        const mutation = /\bmutation\b/.test(post.slice(0, 2000));
        const isGraphql = /graphql/i.test(e.request.url);
        if (e.type !== "Ping" && !["GET", "HEAD", "OPTIONS"].includes(method) && (!isGraphql || mutation)) {
          this.writes.set(e.requestId, { requestId: e.requestId, method, url: e.request.url, startedAt: Date.now(), mutation });
          if (this.writes.size > 300) this.writes.delete(this.writes.keys().next().value!);
        }
      }),
      session.on("Network.responseReceived", (e) => {
        const w = this.writes.get(e.requestId);
        if (w) w.status = e.response.status;
      }),
      session.on("Network.loadingFinished", (e) => this.finish(e.requestId)),
      session.on("Network.loadingFailed", (e: Protocol.Network.LoadingFailedEvent) => {
        if (!e.canceled) this.failed++;
        const w = this.writes.get(e.requestId);
        if (w) w.failed = e.canceled ? "canceled" : e.errorText;
        this.finish(e.requestId);
      }),
      session.on("Network.requestServedFromCache", (e) => this.finish(e.requestId)),
      // WebSockets and EventSources are never "finished"; don't count them as pending.
      session.on("Network.webSocketCreated", (e) => {
        this.inflight.delete(e.requestId);
        this.sockets.set(e.requestId, { url: e.url, createdAt: Date.now(), open: false, lastSent: 0, lastReceived: 0 });
        if (this.sockets.size > 50) this.sockets.delete(this.sockets.keys().next().value!);
      }),
      session.on("Network.webSocketHandshakeResponseReceived", (e) => {
        const s = this.sockets.get(e.requestId);
        if (s) s.open = true;
      }),
      session.on("Network.webSocketFrameSent", (e) => {
        const s = this.sockets.get(e.requestId);
        if (s) s.lastSent = Date.now();
      }),
      session.on("Network.webSocketFrameReceived", (e) => {
        const s = this.sockets.get(e.requestId);
        if (s) s.lastReceived = Date.now();
      }),
      session.on("Network.webSocketClosed", (e) => this.sockets.delete(e.requestId)),
      session.on("Network.eventSourceMessageReceived", (e) => this.inflight.delete(e.requestId)),
    );
  }

  /**
   * WebSockets an action touched: opened at or after `since`, or sent a frame then (a query the page sent over it).
   * `ignore` drops third-party ones (chat widgets, analytics) by URL.
   */
  socketsSince(since: number, ignore?: (url: string) => boolean): SocketActivity[] {
    return [...this.sockets.values()].filter((s) => (s.createdAt >= since || s.lastSent >= since) && !ignore?.(s.url));
  }

  /** A WebSocket still connecting (opened within 10 s), or one with a frame either way in the last `withinMs`. */
  socketBusy(withinMs: number, ignore?: (url: string) => boolean, now = Date.now()): boolean {
    for (const s of this.sockets.values()) {
      if (ignore?.(s.url)) continue;
      if (!s.open && now - s.createdAt < 10_000) return true;
      if (now - Math.max(s.lastSent, s.lastReceived) < withinMs) return true;
    }
    return false;
  }

  private finish(requestId: string): void {
    const w = this.writes.get(requestId);
    if (w && !w.endedAt) w.endedAt = Date.now();
    if (this.inflight.delete(requestId)) this.lastActivityAt = Date.now();
  }

  /** Number of requests considered "pending" for idleness purposes. `ignore` drops e.g. telemetry/third-party URLs. */
  pendingCount(now = Date.now(), ignore?: (url: string) => boolean): number {
    let n = 0;
    for (const r of this.inflight.values()) {
      if (r.type === "WebSocket" || r.type === "EventSource" || r.type === "Media") continue;
      if (now - r.startedAt > this.longPollMs) continue;
      if (ignore?.(r.url)) continue;
      n++;
    }
    return n;
  }

  /** In-flight XHR/fetch requests (the data a single-page app renders from), excluding long polls and `ignore`d URLs. */
  pendingData(now = Date.now(), ignore?: (url: string) => boolean, maxAgeMs = this.longPollMs): number {
    let n = 0;
    for (const r of this.inflight.values()) {
      if (r.type !== "XHR" && r.type !== "Fetch") continue;
      if (now - r.startedAt > maxAgeMs) continue;
      if (ignore?.(r.url)) continue;
      n++;
    }
    return n;
  }

  /** All in-flight requests except WebSockets/EventSources, including long-running ones (for diagnostics). */
  inflightTotal(): number {
    let n = 0;
    for (const r of this.inflight.values()) if (r.type !== "WebSocket" && r.type !== "EventSource") n++;
    return n;
  }

  /** Requests started at or after `since` that are still in flight (long polls and `ignore`d URLs left out). */
  pendingSince(since: number, ignore?: (url: string) => boolean, now = Date.now()): number {
    let n = 0;
    for (const r of this.inflight.values()) {
      if (r.startedAt < since || now - r.startedAt > this.longPollMs) continue;
      if (r.type === "WebSocket" || r.type === "EventSource" || r.type === "Media" || r.type === "Ping") continue;
      if (ignore?.(r.url)) continue;
      n++;
    }
    return n;
  }

  /** Requests started at or after `since`, excluding ones `ignore` rejects (telemetry, third party). */
  requestsSince(since: number, ignore?: (url: string) => boolean): number {
    let n = 0;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const r = this.recent[i]!;
      if (r.t < since) break;
      if (r.type === "WebSocket" || r.type === "EventSource" || r.type === "Ping") continue;
      if (ignore?.(r.url)) continue;
      n++;
    }
    return n;
  }

  /** First-party, non-telemetry write requests started at or after `since`. */
  writesSince(since: number, pageHost: string): WriteRequest[] {
    return [...this.writes.values()].filter((w) => w.startedAt >= since && !isNoiseRequest(w.url, pageHost));
  }

  stats(): NetworkStats {
    return { inflight: this.pendingCount(), totalRequests: this.total, failed: this.failed, lastActivityAt: this.lastActivityAt };
  }

  /** Snapshot counters so an action can report the delta it caused. */
  mark(): { total: number; failed: number } {
    return { total: this.total, failed: this.failed };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

/**
 * Wait until all tracked sessions have ≤ `maxPending` pending requests for
 * `quietMs`, bounded by `timeoutMs`. Resolves with whether idleness was reached.
 */
export async function waitForNetworkIdle(
  trackers: Iterable<NetworkTracker>,
  { quietMs = 500, timeoutMs = 3_000, maxPending = 0, ignore }: { quietMs?: number; timeoutMs?: number; maxPending?: number; ignore?: (url: string) => boolean } = {},
): Promise<boolean> {
  const list = [...trackers];
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    const now = Date.now();
    const pending = list.reduce((n, t) => n + t.pendingCount(now, ignore), 0);
    if (pending <= maxPending) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    } else {
      quietSince = null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Ranges a page must not reach through us (RFC 6890: not globally reachable). */
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: the cloud metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated, still routed by some stacks)
  ["ff00::", 8], // multicast
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv6");

/** The eight 16-bit groups of a valid IPv6 address (a dotted IPv4 tail included). */
function v6Groups(ip: string): number[] {
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const s = tail ? `${ip.slice(0, tail.index)}${((+tail[1]! << 8) | +tail[2]!).toString(16)}:${((+tail[3]! << 8) | +tail[4]!).toString(16)}` : ip;
  const [head = "", rest] = s.split("::");
  const groups = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const h = groups(head);
  const r = rest === undefined ? [] : groups(rest);
  return [...h, ...new Array<number>(Math.max(0, 8 - h.length - r.length)).fill(0), ...r];
}

/**
 * The IPv4 address an IPv6 one reaches: IPv4-mapped (::ffff:0:0/96, how a URL serialises
 * [::ffff:127.0.0.1] as ::ffff:7f00:1), IPv4-translated (::ffff:0:0:0/96), IPv4-compatible (::/96),
 * NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Null for any other.
 */
function embeddedV4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if ((zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0) || zero(0, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/**
 * An address a page must not reach through us: loopback, private, link-local (metadata), CGNAT, reserved,
 * multicast or unspecified, also when an IPv6 form carries such an IPv4 address (hex or dotted). Anything
 * that is not an IP address counts as non-public (fail closed). One classifier for every guard.
 */
export function isNonPublicAddress(ip: string): boolean {
  const addr = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(addr);
  if (family === 4) return NON_PUBLIC.check(addr, "ipv4");
  if (family !== 6) return true;
  const v4 = embeddedV4(v6Groups(addr.toLowerCase()));
  return (v4 !== null && NON_PUBLIC.check(v4, "ipv4")) || NON_PUBLIC.check(addr, "ipv6");
}

/**
 * Chrome's own background services (component and extension updates, safe-browsing lists, autofill
 * and optimization hints) go direct, never through a proxy: a proxy may bill by the byte
 * (update.googleapis.com alone made 89 requests in a day) and no site sees them.
 */
export const CHROME_SERVICE_HOSTS = [
  "update.googleapis.com",
  "*.gvt1.com",
  "clients2.google.com",
  "clients2.googleusercontent.com",
  "optimizationguide-pa.googleapis.com",
  "safebrowsing.googleapis.com",
  "safebrowsingohttpgateway.googleapis.com",
  "content-autofill.googleapis.com",
];
