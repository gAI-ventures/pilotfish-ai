// Before a browser is let go, the page's own writes reach its site: a save the page makes a moment after the click
// (a cart synced on a timer) and one it sends on the way out (sendBeacon on pagehide). Live, 6 Nov: an item added to
// a grocery delivery cart showed in the agent's cart and never reached the person's account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const CART = `<!doctype html><html><head><meta charset="utf-8"><title>Cart</title></head><body>
<button id="add" onclick="setTimeout(() => fetch('/api/cart', { method: 'POST', body: 'milk' }), 1000)">Add</button>
<script>addEventListener('pagehide', () => navigator.sendBeacon('/api/cart-sync', 'milk'));</script>
</body></html>`;

(E2E ? describe : describe.skip)("leaving a page (e2e)", () => {
  let server: Server;
  let origin = "";
  let browser: Browser;
  const got: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST") {
        req.resume();
        req.on("end", () => {
          got.push(req.url ?? "");
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(CART);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("flushWrites waits for a save made a moment after the click; leave sends what the page sends on the way out", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/cart`);
    await p.main.evaluate("document.getElementById('add').click()");
    // Nothing has gone yet: the page saves a second later.
    expect(got).toEqual([]);
    const f = await p.flushWrites({ quietMs: 1_500, timeoutMs: 5_000 });
    expect(f.pending).toBe(0);
    expect(got).toEqual(["/api/cart"]);
    await p.leave();
    await expect.poll(() => got, { timeout: 3_000 }).toEqual(["/api/cart", "/api/cart-sync"]);
    expect(p.url).toBe("about:blank");
    await p.close();
  }, 60_000);

  it("leave on a blank page, or one already closed, does nothing and never throws", async () => {
    const p = await browser.newPage();
    await p.leave();
    await p.close();
    await p.leave();
  }, 30_000);
});
