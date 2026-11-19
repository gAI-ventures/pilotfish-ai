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
  /** Visible text changed, including removal, order and duplicate-count changes. */
  textChanged?: boolean;
  /**
   * The page's own main heading (its first visible h1) before and after, as the page words it: after a search or a
   * choice it is often where the site says what it resolved ("North goa: 8 properties found"). Never interpreted.
   */
  heading?: { before: string; after: string };
  /**
   * The page's breadcrumb trail (an element named as one, the WAI-ARIA pattern), before and after, its parts in order.
   * Found by the word "breadcrumb" in its name: English-named trails only (`breadcrumbOf`).
   */
  breadcrumb?: { before: string[]; after: string[]; name: string };
  /**
   * New elements with role=tab, in page order, described as `added` is (the first `TABS_KEPT`), and how many there were:
   * `formatEvidence` names the ones its list of new elements leaves out. Tabs only, no other role (17 Nov).
   */
  addedTabs?: string[];
  addedTabCount?: number;
  /** Overall judgement computed from the above. */
  changed: boolean;
}

export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  extras: {
    dialogs?: DialogInfo[];
    network?: { requests: number; failed: number };
    settle?: SettleResult | null;
    writes?: WriteSummary[];
    /** Elements described as the compact screen prints them (describeNode's `compactFor`): the after page's address. */
    compactFor?: string;
    /** Elements described with the screen's `roleTags` markup. */
    roleTags?: boolean;
    /** Also compare `invalid` (a field turning invalid or valid), for a caller that asks for validation (17 Nov). */
    validation?: boolean;
  } = {},
): ActionEvidence {
  const describe = (n: SnapNode, url: string) => describeNode(n, extras.compactFor !== undefined ? url : undefined, extras.roleTags);
  // Compare ALL interactive nodes, not just the ones that got a ref in each snapshot's viewport band:
  // a whole-page snapshot (e.g. after `find`) against a one-band snapshot would otherwise report every
  // out-of-band element as "removed" and mark an inert action as changed, defeating the no-effect check.
  const interactive = (snap: Snapshot) => snap.nodes.filter((n) => n.nodeType === 1 && (n.interactive || n.scrollable));
  const beforeByKey = new Map<string, SnapNode>();
  for (const n of interactive(before)) beforeByKey.set(nodeKey(n), n);
  const afterByKey = new Map<string, SnapNode>();
  for (const n of interactive(after)) afterByKey.set(nodeKey(n), n);

  const added: string[] = [];
  const addedTabs: string[] = [];
  const removed: string[] = [];
  const valueChanges: ValueChange[] = [];
  const stateChanges: string[] = [];

  for (const [k, n] of afterByKey) {
    const prev = beforeByKey.get(k);
    if (!prev) {
      added.push(describe(n, after.url));
      if (n.role === "tab") addedTabs.push(added[added.length - 1]!);
      continue;
    }
    // Value/state changes are only actionable for an element the model can name, i.e. one with a ref
    // (in the rendered band); out-of-band flips still count toward `changed` via added/removed.
    if ((prev.value ?? "") !== (n.value ?? "") && n.ref) {
      valueChanges.push({ ref: n.ref, description: describe(n, after.url), from: clip(prev.value ?? "", 60), to: clip(n.value ?? "", 60) });
    }
    if (n.ref) {
      for (const prop of extras.validation ? (["checked", "expanded", "selected", "disabled", "invalid"] as const) : (["checked", "expanded", "selected", "disabled"] as const)) {
        if ((prev[prop] ?? false) !== (n[prop] ?? false)) {
          stateChanges.push(`${n.ref} ${prop}: ${prev[prop] ? "true" : "false"} → ${n[prop] ? "true" : "false"}`);
        }
      }
    }
  }
  for (const [k, n] of beforeByKey) {
    if (!afterByKey.has(k)) removed.push(describe(n, before.url));
  }

  // Compare the ordered visible runs, not only a set of newly added long strings. Short
  // prices/counts/Yes-No states and removal-only updates matter too: treating those as an
  // unchanged page suppresses the refreshed snapshot sent to an MCP client.
  const visibleRuns = (snap: Snapshot): string[] => snap.nodes
    .filter((n) => !!n.text?.trim() && (!n.parent || n.parent.visible || n.parent.boxless))
    .map((n) => n.text!.replace(/\s+/g, " ").trim());
  const beforeRuns = visibleRuns(before);
  const afterRuns = visibleRuns(after);
  const textChanged = beforeRuns.length !== afterRuns.length || afterRuns.some((t, i) => t !== beforeRuns[i]);
  const beforeText = new Set(beforeRuns);
  const newText: string[] = [];
  const seen = new Set<string>();
  for (const text of afterRuns) {
    if (beforeText.has(text) || seen.has(text)) continue;
    seen.add(text);
    newText.push(clip(text, 120));
    if (newText.length >= 8) break;
  }

  const navigated = before.url !== after.url;
  const hb = headingOf(before);
  const ha = headingOf(after);
  const bb = breadcrumbOf(before);
  const ba = breadcrumbOf(after);
  const scrollDelta = { x: Math.round(after.scroll.x - before.scroll.x), y: Math.round(after.scroll.y - before.scroll.y) };
  const dialogs = extras.dialogs ?? [];
  const changed =
    navigated ||
    added.length > 0 ||
    removed.length > 0 ||
    valueChanges.length > 0 ||
    stateChanges.length > 0 ||
    textChanged ||
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
    ...(addedTabs.length ? { addedTabs: addedTabs.slice(0, TABS_KEPT), addedTabCount: addedTabs.length } : {}),
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
    textChanged,
    ...(ha !== hb ? { heading: { before: hb, after: ha } } : ha && navigated ? { heading: { before: hb, after: ha } } : {}),
    ...(ba && (navigated || ba.parts.join("\n") !== (bb?.parts ?? []).join("\n")) ? { breadcrumb: { before: bb?.parts ?? [], after: ba.parts, name: ba.name } } : {}),
    changed,
  };
}

/** Controls whose own text (a select's options, a button's label) is not the heading's words when nested in one. */
const CONTROL_TAGS = new Set(["select", "option", "optgroup", "datalist", "button", "input", "textarea"]);
const CONTROL_ROLES = new Set(["combobox", "listbox", "menu", "menubar", "button", "textbox", "searchbox"]);

/**
 * The first visible top-level heading's own text ("" when there is none): its visible text, leaving out controls
 * nested in it (17 Nov: Amazon's results h1 holds its sort <select>, whose every option read as part of the heading).
 */
export function headingOf(snap: Snapshot): string {
  const own = (h: SnapNode): string => {
    const parts: string[] = [];
    const walk = (c: SnapNode) => {
      if (c.text) parts.push(c.text);
      for (const ch of c.children) {
        if (ch.nodeType === 1 && (!(ch.visible || ch.boxless) || CONTROL_TAGS.has(ch.tag) || CONTROL_ROLES.has(ch.role))) continue;
        walk(ch);
      }
    };
    walk(h);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  for (const n of snap.nodes) {
    if (n.nodeType !== 1 || !n.visible || !(n.tag === "h1" || (n.role === "heading" && n.attrs["aria-level"] === "1"))) continue;
    const t = own(n);
    if (t) return clip(t, 160);
  }
  return "";
}

/**
 * The page's breadcrumb trail: the first visible element whose accessible name says it is one (the WAI-ARIA breadcrumb
 * pattern, aria-label="Breadcrumb"), its texts in order (separators left out), at most 8. A heuristic on English text:
 * the name must contain "breadcrumb", so a trail labelled in another language ("Fil d'Ariane", "Brotkrümelnavigation",
 * "Ruta de navegación") or not labelled at all gives none. The heading (`headingOf`) needs no words:
 * the first visible h1 or level-1 heading.
 */
export function breadcrumbOf(snap: Snapshot): { name: string; parts: string[] } | null {
  const b = snap.nodes.find((n) => n.nodeType === 1 && n.visible && /breadcrumb/i.test(n.name || n.attrs["aria-label"] || ""));
  if (!b) return null;
  const parts: string[] = [];
  const walk = (n: SnapNode) => {
    if (n.text && /[\p{L}\p{N}]/u.test(n.text)) parts.push(clip(n.text.replace(/\s+/g, " ").trim(), 60));
    for (const c of n.children) if (c.nodeType !== 1 || c.visible || c.boxless) walk(c);
  };
  walk(b);
  return parts.length ? { name: b.name || b.attrs["aria-label"] || "", parts: parts.slice(0, 8) } : null;
}

/** How many new tabs the evidence keeps by description, and how many of those its unlisted-tabs line names. */
const TABS_KEPT = 20;
const TABS_NAMED = 3;

/** Compact, model-facing rendering of evidence (aim: < 400 tokens). */
/**
 * `shown`: the snapshot printed with this evidence; new elements and text it already shows are only counted, not
 * listed again (a page load listed five of its elements and five of its texts, all on the screen printed below).
 * `lists: false`: counts only (no snapshot follows, as the reader asked).
 * `compactUrls`: an address change within the same origin and path is said as the new address in full plus each query
 * parameter (and the fragment) that changed, with its old and new value (`sameAddressChange`): the old address is the
 * new one with those changes undone, so nothing of it is lost, and the parameters that did not change are not repeated.
 */
function unlistedTabs(ev: ActionEvidence, listed: string[], onScreen: (t: string) => boolean): string {
  const kept = ev.addedTabs ?? [];
  const left = kept.filter((t) => !listed.includes(t) && !onScreen(t));
  // Tabs past the kept ones are past the first five new elements, so none of them is listed; they are counted.
  const n = left.length + Math.max(0, (ev.addedTabCount ?? kept.length) - kept.length);
  if (!n) return "";
  const named = left.slice(0, TABS_NAMED);
  return `- ${n} new tab(s) not listed above: ${named.join(" ; ")}${n > named.length ? ` (+${n - named.length} more)` : ""}`;
}

export function formatEvidence(ev: ActionEvidence, { shown, lists = true, compactUrls = false, newDocument = false }: { shown?: string; lists?: boolean; compactUrls?: boolean; newDocument?: boolean } = {}): string {
  const refIn = (s: string) => /^\[((?:f\d+)?e\d+)\]/.exec(s)?.[1];
  // The same items as without `shown`, less the ones it prints.
  const added = !lists ? [] : ev.added.slice(0, 5).filter((a) => !(shown && refIn(a) && shown.includes(`[${refIn(a)}]`)));
  const newText = !lists ? [] : ev.newText.slice(0, 5).filter((t) => !(shown && shown.includes(t.replace(/\s+/g, " ").trim())));
  // A new document (18 Nov, the open MCP): every element of the earlier one is gone, so naming three of them tells
  // nothing; the count stays. (Amazon's next results page listed three of the last page's links, about 400 characters.)
  const removed = lists && !(compactUrls && newDocument) ? ev.removed : [];
  const lines: string[] = [];
  if (!ev.changed) {
    lines.push("EVIDENCE: no observable change (same URL, no new/removed elements, no value/state changes, no text changes).");
  } else {
    lines.push("EVIDENCE:");
    if (ev.navigated) lines.push(`- navigated: ${(compactUrls && sameAddressChange(ev.urlBefore, ev.urlAfter)) || `${ev.urlBefore} → ${ev.urlAfter}`}`);
    if (ev.titleBefore !== ev.titleAfter) lines.push(`- title: "${clip(ev.titleBefore, 60)}" → "${clip(ev.titleAfter, 60)}"`);
    // The page's own heading and breadcrumb when they changed or the page moved, unless the screen printed with this
    // evidence already shows them (a breadcrumb by its own name line).
    if (ev.heading?.after && !(shown && shown.includes(ev.heading.after))) lines.push(`- page heading: "${ev.heading.after}"`);
    if (ev.breadcrumb && !(shown && ev.breadcrumb.name && shown.includes(ev.breadcrumb.name))) lines.push(`- breadcrumb: ${ev.breadcrumb.after.join(" › ")}`);
    if (ev.dialogs.length) for (const d of ev.dialogs) lines.push(`- ${d.type} dialog "${clip(d.message, 100)}" was auto-${d.handledWith}ed`);
    if (ev.valueChanges.length) for (const v of ev.valueChanges.slice(0, 6)) lines.push(`- value ${v.ref}: "${v.from}" → "${v.to}"`);
    if (ev.stateChanges.length) lines.push(`- state: ${ev.stateChanges.slice(0, 6).join("; ")}`);
    if (ev.addedCount) lines.push(`- ${ev.addedCount} new interactive element(s)${added.length ? ": " + added.slice(0, 5).join(" ; ") : ""}`);
    // Additive (17 Nov): the line above lists the first five new elements in page order, so a tablist after them (Google
    // Flights' "Cheapest from ₹9,584" below its filter buttons) was in no quiet reply. Its new tabs that the list and the
    // screen printed with it leave out are named on a line of their own; nothing above is reordered or dropped, and
    // with none left out there is no line. It repairs what the reply shows; it does not claim a reader will open a tab.
    const tabsLine = lists ? unlistedTabs(ev, added, (t) => !!(shown && refIn(t) && shown.includes(`[${refIn(t)}]`))) : "";
    if (tabsLine) lines.push(tabsLine);
    if (ev.removedCount) lines.push(`- ${ev.removedCount} element(s) removed${removed.length ? ": " + removed.slice(0, 3).join(" ; ") : compactUrls && newDocument && lists ? " (the earlier page's)" : ""}`);
    if (newText.length) lines.push(`- new text: ${newText.slice(0, 5).map((t) => `"${t}"`).join(", ")}`);
    if (ev.textChanged && !ev.newText.length) lines.push("- visible text changed");
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

/**
 * `<after> (same path; k: "old" → "new", n added "v", p removed (was "v"), fragment "a" → "b")` when `before` and
 * `after` share origin and path and the line is shorter than `before → after`; else null (another origin or path, a
 * key repeated in either query, an address that does not parse). Values are given whole: the old address can be
 * rebuilt exactly from the line (a parameter's position aside).
 */
export function sameAddressChange(before: string, after: string): string | null {
  let a: URL, b: URL;
  try {
    a = new URL(before);
    b = new URL(after);
  } catch {
    return null;
  }
  if (a.origin !== b.origin || a.pathname !== b.pathname) return null;
  const pairs = (u: URL) => [...u.searchParams.entries()];
  const pa = pairs(a), pb = pairs(b);
  if (new Set(pa.map(([k]) => k)).size !== pa.length || new Set(pb.map(([k]) => k)).size !== pb.length) return null;
  const ma = new Map(pa), mb = new Map(pb);
  const q = (s: string) => JSON.stringify(s);
  const parts: string[] = [];
  for (const [k, v] of pb) {
    if (!ma.has(k)) parts.push(`${k} added ${q(v)}`);
    else if (ma.get(k) !== v) parts.push(`${k}: ${q(ma.get(k)!)} → ${q(v)}`);
  }
  for (const [k, v] of pa) if (!mb.has(k)) parts.push(`${k} removed (was ${q(v)})`);
  if (a.hash !== b.hash) parts.push(`fragment ${q(a.hash.slice(1))} → ${q(b.hash.slice(1))}`);
  if (!parts.length) return null;
  const line = `${after} (same path; ${parts.join(", ")})`;
  return line.length < `${before} → ${after}`.length ? line : null;
}

export { textOf };
