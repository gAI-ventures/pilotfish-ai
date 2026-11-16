// Action evidence: a structured, code-computed diff between the snapshot
// before an action and the snapshot after it. This is the "missing feedback
// signal" the failure analyses point at (BrowserForge: 71% of failures are
// unproductive repetition). Every action result carries one, so the model can
// tell "nothing happened" from "a modal opened" from "navigated" without a
// screenshot and without guessing.

import type { DialogInfo, SettleResult, WriteSummary } from "@pilotfish/browser";
import { nodeKey, textOf, type SnapNode, type Snapshot } from "./snapshot.js";
import { clip, describeNode } from "./serialize.js";

export interface ValueChange {
  ref: string;
  description: string;
  from: string;
  to: string;
}

export interface ActionEvidence {
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  titleBefore: string;
  titleAfter: string;
  /** Interactive elements that appeared / disappeared (by structural key). */
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  /** Input/select/textarea values that changed. */
  valueChanges: ValueChange[];
  /** State flips (checked/expanded/selected/disabled). */
  stateChanges: string[];
  focusedBefore?: string;
  focusedAfter?: string;
  scrollDelta: { x: number; y: number };
  dialogs: DialogInfo[];
  network: { requests: number; failed: number };
  settle: SettleResult | null;
  /** Write requests the action caused (first-party, non-telemetry), when tracked. */
  writes?: WriteSummary[];
  /** New visible text that wasn't on the page before (first few lines). */
  newText: string[];
  /** Overall judgement computed from the above. */
  changed: boolean;
}

export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  extras: { dialogs?: DialogInfo[]; network?: { requests: number; failed: number }; settle?: SettleResult | null; writes?: WriteSummary[] } = {},
): ActionEvidence {
  // Compare ALL interactive nodes, not just the ones that got a ref in each snapshot's viewport band:
  // a whole-page snapshot (e.g. after `find`) against a one-band snapshot would otherwise report every
  // out-of-band element as "removed" and mark an inert action as changed, defeating the no-effect check.
  const interactive = (snap: Snapshot) => snap.nodes.filter((n) => n.nodeType === 1 && (n.interactive || n.scrollable));
  const beforeByKey = new Map<string, SnapNode>();
  for (const n of interactive(before)) beforeByKey.set(nodeKey(n), n);
  const afterByKey = new Map<string, SnapNode>();
  for (const n of interactive(after)) afterByKey.set(nodeKey(n), n);

  const added: string[] = [];
  const removed: string[] = [];
  const valueChanges: ValueChange[] = [];
  const stateChanges: string[] = [];

  for (const [k, n] of afterByKey) {
    const prev = beforeByKey.get(k);
    if (!prev) {
      added.push(describeNode(n));
      continue;
    }
    // Value/state changes are only actionable for an element the model can name, i.e. one with a ref
    // (in the rendered band); out-of-band flips still count toward `changed` via added/removed.
    if ((prev.value ?? "") !== (n.value ?? "") && n.ref) {
      valueChanges.push({ ref: n.ref, description: describeNode(n), from: clip(prev.value ?? "", 60), to: clip(n.value ?? "", 60) });
    }
    if (n.ref) {
      for (const prop of ["checked", "expanded", "selected", "disabled"] as const) {
        if ((prev[prop] ?? false) !== (n[prop] ?? false)) {
          stateChanges.push(`${n.ref} ${prop}: ${prev[prop] ? "true" : "false"} → ${n[prop] ? "true" : "false"}`);
        }
      }
    }
  }
  for (const [k, n] of beforeByKey) {
    if (!afterByKey.has(k)) removed.push(describeNode(n));
  }

  // New visible text: compare sets of text runs under visible nodes (cheap, approximate).
  const beforeText = new Set<string>();
  for (const n of before.nodes) if (n.text && n.text.length > 3) beforeText.add(n.text);
  const newText: string[] = [];
  const seen = new Set<string>();
  for (const n of after.nodes) {
    if (!n.text || n.text.length <= 3 || beforeText.has(n.text) || seen.has(n.text)) continue;
    if (n.parent && !n.parent.visible && !n.parent.boxless) continue;
    seen.add(n.text);
    newText.push(clip(n.text, 120));
    if (newText.length >= 8) break;
  }

  const navigated = before.url !== after.url;
  const scrollDelta = { x: Math.round(after.scroll.x - before.scroll.x), y: Math.round(after.scroll.y - before.scroll.y) };
  const dialogs = extras.dialogs ?? [];
  const changed =
    navigated ||
    added.length > 0 ||
    removed.length > 0 ||
    valueChanges.length > 0 ||
    stateChanges.length > 0 ||
    newText.length > 0 ||
    dialogs.length > 0 ||
    before.title !== after.title ||
    scrollDelta.y !== 0 ||
    scrollDelta.x !== 0 ||
    before.focusedRef !== after.focusedRef ||
    (extras.writes?.length ?? 0) > 0;

  return {
    urlBefore: before.url,
    urlAfter: after.url,
    navigated,
    titleBefore: before.title,
    titleAfter: after.title,
    added: added.slice(0, 10),
    removed: removed.slice(0, 10),
    addedCount: added.length,
    removedCount: removed.length,
    valueChanges,
    stateChanges,
    focusedBefore: before.focusedRef,
    focusedAfter: after.focusedRef,
    scrollDelta,
    dialogs,
    network: extras.network ?? { requests: 0, failed: 0 },
    settle: extras.settle ?? null,
    writes: extras.writes,
    newText,
    changed,
  };
}

/** Compact, model-facing rendering of evidence (aim: < 400 tokens). */
/**
 * `shown`: the snapshot printed with this evidence; new elements and text it already shows are only counted, not
 * listed again (a page load listed five of its elements and five of its texts, all on the screen printed below).
 * `lists: false`: counts only (no snapshot follows, as the reader asked).
 */
export function formatEvidence(ev: ActionEvidence, { shown, lists = true }: { shown?: string; lists?: boolean } = {}): string {
  const refIn = (s: string) => /^\[((?:f\d+)?e\d+)\]/.exec(s)?.[1];
  // The same items as without `shown`, less the ones it prints.
  const added = !lists ? [] : ev.added.slice(0, 5).filter((a) => !(shown && refIn(a) && shown.includes(`[${refIn(a)}]`)));
  const newText = !lists ? [] : ev.newText.slice(0, 5).filter((t) => !(shown && shown.includes(t.replace(/\s+/g, " ").trim())));
  const removed = lists ? ev.removed : [];
  const lines: string[] = [];
  if (!ev.changed) {
    lines.push("EVIDENCE: no observable change (same URL, no new/removed elements, no value/state changes, no new text).");
  } else {
    lines.push("EVIDENCE:");
    if (ev.navigated) lines.push(`- navigated: ${ev.urlBefore} → ${ev.urlAfter}`);
    if (ev.titleBefore !== ev.titleAfter) lines.push(`- title: "${clip(ev.titleBefore, 60)}" → "${clip(ev.titleAfter, 60)}"`);
    if (ev.dialogs.length) for (const d of ev.dialogs) lines.push(`- ${d.type} dialog "${clip(d.message, 100)}" was auto-${d.handledWith}ed`);
    if (ev.valueChanges.length) for (const v of ev.valueChanges.slice(0, 6)) lines.push(`- value ${v.ref}: "${v.from}" → "${v.to}"`);
    if (ev.stateChanges.length) lines.push(`- state: ${ev.stateChanges.slice(0, 6).join("; ")}`);
    if (ev.addedCount) lines.push(`- ${ev.addedCount} new interactive element(s)${added.length ? ": " + added.slice(0, 5).join(" ; ") : ""}`);
    if (ev.removedCount) lines.push(`- ${ev.removedCount} element(s) removed${removed.length ? ": " + removed.slice(0, 3).join(" ; ") : ""}`);
    if (newText.length) lines.push(`- new text: ${newText.slice(0, 5).map((t) => `"${t}"`).join(", ")}`);
    if (ev.scrollDelta.y || ev.scrollDelta.x) lines.push(`- scrolled by (${ev.scrollDelta.x}, ${ev.scrollDelta.y})`);
    if (ev.focusedBefore !== ev.focusedAfter) lines.push(`- focus: ${ev.focusedBefore ?? "none"} → ${ev.focusedAfter ?? "none"}`);
    // Identical requests (an autocomplete's lookups) once, with their count; the first 4 kinds.
    const kinds = new Map<string, { line: string; n: number }>();
    for (const w of ev.writes ?? []) {
      let path = w.url;
      try {
        path = new URL(w.url).pathname;
      } catch {}
      const outcome = w.failed ? `FAILED (${w.failed})` : w.status !== undefined ? String(w.status) : "no response yet";
      const key = `${w.method} ${path} ${outcome}`;
      const seen = kinds.get(key);
      if (seen) seen.n++;
      else kinds.set(key, { line: `- server: ${w.method} ${clip(path, 80)} → ${outcome}${w.ok ? "" : w.failed || (w.status ?? 0) >= 400 ? " — the server did NOT accept this" : ""}${w.ms !== undefined ? ` (${(w.ms / 1000).toFixed(1)}s)` : ""}`, n: 1 });
    }
    for (const { line, n } of [...kinds.values()].slice(0, 4)) lines.push(n > 1 ? `${line} ×${n}` : line);
  }
  const net = ev.network.requests ? `${ev.network.requests} request(s)${ev.network.failed ? `, ${ev.network.failed} failed` : ""}` : "no network";
  const settle = ev.settle ? `${ev.settle.networkIdle ? "network idle" : "NETWORK STILL BUSY"}, ${ev.settle.mutationsQuiet ? "DOM quiet" : "DOM still mutating"}` : "";
  lines.push(`- ${net}${settle ? `; ${settle}` : ""}`);
  return lines.join("\n");
}

export { textOf };
