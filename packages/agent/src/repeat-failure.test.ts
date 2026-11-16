import { describe, expect, it } from "vitest";
import { failureLines, isRetryLabel, RepeatFailures, repeatFailureNudge } from "./repeat-failure.js";

describe("failureLines", () => {
  it("reads a site's own failure messages, in English and other languages", () => {
    const page = [
      "Bengaluru", "New Delhi", "Oops, something went wrong.", "No results returned.", "We couldn’t load the prices. Please try again later.",
      "Une erreur s'est produite", "Se ha producido un error", "Ein Fehler ist aufgetreten", "エラーが発生しました", "Service temporarily unavailable",
    ].join("\n");
    expect(failureLines(page)).toEqual(["oops, something went wrong.", "no results returned.", "we couldn’t load the prices. please try again later.", "une erreur s'est produite", "se ha producido un error", "ein fehler ist aufgetreten"]);
  });
  it("leaves pages that only talk about errors, and ordinary results", () => {
    const page = [
      "Error handling in Java: what to do when something went wrong in a thread pool and how the executor reports it to callers, with examples of retry policies and back-off strategies.",
      "No results for “blue lamp”. Try another search.",
      "Errors and omissions excepted",
      "3 results",
      "Retry policies",
      "Try again",
    ].join("\n");
    expect(failureLines(page)).toEqual([]);
  });
});

describe("isRetryLabel", () => {
  it("knows retry controls", () => {
    for (const l of ["Try again", "Retry", "Reload", "Refresh results", "Réessayer", "Erneut versuchen", "再試行"]) expect(isRetryLabel(l)).toBe(true);
    for (const l of ["Search", "Done", "Sort by price", "Retrieve booking"]) expect(isRetryLabel(l)).toBe(false);
  });
});

describe("RepeatFailures", () => {
  const OOPS = "oops, something went wrong.";
  const t = (o: Partial<Parameters<RepeatFailures["turn"]>[0]> = {}) => ({ site: "google.com", before: [], after: [OOPS], loaded: false, retried: false, ...o });

  it("reports a site's message once it has come back three times, and every time after", () => {
    const r = new RepeatFailures();
    expect(r.turn(t())).toEqual([]); // a search: the message appears
    expect(r.turn(t({ before: [OOPS], retried: true }))).toEqual([]); // "Try again": it is back
    expect(r.turn(t())).toEqual([{ site: "google.com", text: OOPS, times: 3 }]); // redone and searched again
    expect(r.turn(t({ loaded: true, before: [OOPS] }))).toEqual([{ site: "google.com", text: OOPS, times: 4 }]);
    // Another site is counted on its own.
    expect(r.turn(t({ site: "kayak.com" }))).toEqual([]);
  });

  it("does not count a message that stays on the page while the agent works", () => {
    const r = new RepeatFailures();
    const FORM = "an error occurred";
    expect(r.turn(t({ after: [FORM] }))).toEqual([]);
    for (let i = 0; i < 10; i++) expect(r.turn(t({ before: [FORM], after: [FORM] }))).toEqual([]);
    // Gone, then back: that counts.
    expect(r.turn(t({ before: [FORM], after: [] }))).toEqual([]);
    expect(r.turn(t({ after: [FORM] }))).toEqual([]);
    expect(r.turn(t({ before: [FORM], after: [FORM], loaded: true }))).toMatchObject([{ times: 3 }]);
  });

  it("lists each site that kept failing with its most repeated message", () => {
    const r = new RepeatFailures();
    for (let i = 0; i < 4; i++) r.turn(t({ after: [OOPS] }));
    for (let i = 0; i < 3; i++) r.turn(t({ after: ["no results returned."] }));
    r.turn(t({ site: "kayak.com" }));
    // Shown to the check from the second time (FAILURE_SHOWN); the executor's nudge waits for the third.
    expect(r.failing()).toEqual([{ site: "google.com", text: OOPS, times: 4 }]);
    r.turn(t({ site: "kayak.com" }));
    expect(r.failing()).toEqual([{ site: "google.com", text: OOPS, times: 4 }, { site: "kayak.com", text: OOPS, times: 2 }]);
    expect(r.failing(3)).toEqual([{ site: "google.com", text: OOPS, times: 4 }]);
  });

  it("counts each message on its own", () => {
    const r = new RepeatFailures();
    expect(r.turn(t({ after: ["a"] }))).toEqual([]);
    expect(r.turn(t({ after: ["b"] }))).toEqual([]);
    expect(r.turn(t({ after: ["c"] }))).toEqual([]);
    expect(r.turn(t({ after: ["a"] }))).toEqual([]);
    expect(r.turn(t({ after: ["a", "b"] }))).toEqual([{ site: "google.com", text: "a", times: 3 }]);
  });

  it("tells the model to stop retrying and to switch sites or report", () => {
    const n = repeatFailureNudge({ site: "google.com", text: OOPS, times: 3 });
    expect(n).toContain('google.com has answered "oops, something went wrong." 3 times');
    expect(n).toContain("Do not repeat those steps on google.com");
    expect(n).toContain("another site");
    expect(n).toContain("done(success=false)");
  });
});
