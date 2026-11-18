import { describe, expect, it } from "vitest";
import { applyInOrder, diffObservation } from "./observation.js";

const base = [
  '<form "Filters">',
  "\t[e10]<input type=\"checkbox\" label=\"Free cancellation\" />",
  "\t[e11]<input type=\"checkbox\" label=\"Breakfast included\" />",
  "<list>",
  "\t[e20]<a href=\"/h/1\">Hotel Aurora</a>",
  "\t\t$120 per night",
  "\t[e21]<a href=\"/h/2\">Hotel Borealis</a>",
  "\t\t$95 per night",
  "(12 interactive elements below the viewport; scroll down to reveal)",
].join("\n");

describe("diffObservation", () => {
  it("lists only the changed lines, each under its unchanged parent", () => {
    const next = base.replace('label="Free cancellation" />', 'label="Free cancellation" checked />').replace("$95 per night", "$89 per night");
    const d = diffObservation(base, next)!;
    expect(d.text.split("\n")).toEqual([
      '~ <form "Filters">',
      '\t[e10]<input type="checkbox" label="Free cancellation" checked />',
      '~ [e21]<a href="/h/2">Hotel Borealis</a>',
      "\t\t$89 per night",
    ]);
    expect(d.ratio).toBeLessThan(0.6);
  });

  it("ignores new-element markers and content that only moved", () => {
    const moved = base.split("\n");
    const reordered = [moved[0], moved[2], moved[1], ...moved.slice(3)].join("\n");
    expect(diffObservation(base, reordered)).toBeNull();
    expect(diffObservation(base, base.replace("\t[e11]", "\t*[e11]"))).toBeNull();
  });

  it("names the refs that are gone and counts gone text", () => {
    const next = base.split("\n").filter((l) => !l.includes("e21") && !l.includes("$95")).join("\n");
    const d = diffObservation(base, next)!;
    expect(d.text).toBe("GONE from the page: [e21] Hotel Borealis; 1 text line(s)");
    expect(d.gone).toBe(2);
  });

  // In page order (`ordered`, the open MCP's change lists): every value is read with its row and its place, and the
  // list applied to the page the client holds gives the new page exactly (`applyInOrder`).
  const rows = (...r: [string, string][]) => ["<list>", ...r.flatMap(([n, v]) => [`\t[e${n.charCodeAt(0)}]<a>${n}</a>`, `\t\t${v}`])].join("\n");
  const trimmed = (page: string) => page.split("\n").map((l) => l.replace(/^(\t*)\*/, "$1").trim());
  const roundTrip = (before: string, after: string) => {
    const d = diffObservation(before, after, { ordered: true })!;
    expect(applyInOrder(before, d.text)).toEqual(trimmed(after));
    return d.text.split("\n");
  };

  it("ordered: two rows that swapped a value show each new value under its own row, in order", () => {
    const before = rows(["A", "1000"], ["B", "2000"]);
    const after = rows(["A", "2000"], ["B", "1000"]);
    expect(diffObservation(before, after)).toBeNull(); // the multiset diff calls it the same page
    expect(roundTrip(before, after)).toEqual(["~ [e65]<a>A</a>", "\t\t2000", "(replaces 1 line(s))", "~ [e66]<a>B</a>", "\t\t1000", "(replaces 1 line(s))"]);
  });

  it("ordered: duplicate prices match in order, so one changed row is the only change", () => {
    const before = rows(["A", "999"], ["B", "999"], ["C", "999"]);
    const after = rows(["A", "999"], ["B", "1099"], ["C", "999"]);
    expect(roundTrip(before, after)).toEqual(["~ [e66]<a>B</a>", "\t\t1099", "(replaces 1 line(s))"]);
  });

  it("ordered: a row inserted after a repeated value is placed by the row before it, never by the value alone", () => {
    const before = rows(["A", "999"], ["B", "999"], ["C", "999"]);
    const after = rows(["A", "999"], ["B", "999"], ["N", "999"], ["C", "999"]);
    const t = roundTrip(before, after);
    // "999" alone could be any of three: the context starts at B's own line.
    expect(t).toEqual(["~ [e66]<a>B</a>", "~ 999", "\t[e78]<a>N</a>", "\t\t999"]);
    // The row before it newly marked "*" in this snapshot (new since the last one, not since the base): same anchor.
    expect(roundTrip(before, after.replace("\t[e66]", "\t*[e66]"))[0]).toBe("~ [e66]<a>B</a>");
    // Removing that row again, and a removal right after a repeated value at the top of the list.
    roundTrip(after, before);
    roundTrip(before, rows(["B", "999"], ["C", "999"]));
    // Repeated lines with no unique line before them: placed from the top of the page.
    roundTrip(["999", "999", "999"].join("\n"), ["999", "999", "NEW", "999"].join("\n"));
  });

  it("ordered: a pure sort is never 'the same' and, sorted throughout, is a large change", () => {
    const before = rows(["A", "9.1"], ["B", "9.8"], ["C", "8.7"], ["D", "10"]);
    const after = rows(["D", "10"], ["B", "9.8"], ["A", "9.1"], ["C", "8.7"]);
    expect(diffObservation(before, after)).toBeNull();
    roundTrip(before, after);
    expect(diffObservation(before, after, { ordered: true })!.ratio).toBeGreaterThan(0.5);
  });

  it("ordered: a renamed parent row is one line; its unchanged children are not repeated", () => {
    const before = rows(["A", "1000"], ["B", "2000"]);
    const after = before.replace("<a>A</a>", "<a>A (sold out)</a>");
    expect(roundTrip(before, after)).toEqual(["~ <list>", "\t[e65]<a>A (sold out)</a>", "(replaces 1 line(s))"]);
  });

  it("ordered: an insert and a removal are each placed after the unique lines that lead to them", () => {
    const before = rows(["A", "1"], ["B", "2"], ["C", "3"]);
    expect(roundTrip(before, rows(["A", "1"], ["N", "5"], ["B", "2"], ["C", "3"]))).toEqual(["~ 1", "\t[e78]<a>N</a>", "\t\t5"]);
    expect(roundTrip(before, rows(["A", "1"], ["C", "3"]))).toEqual(["~ 1", "(2 line(s) gone here)", "GONE from the page: [e66] B"]);
    expect(diffObservation(before, before.replace("\t[e66]", "\t*[e66]"), { ordered: true })).toBeNull();
  });

  it("ordered: a page cut by the character cap is shown whole", () => {
    const before = rows(["A", "1"], ["B", "2"]);
    const after = `${rows(["A", "1"], ["B", "3"])}\n(output truncated at 24000 chars)`;
    expect(diffObservation(before, after, { ordered: true, truncated: true })).toMatchObject({ ratio: 1, fullBecause: "truncated" });
    expect(diffObservation(`${before}\n(output truncated at 24000 chars)`, after.replace(/\n\(output.*$/, ""), { ordered: true })).toMatchObject({ fullBecause: "truncated" });
  });

  it("reports a page rewritten in full as a large ratio", () => {
    const next = base.replace(/Hotel|night|Free|Breakfast|Filters|below/g, "Other");
    expect(diffObservation(base, next)!.ratio).toBeGreaterThan(0.6);
  });
});
