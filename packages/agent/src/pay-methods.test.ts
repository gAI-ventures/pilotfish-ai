import { describe, expect, it } from "vitest";
import type { SnapNode } from "@pilotfish/perception";
import { NOT_NOW, payMethodNamed, payOptions, pickedOption } from "./pay-methods.js";

/** A tiny tree: tag, attributes and state, children (strings are text nodes); `nodes` lists it depth first. */
type Spec = { tag: string; attrs?: Record<string, string>; name?: string; role?: string; checked?: boolean; disabled?: boolean; ref?: string; kids?: Array<Spec | string> };
function tree(spec: Spec): SnapNode[] {
  const all: SnapNode[] = [];
  const make = (s: Spec | string, parent: SnapNode | null): SnapNode => {
    const n = (typeof s === "string"
      ? { tag: "#text", text: s, attrs: {}, role: "", name: "", children: [], parent, visible: true }
      : { tag: s.tag, attrs: s.attrs ?? {}, role: s.role ?? (s.attrs?.["type"] === "radio" ? "radio" : s.attrs?.["type"] === "checkbox" ? "checkbox" : ""), name: s.name ?? "", checked: s.checked, disabled: s.disabled, ref: s.ref, children: [], parent, visible: true }) as unknown as SnapNode;
    all.push(n);
    if (typeof s !== "string") for (const k of s.kids ?? []) n.children.push(make(k, n));
    return n;
  };
  make(spec, null);
  return all;
}
const radio = (ref: string, extra: Partial<Spec> = {}): Spec => ({ tag: "input", attrs: { type: "radio", name: "ppw-instrumentRowSelection" }, name: "ppw-instrumentRowSelection", ref, ...extra });

describe("the ways to pay a page offers", () => {
  // As a payment page draws them (17 Nov): radios named for the site's code, their words in the row beside them.
  const page = tree({
    tag: "form",
    kids: [
      { tag: "h1", kids: ["Select a payment method"] },
      { tag: "div", kids: [{ tag: "label", kids: [{ tag: "input", attrs: { type: "checkbox" }, name: "Use 158.00 of 1,000.00 from your eligible Vouchers", checked: true, ref: "e5" }, "Use 158.00 of 1,000.00 from your eligible Vouchers"] }] },
      { tag: "div", kids: [radio("e6", { disabled: true }), "Amazon Pay Balance 0.00 Unavailable"] },
      { tag: "div", kids: [radio("e7"), { tag: "span", kids: ["Credit or debit card"] }, { tag: "a", kids: ["Add a new credit or debit card"] }] },
      { tag: "div", kids: [radio("e8"), "Net Banking", { tag: "select", kids: ["Choose an Option"] }] },
      { tag: "div", kids: [radio("e9"), "Scan and Pay with UPI", "You will need to scan the QR code on the payment page."] },
      { tag: "div", kids: [radio("e10"), "Pay on Delivery (UPI only)", { tag: "span", kids: ["Unavailable for this item"] }] },
      { tag: "div", kids: [{ tag: "input", attrs: { type: "checkbox" }, name: "Send me offers by email", ref: "e11" }] },
    ],
  });

  it("lists those that can be picked now, by the row's words, the picked one marked", () => {
    expect(payOptions(page)).toEqual([
      { label: "Use 158.00 of 1,000.00 from your eligible Vouchers", checked: true, ref: "e5" },
      { label: "Credit or debit card", checked: false, ref: "e7" },
      { label: "Net Banking", checked: false, ref: "e8" },
      { label: "Scan and Pay with UPI", checked: false, ref: "e9" },
    ]);
  });

  it("reads the person's pick from the card's answer or their own words", () => {
    const options = payOptions(page);
    expect(pickedOption("1. Pay with\n   Answer: Net Banking", options)).toMatchObject({ label: "Net Banking", option: { ref: "e8" } });
    expect(pickedOption("scan and pay with upi", options)).toMatchObject({ label: "Scan and Pay with UPI" });
    expect(pickedOption("my HDFC card ending 42", options)).toEqual({ label: "my HDFC card ending 42" });
    expect(NOT_NOW).toBe("Don't pay yet");
  });

  it("a delivery or gift option is no way to pay", () => {
    const slots = tree({ tag: "form", kids: [{ tag: "div", kids: [radio("e1"), "Standard delivery, Thursday"] }, { tag: "div", kids: [radio("e2"), "Express delivery, tomorrow"] }, { tag: "div", kids: [{ tag: "input", attrs: { type: "checkbox" }, name: "Add gift wrap", ref: "e3" }] }] });
    expect(payOptions(slots)).toEqual([]);
  });
});

describe("whether the person named a way to pay", () => {
  it("a method, a wallet, vouchers, or leaving it to the run count; ordering alone does not", () => {
    for (const w of ["order it and pay with UPI", "use the coupon and make the payment", "pay with my saved card", "use my Amazon Pay balance", "cash on delivery please", "pay any way you like", "whichever is fine", "Paid with Answer: Scan and Pay with UPI"]) expect(payMethodNamed(w), w).toBe(true);
    for (const w of ["just order it for me", "make the payment - i'll share details", "place the order", "book it for tomorrow 8pm", "buy 2 diet cokes, a snack around 60 rupees"]) expect(payMethodNamed(w), w).toBe(false);
  });
});
