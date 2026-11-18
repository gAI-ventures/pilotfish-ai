// restoreHiddenNames on hand-built captures (17 Nov): the race seen live on Google Flights, where the capture right
// after its listbox opened read Chromium's tree with the background already dropped but the DOM a moment before
// `aria-hidden` was set, so inputs were neither named nor known hidden; and the next capture copied that empty name.
import { describe, expect, it } from "vitest";
import { restoreHiddenNames, type SnapNode, type Snapshot } from "./snapshot.js";

let backend = 1;
function el(tag: string, extra: Partial<SnapNode> = {}): SnapNode {
  return { nodeType: 1, tag, role: "", name: "", attrs: {}, visible: true, interactive: false, scrollable: false, children: [], parent: null, frameId: "F", backendNodeId: backend++, nth: 0, identity: "", groupSize: 1, ...extra } as SnapNode;
}
/** A copy of `n` as a later capture reads it: same DOM node, the given AX outcome. */
function later(n: SnapNode, ax: Partial<SnapNode>): SnapNode {
  return { ...n, children: [], role: "", name: "", axHidden: undefined, axUnlisted: undefined, ...ax } as SnapNode;
}
const snap = (nodes: SnapNode[]) => ({ nodes }) as Snapshot;

describe("restoreHiddenNames: elements Chromium's tree does not list", () => {
  const input = el("input", { role: "combobox", name: "Where from?", attrs: { "aria-label": "Where from?", role: "combobox" }, interactive: true });
  const box = el("div", { name: "" , axUnlisted: true });

  it("an unlisted element, not known hidden, gets Chromium's earlier name for the same node back", () => {
    const now = later(input, { role: "combobox", axUnlisted: true });
    expect(restoreHiddenNames([now], snap([input]))).toBe(true);
    expect(now.name).toBe("Where from?");
    // Naming only: visibility and interactivity are what the capture read.
    expect(now.visible).toBe(true);
    expect(now.interactive).toBe(input.interactive);
  });

  it("an unlisted interactive element with nothing earlier to go by is named from the DOM, never left empty", () => {
    const raced = later(input, { role: "combobox", axUnlisted: true, interactive: true }); // the racing capture
    expect(restoreHiddenNames([raced], null)).toBe(true);
    expect(raced.name).toBe("Where from?");
  });

  it("never carries forward an empty name: an empty earlier name falls through to a fresh DOM-derived one", () => {
    const emptyEarlier = later(input, { role: "combobox", axUnlisted: true, name: "" });
    for (const ax of [{ axUnlisted: true }, { axUnlisted: true, axHidden: true }]) {
      const next = later(input, { role: "combobox", interactive: true, ...ax });
      restoreHiddenNames([next], snap([emptyEarlier]));
      expect(next.name, JSON.stringify(ax)).toBe("Where from?");
    }
  });

  it("two unlisted look-alikes told apart only by aria-label keep apart names, so their keys and nth stay apart", () => {
    const opt = (label: string) => el("li", { role: "option", attrs: { role: "option", "aria-label": label }, interactive: true });
    const [a, b] = [opt("North Goa, region"), opt("North Goa, city")];
    for (const o of [a, b]) o.children.push({ nodeType: 3, text: "North Goa", visible: true, parent: o, children: [] } as unknown as SnapNode);
    const [na, nb] = [later(a, { role: "option", axUnlisted: true, interactive: true }), later(b, { role: "option", axUnlisted: true, interactive: true })];
    na.children = a.children;
    nb.children = b.children;
    restoreHiddenNames([na, nb], snap([later(a, { axUnlisted: true }), later(b, { axUnlisted: true })]));
    expect([na.name, nb.name]).toEqual(["North Goa, region", "North Goa, city"]);
  });

  it("does not restore a name whose label changed (it is read fresh), and leaves plain unlisted containers unnamed", () => {
    const relabelled = later({ ...input, attrs: { ...input.attrs, "aria-label": "Where to?" } }, { role: "combobox", axUnlisted: true });
    restoreHiddenNames([relabelled], snap([input]));
    expect(relabelled.name).toBe("Where to?");
    const container = later(box, { axUnlisted: true });
    expect(restoreHiddenNames([container], snap([box]))).toBe(false);
    expect(container.name).toBe("");
  });
});
