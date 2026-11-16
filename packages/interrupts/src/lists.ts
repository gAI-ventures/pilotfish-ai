// Filter lists: fetch the upstream lists at first use, strip what must never be blocked or hidden,
// build the @ghostery/adblocker engine, derive the Tier A host list, and cache both on disk.
//
// No list content is vendored: EasyList/EasyPrivacy/uBO lists are GPL/CC-BY-SA and are fetched
// from their official URLs. Load order: fresh cache -> upstream lists -> Ghostery's mirror of the
// same lists (the package's "prebuilt ads+tracking" set) -> stale cache -> a tiny built-in seed.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { FiltersEngine, parseFilters, adsAndTrackingLists, fetchResources, ENGINE_VERSION } from "@ghostery/adblocker";
import type { CosmeticFilter, NetworkFilter, Fetch } from "@ghostery/adblocker";
import { getDomain } from "tldts-experimental";
import { PROTECTED_SELECTOR, PROTECTED_URL, NEVER_BLOCK, hostIsUnder, hostTouchesProtected, hostUrlPattern } from "./hosts.js";

/** Official list URLs, each with a mirror. */
export const UPSTREAM_LISTS: ReadonlyArray<readonly string[]> = [
  ["https://easylist.to/easylist/easylist.txt", "https://easylist-downloads.adblockplus.org/easylist.txt"],
  ["https://easylist.to/easylist/easyprivacy.txt", "https://easylist-downloads.adblockplus.org/easyprivacy.txt"],
  ["https://ublockorigin.github.io/uAssets/filters/filters.txt", "https://ublockorigin.pages.dev/filters/filters.txt"],
  ["https://ublockorigin.github.io/uAssets/filters/privacy.txt", "https://ublockorigin.pages.dev/filters/privacy.txt"],
];

/**
 * Major ad/tracker networks (our own list): the last resort when offline with no cache, and the
 * Tier A hosts every session installs first.
 */
export const SEED_HOSTS: readonly string[] = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adnxs.com", "criteo.com", "criteo.net",
  "taboola.com", "outbrain.com", "amazon-adsystem.com", "scorecardresearch.com", "quantserve.com",
  "rubiconproject.com", "pubmatic.com", "openx.net", "casalemedia.com", "adsrvr.org", "bidswitch.net", "3lift.com",
  "sharethrough.com", "teads.tv", "moatads.com", "doubleverify.com", "adsafeprotected.com", "hotjar.com",
  "chartbeat.com", "chartbeat.net", "smartadserver.com", "adform.net", "media.net", "mathtag.com", "bluekai.com",
  "demdex.net", "krxd.net", "exelator.com", "agkn.com", "rlcdn.com",
];

/** Engine features we use: network matching and CSS hiding. No scriptlets, procedural selectors or CSP. */
const ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadExtendedSelectors: false,
  loadCSPFilters: false,
  enableHtmlFiltering: false,
} as const;

/** Bump when the cache layout or the stripping/derivation rules change. */
const FORMAT = 2;
/** Ranked hosts kept in the cache; sessions take a prefix. */
const STORED_HOSTS = 6000;

export interface TierA {
  /** Hosts to block with their subdomains, most prevalent first. */
  hosts: string[];
  /** URLPatterns allowed through for a blocked host: generically excepted subdomains, surrogate-served URLs. */
  allow: Array<{ host: string; pattern: string }>;
  /** Page site (registrable domain) -> hosts to allow on that site (site-specific exceptions, `$third-party` rules on their own site). */
  siteAllow: Record<string, string[]>;
}

export type ListSource = "inline" | "cache" | "upstream" | "mirror" | "stale-cache" | "seed";

export interface LoadedLists {
  engine: FiltersEngine;
  tierA: TierA;
  source: ListSource;
  builtAt: number;
}

export interface LoadListsOptions {
  /** Raw filter-list text to use instead of fetching (tests, custom deployments). Not cached. */
  filters?: string;
  /** Default ~/.pilotfish/adblock. */
  cacheDir?: string;
  /** Refresh the cache when older than this. Default 7 days. */
  maxAgeMs?: number;
  /** Download a URL as text, rejecting on HTTP errors. Default: node:https (see httpText). */
  fetchText?: FetchText;
  /** Called with the outcome of a background refresh of a stale cache. */
  onRefresh?: (result: LoadedLists | Error) => void;
}

export type FetchText = (url: string) => Promise<string>;

export function defaultCacheDir(): string {
  return join(homedir(), ".pilotfish", "adblock");
}

// ------------------------------------------------------------------ fetching

/**
 * GET a URL as text with node:https (gzip/br, redirects, 20 s timeout). Not global fetch: Node 22's
 * bundled undici dies on an uncatchable `assert(!this.paused)` when a dozen multi-MB gzip list
 * downloads run concurrently and a server closes the socket mid-body.
 */
export const httpText: FetchText = (url) => httpGet(url, 5);

function httpGet(url: string, redirects: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("http:") ? httpRequest : httpsRequest)(url, { headers: { "accept-encoding": "gzip, br", "user-agent": "pilotfish-adblock" }, timeout: 20_000 }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        resolve(httpGet(new URL(location, url).href, redirects - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`${url}: HTTP ${status}`));
        return;
      }
      const enc = res.headers["content-encoding"];
      const body = enc === "gzip" ? res.pipe(createGunzip()) : enc === "br" ? res.pipe(createBrotliDecompress()) : res;
      const chunks: Buffer[] = [];
      body.on("data", (c: Buffer) => chunks.push(c));
      body.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      body.on("error", reject);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${url}: timed out`)));
    req.on("error", reject);
    req.end();
  });
}

/** Fetch one list, trying mirrors in order, and inline its `!#include` files (one level, same origin). */
export async function fetchList(fetchText: FetchText, urls: readonly string[]): Promise<string> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const text = await fetchText(url);
      const includes = [...text.matchAll(/^!#include (\S+)\s*$/gm)].map((m) => new URL(m[1]!, url));
      // A missing include (mirrors do not carry every file) drops that part, not the whole list.
      const parts = await Promise.all(
        includes.filter((u) => u.origin === new URL(url).origin).map((u) => fetchText(u.href).catch(() => "")),
      );
      return [text, ...parts].join("\n");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ------------------------------------------------------------------ stripping

/** True for a network filter we keep: exceptions always; never one that could block a protected host or a CMP/paywall script. */
function keepNetwork(f: NetworkFilter): boolean {
  if (f.isException()) return true;
  const host = f.hasHostname() ? f.getHostname() : "";
  if (host && NEVER_BLOCK.some((r) => !r.includes("/") && hostIsUnder(host, r))) return false;
  return !PROTECTED_URL.test(host + (f.getFilter() ?? ""));
}

/** True for a cosmetic filter we keep: CSS hiding only, never a consent banner or a paywall. */
function keepCosmetic(c: CosmeticFilter): boolean {
  if (c.isScriptInject() || c.isExtended() || c.isHtmlFiltering() || c.isRemove()) return false;
  return c.isUnhide() || !PROTECTED_SELECTOR.test(c.getSelector());
}

/** Parse filter text and build an engine without the rules we must never apply. */
export function buildEngine(text: string): FiltersEngine {
  const parsed = parseFilters(text, ENGINE_CONFIG);
  return new FiltersEngine({
    networkFilters: parsed.networkFilters.filter(keepNetwork),
    cosmeticFilters: parsed.cosmeticFilters.filter(keepCosmetic),
    preprocessors: parsed.preprocessors,
    config: ENGINE_CONFIG,
  });
}

// ------------------------------------------------------------------ Tier A

const NET_LINE = /^(@@)?\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])([^$]*)(?:\$(.*))?$/;
/** Options that keep `||host^` a whole-host rule. */
const PURE_OPTS = new Set(["third-party", "3p", "important", "all"]);
/** Exception options that do not unblock network requests. */
const NON_NETWORK_EXCEPTION = new Set(["generichide", "ghide", "elemhide", "ehide", "specifichide", "shide", "document", "doc", "popup", "csp", "removeparam", "urlskip", "permissions", "header", "redirect", "redirect-rule"]);
/** More allow entries than this and a host is too porous to block wholesale. */
const MAX_HOLES = 8;

interface LineRule {
  exception: boolean;
  host: string;
  /** What follows the host: "^" for a whole-host rule, "/path" for a path rule. */
  rest: string;
  pure: boolean;
  thirdParty: boolean;
  badfilter: boolean;
  redirect: boolean;
  sites: string[]; // positive $domain= / $from= entries
  networkException: boolean;
}

function parseLine(line: string): LineRule | null {
  const m = NET_LINE.exec(line);
  if (!m) return null;
  const opts = (m[4] ?? "").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
  const names = opts.map((o) => o.split("=")[0]!);
  const sites: string[] = [];
  for (const o of opts) {
    const [k, v] = o.split("=");
    if ((k === "domain" || k === "from") && v) for (const d of v.split("|")) if (!d.startsWith("~") && !d.includes("*")) sites.push(d);
  }
  const rest = m[3] ?? "";
  const plainOpts = names.filter((n) => n !== "badfilter");
  return {
    exception: !!m[1],
    host: m[2]!,
    rest,
    pure: !m[1] && (rest === "^" || rest === "^|") && plainOpts.every((n) => PURE_OPTS.has(n)),
    thirdParty: names.includes("third-party") || names.includes("3p"),
    badfilter: names.includes("badfilter"),
    redirect: names.some((n) => n === "redirect" || n === "redirect-rule"),
    sites,
    networkException: !!m[1] && !(names.length > 0 && names.every((n) => NON_NETWORK_EXCEPTION.has(n))),
  };
}

const siteOf = (host: string): string => getDomain(host) ?? host;

/**
 * An ABP path ("/a/*.js^") as a URLPattern pathname prefix, or null when it cannot be expressed.
 * Always at least as broad as the original (`^` and the query part widen to `*`): an allow entry
 * that is too broad only under-blocks.
 */
export function abpPathPattern(rest: string): string | null {
  if (!rest.startsWith("/")) return null;
  const path = rest.split(/[?#|]/)[0]!.replace(/\^/g, "*");
  if (!/^\/[A-Za-z0-9._~%/*=,;!@:()+-]*$/.test(path)) return null;
  return (path.replace(/[:()+]/g, (c) => "\\" + c) + "*").replace(/\*+/g, "*");
}

/**
 * Derive the Tier A host list from raw filter text: whole-host block rules (`||host^`, optionally
 * `$third-party`/`$important`), minus hosts touching the allow-list and hosts excepted as a whole,
 * ranked by how many other network rules target their registrable domain (a prevalence proxy: a
 * one-off popunder domain has its single rule, doubleclick.net has dozens of path rules, exceptions
 * and site fixes). Generic exceptions inside a blocked host, and the URLs the lists answer with a
 * surrogate script (`$redirect`, e.g. gpt.js, beacon.js), become allow entries: Tier A cannot serve
 * a surrogate, so it lets those through rather than break the page.
 */
export function deriveTierA(text: string, max = STORED_HOSTS): TierA {
  const pure = new Map<string, boolean>(); // host -> third-party only
  const bad = new Set<string>();
  // site -> generic exceptions and generic surrogate rules (path null: the whole host)
  const holes = new Map<string, Array<{ host: string; path: string | null }>>();
  const siteExceptions = new Map<string, Array<{ host: string; sites: string[] }>>();
  const mentions = new Map<string, number>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    const r = parseLine(line);
    if (r?.pure) {
      if (r.badfilter) bad.add(r.host);
      else pure.set(r.host, (pure.get(r.host) ?? true) && r.thirdParty);
      continue;
    }
    if (!r) continue;
    if (r.exception && r.networkException && r.sites.length) push(siteExceptions, siteOf(r.host), { host: r.host, sites: r.sites });
    else if ((r.exception && r.networkException) || (!r.exception && r.redirect && !r.sites.length)) {
      push(holes, siteOf(r.host), { host: r.host, path: abpPathPattern(r.rest) });
    }
    // Prevalence: rules aimed at requests *to* this domain (paths, exceptions, per-site variants).
    // Publisher domains, which appear in `$domain=` options and cosmetic rules, do not count.
    const site = siteOf(r.host);
    mentions.set(site, (mentions.get(site) ?? 0) + 1);
  }

  const allowFor = new Map<string, string[]>(); // blocked host -> allow patterns it needs
  const groups = new Map<string, string[]>();
  candidates: for (const [host] of pure) {
    if (bad.has(host) || hostTouchesProtected(host)) continue;
    const site = siteOf(host);
    const patterns = new Set<string>();
    for (const hole of holes.get(site) ?? []) {
      if (!hostIsUnder(hole.host, host) && !hostIsUnder(host, hole.host)) continue;
      if (hole.path) patterns.add(`*://{*.}?${hole.host}:*${hole.path}`);
      else if (hole.host !== host && hostIsUnder(hole.host, host)) patterns.add(hostUrlPattern(hole.host));
      else continue candidates; // excepted or surrogate-served as a whole: Tier B only
    }
    if (patterns.size > MAX_HOLES) continue;
    if (patterns.size) allowFor.set(host, [...patterns]);
    push(groups, site, host);
  }
  // A domain-level rule covers its subdomains; otherwise keep a few subdomains per domain.
  const ranked = [...groups]
    .map(([site, hosts]) => ({ site, hosts: hosts.includes(site) ? [site] : hosts.sort((a, b) => a.length - b.length).slice(0, 4), score: mentions.get(site) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.hosts.length - b.hosts.length || (a.site < b.site ? -1 : 1));
  const hosts: string[] = [];
  for (const g of ranked) {
    for (const h of g.hosts) if (hosts.length < max) hosts.push(h);
    if (hosts.length >= max) break;
  }

  const siteAllow: Record<string, string[]> = {};
  const addSiteAllow = (site: string, host: string) => {
    const list = (siteAllow[siteOf(site)] ??= []);
    if (!list.includes(host)) list.push(host);
  };
  for (const h of hosts) {
    if (pure.get(h)) addSiteAllow(h, h); // `$third-party`: first-party use on its own site is allowed
    for (const e of siteExceptions.get(siteOf(h)) ?? []) {
      if (hostIsUnder(h, e.host) || hostIsUnder(e.host, h)) for (const s of e.sites) addSiteAllow(s, hostIsUnder(h, e.host) ? h : e.host);
    }
  }
  const allow = hosts.flatMap((host) => (allowFor.get(host) ?? []).map((pattern) => ({ host, pattern })));
  return { hosts, allow, siteAllow };
}

// ------------------------------------------------------------------ loading and cache

async function buildFrom(text: string, fetchText: FetchText | null): Promise<{ engine: FiltersEngine; tierA: TierA }> {
  const engine = buildEngine(text);
  if (fetchText) {
    // uBO surrogate scripts for Tier B redirects (fetched, not vendored). Optional.
    const adapter: Fetch = (url) => fetchText(url).then((t) => ({ text: async () => t, json: async () => JSON.parse(t), arrayBuffer: async () => new TextEncoder().encode(t).buffer }));
    const resources = await fetchResources(adapter).catch(() => undefined);
    try {
      if (resources) engine.updateResources(resources, String(resources.length));
    } catch {
      /* unparsable resources: Tier B fails redirected requests instead of answering with a surrogate */
    }
  }
  return { engine, tierA: deriveTierA(text) };
}

interface CacheMeta {
  format: number;
  engineVersion: number;
  builtAt: number;
  source: ListSource;
  tierA: TierA;
}

async function readCache(dir: string): Promise<(LoadedLists & { ageMs: number }) | null> {
  try {
    const meta = JSON.parse(await readFile(join(dir, "tier-a.json"), "utf8")) as CacheMeta;
    if (meta.format !== FORMAT || meta.engineVersion !== ENGINE_VERSION) return null;
    const bin = await readFile(join(dir, "engine.bin"));
    const engine = FiltersEngine.deserialize(new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength));
    return { engine, tierA: meta.tierA, source: "cache", builtAt: meta.builtAt, ageMs: Date.now() - meta.builtAt };
  } catch {
    return null;
  }
}

async function writeCache(dir: string, lists: LoadedLists): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `.${process.pid}.${Date.now()}.tmp`;
  const meta: CacheMeta = { format: FORMAT, engineVersion: ENGINE_VERSION, builtAt: lists.builtAt, source: lists.source, tierA: lists.tierA };
  // Write-then-rename so concurrent processes never read a torn file.
  await writeFile(join(dir, "engine.bin" + tmp), lists.engine.serialize());
  await writeFile(join(dir, "tier-a.json" + tmp), JSON.stringify(meta));
  await rename(join(dir, "engine.bin" + tmp), join(dir, "engine.bin"));
  await rename(join(dir, "tier-a.json" + tmp), join(dir, "tier-a.json"));
}

/** Fetch and build from upstream, then Ghostery's mirror; null if both fail. */
async function fetchAndBuild(fetchText: FetchText): Promise<LoadedLists | null> {
  const attempts: Array<[ListSource, ReadonlyArray<readonly string[]>]> = [
    ["upstream", UPSTREAM_LISTS],
    ["mirror", adsAndTrackingLists.map((u) => [u])],
  ];
  for (const [source, lists] of attempts) {
    try {
      const texts = await Promise.all(lists.map((urls) => fetchList(fetchText, urls)));
      return { ...(await buildFrom(texts.join("\n"), fetchText)), source, builtAt: Date.now() };
    } catch {
      /* next source */
    }
  }
  return null;
}

/** Load the engine and Tier A list, following the fallback order in the file header. */
export async function loadLists(opts: LoadListsOptions = {}): Promise<LoadedLists> {
  if (opts.filters !== undefined) {
    return { ...(await buildFrom(opts.filters, null)), source: "inline", builtAt: Date.now() };
  }
  const seed = async (): Promise<LoadedLists> => ({ ...(await buildFrom(SEED_HOSTS.map((h) => `||${h}^$third-party`).join("\n"), null)), source: "seed", builtAt: Date.now() });
  // PILOTFISH_ADBLOCK_OFFLINE=1 (CI): no downloads, the built-in seed list only (unless a caller brings its own fetch).
  if (!opts.fetchText && /^(1|true|yes|on)$/i.test(process.env["PILOTFISH_ADBLOCK_OFFLINE"] ?? "")) return seed();
  const dir = opts.cacheDir ?? defaultCacheDir();
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600_000;
  const fetchText = opts.fetchText ?? httpText;
  const cached = await readCache(dir);
  if (cached && cached.ageMs < maxAgeMs) return cached;
  if (cached) {
    // Stale: serve it now, refresh in the background for the next start.
    void fetchAndBuild(fetchText).then(
      async (fresh) => {
        if (!fresh) throw new Error("all list sources failed");
        await writeCache(dir, fresh);
        opts.onRefresh?.(fresh);
      },
    ).catch((e: unknown) => opts.onRefresh?.(e instanceof Error ? e : new Error(String(e))));
    return { ...cached, source: "stale-cache" };
  }
  const fresh = await fetchAndBuild(fetchText);
  if (fresh) {
    await writeCache(dir, fresh).catch(() => undefined);
    return fresh;
  }
  return seed();
}
