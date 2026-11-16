// Page snapshot: DOMSnapshot.captureSnapshot (structure, layout, styles, form
// state, paint order) joined with Accessibility.getFullAXTree (roles, names,
// states) on backendNodeId, across the main frame, same-process iframes
// (DOMSnapshot `contentDocumentIndex`) and out-of-process iframes (child CDP
// sessions). Produces a flat list of `SnapNode`s in document order with page
// coordinates, interactivity and visibility, from which the serializer builds
// the model-facing text and the handle table.

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
  attrs: Record<string, string>;
  /** AX role (e.g. "button") or tag-derived fallback. */
  role: string;
  /** AX accessible name. */
  name: string;
  /** Current value for inputs/selects/textareas (never for password fields). */
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  required?: boolean;
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
}

/** Capture a snapshot of the page across all frames. */
export async function captureSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
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
      if (ax.ignored || ax.backendDOMNodeId === undefined) continue;
      const props: Record<string, unknown> = {};
      for (const p of ax.properties ?? []) props[p.name] = p.value.value;
      const role = String(ax.role?.value ?? "");
      if (!map.has(ax.backendDOMNodeId)) {
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
      if (axi?.props) {
        const p = axi.props;
        if (p.checked !== undefined) node.checked = p.checked === true || p.checked === "true";
        if (p.selected !== undefined) node.selected = p.selected === true;
        if (p.expanded !== undefined) node.expanded = p.expanded === true;
        if (p.disabled !== undefined) node.disabled = p.disabled === true;
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
