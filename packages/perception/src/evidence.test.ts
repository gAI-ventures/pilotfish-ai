import { describe, expect, it } from "vitest";
import { diffSnapshots, formatEvidence, headingOf, sameAddressChange } from "./evidence.js";
import { describeNode, shownHref } from "./serialize.js";
import type { SnapNode, Snapshot } from "./snapshot.js";

// Minimal snapshots: none of these cases can hide behind focus, input, URL or interactive-node changes.
function snapshot(texts: string[], visible = true): Snapshot {
  const parent = { visible, boxless: false } as SnapNode;
  const nodes = texts.map((text) => ({ nodeType: 3, text, visible, parent, interactive: false, scrollable: false }) as SnapNode);
  return { nodes, url: "https://fixture.test/", title: "Fixture", scroll: { x: 0, y: 0 }, focusedRef: "e1" } as Snapshot;
}

describe("visible text action evidence", () => {
  it.each([["1", "2"], ["$1", "$2"], ["Yes", "No"], ["A", "AB"], ["AB", "ABC"]])("reports short text %s -> %s", (before, after) => {
    const evidence = diffSnapshots(snapshot([before]), snapshot([after]));
    expect(evidence.changed).toBe(true);
    expect(evidence.newText).toContain(after);
    expect(formatEvidence(evidence)).not.toContain("no observable change");
  });

  it("reports removal-only text instead of suppressing the new page", () => {
    const evidence = diffSnapshots(snapshot(["A visible status will disappear"]), snapshot([]));
    expect(evidence.changed).toBe(true);
    expect(formatEvidence(evidence)).toContain("visible text changed");
  });

  it("reports reordered and duplicated text even when the set of words is unchanged", () => {
    expect(diffSnapshots(snapshot(["Price", "10", "20"]), snapshot(["Price", "20", "10"])).changed).toBe(true);
    expect(diffSnapshots(snapshot(["Item", "Item"]), snapshot(["Item"])).changed).toBe(true);
  });

  it("keeps genuinely unchanged or whitespace-only runs unchanged", () => {
    expect(diffSnapshots(snapshot(["10", "Yes"]), snapshot(["10", "Yes"])).changed).toBe(false);
    expect(diffSnapshots(snapshot([" ", "Yes"]), snapshot(["\n", "Yes"])).changed).toBe(false);
  });

  it("does not turn changes under a hidden parent into visible evidence", () => {
    const evidence = diffSnapshots(snapshot(["before"], false), snapshot(["after"], false));
    expect(evidence.changed).toBe(false);
    expect(evidence.newText).toEqual([]);
  });

  it("caps text samples without losing change detection", () => {
    const evidence = diffSnapshots(snapshot([]), snapshot(Array.from({ length: 30 }, (_, i) => String(i))));
    expect(evidence.changed).toBe(true);
    expect(evidence.newText).toHaveLength(8);
  });
});

describe("the page's own heading and breadcrumb (17 Nov)", () => {
  // A page: a breadcrumb navigation named as one, and an h1, built by hand.
  function page(url: string, crumbs: string[], h1: string): Snapshot {
    const el = (tag: string, extra: Partial<SnapNode> = {}): SnapNode =>
      ({ nodeType: 1, tag, role: "", name: "", attrs: {}, visible: true, interactive: false, scrollable: false, children: [], parent: null, ...extra }) as SnapNode;
    const txt = (text: string, parent: SnapNode): SnapNode => ({ nodeType: 3, text, visible: true, parent, children: [], interactive: false, scrollable: false }) as unknown as SnapNode;
    const nav = el("nav", { role: "navigation", name: "Breadcrumb" });
    for (const c of crumbs) {
      const a = el("a", { parent: nav });
      a.children.push(txt(c, a));
      nav.children.push(a, txt("›", nav));
    }
    const h = el("h1", { role: "heading" });
    h.children.push(txt(h1, h));
    const nodes = [nav, ...nav.children.flatMap((c) => [c, ...c.children]), h, ...h.children];
    return { nodes, url, title: "Stays", scroll: { x: 0, y: 0 } } as Snapshot;
  }
  const before = page("https://stays.test/", [], "Find a stay");
  const after = page("https://stays.test/search?ss=North+Ridge&type=city", ["Home", "Westland", "North Ridge"], "North Ridge: 8 stays found");

  it("says the heading and the breadcrumb after a navigation, separators left out", () => {
    const ev = diffSnapshots(before, after);
    expect(ev.heading).toEqual({ before: "Find a stay", after: "North Ridge: 8 stays found" });
    expect(ev.breadcrumb?.after).toEqual(["Home", "Westland", "North Ridge"]);
    const text = formatEvidence(ev);
    expect(text).toContain('- page heading: "North Ridge: 8 stays found"');
    expect(text).toContain("- breadcrumb: Home › Westland › North Ridge");
  });

  it("leaves them out when the screen printed with the evidence shows them, and when nothing changed", () => {
    const ev = diffSnapshots(before, after);
    const text = formatEvidence(ev, { shown: '<navigation "Breadcrumb">\n\t[e1]<a>Home\n<h1>North Ridge: 8 stays found' });
    expect(text).not.toContain("page heading");
    expect(text).not.toContain("breadcrumb:");
    expect(diffSnapshots(after, after).heading).toBeUndefined();
    expect(diffSnapshots(after, after).breadcrumb).toBeUndefined();
  });
});

describe("shorter evidence lines that lose nothing (17 Nov)", () => {
  /** Reads a sameAddressChange line back: the old address's query parameters and fragment, from the new address. */
  function oldFrom(line: string): { params: Map<string, string>; hash: string } {
    const m = /^(\S+) \(same path; (.*)\)$/s.exec(line)!;
    const after = new URL(m[1]!);
    const params = new Map([...after.searchParams.entries()]);
    let hash = after.hash.slice(1);
    const STR = String.raw`"(?:[^"\\]|\\.)*"`;
    const part = new RegExp(String.raw`(?:^|, )(?:(\w+): (${STR}) → (${STR})|(\w+) added (${STR})|(\w+) removed \(was (${STR})\)|fragment (${STR}) → (${STR}))`, "gy");
    let rest = m[2]!;
    let consumed = 0;
    for (const p of rest.matchAll(part)) {
      consumed = p.index! + p[0].length;
      if (p[1]) params.set(p[1], JSON.parse(p[2]!));
      else if (p[4]) params.delete(p[4]);
      else if (p[6]) params.set(p[6], JSON.parse(p[7]!));
      else hash = JSON.parse(p[8]!);
    }
    expect(consumed, `unparsed: ${rest.slice(consumed)}`).toBe(rest.length);
    return { params, hash };
  }
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("a same-path address change is the new address whole plus each changed part, and the old one rebuilds exactly", () => {
    const VALUES = ["1", "2", "North Goa", "a&b=c", 'say "hi"', "x, y", "→", "उत्तर गोवा", "", "%41", "dest_type=city"];
    let lines = 0;
    for (let seed = 1; seed <= 2_000; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
      const keys = ["ss", "dest_type", "order", "page", "k", "tfs", "q", "lang"].filter(() => r() < 0.6);
      const a = new URL("https://www.example.test/searchresults.html");
      for (const k of keys) a.searchParams.set(k, pick(VALUES));
      if (r() < 0.3) a.hash = pick(VALUES);
      const b = new URL(a.href);
      for (const k of ["ss", "dest_type", "order", "page", "k", "tfs", "q", "lang"]) {
        const x = r();
        if (x < 0.15) b.searchParams.delete(k);
        else if (x < 0.35) b.searchParams.set(k, pick(VALUES));
      }
      if (r() < 0.2) b.hash = pick(VALUES);
      if (a.href === b.href) continue;
      const line = sameAddressChange(a.href, b.href);
      if (line === null) continue; // not shorter: the full "old → new" is printed instead
      lines++;
      expect(line.startsWith(`${b.href} (same path; `), line).toBe(true);
      const old = oldFrom(line);
      expect(Object.fromEntries(old.params), `seed ${seed}`).toEqual(Object.fromEntries(a.searchParams.entries()));
      expect(old.hash, `seed ${seed}`).toBe(a.hash.slice(1));
    }
    expect(lines).toBeGreaterThan(500);
  });

  it("keeps every fact of the new address (a Booking-like dest_type) and falls back to old → new when it cannot say less", () => {
    const before = "https://www.booking.com/searchresults.html?ss=North+Goa&dest_id=5052&dest_type=region&checkin=2026-12-12&checkout=2026-12-14&group_adults=2&label=gen173nr-xyz-1234567890&order=popularity";
    const after = before.replace("order=popularity", "order=review_score_and_price");
    const line = sameAddressChange(before, after)!;
    expect(line).toContain(after);
    expect(line).toContain("dest_type=region");
    expect(line).toContain('order: "popularity" → "review_score_and_price"');
    expect(line.length).toBeLessThan(`${before} → ${after}`.length);
    // Another path, another origin, a repeated key, nothing changed: no rewrite.
    expect(sameAddressChange("https://www.booking.com/", after)).toBeNull();
    expect(sameAddressChange(after, after.replace("www.booking.com", "booking.com"))).toBeNull();
    expect(sameAddressChange("https://x.test/s?a=1&a=2", "https://x.test/s?a=1&a=3")).toBeNull();
    expect(sameAddressChange(after, after)).toBeNull();
    // Formatted only when asked (the open MCP); otherwise the line is as before.
    const ev = diffSnapshots({ nodes: [], url: before, title: "t", scroll: { x: 0, y: 0 } } as unknown as Snapshot, { nodes: [], url: after, title: "t", scroll: { x: 0, y: 0 } } as unknown as Snapshot);
    expect(formatEvidence(ev)).toContain(`- navigated: ${before} → ${after}`);
    expect(formatEvidence(ev, { compactUrls: true })).toContain(`- navigated: ${line}`);
  });

  it("the page heading is the heading's own words, not the options of a control nested in it", () => {
    const el = (tag: string, extra: Partial<SnapNode> = {}) => ({ nodeType: 1, tag, role: "", name: "", attrs: {}, visible: true, interactive: false, scrollable: false, children: [], parent: null, ...extra }) as SnapNode;
    const txt = (text: string) => ({ nodeType: 3, text, visible: true, children: [], interactive: false, scrollable: false }) as unknown as SnapNode;
    const h1 = el("h1", { role: "heading" });
    const sel = el("select", { role: "combobox" });
    for (const o of ["Featured", "Price: Low to High"]) sel.children.push(Object.assign(el("option", { role: "option" }), { children: [txt(o)] }));
    h1.children.push(txt('1-16 of over 50,000 results for "earbuds"'), sel, txt("Sort by:"));
    expect(headingOf({ nodes: [h1], url: "u", title: "t" } as unknown as Snapshot)).toBe('1-16 of over 50,000 results for "earbuds" Sort by:');
  });

  it("an element in compact evidence is its screen line's facts: same ref, text and states, the href as the screen prints it", () => {
    const a = {
      nodeType: 1, tag: "a", role: "link", name: "Noise Buds Mini X", ref: "e200", visible: true, interactive: true, scrollable: false, children: [], parent: null, selected: true,
      attrs: { href: "https://www.amazon.in/Noise-Buds/dp/B0H6FQPGFT/ref=sr_1_17?dib=eyJ2IjoiMSJ9&keywords=earbuds", "aria-controls": "flyout-1", id: "a-autoid-12345" },
    } as unknown as SnapNode;
    a.children.push({ nodeType: 3, text: "Noise Buds Mini X", visible: true, children: [], parent: a } as unknown as SnapNode);
    const full = describeNode(a);
    const compact = describeNode(a, "https://www.amazon.in/s?k=earbuds");
    expect(compact.startsWith("[e200]<a ")).toBe(true);
    expect(compact).toContain(">Noise Buds Mini X</a>");
    expect(compact).toContain(`href="${shownHref(a.attrs["href"]!, "https://www.amazon.in/s?k=earbuds")}"`);
    expect(compact).not.toContain("www.amazon.in");
    expect(compact).not.toContain("aria-controls");
    expect(compact.length).toBeLessThan(full.length);
    for (const s of ["selected"]) expect(compact).toContain(s);
  });
});

describe("formatEvidence with a page part (C1a controls, 18 Nov): only an added element printed in it is left to it", () => {
  const ev = {
    changed: true, navigated: false, urlBefore: "https://shop.test/", urlAfter: "https://shop.test/", titleBefore: "Shop", titleAfter: "Shop",
    dialogs: [], scrollDelta: { x: 0, y: 0 }, focusedBefore: "e3", focusedAfter: "e3",
    valueChanges: [{ ref: "e3", description: '[e3]<input label="Where" value="North">', from: "", to: "North" }],
    stateChanges: ["e4 checked: false → true"],
    added: ["[e7]<button>Here</button>", "<button>Far below</button>"], addedCount: 2,
    removed: ["[e9]<button>Gadget</button>"], removedCount: 1,
    newText: [], network: { requests: 2, failed: 0 },
  } as unknown as Parameters<typeof formatEvidence>[0];
  // The page part shows the field's new value, the box checked, the new button, and (a reused ref) e9 as something else.
  const shown = '[e3]<input label="Where" value="North">\n[e4]<input type="checkbox" checked>\n[e7]<button>Here\n[e9]<button>Gadget';
  const out = formatEvidence(ev, { shown });
  it("keeps every old → new value and state, whatever the page part shows of the new one", () => {
    expect(out).toContain('- value e3: "" → "North"');
    expect(out).toContain("- state: e4 checked: false → true");
  });
  it("keeps every removal, even one whose ref and line the page part prints", () => {
    expect(out).toContain("- 1 element(s) removed: [e9]<button>Gadget</button>");
  });
  it("keeps an added element the page part does not print (offscreen, no ref), and counts the one it prints", () => {
    expect(out).toContain("- 2 new interactive element(s): <button>Far below</button>");
    expect(out).not.toContain("[e7]<button>Here</button>");
  });
});

describe("formatEvidence on a new document (the open MCP, 18 Nov): the earlier page's elements are counted, not named", () => {
  const ev = {
    changed: true, navigated: true, urlBefore: "https://shop.test/s?q=buds&page=1", urlAfter: "https://shop.test/s?q=buds&page=2", titleBefore: "Shop", titleAfter: "Shop",
    dialogs: [], scrollDelta: { x: 0, y: 0 }, focusedBefore: undefined, focusedAfter: undefined,
    valueChanges: [], stateChanges: [],
    added: ["[e40]<a>Buds Two</a>"], addedCount: 1,
    removed: ["[e9]<a>Buds One</a>", "[e10]<a>Next</a>"], removedCount: 2,
    newText: [], network: { requests: 2, failed: 0 },
  } as unknown as Parameters<typeof formatEvidence>[0];
  it("names no element of the earlier page, keeps the count and says whose they were", () => {
    const out = formatEvidence(ev, { compactUrls: true, newDocument: true });
    expect(out).toContain("- 2 element(s) removed (the earlier page's)");
    expect(out).not.toContain("Buds One");
    // The new page's own elements are still named: a quiet reply's ref may be the next action's target.
    expect(out).toContain("[e40]<a>Buds Two</a>");
  });
  it("names them as before on the same document, and outside the open MCP (no compactUrls)", () => {
    expect(formatEvidence(ev, { compactUrls: true })).toContain("- 2 element(s) removed: [e9]<a>Buds One</a>");
    expect(formatEvidence(ev, { newDocument: true })).toContain("- 2 element(s) removed: [e9]<a>Buds One</a>");
  });
  it("counts only, as before, when no lists are asked for", () => {
    const out = formatEvidence(ev, { compactUrls: true, newDocument: true, lists: false });
    expect(out).toContain("- 2 element(s) removed");
    expect(out).not.toContain("earlier page");
  });
});
