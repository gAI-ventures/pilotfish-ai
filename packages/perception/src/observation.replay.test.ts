// Bounded, deterministic replay of the in-order change list (17 Nov review): random small screen pairs, seeded, with
// the shapes that make a change list hard to place — the same text on several lines (prices, "Add", "Score 9"), the
// same row printed twice, lines that move, swap, duplicate or disappear, indentation under repeated parents. Every
// change list must apply to its base without an error and give the next screen exactly; a list that cannot be placed
// or places a line wrongly is an accuracy bug (the client would read a value under the wrong row).
import { describe, expect, it } from "vitest";
import { applyInOrder, diffObservation } from "./observation.js";

/** mulberry32: a small seeded generator, so a failure names its case. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS_DEFAULT = ["Score 9", "Score 10", "$120", "$95", "Add", "Free cancellation", "<list>", "<h2>Stays", "Note", "Price may change"];
/** Few texts, so nearly every line repeats. */
const FEW = ["A", "B", "C"];
/** Page text that reads like the change list's own syntax. */
const SYNTAX = ["Score 9", "$95", "Add", "~ 2 hr", "~ Score 9", "(2 line(s) gone here)", "(replaces 1 line(s))", "GONE from the page: x"];

function screens(seed: number, TEXTS: readonly string[] = TEXTS_DEFAULT, pRef = 0.35): { base: string; next: string } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  let ref = 1;
  // A line: a control with a ref of its own, or a text that repeats, at depth 0-2; sometimes with the new mark "*".
  const line = (): string => {
    const tabs = "\t".repeat(Math.floor(r() * 3));
    const mark = r() < 0.15 ? "*" : "";
    return r() < pRef ? `${tabs}${mark}[e${ref++}]<button>${pick(TEXTS)}` : `${tabs}${pick(TEXTS)}`;
  };
  const base = Array.from({ length: 4 + Math.floor(r() * 22) }, line);
  const next = base.map((l) => l.replace(/^(\t*)\*/, "$1"));
  for (let k = 1 + Math.floor(r() * 5); k > 0; k--) {
    const i = Math.floor(r() * next.length);
    const op = r();
    if (op < 0.2) next.splice(i, 0, line());
    else if (op < 0.35 && next.length > 1) next.splice(i, 1);
    else if (op < 0.5) next[i] = next[i]!.replace(/[^\]>\t]+$/, pick(TEXTS));
    else if (op < 0.65) {
      const j = Math.floor(r() * next.length);
      [next[i], next[j]] = [next[j]!, next[i]!];
    } else if (op < 0.75) next.splice(Math.floor(r() * next.length), 0, next[i]!.replace(/\[e\d+\]/, () => `[e${ref++}]`));
    else if (op < 0.88) {
      // A block moves (a re-sort).
      const len = 1 + Math.floor(r() * 3);
      const block = next.splice(i, len);
      next.splice(Math.floor(r() * (next.length + 1)), 0, ...block);
    } else next[i] = `${r() < 0.5 ? "*" : ""}${next[i]!.replace(/^\t*\*?/, "")}`;
  }
  return { base: base.join("\n"), next: next.join("\n") };
}

const norm = (l: string) => l.replace(/^(\t*)\*/, "$1").trim();
const lines = (t: string) => JSON.stringify(t.split("\n").map(norm));

/** Replays `n` seeded pairs: failures (a list that throws or rebuilds another screen), lists applied, whole screens by reason. */
function replay(n: number, texts: readonly string[], pRef: number) {
  const failures: string[] = [];
  const whole = new Map<string, number>();
  let lists = 0;
  for (let seed = 1; seed <= n; seed++) {
    const { base, next } = screens(seed, texts, pRef);
    const d = diffObservation(base, next, { ordered: true });
    if (!d) {
      if (lines(base) !== lines(next)) failures.push(`seed ${seed}: "no change" but the screens differ`);
      continue;
    }
    if (d.fullBecause) {
      whole.set(d.fullBecause, (whole.get(d.fullBecause) ?? 0) + 1);
      continue;
    }
    lists++;
    try {
      const rebuilt = applyInOrder(base, d.text);
      if (JSON.stringify(rebuilt) !== lines(next)) failures.push(`seed ${seed}: rebuilt differs`);
    } catch (e) {
      failures.push(`seed ${seed}: ${(e as Error).message}`);
    }
  }
  return { failures, lists, whole };
}

describe("in-order change list replay", () => {
  it("every change list of 5,000 seeded screen pairs applies to its base and gives the next screen exactly", () => {
    const { failures, lists } = replay(5_000, TEXTS_DEFAULT, 0.35);
    expect(lists).toBeGreaterThan(4_000);
    expect(failures.slice(0, 10), `${failures.length} of ${lists} change lists failed`).toEqual([]);
  });

  it("nearly every line repeated (three texts, few refs): still placed exactly", () => {
    const { failures, lists } = replay(5_000, FEW, 0.1);
    expect(lists).toBeGreaterThan(4_000);
    expect(failures.slice(0, 10), `${failures.length} of ${lists} change lists failed`).toEqual([]);
  });

  it("page text that reads like the list's own syntax is a whole screen, never a list read wrongly (17 Nov)", () => {
    // Before: 25-37% of these lists rebuilt another screen (a "~ 2 hr" line read as context, a "(2 line(s) gone here)"
    // line as a count).
    const { failures, lists, whole } = replay(5_000, SYNTAX, 0.2);
    expect(lists).toBeGreaterThan(1_000);
    expect(whole.get("page-text-like-markers") ?? 0).toBeGreaterThan(500);
    expect(failures.slice(0, 10), `${failures.length} of ${lists} change lists failed`).toEqual([]);
  });
});
