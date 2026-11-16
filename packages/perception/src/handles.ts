// Two-key element handles and re-grounding.
//
// A ref like "e12" is valid for the snapshot that produced it. Between
// perception and action the page can change (SPAs mutate without navigating),
// so a handle carries both keys: the CDP backendNodeId (fast path) and a
// structural identity (frame + tag + role + name + nth) (recovery path).
// `resolve()` verifies the fast path with one DOM.describeNode round trip and
// falls back to re-grounding in a fresh snapshot, reporting what it did so the
// agent gets a transient "stale" rather than a silent wrong-element click.

import type { FrameSession, Page } from "@pilotfish/browser";
import { ActionError } from "@pilotfish/browser";
import { captureSnapshot, groupKey, nodeKey, type SnapNode, type Snapshot } from "./snapshot.js";
import { describeNode } from "./serialize.js";

export interface ElementHandle {
  ref: string;
  backendNodeId: number;
  frame: FrameSession;
  frameId: string;
  tag: string;
  role: string;
  name: string;
  nth: number;
  key: string;
  /** Size of the look-alike group when the handle was made; re-grounding by position requires it unchanged. */
  groupSize: number;
  identity: string;
  description: string;
}

export function handleFor(n: SnapNode): ElementHandle {
  return {
    ref: n.ref ?? "",
    backendNodeId: n.backendNodeId,
    frame: n.frame,
    frameId: n.frameId,
    tag: n.tag,
    role: n.role,
    name: n.name,
    nth: n.nth,
    key: nodeKey(n),
    groupSize: n.groupSize,
    identity: n.identity,
    description: describeNode(n),
  };
}

export interface ResolveResult {
  handle: ElementHandle;
  /** "verified": backendNodeId still points at an element with the same tag. "regrounded": found by structural key in a fresh snapshot. */
  how: "verified" | "regrounded";
  freshSnapshot?: Snapshot;
}

/**
 * Verify a handle is still live, or re-ground it. Throws ActionError("stale")
 * with a helpful message if the element cannot be found.
 */
export async function resolveHandle(page: Page, h: ElementHandle, { allowReground = true } = {}): Promise<ResolveResult> {
  if (h.frame.session.closed) {
    throw new ActionError("frame_detached", `The frame containing ${h.ref} was detached; take a new snapshot.`);
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
  try {
    // DOM.describeNode can still succeed for a node that was removed from the
    // document but not yet garbage-collected, so check isConnected in-page.
    const live = await h.frame.callOnNode<{ connected: boolean; tag: string }>(
      h.backendNodeId,
      "function(){ return { connected: this.isConnected === true, tag: (this.localName || '').toLowerCase() }; }",
    );
    if (live.connected && live.tag === h.tag) {
      // Confirm it is still the SAME element, not a reused node with swapped content (a React list
      // keyed by index keeps the node connected while changing what it shows). Compare the COMPUTED
      // accessible name — the same source h.name came from — not a guess from attributes, which
      // mismatches for label/placeholder-named inputs and would re-ground (and renumber refs) on every
      // type/fill. Re-ground only when a non-empty name positively differs; otherwise trust the id.
      if (!h.name) return { handle: h, how: "verified" };
      const ax = (await h.frame.session
        .send("Accessibility.getPartialAXTree", { backendNodeId: h.backendNodeId, fetchRelatives: false })
        .catch(() => null)) as { nodes?: Array<{ backendDOMNodeId?: number; name?: { value?: string } }> } | null;
      if (!ax) return { handle: h, how: "verified" };
      const node = ax.nodes?.find((n) => n.backendDOMNodeId === h.backendNodeId) ?? ax.nodes?.[0];
      const axName = norm(String(node?.name?.value ?? ""));
      if (!axName || axName === norm(h.name)) return { handle: h, how: "verified" };
    }
  } catch {
    // fall through to re-grounding
  }
  if (!allowReground) throw new ActionError("stale", `${h.ref} (${h.description}) is no longer in the page; take a new snapshot.`);
  let fresh = await captureSnapshot(page, { viewportBand: Infinity });
  let match = fresh.nodes.find((n) => n.nodeType === 1 && nodeKey(n) === h.key);
  if (!match) {
    // Caught mid-redraw: a list or tab bar the page draws again while results load is gone for a moment (Google
    // Flights' "Cheapest" tab, 4 Nov: the click failed and the same element was back for the next call, twice).
    // One more look after a pause, matched just as strictly.
    await new Promise((r) => setTimeout(r, 600));
    fresh = await captureSnapshot(page, { viewportBand: Infinity });
    match = fresh.nodes.find((n) => n.nodeType === 1 && nodeKey(n) === h.key);
  }
  // Position is part of the key ("2nd 'Add' button"), and `n:`/`h:` identities (form name, href) are
  // often shared across rows, so a distinguishing attribute does not by itself make the match unique.
  // Whenever the look-alike group had siblings and its size changed, position no longer means the same
  // element: refuse rather than act on a neighbour.
  const ambiguous = !!match && h.groupSize > 1 && match.groupSize !== h.groupSize;
  if (!match || ambiguous) {
    throw new ActionError("stale", ambiguous
      ? `${h.ref} (${h.description}) was re-rendered and similar-looking elements were added or removed, so it can't be identified safely; take a new snapshot.`
      : `${h.ref} (${h.description}) is no longer in the page and no element with the same role/name exists; take a new snapshot.`, {
      key: h.key,
    });
  }
  return { handle: { ...handleFor(match), ref: h.ref }, how: "regrounded", freshSnapshot: fresh };
}
