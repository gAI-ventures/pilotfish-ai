// Page snapshot: DOMSnapshot.captureSnapshot (structure, layout, styles, form
// state, paint order) joined with Accessibility.getFullAXTree (roles, names,
// states) on backendNodeId, across the main frame, same-process iframes
// (DOMSnapshot `contentDocumentIndex`) and out-of-process iframes (child CDP
// sessions). Produces a flat list of `SnapNode`s in document order with page
// coordinates, interactivity and visibility, from which the serializer builds
// the model-facing text and the handle table.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Protocol } from "@pilotfish/cdp";
import type { FrameSession, Page, Rect } from "@pilotfish/browser";
import { isAdFrameUrl } from "@pilotfish/browser";

export interface SnapNode {
  /** Stable within this snapshot: "e12" (main) or "f1e12" (frame 1). Only interactive/scrollable nodes get one. */
  ref?: string;
  backendNodeId: number;
  /** Which FrameSession (CDP session) owns the node. */
  frame: FrameSession;
  /** DOMSnapshot document frame id (differs from frame.frameId for same-process iframes). */
  frameId: string;
  parent: SnapNode | null;
  children: SnapNode[];
  depth: number;
  nodeType: number;
  tag: string; // lowercase localName, "#text", "#document", "#shadow-root"
  text?: string; // for text nodes (collapsed whitespace)
  /**
   * The element's attributes as the page has them, plus the capture's own metadata under keys starting "__" (`__block`,
   * `__cursor`, `__pe`, `__clip`): never page evidence. Read the page's own through `pageAttrs`.
   */
  attrs: Record<string, string>;
  /** AX role (e.g. "button") or tag-derived fallback. */
  role: string;
  /** AX accessible name (for an element the page hides from assistive tech, see `axHidden`). */
  name: string;
  /**
   * The page hides this element from assistive tech (aria-hidden on it or an ancestor, a modal dialog open, inert):
   * Chromium then gives it no role and no name. Its role and name are the ones Chromium gave this same element before,
   * when what names it is unchanged, else derived from the DOM (`restoreHiddenNames`); its states from its aria-*
   * attributes. Without this, every element of a page that hides its background while a listbox or dialog is open
   * changed its structural key: reported as removed and new, printed another way, and the whole screen reprinted.
   */
  axHidden?: boolean;
  /**
   * Chromium's accessibility tree has no entry for this element: hidden by the page (above), "uninteresting" to it, or
   * read a moment before the tree caught up with the DOM (17 Nov, Google Flights: the capture right after opening its
   * listbox read the tree with the background already dropped and the DOM a moment before `aria-hidden` was set on it,
   * so the inputs were neither named nor marked hidden). Such an element keeps Chromium's earlier name for the same
   * node when what names it is unchanged and that name was Chromium's own (`restoreHiddenNames`). Naming only.
   */
  axUnlisted?: boolean;
  /** Current value for inputs/selects/textareas (never for password fields). */
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  required?: boolean;
  /** The element is marked invalid (AX `invalid`, aria-invalid): data only, printed nowhere unless asked (17 Nov). */
  invalid?: boolean;
  /** Layout box in top-level page CSS pixels, if rendered. */
  rect?: Rect;
  paintOrder?: number;
  visible: boolean;
  /** No layout box of its own but laid-out descendants (`display: contents`): invisible itself, walk through it. */
  boxless?: boolean;
  /** Has an effective click handler / is natively interactive / focusable. */
  interactive: boolean;
  /** Scroll container (overflow with content larger than box). */
  scrollable: boolean;
  shadowRoot?: "open" | "closed" | "user-agent";
  isIframe: boolean;
  /** Positional disambiguator among nodes with the same (frameId, role, name, tag). */
  nth: number;
  /** True when some ancestor element is interactive (text/spans inside a link or button). */
  inInteractive?: boolean;
  /** Stable distinguishing attribute (data-testid, id, name or href), "" if none. Part of the structural key. */
  identity: string;
  /** How many elements share this node's (frame, tag, role, name, identity) group in this snapshot. */
  groupSize: number;
  options?: Array<{ value: string; label: string; selected: boolean }>;
}

export interface Snapshot {
  takenAt: number;
  /**
   * The main-frame document the capture read (its loaderId, Page.documentId): no main-frame commit was seen between
   * the capture's start and its end. Null when that document is not known (a tab whose identity was not read yet), or
   * when `unsettled`: such a snapshot is bound to no document.
   */
  document?: string | null;
  /**
   * Page.documentSeq when the capture began and ended (the same: see `document`); unset when `unsettled`. A look that
   * pairs this snapshot with anything read later (a response, the address, cookies) checks the page is still on it.
   */
  documentSeq?: number;
  /**
   * The main frame committed another document during each of captureSnapshot's CAPTURE_TRIES captures: the snapshot
   * (the last) is bound to no document, and nothing that pairs it with a document's response may read it.
   */
  unsettled?: true;
  url: string;
  title: string;
  viewport: Rect;
  content: { width: number; height: number };
  scroll: { x: number; y: number };
  root: SnapNode;
  /** Every node in document order. */
  nodes: SnapNode[];
  byRef: Map<string, SnapNode>;
  frames: FrameSession[];
  /** Index of frame sessions as used in ref prefixes ("f1", "f2"...). */
  frameIndex: Map<FrameSession, number>;
  focusedRef?: string;
  /** Interactive elements outside the included viewport band, by direction. */
  offscreen: { above: number; below: number };
  /** Page-coordinate band [top, bottom] that the serializer renders. */
  band: { top: number; bottom: number };
  /** Set of structural element keys, used for `*` new-element markers. */
  keys: Set<string>;
  /**
   * Every ref handed out so far (structural key → ref), carried from snapshot to snapshot. An element
   * that leaves the band keeps its ref when it comes back, and a new element never reuses its number.
   */
  refMemory: Map<string, string>;
  /** The highest ref number used so far, per frame index. */
  maxRef: Map<number, number>;
  /** Where the capture's time went (ms): `SnapshotTimings`. */
  timings?: SnapshotTimings;
}

/**
 * A capture's time (ms), each from its start: `wait` for the page's first answers (layout metrics, pixel ratio, title:
 * high when its main thread is busy or the machine is short of CPU), `dom` and `ax` for the main frame's DOM snapshot
 * and accessibility tree, `frames` for every frame's capture together (all four asked for at once), `build` for
 * joining them here.
 */
export interface SnapshotTimings {
  wait: number;
  dom: number;
  ax: number;
  frames: number;
  build: number;
}

/** Remembered refs kept per run; the oldest go first. */
const REF_MEMORY_MAX = 5_000;

export interface SnapshotOptions {
  /** Include interactive elements within this many viewport-heights above/below the viewport. Default 1 (i.e. 3 screens total). Infinity = whole page. */
  viewportBand?: number;
  /** Also include out-of-process iframe content. Default true. */
  includeOOPIF?: boolean;
  /** Previous snapshot; used to compute `*` markers and nth stability. */
  previous?: Snapshot | null;
}

const COMPUTED_STYLES = ["display", "visibility", "opacity", "overflow-x", "overflow-y", "cursor", "pointer-events"] as const;

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "scrollbar", "menubar", "menu",
  "gridcell", "columnheader", "rowheader", "disclosuretriangle", "progressbar",
]);
const NATIVE_INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "option", "video", "audio"]);
/** Elements whose text children have no layout boxes but still matter. */
const KEEP_CHILDREN_WITHOUT_LAYOUT = new Set(["select", "option", "optgroup", "datalist"]);
// <canvas> itself is kept (its fallback children have no layout and drop out): a drawn surface the
// model must know about to reach for a screenshot.
const SKIP_SUBTREE_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "path"]);

interface AXInfo {
  role: string;
  name: string;
  value?: string;
  props: Record<string, unknown>;
  /** Ignored by Chromium because the page hides it (HIDDEN_BY_PAGE), not because it is not rendered. */
  hidden?: true;
}

/** Why Chromium leaves a rendered element out of the accessibility tree when the page itself hides it from assistive tech. */
const HIDDEN_BY_PAGE = new Set(["ariaHiddenElement", "ariaHiddenSubtree", "activeModalDialog", "inertElement", "inertSubtree"]);

/**
 * Captures counted per unit of work (17 Nov, Stage A2; scoped after review): a caller runs its work inside
 * `withCaptureStats`, and every capture made in that async context (the action's, re-captures, re-grounds, reads)
 * adds to that unit's own count and summed wall ms, never another client's working at the same time. Numbers only;
 * a capture that fails still counts; a capture outside any unit is not counted.
 */
export interface CaptureStats {
  count: number;
  ms: number;
}
const captureScope = new AsyncLocalStorage<CaptureStats>();

/** Runs `fn` as one counted unit of work; `currentCaptureStats()` inside it reads that unit's counts. */
export function withCaptureStats<T>(fn: () => Promise<T>): Promise<T> {
  return captureScope.run({ count: 0, ms: 0 }, fn);
}

/** The counts of the unit of work this code runs in, or null outside one. */
export function currentCaptureStats(): CaptureStats | null {
  return captureScope.getStore() ?? null;
}

/**
 * Fields that were password fields when typed into (17 Nov): a page may turn one into a text field, and its value
 * would then be captured. Kept per page (tab), by DOM node and by structural key (a field redrawn keeps its key);
 * every capture of that page masks their values as a password field's are.
 */
const sensitiveFields = new WeakMap<object, { ids: Set<string>; keys: Set<string> }>();

export function markSensitiveField(page: Page, n: SnapNode): void {
  let s = sensitiveFields.get(page);
  if (!s) sensitiveFields.set(page, (s = { ids: new Set(), keys: new Set() }));
  s.ids.add(`${n.frameId}:${n.backendNodeId}`);
  s.keys.add(nodeKey(n));
}

/** Captures captureSnapshot makes, at most, for one that starts and ends on the same main-frame document. */
export const CAPTURE_TRIES = 3;

/**
 * Runs `capture` until one starts and ends on the same main-frame document (no commit seen meanwhile: Page.documentSeq
 * unchanged, an event count, never a time), at most `tries` times. `document` is that document's loaderId (null when
 * the page does not know it), or undefined when no try settled: the last value, bound to no document.
 *
 * `corroborate`, when given, asks the page itself after each capture which main-frame document it has committed (its
 * loaderId; null or undefined when it cannot say). A try settles only when that equals the document the Node side
 * holds: Chrome may tell Node of a commit only after a capture already read the new document's elements, and such a
 * capture would otherwise be bound to the old document and its response (fifth review, v5: the late event).
 *
 * A capture while the main frame commits another document may hold either one, its address the new one's (read last);
 * paired with a response, the block page HUMAN's script reloaded read with the next document's 200 as a Press & Hold
 * that was not there (fifth review, 17 Nov).
 */
export async function onOneDocument<T>(
  page: Pick<Page, "documentSeq" | "documentId">,
  capture: () => Promise<T>,
  tries = CAPTURE_TRIES,
  corroborate?: () => Promise<string | null | undefined>,
): Promise<{ value: T; document: string | null | undefined; tries: number }> {
  for (let n = 1; ; n++) {
    const seq = page.documentSeq;
    const document = page.documentId;
    const value = await capture();
    // The page's own word, read after the capture: no newer document has committed than the one Node holds.
    const confirmed = !corroborate || document === null || (await corroborate().catch(() => undefined)) === document;
    if (page.documentSeq === seq && confirmed) return { value, document, tries: n };
    if (n >= tries) return { value, document: undefined, tries: n };
  }
}

/** The main-frame document the page has committed, by its own account (Page.getFrameTree's loaderId); undefined if not read. */
export async function committedLoader(page: Page): Promise<string | undefined> {
  const r = await page.session.send("Page.getFrameTree", undefined, { timeoutMs: 3_000 }).catch(() => null);
  return r?.frameTree?.frame?.loaderId;
}

/** Capture a snapshot of the page across all frames, bound to the main-frame document it read (onOneDocument). */
export async function captureSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const t0 = Date.now();
  const stats = captureScope.getStore();
  let captures = 0;
  // The count the last try began at: on a settled capture, the one it ended at too.
  let seq = 0;
  try {
    const out = await onOneDocument(
      page,
      () => {
        captures++;
        seq = page.documentSeq;
        return captureOnce(page, opts);
      },
      CAPTURE_TRIES,
      () => committedLoader(page),
    );
    const snap = out.value;
    snap.document = out.document ?? null;
    if (out.document === undefined) snap.unsettled = true;
    else snap.documentSeq = seq;
    return snap;
  } finally {
    if (stats) {
      stats.count += captures;
      stats.ms += Date.now() - t0;
    }
  }
}

async function captureOnce(page: Page, opts: SnapshotOptions): Promise<Snapshot> {
  const started = Date.now();
  const timings: SnapshotTimings = { wait: 0, dom: 0, ax: 0, frames: 0, build: 0 };
  // The page's size, pixel ratio and title are asked for together and alongside the captures below: each waits for
  // the page's main thread, and one after another on a busy page each waited again (a travel results page after a
  // filter click: 6.0 s for these three, then 2.2 s for the captures).
  const asked = Promise.all([
    page.layoutMetrics(),
    // DOMSnapshot reports layout in device pixels; everything else here (viewport, scroll, box models,
    // input coordinates) is CSS pixels. On a 125% display a 300 px button came back 375 px wide.
    page.main.evaluate<number>("devicePixelRatio", { timeoutMs: 2_000 }).catch(() => 1),
    page.title(),
  ]).finally(() => void (timings.wait = Date.now() - started));
  // Ad and tracking iframes are skipped: their renderers are often busy for seconds and they hold nothing a task needs.
  const frames = opts.includeOOPIF === false ? [page.main] : page.frames().filter((f) => f.isMain || !isAdFrameUrl(f.url));
  const frameIndex = new Map<FrameSession, number>();
  frames.forEach((f, i) => frameIndex.set(f, i));

  const root: SnapNode = {
    backendNodeId: -1, frame: page.main, frameId: page.main.frameId, parent: null, children: [], depth: -1, nodeType: 9,
    tag: "#document", attrs: {}, role: "document", name: "", visible: true, interactive: false, scrollable: false, isIframe: false, nth: 0, identity: "", groupSize: 1,
  };
  const nodes: SnapNode[] = [];

  // Capture every frame concurrently; join each in order.
  const capturing = Promise.all(
    frames.map(async (frame) => {
      const [dom, ax] = await Promise.all([
        // A child frame gets 2 s: one slow third-party frame must not stall every step.
        frame.session
          .send("DOMSnapshot.captureSnapshot", { computedStyles: [...COMPUTED_STYLES], includePaintOrder: true, includeDOMRects: true }, { timeoutMs: frame.isMain ? 20_000 : 2_000 })
          .catch(() => null)
          .finally(() => void (frame.isMain && (timings.dom = Date.now() - started))),
        collectAX(frame).finally(() => void (frame.isMain && (timings.ax = Date.now() - started))),
      ]);
      const offset = frame.isMain ? { x: 0, y: 0 } : await frame.offsetInPage().catch(() => ({ x: 0, y: 0 }));
      // For OOPIFs, find the <iframe> element in the parent session that owns this frame so we can mount under it.
      let ownerBackendNodeId: number | null = null;
      if (frame.parent) {
        ownerBackendNodeId = await frame.parent.session
          .send("DOM.getFrameOwner", { frameId: frame.frameId })
          .then((r) => r.backendNodeId)
          .catch(() => null);
      }
      return { frame, dom, ax, offset, ownerBackendNodeId };
    }),
  ).finally(() => void (timings.frames = Date.now() - started));
  const [[metrics, dpr, title], captures] = await Promise.all([asked, capturing]);
  const geo = { ...metrics, scale: dpr > 0 ? 1 / dpr : 1 };
  const building = Date.now();
  // OOPIF documents attach under the iframe element in the parent that owns them.
  const oopifMounts = new Map<string, SnapNode>(); // frameId -> iframe SnapNode
  const nthCounter = new Map<string, number>();

  for (const cap of captures) {
    if (!cap.dom) continue;
    const mountParent = cap.frame.isMain
      ? root
      : (cap.ownerBackendNodeId !== null ? oopifMounts.get(`owner:${cap.frame.parent!.frameId}:${cap.ownerBackendNodeId}`) : undefined) ?? root;
    // Boxes are viewport-relative everywhere (the band, the viewport checks, overlay and challenge detection, click_xy
    // hints). DOMSnapshot gives the main document's in page coordinates, so its scroll comes off here; a frame's offset
    // (offsetInPage, from content quads) is viewport-relative already. Until 4 Nov the scroll was not taken off, and every
    // snapshot after a scroll showed the top three screens of the page whatever was on screen.
    const offset = cap.frame.isMain ? { x: cap.offset.x - metrics.scroll.x, y: cap.offset.y - metrics.scroll.y } : cap.offset;
    buildDocument(cap.dom, 0, cap.frame, cap.ax, mountParent, offset, nodes, oopifMounts, nthCounter, geo);
  }
  // Elements the page hides from assistive tech get their role and name back; the positional numbers that depend on
  // names are then counted again, in the same document order the build counted them.
  if (restoreHiddenNames(nodes, opts.previous ?? null)) {
    nthCounter.clear();
    for (const n of nodes) {
      if (!(n.interactive || n.scrollable)) continue;
      const k = groupKey(n);
      n.nth = nthCounter.get(k) ?? 0;
      nthCounter.set(k, n.nth + 1);
    }
  }

  // Assign refs to interactive + scrollable nodes, compute viewport band filter.
  const band = opts.viewportBand ?? 1;
  const vpTop = metrics.viewport.y;
  const vpBottom = metrics.viewport.y + metrics.viewport.height;
  const bandTop = vpTop - band * metrics.viewport.height;
  const bandBottom = vpBottom + band * metrics.viewport.height;
  const byRef = new Map<string, SnapNode>();
  const offscreen = { above: 0, below: 0 };
  let focusedRef: string | undefined;
  for (const n of nodes) {
    if (n.interactive || n.scrollable) n.groupSize = nthCounter.get(`${groupKey(n)}`) ?? 1;
  }

  // Stable refs: an element that is still present (same structural key) keeps
  // the ref it had before, so refs the model already holds stay valid across
  // actions. That includes elements that were outside the band for a while (a
  // find hit below the viewport, a field scrolled past): forgetting them made the
  // model's next click on one fail. New elements get numbers above any used before.
  const prevRefByKey = new Map<string, string>(opts.previous?.refMemory ?? []);
  // Prefer the SAME DOM node over a structural match: a backendNodeId is stable for a node's
  // lifetime, so a ref follows its own element even when an identical look-alike earlier in the
  // page is added or removed (which shifts the positional `nth` and would otherwise move the ref
  // onto a neighbour — "remove row B" deleting row C).
  const prevRefByBackend = new Map<string, string>();
  const maxUsed = new Map<number, number>(opts.previous?.maxRef ?? []);
  const parseRef = (ref: string): { fi: number; num: number } => {
    const m = /^(?:f(\d+))?e(\d+)$/.exec(ref);
    return { fi: m?.[1] ? Number(m[1]) : 0, num: m ? Number(m[2]) : 0 };
  };
  if (opts.previous) {
    for (const [ref, pn] of opts.previous.byRef) {
      prevRefByKey.set(nodeKey(pn), ref);
      prevRefByBackend.set(`${pn.frameId}:${pn.backendNodeId}`, ref);
      const { fi, num } = parseRef(ref);
      maxUsed.set(fi, Math.max(maxUsed.get(fi) ?? 0, num));
    }
  }
  const taken = new Set<string>();
  const inBand: SnapNode[] = [];
  for (const n of nodes) {
    if (!(n.interactive || n.scrollable) || !n.visible || !n.rect) continue;
    // rect is viewport-relative; convert to page-relative for band test
    const pageY = n.rect.y + metrics.scroll.y;
    if (Number.isFinite(band) && (pageY + n.rect.height < bandTop || pageY > bandBottom)) {
      if (pageY > bandBottom) offscreen.below++;
      else offscreen.above++;
      continue;
    }
    inBand.push(n);
  }
  const assign = (n: SnapNode, ref: string) => {
    n.ref = ref;
    taken.add(ref);
    byRef.set(ref, n);
    if (n.focused) focusedRef = ref;
  };
  // Two ordered passes so a look-alike can never claim a ref that its own element reclaims. Pass 1:
  // keep a ref on the SAME DOM node (stable backendNodeId) — the strongest identity. Pass 2: a
  // structural match from memory, only for nodes that did not keep a backend ref and only for refs not
  // already claimed in pass 1. Pass 3: a fresh number above any used before.
  for (const n of inBand) {
    const fi = frameIndex.get(n.frame) ?? 0;
    const byBackend = prevRefByBackend.get(`${n.frameId}:${n.backendNodeId}`);
    if (byBackend && parseRef(byBackend).fi === fi && !taken.has(byBackend)) assign(n, byBackend);
  }
  for (const n of inBand) {
    if (n.ref) continue;
    const fi = frameIndex.get(n.frame) ?? 0;
    const byKey = prevRefByKey.get(nodeKey(n));
    if (byKey && parseRef(byKey).fi === fi && !taken.has(byKey)) assign(n, byKey);
  }
  for (const n of inBand) {
    if (n.ref) continue;
    const fi = frameIndex.get(n.frame) ?? 0;
    let c = (maxUsed.get(fi) ?? 0) + 1;
    let ref = fi === 0 ? `e${c}` : `f${fi}e${c}`;
    while (taken.has(ref)) {
      c++;
      ref = fi === 0 ? `e${c}` : `f${fi}e${c}`;
    }
    maxUsed.set(fi, c);
    assign(n, ref);
  }

  const keys = new Set<string>();
  for (const n of byRef.values()) keys.add(nodeKey(n));
  // What this snapshot shows moves to the newest end of the memory; the oldest entries go first.
  const refMemory = prevRefByKey;
  for (const [ref, n] of byRef) {
    const k = nodeKey(n);
    refMemory.delete(k);
    refMemory.set(k, ref);
  }
  for (const k of refMemory.keys()) {
    if (refMemory.size <= REF_MEMORY_MAX) break;
    refMemory.delete(k);
  }

  const sens = sensitiveFields.get(page);
  if (sens) {
    for (const n of nodes) {
      if (n.value && (sens.ids.has(`${n.frameId}:${n.backendNodeId}`) || sens.keys.has(nodeKey(n)))) n.value = "•".repeat(Math.min(n.value.length, 8));
    }
  }
  timings.build = Date.now() - building;
  return {
    takenAt: Date.now(),
    timings,
    url: page.url,
    title,
    viewport: metrics.viewport,
    content: metrics.content,
    scroll: metrics.scroll,
    root,
    nodes,
    byRef,
    frames,
    frameIndex,
    focusedRef,
    offscreen,
    band: { top: bandTop, bottom: bandBottom },
    keys,
    refMemory,
    maxRef: maxUsed,
  };
}

/** Is a node's box inside the rendered band (or boxless, in which case yes)? */
export function inBand(snap: Snapshot, n: SnapNode): boolean {
  if (!n.rect) return true;
  const top = n.rect.y + snap.scroll.y;
  const bottom = top + n.rect.height;
  return bottom >= snap.band.top && top <= snap.band.bottom;
}

/** A frame URL that belongs to a known CAPTCHA / bot-check provider (reCAPTCHA, hCaptcha, Turnstile, Arkose). */
export function isCaptchaFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /(^https?:\/\/|\/\/)([^/]*\.)?(google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com)/i.test(url);
}

/** Structural identity of an element independent of backendNodeId: frame + role + name + tag + nth. */
/** A key of `SnapNode.attrs` that is the capture's own metadata, not an attribute of the page. */
export const isCaptureMeta = (key: string): boolean => key.startsWith("__");

/** The element's attributes as the page has them: the capture's own metadata left out. */
export function pageAttrs(n: SnapNode): [string, string][] {
  return Object.entries(n.attrs).filter(([k]) => !isCaptureMeta(k));
}

export function nodeKey(n: SnapNode): string {
  return `${n.frameId}|${n.tag}|${n.role}|${n.name.slice(0, 80)}|${n.identity}|${n.nth}`;
}

/** The (frame, tag, role, name, identity) group a node belongs to, without its position. */
export function groupKey(n: SnapNode): string {
  return `${n.frameId}|${n.tag}|${n.role}|${n.name.slice(0, 80)}|${n.identity}`;
}

/**
 * A distinguishing attribute that survives re-renders, so identity does not
 * depend on position when the page offers something better. Generated ids
 * (React's ":r1:", long numeric runs, UUIDs) are skipped.
 */
function identityOf(n: SnapNode): string {
  const a = n.attrs;
  const testid = a["data-testid"] ?? a["data-test"] ?? a["data-qa"] ?? a["data-cy"];
  if (testid) return `t:${testid.slice(0, 60)}`;
  const id = a["id"];
  if (id && id.length <= 40 && !/^:|\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return `i:${id}`;
  if (a["name"] && ["input", "select", "textarea", "button"].includes(n.tag)) return `n:${a["name"].slice(0, 60)}`;
  if (n.tag === "a" && a["href"]) return `h:${a["href"].slice(0, 120)}`;
  return "";
}

async function collectAX(frame: FrameSession): Promise<Map<number, AXInfo>> {
  const map = new Map<number, AXInfo>();
  // getFullAXTree without a frameId covers only the session's root document: same-process child
  // frames need their own call or their elements lose roles and names. Out-of-process frames have
  // their own session (and their own collectAX), so they are skipped here.
  const childIds: string[] = [];
  try {
    const { frameTree } = await frame.session.send("Page.getFrameTree", undefined, { timeoutMs: 2_000 });
    const walk = (t: Protocol.Page.FrameTree) => {
      for (const c of t.childFrames ?? []) {
        if (!frame.children.has(c.frame.id) && !isAdFrameUrl(c.frame.url)) childIds.push(c.frame.id);
        walk(c);
      }
    };
    walk(frameTree);
  } catch {
    /* no frame tree: root document only */
  }
  const calls = [undefined, ...childIds.slice(0, 20)].map((frameId) =>
    frame.session.send("Accessibility.getFullAXTree", frameId ? { frameId } : {}, { timeoutMs: frame.isMain && !frameId ? 20_000 : 2_000 }).catch(() => null),
  );
  for (const res of await Promise.all(calls)) {
    if (!res) continue;
    for (const ax of res.nodes) {
      if (ax.backendDOMNodeId === undefined) continue;
      if (ax.ignored) {
        if (!map.has(ax.backendDOMNodeId) && (ax.ignoredReasons ?? []).some((r) => HIDDEN_BY_PAGE.has(String(r.name)))) {
          map.set(ax.backendDOMNodeId, { role: "", name: "", props: {}, hidden: true });
        }
        continue;
      }
      const props: Record<string, unknown> = {};
      for (const p of ax.properties ?? []) props[p.name] = p.value.value;
      const role = String(ax.role?.value ?? "");
      if (!map.has(ax.backendDOMNodeId) || map.get(ax.backendDOMNodeId)!.hidden) {
        map.set(ax.backendDOMNodeId, {
          role: role === "generic" || role === "none" || role === "presentation" || role === "LabelText" || role === "InlineTextBox" || role === "StaticText" ? "" : role,
          name: String(ax.name?.value ?? ""),
          value: ax.value?.value !== undefined ? String(ax.value.value) : undefined,
          props,
        });
      }
    }
  }
  return map;
}

/**
 * Convert one DOMSnapshot document (and recursively its same-process child
 * documents) into SnapNodes under `mountParent`.
 */
function buildDocument(
  dom: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  docIndex: number,
  frame: FrameSession,
  ax: Map<number, AXInfo>,
  mountParent: SnapNode,
  offset: { x: number; y: number },
  out: SnapNode[],
  oopifMounts: Map<string, SnapNode>,
  nthCounter: Map<string, number>,
  metrics: { viewport: Rect; scroll: { x: number; y: number }; scale: number },
): void {
  const doc = dom.documents[docIndex];
  if (!doc) return;
  const S = dom.strings;
  const str = (i: number | undefined): string => (i === undefined || i < 0 ? "" : S[i] ?? "");
  const N = doc.nodes;
  const L = doc.layout;
  const count = N.parentIndex?.length ?? 0;

  // layout lookup: nodeIndex -> layout index
  const layoutOf = new Map<number, number>();
  L.nodeIndex.forEach((ni, li) => layoutOf.set(ni, li));
  // Nodes come in document order (parents before children), so one reverse pass
  // tells which box-less elements still have rendered descendants (display: contents).
  const laidOutBelow = new Uint8Array(count);
  for (let i = count - 1; i > 0; i--) {
    const p = N.parentIndex![i]!;
    if (p >= 0 && (laidOutBelow[i] || layoutOf.has(i))) laidOutBelow[p] = 1;
  }
  const styleIdx = (li: number, name: (typeof COMPUTED_STYLES)[number]): string => {
    const k = COMPUTED_STYLES.indexOf(name);
    return str(L.styles[li]?.[k]);
  };

  const rare = (r: Protocol.DOMSnapshot.RareIntegerData | Protocol.DOMSnapshot.RareStringData | Protocol.DOMSnapshot.RareBooleanData | undefined, i: number): number | boolean | undefined => {
    if (!r) return undefined;
    const pos = r.index.indexOf(i);
    if (pos === -1) return undefined;
    if ("value" in r) return (r as Protocol.DOMSnapshot.RareIntegerData).value[pos];
    return true;
  };

  const docFrameId = str(doc.frameId as number) || frame.frameId;
  const built: Array<SnapNode | null> = new Array(count).fill(null);
  const hiddenSubtree: boolean[] = new Array(count).fill(false);

  for (let i = 0; i < count; i++) {
    const parentIdx = N.parentIndex![i]!;
    const nodeType = N.nodeType![i]!;
    const tag = str(N.nodeName![i]).toLowerCase();
    const parent = parentIdx >= 0 ? built[parentIdx] : null;
    if (parentIdx >= 0 && (parent === null || hiddenSubtree[parentIdx])) {
      hiddenSubtree[i] = true;
      continue;
    }
    if (nodeType === 1 && SKIP_SUBTREE_TAGS.has(tag)) {
      hiddenSubtree[i] = true;
      continue;
    }
    if (nodeType === 8) continue; // comments

    const backendNodeId = N.backendNodeId![i]!;
    const node: SnapNode = {
      backendNodeId,
      frame,
      frameId: docFrameId,
      parent: parent ?? mountParent,
      children: [],
      depth: (parent ?? mountParent).depth + 1,
      nodeType,
      tag: nodeType === 3 ? "#text" : nodeType === 9 ? "#document" : nodeType === 11 ? "#shadow-root" : tag,
      attrs: {},
      role: "",
      name: "",
      visible: true,
      interactive: false,
      scrollable: false,
      isIframe: false,
      nth: 0,
      identity: "",
      groupSize: 1,
    };

    if (nodeType === 3) {
      const t = str(N.nodeValue![i]).replace(/\s+/g, " ").trim();
      if (!t) continue;
      node.text = t;
      if (parent?.shadowRoot) node.shadowRoot = parent.shadowRoot;
      // Text visibility follows its parent's layout; parent with no layout => skip.
      const li = layoutOf.get(i);
      if (li !== undefined) {
        const b = L.bounds[li]!;
        node.rect = { x: b[0]! * metrics.scale + offset.x, y: b[1]! * metrics.scale + offset.y, width: b[2]! * metrics.scale, height: b[3]! * metrics.scale };
      } else if (parent && !parent.rect && !KEEP_CHILDREN_WITHOUT_LAYOUT.has(parent.tag)) {
        continue;
      }
      (parent ?? mountParent).children.push(node);
      out.push(node);
      built[i] = node;
      continue;
    }

    if (nodeType === 1) {
      const attrIdx = N.attributes?.[i] ?? [];
      for (let a = 0; a + 1 < attrIdx.length; a += 2) {
        node.attrs[str(attrIdx[a])] = str(attrIdx[a + 1]);
      }
      const li = layoutOf.get(i);
      if (li !== undefined) {
        const b = L.bounds[li]!;
        node.rect = { x: b[0]! * metrics.scale + offset.x, y: b[1]! * metrics.scale + offset.y, width: b[2]! * metrics.scale, height: b[3]! * metrics.scale };
        node.paintOrder = L.paintOrders?.[li];
        const display = styleIdx(li, "display");
        const visibility = styleIdx(li, "visibility");
        const opacity = parseFloat(styleIdx(li, "opacity") || "1");
        if (display === "none" || visibility === "hidden" || visibility === "collapse") node.visible = false;
        // A block-level box (capture metadata): with the box's position, where one element's text is stacked in parts.
        if (/^(block|flex|grid|list-item|table|flow-root)/.test(display ?? "")) node.attrs["__block"] = "1";
        if (opacity === 0) {
          node.visible = false;
          hiddenSubtree[i] = true; // opacity hides descendants too
        }
        if (styleIdx(li, "cursor") === "pointer") node.attrs["__cursor"] = "pointer";
        if (styleIdx(li, "pointer-events") === "none") node.attrs["__pe"] = "none";
        const ox = styleIdx(li, "overflow-x");
        const oy = styleIdx(li, "overflow-y");
        // A clipping box hides what overflows it (a collapsed accordion: height 0, overflow hidden).
        if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip") node.attrs["__clip"] = "1";
        const scrollRect = L.scrollRects?.[li];
        const clientRect = L.clientRects?.[li];
        if (scrollRect && clientRect && (ox === "auto" || ox === "scroll" || oy === "auto" || oy === "scroll")) {
          if (scrollRect[3]! > clientRect[3]! + 1 || scrollRect[2]! > clientRect[2]! + 1) node.scrollable = true;
        }
      } else if (KEEP_CHILDREN_WITHOUT_LAYOUT.has(tag) || (parent && KEEP_CHILDREN_WITHOUT_LAYOUT.has(parent.tag))) {
        // <option> and friends have no layout boxes but carry the labels we show on the <select>.
        node.visible = parent?.visible ?? true;
      } else if (laidOutBelow[i]) {
        // display: contents (common in React/Web Component wrappers): no box, but its children render.
        node.visible = false;
        node.boxless = true;
      } else {
        // No layout box: display:none or not rendered. Hide subtree.
        node.visible = false;
        hiddenSubtree[i] = true;
      }
      if (node.rect && (node.rect.width === 0 || node.rect.height === 0) && !["input", "select", "textarea", "button", "a"].includes(tag)) {
        // zero-size containers can still have visible overflowing children; keep but not interactive
        node.visible = node.visible && false;
      }

      const axi = ax.get(backendNodeId);
      node.role = axi?.role || tagRole(tag, node.attrs);
      node.name = axi?.name ?? "";
      // Hidden by the page: Chromium says so, or leaves the element out of its tree (it lists few of the elements it
      // hides: under a modal dialog only <html>) while the element is aria-hidden or inert itself or its parent is
      // hidden. An element Chromium lists as not ignored (the open dialog and what is in it) is not hidden.
      const hiddenByPage = axi ? !!axi.hidden : node.attrs["aria-hidden"] === "true" || node.attrs["inert"] !== undefined || !!parent?.axHidden;
      if (!axi) node.axUnlisted = true;
      if (hiddenByPage) node.axHidden = true;
      if (hiddenByPage || !axi) {
        // Chromium gives a hidden or unlisted element no states: its own aria-* attributes say them (native ones are read below).
        const a = node.attrs;
        if (a["aria-expanded"] !== undefined) node.expanded = a["aria-expanded"] === "true";
        if (a["aria-selected"] !== undefined) node.selected = a["aria-selected"] === "true";
        if (a["aria-checked"] !== undefined) node.checked = a["aria-checked"] === "true";
        if (a["aria-disabled"] === "true") node.disabled = true;
        if (a["aria-invalid"] !== undefined && a["aria-invalid"] !== "false") node.invalid = true;
      }
      if (axi?.props) {
        const p = axi.props;
        if (p.checked !== undefined) node.checked = p.checked === true || p.checked === "true";
        if (p.selected !== undefined) node.selected = p.selected === true;
        if (p.expanded !== undefined) node.expanded = p.expanded === true;
        if (p.disabled !== undefined) node.disabled = p.disabled === true;
        if (p.invalid !== undefined) node.invalid = p.invalid !== false && p.invalid !== "false";
        if (p.focused !== undefined) node.focused = p.focused === true;
        if (p.required !== undefined) node.required = p.required === true;
      }
      const inputValue = rare(N.inputValue, i);
      const type = (node.attrs["type"] ?? "").toLowerCase();
      if (typeof inputValue === "number" || typeof inputValue === "string") {
        // RareStringData value is an index into strings
        const v = typeof inputValue === "number" ? str(inputValue) : inputValue;
        node.value = type === "password" ? (v ? "•".repeat(Math.min(v.length, 8)) : "") : v;
      } else if (axi?.value !== undefined && (tag === "input" || tag === "textarea" || tag === "select") && type !== "password") {
        node.value = axi.value;
      }
      if (type === "checkbox" || type === "radio") node.value = undefined;
      if (rare(N.inputChecked, i) === true) node.checked = true;
      if (rare(N.optionSelected, i) === true) node.selected = true;
      // DOMSnapshot flattens shadow trees: every node *inside* a shadow tree
      // carries the type of its root. The serializer emits a |SHADOW| marker
      // where the type changes between parent and child.
      const shadow = rare(N.shadowRootType, i);
      if (typeof shadow === "number") {
        const st = str(shadow);
        if (st === "user-agent") {
          hiddenSubtree[i] = true; // internals of <input>, <video> etc.
          continue;
        }
        if (st === "open" || st === "closed") node.shadowRoot = st;
      }
      if (node.attrs["disabled"] !== undefined) node.disabled = true;
      if (tag === "iframe" || tag === "frame") node.isIframe = true;

      const clickable = rare(N.isClickable, i) === true;
      node.inInteractive = !!(parent && (parent.interactive || parent.inInteractive));
      const isDocumentShell = tag === "html" || tag === "body" || tag === "head";
      const nativelyInteractive = isNativeControl(node);
      const tabindex = node.attrs["tabindex"] === undefined ? NaN : parseInt(node.attrs["tabindex"], 10);
      // Delegated click handlers (flatpickr's day grid, jQuery's `.on("click", ".day", …)`) listen on a
      // container, so Chrome reports only the container as clickable and its cells would fold into its
      // ref. Inside a listener-only container (not a link, button or other control, not an editor), a
      // cell that marks itself as a target keeps a ref of its own: it has its own listener, sets
      // `cursor: pointer` itself rather than inheriting it, or is focusable (`tabindex` >= 0, or -1 with
      // its own aria-label: the roving-focus pattern). Spans inside a link or button still fold.
      const host = node.inInteractive ? interactiveAncestor(parent) : null;
      const delegatedTarget =
        !!host &&
        !isNativeControl(host) &&
        host.attrs["contenteditable"] === undefined &&
        !nativelyInteractive &&
        (clickable ||
          (node.attrs["__cursor"] === "pointer" && inheritedCursor(parent) !== "pointer") ||
          tabindex >= 0 ||
          (tabindex === -1 && !!node.attrs["aria-label"] && node.role === ""));
      node.interactive =
        node.visible &&
        !node.attrs["__pe"] &&
        (clickable ||
          nativelyInteractive ||
          node.attrs["contenteditable"] === "true" ||
          // Something the page lets you drag (cards, list items) must be a drag target by ref.
          node.attrs["draggable"] === "true" ||
          node.attrs["contenteditable"] === "" ||
          tabindex >= 0 ||
          (node.attrs["__cursor"] === "pointer" && !(parent?.interactive ?? false)) ||
          delegatedTarget);
      // A click listener on <html>/<body> (common: analytics, menus closing on
      // outside click) makes Chrome report them as clickable. They are never
      // meaningful targets, and as refs they swallow the whole page's text.
      if (isDocumentShell) node.interactive = false;
      // Frameworks delegate events to their root container (React's #root / #__next), so Chrome reports
      // the whole app wrapper as clickable. A listener-only target covering most of the viewport is never
      // meaningful, and as a ref it would fold every card inside it into one giant element.
      const vpArea = metrics.viewport.width * metrics.viewport.height;
      if (node.interactive && !nativelyInteractive && node.attrs["tabindex"] === undefined && node.rect && vpArea > 0 && node.rect.width * node.rect.height >= 0.6 * vpArea) {
        node.interactive = false;
      }
      // <label> forwards clicks to its control; index the control, not the label, unless the label is
      // explicitly interactive. But a label that sets its OWN pointer cursor is the visible control of
      // a custom toggle whose real <input> is hidden (opacity 0 / pointer-events none, so the input
      // gets no ref) — keep that label clickable so there is a target.
      const ownPointer = node.attrs["__cursor"] === "pointer" && inheritedCursor(parent) !== "pointer";
      if (tag === "label" && node.attrs["role"] === undefined && node.attrs["tabindex"] === undefined && node.attrs["onclick"] === undefined && !ownPointer) {
        node.interactive = false;
      }
      // Descendants of an interactive element (spans inside a link, icons inside a
      // button) inherit isClickable from Chrome but are not separate targets unless
      // they are natively interactive themselves or cells of a delegated handler
      // (above). Fold them into the parent.
      if (node.interactive && node.inInteractive && !nativelyInteractive && !delegatedTarget && node.attrs["contenteditable"] === undefined) {
        node.interactive = false;
      }
      // Never offer a CAPTCHA / bot-check widget's own controls (the "I'm not a robot" checkbox) as an
      // action target: pilotfish does not interact with bot checks — the person does, in the live view.
      // The widget runs in a provider iframe, so its controls carry that frame's URL.
      if (node.interactive && isCaptchaFrameUrl(node.frame?.url)) node.interactive = false;

      if (node.interactive || node.scrollable) {
        node.identity = identityOf(node);
        const k = `${docFrameId}|${node.tag}|${node.role}|${node.name.slice(0, 80)}|${node.identity}`;
        const n = nthCounter.get(k) ?? 0;
        node.nth = n;
        nthCounter.set(k, n + 1);
      }

      (parent ?? mountParent).children.push(node);
      out.push(node);
      built[i] = node;

      // Same-process child document
      const cdi = rare(N.contentDocumentIndex, i);
      if (typeof cdi === "number") {
        const childOffset = node.rect ? { x: node.rect.x, y: node.rect.y } : offset;
        buildDocument(dom, cdi, frame, ax, node, childOffset, out, oopifMounts, nthCounter, metrics);
      } else if (node.isIframe) {
        // Possibly an OOPIF: remember the mount point by the frame id Chrome assigns.
        // Chrome exposes the child frame id only via DOM.describeNode; we match lazily using the owner lookup done by the OOPIF capture (offsetInPage), so mount under root if unknown.
        // The DOMSnapshot node for an iframe has no frameId, so we record by backendNodeId and resolve in attachOOPIFMounts().
        oopifMounts.set(`owner:${frame.frameId}:${backendNodeId}`, node);
      }
      continue;
    }

    if (nodeType === 11) {
      // Shadow root: transparent container, children keep flowing.
      node.tag = "#shadow-root";
      node.visible = parent?.visible ?? true;
      if (parent?.axHidden) node.axHidden = true;
      (parent ?? mountParent).children.push(node);
      out.push(node);
      built[i] = node;
      continue;
    }

    if (nodeType === 9) {
      // Nested document node: attach children to mountParent directly.
      built[i] = mountParent;
      continue;
    }
  }

  // Letter-by-letter animated text (one text node or <span> per character, often repeated dozens of
  // times: Airbnb's "one price" popup) costs tokens and reads as "N o w y o u"; sites keep a readable
  // copy alongside it. Drop runs of 6+ single characters that spell something. Controls are kept
  // (calendar days 1-9, pager numbers, keypads, crossword cells): test the flags that later earn a ref,
  // since refs are not assigned yet. Runs without a letter are kept too: the days of a calendar whose
  // cells fold into its container's ref, or of a read-only month grid, are data.
  for (const n of out) {
    if (n.children.length < 6) continue;
    const char = (c: SnapNode) => (c.nodeType === 3 ? c.text : c.children[0]?.text);
    const letter = (c: SnapNode) =>
      !c.interactive && !c.scrollable && (c.nodeType === 3 ? c.text?.length === 1 : c.nodeType === 1 && c.children.length === 1 && c.children[0]!.text?.length === 1);
    let runStart = -1;
    const keep: SnapNode[] = [];
    for (let k = 0; k <= n.children.length; k++) {
      const c = n.children[k];
      if (c && letter(c)) {
        if (runStart < 0) runStart = k;
        continue;
      }
      if (runStart >= 0 && (k - runStart < 6 || !/\p{L}/u.test(n.children.slice(runStart, k).map(char).join("")))) keep.push(...n.children.slice(runStart, k));
      runStart = -1;
      if (c) keep.push(c);
    }
    if (keep.length !== n.children.length) n.children = keep;
  }

  // Collect select options: options are child <option> nodes.
  for (const n of out) {
    if (n.tag === "select" && n.frameId === docFrameId) {
      const opts: SnapNode["options"] = [];
      const walk = (c: SnapNode) => {
        for (const ch of c.children) {
          if (ch.tag === "option") opts.push({ value: ch.attrs["value"] ?? textOf(ch), label: textOf(ch) || ch.attrs["label"] || ch.attrs["value"] || "", selected: ch.selected === true });
          else walk(ch);
        }
      };
      walk(n);
      n.options = opts;
    }
  }
}

/** A control by tag or role (a link, button, input, option...), as opposed to an element that only has a listener. */
function isNativeControl(n: SnapNode): boolean {
  return INTERACTIVE_ROLES.has(n.role) || (NATIVE_INTERACTIVE_TAGS.has(n.tag) && !(n.tag === "a" && n.attrs["href"] === undefined));
}

/** The nearest interactive ancestor: the element a non-target descendant folds into. */
function interactiveAncestor(n: SnapNode | null | undefined): SnapNode | null {
  while (n && !n.interactive) n = n.parent;
  return n ?? null;
}

/** The cursor an element inherits: its nearest ancestor with a layout box (boxless wrappers and shadow roots carry no styles). */
function inheritedCursor(n: SnapNode | null | undefined): string | undefined {
  while (n && !n.rect && n.parent) n = n.parent;
  return n?.attrs["__cursor"];
}

export function textOf(n: SnapNode, max = 200): string {
  const parts: string[] = [];
  const walk = (c: SnapNode) => {
    if (c.text) parts.push(c.text);
    for (const ch of c.children) {
      if (parts.join(" ").length > max) return;
      walk(ch);
    }
  };
  walk(n);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Roles whose accessible name comes from their content (WAI-ARIA "name from: contents"). */
const NAME_FROM_CONTENT = new Set([
  "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "row", "rowheader", "switch", "tab", "tooltip", "treeitem",
]);

/**
 * Role and name for elements the page hides from assistive tech (`axHidden`), which Chromium leaves unnamed. The same
 * element (same frame and backend node) in `previous` gives them back, Chromium's own, when what names it is unchanged
 * (its naming attributes, its labels' text and its own text); otherwise they are derived from the DOM in the order an
 * accessible name is: aria-labelledby, aria-label, a <label>, alt or a button's value, the content for roles named by
 * it, title, placeholder. aria-label comes before the content, so two elements told apart only by their aria-label stay
 * apart. An element Chromium did not list at all (`axUnlisted`) is matched the same way: `previous` holds every element
 * node of the last capture, listed or not, keyed by frame and backendNodeId, under the same unchanged-inputs guard. An
 * interactive or scrollable one (Chromium lists every such element it does not hide, so being unlisted means hidden, or
 * read before the tree caught up) falls back to the DOM-derived name as a hidden one does; any other unlisted element
 * (a container Chromium finds uninteresting) only takes an earlier non-empty name and is otherwise left as read. An
 * empty name from a capture that had none to give is never carried forward: it falls through to a fresh DOM-derived
 * name. Naming only: visibility and interactivity are never touched. Returns whether any name or role changed.
 */
export function restoreHiddenNames(nodes: SnapNode[], previous: Snapshot | null): boolean {
  /** Named as a hidden element is: hidden by the page, or unlisted while interactive or scrollable. */
  const unnamedByChromium = (n: SnapNode) => !!n.axHidden || (!!n.axUnlisted && (n.interactive || n.scrollable));
  if (!nodes.some((n) => unnamedByChromium(n) || (previous && n.axUnlisted))) return false;
  // Ids and <label for> of one snapshot: a node is named from its own snapshot's page.
  const indexOf = (all: SnapNode[]) => {
    const byId = new Map<string, SnapNode>();
    const labelFor = new Map<string, SnapNode[]>();
    for (const n of all) {
      if (n.nodeType !== 1) continue;
      const id = n.attrs["id"];
      if (id && !byId.has(`${n.frameId}\n${id}`)) byId.set(`${n.frameId}\n${id}`, n);
      const f = n.tag === "label" ? n.attrs["for"] : undefined;
      if (f) labelFor.set(`${n.frameId}\n${f}`, [...(labelFor.get(`${n.frameId}\n${f}`) ?? []), n]);
    }
    return { byId, labelFor };
  };
  const here = indexOf(nodes);
  let there: ReturnType<typeof indexOf> | null = null;
  // The text a name is made of: what is laid out and visible (no display:none, opacity:0 or [hidden] content, which is
  // in no page text either). aria-labelledby is the exception, as in the accessible-name rules: it names by the
  // referenced element's text whether or not that element is shown.
  const txt = (n: SnapNode | undefined) => {
    if (!n) return "";
    const parts: string[] = [];
    const walk = (c: SnapNode) => {
      if (c.text) parts.push(c.text);
      for (const ch of c.children) if (ch.nodeType !== 1 || ch.visible || ch.boxless) walk(ch);
    };
    walk(n);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
  };
  const domName = (n: SnapNode, { byId, labelFor } = here): string => {
    const a = n.attrs;
    const by = (a["aria-labelledby"] ?? "").split(/\s+/).filter(Boolean).map((id) => { const r = byId.get(`${n.frameId}\n${id}`); return r ? textOf(r, 200) : ""; }).filter(Boolean).join(" ");
    if (by) return by;
    if (a["aria-label"]?.trim()) return a["aria-label"].trim();
    if (["input", "select", "textarea"].includes(n.tag)) {
      const type = (a["type"] ?? "").toLowerCase();
      if (type === "image" && a["alt"]) return a["alt"];
      if (["button", "submit", "reset"].includes(type) && a["value"]) return a["value"];
      const labels = [...(a["id"] ? labelFor.get(`${n.frameId}\n${a["id"]}`) ?? [] : [])];
      for (let p = n.parent; p; p = p.parent) if (p.tag === "label") labels.push(p);
      const l = labels.map((x) => txt(x)).filter(Boolean).join(" ");
      if (l) return l;
    }
    if (n.tag === "img" && a["alt"] !== undefined) return a["alt"];
    if (NAME_FROM_CONTENT.has(n.role)) {
      const t = txt(n);
      if (t) return t;
    }
    return a["title"]?.trim() || a["placeholder"]?.trim() || "";
  };
  // What names an element, read from the DOM: unchanged means Chromium would name it as it did.
  const inputs = (n: SnapNode, ix = here) => `${n.tag}|${n.attrs["role"] ?? ""}|${domName(n, ix)}|${txt(n)}|${n.attrs["title"] ?? ""}|${n.attrs["placeholder"] ?? ""}`;
  const before = new Map<string, SnapNode>();
  for (const p of previous?.nodes ?? []) if (p.nodeType === 1) before.set(`${p.frameId}:${p.backendNodeId}`, p);
  let changed = false;
  for (const n of nodes) {
    if (!n.axHidden && !n.axUnlisted) continue;
    const p = before.get(`${n.frameId}:${n.backendNodeId}`);
    // The earlier name is taken only when it was Chromium's own (the node was listed then) or one restored for it, never
    // an empty one from a capture that had none to give: an empty name must not be carried forward.
    const candidate = !!p && p.tag === n.tag && !(p.name === "" && (p.axUnlisted || p.axHidden));
    // Unlisted plain containers (not interactive or scrollable; most are ones Chromium finds uninteresting): only a
    // named earlier node is worth comparing, and with nothing earlier to go by it stays as Chromium gave it (no name).
    const derive = unnamedByChromium(n);
    if (!derive && !(candidate && p!.name !== "")) continue;
    const usable = candidate && inputs(p!, (there ??= indexOf(previous!.nodes))) === inputs(n);
    if (!usable && !derive) continue;
    const [role, name] = usable ? [p!.role, p!.name] : [n.role, domName(n)];
    if (role !== n.role || name !== n.name) changed = true;
    n.role = role;
    n.name = name;
  }
  return changed;
}

function tagRole(tag: string, attrs: Record<string, string>): string {
  if (attrs["role"]) return attrs["role"];
  switch (tag) {
    case "a":
      return attrs["href"] !== undefined ? "link" : "";
    case "button":
      return "button";
    case "input": {
      const t = (attrs["type"] ?? "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "file") return "button";
      return "textbox";
    }
    case "select":
      return attrs["multiple"] !== undefined ? "listbox" : "combobox";
    case "textarea":
      return "textbox";
    case "img":
      return "img";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "form":
      return "form";
    case "table":
      return "table";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "summary":
      return "button";
    case "option":
      return "option";
    case "dialog":
      return "dialog";
    default:
      return "";
  }
}
