// End-to-end tests for Page input and navigation details against a real Chromium. Run with
// `npm run test:e2e` (PILOTFISH_E2E=1). A local page records the event stream a behaviour sensor
// would see; no network beyond 127.0.0.1, no model.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { blockPageWrites, launch, type Browser, type Page } from "./index.js";
import { RequestInterceptor } from "./intercept.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const INPUT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>input</title></head><body style="margin:0">
<input id="txt" style="position:absolute;left:80px;top:80px;width:300px">
<input id="pw" type="password" style="position:absolute;left:80px;top:130px;width:300px">
<button id="btn" style="position:absolute;left:700px;top:500px;width:120px;height:40px">go</button>
<button id="far" style="position:absolute;left:300px;top:2600px;width:160px;height:40px">far below</button>
<div id="panel" style="position:absolute;left:900px;top:200px;width:200px;height:150px;overflow:auto"><div style="height:1200px"></div><button id="inpanel">in the panel</button></div>
<input id="num" type="number" value="50" style="position:absolute;left:80px;top:300px;width:120px">
<div style="position:fixed;left:0;top:0;width:100%;height:36px;background:#eee;z-index:5"><button id="hdr" style="margin:4px">header</button></div>
<div id="trigger" style="position:absolute;left:500px;top:120px;width:160px;height:30px;background:#ddd"
  onmouseenter="clearTimeout(window.__mt); document.getElementById('menu').style.display='block'"
  onmouseleave="window.__mt = setTimeout(() => document.getElementById('menu').style.display='none', 150)">menu</div>
<div id="menu" style="display:none;position:absolute;left:500px;top:150px;width:160px;height:80px;background:#ccc">items</div>
<div style="height:6000px"></div>
<script>
  window.__reset = () => { window.__ev = { moves: 0, firstMove: null, lastMove: null, movesBeforeDown: -1, wheelsBeforeDown: -1, down: null, up: null, pdown: null, keys: 0, keyLog: [], wheels: [] }; };
  __reset();
  addEventListener('mousemove', (e) => { __ev.moves++; if (__ev.firstMove === null) __ev.firstMove = e.timeStamp; __ev.lastMove = e.timeStamp; }, true);
  addEventListener('pointerdown', (e) => { __ev.pdown = { buttons: e.buttons, trusted: e.isTrusted, pressure: e.pressure }; }, true);
  addEventListener('mousedown', (e) => { __ev.down = { buttons: e.buttons, t: e.timeStamp, trusted: e.isTrusted, target: e.target.id }; __ev.movesBeforeDown = __ev.moves; __ev.wheelsBeforeDown = __ev.wheels.length; }, true);
  addEventListener('mouseup', (e) => { __ev.up = { buttons: e.buttons, t: e.timeStamp }; }, true);
  addEventListener('keydown', (e) => { if (e.key !== 'Shift' && e.key !== 'Backspace') { __ev.keys++; __ev.keyLog.push({ key: e.key, code: e.code, shift: e.shiftKey }); } }, true);
  addEventListener('wheel', (e) => { __ev.wheels.push(e.deltaY); }, true);
</script></body></html>`;

/** A checkout step: its button sends an order (a POST) and its form submits one. */
const SHOP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title></head><body>
<p id="total">Total $45.00</p><input id="qty" value="1">
<button id="buy" onclick="window.__clicked = true; fetch('/order', { method: 'POST', body: 'x' })">Place order</button>
<form id="f" method="post" action="/order"><button>Send</button></form>
</body></html>`;

interface Events {
  moves: number;
  firstMove: number | null;
  lastMove: number | null;
  movesBeforeDown: number;
  wheelsBeforeDown: number;
  down: { buttons: number; t: number; trusted: boolean; target: string } | null;
  up: { buttons: number; t: number } | null;
  pdown: { buttons: number; trusted: boolean; pressure: number } | null;
  keys: number;
  keyLog: Array<{ key: string; code: string; shift: boolean }>;
  wheels: number[];
}

(E2E ? describe : describe.skip)("page input and navigation (e2e)", () => {
  let server: Server;
  let origin: string;
  let hits: Record<string, number>;
  let browser: Browser;

  beforeAll(async () => {
    hits = {};
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      if (path === "/input") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(INPUT_PAGE);
        return;
      }
      if (path === "/shop") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(SHOP_PAGE);
        return;
      }
      if (path === "/missing") {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>404</title><h1>Not found</h1>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>ok</title><h1>${path}</h1>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const events = (p: Page) => p.main.evaluate<Events>("window.__ev", { mainWorld: true });
  const reset = (p: Page) => p.main.evaluate("window.__reset()", { mainWorld: true });

  async function nodeId(p: Page, selector: string): Promise<number> {
    const { root } = await p.session.send("DOM.getDocument", { depth: 0 });
    const { nodeId: id } = await p.session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!id) throw new Error(`no element for ${selector}`);
    const { node } = await p.session.send("DOM.describeNode", { nodeId: id });
    return node.backendNodeId;
  }

  it("presses with buttons:1 and holds at least 40 ms, humanize off (one move, text inserted)", async () => {
    const p = await browser.newPage();
    try {
      expect(p.humanize).toBe(false);
      await p.navigate(`${origin}/input`);
      await reset(p);
      await p.click(p.main, await nodeId(p, "#btn"));
      let ev = await events(p);
      expect(ev.down?.buttons).toBe(1);
      expect(ev.down?.trusted).toBe(true);
      expect(ev.pdown?.buttons).toBe(1);
      // A mouse button down reads pressure 0.5 (CDP's default force of 0 read as 0).
      expect(ev.pdown?.pressure).toBe(0.5);
      expect(ev.up?.buttons).toBe(0);
      expect(ev.up!.t - ev.down!.t).toBeGreaterThanOrEqual(39); // timeStamp is coarsened; 40 ms gap minimum
      expect(ev.movesBeforeDown).toBeLessThanOrEqual(1);
      await reset(p);
      await p.type(p.main, await nodeId(p, "#txt"), "hello world", { clear: false });
      ev = await events(p);
      expect(ev.keys).toBe(0); // inserted, not keyed
      expect(await p.main.evaluate<string>("document.getElementById('txt').value", { mainWorld: true })).toBe("hello world");
      await reset(p);
      await p.scroll(500);
      // The wheel reaches the page after the input call returns (the compositor handles it first).
      for (let i = 0; i < 40 && !(await events(p)).wheels.length; i++) await new Promise((r) => setTimeout(r, 25));
      ev = await events(p);
      expect(ev.wheels).toEqual([500]);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("humanize on with no input driver registered (the open MCP) keeps input plain", async () => {
    const p = await browser.newPage();
    try {
      p.humanize = true;
      await p.navigate(`${origin}/input`);
      await reset(p);
      await p.click(p.main, await nodeId(p, "#btn"));
      let ev = await events(p);
      expect(ev.movesBeforeDown).toBeLessThanOrEqual(1);
      await reset(p);
      await p.type(p.main, await nodeId(p, "#txt"), "hello", { clear: false });
      ev = await events(p);
      expect(ev.keys).toBe(0);
      await reset(p);
      await p.scroll(500);
      for (let i = 0; i < 40 && !(await events(p)).wheels.length; i++) await new Promise((r) => setTimeout(r, 25));
      ev = await events(p);
      expect(ev.wheels).toEqual([500]);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("returns phase timings and the main document's status", async () => {
    const p = await browser.newPage();
    try {
      const ok = await p.navigate(`${origin}/input`, { waitUntil: "domcontentloaded" });
      expect(ok.status).toBe(200);
      expect(ok.timings?.commitMs).toBeGreaterThanOrEqual(0);
      expect(ok.timings?.dclMs).toBeGreaterThanOrEqual(ok.timings!.commitMs!);
      const missing = await p.navigate(`${origin}/missing`);
      expect(missing.status).toBe(404);
      expect(missing.timings?.commitMs).toBeGreaterThanOrEqual(0);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("an expression held to reading cannot click, submit, send, type or add to the page; reads work, and the tools' own world is untouched (review, 3 Nov)", async () => {
    const p = await browser.newPage();
    try {
      await p.navigate(`${origin}/shop`);
      const ro = (expression: string) => p.main.evaluate(expression, { readOnly: true });
      expect(await ro("document.querySelector('#total').innerText")).toBe("Total $45.00");
      expect(await ro("[...document.querySelectorAll('button')].map((b) => b.innerText)")).toEqual(["Place order", "Send"]);
      for (const act of [
        "document.querySelector('#buy').click()",
        "document.querySelector('#buy').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
        "document.querySelector('#f').submit()",
        "document.querySelector('#f').requestSubmit()",
        "fetch('/order', { method: 'POST' })",
        "navigator.sendBeacon('/order', 'x')",
        "document.querySelector('#qty').value = '5'",
        "document.body.appendChild(document.createElement('iframe'))",
        "document.body.innerHTML = ''",
        "window.open('/order')",
      ]) await expect(ro(act), act).rejects.toThrow(/read-only: /);
      expect(await p.main.evaluate("window.__clicked ?? false", { mainWorld: true })).toBe(false);
      expect(await p.main.evaluate("document.querySelector('#qty').value", { mainWorld: true })).toBe("1");
      expect(hits["/order"] ?? 0).toBe(0);
      // The tools' world keeps its DOM methods.
      await p.main.evaluate("document.querySelector('#buy').click()");
      expect(await p.main.evaluate("window.__clicked", { mainWorld: true })).toBe(true);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("while writes are blocked the page's own POST fails and a GET goes through; after, both do", async () => {
    const p = await browser.newPage();
    try {
      await p.navigate(`${origin}/shop`);
      const send = (method: string) => p.main.evaluate<string>(`fetch('/order', { method: '${method}' }).then((r) => String(r.status), () => 'failed')`, { mainWorld: true });
      const before = hits["/order"] ?? 0;
      const unblock = await blockPageWrites(p);
      expect(await send("POST")).toBe("failed");
      expect(await send("GET")).toBe("200");
      unblock();
      await new Promise((r) => setTimeout(r, 200));
      expect(await send("POST")).toBe("200");
      expect((hits["/order"] ?? 0) - before).toBe(2);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("retries once a navigation that fails at once with nothing committed", async () => {
    const p = await browser.newPage();
    try {
      // The first request for /flaky dies in the browser before reaching the server, as when an exit
      // switches mid-request; the retry gets through.
      let paused = 0;
      const reg = RequestInterceptor.for(p.session).add({
        types: ["Document"],
        onRequest: (e) => {
          if (!e.request.url.endsWith("/flaky")) return;
          paused++;
          if (paused === 1) return { action: "fail", reason: "Aborted" };
        },
      });
      await reg.enabled;
      const res = await p.navigate(`${origin}/flaky`);
      expect(res.status).toBe(200);
      expect(paused).toBe(2);
      expect(hits["/flaky"]).toBe(1);
      expect(await p.main.evaluate<string>("document.querySelector('h1').textContent")).toBe("/flaky");
      reg.remove();

      // A failure a retry cannot change is not retried.
      let blocked = 0;
      const reg2 = RequestInterceptor.for(p.session).add({
        types: ["Document"],
        onRequest: (e) => {
          if (!e.request.url.endsWith("/blocked")) return;
          blocked++;
          return { action: "fail", reason: "BlockedByClient" };
        },
      });
      await reg2.enabled;
      await expect(p.navigate(`${origin}/blocked`)).rejects.toMatchObject({ code: "navigation_failed" });
      expect(blocked).toBe(1);
      reg2.remove();
    } finally {
      await p.close();
    }
  }, 30_000);
});
