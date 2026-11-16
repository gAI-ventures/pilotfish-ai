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
}

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
export function diffObservation(base: string, next: string, opts: { liveRefs?: ReadonlySet<string>; truncated?: boolean } = {}): ObservationDiff | null {
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
