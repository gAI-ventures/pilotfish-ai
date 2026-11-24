// Model-facing serialization of a Snapshot. One line per element, indented by
// depth, in an HTML-like grammar extended with AX roles and state:
//
//   *[e12]<button aria-label="Close dialog">×</button>
//   [e13]<input type="text" placeholder="Email" value="" />
//   <h1>Dashboard</h1>
//   |SCROLL|[e20]<div role="list" />
//   |IFRAME src="https://pay.example" |
//
// `*` marks elements that did not exist in the previous snapshot. Only
// interactive and scrollable elements carry refs; everything else is context
// text, collapsed and capped so a typical page lands in the 2–8K token range.

import { inBand, nodeKey, textOf, type SnapNode, type Snapshot, pageAttrs } from "./snapshot.js";

export interface SerializeOptions {
  /** Hard cap on output characters. Default 24_000 (~6K tokens). */
  maxChars?: number;
  /** Cap per text run. Default 160. */
  maxTextChars?: number;
  /** Include non-interactive context text. Default true. */
  includeText?: boolean;
  /** Only elements with refs (plus headings). Default false. */
  interactiveOnly?: boolean;
  /** Mark elements absent from `previous`. */
  previous?: Snapshot | null;
  /** Restrict to a subtree (ref). */
  rootRef?: string;
  /**
   * Print only what lies within this many viewport-heights of the viewport (0: the visible screen), narrower than the
   * band the snapshot was captured with; what is left out is counted above and below. Default: the capture's band.
   * Refs of elements left out still resolve: only the printout is narrower.
   */
  band?: number;
  /** What the truncation footer tells the reader to use for the rest. Default: find() or read_page(rootRef). */
  moreHint?: string;
  /**
   * The same elements and words in lighter markup: a link's target as its path ("?…" for a long query, as page text
   * shows it), and no attribute that only points at another element (aria-controls) or is a generated id
   * (":r2l:", "_R_nd_", "Oacf4b"). Nothing a reader acts on or quotes is left out.
   */
  compactAttrs?: boolean;
  /**
   * The same elements and words, each said once: no closing tags (one element per line, so `</div>` says nothing),
   * an element's text not printed again on its child lines when its own line already says all of it, and no `*`
   * when every element printed is new (a page just loaded). Measured on a set of recorded pages: 11-20% fewer
   * tokens, no word or ref lost.
   */
  compactMarkup?: boolean;
  /**
   * Shorter markup for the same facts (17 Nov, the open MCP): an element of a generic tag whose page role says what it
   * is prints as that role marked `@` (`<div role="button">` as `<@button>`, never as a native `<button>`), a page role
   * its tag already has is not repeated (`<a role="link">` as `<a>`), and aria-haspopup prints as `haspopup` ("true")
   * or `haspopup=<value>`. Refs, names, values, states, attributes and order are unchanged. On the saved MCP replies
   * of 17 Nov (a character simulation): 10-15% fewer characters on Google Flights, under 1% on Amazon and Booking.
   */
  roleTags?: boolean;
  /**
   * The screen across as well as down (18 Nov, the open MCP): an element wholly past the viewport's left or right edge,
   * or wholly outside the box of an area that scrolls (a sideways calendar or carousel: Google Flights' date picker
   * printed about 330 day buttons for the two months on screen), is left out and counted in one note; and a frame with
   * no box and nothing drawn inside it (a tracker's cookie-sync or pixel frame) prints nothing. Refs of what is left
   * out still resolve (browser_find finds them), as with `band`.
   */
  screenOnly?: boolean;
  /**
   * Under a list of suggestions (a listbox) in which two or more options share a name (their first line as printed,
   * before " · ", without case or punctuation), one line naming them and which of them a task means (19 Nov, the open
   * MCP): Booking lists "North Goa · India" (the region) over "North goa · Goa (North Goa), India" (a town of eight
   * stays), and a note after the pick was not acted on. Said while the choice is still open; nothing for other lists.
   */
  sameNames?: boolean;
}

/** A generated id (framework counters and hashes), not a name a person gave the element. */
function generatedId(v: string): boolean {
  return /[:]|^_|_$|\d{3,}|^[a-z]{0,3}\d+$/i.test(v) || (v.length >= 5 && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && !/[-_]/.test(v));
}


const LANDMARK_ROLES = new Set(["navigation", "main", "form", "dialog", "table", "list", "banner", "contentinfo", "complementary", "region", "alert", "alertdialog", "menu", "tablist", "listbox", "tree", "grid"]);
const CELL_TAGS = new Set(["td", "th"]);
const CELL_ROLES = new Set(["cell", "gridcell"]);
const FORM_CONTROL_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "listbox"]);
const KEEP_ATTRS = ["type", "name", "placeholder", "href", "aria-label", "title", "alt", "role", "for", "aria-haspopup", "aria-controls", "data-testid", "id"];
const STATE_ATTRS: Array<[keyof SnapNode, string]> = [
  ["checked", "checked"],
  ["selected", "selected"],
  ["expanded", "expanded"],
  ["disabled", "disabled"],
  ["focused", "focused"],
  ["required", "required"],
];

export function serializeSnapshot(snap: Snapshot, opts: SerializeOptions = {}): string {
  const maxChars = opts.maxChars ?? 24_000;
  // The printed range: the capture's band, or a narrower one around the viewport.
  const narrower = opts.band !== undefined && Number.isFinite(opts.band) && opts.band >= 0;
  const range = narrower ? { top: snap.scroll.y - opts.band! * snap.viewport.height, bottom: snap.scroll.y + (1 + opts.band!) * snap.viewport.height } : snap.band;
  const screenOnly = !!opts.screenOnly;
  /** Wholly past the viewport's left or right edge, or wholly outside the box of a sideways area it is in (screenOnly). */
  const offSide = (n: SnapNode): boolean => {
    const r = n.rect;
    if (!screenOnly || !r || r.width <= 0) return false;
    if (r.x + r.width <= 0 || r.x >= snap.viewport.width) return true;
    for (let a = n.parent; a; a = a.parent) {
      const b = a.rect;
      if (a.scrollsX && b && b.width > 0 && (r.x + r.width <= b.x || r.x >= b.x + b.width)) return true;
    }
    return false;
  };
  const inRange = (n: SnapNode): boolean => {
    if (!narrower) return inBand(snap, n);
    if (!n.rect) return true;
    const top = n.rect.y + snap.scroll.y;
    return top + n.rect.height >= range.top && top <= range.bottom;
  };
  const shown = (n: SnapNode): boolean => inRange(n) && !offSide(n);
  /** Elements with refs are filtered by what is shown (a narrower band, or screenOnly), not only by the capture's band. */
  const filtering = narrower || screenOnly;
  const shownRefBelow = (n: SnapNode): boolean => n.children.some((c) => (c.ref !== undefined && shown(c)) || shownRefBelow(c));
  // Elements with refs in the capture but outside the printed range, counted with the capture's own.
  const offscreen = { ...snap.offscreen };
  let offscreenSide = 0;
  if (filtering) {
    for (const n of snap.byRef.values()) {
      if (!n.rect || shown(n)) continue;
      if (!inRange(n)) {
        if (n.rect.y + snap.scroll.y >= range.bottom) offscreen.below++;
        else offscreen.above++;
      } else offscreenSide++;
    }
  }
  const maxText = opts.maxTextChars ?? 160;
  const prevKeys = opts.previous?.keys ?? null;
  const compact = !!opts.compactMarkup;
  const close = (tag: string) => (compact ? "" : `</${tag}>`);
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  let refLines = 0;
  let newRefLines = 0;
  /** Indexes in `lines` of table rows printed on one line (rowLine). */
  const rowLines: number[] = [];

  const root = opts.rootRef ? snap.byRef.get(opts.rootRef) : snap.root;
  if (!root) return `(no element ${opts.rootRef})`;
  const secondary = duplicateLinks(snap, maxText);

  const push = (line: string) => {
    if (truncated) return;
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };

  // Indentation is relative to the nearest *printed* ancestor, not raw DOM depth,
  // so wrapper divs that print nothing don't push content to the right.
  // `skipText`: an ancestor's line already printed this text (compactMarkup: down to the next element with a ref,
  // whose text an ancestor's inline text never includes).
  const walk = (n: SnapNode, level: number, { skipText = false } = {}) => {
    if (truncated) return;
    let shadowMarked = false;
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i]!;
      let lvl = level;
      if (c.shadowRoot && c.shadowRoot !== n.shadowRoot) {
        if (!shadowMarked) {
          push(`${indent(level)}|SHADOW(${c.shadowRoot})|`);
          shadowMarked = true;
        }
        lvl = level + 1;
      }
      if (c.text !== undefined) {
        if (skipText || opts.includeText === false || opts.interactiveOnly) continue;
        if (!c.visible && c.parent && !c.parent.visible) continue;
        if (!shown(c)) continue;
        // Gather consecutive text siblings.
        let t = c.text;
        while (i + 1 < n.children.length && n.children[i + 1]!.text !== undefined) {
          i++;
          t += " " + n.children[i]!.text;
        }
        // Punctuation-only separators ("|", "•", "(") carry no information for the model.
        if (!/[\p{L}\p{N}]/u.test(t)) continue;
        push(indent(lvl) + clip(t, maxText));
        continue;
      }
      renderElement(c, lvl, compact && skipText);
    }
  };

  /** `said`: an ancestor's line printed this element's text (compactMarkup); elements with refs print their own. */
  const renderElement = (n: SnapNode, level: number, said = false) => {
    if (truncated) return;
    if (n.boxless) return walk(n, level, { skipText: said });
    // A zero-size box can still hold visible content (a body whose children are all absolutely or
    // fixed positioned): pass through it like a boxless wrapper, unless it clips them (a collapsed
    // accordion: height 0, overflow hidden).
    if (!n.visible && !n.isIframe) return !n.attrs["__clip"] && hasVisibleDescendant(n) ? walk(n, level, { skipText: said }) : undefined;
    if (n.rect && !shown(n) && !(filtering ? shownRefBelow(n) : hasInteractiveDescendant(n))) return;
    const ind = indent(level);
    // A frame with no box and nothing drawn inside it (a tracker's cookie sync or pixel) shows nothing.
    if (n.isIframe && screenOnly && !n.visible && !hasVisibleDescendant(n)) return;
    if (n.isIframe) {
      const src = n.attrs["src"] ? ` src="${clip(n.attrs["src"], 80)}"` : "";
      push(`${ind}|IFRAME${src}|`);
      walk(n, level + 1);
      return;
    }
    if (n.tag === "canvas") {
      // A drawn surface: nothing inside it is in this tree. Its size says how much of the page it is.
      const r = n.rect;
      if (r && r.width >= 40 && r.height >= 30) push(`${ind}${n.ref ? `[${n.ref}]` : ""}<canvas ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)} />`);
      return;
    }
    if (n.ref && wrapsOneControl(n)) {
      // The control inside carries the ref and the line; this wrapper adds nothing to click.
      walk(n, level);
      return;
    }
    if (n.ref && secondary.has(n)) {
      // Another link in this card goes to the same place and carries the ref; keep only the text.
      const inner = inlineText(n, maxText);
      if (inner && /[\p{L}\p{N}]/u.test(inner)) push(ind + inner);
      if (hasInteractiveDescendant(n)) walk(n, level + 1, { skipText: true });
      return;
    }
    if (n.ref && filtering && !shown(n)) {
      // Left out of the printout (counted above, below or to the side); a part of it in range still prints.
      walk(n, level);
      return;
    }
    if (n.ref) {
      const star = prevKeys && !prevKeys.has(nodeKey(n)) ? "*" : "";
      const scroll = n.scrollable ? "|SCROLL|" : "";
      const own = n.tag === "select" ? { text: "", clipped: false } : inlineInfo(n, maxText);
      const inner = own.text;
      const attrs = attrString(n, inner, opts.compactAttrs ? snap.url : undefined, opts.roleTags);
      const tag = printedTag(n, opts.roleTags);
      let line = `${ind}${star}${scroll}[${n.ref}]<${tag}${attrs}`;
      if (n.tag === "select" && n.options) {
        const shown = n.options.slice(0, 8).map((o) => `${o.selected ? "*" : ""}${clip(o.label, 30)}`);
        const more = n.options.length > 8 ? ` …+${n.options.length - 8}` : "";
        line += ` options=[${shown.join(" | ")}${more}]`;
      }
      line += inner ? `>${inner}${close(tag)}` : compact ? ">" : " />";
      const before = lines.length;
      push(line);
      if (lines.length > before) {
        refLines++;
        if (star) newRefLines++;
      }
      // Its line says all of its text (not cut short): the lines under it show only what it does not say.
      if (hasInteractiveDescendant(n) || n.scrollable) walk(n, level + 1, { skipText: compact && !!inner && !own.clipped });
      if (opts.sameNames && n.role === "listbox") {
        const note = sameNamesNote(n);
        if (note) push(indent(level + 1) + note);
      }
      return;
    }
    if (opts.interactiveOnly && n.role !== "heading") {
      walk(n, level, { skipText: said });
      return;
    }
    const row = rowLine(n);
    if (row !== null) {
      if (row) {
        push(ind + row);
        rowLines.push(lines.length - 1);
      }
      return;
    }
    if (n.role === "heading" || n.tag === "label" || n.tag === "th" || n.tag === "legend" || n.tag === "dt") {
      const inner = inlineText(n, maxText);
      if (inner) push(`${ind}<${n.tag}>${inner}${close(n.tag)}`);
      if (hasInteractiveDescendant(n)) walk(n, level + 1, { skipText: true });
      return;
    }
    if (n.tag === "img" && (n.attrs["alt"] || n.name)) {
      push(`${ind}<img alt="${clip(n.attrs["alt"] || n.name, 60)}"${compact ? ">" : " />"}`);
      return;
    }
    if (LANDMARK_ROLES.has(n.role) && (n.role !== "list" || n.children.length > 2)) {
      const label = n.name ? ` "${clip(n.name, 40)}"` : "";
      push(`${ind}<${n.role}${label}>`);
      walk(n, level + 1, { skipText: said });
      if (opts.sameNames && n.role === "listbox") {
        const note = sameNamesNote(n);
        if (note) push(indent(level + 1) + note);
      }
      return;
    }
    walk(n, level, { skipText: said });
  };

  /**
   * A table row on one line, its cells in order between " | " (a header row of th cells after "<th>"), so a value
   * stays with its row and column: printed a cell per line, the 9 Nov BBC table lost its rows, and a header whose
   * hidden text adds ", Last 6 games, Oldest first" read as three headings. Only a plain row: two or more cells, each
   * with at most one ref'd element that is not a form control and carries no state or label of its own (a calendar
   * day's "selected", "October 5, 2026"), no nested table, the row shown in full and under 600 characters. Anything
   * else, or a row out of the printed range, is printed as before (null). "" for a row with no text at all.
   */
  const rowLine = (n: SnapNode): string | null => {
    if ((n.tag !== "tr" && n.role !== "row") || n.ref || (n.rect && !shown(n))) return null;
    const cells: SnapNode[] = [];
    for (const c of n.children) {
      if (c.text !== undefined) {
        if (/[\p{L}\p{N}]/u.test(c.text)) return null;
        continue;
      }
      if (!(CELL_TAGS.has(c.tag) || CELL_ROLES.has(c.role) || c.role === "columnheader" || c.role === "rowheader")) return null;
      cells.push(c);
    }
    if (cells.length < 2) return null;
    const parts: string[] = [];
    let refs = 0;
    let fresh = 0;
    for (const cell of cells) {
      const inner: SnapNode[] = [];
      let nested = false;
      const visit = (x: SnapNode) => {
        for (const ch of x.children) {
          if (ch.text !== undefined) continue;
          if (ch.tag === "table" || ch.role === "table" || ch.role === "grid" || ch.isIframe || ch.scrollable) nested = true;
          if (ch.ref) inner.push(ch);
          visit(ch);
        }
      };
      visit(cell);
      const own = cell.ref ? [cell, ...inner] : inner;
      if (nested || own.length > 1) return null;
      const r = own[0];
      if (r) {
        if (FORM_CONTROL_ROLES.has(r.role) || r.tag === "input" || r.tag === "select" || r.tag === "textarea") return null;
        for (const [prop] of STATE_ATTRS) if (prop !== "focused" && (r[prop] === true || cell[prop] === true)) return null;
      }
      if (!cell.visible && !hasVisibleDescendant(cell)) {
        parts.push("");
        continue;
      }
      let text = inlineText(cell, maxText);
      if (r) {
        const rt = inlineText(r, maxText);
        if (unsaidName(r, rt)) return null;
        const star = prevKeys && !prevKeys.has(nodeKey(r)) ? "*" : "";
        refs++;
        if (star) fresh++;
        const mark = `${star}[${r.ref}]${rt}`;
        if (r === cell) text = mark;
        else {
          // The cell's words in page order, the ref'd element's where it stands ("1 [e43]Celtic", not "[e43]Celtic 1").
          const words: string[] = [];
          const order = (x: SnapNode) => {
            for (const ch of x.children) {
              if (ch === r) words.push(mark);
              else if (ch.text !== undefined) words.push(ch.text);
              else order(ch);
            }
          };
          order(cell);
          text = clip(words.join(" ").replace(/\s+/g, " ").trim(), maxText + mark.length);
        }
      }
      parts.push(text);
    }
    const line = parts.join(" | ");
    if (line.length > 600) return null;
    refLines += refs;
    newRefLines += fresh;
    if (!/[\p{L}\p{N}]/u.test(line)) return "";
    return cells.every((c) => c.tag === "th" || c.role === "columnheader") ? `<th>${line}` : line;
  };

  if (root === snap.root) walk(root, 0);
  else renderElement(root, 0);
  // A page just loaded: every element is new, and a mark on each says nothing.
  if (compact && refLines > 0 && newRefLines === refLines) {
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.replace(/^(\t*)\*(?=\||\[)/, "$1");
    // A row line carries its refs mid-line.
    for (const i of rowLines) lines[i] = lines[i]!.replace(/\*(?=\[[^\]\s]+\])/g, "");
  }

  const header: string[] = [];
  if (offscreen.above) header.push(`(${offscreen.above} interactive elements above the viewport; scroll up to reveal)`);
  const body = lines.join("\n");
  const footer: string[] = [];
  if (offscreen.below) footer.push(`(${offscreen.below} interactive elements below the viewport; scroll down to reveal)`);
  if (offscreenSide) footer.push(`(${offscreenSide} interactive elements off the screen to the side, in an area that scrolls sideways: use its own controls, such as Next, or find them)`);
  if (truncated) footer.push(`(output truncated at ${maxChars} chars; ${opts.moreHint ?? "use find() or read_page(rootRef) for more"})`);
  return [...header, body, ...footer].filter(Boolean).join("\n");
}

/**
 * Result cards repeat one link 3-5 times (image, title, rating count, price) with the same long href.
 * Among links with the same href close together in document order, the one with the most text keeps
 * its ref; the others are rendered as plain text. Clicking any of them goes to the same place.
 */
function duplicateLinks(snap: Snapshot, maxText: number): Set<SnapNode> {
  const out = new Set<SnapNode>();
  const links = snap.nodes.filter((n) => n.ref && n.tag === "a" && (n.attrs["href"] ?? "").length > 1 && !n.attrs["href"]!.startsWith("#") && !n.attrs["href"]!.startsWith("javascript:"));
  const WINDOW = 8;
  const done = new Set<number>();
  for (let i = 0; i < links.length; i++) {
    if (done.has(i)) continue;
    const page = (n: SnapNode) => n.attrs["href"]!.split("#")[0];
    const href = page(links[i]!);
    const group = [i];
    for (let j = i + 1; j < links.length && j <= group[group.length - 1]! + WINDOW; j++) {
      if (!done.has(j) && page(links[j]!) === href) group.push(j);
    }
    if (group.length < 2) continue;
    let best = group[0]!;
    let bestLen = -1;
    for (const k of group) {
      done.add(k);
      const len = inlineText(links[k]!, maxText).length;
      if (len > bestLen) {
        best = k;
        bestLen = len;
      }
    }
    for (const k of group) if (k !== best) out.add(links[k]!);
  }
  return out;
}

/**
 * An element with a ref whose only ref'd descendant is the same control: a calendar cell and the day
 * button inside it (Booking's date picker printed 61 cells twice, 263 refs against main's 68), an
 * option and its one link. Same accessible name, or the inner box covering most of the outer one.
 * A scroll container, a form control, or a state only the outer one carries keeps its line.
 * A table cell with no label of its own and no text outside its one control (a day cell around a
 * "5 October 2026" span that fills a third of it) is that control too, whatever their sizes.
 */
function wrapsOneControl(n: SnapNode): boolean {
  if (n.scrollable || n.isIframe || FORM_CONTROL_ROLES.has(n.role) || n.tag === "input" || n.tag === "select" || n.tag === "textarea") return false;
  for (const [prop] of STATE_ATTRS) if (prop !== "disabled" && prop !== "focused" && n[prop] === true) return false;
  let only: SnapNode | null = null;
  const stack = [...n.children];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.ref) {
      if (only) return false;
      only = c;
    }
    stack.push(...c.children);
  }
  if (!only) return false;
  if (n.name && only.name && n.name.trim() === only.name.trim()) return true;
  if ((CELL_TAGS.has(n.tag) || CELL_ROLES.has(n.role)) && only.visible && !n.attrs["aria-label"] && !hasOwnText(n)) return true;
  const a = n.rect;
  const b = only.rect;
  if (!a || !b || a.width * a.height <= 0) return false;
  return (b.width * b.height) / (a.width * a.height) >= 0.6;
}

/** Text (a letter or digit) outside the element's ref'd descendants: a price under a day number. */
function hasOwnText(n: SnapNode): boolean {
  for (const c of n.children) {
    if (c.ref) continue;
    if (c.text !== undefined ? /[\p{L}\p{N}]/u.test(c.text) : hasOwnText(c)) return true;
  }
  return false;
}

function hasVisibleDescendant(n: SnapNode): boolean {
  for (const c of n.children) {
    if (c.text === undefined && (c.visible || (!c.attrs["__clip"] && hasVisibleDescendant(c)))) return true;
  }
  return false;
}

function hasInteractiveDescendant(n: SnapNode): boolean {
  for (const c of n.children) {
    if (c.ref) return true;
    if (hasInteractiveDescendant(c)) return true;
  }
  return false;
}

function inlineText(n: SnapNode, max: number): string {
  return inlineInfo(n, max).text;
}

/**
 * Roles whose text is often drawn as stacked lines: an autocomplete suggestion's name on one line and more text under
 * it ("Springfield" over "Illinois, United States"). Printed run together, two such lines read as one phrase.
 */
const STACKED_ROLES = new Set(["option"]);
/**
 * Between two parts of one element's text that the page draws as separate lines: text in another block box than the
 * text before it, whose box starts at or below the bottom of that text's box. A layout fact only: it says where the
 * page breaks the line, not what either part means. Boxes side by side (flex items on one row) and inline markup
 * inside one box stay one phrase, and so does any part whose box has no position.
 */
const PART_SEP = "·";

/** An element's own text (`inlineText`) and whether the cap cut it short. */
function inlineInfo(n: SnapNode, max: number): { text: string; clipped: boolean } {
  // Text content excluding text that belongs to interactive descendants (they render themselves).
  const parts: string[] = [];
  // In a stacked role, text in another block box than the text before it is another part ("North Goa" · "India"),
  // never run into one phrase; inline markup inside one block (<b>North</b> Goa) stays one part.
  const stacked = STACKED_ROLES.has(n.role);
  const blockOf = (t: SnapNode) => {
    let p = t.parent;
    while (p && p !== n && !p.attrs["__block"]) p = p.parent;
    return p;
  };
  const startsBelow = (box: SnapNode | null, prev: SnapNode | null | undefined) =>
    !!box?.rect && !!prev?.rect && box.rect.y >= prev.rect.y + prev.rect.height - 1;
  let lastBlock: SnapNode | null | undefined;
  // Collection stops once the raw text passes the cap: what is left out may not be at the end of `t`
  // (whitespace collapses), so a stop counts as cut short whatever the final length.
  let stopped = false;
  const walk = (c: SnapNode) => {
    for (const ch of c.children) {
      if (ch.ref) continue;
      if (ch.text) {
        if (stacked && ch.text.trim()) {
          const block = blockOf(ch);
          if (parts.length && block !== lastBlock && startsBelow(block, lastBlock)) parts.push(PART_SEP);
          lastBlock = block;
        }
        parts.push(ch.text);
      } else walk(ch);
      if (parts.join(" ").length > max) {
        stopped = true;
        return;
      }
    }
  };
  walk(n);
  let t = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!t && n.name && !FORM_CONTROL_ROLES.has(n.role) && n.tag !== "input") t = n.name;
  return { text: clip(t, max), clipped: stopped || t.length > max };
}

/** Generic tags: the tag word says nothing a page role on it does not say better. */
const ROLE_TAGGED = new Set(["div", "span", "li", "ul", "ol", "section", "article", "p", "label", "i", "b", "em", "strong", "svg", "g", "nav", "header", "footer", "main", "aside", "figure"]);

/**
 * WAI-ARIA role names that say what an element is. Only these replace a generic tag: a custom or misspelled role, a
 * list of roles ("button link"), and presentation/none/generic (which say the element is nothing) keep
 * `<div role="…">` as before.
 */
const ARIA_ROLE_TAGS = new Set([
  "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "dialog", "document", "feed", "figure", "form", "grid", "gridcell",
  "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation", "note", "option", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider",
  "spinbutton", "status", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "timer", "toolbar",
  "tooltip", "tree", "treegrid", "treeitem",
]);

/**
 * The tag word printed for `n` (`roleTags`): a generic tag's page role, marked `@`, when it is one WAI-ARIA role name
 * (`<@button>`: an element the page made a button, without a native button's behaviour, focus, keys or form role),
 * else its own tag. A native tag whose role differs in meaning (`<input role="combobox">`, `<button role="tab">`) stays
 * native and keeps its role attribute.
 */
export function printedTag(n: SnapNode, roleTags?: boolean): string {
  const r = n.attrs["role"];
  return roleTags && r && ROLE_TAGGED.has(n.tag) && ARIA_ROLE_TAGS.has(r) ? `@${r}` : n.tag;
}

function attrString(n: SnapNode, inner: string, compactFor?: string, roleTags?: boolean): string {
  const out: string[] = [];
  // A name the text does not say (a form control's, "October 5, 2026" on a calendar cell reading
  // "5", "Close dialog" on "×") is printed once: under the attribute it came from, else as label=""
  // (aria-labelledby, <label for>).
  let name = unsaidName(n, inner);
  if (n.role && n.role !== tagDefaultRole(n.tag, n.attrs) && n.role !== n.attrs["role"]) out.push(`role="${n.role}"`);
  for (const k of KEEP_ATTRS) {
    const v = n.attrs[k];
    if (v === undefined || v === "") continue;
    // roleTags: a role printed as the tag word, or one the tag already has, is not repeated as an attribute.
    if (roleTags && k === "role" && (printedTag(n, true) !== n.tag || v === tagDefaultRole(n.tag, n.attrs))) continue;
    if (roleTags && k === "aria-haspopup") {
      out.push(v === "true" ? "haspopup" : `haspopup=${clip(v, 20)}`);
      continue;
    }
    if (k === "id" && v.length > 24) continue; // generated ids are noise
    if (compactFor !== undefined && (k === "aria-controls" || (k === "id" && generatedId(v)))) continue;
    if (k === "href" && (v.trim().startsWith("javascript:") || v === "#")) continue;
    if (compactFor !== undefined && k === "href") {
      out.push(`href="${shownHref(v, compactFor)}"`);
      continue;
    }
    if ((k === "aria-label" || k === "title" || k === "alt") && (v === inner || v === n.name)) {
      if (v !== name) continue;
      name = "";
    } else if (k === "aria-label" && n.name && v !== n.name) continue; // AX name already reflects it
    out.push(`${k}="${clip(v, k === "href" ? 80 : 60)}"`);
  }
  if (name) out.push(`label="${clip(name, 60)}"`);
  if (n.value !== undefined && !(n.tag === "select" && n.options?.length)) out.push(`value="${clip(n.value, 80)}"`);
  for (const [prop, label] of STATE_ATTRS) {
    if (n[prop] === true) out.push(label);
  }
  return out.length ? " " + out.join(" ") : "";
}

/**
 * The AX name when nothing else prints it, else "". Without text, an element's name is its text,
 * except a form control's (unless the placeholder says it). With text, only a label of the element's
 * own (aria-label, aria-labelledby, title, a form control's) that has a word the text lacks. Case,
 * spacing, punctuation and order are ignored, so aria-label="Pricing" on "Pricing plans" stays hidden.
 */
function unsaidName(n: SnapNode, inner: string): string {
  if (!n.name || n.name === inner) return "";
  if (!inner) return (FORM_CONTROL_ROLES.has(n.role) || n.tag === "input") && n.name !== n.attrs["placeholder"] ? n.name : "";
  // Without a label of its own the name is the content plus descendants' alt text and icon labels:
  // a news card's photo description, an avatar stack's user names.
  if (!n.attrs["aria-label"] && !n.attrs["aria-labelledby"] && !n.attrs["title"] && !FORM_CONTROL_ROLES.has(n.role)) return "";
  let said = words(clip(n.name, 60));
  if (n.name.replace(/\s+/g, " ").trim().length > 60) said = said.slice(0, -1); // the clip cut the last word
  let text = new Set(words(inner));
  if (said.every((w) => text.has(w))) return "";
  // Text of interactive descendants renders on their own lines but still counts as said.
  text = new Set(words(textOf(n, n.name.length + 200)));
  return said.some((w) => !text.has(w)) ? n.name : "";
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tagDefaultRole(tag: string, attrs: Record<string, string>): string {
  if (tag === "input") {
    const t = (attrs["type"] ?? "text").toLowerCase();
    return { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", number: "spinbutton", search: "searchbox", file: "button", email: "textbox", password: "textbox", tel: "textbox", url: "textbox", text: "textbox" }[t] ?? "textbox";
  }
  return { a: "link", button: "button", textarea: "textbox", select: attrs["multiple"] !== undefined ? "listbox" : "combobox", option: "option", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", img: "img", summary: "button", nav: "navigation", main: "main", form: "form", table: "table", ul: "list", ol: "list", li: "listitem", dialog: "dialog" }[tag] ?? "";
}

function indent(level: number): string {
  return level > 0 ? "\t".repeat(Math.min(level, 12)) : "";
}

const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const SELECTABLE = new Set(["option", "tab", "treeitem", "gridcell", "row"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
/** Facet-like targets whose disabled state says an option is unavailable (a greyed-out filter). */
const DISABLED_ROLES = new Set(["option", "link", "button", "tab", "menuitem", "treeitem"]);

/**
 * The state of the page's controls, one line each, for a reviewer that cannot see the page:
 * checked boxes and radios, selected options and tabs, pressed toggles, current-page markers and
 * field values. Applied filters and sorts usually live here, not in the page's text (a check that
 * read only the text kept reporting "no evidence the filter was applied").
 *
 * Disabled boxes and facets follow in a list of their own, capped at `maxDisabled`: a filter the site
 * greys out is why a constraint could not be applied (a check called "Shipping is greyed out"
 * unverified), and a page with 60+ unavailable facets must not push out a checked one.
 */
export function controlStates(snap: Snapshot, { maxLines = 60, maxDisabled = 15 } = {}): string[] {
  const out: string[] = [];
  const disabled: string[] = [];
  const seen = new Set<string>();
  const add = (line: string, list = out, max = maxLines) => {
    if (list.length < max && !seen.has(line)) {
      seen.add(line);
      list.push(line);
    }
  };
  const label = (n: SnapNode) => clip((n.name || n.attrs["aria-label"] || n.attrs["placeholder"] || n.attrs["name"] || n.attrs["id"] || "").replace(/\s+/g, " ").trim(), 80);
  for (const n of snap.nodes) {
    if (out.length >= maxLines && disabled.length >= maxDisabled) break;
    if (n.text !== undefined || n.nodeType !== 1) continue;
    const name = label(n);
    const checkable = CHECKABLE.has(n.role) || n.attrs["type"] === "checkbox" || n.attrs["type"] === "radio";
    const kind = n.role === "radio" || n.attrs["type"] === "radio" ? "radio" : "box";
    // A custom checkbox often hides its <input>: its state counts even when it is not rendered.
    if (n.checked && checkable) {
      add(`checked ${kind}: "${name}"${n.attrs["name"] ? ` (${n.attrs["name"]})` : ""}`);
      continue;
    }
    if (n.disabled && checkable) {
      if (name) add(`disabled ${kind}: "${name}"${n.attrs["name"] ? ` (${n.attrs["name"]})` : ""}`, disabled, maxDisabled);
      continue;
    }
    if (!n.visible) continue;
    if (n.disabled && DISABLED_ROLES.has(n.role) && name) add(`disabled ${n.role}: "${name}"`, disabled, maxDisabled);
    if (n.tag === "select" && n.options?.length) {
      const sel = n.options.filter((o) => o.selected).map((o) => clip(o.label, 60));
      if (sel.length) add(`select "${name}" = "${sel.join('", "')}"`);
      continue;
    }
    if (n.selected && SELECTABLE.has(n.role)) add(`selected ${n.role}: "${name}"`);
    if (n.attrs["aria-pressed"] === "true") add(`pressed: "${name}"`);
    const current = n.attrs["aria-current"];
    if (current && current !== "false") add(`current ${current === "true" ? "item" : current}: "${name}"`);
    if (n.value && n.attrs["type"] !== "password" && (VALUE_ROLES.has(n.role) || n.tag === "input" || n.tag === "textarea") && !["checkbox", "radio", "submit", "button", "hidden"].includes(n.attrs["type"] ?? "")) {
      add(`field "${name}" = "${clip(n.value, 80)}"`);
    }
  }
  for (const label of lookSelected(snap)) add(`selected (by its look): "${label}"`);
  return [...out, ...disabled];
}

/** A class token that marks the chosen one of a group: active, is-selected, tab--active, sortTabActive, activeTab. */
const STATE_CLASS = /^(?:is-?|has-?)?(?:active|selected|current|checked|chosen)$|[-_](?:is-?)?(?:active|selected|current|checked|chosen)$|[a-z](?:Active|Selected|Current|Checked|Chosen)$|^(?:active|selected|current|checked|chosen)[A-Z_-]/;
/** Carousel and slider libraries mark every slide in view: not a choice. */
const SLIDE_CLASS = /^(?:slick|swiper|owl|carousel|glide|splide|flickity|keen-slider)/i;
const classTokens = (n: SnapNode): string[] => (n.attrs["class"] ?? "").split(/\s+/).filter(Boolean);
const marked = (n: SnapNode): boolean => /^(?:active|selected|on|checked)$/i.test(n.attrs["data-state"] ?? "") || classTokens(n).some((t) => STATE_CLASS.test(t) && !SLIDE_CLASS.test(t));

/**
 * Options a page shows as chosen by their look alone (class names or `data-state`, no ARIA state): one of a group of
 * sibling elements of the same kind, marked where at least one of its siblings is not, its own text short. 9 Nov,
 * MakeMyTrip: the sort tab "Cheapest" was selected by default with no ARIA state, so the end check saw no sort and
 * failed a right answer twice ("the Cheapest tab's active state isn't visible in controls").
 */
export function lookSelected(snap: Snapshot, max = 8): string[] {
  const out: string[] = [];
  for (const n of snap.nodes) {
    if (out.length >= max) break;
    if (n.nodeType !== 1 || !n.visible || !n.parent || n.attrs["aria-selected"] !== undefined || n.attrs["aria-pressed"] !== undefined) continue;
    if (!marked(n)) continue;
    const sibs = n.parent.children.filter((c) => c !== n && c.nodeType === 1 && c.tag === n.tag && c.visible);
    const own = classTokens(n);
    const base = own.filter((t) => !STATE_CLASS.test(t));
    // A state class's stem ("sortTabActive" → "sortTab", "tab--active" → "tab"): a sibling of that class is its kind.
    const stems = own.filter((t) => STATE_CLASS.test(t)).map((t) => t.replace(/[-_]*(?:is-?)?(?:active|selected|current|checked|chosen)$/i, "").replace(/^(?:active|selected|current|checked|chosen)[-_]*/i, "")).filter(Boolean);
    // Its own kind: a sibling with a class in common or its state class's stem (or no class, when it has none but the state).
    const kin = sibs.filter((c) => {
      const ct = classTokens(c);
      if (ct.some((t) => base.includes(t) || stems.some((s) => s.toLowerCase() === t.toLowerCase()))) return true;
      return !base.length && !stems.length && !ct.some((t) => !STATE_CLASS.test(t));
    });
    if (!kin.length || kin.every(marked)) continue;
    // More marked than not is a list's look (every row "active"), not one choice.
    if (kin.filter(marked).length + 1 > (kin.length + 1) / 2) continue;
    const text = textOf(n, 120);
    const label = clip(n.name || n.attrs["aria-label"] || text, 60);
    if (!label || text.length > 60) continue;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** A URL's query parameters, decoded, one `key=value` each ("" when there are none). */
export function urlParams(url: string): string {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([k, v]) => `${k}=${clip(v, 80)}`).join("; ");
  } catch {
    return "";
  }
}

export function clip(s: string, max: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  // Cut on a code-point boundary so an emoji's surrogate pair is never split: a lone surrogate makes
  // the tool result invalid JSON and ends the run.
  return [...s].slice(0, Math.max(0, max - 1)).join("") + "…";
}

/**
 * A link's target as page text shows it: a same-site address as its path, and the query only when the whole of it
 * is short. Result links carry long tracking queries (session ids, ranking tokens) that told the reader nothing and
 * filled the text: on 4 Nov link targets were 77% of a Booking results page's text and most of Amazon's, so a check
 * capped at 12,000 characters saw fewer results. The path still names the page (/dp/B0FMDL81GS, /hotel/in/x.html);
 * "?…" marks a query left out.
 */
export function shownHref(href: string, pageUrl = ""): string {
  if (href.startsWith("#")) return clip(href, 120);
  let u: URL;
  try {
    u = new URL(href, pageUrl || undefined);
  } catch {
    return clip(href, 120);
  }
  if (!/^https?:$/.test(u.protocol)) return clip(href, 120);
  let base = "";
  try {
    base = new URL(pageUrl).host;
  } catch {
    // No page address: show it whole.
  }
  const where = base && u.host === base ? u.pathname : `${u.host}${u.pathname}`;
  const query = u.search;
  const full = `${where}${query}`;
  if (full.length <= 80 || !query) return clip(full, 120);
  return `${clip(where, 116)}?…`;
}

/** How pageText lays out the page. */
export interface PageTextOptions {
  maxChars?: number;
  /**
   * Lists and tables keep their shape: a list item starts "- " and a table row is "| a | b |", so a reader can tell
   * which value sits in which column of a price list or a specs table (plain text runs the cells together).
   */
  structured?: boolean;
  /**
   * The page's main content (<main>, role=main, or a lone <article>) first, then the rest under a marked line: a
   * capped read is then spent on the content, not on the menus above it. Nothing is dropped.
   */
  mainFirst?: boolean;
}

/** Printed text a main must give to go first; less and the page is read in its own order. */
const MAIN_FIRST_MIN_CHARS = 200;

/** The node holding a page's main content, when it has one worth leading with. */
function mainNode(root: SnapNode): SnapNode | null {
  const mains: SnapNode[] = [];
  const articles: SnapNode[] = [];
  const walk = (n: SnapNode) => {
    for (const c of n.children) {
      if (c.tag === "main" || c.role === "main") {
        mains.push(c);
        continue;
      }
      if (c.tag === "article") articles.push(c);
      walk(c);
    }
  };
  walk(root);
  const pick = mains[0] ?? (articles.length === 1 ? articles[0] : undefined);
  if (!pick) return null;
  // A main that holds almost nothing (an app shell, a skip target) is no better a start than the page itself.
  return textOf(pick, 400).length >= 200 ? pick : null;
}

/** Plain readable text of the page (for extraction), with headings marked. */
export function pageText(snap: Snapshot, { maxChars = 60_000, structured = false, mainFirst = false }: PageTextOptions = {}): string {
  const out: string[] = [];
  let chars = 0;
  const skip = new Set<SnapNode>();
  let inCell = 0;
  const walk = (n: SnapNode) => {
    for (const c of n.children) {
      if (chars > maxChars) return;
      if (skip.has(c)) continue;
      if (!c.visible && !c.text && !c.boxless && (c.attrs["__clip"] || !hasVisibleDescendant(c))) continue;
      if (c.boxless || (!c.visible && !c.text)) {
        walk(c);
      } else if (c.text) {
        out.push(c.text);
        chars += c.text.length + 1;
      } else if (c.role === "heading") {
        const t = textOf(c, 300);
        out.push(`\n# ${t}\n`);
        chars += t.length + 4;
      } else if (c.tag === "a" && c.attrs["href"]) {
        // Cut where it is cut, so a reader can tell: a card's link holds the item's whole name.
        const t = clip(textOf(c, 241), 240);
        if (t) {
          const href = shownHref(c.attrs["href"], snap.url);
          out.push(`[${t}](${href})`);
          chars += t.length + href.length + 4;
        }
      } else if (c.tag === "input" || c.tag === "textarea" || c.tag === "select") {
        const label = c.name || c.attrs["placeholder"] || c.attrs["name"] || c.tag;
        out.push(`[${label}: ${c.value ?? ""}]`);
        chars += label.length + 4;
      } else if (structured && c.tag === "li") {
        // Inside a table cell a list stays on the row's line, its items apart.
        out.push(inCell ? "·" : "\n-");
        chars += 2;
        walk(c);
      } else if (structured && c.tag === "tr") {
        out.push("\n|");
        chars += 2;
        walk(c);
        out.push("|");
      } else if (structured && (c.tag === "td" || c.tag === "th")) {
        const before = out.length;
        inCell++;
        walk(c);
        inCell--;
        // An empty cell still holds its column.
        if (out.length === before) out.push(" ");
        out.push("|");
        chars += 2;
      } else {
        if (["li", "tr", "p", "div", "section", "article", "br", "td", "th"].includes(c.tag)) out.push(inCell ? " " : "\n");
        walk(c);
      }
    }
  };
  const main = mainFirst ? mainNode(snap.root) : null;
  if (main) walk({ ...main, children: [main] } as SnapNode);
  if (main && chars >= MAIN_FIRST_MIN_CHARS) {
    skip.add(main);
    if (chars <= maxChars) {
      out.push("\n\n---\n(Outside the main content:)\n");
      walk(snap.root);
    }
  } else {
    // No main, or one that printed almost nothing (hidden, drawn elsewhere): the page in its own order.
    out.length = 0;
    chars = 0;
    walk(snap.root);
  }
  let joined = out
    .join(" ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (structured) joined = joined.replace(/\| +\|/g, "| |").replace(/\n- +\n/g, "\n");
  if (joined.length <= maxChars) return joined;
  // The cap can land between an emoji's surrogate pair; drop a trailing unpaired high surrogate so the
  // result stays valid JSON (the string was well-formed before the cut, so only the boundary is at risk).
  const cut = joined.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The page's links, one a line, "- [words](target)", each target once (its first words kept), in page order: for
 * picking the next page to open on a site or a results list without reading all its text.
 */
export function pageLinks(snap: Snapshot, { maxChars = 60_000 } = {}): { text: string; total: number } {
  const lines: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  let total = 0;
  const walk = (n: SnapNode) => {
    for (const c of n.children) {
      if (!c.visible && !c.boxless && !hasVisibleDescendant(c)) continue;
      if (c.tag === "a" && c.attrs["href"] && !c.attrs["href"].startsWith("javascript:")) {
        const href = shownHref(c.attrs["href"], snap.url);
        const t = clip(textOf(c, 161), 160) || c.name || c.attrs["title"] || c.attrs["aria-label"] || "";
        if (t && !seen.has(href)) {
          seen.add(href);
          total++;
          const line = `- [${t}](${href})`;
          if (chars + line.length + 1 <= maxChars) {
            lines.push(line);
            chars += line.length + 1;
          }
        }
        continue;
      }
      walk(c);
    }
  };
  walk(snap.root);
  return { text: lines.join("\n"), total };
}

/** Search the snapshot for elements whose role/name/text/attributes contain all query words. */
export function findInSnapshot(snap: Snapshot, query: string, { limit = 20 } = {}): SnapNode[] {
  return findScored(snap, query, { limit }).map((h) => h.node);
}

/** A find hit: `exact` when the element has every word of one of the query's targets. */
export interface FindHit {
  node: SnapNode;
  exact: boolean;
}

/**
 * Words a model adds to describe an element rather than name it ("the search button in the header"): they
 * never decide a match. Role words count only as a tie-break toward that kind of element.
 */
const FIND_FILLER = new Set(
  // Not "next", "first", "last", "top"…: those are often the element's own label (a pager's Next, Back to top).
  "a an the of in on at to for from by with into inside within under over near this that these those its it is are be and or & + - element elements area section part page panel popup modal dialog window side header footer sidebar".split(" "),
);
const FIND_ROLE_WORDS: Record<string, string[]> = {
  button: ["button", "btn"],
  link: ["link", "hyperlink"],
  checkbox: ["checkbox", "check", "tick"],
  radio: ["radio"],
  textbox: ["field", "input", "box", "textbox", "textfield"],
  searchbox: ["search", "field", "input", "box", "searchbox"],
  combobox: ["dropdown", "select", "combobox", "picker", "menu"],
  listbox: ["dropdown", "select", "listbox", "list"],
  tab: ["tab"],
  option: ["option", "choice"],
  menuitem: ["menu", "menuitem", "option"],
  heading: ["heading", "title", "header"],
  slider: ["slider", "range"],
  switch: ["switch", "toggle"],
};
const ALL_ROLE_WORDS = new Set(Object.values(FIND_ROLE_WORDS).flat());
const findTokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}$€£₹%]+/u).filter(Boolean);

/**
 * Elements matching a model's description, best first. A query names one target or several ("price max input,
 * Go button"; "Sign in or Log in"): each target is matched on its own words, so a list of targets finds each of
 * them. Words match as whole words or stems ("filters" for "filter", "sorting" for "sort"); filler and role words
 * ("button", "in the sidebar") never decide a match, they only rank one kind of element above another. Elements
 * with every word of a target come first, and when some exist, partial matches for that target are left out; a
 * target nothing matches whole gets its elements with most of its words, marked not exact. Requiring every word of
 * the description as written made 210 of 272 finds return nothing in a sample of recorded runs: models describe ("Charity
 * Foundations category checkbox in Filter by") rather than quote.
 */
/**
 * The text of the `<label>` an unnamed control sits in (at most 3 levels up), or "". A label wrapping a custom control
 * (a div with a radio's role and no name of its own) names it for the person, though not in the accessibility tree:
 * Google Flights' currency dialog lists "Vietnamese Dong VND" as such a label around an unnamed div, and `find` matched
 * nothing for it (23 Nov: two runs spent 20 steps or more on that dialog and one gave up).
 */
function labelOf(n: SnapNode): string {
  for (let p = n.parent, up = 0; p && up < 3; p = p.parent, up++) if (p.tag === "label") return textOf(p, 200);
  return "";
}

export function findScored(snap: Snapshot, query: string, { limit = 20 } = {}): FindHit[] {
  const targets = query
    .split(/[,;|\n]+|\s+(?:or|\/)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  const candidates = snap.nodes.filter((n) => n.text === undefined && n.visible && (n.ref || n.role === "heading"));
  const hay = new Map<SnapNode, { tokens: string[]; flat: string; name: string }>();
  const hayOf = (n: SnapNode) => {
    let h = hay.get(n);
    if (!h) {
      // The page's own attributes only: the capture's metadata ("1", "pointer", "none") is no evidence to match.
      const own = `${n.name} ${textOf(n, 200)}`;
      const s = `${n.tag} ${n.role} ${own} ${own.trim() ? "" : labelOf(n)} ${pageAttrs(n).map(([, v]) => v).join(" ")}`.toLowerCase();
      h = { tokens: findTokens(s), flat: ` ${findTokens(s).join(" ")} `, name: n.name.trim().toLowerCase() };
      hay.set(n, h);
    }
    return h;
  };
  const best = new Map<SnapNode, { score: number; exact: boolean; order: number }>();
  const order = new Map(snap.nodes.map((n, i) => [n, i]));
  /** How well a word matches a token: 1 whole, 0.75 a stem ("filter"/"filters", "sort"/"sorting"), else 0. */
  const wordIn = (w: string, n: SnapNode, roleWords: boolean): number => {
    const h = hayOf(n);
    if (h.tokens.includes(w)) return 1;
    if (h.tokens.some((t) => (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)))) return 0.75;
    // Inside a longer token ("cart" in "addtocart"), as the old substring matcher allowed.
    if (w.length >= 3 && h.flat.includes(w)) return 0.6;
    // A target that names only a kind of element ("search box"): its role words match the element's role.
    if (roleWords && (FIND_ROLE_WORDS[n.role] ?? []).includes(w)) return 1;
    return 0;
  };
  // Elements carrying each word: a word on few elements tells more than one on every card, and a word on none is
  // the model's description ("filter" for the "4 Stars & Up" link), which no element can be expected to have.
  const df = new Map<string, number>();
  const docFreq = (w: string, roleWords: boolean) => {
    const k = `${roleWords ? "r" : ""}${w}`;
    let v = df.get(k);
    if (v === undefined) {
      v = candidates.reduce((c, n) => c + (wordIn(w, n, roleWords) > 0 ? 1 : 0), 0);
      df.set(k, v);
    }
    return v;
  };
  for (const target of targets) {
    const all = findTokens(target);
    let words = all.filter((w) => !FIND_FILLER.has(w) && !ALL_ROLE_WORDS.has(w));
    // A target made only of role or filler words ("search box", "next"): those words are what it names.
    const roleWords = !words.length;
    if (roleWords) words = all.filter((w) => !FIND_FILLER.has(w));
    if (!words.length) words = all;
    if (!words.length) continue;
    const roleHints = all.filter((w) => ALL_ROLE_WORDS.has(w));
    const weights = words.map((w) => {
      const d = docFreq(w, roleWords);
      return d ? Math.log(1 + candidates.length / d) : 0;
    });
    const present = weights.reduce((a, b) => a + b, 0);
    if (!present) continue;
    const scored: Array<{ n: SnapNode; cover: number; score: number; run: number; raw: number }> = [];
    for (const n of candidates) {
      const h = hayOf(n);
      const got = words.map((w) => wordIn(w, n, roleWords));
      if (!got.some((g) => g > 0)) continue;
      // Every word as written: an exact hit, as the old matcher required.
      const all1 = got.every((g) => g >= 1);
      const cover = all1 ? 1 : got.reduce((a, g, i) => a + g * weights[i]!, 0) / present;
      // The longest run of the target's words standing together in the element ("free cancellation").
      let run = 0;
      for (let i = 0; i < words.length; i++) {
        for (let j = words.length; j > i + run; j--) {
          if (h.flat.includes(` ${words.slice(i, j).join(" ")} `)) {
            run = j - i;
            break;
          }
        }
      }
      let score = cover + (words.length > 1 ? (0.5 * run) / words.length : 0);
      if (h.name && h.name === target.trim().toLowerCase()) score += 1;
      if (roleHints.length && (FIND_ROLE_WORDS[n.role] ?? []).some((r) => roleHints.includes(r))) score += 0.25;
      // The shorter the element's text, the more specifically it is the thing named (a filter's label, not a card
      // that mentions it).
      score -= Math.min(0.2, h.tokens.length / 500);
      // Share of the target's words the element has as written, rare or not.
      const raw = got.filter((g) => g > 0).length / words.length;
      scored.push({ n, cover: all1 ? 1 : Math.min(cover, 0.99), score, run, raw });
    }
    const whole = scored.filter((s) => s.cover >= 1);
    // Partial matches: most of what a target's words tell apart, or two of its words standing together, and at least
    // half of its words as written: a word no element has may be the very constraint ("shipping today": "Free
    // shipping" is not it), so an element with one word of three is no match; the closest labels say so instead.
    const kept = whole.length
      ? whole
      : scored
          .filter((s) => s.raw >= 0.5 && (s.cover >= 0.6 || (s.run >= 2 && s.cover >= 0.4)))
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
    for (const s of kept) {
      const prev = best.get(s.n);
      const exact = s.cover >= 1;
      if (!prev || s.score > prev.score) best.set(s.n, { score: s.score, exact: exact || !!prev?.exact, order: order.get(s.n) ?? 0 });
    }
  }
  // A match the page does not draw (inside a collapsed part: `folded`) comes after every drawn one of its kind: a
  // click cannot land on it, and the first hit is the one taken (23 Nov: "Mosaic" on a Wikipedia article was first
  // the link in a collapsed navbox, and its click only scrolled).
  return [...best.entries()]
    .sort((a, b) => Number(b[1].exact) - Number(a[1].exact) || Number(!!a[0].folded) - Number(!!b[0].folded) || b[1].score - a[1].score || a[1].order - b[1].order)
    .slice(0, limit)
    .map(([node, s]) => ({ node, exact: s.exact }));
}

/** Render a single node as a one-liner (used by find() results and evidence). */
/**
 * One element as a line: its ref, tag, attributes and text. `compactFor` (the page's address): the attributes as the
 * compact screen prints them (an href relative to the page with its query elided, no aria-controls or generated ids),
 * so an element named in evidence reads as its line on the screen does.
 */
export function describeNode(n: SnapNode, compactFor?: string, roleTags?: boolean): string {
  const ref = n.ref ? `[${n.ref}]` : "";
  const inner = inlineText(n, 80);
  const attrs = attrString(n, inner, compactFor, roleTags);
  const tag = printedTag(n, roleTags);
  return `${ref}<${tag}${attrs}${inner ? `>${inner}</${tag}>` : " />"}`;
}

/** Roles of an item picked out of a list or a set of tabs, and the roles of what holds such items. */
const CHOICE_ROLES = new Set(["option", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "treeitem"]);
const CHOICE_HOLDERS = new Set(["listbox", "menu", "menubar", "tablist", "tree", "combobox", "grid", "radiogroup"]);

/**
 * For a ref that is an item of a list (an option, a menu item, a tab, a tree item): its label as the page gives it
 * (accessible name, else its text), its position among the items of the same role in its list, and the list's name:
 * `option 2 of 5 in "Suggestions": "North Ridge Lakes"`. Null for anything else, and null when the ref is not in
 * `snap` (then no line is said). It describes what the ref named in that snapshot, the one taken before the action; it
 * is no proof of what a click reached beyond the checks the click itself makes (the ref's staleness check, its hit
 * test). Facts the page shows, nothing inferred about what the item stands for.
 */
export function choiceOf(snap: Snapshot | null | undefined, ref: string, { sameNameAbove = false }: { sameNameAbove?: boolean } = {}): string | null {
  const n = snap?.byRef.get(ref);
  if (!n || !CHOICE_ROLES.has(n.role)) return null;
  let holder: SnapNode | null = n.parent;
  while (holder && !CHOICE_HOLDERS.has(holder.role)) holder = holder.parent;
  const label = clip((n.name || textOf(n, 300)).replace(/\s+/g, " ").trim(), 160);
  if (!holder) return `${n.role}: "${label}"`;
  const items: SnapNode[] = [];
  const walk = (x: SnapNode) => {
    for (const c of x.children) {
      if (c.nodeType !== 1) continue;
      if (c.role === n.role && c.visible) items.push(c);
      else if (!CHOICE_HOLDERS.has(c.role)) walk(c);
    }
  };
  walk(holder);
  const at = items.indexOf(n);
  const name = holder.name ? ` in "${clip(holder.name, 60)}"` : "";
  if (at < 0) return `${n.role}${name}: "${label}"`;
  return `${n.role} ${at + 1} of ${items.length}${name}: "${label}"${sameNameAbove && n.role === "option" ? skippedSameName(items, at) : ""}`;
}

/**
 * A suggestion picked below another of the same name (18 Nov, the open MCP): an autocomplete lists different places
 * under one name, the place itself first and smaller places that share its name after it ("North Goa" over "India",
 * then "North goa" over "Goa (North Goa), India"), and a pick of the later one decides every search after it. Said
 * only when an item listed above the pick has its name (its first line as the screen prints it, before " · ", without
 * case or punctuation): a pick of the first such item says nothing, so a right first pick costs nothing. The list's own
 * words, with one sentence on which of them a task means.
 */
/** An option's name for comparing: its first line as the screen prints it (before " · "), no case or punctuation. */
function optionLead(x: SnapNode): string {
  return (inlineText(x, 200).split(` ${PART_SEP} `)[0] ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The line under a listbox whose options share a name (SerializeOptions.sameNames), or "" (see there). */
function sameNamesNote(box: SnapNode): string {
  const options: SnapNode[] = [];
  const walk = (x: SnapNode) => {
    for (const c of x.children) {
      if (c.nodeType !== 1) continue;
      if (c.role === "option" && c.visible) options.push(c);
      else if (c.role !== "listbox") walk(c);
    }
  };
  walk(box);
  const groups = new Map<string, SnapNode[]>();
  for (const o of options) {
    const k = optionLead(o);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const same = [...groups.values()].find((g) => g.length > 1);
  if (!same) return "";
  const named = same.map((o) => (o.ref ? `[${o.ref}]` : `"${clip(inlineText(o, 60), 60)}"`)).join(", ");
  const shown = clip(inlineText(same[0]!, 60).split(` ${PART_SEP} `)[0] ?? "", 60);
  return `(${named} share the name "${shown}": they are different places. The task's place is the place itself (its country, region or city), not a smaller place that shares its name, unless the task names that smaller place.)`;
}

function skippedSameName(items: SnapNode[], at: number): string {
  const lead = (x: SnapNode) =>
    (inlineText(x, 200).split(` ${PART_SEP} `)[0] ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const mine = lead(items[at]!);
  if (!mine) return "";
  const above = items.slice(0, at).findIndex((x) => lead(x) === mine);
  if (above < 0) return "";
  return `. Option ${above + 1}, listed above it, has the same name: "${clip(inlineText(items[above]!, 120), 120)}". These are different places; the task's place is the place itself (its country, region or city), not a smaller place that shares its name.`;
}
