// A transparent input laid over the box that draws it (code entry: one input over a row of drawn boxes) is a field;
// a honeypot (tiny, off its box, unpositioned) and other transparent elements are not.
import { describe, expect, it } from "vitest";
import { transparentField } from "./snapshot.js";
import type { SnapNode } from "./snapshot.js";

type Rect = { x: number; y: number; width: number; height: number };
const parent = (rect?: Rect, visible = true) => ({ rect, visible, parent: null }) as unknown as SnapNode;
const input = (rect: Rect, attrs: Record<string, string> = {}, p = parent({ x: 100, y: 200, width: 300, height: 48 })) =>
  ({ tag: "input", attrs, rect, parent: p }) as Pick<SnapNode, "tag" | "attrs" | "rect" | "parent">;
const row = { x: 100, y: 200, width: 300, height: 48 };

describe("transparentField", () => {
  it("an input covering its box, positioned, is a field (text, tel, number, no type)", () => {
    expect(transparentField(input(row, { type: "text", autocomplete: "one-time-code" }), "absolute", "auto")).toBe(true);
    expect(transparentField(input(row, { type: "tel" }), "absolute", "auto")).toBe(true);
    expect(transparentField(input(row), "fixed", "auto")).toBe(true);
    // Its box is the nearest laid-out ancestor (a display:contents wrapper has none).
    const wrapper = { rect: undefined, visible: false, parent: parent(row) } as unknown as SnapNode;
    expect(transparentField(input(row, {}, wrapper), "absolute", "auto")).toBe(true);
  });

  it("a honeypot or another transparent control is not", () => {
    // In the flow, or taking no pointer events.
    expect(transparentField(input(row), "static", "auto")).toBe(false);
    expect(transparentField(input(row), "absolute", "none")).toBe(false);
    // Tiny.
    expect(transparentField(input({ x: 100, y: 200, width: 1, height: 1 }), "absolute", "auto")).toBe(false);
    // Off its box (moved off the page), or covering little of it.
    expect(transparentField(input({ x: -9999, y: 200, width: 300, height: 48 }), "absolute", "auto")).toBe(false);
    expect(transparentField(input({ x: 100, y: 200, width: 60, height: 20 }), "absolute", "auto")).toBe(false);
    // Its box is not shown.
    expect(transparentField(input(row, {}, parent(row, false)), "absolute", "auto")).toBe(false);
    // Not a text input: a checkbox drawn by its label, a file input over an upload button.
    expect(transparentField(input(row, { type: "checkbox" }), "absolute", "auto")).toBe(false);
    expect(transparentField(input(row, { type: "file" }), "absolute", "auto")).toBe(false);
    expect(transparentField({ tag: "select", attrs: {}, rect: row, parent: parent(row) }, "absolute", "auto")).toBe(false);
  });
});
