import { describe, expect, it } from "vitest";
import { diffObservation } from "./observation.js";

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

  it("reports a page rewritten in full as a large ratio", () => {
    const next = base.replace(/Hotel|night|Free|Breakfast|Filters|below/g, "Other");
    expect(diffObservation(base, next)!.ratio).toBeGreaterThan(0.6);
  });
});
