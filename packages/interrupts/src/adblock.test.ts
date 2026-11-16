import { describe, expect, it } from "vitest";
import type { FrameSession } from "@pilotfish/browser";
import { AdBlockEngine, newRules } from "./adblock.js";

/** A frame session that records commands and lets the test emit events. */
function fakeFrame(url: string, isMain = true) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const sent: Array<{ method: string; params: any }> = [];
  const session = {
    connection: {},
    async send(method: string, params: unknown) {
      sent.push({ method, params });
      return {};
    },
    on(event: string, fn: (e: unknown) => void) {
      const set = listeners.get(event) ?? listeners.set(event, new Set()).get(event)!;
      set.add(fn);
      return () => void set.delete(fn);
    },
  };
  const page = {};
  const frame = { session, page, isMain, url, frameId: "F1" } as unknown as FrameSession;
  let n = 0;
  return {
    frame,
    page: page as never,
    emit: (event: string, e: unknown) => listeners.get(event)?.forEach((fn) => fn(e)),
    request: (u: string, type = "Script") => listeners.get("Network.requestWillBeSent")?.forEach((fn) => fn({ requestId: String(++n), frameId: "F2", type, request: { url: u } })),
    /** URLPatterns of the last Network.setBlockedURLs call, split by allow/block. */
    patterns() {
      const last = sent.filter((c) => c.method === "Network.setBlockedURLs").at(-1)?.params.urlPatterns as Array<{ urlPattern: string; block: boolean }>;
      return { block: last.filter((p) => p.block).map((p) => p.urlPattern), allow: last.filter((p) => !p.block).map((p) => p.urlPattern) };
    },
    installs: () => sent.filter((c) => c.method === "Network.setBlockedURLs").length,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("Tier A patterns", () => {
  // Prevalence order (rules per domain): big.example, then mid.example, then small.example.
  const filters = [
    "||big.example^", "||big.example/a.js", "||big.example/b.js", "||big.example/c.js",
    "||mid.example^", "||mid.example/a.js",
    "||small.example^$third-party",
    "||stripe.com^", // protected: never in Tier A
  ].join("\n");

  it("installs a short head and no allow-list entries for protected hosts", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 1 });
    const f = fakeFrame("https://news.example/");
    await e.initSession(f.frame);
    expect(f.patterns()).toEqual({ block: ["*://{*.}?big.example:*/*"], allow: [] });
  });

  it("learns a listed host on its first request and blocks it from then on, for the whole site", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 1 });
    const f = fakeFrame("https://news.example/");
    await e.initSession(f.frame);
    f.request("https://cdn.mid.example/tag.js");
    f.request("https://x.mid.example/pixel.gif"); // same burst: one re-install
    f.request("https://unlisted.example/app.js");
    f.request("https://big.example/a.js"); // already blocked
    await settle();
    expect(f.installs()).toBe(2);
    expect(f.patterns().block).toEqual(["*://{*.}?big.example:*/*", "*://{*.}?mid.example:*/*"]);
    expect(e.stats(f.page).learnedHosts).toBe(1);
    // Another document of the same site starts with it; another site does not.
    const same = fakeFrame("https://www.news.example/other");
    await e.initSession(same.frame);
    expect(same.patterns().block).toContain("*://{*.}?mid.example:*/*");
    const other = fakeFrame("https://shop.example/");
    await e.initSession(other.frame);
    expect(other.patterns().block).toEqual(["*://{*.}?big.example:*/*"]);
  });

  it("does not learn a host the site allows, its own main document, or with learn off", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 0 });
    const own = fakeFrame("https://small.example/"); // $third-party host on its own site
    await e.initSession(own.frame);
    own.request("https://cdn.small.example/x.js");
    own.emit("Network.requestWillBeSent", { requestId: "d", frameId: "F1", type: "Document", request: { url: "https://big.example/" } });
    await settle();
    expect(own.installs()).toBe(1);
    const off = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 0, learn: false });
    const f = fakeFrame("https://news.example/");
    await off.initSession(f.frame);
    f.request("https://big.example/a.js");
    await settle();
    expect(f.installs()).toBe(1);
    expect(f.patterns().block).toEqual([]);
  });

  it("leaves third-party-only hosts out of an out-of-process iframe's head until its site is known", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxFramePatterns: 10 });
    const f = fakeFrame("", false); // OOPIFs attach before their URL is known
    await e.initSession(f.frame);
    expect(f.patterns().block).toEqual(["*://{*.}?big.example:*/*", "*://{*.}?mid.example:*/*"]);
    f.emit("Page.frameNavigated", { frame: { id: "F1", url: "https://cdn.small.example/frame.html" } });
    await settle();
    // On its own site, small.example is installed and allowed again by the site's exception.
    expect(f.patterns()).toEqual({ block: ["*://{*.}?big.example:*/*", "*://{*.}?mid.example:*/*", "*://{*.}?small.example:*/*"], allow: ["*://{*.}?small.example:*/*"] });
  });

  it("swaps to the new site's learned hosts when the frame navigates", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 0 });
    const a = fakeFrame("https://a.example/");
    await e.initSession(a.frame);
    a.request("https://mid.example/t.js");
    await settle();
    expect(a.patterns().block).toEqual(["*://{*.}?mid.example:*/*"]);
    a.emit("Page.frameStartedNavigating", { frameId: "F1", url: "https://b.example/", navigationType: "differentDocument" });
    await settle();
    expect(a.patterns().block).toEqual([]);
  });
});

describe("first-party anti-bot sensors", () => {
  // The EasyList/EasyPrivacy/uBO rules that hit sensors in the cached lists (offline check, Oct 2026).
  const filters = [
    "/\\/api\\/v2\\/collector/",
    "/akam/13/",
    "||walmart.com^/px/pxu6b0qd2s/init.js",
    "||dd.leboncoin.fr^",
    "||collector-px0py5pczn.octopart.com^",
    "||big.example^",
    "/tracker.js",
  ].join("\n");

  it.each([
    ["https://www.zillow.com/HYx10rg3/xhr/api/v2/collector", "https://www.zillow.com/homes/", "XHR"],
    ["https://www.walmart.com/px/PXu6b0qd2S/init.js", "https://www.walmart.com/", "Script"],
    ["https://www.homedepot.com/akam/13/3c0a7b21", "https://www.homedepot.com/", "Script"],
    ["https://dd.leboncoin.fr/js/", "https://www.leboncoin.fr/", "XHR"],
    ["https://collector-px0py5pczn.octopart.com/api/v2/collector", "https://octopart.com/", "XHR"],
  ])("Tier B never blocks %s", async (url, source, type) => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false });
    expect(e.match(url, source, type).block).toBe(false);
  });

  it("still blocks the same rules elsewhere, and keeps sensor subdomains out of Tier A", async () => {
    const e = await AdBlockEngine.create({ filters, cosmetic: false, maxHostPatterns: 10 });
    expect(e.match("https://tracker.example/api/v2/collector", "https://news.example/", "XHR").block).toBe(true);
    expect(e.match("https://news.example/tracker.js", "https://news.example/", "Script").block).toBe(true);
    const f = fakeFrame("https://www.leboncoin.fr/");
    await e.initSession(f.frame);
    expect(f.patterns().block).toEqual(["*://{*.}?big.example:*/*"]);
    // A request to the sensor subdomain is not learned either.
    f.request("https://dd.leboncoin.fr/js/", "XHR");
    await settle();
    expect(f.installs()).toBe(1);
  });
});

describe("cosmetic CSS", () => {
  it("emits one rule per new selector and skips ones already injected", () => {
    const seen = new Set<string>();
    const first = newRules(".a, .b:is(.c, .d), [href*=\"x,y\"] { display: none !important; }", seen);
    expect(first.count).toBe(3);
    expect(first.css.split("\n")).toEqual([
      ".a { display: none !important; }",
      ".b:is(.c, .d) { display: none !important; }",
      "[href*=\"x,y\"] { display: none !important; }",
    ]);
    expect(newRules(".a, .e { display: none !important; }", seen)).toEqual({ css: ".e { display: none !important; }", count: 1 });
  });

  it("returns hostname rules up front and generic rules for DOM features", async () => {
    const e = await AdBlockEngine.create({ filters: "##.ad-slot\nnews.example##.sponsored\n##.cookie-banner" });
    expect(e.cosmeticCss("https://news.example/a")).toContain(".sponsored");
    const dom = e.cosmeticCss("https://news.example/a", { classes: ["ad-slot", "cookie-banner"], ids: [], hrefs: [] });
    expect(dom).toContain(".ad-slot");
    expect(dom).not.toContain("cookie-banner");
  });
});
