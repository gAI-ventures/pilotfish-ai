// A sign-in value is never typed into a control that is pressed, and a sign-in counts as finished only once the page no
// longer offers signing in or asks for a code (24 Nov: a code typed into a code page's "Edit phone number" button, and
// a run that reported "Signed in" with the code dialog still open).
import { describe, expect, it } from "vitest";
import type { SnapNode } from "@pilotfish/perception";
import { codeMissNote, notAField, stillSigningIn } from "./agent.js";
import { readSignIn, type SignInNode } from "./sign-in.js";

type N = Pick<SnapNode, "visible" | "tag" | "role" | "name" | "text" | "attrs" | "parent">;
const el = (tag: string, o: Partial<N> = {}): N => ({ visible: true, tag, role: "", name: "", attrs: {}, parent: null, ...o });
const text = (t: string, parent: N | null = null): N => ({ visible: true, tag: "#text", role: "", name: "", text: t, attrs: {}, parent: parent as SnapNode | null });

describe("notAField", () => {
  it("refuses a button, a link and a pressed input type; names the control", () => {
    const b = notAField({ tag: "button", role: "button", name: "Edit phone number", attrs: {} }, "e114", ["user_code"]);
    expect(b).toMatch(/^Refused: e114 is a button \("Edit phone number"\), not a field/);
    expect(b).toContain("{{user_code}}");
    expect(notAField({ tag: "a", role: "link", name: "Change number", attrs: { href: "#" } }, "e3", ["site.entered_phone"])).toMatch(/is a link/);
    expect(notAField({ tag: "input", role: "button", name: "Verify", attrs: { type: "submit" } }, "e9", ["user_code"])).toMatch(/is a submit input/);
    expect(notAField({ tag: "div", role: "button", name: "Resend", attrs: {} }, "e5", ["user_code"])).toMatch(/is a button/);
  });

  it("lets through what takes text: inputs, text areas, editable and unnamed elements, text roles", () => {
    const fields: Array<Pick<SnapNode, "tag" | "role" | "name" | "attrs">> = [
      { tag: "input", role: "textbox", name: "OTP", attrs: { type: "text" } },
      { tag: "input", role: "spinbutton", name: "Digit 1", attrs: { type: "number" } },
      { tag: "input", role: "textbox", name: "", attrs: {} },
      { tag: "input", role: "textbox", name: "Password", attrs: { type: "password" } },
      { tag: "textarea", role: "textbox", name: "", attrs: {} },
      { tag: "div", role: "", name: "", attrs: { contenteditable: "true" } },
      { tag: "div", role: "textbox", name: "Code", attrs: {} },
      { tag: "div", role: "", name: "", attrs: {} },
    ];
    for (const n of fields) expect(notAField(n, "e1", ["user_code"])).toBeNull();
  });
});

describe("stillSigningIn", () => {
  it("a page offering signing in, or a heading or dialog asking for a code, is not signed in", () => {
    expect(stillSigningIn([el("button", { role: "button", name: "login" })])).toBe(true);
    expect(stillSigningIn([el("a", { role: "link", name: "Sign in" })])).toBe(true);
    expect(stillSigningIn([el("button", { role: "button", name: "Login / Sign up" })])).toBe(true);
    expect(stillSigningIn([el("h2", { role: "heading", name: "OTP Verification" })])).toBe(true);
    expect(stillSigningIn([el("h1", { role: "heading", name: "Verify your phone number" })])).toBe(true);
    const dialog = el("dialog", { role: "dialog" });
    expect(stillSigningIn([dialog, text("OTP has been sent to +91 98•••••210", el("p", { parent: dialog as SnapNode }))])).toBe(true);
    expect(stillSigningIn([dialog, text("We texted a 6-digit code to your phone", el("p", { parent: dialog as SnapNode }))])).toBe(true);
  });

  it("a signed-in page, an account control, words outside a dialog and hidden controls do not count", () => {
    expect(stillSigningIn([el("button", { role: "button", name: "Account" }), el("h1", { role: "heading", name: "Shop by Category" })])).toBe(false);
    expect(stillSigningIn([el("button", { role: "button", name: "Sign out" }), el("a", { role: "link", name: "Sign in to another account" })])).toBe(false);
    // A page's own notice about codes, not in a dialog or a heading (a bank's footer).
    expect(stillSigningIn([text("Never share the OTP sent to your phone with anyone.", el("footer"))])).toBe(false);
    expect(stillSigningIn([el("button", { role: "button", name: "Log in", visible: false })])).toBe(false);
  });
});

describe("readSignIn on a code page", () => {
  const dialog = { tag: "dialog", role: "dialog", attrs: {}, parent: null };
  const inD = (n: Record<string, unknown>) => ({ attrs: {}, parent: dialog, ...n }) as unknown as SignInNode;
  it("a code dialog whose field is not shown is the code step, not a sign-in form", () => {
    const seen = readSignIn([
      dialog as unknown as SignInNode,
      inD({ tag: "h2", role: "heading", name: "OTP Verification" }),
      inD({ tag: "button", role: "button", name: "Edit phone number" }),
      inD({ tag: "#text", text: "OTP has been sent to +91 98•••••210" }),
      inD({ tag: "button", role: "button", name: "Send SMS" }),
    ]);
    expect(seen.codeStep).toBe(true);
    // A page with no field and no code words is not.
    expect(readSignIn([{ tag: "h1", role: "heading", name: "Shop by Category", attrs: {} }]).codeStep).toBe(false);
  });

  it("a footer's follow-us links to a provider's own pages are no sign-in providers; its sign-in buttons and pages are", () => {
    const seen = readSignIn([
      { tag: "a", role: "link", name: "Facebook", attrs: { href: "https://www.facebook.com/someshop" } },
      { tag: "a", role: "link", name: "LinkedIn", attrs: { href: "https://www.linkedin.com/company/someshop" } },
      { tag: "a", role: "link", name: "Google", attrs: { href: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" } },
      { tag: "button", role: "button", name: "Continue with Apple", attrs: {} },
    ]);
    expect(seen.providers).toEqual(["Google", "Apple"]);
  });

  it("a site's own logo link named like a provider is no way to sign in; a bare name going to a sign-in address is", () => {
    const seen = readSignIn([
      { tag: "a", role: "link", name: "Amazon", attrs: { href: "/ref=nav_logo" } },
      { tag: "a", role: "link", name: "Google", attrs: { href: "/auth/google/start" } },
      { tag: "button", role: "button", name: "Amazon", attrs: {} },
    ]);
    expect(seen.providers).toEqual(["Google", "Amazon"]);
  });
});

describe("codeMissNote", () => {
  it("says nothing was submitted and hands the code to the person, never to be typed again", () => {
    const n = codeMissNote("2 of the 6 boxes held their character after typing, each fixed twice");
    expect(n).toMatch(/NOT submitted: 2 of the 6 boxes/);
    expect(n).toMatch(/Do not type it again/);
    expect(n).toMatch(/kind "login"/);
  });
});
