import { describe, expect, it } from "vitest";
import { looksLikePhone, signInOffers, signInPreference, type SignInNode } from "./sign-in.js";

const input = (attrs: Record<string, string>, name = ""): SignInNode => ({ tag: "input", attrs, name, visible: true });
const button = (name: string, role = "button"): SignInNode => ({ tag: "button", attrs: {}, role, name, visible: true });

describe("what a sign-in page offers", () => {
  it("reads password, phone and email fields from their type, autocomplete and labels", () => {
    expect(signInOffers([input({ type: "tel" })])).toEqual(["phone"]);
    expect(signInOffers([input({ type: "text", name: "mobile" }), button("Continue")])).toEqual(["phone"]);
    expect(signInOffers([input({ type: "text" }, "Enter Mobile Number")])).toEqual(["phone"]);
    expect(signInOffers([input({ type: "email" }), input({ type: "password" })])).toEqual(["password", "email"]);
    expect(signInOffers([input({ type: "text", autocomplete: "username" }, "Email or phone"), input({ type: "password" })])).toEqual(["password", "phone", "email"]);
    // A switch to the phone way counts, so does a button that sends an OTP.
    expect(signInOffers([input({ type: "email" }), button("Use phone number instead", "link")])).toEqual(["phone", "email"]);
    expect(signInOffers([input({ type: "text" }, "Username"), button("Login with OTP")])).toEqual(["phone"]);
  });

  it("leaves out hidden fields, check boxes and a page with no sign-in fields", () => {
    expect(signInOffers([{ ...input({ type: "password" }), visible: false }, input({ type: "hidden", name: "phone" }), input({ type: "checkbox" }, "Remember my phone")])).toEqual([]);
    expect(signInOffers([button("Sign in")])).toEqual([]);
  });
});

describe("the way the person asks to sign in", () => {
  it("phone and a texted code", () => {
    for (const t of ["so can you help me login with phone number and otp", "use my mobile", "text me the code", "log in with OTP", "sign in with my cell number"]) expect(signInPreference([t]), t).toBe("phone");
  });

  it("an email and a code, or a password", () => {
    expect(signInPreference(["send the code to my email"])).toBe("email_code");
    expect(signInPreference(["use the magic link in my inbox"])).toBe("email_code");
    expect(signInPreference(["log in with my email and password"])).toBe("password");
    expect(signInPreference(["my password is in the vault, use that"])).toBe("password");
  });

  it("the latest that names a way wins; text that names none changes nothing", () => {
    expect(signInPreference(["log in to swiggy with my phone", "actually use email and password"])).toBe("password");
    expect(signInPreference(["use email and password", "no wait, OTP to my phone"])).toBe("phone");
    expect(signInPreference(["order milk on instamart", "hurry up please"])).toBeNull();
    expect(signInPreference(["log in without a password, by OTP"])).toBe("phone");
    expect(signInPreference(["I don't have a password"])).toBeNull();
  });
});

describe("a phone number", () => {
  it("is 7 to 15 digits with the usual separators", () => {
    for (const t of ["7875710083", "+91 98765 43210", "(415) 555-0134", "+1.415.555.0134"]) expect(looksLikePhone(t), t).toBe(true);
    for (const t of ["ada@example.com", "12345", "1234567890123456", "call 4155550134"]) expect(looksLikePhone(t), t).toBe(false);
  });
});

describe("a question for the phone number to sign in with", () => {
  it("is the sign-in hand-off's: asked with sign-in words, or on a sign-in page", async () => {
    const { asksSignInNumber } = await import("./sign-in.js");
    expect(asksSignInNumber("What phone number should Swiggy use to send the sign-in OTP?")).toBe(true);
    expect(asksSignInNumber("Which mobile number should I use to log in?")).toBe(true);
    expect(asksSignInNumber("Please provide the phone number for your Swiggy account so I can request the OTP.")).toBe(true);
    expect(asksSignInNumber("What is your phone number?", true)).toBe(true);
  });

  it("not a question for the code, nor a phone number with no sign-in in view", async () => {
    const { asksSignInNumber } = await import("./sign-in.js");
    expect(asksSignInNumber("Please enter the OTP sent to your mobile number")).toBe(false);
    expect(asksSignInNumber("What is the verification code texted to your phone number?")).toBe(false);
    expect(asksSignInNumber("What phone number should the courier call for delivery?")).toBe(false);
    expect(asksSignInNumber("Veg or non-veg?", true)).toBe(false);
  });
});

describe("the step a person is asked to approve", () => {
  it("names the control by its own label, the site and the kind of step, never markup or refs", async () => {
    const { approvalText } = await import("./agent.js");
    expect(approvalText("click", { ref: "e12" }, '[e12]<button aria-label="Remove 1 item from cart" data-testid="add_buttons_minus">−</button>', "www.swiggy.com", "delete")).toBe("Press “Remove 1 item from cart” on swiggy.com? It deletes or removes something.");
    expect(approvalText("click", { ref: "e3" }, "[e3]<button>Place order · ₹285</button>", "www.swiggy.com", "pay")).toBe("Press “Place order · ₹285” on swiggy.com? It pays or places an order.");
    expect(approvalText("type", { ref: "e5", submit: true }, '[e5]<input placeholder="Write a reply">', "x.com", "send")).toBe("Submit “Write a reply” on x.com? It sends or publishes something.");
    expect(approvalText("click", { ref: "e9" }, undefined, "", undefined)).toBe("Press this control? It may not be undoable.");
  });
});

describe("a page saying the site does not serve this country", () => {
  it("is read as a geo block, a delivery-area or shipping note is not", async () => {
    const { GEO_BLOCK_TEXT } = await import("@pilotfish/perception");
    for (const t of ["Sorry, this service is not available in your country.", "The content is not available in your region", "We do not currently ship to your country", "Zillow is not available outside the US", "This site is only available in the United States", "not available in this country or region"]) expect(GEO_BLOCK_TEXT.test(t), t).toBe(true);
    for (const t of ["Free shipping only available in stores", "Our app is available in your region", "Delivery is not available outside Bengaluru", "Not available in this size"]) expect(GEO_BLOCK_TEXT.test(t), t).toBe(false);
  });
});

describe("a phone number fitted to its field", () => {
  it("leaves out the country code the page shows, and keeps to the field's length and digits", async () => {
    const { fitPhone } = await import("./sign-in.js");
    expect(fitPhone("+91 98765 43210", { dialCode: "+91", maxLength: 10 })).toBe("9876543210");
    expect(fitPhone("+91 98765 43210", { maxLength: 10 })).toBe("9876543210");
    expect(fitPhone("07875710083", { maxLength: 10 })).toBe("7875710083");
    expect(fitPhone("(415) 555-0134", { numeric: true })).toBe("4155550134");
    expect(fitPhone("+1 415 555 0134", { dialCode: "+1" })).toBe("4155550134");
    // A field that takes it as given gets it as given.
    expect(fitPhone("+91 98765 43210", {})).toBe("+91 98765 43210");
    expect(fitPhone("7875710083", { maxLength: 15 })).toBe("7875710083");
    // A shown code that is not the number's own is not cut from it.
    expect(fitPhone("+44 7700 900123", { dialCode: "+91" })).toBe("447700900123");
  });

  it("finds the country code shown by the field", async () => {
    const { dialCodeIn } = await import("./sign-in.js");
    expect(dialCodeIn(["Mobile number", "+91"])).toBe("+91");
    expect(dialCodeIn(["IN +91 ▾"])).toBe("+91");
    expect(dialCodeIn(["(+1)"])).toBe("+1");
    expect(dialCodeIn(["Save +20% today", "Enter your number"])).toBeUndefined();
  });
});


describe("a sign-in page's address", () => {
  it("is a path segment of its own, not a word in a slug", async () => {
    const { isAuthPath } = await import("./sign-in.js");
    for (const path of ["/auth", "/login", "/sign-in", "/account/login", "/signin/v2"]) expect(isAuthPath(path), path).toBe(true);
    for (const path of ["/how-to-fix-login-problems", "/authors", "/instamart"]) expect(isAuthPath(path), path).toBe(false);
  });
});
