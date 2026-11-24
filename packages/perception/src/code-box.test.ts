// One box of a split code: maxlength 1, or a narrow box whose maxlength is 2 or whose pattern takes one character.
import { describe, expect, it } from "vitest";
import { oneCharBox } from "./interrupts.js";

const box = (maxLength: number | null, width: number, pattern?: string) =>
  ({ maxLength, node: { attrs: pattern ? { pattern } : {}, rect: { x: 0, y: 0, width, height: 44 } } }) as unknown as Parameters<typeof oneCharBox>[0];

describe("oneCharBox", () => {
  it("takes maxlength 1, and narrow boxes of maxlength 2 or a one-character pattern", () => {
    expect(oneCharBox(box(1, 200))).toBe(true);
    expect(oneCharBox(box(2, 44))).toBe(true);
    expect(oneCharBox(box(2, 44, "[0-9]{1}"))).toBe(true);
    expect(oneCharBox(box(null, 44, "[0-9]{1}"))).toBe(true);
    expect(oneCharBox(box(null, 44, "\\d"))).toBe(true);
    expect(oneCharBox(box(null, 44, "[a-zA-Z0-9]{1}"))).toBe(true);
  });

  it("not a wide field of maxlength 2 (a state code), a multi-character pattern, or a box with none", () => {
    expect(oneCharBox(box(2, 200))).toBe(false);
    expect(oneCharBox(box(null, 44, "[0-9]{6}"))).toBe(false);
    expect(oneCharBox(box(null, 44, "\\d+"))).toBe(false);
    expect(oneCharBox(box(null, 44))).toBe(false);
    expect(oneCharBox(box(6, 44, "[0-9]{1}"))).toBe(false);
  });
});
