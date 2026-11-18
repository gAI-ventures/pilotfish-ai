// Unit tests for the serializer and controlStates over hand-built snapshot trees (the e2e suite
// covers real snapshots).
import { describe, expect, it } from "vitest";
import type { FrameSession, Rect } from "@pilotfish/browser";
import { controlStates, describeNode, findInSnapshot, findScored, serializeSnapshot } from "./serialize.js";
import { formatEvidence } from "./evidence.js";
import { nodeKey, type SnapNode, type Snapshot } from "./snapshot.js";

// ---------------------------------------------------------------- tiny tree builder

let row = 0;
let refs = 0;
let ids = 0;
type Child = SnapNode | string;
function E(tag: string, attrs: Record<string, string> = {}, children: Child[] = [], extra: Partial<SnapNode> = {}): SnapNode {
  const rect: Rect = extra.rect ?? { x: 20, y: 20 + (row++ % 24) * 30, width: 280, height: 24 };
  const n: SnapNode = {
    backendNodeId: ++ids,
    frame: {} as FrameSession,
    frameId: "main",
    parent: null,
    children: [],
    depth: 0,
    nodeType: 1,
    tag,
    attrs,
    role: "",
    name: "",
    visible: true,
    interactive: false,
    scrollable: false,
    isIframe: false,
    nth: 0,
    identity: "",
    groupSize: 1,
    rect,
    ...extra,
  };
  if (n.interactive && !n.ref) n.ref = `e${++refs}`;
  for (const c of children) {
    const child: SnapNode = typeof c === "string" ? { ...E("#text", {}, [], { rect: { ...n.rect! } }), nodeType: 3, text: c, ref: undefined } : c;
    child.parent = n;
    n.children.push(child);
  }
  return n;
}
/** An interactive element: it gets the next ref. */
const I = (tag: string, attrs: Record<string, string>, children: Child[], extra: Partial<SnapNode> = {}) => E(tag, attrs, children, { interactive: true, ...extra });

function S(body: Child[]): Snapshot {
  const root = E("body", {}, body, { rect: { x: 0, y: 0, width: 1280, height: 2000 } });
  const nodes: SnapNode[] = [];
  const byRef = new Map<string, SnapNode>();
  const walk = (n: SnapNode, depth: number) => {
    n.depth = depth;
    nodes.push(n);
    if (n.ref) byRef.set(n.ref, n);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return {
    takenAt: 0,
    url: "https://shop.example/",
    title: "",
    viewport: { x: 0, y: 0, width: 1280, height: 800 },
    content: { width: 1280, height: 2000 },
    scroll: { x: 0, y: 0 },
    root,
    nodes,
    byRef,
    frames: [],
    frameIndex: new Map(),
    offscreen: { above: 0, below: 0 },
    band: { top: 0, bottom: 2000 },
    keys: new Set(),
    refMemory: new Map(),
    maxRef: new Map(),
  };
}

const box = (label: string, extra: Partial<SnapNode> = {}, attrs: Record<string, string> = {}) => I("input", { type: "checkbox", ...attrs }, [], { role: "checkbox", name: label, ...extra });

// ---------------------------------------------------------------- controlStates

describe("controlStates: options selected by their look alone (9 Nov, MakeMyTrip)", () => {
  const tab = (cls: string, text: string, attrs: Record<string, string> = {}) => I("div", { class: cls, ...attrs }, [text], { role: "", name: "" });
  const looks = (snap: Snapshot) => controlStates(snap).filter((l) => l.startsWith("selected (by its look)"));
  it("a sort tab marked active among siblings that are not", () => {
    expect(looks(S([E("div", { class: "sortTabs" }, [tab("tab active", "Cheapest"), tab("tab", "Fastest"), tab("tab", "You May Prefer")])]))).toEqual(['selected (by its look): "Cheapest"']);
  });
  it("BEM, is-, camelCase and CSS-module state classes, and data-state", () => {
    expect(looks(S([E("ul", {}, [E("li", { class: "chip chip--selected" }, ["Non Stop"]), E("li", { class: "chip" }, ["1 Stop"])])]))).toEqual(['selected (by its look): "Non Stop"']);
    expect(looks(S([E("div", {}, [tab("seg is-active", "Price"), tab("seg", "Rating")])]))).toEqual(['selected (by its look): "Price"']);
    expect(looks(S([E("div", {}, [tab("sortTabActive", "Cheapest"), tab("sortTab", "Fastest")])]))).toEqual(['selected (by its look): "Cheapest"']);
    expect(looks(S([E("div", { role: "tablist" }, [tab("", "Overview", { "data-state": "inactive" }), tab("", "Reviews", { "data-state": "active" })])]))).toEqual(['selected (by its look): "Reviews"']);
  });
  it("not without an unmarked sibling of its kind, not a list where most are marked, not a carousel, not a long block", () => {
    // Alone, or every sibling marked.
    expect(looks(S([E("div", {}, [tab("tab active", "Only one")])]))).toEqual([]);
    expect(looks(S([E("div", {}, [tab("tab active", "A"), tab("tab active", "B")])]))).toEqual([]);
    // Most of a list marked: its rows' look, not a choice.
    expect(looks(S([E("div", {}, [tab("row active", "1"), tab("row active", "2"), tab("row active", "3"), tab("row", "4")])]))).toEqual([]);
    // Carousel libraries mark every slide in view.
    expect(looks(S([E("div", {}, [tab("slick-slide slick-active", "Slide 1"), tab("slick-slide", "Slide 2"), tab("slick-slide", "Slide 3")])]))).toEqual([]);
    // A card's whole text is no option's label.
    expect(looks(S([E("div", {}, [tab("card active", "A long card with a lot of text describing a hotel, its rooms, its prices and its reviews."), tab("card", "Other")])]))).toEqual([]);
    // Words that only contain a state word are no state.
    expect(looks(S([E("div", {}, [tab("tab inactive", "Off"), tab("tab", "On")])]))).toEqual([]);
    // A sibling of another kind is no peer.
    expect(looks(S([E("div", {}, [tab("tab active", "Cheapest"), tab("banner", "Sale")])]))).toEqual([]);
  });
  it("ARIA state is reported as before, not twice", () => {
    const lines = controlStates(S([E("div", { role: "tablist" }, [I("button", { class: "tab active", "aria-selected": "true" }, ["Cheapest"], { role: "tab", name: "Cheapest", selected: true }), I("button", { class: "tab", "aria-selected": "false" }, ["Fastest"], { role: "tab", name: "Fastest" })])]));
    expect(lines).toEqual(['selected tab: "Cheapest"']);
  });
});

describe("controlStates: disabled controls", () => {
  it("a hidden disabled checkbox is reported as a disabled box", () => {
    const snap = S([E("form", {}, [box("Shipping", { disabled: true, visible: false }), box("Pickup", { checked: true })])]);
    const lines = controlStates(snap);
    expect(lines).toContain('disabled box: "Shipping"');
    expect(lines).toContain('checked box: "Pickup"');
    // The disabled list follows the other states.
    expect(lines.indexOf('checked box: "Pickup"')).toBeLessThan(lines.indexOf('disabled box: "Shipping"'));
  });

  it("disabled options, links and buttons are listed; hidden ones and unnamed ones are not", () => {
    const snap = S([
      I("a", { href: "/c?brand=pny" }, ["PNY"], { role: "link", name: "PNY", disabled: true }),
      I("button", {}, ["Get it today"], { role: "button", name: "Get it today", disabled: true }),
      I("button", {}, ["Hidden"], { role: "button", name: "Hidden", disabled: true, visible: false }),
      I("button", {}, [], { role: "button", name: "", disabled: true }),
      E("select", {}, [E("option", {}, ["XL"], { role: "option", name: "XL", disabled: true })], { role: "combobox", name: "Size" }),
      box("Radio choice", { role: "radio", disabled: true }, { type: "radio", name: "speed" }),
    ]);
    const lines = controlStates(snap);
    expect(lines).toEqual(expect.arrayContaining(['disabled link: "PNY"', 'disabled button: "Get it today"', 'disabled option: "XL"', 'disabled radio: "Radio choice" (speed)']));
    expect(lines.join("\n")).not.toMatch(/Hidden|disabled button: ""/);
  });

  it("70 disabled facets do not push out a later checked box, and are capped at 15", () => {
    const facets = Array.from({ length: 70 }, (_, i) => box(`Facet ${i}`, { disabled: true }));
    const snap = S([E("form", {}, [...facets, box("In stock", { checked: true })])]);
    const lines = controlStates(snap);
    expect(lines).toContain('checked box: "In stock"');
    expect(lines.filter((l) => l.startsWith("disabled box:"))).toHaveLength(15);
    expect(lines[0]).toBe('checked box: "In stock"');
  });

  it("the main list keeps its own cap", () => {
    const snap = S([E("form", {}, [...Array.from({ length: 5 }, (_, i) => box(`On ${i}`, { checked: true })), box("Off", { disabled: true })])]);
    expect(controlStates(snap, { maxLines: 2 })).toEqual(['checked box: "On 0"', 'checked box: "On 1"', 'disabled box: "Off"']);
    expect(controlStates(snap, { maxDisabled: 0 })).not.toContain('disabled box: "Off"');
  });
});

// ---------------------------------------------------------------- one ref per clickable unit

describe("serializeSnapshot: nested refs", () => {
  const refCount = (s: string) => (s.match(/\[e\d+\]/g) ?? []).length;

  it("a calendar td around a day span prints one ref, the span's", () => {
    const day = (d: number) =>
      I("td", {}, [I("span", { "data-date": `2026-10-${String(d).padStart(2, "0")}` }, [String(d)], { role: "button", name: `${d} October 2026`, rect: { x: 8 + d * 40, y: 108, width: 24, height: 24 } })], {
        role: "gridcell",
        name: "",
        rect: { x: d * 40, y: 100, width: 40, height: 40 },
      });
    const snap = S([E("table", {}, [E("tr", {}, [day(5), day(6), day(7)])], { role: "grid", name: "October 2026" })]);
    const text = serializeSnapshot(snap);
    expect(refCount(text)).toBe(3);
    expect(text).toMatch(/\[e\d+\]<span[^\n]*data-date|\[e\d+\]<span[^\n]*>5<\/span>/);
    expect(text).not.toMatch(/<td/);
    // The cell keeps its ref in the table (handles and earlier refs still resolve), it just does not print.
    expect([...snap.byRef.values()].filter((n) => n.tag === "td")).toHaveLength(3);
  });

  it("a cell with text of its own (a price under the day) keeps both refs", () => {
    const cell = I("td", {}, [I("span", {}, ["5"], { role: "button", name: "5 October 2026", rect: { x: 8, y: 108, width: 24, height: 24 } }), E("small", {}, ["$120"])], {
      role: "gridcell",
      name: "",
      rect: { x: 0, y: 100, width: 40, height: 60 },
    });
    const text = serializeSnapshot(S([E("table", {}, [E("tr", {}, [cell])], { role: "grid" })]));
    expect(refCount(text)).toBe(2);
    expect(text).toMatch(/<td/);
  });

  it("a cell holding two controls, or a selected cell, keeps its own line", () => {
    const two = I("td", {}, [I("a", { href: "/a" }, ["A"], { role: "link", name: "A" }), I("a", { href: "/b" }, ["B"], { role: "link", name: "B" })], { role: "gridcell", rect: { x: 0, y: 100, width: 200, height: 40 } });
    const selected = I("td", {}, [I("span", {}, ["9"], { role: "button", name: "9 October 2026", rect: { x: 8, y: 208, width: 24, height: 24 } })], { role: "gridcell", selected: true, rect: { x: 0, y: 200, width: 40, height: 40 } });
    const text = serializeSnapshot(S([E("table", {}, [E("tr", {}, [two]), E("tr", {}, [selected])], { role: "grid" })]));
    expect(refCount(text)).toBe(5);
  });
});

// ---------------------------------------------------------------- a print band narrower than the capture's

describe("serializeSnapshot: band (the visible screen of a three-screen capture)", () => {
  // Cards down a 2400 px page, viewport 800 px high, captured with three screens (band 0-2400).
  const page = () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      E("div", {}, [I("a", { href: `/p/${i}` }, [`Product ${i}`], { role: "link", name: `Product ${i}`, rect: { x: 20, y: 40 + i * 200, width: 300, height: 24 } }), `Price ${i}`], { rect: { x: 0, y: 30 + i * 200, width: 400, height: 180 } }),
    );
    const s = S(cards);
    s.band = { top: 0, bottom: 2400 };
    s.offscreen = { above: 0, below: 5 };
    return s;
  };

  it("prints only what is on screen and counts the rest, with the capture's own count", () => {
    const s = page();
    const all = serializeSnapshot(s);
    expect(all).toContain("Product 11");
    const screen = serializeSnapshot(s, { band: 0 });
    for (let i = 0; i <= 3; i++) expect(screen, `card ${i}`).toContain(`Product ${i}`);
    expect(screen).toContain("Price 3");
    for (let i = 4; i < 12; i++) expect(screen, `card ${i}`).not.toContain(`Product ${i}<`);
    expect(screen).not.toContain("Price 11");
    // 8 cards below the screen in the capture, plus the 5 the capture had left out already.
    expect(screen).toContain("(13 interactive elements below the viewport; scroll down to reveal)");
    expect(screen.length).toBeLessThan(all.length / 2);
    // The capture is untouched: every ref still resolves.
    expect(s.byRef.size).toBe(12);
  });

  it("counts what is above once scrolled, and the default stays the capture's band", () => {
    const s = page();
    s.scroll = { x: 0, y: 1600 };
    // Card rects are viewport-relative: scrolled 1600 px, card i sits at 40 + 200i - 1600.
    for (const n of s.byRef.values()) n.rect = { ...n.rect!, y: n.rect!.y - 1600 };
    for (const n of s.nodes) if (!n.ref && n.tag === "div") n.rect = { ...n.rect!, y: n.rect!.y - 1600 };
    const screen = serializeSnapshot(s, { band: 0 });
    expect(screen).toMatch(/^\(8 interactive elements above the viewport; scroll up to reveal\)/);
    expect(screen).toContain("Product 8");
    expect(screen).not.toContain("Product 2<");
    expect(serializeSnapshot(s)).toContain("Product 2");
  });

  it("names the reader's own tools when it truncates", () => {
    const s = page();
    expect(serializeSnapshot(s, { maxChars: 120, moreHint: "browser_get_text for the page's text" })).toContain("(output truncated at 120 chars; browser_get_text for the page's text)");
    expect(serializeSnapshot(s, { maxChars: 120 })).toContain("use find() or read_page(rootRef) for more");
  });
});

describe("findScored: how models describe elements", () => {
  // A results page: a filter sidebar, sort control, result cards that mention the same words, a pager.
  const results = () =>
    S([
      E("div", {}, [
        E("h2", {}, ["Filter by"], { role: "heading", name: "Filter by" }),
        box("Free cancellation 2262"),
        box("Very Good: 8+ 1362"),
        box("Very good breakfast 82"),
        box("Charity Foundations"),
        I("a", { href: "/s?rating=4" }, ["4 Stars & Up"], { role: "link", name: "4 Stars & Up" }),
        I("input", { type: "text", placeholder: "Max" }, [], { role: "textbox", name: "Max price" }),
        I("button", {}, ["Go"], { role: "button", name: "Go" }),
      ]),
      I("select", { "aria-label": "Sort by:" }, [], { role: "combobox", name: "Sort by:" }),
      I("input", { type: "search", placeholder: "Search" }, [], { role: "searchbox", name: "Search" }),
      ...[1, 2, 3].map((i) => I("a", { href: `/item/${i}` }, [`Hotel ${i}. 4.${i} out of 5 stars, 120 customer reviews. Free cancellation`], { role: "link", name: `Hotel ${i}` })),
      I("a", { href: "/s?page=2" }, ["Next"], { role: "link", name: "Next" }),
    ]);

  it("finds a control the model describes with role and place words", () => {
    const s = results();
    const names = (q: string) => findScored(s, q).map((h) => h.node.name);
    expect(names("Charity Foundations category checkbox in Filter by")[0]).toBe("Charity Foundations");
    expect(names("Free cancellation filter checkbox")[0]).toBe("Free cancellation 2262");
    expect(names("Very Good: 8+ checkbox")[0]).toBe("Very Good: 8+ 1362");
    expect(names("Sort by dropdown")[0]).toBe("Sort by:");
    expect(names("Next page link")[0]).toBe("Next");
  });

  it("finds each of several targets in one query", () => {
    const names = findScored(results(), "max price input, Go button").map((h) => h.node.name);
    expect(names).toContain("Max price");
    expect(names).toContain("Go");
  });

  it("names a kind of element by its role when that is all the query says", () => {
    expect(findScored(results(), "search box")[0]?.node.name).toBe("Search");
  });

  it("puts the filter link above result cards that share its words, and marks partial matches", () => {
    const hits = findScored(results(), "4 Stars & Up customer review filter link");
    expect(hits[0]?.node.name).toBe("4 Stars & Up");
    expect(hits[0]?.exact).toBe(false);
  });

  it("keeps exact matches alone when there are some (no partial noise)", () => {
    const hits = findScored(results(), "Free cancellation");
    expect(hits.every((h) => h.exact)).toBe(true);
    expect(hits.map((h) => h.node.name)).toContain("Free cancellation 2262");
  });

  it("keeps position words that are an element's own label (a pager's Next, Back to top)", () => {
    const s = S([I("button", {}, ["Products"], { role: "button", name: "Products" }), I("button", {}, ["Next"], { role: "button", name: "Next" }), I("a", { href: "#top" }, ["Back to top"], { role: "link", name: "Back to top" })]);
    expect(findScored(s, "Next page button").map((h) => h.node.name)).toEqual(["Next"]);
    expect(findScored(s, "back to top link")[0]?.node.name).toBe("Back to top");
  });

  it("finds nothing for words nothing on the page has", () => {
    expect(findScored(results(), "Add to bag")).toEqual([]);
    expect(findInSnapshot(results(), "Add to bag")).toEqual([]);
  });
});

describe("shownHref: link targets in page text", async () => {
  const { shownHref } = await import("./serialize.js");
  it("keeps short targets whole and same-site addresses as paths", () => {
    expect(shownHref("/cart", "https://shop.example/x")).toBe("/cart");
    expect(shownHref("https://shop.example/s?k=lamp&page=2", "https://shop.example/x")).toBe("/s?k=lamp&page=2");
    expect(shownHref("https://other.example/a", "https://shop.example/")).toBe("other.example/a");
    expect(shownHref("#reviews", "https://shop.example/")).toBe("#reviews");
    expect(shownHref("mailto:a@b.c", "https://shop.example/")).toBe("mailto:a@b.c");
  });
  it("drops a long tracking query but keeps the path that names the page", () => {
    const amazon = "/OnePlus-Nord-Buds-3r/dp/B0FMDL81GS/ref=sr_1_3?dib=eyJ2IjoiMSJ9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dib_tag=se&keywords=wireless+earbuds&qid=1793000000&sr=8-3";
    expect(shownHref(amazon, "https://www.amazon.in/s?k=x")).toBe("/OnePlus-Nord-Buds-3r/dp/B0FMDL81GS/ref=sr_1_3?…");
  });
});

describe("findScored: a missing constraint word is no match", () => {
  it("does not offer 'Free shipping' for 'shipping today filter' when nothing says today", () => {
    const s = S([box("Free shipping"), I("button", {}, ["Get it by tomorrow"], { role: "button", name: "Get it by tomorrow" })]);
    expect(findScored(s, "shipping today filter")).toEqual([]);
  });
});

describe("serializeSnapshot: compactAttrs (lighter markup, same words)", () => {
  const card = () =>
    S([
      I("a", { href: "https://shop.example/Blue-Lamp/dp/B0LAMP1234/ref=sr_1_3?dib=eyJ2IjoiMSJ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&qid=1793000000&sr=8-3", id: ":r2l:" }, ["Blue desk lamp, 40 W"], { role: "link", name: "Blue desk lamp, 40 W" }),
      I("button", { "aria-controls": "_R_nd_", id: "Oacf4b", "aria-haspopup": "true" }, ["Sort by"], { role: "button", name: "Sort by" }),
      I("input", { type: "submit", id: "nav-search-submit-button", "data-testid": "search-go" }, [], { role: "button", name: "Go" }),
      E("p", {}, ["Rated 4.5 by 1,200 buyers"]),
    ]);
  it("shows a link's target as its path and drops pointer and generated ids, keeping every word and ref", () => {
    const snap = card();
    const full = serializeSnapshot(snap);
    const compact = serializeSnapshot(snap, { compactAttrs: true });
    expect(compact).toContain('href="/Blue-Lamp/dp/B0LAMP1234/ref=sr_1_3?…"');
    expect(compact).not.toContain("aria-controls");
    expect(compact).not.toContain(":r2l:");
    expect(compact).not.toContain("Oacf4b");
    expect(compact).toContain('id="nav-search-submit-button"');
    expect(compact).toContain('data-testid="search-go"');
    expect(compact).toContain('aria-haspopup="true"');
    for (const w of ["Blue desk lamp, 40 W", "Sort by", "Rated 4.5 by 1,200 buyers"]) expect(compact).toContain(w);
    expect(compact.match(/\[e\d+\]/g)).toEqual(full.match(/\[e\d+\]/g));
    expect(compact.length).toBeLessThan(full.length);
  });
  it("changes nothing without the option", () => {
    expect(serializeSnapshot(card())).toContain("aria-controls");
  });
});

describe("serializeSnapshot: compactMarkup (each word once)", () => {
  // A results row a person clicks, its texts in wrappers, with two controls of its own inside.
  const row = () =>
    S([
      I("div", {}, [E("div", {}, ["IndiGo"]), E("div", {}, [E("span", {}, ["2 hr 50 min"]), "DEL – BLR"]), I("span", { "aria-label": "Departure time: 5:15 AM." }, ["5:15 AM"]), E("div", {}, ["₹10,041"]), I("button", {}, ["Details"])], { role: "button", name: "IndiGo flight" }),
      E("h2", {}, ["Price insights"], { role: "heading" }),
      I("a", { href: "/history" }, ["View price history"], { role: "link", name: "View price history" }),
    ]);
  const words = (t: string) => new Set(t.replace(/\[e\d+\]|<[^>]*>?|"[^"]*"/g, " ").match(/[\p{L}\p{N}₹,:.]+/gu) ?? []);
  it("prints a row's text once, keeps every word and ref, and drops closing tags", () => {
    const snap = row();
    const full = serializeSnapshot(snap);
    const compact = serializeSnapshot(snap, { compactMarkup: true });
    expect(full.match(/IndiGo/g)!.length).toBe(2);
    expect(compact.match(/IndiGo/g)!.length).toBe(1);
    expect(compact).toContain("₹10,041");
    expect(compact).not.toMatch(/<\/\w+>/);
    expect(compact.match(/\[e\d+\]/g)).toEqual(full.match(/\[e\d+\]/g));
    for (const w of words(full)) expect(words(compact)).toContain(w);
    expect(compact).toContain("<h2>Price insights");
    expect(compact.length).toBeLessThan(full.length);
  });
  it("keeps the lines under a row whose own line was cut short", () => {
    const long = "x".repeat(150);
    const snap = S([I("div", {}, [E("div", {}, [long]), E("div", {}, ["Free cancellation"]), I("button", {}, ["Reserve"])], { role: "button" })]);
    const compact = serializeSnapshot(snap, { compactMarkup: true });
    expect(compact.match(/Free cancellation/g)!.length).toBeGreaterThanOrEqual(1);
    expect(compact.split("\n").some((l) => l.trim() === "Free cancellation")).toBe(true);
  });
  it("marks new elements only when some are not new", () => {
    const snap = row();
    const before = S([]);
    const allNew = serializeSnapshot(snap, { compactMarkup: true, previous: before });
    expect(allNew).not.toMatch(/^\t*\*/m);
    expect(serializeSnapshot(snap, { previous: before })).toMatch(/^\t*\*\[e/m);
    const some = S([]);
    some.keys = new Set([nodeKey(snap.byRef.values().next().value!)]);
    const mixed = serializeSnapshot(snap, { compactMarkup: true, previous: some });
    expect(mixed).toMatch(/^\t*\*\[e/m);
    expect(mixed.split("\n").find((l) => l.includes("IndiGo"))).not.toMatch(/^\t*\*/);
  });
  it("changes nothing without the option", () => {
    expect(serializeSnapshot(row())).toContain("</div>");
  });
});

describe("formatEvidence: shown", () => {
  const ev = {
    changed: true, navigated: true, urlBefore: "about:blank", urlAfter: "https://shop.example/", titleBefore: "", titleAfter: "Shop",
    dialogs: [], valueChanges: [], stateChanges: [], scrollDelta: { x: 0, y: 0 }, focusedBefore: null, focusedAfter: null,
    added: ["[e1]<a>Home</a>", "[e2]<button>Cart</button>", '<span aria-label="Departure time: 4:00 PM.">4:00 PM</span>'], addedCount: 40,
    removed: [], removedCount: 0, newText: ["Free delivery", "Only 2 left"], network: { requests: 12, failed: 0 },
  } as unknown as Parameters<typeof formatEvidence>[0];
  it("counts what the snapshot below shows instead of listing it twice", () => {
    const out = formatEvidence(ev, { shown: "[e1]<a>Home\n[e2]<button>Cart\nFree delivery" });
    expect(out).toContain("- 40 new interactive element(s): <span");
    expect(out).not.toContain("[e1]");
    expect(out).toContain('new text: "Only 2 left"');
    expect(out).not.toContain('"Free delivery"');
  });
  it("lists: false gives counts only; without options nothing changes", () => {
    expect(formatEvidence(ev, { lists: false })).toContain("- 40 new interactive element(s)\n");
    expect(formatEvidence(ev)).toContain("[e1]<a>Home</a> ; [e2]");
  });
});

describe("roleTags: shorter markup, the same facts (17 Nov)", () => {
  const page = () =>
    S([
      I("div", { role: "button", "aria-haspopup": "true" }, ["Departure"], { role: "button", name: "Departure" }),
      I("div", { role: "tab", "aria-haspopup": "dialog" }, ["Cheapest from ₹9,490"], { role: "tab", name: "Cheapest from ₹9,490", selected: true }),
      I("a", { href: "/flights", role: "link" }, ["Flights"], { role: "link", name: "Flights" }),
      I("input", { role: "combobox", type: "text", placeholder: "Where from?" }, [], { role: "combobox", name: "Where from?", value: "Delhi" }),
      I("button", { role: "tab" }, ["Best"], { role: "tab", name: "Best" }),
      I("td", { role: "gridcell" }, ["1"], { role: "gridcell", name: "Tuesday, December 1" }),
    ]);
  const opts = { compactAttrs: true, compactMarkup: true } as const;
  it("a generic tag with a page role prints as the role; a role the tag has is dropped; haspopup is short", () => {
    const out = serializeSnapshot(page(), { ...opts, roleTags: true });
    expect(out).toMatch(/\[e\d+\]<@button haspopup>Departure/);
    expect(out).toMatch(/\[e\d+\]<@tab haspopup=dialog selected>Cheapest from ₹9,490/);
    expect(out).toMatch(/\[e\d+\]<a href="\/flights">Flights/);
    // A native tag with another role keeps both; a table cell is not a generic tag.
    expect(out).toMatch(/\[e\d+\]<input [^\n]*role="combobox"/);
    expect(out).toMatch(/\[e\d+\]<button role="tab">Best/);
    expect(out).toMatch(/\[e\d+\]<td role="gridcell"/);
    expect(out).not.toContain('<div role=');
    expect(out).not.toContain("aria-haspopup");
  });
  it("a native button and an element the page made a button print differently", () => {
    const out = serializeSnapshot(
      // Explicit rects: the builder's shared row counter (other tests' layouts) is left as it was.
      S([
        I("button", {}, ["Native"], { role: "button", name: "Native", rect: { x: 20, y: 20, width: 280, height: 24 } }),
        I("div", { role: "button", tabindex: "0" }, ["Scripted"], { role: "button", name: "Scripted", rect: { x: 20, y: 50, width: 280, height: 24 } }),
      ]),
      { compactAttrs: true, compactMarkup: true, roleTags: true },
    );
    const lines = out.split("\n");
    expect(lines.find((l) => l.includes("Native"))).toMatch(/\]<button>Native$/);
    expect(lines.find((l) => l.includes("Scripted"))).toMatch(/\]<@button>Scripted$/);
  });
  it("ambiguous roles keep the old markup: custom, several, presentational; a native tag keeps its own word", () => {
    const out = serializeSnapshot(
      S([
        I("div", { role: "fancybutton" }, ["Custom"], { name: "Custom" }),
        I("div", { role: "button link" }, ["Two roles"], { name: "Two roles" }),
        I("span", { role: "presentation", tabindex: "0" }, ["Presentational"], { name: "Presentational" }),
        I("div", { role: "none", tabindex: "0" }, ["None"], { name: "None" }),
        I("a", { href: "/x", role: "button" }, ["Link as button"], { role: "button", name: "Link as button" }),
      ]),
      { compactAttrs: true, compactMarkup: true, roleTags: true },
    );
    expect(out).toContain('<div role="fancybutton">Custom');
    expect(out).toContain('<div role="button link">Two roles');
    expect(out).toContain('<span role="presentation">Presentational');
    expect(out).toContain('<div role="none">None');
    expect(out).toContain('<a href="/x" role="button">Link as button');
  });
  it("the same refs, words, values and states in the same order; shorter; without the option nothing changes", () => {
    const snap = page();
    const before = serializeSnapshot(snap, opts);
    const after = serializeSnapshot(snap, { ...opts, roleTags: true });
    expect(before).toContain('<div role="button" aria-haspopup="true">Departure');
    const facts = (s: string) => s.split("\n").map((l) => [l.match(/\[e\d+\]/)?.[0], l.replace(/<[^>]*>/, "").trim(), /selected/.test(l), l.match(/value="[^"]*"/)?.[0]]);
    expect(facts(after)).toEqual(facts(before));
    expect(after.length).toBeLessThan(before.length);
    expect(serializeSnapshot(snap, { ...opts, roleTags: false })).toBe(before);
  });
  it("describeNode (evidence and find lines) uses the same markup only when asked", () => {
    const snap = page();
    const first = [...snap.byRef.values()][0]!;
    expect(describeNode(first, "https://x.example/")).toContain('<div role="button" aria-haspopup="true">Departure</div>');
    expect(describeNode(first, "https://x.example/", true)).toContain("<@button haspopup>Departure</@button>");
  });
});

describe("formatEvidence: new tabs the list leaves out (17 Nov)", () => {
  const filters = ["[e16]<button>1</button>", "[e777]<button>All filters</button>", "[e778]<button>Stops</button>", "[e779]<button>Airlines</button>", "[e780]<button>Bags</button>"];
  const tabs = ['[e842]<div role="tab" selected>Best</div>', '[e843]<div role="tab">Cheapest from ₹9,584</div>', '[e850]<div role="tab">Fastest</div>', '[e851]<div role="tab">Greenest</div>', '[e852]<div role="tab">Earliest</div>'];
  const ev = (over: Record<string, unknown>) => ({
    changed: true, navigated: true, urlBefore: "https://flights.example/", urlAfter: "https://flights.example/search", titleBefore: "F", titleAfter: "Results",
    dialogs: [], valueChanges: [], stateChanges: [], scrollDelta: { x: 0, y: 0 }, focusedBefore: null, focusedAfter: null,
    added: [...filters, ...tabs].slice(0, 10), addedCount: 224, removed: [], removedCount: 0, newText: [], network: { requests: 3, failed: 0 },
    ...over,
  }) as unknown as Parameters<typeof formatEvidence>[0];
  const without = (out: string) => out.split("\n").filter((l) => !l.startsWith("- ") || !l.includes("new tab(s) not listed above")).join("\n");

  it("(a) more unlisted tabs than it names: the first three by description, the rest counted", () => {
    const out = formatEvidence(ev({ addedTabs: tabs, addedTabCount: 7 }));
    expect(out).toContain(`- 7 new tab(s) not listed above: ${tabs.slice(0, 3).join(" ; ")} (+4 more)`);
    // The list of new elements is the same first five as before.
    expect(out).toContain(`- 224 new interactive element(s): ${filters.join(" ; ")}\n`);
  });
  it("(b) no unlisted tabs: no line, even with unlisted elements of other roles", () => {
    const none = ev({});
    expect(formatEvidence(none)).not.toContain("new tab(s)");
    const otherRoles = ev({ added: [...filters, '[e900]<select role="combobox">Sort by</select>', '[e901]<div role="option">Price</div>'] });
    expect(formatEvidence(otherRoles)).not.toContain("new tab(s)");
  });
  it("(c) a tab already listed, or on the screen printed with the evidence, is not repeated", () => {
    const listedTab = ev({ added: [tabs[1], ...filters.slice(0, 4), tabs[0]], addedTabs: [tabs[1], tabs[0]], addedTabCount: 2 });
    const out = formatEvidence(listedTab);
    expect(out).toContain(`- 1 new tab(s) not listed above: ${tabs[0]}`);
    expect(out.split(tabs[1]!).length - 1).toBe(1);
    const allListed = ev({ added: [tabs[1], ...filters.slice(0, 4)], addedTabs: [tabs[1]], addedTabCount: 1 });
    expect(formatEvidence(allListed)).not.toContain("new tab(s)");
    const onScreen = ev({ addedTabs: [tabs[0], tabs[1]], addedTabCount: 2 });
    expect(formatEvidence(onScreen, { shown: "[e842]<div role=tab selected>Best\n[e843]<div role=tab>Cheapest from ₹9,584" })).not.toContain("new tab(s)");
  });
  it("(d) everything else is byte for byte what it was without the tabs; lists: false adds nothing", () => {
    const withTabs = ev({ addedTabs: tabs, addedTabCount: 5 });
    const before = ev({});
    for (const opts of [{}, { compactUrls: true }, { shown: "[e16]<button>1" }]) {
      const out = formatEvidence(withTabs, opts);
      expect(out).toContain("new tab(s) not listed above");
      expect(without(out)).toBe(formatEvidence(before, opts));
    }
    expect(formatEvidence(withTabs, { lists: false })).toBe(formatEvidence(before, { lists: false }));
  });
});

describe("formatEvidence: server requests", () => {
  const base = {
    changed: true, navigated: false, urlBefore: "https://travel.example/", urlAfter: "https://travel.example/", titleBefore: "T", titleAfter: "T",
    dialogs: [], valueChanges: [], stateChanges: [], scrollDelta: { x: 0, y: 0 }, added: [], addedCount: 0, removed: [], removedCount: 0, newText: [], network: { requests: 50, failed: 0 },
  };
  it("lists identical requests once with their count, then the other kinds (an autocomplete's lookups, 9 Nov)", () => {
    const lookup = { method: "POST", url: "https://travel.example/data/batchexecute?rpcids=x", status: 200, ok: true };
    const ev = { ...base, writes: [...Array.from({ length: 47 }, () => lookup), { method: "POST", url: "https://travel.example/log", status: 204, ok: true }] } as unknown as Parameters<typeof formatEvidence>[0];
    const out = formatEvidence(ev);
    expect(out.match(/- server: POST \/data\/batchexecute → 200/g)).toHaveLength(1);
    expect(out).toContain("- server: POST /data/batchexecute → 200 ×47");
    expect(out).toContain("- server: POST /log → 204");
    // A refusal is still its own line, never folded into an accepted one.
    const refused = { ...base, writes: [lookup, { ...lookup, status: 500, ok: false }] } as unknown as Parameters<typeof formatEvidence>[0];
    expect(formatEvidence(refused)).toContain("→ 500 — the server did NOT accept this");
  });
});

describe("serializeSnapshot: table rows on one line (9 Nov, BBC's league table)", () => {
  const league = () =>
    S([
      E("table", {}, [
        E("tr", {}, [E("th", {}, ["Team"]), E("th", {}, ["Played"]), E("th", {}, ["Form", E("span", {}, ["Last 6 games, Oldest first"])])]),
        E("tr", {}, [E("td", {}, [I("a", { href: "/teams/celtic" }, ["Celtic"], { identity: "celtic" })]), E("td", {}, ["13"]), E("td", {}, ["W W D"])]),
        E("tr", {}, [E("td", {}, [I("a", { href: "/teams/rangers" }, ["Rangers"], { identity: "rangers" })]), E("td", {}, ["12"]), E("td", {}, [])]),
      ]),
    ]);

  it("prints each row as its cells between bars, the header row marked, refs kept", () => {
    const out = serializeSnapshot(league(), { compactMarkup: true });
    expect(out).toContain("<th>Team | Played | Form Last 6 games, Oldest first");
    expect(out).toMatch(/\[e\d+\]Celtic \| 13 \| W W D/);
    // An empty cell keeps its column.
    expect(out).toMatch(/\[e\d+\]Rangers \| 12 \| $/m);
    expect(out.split("\n").filter((l) => /\[e\d+\]Celtic/.test(l))).toHaveLength(1);
  });

  it("marks a new ref inside a row, and drops the marks when every element is new", () => {
    const snap = league();
    const old = league();
    const ref = [...snap.byRef.values()].find((n) => n.children[0]?.text === "Rangers")!;
    old.keys = new Set(snap.nodes.filter((n) => n !== ref).map(nodeKey));
    expect(serializeSnapshot(snap, { previous: old, compactMarkup: true })).toMatch(/\*\[e\d+\]Rangers \| 12/);
    expect(serializeSnapshot(snap, { previous: S([]), compactMarkup: true })).not.toContain("*[");
  });

  it("keeps a calendar's day buttons (a date label and a state) on lines of their own", () => {
    const snap = S([
      E("table", {}, [
        E("tr", {}, [
          E("td", {}, [I("button", { "aria-label": "Sunday 5 October 2026" }, ["5"], { name: "Sunday 5 October 2026", role: "button" })]),
          E("td", {}, [I("button", { "aria-label": "Monday 6 October 2026" }, ["6"], { name: "Monday 6 October 2026", role: "button", selected: true })]),
        ]),
      ]),
    ]);
    const out = serializeSnapshot(snap);
    expect(out).not.toContain(" | ");
    expect(out).toContain('aria-label="Sunday 5 October 2026"');
  });

  it("leaves rows with form controls, two links in a cell, or a nested table as they were", () => {
    const withBox = S([E("table", {}, [E("tr", {}, [E("td", {}, [box("Select row")]), E("td", {}, ["Alpha"])])])]);
    expect(serializeSnapshot(withBox)).not.toContain(" | ");
    const twoLinks = S([E("table", {}, [E("tr", {}, [E("td", {}, [I("a", { href: "/a" }, ["A"]), I("a", { href: "/b" }, ["B"])]), E("td", {}, ["x"])])])]);
    expect(serializeSnapshot(twoLinks)).not.toContain(" | ");
    const nested = S([E("table", {}, [E("tr", {}, [E("td", {}, [E("table", {}, [E("tr", {}, [E("td", {}, ["in"]), E("td", {}, ["side"])])])]), E("td", {}, ["x"])])])]);
    expect(serializeSnapshot(nested).split("\n").filter((l) => l.includes("x"))).toHaveLength(1);
    expect(serializeSnapshot(nested)).toContain("in | side");
  });

  it("prints a page with no table exactly as before", () => {
    const snap = S([E("h1", {}, ["Shop"], { role: "heading" }), E("p", {}, ["Hello"]), I("a", { href: "/x" }, ["Go"])]);
    expect(serializeSnapshot(snap)).toBe(`<h1>Shop</h1>
Hello
[${[...snap.byRef.keys()][0]}]<a href="/x">Go</a>`);
  });
});

describe("a suggestion's stacked parts (16 Nov: Booking printed \"North Goa India\" for a name over its place)", () => {
  const block = { __block: "1" };
  const listbox = (...options: SnapNode[]) =>
    S([E("div", {}, options, { role: "listbox", name: "Suggestions" })]);
  const option = (children: Child[]) => I("li", {}, children, { role: "option" });
  it("keeps a name and the place under it apart, and inline markup in one line together", () => {
    const text = serializeSnapshot(
      listbox(
        option([E("div", block, ["North Ridge"]), E("div", block, ["Westland"])]),
        option([E("div", block, ["North ridge"]), E("div", block, ["Lakes (North Ridge), Westland"])]),
        option([E("div", block, [E("b", {}, ["North"]), " Ridge Inn"])]),
      ),
    );
    expect(text).toContain("North Ridge · Westland");
    expect(text).toContain("North ridge · Lakes (North Ridge), Westland");
    expect(text).toContain("North Ridge Inn");
    expect(text).not.toContain("North · Ridge Inn");
  });
  it("keeps parts side by side on one row (flex items) as one phrase: a line break is a layout fact, not a box kind", () => {
    const row = (x: number) => ({ rect: { x, y: 300, width: 60, height: 20 } });
    const text = serializeSnapshot(listbox(option([E("div", block, ["Blue"], row(20)), E("div", block, ["shirt"], row(90))])));
    expect(text).toContain("Blue shirt");
    expect(text).not.toContain("·");
  });
  it("sets no part apart where a box has no position", () => {
    const text = serializeSnapshot(listbox(option([E("div", block, ["North Ridge"]), E("div", block, ["Westland"], { rect: undefined })])));
    expect(text).toContain("North Ridge Westland");
  });
  it("cuts a long stacked option at the cap like any text, the separator counted in", () => {
    const long = "Lakes district of the northern ridge, Westland province, far north coast region";
    const text = serializeSnapshot(listbox(option([E("div", block, ["North Ridge"]), E("div", block, [long])])), { maxTextChars: 40 });
    const line = text.split("\n").find((l) => /\[e\d+\]<li/.test(l))!;
    const inner = line.slice(line.indexOf(">") + 1).replace(/<\/li>$/, "");
    expect(inner, line).toMatch(/^North Ridge · Lakes/);
    expect(inner.endsWith("…"), line).toBe(true);
    expect([...inner].length).toBeLessThanOrEqual(40);
  });
  it("leaves other roles' text as it was", () => {
    const text = serializeSnapshot(S([I("a", { href: "/x" }, [E("div", block, ["Hotel Aurora"]), E("div", block, ["9.1"])], { role: "link" })]));
    expect(text).not.toContain("·");
  });
});

describe("capture metadata is not page evidence (17 Nov review)", () => {
  it("find never matches a node by the capture's own flags", () => {
    const flagged = (label: string, meta: Record<string, string>) => I("button", { ...meta }, [label], { role: "button", name: label });
    const s = S([flagged("Apply", { __block: "1", __clip: "1" }), flagged("Close", { __cursor: "pointer", __pe: "none" }), I("button", { "data-count": "1" }, ["Page"], { role: "button", name: "Page" })]);
    const hits = (q: string) => findScored(s, q).map((h) => h.node.name);
    expect(hits("1")).toEqual(["Page"]); // the page's own data-count="1" still matches; the capture's "1" does not
    expect(hits("pointer")).toEqual([]);
    expect(hits("none")).toEqual([]);
  });
});
