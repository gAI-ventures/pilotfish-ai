// End-to-end: consent rejection, Tier A/B blocking, cosmetic hiding, the allow-list and OOPIFs
// against a real Chromium. Run with PILOTFISH_E2E=1. One local server answers every hostname:
// `--host-resolver-rules=MAP * 127.0.0.1` sends ad hosts (and the allow-listed real hosts) to it,
// so nothing leaves the machine; localhost vs 127.0.0.1 gives a cross-site (OOPIF) iframe.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser, type Page } from "@pilotfish/browser";
import { attachInterrupts, type InterruptEvent, type Interrupts } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const FILTERS = [
  "||ads.adhost.test^",
  "||tracker.adhost.test^$third-party",
  "/banner.js$script", // path rule: not host-level, so Tier B only
  "##.ad-slot",
  "##.cookie-banner", // stripped: would hide consent banners from autoconsent
  "##.paywall", // stripped: would circumvent a paywall
  "||stripe.com^",
  "||hcaptcha.com^",
  "||cookielaw.org^",
  "||okta.com^",
  "||recaptcha.net^",
  "||challenges.cloudflare.com^",
].join("\n");

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

interface Fixture {
  server: Server;
  port: number;
  choices: string[];
  hits: string[];
}

function start(): Promise<Fixture> {
  const fx: Fixture = { server: null as unknown as Server, port: 0, choices: [], hits: [] };
  const banner = (buttons: string) => `
    <div id="banner" role="dialog" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#fff;padding:16px;border-top:2px solid #000">
      <p>We use cookies and similar technologies to personalise content and ads and to analyse our traffic. You can accept all cookies or reject non-essential cookies.</p>
      ${buttons}
    </div>
    <script>function choose(c){ fetch('/choice?c=' + c); document.getElementById('banner').remove(); }</script>`;
  const routes: Record<string, (host: string) => { body: string; type?: string }> = {
    "/consent": () => ({ body: html(`<h1>News</h1><p>${"Article text. ".repeat(40)}</p>` + banner(`<button id="accept" onclick="choose('accepted')">Accept all</button> <button id="reject" onclick="choose('rejected')">Reject all</button>`)) }),
    "/accept-only": () => ({ body: html(`<h1>News</h1>` + banner(`<button id="accept" onclick="choose('accepted')">Accept all</button> <button id="more" onclick="choose('learn-more')">Learn more</button>`)) }),
    "/ads": () => ({
      body: html(`
        <h1 id="content">Real content</h1>
        <div class="ad-slot" id="ad">AD</div>
        <div class="cookie-banner" id="cb">cookie banner</div>
        <div class="paywall" id="pw">paywall</div>
        <script src="/app.js"></script>
        <script src="http://ads.adhost.test:${fx.port}/ad.js" onerror="window.adBlocked=true"></script>
        <script src="http://cdn.adhost.test:${fx.port}/banner.js" onerror="window.bannerBlocked=true"></script>`),
    }),
    "/protected": () => ({
      body: html(`<h1>protected</h1>` +
        ["js.stripe.com/v3/", "newassets.hcaptcha.com/x.js", "cdn.cookielaw.org/x.js", "acme.okta.com/x.js", "www.recaptcha.net/x.js", "challenges.cloudflare.com/x.js", "www.google.com/recaptcha/api.js", "ads.adhost.test/control.js"]
          .map((u) => { const [h, ...p] = u.split("/"); return `<script src="http://${h}:${fx.port}/${p.join("/")}"></script>`; }).join("")),
    }),
    "/oopif": () => ({ body: html(`<h1>host</h1><iframe id="f" src="http://localhost:${fx.port}/frame-ads" style="width:400px;height:300px"></iframe>`) }),
    "/frame-ads": () => ({ body: html(`<p id="inner">frame</p><div class="ad-slot">AD</div><script src="http://ads.adhost.test:${fx.port}/frame-ad.js" onerror="window.adBlocked=true"></script>`) }),
    // One script from an ad host in the document, a second one added 300 ms later.
    "/learn": () => ({
      body: html(`
        <h1 id="content">Real content</h1>
        <script src="http://ads.adhost.test:${fx.port}/ad.js?n=1" onerror="window.firstBlocked=true"></script>
        <script>setTimeout(() => { const s = document.createElement("script"); s.src = "http://x.ads.adhost.test:${fx.port}/ad.js?n=2";
          s.onload = () => (window.second = "loaded"); s.onerror = () => (window.second = "blocked"); document.head.appendChild(s); }, 300);</script>`),
    }),
    "/app.js": () => ({ body: "window.appLoaded = true", type: "application/javascript" }),
    "/ad.js": () => ({ body: "window.adLoaded = true", type: "application/javascript" }),
    "/banner.js": () => ({ body: "window.bannerLoaded = true", type: "application/javascript" }),
  };
  return new Promise((resolve) => {
    fx.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      fx.hits.push(`${req.headers.host}${url.pathname}`);
      if (url.pathname === "/choice") fx.choices.push(url.searchParams.get("c") ?? "");
      const r = routes[url.pathname]?.(req.headers.host ?? "") ?? { body: "", type: "application/javascript" };
      res.writeHead(200, { "content-type": r.type ?? "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(r.body);
    });
    fx.server.listen(0, "127.0.0.1", () => {
      fx.port = (fx.server.address() as AddressInfo).port;
      resolve(fx);
    });
  });
}

/** Evaluate in a page's main world. */
const main = <T>(page: Page, expr: string) => page.main.evaluate<T>(expr, { mainWorld: true });

async function launchArmed(tierB: boolean, events: InterruptEvent[] = []): Promise<{ browser: Browser; ix: Interrupts }> {
  const browser = await launch({ headless: true, args: ["--host-resolver-rules=MAP * 127.0.0.1"] });
  const ix = await attachInterrupts(browser, { adblock: { filters: FILTERS, tierB }, onEvent: (e) => events.push(e) });
  return { browser, ix };
}

describe.skipIf(!E2E)("interrupts e2e", () => {
  let fx: Fixture;
  let browser: Browser;
  let ix: Interrupts;
  const events: InterruptEvent[] = [];
  const origin = () => `http://127.0.0.1:${fx.port}`;

  beforeAll(async () => {
    fx = await start();
    ({ browser, ix } = await launchArmed(false, events));
  }, 60_000);

  afterAll(async () => {
    ix?.detach();
    await browser?.close().catch(() => undefined); // Windows may hold the temp profile open briefly
    fx?.server.close();
  });

  it("rejects a generic cookie banner, never accepts (Runtime.enable stays off)", async () => {
    const page = await browser.newPage();
    await expect(page.session.send("Runtime.enable")).rejects.toThrow(/disabled/);
    fx.choices.length = 0;
    await page.navigate(`${origin()}/consent`);
    const status = await ix.consent!.waitForConsent(page, 15_000);
    await new Promise((r) => setTimeout(r, 300)); // let the recorded choice reach the server
    expect(status.outcome).toBe("opted_out");
    expect(status.cmp).toMatch(/^HEURISTIC/);
    expect(fx.choices).toEqual(["rejected"]);
    expect(await main<boolean>(page, "!!document.getElementById('banner')")).toBe(false);
    expect(events.some((e) => e.source === "consent" && e.type === "autoconsentDone")).toBe(true);
    await page.close();
  });

  it("does nothing to a banner whose only choice is accept, and the click guard refuses accept clicks", async () => {
    const page = await browser.newPage();
    fx.choices.length = 0;
    await page.navigate(`${origin()}/accept-only`);
    await new Promise((r) => setTimeout(r, 4_000)); // several heuristic detection rounds
    expect(fx.choices).toEqual([]);
    expect((await ix.consent!.waitForConsent(page, 10_000)).outcome).toBe("no_cmp");
    // Simulate a rule clicking inside autoconsent's isolated world: accept is refused, others go through.
    const { executionContextId } = await page.session.send("Page.createIsolatedWorld", { frameId: page.main.frameId, worldName: "pf_ac" });
    await page.session.send("Runtime.evaluate", { contextId: executionContextId, expression: "document.getElementById('accept').click(); document.getElementById('more').click();" });
    await new Promise((r) => setTimeout(r, 300));
    expect(fx.choices).toEqual(["learn-more"]);
    expect(ix.consent!.consentStatus(page).refusedClicks).toBe(1);
    // The page's own world is untouched: a real user click on accept still works there.
    expect(await main<boolean>(page, "HTMLElement.prototype.click.toString().includes('[native code]')")).toBe(true);
    await page.close();
  });

  it("blocks a known ad host at the network layer and the page still loads", async () => {
    const page = await browser.newPage();
    fx.hits.length = 0;
    await page.navigate(`${origin()}/ads`);
    expect(await main<string>(page, "document.getElementById('content').textContent")).toBe("Real content");
    expect(await main<boolean>(page, "window.appLoaded === true")).toBe(true);
    expect(await main<boolean>(page, "window.adBlocked === true && !window.adLoaded")).toBe(true);
    expect(fx.hits.some((h) => h.startsWith("ads.adhost.test"))).toBe(false);
    // Path rules are not host-level: Tier A lets them through (Tier B catches them, below).
    expect(await main<boolean>(page, "window.bannerLoaded === true")).toBe(true);
    const stats = ix.adblock!.stats(page);
    expect(stats.blocked).toBeGreaterThanOrEqual(1);
    expect(stats.byHost["ads.adhost.test"]).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  it("hides known ad selectors from an isolated world, but never consent banners or paywalls", async () => {
    const page = await browser.newPage();
    await page.navigate(`${origin()}/ads`);
    const display = (id: string) => main<string>(page, `getComputedStyle(document.getElementById('${id}')).display`);
    let ad = await display("ad");
    for (let i = 0; i < 20 && ad !== "none"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ad = await display("ad");
    }
    expect(ad).toBe("none");
    expect(await display("cb")).not.toBe("none");
    expect(await display("pw")).not.toBe("none");
    expect(await main<string>(page, "typeof window.__pfAbCss")).toBe("undefined");
    expect(ix.adblock!.stats(page).hiddenSelectors).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  it("never blocks CAPTCHA, payment, auth or consent-manager hosts", async () => {
    const page = await browser.newPage();
    const failed: Array<{ url: string; reason?: string }> = [];
    const urls = new Map<string, string>();
    page.session.on("Network.requestWillBeSent", (e) => void urls.set(e.requestId, e.request.url));
    page.session.on("Network.loadingFailed", (e) => void failed.push({ url: urls.get(e.requestId) ?? "", reason: e.blockedReason }));
    await page.navigate(`${origin()}/protected`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 500));
    const blocked = failed.filter((f) => f.reason === "inspector").map((f) => new URL(f.url).hostname);
    expect(blocked).toEqual(["ads.adhost.test"]); // the control, and nothing else
    // Engine side too (Tier B decisions).
    for (const u of ["https://js.stripe.com/v3/", "https://newassets.hcaptcha.com/x.js", "https://cdn.cookielaw.org/x.js", "https://acme.okta.com/x", "https://www.recaptcha.net/x.js"]) {
      expect(ix.adblock!.match(u, "https://shop.example/", "Script").block).toBe(false);
    }
    await page.close();
  });

  it("works inside a cross-origin iframe (OOPIF): blocking, hiding and the consent channel", async () => {
    const page = await browser.newPage();
    await page.navigate(`${origin()}/oopif`);
    let frame = page.frames().find((f) => f.url.includes("localhost") && f.session !== page.session);
    for (let i = 0; i < 30 && !frame; i++) {
      await new Promise((r) => setTimeout(r, 100));
      frame = page.frames().find((f) => f.url.includes("localhost") && f.session !== page.session);
    }
    expect(frame, "OOPIF session").toBeTruthy();
    let hidden = "";
    for (let i = 0; i < 30 && hidden !== "none"; i++) {
      hidden = await frame!.evaluate<string>("getComputedStyle(document.querySelector('.ad-slot')).display", { mainWorld: true }).catch(() => "");
      if (hidden !== "none") await new Promise((r) => setTimeout(r, 100));
    }
    expect(hidden).toBe("none");
    expect(await frame!.evaluate<boolean>("window.adBlocked === true", { mainWorld: true })).toBe(true);
    // autoconsent initialized in both the top document and the OOPIF over the binding channel.
    let frames = 0;
    for (let i = 0; i < 30 && frames < 2; i++) {
      frames = ix.consent!.consentStatus(page).frames;
      if (frames < 2) await new Promise((r) => setTimeout(r, 100));
    }
    expect(frames).toBeGreaterThanOrEqual(2);
    await page.close();
  });
});

describe.skipIf(!E2E)("interrupts e2e: learned Tier A hosts", () => {
  let fx: Fixture;
  let browser: Browser;
  let ix: Interrupts;

  beforeAll(async () => {
    fx = await start();
    browser = await launch({ headless: true, args: ["--host-resolver-rules=MAP * 127.0.0.1"] });
    // No head: every listed host has to be learned from the page's own requests.
    ix = await attachInterrupts(browser, { consent: false, adblock: { filters: FILTERS, maxHostPatterns: 0, maxFramePatterns: 0 } });
  }, 60_000);

  afterAll(async () => {
    ix?.detach();
    await browser?.close().catch(() => undefined);
    fx?.server.close();
  });

  const hits = (n: number) => fx.hits.filter((h) => h.includes("ads.adhost.test") && h.includes(`/ad.js`)).length >= n;
  const waitFor = async (page: Page, expr: string) => {
    for (let i = 0; i < 50; i++) {
      if (await main<boolean>(page, expr).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it("lets the first request to a listed host through, then blocks the host on this and later documents of the site", async () => {
    const page = await browser.newPage();
    fx.hits.length = 0;
    await page.navigate(`http://127.0.0.1:${fx.port}/learn`);
    await waitFor(page, "!!window.second");
    expect(await main<boolean>(page, "window.adLoaded === true && !window.firstBlocked")).toBe(true); // first visit: leaked
    expect(await main<string>(page, "window.second")).toBe("blocked"); // a subdomain, after learning
    expect(ix.adblock!.stats(page).learnedHosts).toBe(1);
    expect(hits(1) && !hits(2)).toBe(true);

    fx.hits.length = 0;
    await page.navigate(`http://127.0.0.1:${fx.port}/learn`);
    await waitFor(page, "!!window.second");
    expect(await main<boolean>(page, "window.firstBlocked === true && !window.adLoaded")).toBe(true); // blocked from the first byte
    expect(await main<string>(page, "window.second")).toBe("blocked");
    expect(fx.hits.some((h) => h.includes("ads.adhost.test"))).toBe(false);
    expect(ix.adblock!.stats(page).blocked).toBe(2);
    await page.close();
  });
});

describe.skipIf(!E2E)("interrupts e2e: Tier B", () => {
  let fx: Fixture;
  let browser: Browser;
  let ix: Interrupts;

  beforeAll(async () => {
    fx = await start();
    ({ browser, ix } = await launchArmed(true));
  }, 60_000);

  afterAll(async () => {
    ix?.detach();
    await browser?.close().catch(() => undefined);
    fx?.server.close();
  });

  it("blocks path-level rules through Fetch interception", async () => {
    const page = await browser.newPage();
    fx.hits.length = 0;
    await page.navigate(`http://127.0.0.1:${fx.port}/ads`);
    expect(await main<boolean>(page, "window.appLoaded === true")).toBe(true);
    expect(await main<boolean>(page, "window.bannerBlocked === true && !window.bannerLoaded")).toBe(true);
    expect(fx.hits.some((h) => h.endsWith("/banner.js"))).toBe(false);
    const stats = ix.adblock!.stats(page);
    expect(stats.byHost["cdn.adhost.test"]).toBe(1); // counted once (not again as a Tier A failure)
    expect(stats.byHost["ads.adhost.test"]).toBe(1); // host rule: still Tier A
    await page.close();
  });
});
