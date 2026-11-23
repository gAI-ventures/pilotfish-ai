// The words a site uses to say it is still working, and that a search found nothing (agent.ts: SITE_WAIT_TEXT in
// LOADING_INDICATOR_JS, EMPTY_RESULTS_TEXT in EMPTY_RESULTS_JS). Lines from real pages, and look-alikes that are not.
import { describe, expect, it } from "vitest";
import { cutPart, cutPartAt } from "./agent.js";
import { EMPTY_RESULTS_TEXT, SITE_WAIT_TEXT, loadingState } from "./agent.js";

describe("SITE_WAIT_TEXT: the site says it is still working", () => {
  it.each([
    "Loading…",
    "Loading results...",
    "Searching flights…",
    "Fetching the best prices...",
    "Calculating your quote…",
    "Computing…",
    "Looking for available rooms...",
    "Please wait",
    "Please wait while we check availability",
    "Redirecting in 5 seconds",
    "You will be redirected in 10 s",
    "Please wait 8 seconds",
  ])("waits on %j", (t) => expect(SITE_WAIT_TEXT.test(t)).toBe(true));

  it.each([
    "Searching for a job?",
    "Loading docks and warehouses",
    "Loading",
    "Searching made easy. Try it now.",
    "Free delivery in 2 days",
    "Checking account",
    "Updated 5 seconds ago and more text that runs on well past the length a short status line would have",
  ])("does not wait on %j", (t) => expect(SITE_WAIT_TEXT.test(t)).toBe(false));
});

describe("EMPTY_RESULTS_TEXT: a search or filter that found nothing", () => {
  it.each([
    "Sorry, your query returned no results",
    "No results found",
    "No results for “SimCSE”",
    "0 results",
    "0 properties are available in and around this destination",
    "No matching flights",
    "Your search did not match any documents.",
    "We couldn't find any results for that search",
    "Nothing found",
    "No hotels match your filters",
  ])("notes %j", (t) => expect(EMPTY_RESULTS_TEXT.test(t)).toBe(true));

  it.each([
    "Results 1-50 of 62",
    "No-fuss returns within 30 days",
    "0 items in your cart",
    "Showing 12 products",
    "Nothing beats a fresh pizza",
    "No reviews yet",
  ])("leaves %j alone", (t) => expect(EMPTY_RESULTS_TEXT.test(t)).toBe(false));
});

describe("loadingState: what one read of the loading indicators means (16 Nov)", () => {
  const tab1 = "T1\nexample.com\n";
  const tab2 = "T2\nexample.com\n";
  it("a failed read is unknown: nothing finished, no exemption ends", () => {
    const stuck = new Set([`${tab1}Loading results`]);
    expect(loadingState(null, stuck, tab1)).toEqual({ active: [], exempt: [], retire: [], unknown: true });
  });
  it("a label still in view stays exempt, even behind a new operation; another indicator beside it is waited for", () => {
    const stuck = new Set([`${tab1}Loading results`]);
    expect(loadingState("Loading results\nFetching results", stuck, tab1)).toEqual({ active: ["Fetching results"], exempt: ["Loading results"], retire: [], unknown: false });
  });
  it("an exempt label seen gone is retired, so the next search's indicator of that label is waited for", () => {
    const stuck = new Set([`${tab1}Fetching results`, `${tab1}Loading results`]);
    const s = loadingState("Loading results", stuck, tab1);
    expect(s.retire).toEqual([`${tab1}Fetching results`]);
    expect(s.exempt).toEqual(["Loading results"]);
  });
  it("an exemption is its tab's: the same label in another tab is waited for, and that tab's read retires nothing of tab 1", () => {
    const stuck = new Set([`${tab1}Loading results`]);
    expect(loadingState("Loading results", stuck, tab2)).toEqual({ active: ["Loading results"], exempt: [], retire: [], unknown: false });
    expect(loadingState("", stuck, tab2).retire).toEqual([]);
  });
});

describe("cutPart: a page's text read in parts (the open MCP's offset, 20 Nov)", () => {
  const whole = Array.from({ length: 50 }, (_, i) => `line ${i} with a price of $${100 + i}`).join("\n");
  it("parts meet end to start with no word cut in two and nothing lost", () => {
    let off = 0;
    const parts: string[] = [];
    while (off < whole.length && parts.length < 100) {
      const part = cutPart(whole, off, 200);
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(200);
      parts.push(part);
      off = whole.indexOf(part, off) + part.length;
    }
    const words = (x: string) => x.split(/\s+/).filter(Boolean);
    expect(words(parts.join(" "))).toEqual(words(whole));
    for (const p of parts) expect(p).not.toMatch(/^\S*\$\d?$/m);
  });
  it("an offset past the end is empty, and a short text comes whole", () => {
    expect(cutPart(whole, whole.length + 5, 100)).toBe("");
    expect(cutPart("short text", 0, 100)).toBe("short text");
  });
});

describe("cutPartAt: where a part really starts and ends, and whether anything is left (23 Nov)", () => {
  /** Every part read the way a client follows the replies: the next offset is the reported end, until no more. */
  const readAll = (whole: string, max: number) => {
    const parts: Array<ReturnType<typeof cutPartAt>> = [];
    let off = 0;
    for (let i = 0; i < 1000; i++) {
      const p = cutPartAt(whole, off, max);
      parts.push(p);
      if (!p.more) break;
      off = p.end;
    }
    return parts;
  };
  const check = (whole: string, max: number) => {
    const parts = readAll(whole, max);
    let prevEnd = 0;
    for (const p of parts) {
      // The span is the part's own place in the text, and only whitespace lies between one part and the next.
      expect(whole.slice(p.start, p.end)).toBe(p.text);
      expect(whole.slice(prevEnd, p.start)).toMatch(/^\s*$/);
      expect(p.text.trim()).not.toBe("");
      expect(p.text.length).toBeLessThanOrEqual(max);
      prevEnd = p.end;
    }
    // The last part says the end: nothing but whitespace after it.
    expect(parts.at(-1)!.more).toBe(false);
    expect(whole.slice(prevEnd)).toMatch(/^\s*$/);
    return parts;
  };
  it("lines longer than a fifth of a part are cut at spaces, and the next part starts at the next word, not the next line", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(60)}ends with the price $${100 + i}.`).join("\n");
    const parts = check(long, 500);
    expect(parts.length).toBeGreaterThan(5);
    const words = (x: string) => x.split(/\s+/).filter(Boolean);
    expect(words(parts.map((p) => p.text).join(" "))).toEqual(words(long));
  });
  it("a part whose start skips a line break still ends at the text's end; a lone trailing character or whitespace is no further part", () => {
    // The shape of the 23 Nov read: the first part ends at a line break, the second starts past it and runs out.
    const whole = `${"a".repeat(30)} ${"b".repeat(30)}\n${"c".repeat(40)}\n-\n-`;
    const first = cutPartAt(whole, 0, 62);
    expect(first).toMatchObject({ start: 0, end: 61, more: true });
    const second = cutPartAt(whole, first.end, 100);
    expect(second).toMatchObject({ start: 62, end: whole.length, more: false });
    for (const tail of ["", "\n", "  \n\t "]) {
      const t = cutPartAt(`${"x".repeat(50)}\n${"y".repeat(50)}${tail}`, 0, 101);
      expect(t.more, JSON.stringify(tail)).toBe(false);
    }
    check(`${"word ".repeat(400)}\n\n   \n`, 300);
  });
  it("an offset inside a word starts at that word; one past the end is empty and says the end", () => {
    const whole = "alpha beta gamma delta";
    expect(cutPartAt(whole, 8, 100)).toMatchObject({ text: "beta gamma delta", start: 6, more: false });
    expect(cutPartAt(whole, 6, 100).text).toBe("beta gamma delta");
    expect(cutPartAt(whole, 5, 100).text).toBe("beta gamma delta");
    expect(cutPartAt(whole, 99, 100)).toEqual({ text: "", start: whole.length, end: whole.length, more: false });
  });
});
