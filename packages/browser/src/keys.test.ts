import { describe, expect, it } from "vitest";
import { describeKey, parseShortcut } from "./keys.js";

describe("keys", () => {
  it("types a capital or a shifted symbol with Shift, on the key a US keyboard has for it", () => {
    expect(describeKey("A")).toMatchObject({ key: "A", code: "KeyA", keyCode: 65, text: "A", shift: true, unshifted: "a" });
    expect(describeKey("a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(describeKey("a").shift).toBeUndefined();
    expect(describeKey("!")).toMatchObject({ key: "!", code: "Digit1", keyCode: 49, shift: true, unshifted: "1" });
    expect(describeKey("?")).toMatchObject({ code: "Slash", keyCode: 191, shift: true, unshifted: "/" });
    expect(describeKey("@")).toMatchObject({ code: "Digit2", shift: true, unshifted: "2" });
  });

  it("names the physical key of space and punctuation (an empty code is a synthetic-input tell)", () => {
    expect(describeKey(" ")).toMatchObject({ key: " ", code: "Space", keyCode: 32, text: " " });
    expect(describeKey(" ").shift).toBeUndefined();
    for (const [ch, code] of [[".", "Period"], [",", "Comma"], ["-", "Minus"], ["/", "Slash"], [";", "Semicolon"], ["'", "Quote"], ["[", "BracketLeft"], ["\\", "Backslash"], ["=", "Equal"], ["`", "Backquote"]] as const) {
      expect(describeKey(ch)).toMatchObject({ code });
      expect(describeKey(ch).shift).toBeUndefined();
    }
  });

  it("keeps shortcuts as they were: Shift+Tab, Control+a", () => {
    expect(parseShortcut("Shift+Tab")).toMatchObject({ modifiers: 8, key: { key: "Tab", code: "Tab" } });
    expect(parseShortcut("Control+a")).toMatchObject({ modifiers: 2, key: { key: "a", code: "KeyA" } });
  });
});
