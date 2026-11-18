// Same-page observations as a change list. A turn's page snapshot is written to the prompt cache in
// full, and that write was half of every executor call's price (5.7k tokens a turn on hard tasks).
// 70% of page actions leave the URL alone, and most change a few lines of the snapshot: a checked
// filter, a typed value, an opened menu. Refs are stable across snapshots (an element keeps its ref
// while it exists), so the model can read the change against the full snapshot it already holds.

export interface ObservationDiff {
  /** The lines to show: changed or new ones, each under its unchanged parent line marked "~ ". */
  text: string;
  /** Characters of `text` against the full serialization's. */
  ratio: number;
  /** Lines of the base no longer on the page. */
  gone: number;
  /** With `ordered`: why the whole page should be shown instead ("truncated", "too-large"); `ratio` is then 1. */
  fullBecause?: string;
}

/** A line of the page that, printed as a new line of a change list, would read as the list's own syntax (applyInOrder). */
const readsAsSyntax = (line: string): boolean =>
  line.startsWith("~ ") || line.startsWith("GONE from the page: ") || /^\((?:replaces \d+ line\(s\)|\d+ line\(s\) gone here)\)$/.test(line);

/** A snapshot line without its "new element" marker (relative to the previous snapshot, not the base). */
const key = (line: string): string => line.replace(/^(\t*)\*/, "$1");
const depth = (line: string): number => /^\t*/.exec(line)![0].length;

/**
 * The change from `base` (a full serialization the model was shown) to `next` (the full
 * serialization now), or null when nothing changed. Lines are compared as a multiset, so content
 * that moved without changing is not repeated; each changed line is preceded by its nearest
 * unchanged ancestor line (marked "~ ") so its place on the page stays clear. Lines of the base that
 * are gone are listed by ref (interactive ones) and counted (text).
 */
export function diffObservation(
  base: string,
  next: string,
  opts: { liveRefs?: ReadonlySet<string>; truncated?: boolean; ordered?: boolean } = {},
): ObservationDiff | null {
  if (opts.ordered) return diffInOrder(base, next, opts);
  const baseLines = base.split("\n");
  const nextLines = next.split("\n");
  const left = new Map<string, number>();
  for (const l of baseLines) left.set(key(l), (left.get(key(l)) ?? 0) + 1);
  const changed: boolean[] = nextLines.map((l) => {
    const k = key(l);
    const c = left.get(k) ?? 0;
    if (c > 0) {
      left.set(k, c - 1);
      return false;
    }
    return true;
  });
  const goneLines: string[] = [];
  for (const l of baseLines) {
    const k = key(l);
    const c = left.get(k) ?? 0;
    if (c > 0) {
      goneLines.push(l);
      left.set(k, c - 1);
    }
  }
  if (!changed.some(Boolean) && !goneLines.length) return null;

  const out: string[] = [];
  const shownContext = new Set<number>();
  for (let i = 0; i < nextLines.length; i++) {
    if (!changed[i]) continue;
    const d = depth(nextLines[i]!);
    if (d > 0) {
      for (let j = i - 1; j >= 0; j--) {
        if (depth(nextLines[j]!) < d) {
          if (!changed[j] && !shownContext.has(j)) {
            out.push(`~ ${nextLines[j]!.trim()}`);
            shownContext.add(j);
          }
          break;
        }
      }
    }
    out.push(nextLines[i]!);
  }
  // A ref whose line changed (a box now checked) is still on the page, and text edited in place (a
  // new price) is shown by its new line: neither is gone.
  const refOf = (l: string) => /\[((?:f\d+)?e\d+)\]/.exec(l)?.[1];
  const nowRefs = new Set(nextLines.map(refOf).filter(Boolean));
  // A ref missing from `next` is only truly GONE if the live snapshot no longer has it: otherwise it
  // was merely scrolled out of the rendered band or cut by the character cap, not removed.
  const stillLive = (ref: string | undefined) => !!ref && (opts.liveRefs ? opts.liveRefs.has(ref) : false);
  const goneRefs = goneLines
    .filter((l) => refOf(l) && !nowRefs.has(refOf(l)) && !stillLive(refOf(l)))
    .map((l) => /\[((?:f\d+)?e\d+)\]<\w+[^>]*>?([^<]{0,40})/.exec(l))
    .filter((m): m is RegExpExecArray => !!m);
  const changedText = nextLines.filter((l, i) => changed[i] && !refOf(l)).length;
  // When `next` was truncated by the cap, a missing text line may just be past the cap: don't claim it.
  const goneText = opts.truncated ? 0 : Math.max(0, goneLines.filter((l) => !refOf(l)).length - changedText);
  if (goneRefs.length || goneText) {
    const refs = goneRefs.map((m) => `[${m[1]}]${m[2]?.trim() ? ` ${m[2].trim()}` : ""}`);
    out.push(`GONE from the page: ${refs.join("; ")}${goneText ? `${refs.length ? "; " : ""}${goneText} text line(s)` : ""}`);
  }
  const text = out.join("\n");
  return { text, ratio: text.length / Math.max(1, next.length), gone: goneLines.length };
}

/**
 * Applies a change list from `diffObservation(base, next, { ordered: true })` to `base`, the way the client is told
 * to read it, and returns the page it describes (context lines trimmed, as printed). A "~ " line is the base line
 * after the current one when it reads the same, otherwise the one base line with that text (an anchor), with the
 * base lines between kept; other lines are new at the current place; "(replaces N line(s))" and "(N line(s) gone
 * here)" drop N base lines there. Throws when the list cannot be placed (a context line found nowhere or twice).
 */
export function applyInOrder(base: string, diff: string): string[] {
  const b = base.split("\n");
  const norm = (l: string) => key(l).trim();
  const out: string[] = [];
  let at = 0; // the next base line not yet copied or dropped
  for (const line of diff.split("\n")) {
    if (line.startsWith("GONE from the page: ")) break;
    const drop = /^\((?:replaces (\d+) line\(s\)|(\d+) line\(s\) gone here)\)$/.exec(line);
    if (drop) {
      at += Number(drop[1] ?? drop[2]);
      continue;
    }
    if (line.startsWith("~ ")) {
      const t = norm(line.slice(2));
      if (at < b.length && norm(b[at]!) === t) {
        out.push(t);
        at++;
        continue;
      }
      const hits = b.map((l, i) => (i >= at && norm(l) === t ? i : -1)).filter((i) => i >= 0);
      if (hits.length !== 1 || b.filter((l) => norm(l) === t).length !== 1) throw new Error(`context line not placeable: ${t}`);
      for (; at < hits[0]!; at++) out.push(norm(b[at]!));
      out.push(t);
      at++;
      continue;
    }
    out.push(norm(line));
  }
  for (; at < b.length; at++) out.push(norm(b[at]!));
  return out;
}

/**
 * The change from `base` to `next` in page order: lines are matched as a longest common subsequence, so a line
 * that moved, a value that swapped rows, or a list sorted another way is a change at its new place, never "the
 * same". The result can be applied to `base` to give `next` exactly (`applyInOrder`): each run of changed lines is
 * printed after the unchanged lines that lead to it ("~ ", in order), starting from an anchor that occurs once in
 * both pages (or from the top of the page), so a run after a repeated value ("999" under several rows) is placed
 * by the row line before it, never by the value; the lines it replaced or removed there are counted in place.
 * Interactive lines gone from the page are named at the end. The whole page is the answer (`fullBecause`,
 * ratio 1) when either side was cut by the character cap (a line past the cut is neither gone nor moved), the
 * pages are too large to match exactly, or a new line would print as the list's own syntax ("~ 2 hr", "(2 line(s)
 * gone here)", "GONE from the page: …" as page text at the left margin): read as a context line or a count, it would
 * put the lines after it under the wrong rows (17 Nov: 25-37% of seeded lists with such text did).
 */
function diffInOrder(base: string, next: string, opts: { liveRefs?: ReadonlySet<string>; truncated?: boolean }): ObservationDiff | null {
  const baseLines = base.split("\n");
  const nextLines = next.split("\n");
  const full = (why: string): ObservationDiff => ({ text: next, ratio: 1, gone: 0, fullBecause: why });
  if (opts.truncated || base.includes("(output truncated at ")) return full("truncated");
  const a = baseLines.map(key);
  const b = nextLines.map(key);
  // Common head and tail first: most actions change a few lines in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > 4_000_000) return full("too-large");
  // LCS table over the middle, then walk it: matchOf[j] = the base line next line j kept, or -1. A line with a
  // ref (a row's link or control: its identity) weighs more than a bare text line, so when a value and a row
  // compete the row is kept and the value is the change under it (A 1000 -> 2000 is "under A: 2000", never
  // "B's old 2000 now sits under A").
  const weight = (l: string) => (/\[(?:f\d+)?e\d+\]/.test(l) ? 3 : 1);
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      const skip = Math.max(len[(x + 1) * w + y]!, len[x * w + y + 1]!);
      len[x * w + y] = a[head + x] === b[head + y] ? Math.max(skip, len[(x + 1) * w + y + 1]! + weight(a[head + x]!)) : skip;
    }
  }
  const matchOf = new Array<number>(nextLines.length).fill(-1);
  const kept = new Array<boolean>(baseLines.length).fill(false);
  for (let k = 0; k < head; k++) (matchOf[k] = k), (kept[k] = true);
  for (let k = 0; k < tail; k++) (matchOf[nextLines.length - 1 - k] = baseLines.length - 1 - k), (kept[baseLines.length - 1 - k] = true);
  for (let x = 0, y = 0; x < n && y < m; ) {
    if (a[head + x] === b[head + y] && len[x * w + y] === len[(x + 1) * w + y + 1]! + weight(a[head + x]!)) {
      matchOf[head + y] = head + x;
      kept[head + x] = true;
      x++;
      y++;
    } else if (len[(x + 1) * w + y]! >= len[x * w + y + 1]!) x++;
    else y++;
  }
  const goneLines = baseLines.filter((_, i) => !kept[i]);
  if (matchOf.every((x) => x >= 0) && !goneLines.length) return null;

  // Base lines dropped before each kept next line (and after the last), so each run says what it replaced.
  const droppedBefore = new Array<number>(nextLines.length + 1).fill(0);
  {
    let prevBase = -1;
    for (let j = 0; j <= nextLines.length; j++) {
      const at = j < nextLines.length ? matchOf[j]! : baseLines.length;
      if (at < 0) continue;
      droppedBefore[j] = at - prevBase - 1;
      prevBase = at;
    }
  }
  // Printed strictly in page order: `last` is the furthest next line printed so far. A context line is the
  // line as the client reads it ("~ " and its text); an anchor is one whose text occurs once in each page.
  const norm = (l: string) => key(l).trim();
  const count = (lines: string[]) => {
    const c = new Map<string, number>();
    for (const l of lines) c.set(norm(l), (c.get(norm(l)) ?? 0) + 1);
    return c;
  };
  const inBase = count(baseLines);
  const inNext = count(nextLines);
  const unique = (j: number) => inBase.get(norm(nextLines[j]!)) === 1 && inNext.get(norm(nextLines[j]!)) === 1;
  const out: string[] = [];
  let last = -1;
  for (let j = 0; j <= nextLines.length; ) {
    // A run: next lines with no match, plus the base lines dropped before the kept line that ends it.
    if (j < nextLines.length && matchOf[j]! >= 0 && !droppedBefore[j]) {
      j++;
      continue;
    }
    let end = j;
    while (end < nextLines.length && matchOf[end]! < 0) end++;
    const added = end - j;
    const dropped = droppedBefore[end] ?? 0;
    if (!added && !dropped) {
      j = end + 1;
      continue;
    }
    // The unchanged lines leading to the run, from the nearest anchor after what is already printed (or straight on
    // from it, or from the top of the page): never a lone repeated line, which could be any of its copies.
    let from = j - 1;
    while (from > last && !unique(from)) from--;
    // Context is printed without the snapshot's own new-element mark ("*"), which says new since the previous
    // snapshot, not since `base`, and would make the line read unlike its copy in `base`.
    for (let k = Math.max(from, last + 1); k < j; k++) out.push(`~ ${norm(nextLines[k]!)}`);
    for (let k = j; k < end; k++) {
      if (readsAsSyntax(nextLines[k]!)) return full("page-text-like-markers");
      out.push(nextLines[k]!);
    }
    last = end - 1;
    if (dropped) out.push(added ? `(replaces ${dropped} line(s))` : `(${dropped} line(s) gone here)`);
    droppedBefore[end] = 0; // said with this run
    j = end;
  }
  const refOf = (l: string) => /\[((?:f\d+)?e\d+)\]/.exec(l)?.[1];
  const nowRefs = new Set(nextLines.map(refOf).filter(Boolean));
  const stillLive = (ref: string | undefined) => !!ref && (opts.liveRefs ? opts.liveRefs.has(ref) : false);
  const goneRefs = goneLines
    .filter((l) => refOf(l) && !nowRefs.has(refOf(l)) && !stillLive(refOf(l)))
    .map((l) => /\[((?:f\d+)?e\d+)\]<\w+[^>]*>?([^<]{0,40})/.exec(l))
    .filter((x): x is RegExpExecArray => !!x);
  if (goneRefs.length) out.push(`GONE from the page: ${goneRefs.map((x) => `[${x[1]}]${x[2]?.trim() ? ` ${x[2].trim()}` : ""}`).join("; ")}`);
  const text = out.join("\n");
  return { text, ratio: text.length / Math.max(1, next.length), gone: goneLines.length };
}
