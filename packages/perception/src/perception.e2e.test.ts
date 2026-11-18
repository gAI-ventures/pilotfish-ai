// Perception e2e: snapshot grammar, refs, find, handles, evidence on real Chromium.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser, type Page } from "@pilotfish/browser";
import { captureSnapshot, serializeSnapshot, findInSnapshot, handleFor, resolveHandle, diffSnapshots, formatEvidence, pageText, textOf, describeNode, controlStates, urlParams, nodeKey, type Snapshot } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const HTML = `<!doctype html><html><head><title>Shop</title><style>.hidden{display:none}</style></head><body>
<nav aria-label="Main"><a href="/">Home</a><a href="/cart">Cart (0)</a></nav>
<main>
<h1>Products</h1>
<form id="f">
  <label for="q">Search</label><input id="q" type="search" placeholder="Search products">
  <select id="sort"><option value="new">Newest</option><option value="price" selected>Price</option></select>
  <label><input type="checkbox" id="instock"> In stock only</label>
  <button type="button" id="apply" onclick="document.getElementById('status').textContent='Filtered: '+document.getElementById('q').value; document.getElementById('more').classList.remove('hidden')">Apply</button>
</form>
<p id="status"></p>
<div id="more" class="hidden"><button id="extra">Load more</button></div>
<ul id="list"><li>Widget <button class="add" data-testid="add-1">Add</button></li><li>Gadget <button class="add" data-testid="add-2">Add</button></li></ul>
<div id="scroller" style="height:60px;overflow:auto"><div style="height:400px">tall content<a href="/deep">deep link</a></div></div>
<div style="opacity:0"><button id="ghost">ghost</button></div>
<iframe id="same" style="height:60px" srcdoc="<label for='em'>Work email</label><input id='em'>"></iframe>
<div class="card"><a href="/p/lamp"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"></a><a href="/p/lamp">Blue desk lamp</a><a href="/p/lamp#reviews">(128 reviews)</a></div>
<div style="display:contents"><div style="display:contents" aria-label="cards"><section><h2>Sea view flat</h2><p>Cozy flat near the beach</p><button id="reserve">Reserve</button></section></div></div>
<div id="host"></div>
<script>
  const sr = document.getElementById('host').attachShadow({mode:'open'});
  sr.innerHTML = '<button id="shadow-btn">Shadow button</button>';
</script>
<div style="height:3000px"></div>
<button id="far">Far below</button>
</body></html>`;

describe.skipIf(!E2E)("perception e2e", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let page: Page;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      // Every element absolutely or fixed positioned: <html> and <body> have no height at all.
      if (req.url === "/positioned") return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body style="margin:0">
<button style="position:absolute;left:300px;top:300px;width:160px;height:40px">View more</button>
<div role="dialog" style="position:fixed;left:200px;top:150px;width:400px;height:120px;background:#fff"><p>Join our newsletter</p><input type="email" aria-label="Email"></div>
<div style="position:absolute;top:500px;height:0;overflow:hidden"><button>Collapsed item</button><p>Collapsed text</p></div>
</body></html>`);
      // Single-character controls next to letter-by-letter animated text (one <span> per character).
      // A page that hides its background from assistive tech while a listbox or a modal dialog is open (17 Nov), with two
      // options told apart only by their aria-label, and (?modal) a page that loads with its modal already open.
      if (req.url?.startsWith("/hidden")) return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Trips</title></head><body>
<header><nav aria-label="Main"><a href="/" aria-label="Home">Logo</a><button>Sign in</button></nav></header>
<main id="bg"><h1>Find a trip</h1>
<div role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0" id="cb" aria-label="Ticket type. Round trip">Round trip</div>
<input aria-label="Where from?" value="Delhi"><label for="to">Where to?</label><input id="to" value="">
<ul role="listbox" aria-label="Places"><li role="option" tabindex="0" aria-label="North Goa, region">North Goa</li><li role="option" tabindex="0" aria-label="North Goa, city">North Goa</li></ul>
<button id="search">Search</button><span id="lbl">Fare alerts</span><button aria-labelledby="lbl">🔔</button>
<button id="mix">Book<span style="display:none"> hidden extra</span></button>
<button id="g1" style="display:none">Ghost none</button><button id="g2" style="opacity:0">Ghost faded</button><button id="g3" hidden>Ghost attr</button>
</main>
<ul id="lb" role="listbox" aria-label="Ticket types" hidden><li role="option">Round trip</li><li role="option">One way</li></ul>
<dialog id="dlg"><p>Save 10% when you sign in</p><button onclick="this.closest('dialog').close()">Dismiss</button></dialog>
${req.url.includes("modal") ? "<script>document.getElementById('dlg').showModal()</script>" : ""}
</body></html>`);
      if (req.url === "/letters") return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Dates</title></head><body>
<div id="days">${Array.from({ length: 31 }, (_, i) => `<button type="button">${i + 1}</button>`).join("")}</div>
<nav id="pager"><button>‹</button>${Array.from({ length: 6 }, (_, i) => `<button>${i + 1}</button>`).join("")}<button>›</button></nav>
<nav id="index">${[..."ABCDEFGH"].map((ch) => `<button>${ch}</button>`).join("")}</nav>
<p id="anim">${[..."Total price"].map((ch) => (ch === " " ? " " : `<span>${ch}</span>`)).join("")}</p>
<p>Total price $120</p>
</body></html>`);
      // Click listeners on containers (flatpickr's day grid): the cells are the targets, the spans of a link are not.
      if (req.url === "/delegated") return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Delegated</title>
<style>#days span,#roving span,#plain span{display:inline-block;width:30px}.day{cursor:pointer}#roving,.card{cursor:pointer}</style></head><body>
<input id="date" placeholder="Pick a date">
<div id="days" style="width:240px">${Array.from({ length: 31 }, (_, i) => `<span class="day" tabindex="-1" aria-label="October ${i + 1}, 2026">${i + 1}</span>`).join("")}</div>
<div id="roving" style="width:240px">${Array.from({ length: 7 }, (_, i) => `<span tabindex="-1" aria-label="November ${i + 1}, 2026">${i + 1}</span>`).join("")}</div>
<div id="plain" style="width:240px">${Array.from({ length: 9 }, (_, i) => `<span>${i + 1}</span>`).join("")}</div>
<div id="card" class="card"><span>Blue lamp</span> <span>$40</span></div>
<p><a id="shop" href="/shop"><span>Shop</span> <span>now</span></a></p>
<button id="go"><span style="cursor:pointer">Go</span></button>
<script>for (const id of ["days", "roving", "plain", "card"]) document.getElementById(id).addEventListener("click", (e) => { document.getElementById("date").value = e.target.getAttribute("aria-label") || e.target.textContent; });</script>
</body></html>`);
      // Accessible names next to visible text: some say more than the text, some only repeat it.
      if (req.url === "/names") return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Names</title></head><body>
<button id="close" aria-label="Close dialog">×</button>
<button id="trash" aria-label="Delete row 3" title="Delete row 3">🗑</button>
<button id="search" aria-label="Search"><svg width="16" height="16"><circle cx="8" cy="8" r="6" /></svg></button>
<a id="home" href="/">Home</a>
<a id="more" href="/pricing" aria-label="Read more about pricing">Read more</a>
<a id="plans" href="/plans" aria-label="Plans">Pricing plans</a>
<button id="save" aria-label="save">Save draft</button>
<span id="gift-label">Gift wrap</span> <button id="gift" role="switch" aria-checked="false" aria-labelledby="gift-label">Off</button>
<a id="mug" href="/p/mug"><img alt="Blue mug" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"> Blue mug</a>
<input id="digit" aria-label="Digit 1" maxlength="1"> <select id="sort" aria-label="Sort by"><option>Newest</option></select> <input id="confirm" type="button" value="OK" aria-label="Confirm order">
<input id="q" placeholder="Search" aria-label="Search">
<a id="story" href="/news/1"><img alt="Firefighters at the scene" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"> Earthquake hits the region</a>
</body></html>`);
      // Applied filters live in control state, not in the text: checked boxes, selects, pressed chips.
      if (req.url?.startsWith("/filters")) return void res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Results</title></head><body>
<label><input type="checkbox" name="vegan" checked> Vegan</label> <label><input type="checkbox" name="gf"> Gluten free</label>
<label style="position:relative"><input type="checkbox" name="deal" checked style="position:absolute;opacity:0;width:0;height:0"> <span>On sale</span></label>
<select aria-label="Sort by"><option>Relevance</option><option selected>Price: low to high</option></select>
<button aria-pressed="true">4+ stars</button> <button aria-pressed="false">Prime</button>
<nav><a href="/filters?page=1">1</a> <a href="/filters?page=2" aria-current="page">2</a></nav>
<input aria-label="Max price" value="50"> <input type="password" aria-label="Pin" value="1234">
<label><input type="checkbox" name="ship" disabled> Shipping</label> <input type="checkbox" name="today" aria-label="Get it today" disabled style="display:none">
<a href="/filters?brand=pny" aria-disabled="true">PNY</a> <button disabled>Clear all</button>
</body></html>`);
      res.end(HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
    page = await browser.newPage();
    await page.navigate(origin + "/");
    await page.settle();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("lists the state of the page's controls and its URL parameters for a reviewer", async () => {
    await page.navigate(origin + "/filters?q=pizza&diet=vegan");
    await page.settle();
    const lines = controlStates(await captureSnapshot(page, { viewportBand: Infinity }));
    expect(lines).toEqual(
      expect.arrayContaining(['checked box: "Vegan" (vegan)', 'checked box: "On sale" (deal)', 'select "Sort by" = "Price: low to high"', 'pressed: "4+ stars"', 'current page: "2"', 'field "Max price" = "50"']),
    );
    // Greyed-out filters, hidden or not, follow in their own list.
    expect(lines.slice(-4)).toEqual(['disabled box: "Shipping" (ship)', 'disabled box: "Get it today" (today)', 'disabled link: "PNY"', 'disabled button: "Clear all"']);
    expect(lines.join("\n")).not.toMatch(/Gluten free|Prime|1234|Pin/);
    expect(urlParams(page.url)).toBe("q=pizza; diet=vegan");
    await page.navigate(origin + "/");
    await page.settle();
  });

  it("serializes interactive elements with refs, roles, states, shadow DOM and scroll containers", async () => {
    const snap = await captureSnapshot(page);
    const text = serializeSnapshot(snap);
    // eslint-disable-next-line no-console
    console.log(text);
    expect(text).toMatch(/\[e\d+\]<a href="\/cart">Cart \(0\)<\/a>/);
    expect(text).toMatch(/<h1>Products<\/h1>/);
    expect(text).toMatch(/\[e\d+\]<input type="search" placeholder="Search products"/);
    expect(text).toMatch(/\[e\d+\]<select[^\n]*options=\[Newest \| \*Price\]/);
    expect(text).toMatch(/\[e\d+\]<input type="checkbox"[^\n]*label="In stock only"/);
    expect(text).toMatch(/\|SHADOW\(open\)\|/);
    expect(text).toMatch(/\[e\d+\]<button[^\n]*>Shadow button<\/button>/);
    expect(text).toMatch(/\|SCROLL\|\[e\d+\]<div/);
    expect(text).not.toMatch(/ghost/); // opacity:0 subtree hidden
    expect(text).not.toMatch(/Load more/); // display:none
    expect(text).toMatch(/interactive elements below the viewport/); // "Far below" is 3000px down
    expect(text).not.toMatch(/Far below/);
    // Whole-page mode includes it.
    const full = serializeSnapshot(await captureSnapshot(page, { viewportBand: Infinity }));
    expect(full).toMatch(/Far below/);
  });

  it("follows the page when it is scrolled: boxes are viewport-relative and the band moves with the viewport (4 Nov)", async () => {
    // "Far below" sits 3000 px down: out of the band at the top, in it once the page is scrolled to it.
    expect(serializeSnapshot(await captureSnapshot(page))).not.toMatch(/Far below/);
    try {
      await page.main.evaluate("document.getElementById('far').scrollIntoView({ block: 'center' })");
      const snap = await captureSnapshot(page);
      expect(snap.scroll.y).toBeGreaterThan(2000);
      const text = serializeSnapshot(snap);
      expect(text).toMatch(/\[e\d+\][^\n]*Far below/);
      expect(text).toMatch(/interactive elements above the viewport/);
      // The box is where the page draws it now (getBoundingClientRect), not where it sits in the document.
      const far = [...snap.byRef.values()].find((n) => /Far below/.test(n.name))!;
      const live = await page.main.evaluate<number>("document.getElementById('far').getBoundingClientRect().top");
      expect(Math.abs(far.rect!.y - live)).toBeLessThan(2);
      expect(far.rect!.y).toBeLessThan(snap.viewport.height);
      // Printed for the visible screen only: the button shows, the cart link at the top is counted above.
      const screen = serializeSnapshot(snap, { band: 0 });
      expect(screen).toMatch(/Far below/);
      expect(screen).not.toMatch(/Cart \(0\)/);
    } finally {
      await page.main.evaluate("window.scrollTo(0, 0)");
    }
  });

  it("find() locates elements by words and handles re-ground after DOM replacement", async () => {
    const snap = await captureSnapshot(page);
    const hits = findInSnapshot(snap, "add");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const first = hits.find((n) => n.attrs["data-testid"] === "add-1")!;
    const h = handleFor(first);
    expect(h.nth).toBe(0);
    const second = hits.find((n) => n.attrs["data-testid"] === "add-2")!;
    expect(handleFor(second).identity).toBe("t:add-2"); // identified by data-testid, not position

    // Replace the list DOM (same structure, new nodes) -> backendNodeIds die, structural key survives.
    await page.main.evaluate(`document.getElementById('list').innerHTML = document.getElementById('list').innerHTML`);
    const r = await resolveHandle(page, h);
    expect(r.how).toBe("regrounded");
    expect(r.handle.backendNodeId).not.toBe(h.backendNodeId);
    expect(r.handle.nth).toBe(0);
    // Click via the regrounded handle works.
    await page.click(r.handle.frame, r.handle.backendNodeId);
  });

  it("re-grounds an element caught mid-redraw: gone at the first look, back 300 ms later", async () => {
    const snap = await captureSnapshot(page);
    const h = handleFor(findInSnapshot(snap, "add").find((n) => n.attrs["data-testid"] === "add-1")!);
    // The page takes the list away and draws it again a moment later (results reloading under a tab bar).
    await page.main.evaluate(`(() => { const l = document.getElementById('list'); const html = l.innerHTML; l.innerHTML = ''; setTimeout(() => { l.innerHTML = html; }, 300); })()`);
    const r = await resolveHandle(page, h);
    expect(r.how).toBe("regrounded");
    expect(r.handle.nth).toBe(0);
    await page.click(r.handle.frame, r.handle.backendNodeId);
  });

  it("produces evidence for an action and 'no change' for a no-op", async () => {
    const before = await captureSnapshot(page);
    const q = [...before.byRef.values()].find((n) => n.attrs["id"] === "q")!;
    await page.type(q.frame, q.backendNodeId, "lamp");
    const apply = [...before.byRef.values()].find((n) => n.attrs["id"] === "apply")!;
    const mark = page.main.network.mark();
    await page.click(apply.frame, apply.backendNodeId);
    const settle = await page.settle();
    const after = await captureSnapshot(page, { previous: before });
    const ev = diffSnapshots(before, after, { settle, network: { requests: page.main.network.stats().totalRequests - mark.total, failed: 0 } });
    const txt = formatEvidence(ev);
    // eslint-disable-next-line no-console
    console.log(txt);
    expect(ev.changed).toBe(true);
    expect(ev.valueChanges.some((v) => v.to === "lamp")).toBe(true);
    expect(ev.newText.some((t) => t.includes("Filtered: lamp"))).toBe(true);
    expect(ev.addedCount).toBeGreaterThanOrEqual(1); // "Load more" appeared
    expect(serializeSnapshot(after, { previous: before })).toMatch(/\*\[e\d+\]<button[^\n]*>Load more<\/button>/);

    // No-op: hover over the heading.
    const before2 = after;
    const after2 = await captureSnapshot(page);
    const ev2 = diffSnapshots(before2, after2);
    expect(ev2.changed).toBe(false);
    expect(formatEvidence(ev2)).toMatch(/no observable change/);
  });

  it("keeps refs stable for surviving elements and gives new elements fresh numbers", async () => {
    const before = await captureSnapshot(page);
    const refOf = (snap: typeof before, testid: string) => [...snap.byRef.values()].find((n) => n.attrs["data-testid"] === testid)?.ref;
    const add2 = refOf(before, "add-2")!;
    const max = Math.max(...[...before.byRef.keys()].filter((r) => /^e\d+$/.test(r)).map((r) => Number(r.slice(1))));
    // Remove an element that comes *before* add-2 in document order and insert a new one.
    await page.main.evaluate(`document.querySelector('[data-testid=add-1]').remove(); const b = document.createElement('button'); b.textContent = 'Brand new'; document.querySelector('#list').prepend(b);`);
    const after = await captureSnapshot(page, { previous: before });
    expect(refOf(after, "add-2")).toBe(add2);
    const fresh = [...after.byRef.values()].find((n) => n.name === "Brand new" || n.attrs["data-testid"] === undefined && /Brand new/.test(n.children.map((c) => c.text ?? "").join("")))!;
    expect(Number(fresh.ref!.slice(1))).toBeGreaterThan(max);
    // html/body are never refs even when they have click listeners.
    await page.main.evaluate(`document.body.addEventListener('click', () => {}); document.documentElement.addEventListener('click', () => {});`);
    const shells = await captureSnapshot(page);
    expect([...shells.byRef.values()].some((n) => n.tag === "html" || n.tag === "body")).toBe(false);
  });

  it("refuses to re-ground a positional handle when look-alikes were added or removed", async () => {
    await page.main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="dup"><button>Same</button><button>Same</button></div>')`);
    const snap = await captureSnapshot(page, { viewportBand: Infinity });
    const second = [...snap.byRef.values()].filter((n) => n.tag === "button" && n.name === "Same")[1]!;
    const h = handleFor(second);
    expect(h.identity).toBe("");
    // Remove the first look-alike and re-render the second: positional key now matches a different count.
    await page.main.evaluate(`const d = document.getElementById('dup'); d.innerHTML = '<button>Same</button>';`);
    await expect(resolveHandle(page, h)).rejects.toMatchObject({ code: "stale" });
  });

  it("sees through display:contents wrappers but not display:none subtrees", async () => {
    const snap = await captureSnapshot(page, { viewportBand: Infinity });
    const text = serializeSnapshot(snap);
    expect(text).toMatch(/<h2>Sea view flat<\/h2>/);
    expect(text).toMatch(/Cozy flat near the beach/);
    expect(text).toMatch(/\[e\d+\]<button[^\n]*>Reserve<\/button>/);
    expect(pageText(snap)).toContain("Cozy flat near the beach");
    expect([...snap.byRef.values()].some((n) => n.attrs["id"] === "reserve")).toBe(true);
  });

  it("sees content whose html and body have no height (all of it positioned)", async () => {
    const other = await browser.newPage();
    await other.navigate(origin + "/positioned");
    const snap = await captureSnapshot(other, { viewportBand: 1 });
    const text = serializeSnapshot(snap);
    expect(text).toMatch(/\[e\d+\]<button>View more<\/button>/);
    expect(text).toMatch(/Join our newsletter/);
    expect(text).toMatch(/\[e\d+\]<input type="email"/);
    expect(pageText(snap)).toContain("Join our newsletter");
    // A collapsed accordion (height 0, overflow hidden) keeps its content hidden.
    expect(text).not.toMatch(/Collapsed/);
    expect(pageText(snap)).not.toContain("Collapsed");
    await other.close();
  });

  it("keeps single-character buttons (calendar days, pager) but drops letter-by-letter text", async () => {
    const other = await browser.newPage();
    await other.navigate(origin + "/letters");
    const snap = await captureSnapshot(other, { viewportBand: Infinity });
    const text = serializeSnapshot(snap);
    const byId = (id: string) => snap.nodes.find((n) => n.attrs["id"] === id)!;
    for (const [id, labels] of [["days", Array.from({ length: 31 }, (_, i) => String(i + 1))], ["pager", ["‹", "1", "2", "3", "4", "5", "6", "›"]], ["index", [..."ABCDEFGH"]]] as const) {
      const buttons = byId(id).children;
      expect(buttons.map((b) => textOf(b))).toEqual(labels);
      for (const b of buttons) expect(text).toContain(`[${b.ref}]`);
    }
    // The animated copy is dropped; the readable one stays.
    expect(byId("anim").children).toEqual([]);
    expect(pageText(snap)).not.toMatch(/T\s+o\s+t\s+a\s+l/);
    expect(text).toContain("Total price $120");
    await other.close();
  });

  it("gives cells of a delegated click handler their own refs; spans of a link still fold into it", async () => {
    const other = await browser.newPage();
    await other.navigate(origin + "/delegated");
    const snap = await captureSnapshot(other, { viewportBand: Infinity });
    const text = serializeSnapshot(snap);
    const byId = (id: string) => snap.nodes.find((n) => n.attrs["id"] === id)!;
    // Own cursor: pointer (flatpickr), or tabindex="-1" with a label under an inherited cursor.
    for (const [id, count] of [["days", 31], ["roving", 7]] as const) {
      const cells = byId(id).children;
      expect(cells.map((c) => textOf(c))).toEqual(Array.from({ length: count }, (_, i) => String(i + 1)));
      for (const c of cells) expect(text).toContain(`[${c.ref}]<span aria-label="${c.attrs["aria-label"]}">${textOf(c)}</span>`);
    }
    // Two cells read "5"; their labels say which month each belongs to.
    expect(text).toContain(`[${byId("days").children[4]!.ref}]<span aria-label="October 5, 2026">5</span>`);
    expect(text).toContain(`[${byId("roving").children[4]!.ref}]<span aria-label="November 5, 2026">5</span>`);
    // Cells with no signal of their own fold into the container, which keeps all their text (days 1-9 too).
    expect(byId("plain").children.every((c) => !c.ref)).toBe(true);
    expect(text).toContain(`[${byId("plain").ref}]<div id="plain">1 2 3 4 5 6 7 8 9</div>`);
    // An inherited cursor is not a signal; nor is a cursor inside a native control.
    expect(text).toContain(`[${byId("card").ref}]<div id="card">Blue lamp $40</div>`);
    for (const id of ["card", "shop", "go"]) expect(byId(id).children.filter((c) => c.ref)).toEqual([]);
    expect(text).toContain(`[${byId("shop").ref}]<a href="/shop" id="shop">Shop now</a>`);
    expect(text).toContain(`[${byId("go").ref}]<button id="go">Go</button>`);
    // The ref clicks the day itself: the container's listener sees that cell as the target.
    const day5 = byId("days").children[4]!;
    await other.click(day5.frame, day5.backendNodeId);
    expect(await other.main.evaluate<string>(`document.getElementById("date").value`)).toBe("October 5, 2026");
    await other.close();
  });

  it("prints an accessible name once when it says more than the visible text", async () => {
    const other = await browser.newPage();
    await other.navigate(origin + "/names");
    const snap = await captureSnapshot(other, { viewportBand: Infinity });
    const text = serializeSnapshot(snap);
    const line = (id: string) => {
      const n = snap.nodes.find((x) => x.attrs["id"] === id)!;
      return text.split("\n").find((l) => l.includes(`[${n.ref}]`))!.trim();
    };
    // Icon buttons: the label names what the glyph does; a title repeating it is not printed again.
    expect(line("close")).toMatch(/^\[e\d+\]<button aria-label="Close dialog" id="close">×<\/button>$/);
    expect(line("trash")).toMatch(/^\[e\d+\]<button aria-label="Delete row 3" id="trash">🗑<\/button>$/);
    expect(line("search")).toMatch(/^\[e\d+\]<button id="search">Search<\/button>$/); // no text: the name is the text
    expect(line("more")).toMatch(/^\[e\d+\]<a href="\/pricing" aria-label="Read more about pricing" id="more">Read more<\/a>$/);
    // aria-labelledby has no attribute to print under.
    expect(line("gift")).toMatch(/^\[e\d+\]<button role="switch" id="gift" label="Gift wrap">Off<\/button>$/);
    // Form controls print no text: a name from aria-label alone is their only label.
    expect(line("digit")).toMatch(/^\[e\d+\]<input aria-label="Digit 1" id="digit" value="" \/>$/);
    expect(line("sort")).toMatch(/^\[e\d+\]<select aria-label="Sort by" id="sort" options=\[\*Newest\] \/>$/);
    expect(line("confirm")).toMatch(/^\[e\d+\]<input type="button" aria-label="Confirm order" id="confirm" value="OK" \/>$/);
    expect(line("q")).toMatch(/^\[e\d+\]<input placeholder="Search" id="q" value="" \/>$/);
    // Names the text already says (equal, or contained ignoring case) stay hidden.
    expect(line("home")).toMatch(/^\[e\d+\]<a href="\/" id="home">Home<\/a>$/);
    expect(line("plans")).toMatch(/^\[e\d+\]<a href="\/plans" id="plans">Pricing plans<\/a>$/);
    expect(line("save")).toMatch(/^\[e\d+\]<button id="save">Save draft<\/button>$/);
    // So do names computed from the content, whose extra words are descendants' image alts.
    expect(line("mug")).toMatch(/^\[e\d+\]<a href="\/p\/mug" id="mug">Blue mug<\/a>$/);
    expect(line("story")).toMatch(/^\[e\d+\]<a href="\/news\/1" id="story">Earthquake hits the region<\/a>$/);
    // find() results and evidence use the same one-liner.
    expect(describeNode(snap.nodes.find((x) => x.attrs["id"] === "close")!)).toMatch(/^\[e\d+\]<button aria-label="Close dialog" id="close">×<\/button>$/);
    await other.close();
  });

  it("names elements inside same-process iframes from their own accessibility tree", async () => {
    const text = serializeSnapshot(await captureSnapshot(page, { viewportBand: Infinity }));
    expect(text).toMatch(/\[f?\d*e\d+\]<input[^\n]*label="Work email"/);
  });

  it("keeps one ref per repeated link in a card and shows the copies as text", async () => {
    const text = serializeSnapshot(await captureSnapshot(page, { viewportBand: Infinity }));
    expect(text.match(/\[e\d+\]<a href="\/p\/lamp[^"]*"/g)).toEqual([expect.stringMatching(/href="\/p\/lamp"/)]);
    expect(text).toMatch(/\[e\d+\]<a href="\/p\/lamp">Blue desk lamp<\/a>/);
    expect(text).toMatch(/^\s*\(128 reviews\)$/m);
  });

  describe("elements the page hides from assistive tech (17 Nov)", () => {
    // The tests after these read the shop page.
    afterAll(async () => void (await page.navigate(origin + "/")));
    const keysOf = (s: Snapshot) => new Map([...s.byRef].map(([r, n]) => [r, nodeKey(n)]));
    const hide = `document.querySelector('header').setAttribute('aria-hidden','true'); document.getElementById('bg').setAttribute('aria-hidden','true');
      document.getElementById('lb').hidden = false; document.getElementById('cb').setAttribute('aria-expanded','true')`;
    const show = `document.querySelector('header').removeAttribute('aria-hidden'); document.getElementById('bg').removeAttribute('aria-hidden');
      document.getElementById('lb').hidden = true; document.getElementById('cb').setAttribute('aria-expanded','false')`;

    it("keeps refs, names and keys while a listbox hides the background, and reports only the real change", async () => {
      await page.navigate(origin + "/hidden");
      const a = await captureSnapshot(page, { viewportBand: 1 });
      await page.main.evaluate(hide);
      const b = await captureSnapshot(page, { viewportBand: 1, previous: a });
      // Every element of the first capture keeps its ref and its structural key.
      for (const [ref, key] of keysOf(a)) expect(nodeKey(b.byRef.get(ref)!), ref).toBe(key);
      expect([...b.byRef.values()].filter((n) => !a.byRef.has(n.ref!)).map((n) => n.role)).toEqual(["listbox", "option", "option"]);
      const ev = diffSnapshots(a, b);
      expect(ev.removedCount).toBe(0);
      expect(ev.addedCount).toBe(3);
      expect(ev.stateChanges.some((s) => /expanded: false → true/.test(s))).toBe(true);
      // The background prints as it did, but for the line whose state changed.
      const strip = (t: string) => t.split("\n").map((l) => l.replace(/^(\t*)\*/, "$1"));
      const before = strip(serializeSnapshot(a, { compactAttrs: true, compactMarkup: true }));
      const after = new Set(strip(serializeSnapshot(b, { compactAttrs: true, compactMarkup: true })));
      expect(before.filter((l) => !after.has(l)).map((l) => l.trim().slice(0, 4))).toEqual(["[e3]"]);
      // And back.
      await page.main.evaluate(show);
      const c = await captureSnapshot(page, { viewportBand: 1, previous: b });
      const back = diffSnapshots(b, c);
      expect(back.addedCount).toBe(0);
      expect(back.removedCount).toBe(3);
      for (const [ref, key] of keysOf(a)) expect(nodeKey(c.byRef.get(ref)!), ref).toBe(key);
    });

    it("never merges two hidden options told apart only by their aria-label; each keeps its ref on its own node", async () => {
      await page.navigate(origin + "/hidden");
      const a = await captureSnapshot(page, { viewportBand: 1 });
      await page.main.evaluate(hide);
      const b = await captureSnapshot(page, { viewportBand: 1, previous: a });
      await page.main.evaluate(show);
      const c = await captureSnapshot(page, { viewportBand: 1, previous: b });
      await page.main.evaluate(hide);
      // Without a previous capture too (the names then come from the DOM).
      const fresh = await captureSnapshot(page, { viewportBand: 1 });
      const twins = (s: Snapshot) => [...s.byRef.values()].filter((n) => n.role === "option" && textOf(n) === "North Goa");
      for (const s of [a, b, c, fresh]) {
        expect(twins(s).map((n) => n.name)).toEqual(["North Goa, region", "North Goa, city"]);
        expect(new Set(twins(s).map((n) => nodeKey(n))).size).toBe(2);
      }
      // The same ref on the same DOM node, by name, through open, hidden and shown again.
      const assoc = (s: Snapshot) => twins(s).map((n) => `${n.name}=${n.ref}@${n.backendNodeId}`);
      expect(assoc(b)).toEqual(assoc(a));
      expect(assoc(c)).toEqual(assoc(a));
      expect(new Set(twins(a).map((n) => n.ref)).size).toBe(2);
      expect(fresh.nodes.filter((n) => n.axHidden).length).toBeGreaterThan(0);
    });

    it("keeps layout and the accessibility channel apart: hidden content never comes back, names use visible text only", async () => {
      await page.navigate(origin + "/hidden");
      const a = await captureSnapshot(page, { viewportBand: 1 });
      await page.main.evaluate(hide);
      const b = await captureSnapshot(page, { viewportBand: 1, previous: a });
      const fresh = await captureSnapshot(page, { viewportBand: 1 });
      for (const s of [a, b, fresh]) {
        const byId = (id: string) => s.nodes.find((n) => n.attrs["id"] === id)!;
        // display:none, opacity:0 and [hidden] stay invisible with no ref, whatever the accessibility channel says.
        for (const g of ["g1", "g2", "g3"]) {
          expect(byId(g).visible, `${g}`).toBe(false);
          expect(byId(g).ref, `${g}`).toBeUndefined();
        }
        // aria-hidden is no visual state: the background stays visible and keeps its refs.
        expect(byId("search").visible).toBe(true);
        expect(byId("search").ref).toBeDefined();
        // A name read from the DOM leaves out text that is not shown.
        expect(byId("mix").name).toBe("Book");
      }
      expect(b.nodes.find((n) => n.attrs["id"] === "mix")!.axHidden).toBe(true);
      expect(fresh.nodes.find((n) => n.attrs["id"] === "mix")!.axHidden).toBe(true);
      expect(serializeSnapshot(fresh, {})).not.toContain("hidden extra");
      expect(serializeSnapshot(fresh, {})).not.toContain("Ghost");
    });

    it("names a hidden element from its label as it is now, not as it was", async () => {
      await page.navigate(origin + "/hidden");
      const a = await captureSnapshot(page, { viewportBand: 1 });
      await page.main.evaluate(`${hide}; document.getElementById('lbl').textContent = 'Price alerts'; document.getElementById('search').setAttribute('aria-label', 'Find flights')`);
      const b = await captureSnapshot(page, { viewportBand: 1, previous: a });
      const names = [...b.byRef.values()].map((n) => n.name);
      expect(names).toContain("Price alerts");
      expect(names).toContain("Find flights");
      expect(names).not.toContain("Fare alerts");
      // The <label for> name of a hidden input.
      expect(names).toContain("Where to?");
    });

    it("a modal dialog open at load: closing it reports only the dialog's elements as gone", async () => {
      await page.navigate(origin + "/hidden?modal");
      const a = await captureSnapshot(page, { viewportBand: 1 });
      expect(a.nodes.some((n) => n.axHidden && n.tag === "main")).toBe(true);
      await page.main.evaluate(`document.querySelector('#dlg button').click()`);
      const b = await captureSnapshot(page, { viewportBand: 1, previous: a });
      const ev = diffSnapshots(a, b);
      // The background named from the DOM while hidden matches what Chromium names it once shown.
      expect(ev.added).toEqual([]);
      expect(ev.removedCount).toBe(1);
      expect(ev.removed[0]).toContain("Dismiss");
    });
  });

  it("extracts readable page text", async () => {
    const snap = await captureSnapshot(page, { viewportBand: Infinity });
    const t = pageText(snap);
    expect(t).toContain("# Products");
    expect(t).toContain("[Cart (0)](/cart)");
    expect(t).toContain("Widget");
  });
});
