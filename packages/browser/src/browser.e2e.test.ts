// End-to-end tests against a real Chromium. Run with `npm run test:e2e`.
// A tiny local HTTP server provides deterministic pages (same-origin iframe,
// cross-origin OOPIF via a second port, dialogs, slow XHR, overlays).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser, type Page, ActionError } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

function page(body: string, extraHead = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${extraHead}</head><body>${body}</body></html>`;
}

interface Route {
  status?: number;
  body: string;
  type?: string;
  delayMs?: number;
}

function startServer(routes: Record<string, (url: URL) => Route>, host = "127.0.0.1"): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handler = routes[url.pathname] ?? ((): Route => ({ status: 404, body: "nope" }));
      const r = handler(url);
      const send = () => {
        res.writeHead(r.status ?? 200, { "content-type": r.type ?? "text/html; charset=utf-8" });
        res.end(r.body);
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://${host}:${port}` });
    });
  });
}

describe.skipIf(!E2E)("browser e2e", () => {
  let browser: Browser;
  let a: { server: Server; origin: string };
  let b: { server: Server; origin: string };

  beforeAll(async () => {
    // Site isolation keys on scheme+host: 127.0.0.1 vs localhost are different sites, so this frame is an OOPIF.
    b = await startServer({
      "/frame": () => ({ body: page(`<button id="inner" onclick="document.title='clicked-in-oopif'">inner</button>`) }),
    }, "localhost");
    a = await startServer({
      // Pseudo-elements over a click target: the label's ::before of a custom checkbox, the target's own and its
      // child's (these take the click to it), and a wrapper's, a sibling's or body's (these take it away).
      "/pseudo": (u) => {
        const kind = u.searchParams.get("k");
        const css: Record<string, string> = {
          label: `.cb{position:relative;margin:40px}.cb input{opacity:0;position:absolute;left:0;top:0;width:22px;height:22px;margin:0}.cb label{padding-left:30px}.cb label::before{content:"";position:absolute;left:0;top:0;width:20px;height:20px;border:1px solid #333}`,
          own: `#b{position:relative;margin:40px}#b::after{content:"";position:absolute;inset:-4px;border:2px solid blue}`,
          child: `#b{position:relative;margin:40px}#b span::before{content:"";position:absolute;inset:0}`,
          wrapper: `.w{position:relative;display:inline-block;margin:40px}.w::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.05)}`,
          sibling: `.c{position:relative;margin:40px}.c .o::before{content:"";position:absolute;inset:0;z-index:2}`,
          modal: `body::after{content:"";position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10}`,
        };
        const html: Record<string, string> = {
          label: `<div class="cb"><input id="b" type="checkbox" onclick="document.title='clicked'"><label for="b">Free cancellation</label></div>`,
          own: `<button id="b" onclick="document.title='clicked'">Apply</button>`,
          child: `<button id="b" onclick="document.title='clicked'"><span>Apply</span></button>`,
          wrapper: `<span class="w"><button id="b" onclick="document.title='clicked'">Apply</button></span>`,
          sibling: `<div class="c"><button id="b" onclick="document.title='clicked'">Apply</button><span class="o"></span></div>`,
          modal: `<button id="b" style="margin:40px" onclick="document.title='clicked'">Buy</button>`,
        };
        return { body: page(`<style>${css[kind ?? ""] ?? ""}</style>${html[kind ?? ""] ?? ""}`) };
      },
      "/": () => ({
        body: page(`
          <h1>Home</h1>
          <input id="name" placeholder="Your name">
          <button id="go" onclick="document.getElementById('out').textContent='hello '+document.getElementById('name').value">Go</button>
          <div id="out"></div>
          <select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
          <input id="when" type="time" onchange="document.getElementById('out').textContent='time='+this.value">
          <input id="day" type="date">
          <a id="link" href="/second">second</a>
          <button id="alert" onclick="alert('hi')">alert</button>
          <button id="confirm" onclick="document.getElementById('out').textContent = confirm('sure?') ? 'yes' : 'no'">confirm</button>
          <div id="covered-wrap" style="position:relative;width:200px;height:50px">
            <button id="covered" style="position:absolute;inset:0">covered</button>
            <div id="overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.3)"></div>
          </div>
          <span class="a-button" style="display:inline-block;position:relative;width:160px;height:32px">
            <span class="a-button-inner" onclick="var i=this.querySelector('input'); if (event.target!==i) i.click()"><input id="atc" type="submit" value="Add to cart" aria-labelledby="atc-label" style="position:absolute;inset:0;opacity:.01" onclick="document.getElementById('out').textContent='added'">
            <span id="atc-label" class="a-button-text" aria-hidden="true" style="position:absolute;inset:0">Add to cart</span></span>
          </span>
          <button id="slow" onclick="fetch('/slow').then(r=>r.text()).then(t=>{document.getElementById('out').textContent=t})">slow</button>
          <iframe id="same" src="/same" style="width:300px;height:100px"></iframe>
        `),
      }),
      "/same": () => ({ body: page(`<button id="same-btn">same-origin frame</button>`) }),
      "/second": () => ({ body: page(`<h1>Second</h1>`) }),
      // A target=_blank link and form: their tabs' opener is cut off, as by default in Chrome.
      "/tabs": () => ({ body: page(`<a id="blank" href="/second?via=link" target="_blank">tab</a><form id="form" action="/second" target="_blank"><input type="hidden" name="via" value="form"></form>`) }),
      // A fixed header over the top of the viewport, and a button scrolled to sit under it.
      "/sticky": () => ({
        body: page(`<header style="position:fixed;top:0;left:0;right:0;height:90px;background:#fff;z-index:10"><svg width="1200" height="90"><path d="M0 0H1200V90H0Z" fill="#eee"/></svg></header>
          <div style="height:1500px"></div><button id="buy" style="display:block;width:200px;height:40px" onclick="document.title='bought'">Add to cart</button><div style="height:1500px"></div>
          <script>scrollTo(0, document.getElementById('buy').offsetTop - 20)</script>`),
      }),
      "/slow": () => ({ body: "slow-done", type: "text/plain", delayMs: 800 }),
      "/slow-page": () => ({ body: page(`<h1 id="late">arrived</h1>`), delayMs: 1500 }),
      // A client-side redirect before the first document is parsed (it waits on a slow script).
      "/hop": () => ({ body: page(`<script>location.replace("/second")</script><script src="/slow-script"></script>`) }),
      "/slow-script": () => ({ body: "", type: "text/javascript", delayMs: 8000 }),
      "/oopif": (url) => ({ body: page(`<p>host</p><iframe id="x" src="${url.searchParams.get("src")}" style="width:400px;height:200px"></iframe>`) }),
      // A page that spawns a dedicated worker: if the worker is left paused (waitForDebuggerOnStart),
      // #out never updates and the page effectively hangs.
      "/worker": () => ({ body: page(`<div id="out">pending</div><script>const w=new Worker('/w.js');w.onmessage=(e)=>{document.getElementById('out').textContent='worker:'+e.data};w.postMessage('ping')</script>`) }),
      "/w.js": () => ({ body: "self.onmessage=(e)=>self.postMessage(e.data+'-pong')", type: "text/javascript" }),
    });
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    a?.server.close();
    b?.server.close();
  });

  it("lets a page's dedicated worker run (does not leave it paused)", async () => {
    const p = await browser.newPage();
    try {
      await p.navigate(a.origin + "/worker");
      // Poll the worker's reply; a paused worker would never answer and this would time out.
      let out = "";
      for (let i = 0; i < 40 && out !== "worker:ping-pong"; i++) {
        out = String(await p.main.evaluate("document.getElementById('out').textContent"));
        if (out !== "worker:ping-pong") await new Promise((r) => setTimeout(r, 100));
      }
      expect(out).toBe("worker:ping-pong");
    } finally {
      await p.close().catch(() => undefined);
    }
  }, 20_000);

  it("retries a navigation whose connection was dropped (a proxy closing a tunnel)", async () => {
    // A server that drops the first two connections without answering, then serves the page.
    let n = 0;
    const flaky = createServer((req, res) => {
      if (++n <= 2) return void req.socket.destroy();
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<h1 id="ok">served</h1>`));
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", () => r()));
    const p = await browser.newPage();
    try {
      await p.navigate(`http://127.0.0.1:${(flaky.address() as AddressInfo).port}/`, { timeoutMs: 20_000 });
      expect(await p.main.evaluate("document.getElementById('ok')?.textContent")).toBe("served");
      expect(n).toBeGreaterThanOrEqual(3);
    } finally {
      await p.close().catch(() => undefined);
      flaky.close();
    }
  }, 30_000);

  it("launches without automation flags and reports a version", async () => {
    const v = await browser.version();
    expect(v.product).toMatch(/Chrome|HeadlessChrome/);
    const p = browser.allPages()[0]!;
    const webdriver = await p.main.evaluate<boolean>("navigator.webdriver");
    expect(webdriver).toBe(false);
  });

  it("navigate() on the initial tab waits for the real page, not the about:blank load", async () => {
    const p = browser.allPages()[0]!;
    await p.navigate(`${a.origin}/slow-page`);
    expect(await p.main.evaluate<string>("document.readyState")).toBe("complete");
    expect(await p.main.evaluate<string>("document.getElementById('late')?.textContent ?? 'missing'")).toBe("arrived");
  });

  it("navigate() follows a client-side redirect instead of waiting for the first document", async () => {
    const p = await browser.newPage();
    const t0 = Date.now();
    await p.navigate(`${a.origin}/hop`, { waitUntil: "domcontentloaded", timeoutMs: 15_000 });
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(await p.main.evaluate<string>("location.pathname")).toBe("/second");
    await p.close();
  });

  it("navigates, types, clicks (hit-tested) and reads results", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    expect(p.url).toBe(`${a.origin}/`);
    const nameId = await nodeId(p, "#name");
    await p.type(p.main, nameId, "Ada", {});
    const goId = await nodeId(p, "#go");
    await p.click(p.main, goId);
    await p.settle();
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("hello Ada");
    // Typing with clear=true replaces existing text.
    await p.type(p.main, nameId, "Grace");
    expect(await p.main.evaluate<string>("document.getElementById('name').value")).toBe("Grace");
    // Per-key typing sends every character as a key press, spaces and "+" included (not shortcuts).
    await p.type(p.main, nameId, "Ada Lovelace +1 (555) é😀", { perKey: true });
    expect(await p.main.evaluate<string>("document.getElementById('name').value")).toBe("Ada Lovelace +1 (555) é😀");
    await p.close();
  });

  it("sets date/time inputs through the native setter and rejects bad formats", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    await p.type(p.main, await nodeId(p, "#when"), "19:30");
    expect(await p.main.evaluate<string>("document.getElementById('when').value")).toBe("19:30");
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("time=19:30");
    await p.type(p.main, await nodeId(p, "#day"), "2026-10-09");
    expect(await p.main.evaluate<string>("document.getElementById('day').value")).toBe("2026-10-09");
    await expect(p.type(p.main, await nodeId(p, "#day"), "next tuesday")).rejects.toMatchObject({ code: "not_interactable" });
    await p.close();
  });

  it("refuses to click through an overlay with a structured error", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    const covered = await nodeId(p, "#covered");
    await expect(p.click(p.main, covered)).rejects.toMatchObject({ name: "ActionError", code: "obscured" });
    await p.close();
  });

  it("a pseudo-element over the target covers it only when it belongs to another element than the target", async () => {
    const p = await browser.newPage();
    // Its own, its child's, or its label's ::before / ::after: a person's click there reaches the target.
    for (const k of ["label", "own", "child"]) {
      await p.navigate(`${a.origin}/pseudo?k=${k}`);
      await p.click(p.main, await nodeId(p, "#b"));
      await p.settle();
      expect(await p.main.evaluate<string>("document.title"), k).toBe("clicked");
    }
    // A wrapper's, a sibling's or body's (a modal backdrop): the click would go to that element instead.
    for (const k of ["wrapper", "sibling", "modal"]) {
      await p.navigate(`${a.origin}/pseudo?k=${k}`);
      await expect(p.click(p.main, await nodeId(p, "#b")), k).rejects.toMatchObject({ name: "ActionError", code: "obscured" });
    }
    await p.close();
  });

  it("clicks a button left under a sticky header by centring it first", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/sticky`);
    const buy = await nodeId(p, "#buy");
    await p.click(p.main, buy);
    expect(await p.main.evaluate<string>("document.title")).toBe("bought");
    await p.close();
  });

  it("clicks a button whose own visible label sits on top of it (Amazon-style a-button)", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    await p.click(p.main, await nodeId(p, "#atc"));
    await p.settle();
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("added");
    await p.close();
  });

  it("selects options and handles dialogs by policy", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    const sel = await nodeId(p, "#sel");
    expect(await p.selectOption(p.main, sel, ["Beta"])).toEqual(["b"]);
    await expect(p.selectOption(p.main, sel, ["Gamma"])).rejects.toBeInstanceOf(ActionError);

    await p.click(p.main, await nodeId(p, "#alert"));
    await p.settle();
    expect(p.dialogs.at(-1)).toMatchObject({ type: "alert", message: "hi", handledWith: "accept" });

    p.dialogHandler = () => ({ accept: true });
    await p.click(p.main, await nodeId(p, "#confirm"));
    await p.settle();
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("yes");
    await p.close();
  });

  it("settle() waits for slow network and reports honestly", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    await p.click(p.main, await nodeId(p, "#slow"));
    const r = await p.settle({ networkTimeoutMs: 3_000 });
    expect(r.networkIdle).toBe(true);
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("slow-done");
    await p.close();
  });

  it("attaches to a cross-origin OOPIF as a child session and clicks inside it", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/oopif?src=${encodeURIComponent(`${b.origin}/frame`)}`);
    // Give the OOPIF a moment to attach + load.
    const deadline = Date.now() + 10_000;
    while (p.frames().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(p.frames().length).toBe(2);
    const child = p.frames()[1]!;
    expect(child.url).toContain(b.origin);
    await child.session.waitFor("Page.lifecycleEvent", (e) => e.name === "load", 10_000).catch(() => undefined);
    const inner = await nodeIdIn(child, "#inner");
    await p.click(child, inner);
    await p.settle();
    const title = await child.evaluate<string>("document.title");
    expect(title).toBe("clicked-in-oopif");
    await p.close();
  });

  // Such a tab has no renderer until it is released, and used to stay paused for good: no "page", no load.
  it("reports a tab whose opener Chrome cut off (noopener, noreferrer, a target=_blank link or form) as a page that loads", async () => {
    const p = await browser.newPage();
    try {
      await p.navigate(`${a.origin}/tabs`);
      const opens: Record<string, string> = {
        noopener: "window.open('/second?via=noopener', '_blank', 'noopener')",
        noreferrer: "window.open('/second?via=noreferrer', '_blank', 'noreferrer')",
        link: "document.getElementById('blank').click()",
        form: "document.getElementById('form').submit()",
      };
      for (const [via, open] of Object.entries(opens)) {
        const tab = await new Promise<Page>((resolve, reject) => {
          const t = setTimeout(() => (off(), reject(new Error(`${via}: no page within 15 s`))), 15_000);
          const off = browser.on("page", (q) => {
            if (q.openerId !== p.targetId) return;
            clearTimeout(t);
            off();
            resolve(q);
          });
          void p.main.evaluate(`${open}; 1`, { mainWorld: true }).catch(() => undefined);
        });
        const deadline = Date.now() + 10_000;
        while (!tab.url.includes("?via=") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(tab.url, via).toBe(`${a.origin}/second?via=${via}`);
        // The address is the commit's; under load the document can still be parsing then: wait for its heading.
        const heading = () => tab.main.evaluate<string>("document.querySelector('h1')?.textContent ?? ''").catch(() => "");
        let h1 = await heading();
        while (h1 !== "Second" && Date.now() < deadline + 5_000) {
          await new Promise((r) => setTimeout(r, 50));
          h1 = await heading();
        }
        expect(h1, via).toBe("Second");
        await tab.close();
      }
    } finally {
      await p.close().catch(() => undefined);
    }
  });

  it("navigates history and takes screenshots", async () => {
    const p = await browser.newPage();
    await p.navigate(`${a.origin}/`);
    await p.click(p.main, await nodeId(p, "#link"));
    await p.session.waitFor("Page.lifecycleEvent", (e) => e.name === "load", 10_000);
    expect(p.url).toBe(`${a.origin}/second`);
    expect(await p.goBack()).toBe(true);
    expect(p.url).toBe(`${a.origin}/`);
    const png = await p.screenshot();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    await p.close();
  });
});

// Test-only helpers: resolve a CSS selector to a backendNodeId via DOM.getDocument/querySelector.
async function nodeId(p: import("./page.js").Page, selector: string): Promise<number> {
  return nodeIdIn(p.main, selector);
}
async function nodeIdIn(frame: import("./page.js").FrameSession, selector: string): Promise<number> {
  const { root } = await frame.session.send("DOM.getDocument", { depth: 0 });
  const { nodeId: id } = await frame.session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!id) throw new Error(`no element for ${selector}`);
  const { node } = await frame.session.send("DOM.describeNode", { nodeId: id });
  return node.backendNodeId;
}
