// What is open on top of a long page (a cart drawer, a side panel, a dialog) is read first by `pageText` with
// `overlaysFirst`: a capped read of the page in its own order ended in the page's carousels before a drawer rendered
// at the end of <body> (24 Nov: a cart drawer's "Pay" button missing from the end check's PAGE TEXT).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser } from "@pilotfish/browser";
import { captureSnapshot, openPanels, pageText } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const cards = Array.from({ length: 160 }, (_, i) => `<a href="/p/${i}">ADD ₹ ${100 + i} Example Dark Chocolate Bar number ${i} with a long description of its cocoa and taste 1 pc (75 g)</a>`).join("");
const PAGE = (drawer: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
<header style="position:fixed;top:0;left:0;right:0;height:56px;background:#fff">Delivery in 9 minutes · Home · Search · Cart 6</header>
<main style="padding-top:60px"><h1>Example Dark Chocolate 55%</h1><p>₹ 180</p><h2>Similar products</h2><div>${cards}</div></main>
${drawer}
</body></html>`;
const DRAWER = `<div data-testid="cart-screen" style="position:fixed;top:0;right:0;width:420px;height:100vh;background:#fff;overflow:auto">
<h2>Cart</h2><p>Example Dark Chocolate 55% · 1 · ₹180</p><p>Example Crisps · 2 · ₹40</p><p>Delivering to Home</p>
<p>PAYING VIA Example Pay Balance</p><button>Pay ₹387</button></div>`;
const DIALOG = `<div role="dialog" aria-modal="true" style="position:absolute;top:100px;left:200px;width:600px;height:400px;background:#fff"><h2>Confirm your order</h2><p>Total ₹387 for 6 items, paying with Example Pay Balance.</p><button>Place order</button></div>`;
const COOKIE_BAR = `<div style="position:fixed;bottom:0;left:0;right:0;height:40px;background:#eee">We use cookies to improve your experience on this site. <button>OK</button></div>`;

describe.skipIf(!E2E)("pageText reads what is open on top first", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const which = new URL(req.url ?? "/", "http://x").pathname;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(which === "/drawer" ? DRAWER : which === "/dialog" ? DIALOG : which === "/cookie" ? COOKIE_BAR : ""));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const read = async (path: string) => {
    const p = await browser.newPage();
    await p.navigate(origin + path);
    const snap = await captureSnapshot(p, { viewportBand: Infinity });
    await p.close();
    return snap;
  };

  it("a cart drawer at the end of the page: the old read misses its pay button under the cap, the new one has it first", async () => {
    const snap = await read("/drawer");
    expect(pageText(snap, { maxChars: 12_000 })).not.toContain("Pay ₹387");
    const text = pageText(snap, { maxChars: 12_000, overlaysFirst: true });
    expect(text.startsWith("(Open on top of the page:)")).toBe(true);
    expect(text.indexOf("Pay ₹387")).toBeLessThan(600);
    expect(text).toContain("PAYING VIA Example Pay Balance");
    // The page under it follows, without the drawer again.
    expect(text).toContain("(The page under it:)");
    expect(text.split("Pay ₹387").length).toBe(2);
  });

  it("an open dialog is read first too", async () => {
    const text = pageText(await read("/dialog"), { maxChars: 12_000, overlaysFirst: true });
    expect(text.indexOf("Place order")).toBeLessThan(400);
  });

  it("a fixed header or a cookie bar is no panel: the page reads as before", async () => {
    const plain = await read("/");
    expect(openPanels(plain)).toEqual([]);
    expect(pageText(plain, { maxChars: 12_000, overlaysFirst: true })).toBe(pageText(plain, { maxChars: 12_000 }));
    const cookie = await read("/cookie");
    expect(openPanels(cookie)).toEqual([]);
  });
});
