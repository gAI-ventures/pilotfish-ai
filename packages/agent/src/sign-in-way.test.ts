import { describe, expect, it } from "vitest";
import {
  looksLikePhone,
  parseSignInAsk,
  readSignIn,
  SIGN_IN_WAYS,
  signInAnswerProblem,
  signInAsk,
  signInHowQuestion,
  signInHowWords,
  signInPreference,
  signInWaysText,
  type SignInNode,
} from "./sign-in.js";

const input = (attrs: Record<string, string>, name = ""): SignInNode => ({ tag: "input", attrs, name, visible: true });
const button = (name: string, role = "button"): SignInNode => ({ tag: "button", attrs: {}, role, name, visible: true });
const text = (t: string): SignInNode => ({ tag: "#text", attrs: {}, text: t, visible: true });
const heading = (t: string): SignInNode => ({ tag: "h1", attrs: {}, role: "heading", name: t, visible: true });
const ways = (nodes: SignInNode[]) => readSignIn(nodes).ways;

describe("what a sign-in page offers (readSignIn)", () => {
  it("a password form: an email or phone beside a password is its username, not a code way", () => {
    expect(ways([heading("Sign in"), input({ type: "email" }, "Email"), input({ type: "password" }, "Password"), button("Sign in")])).toEqual(["password"]);
    expect(ways([input({ type: "text", autocomplete: "username" }, "Email or phone"), input({ type: "password" }), button("Log in")])).toEqual(["password"]);
    expect(ways([input({ type: "tel" }, "Mobile number"), input({ type: "password" }, "Password")])).toEqual(["password"]);
  });

  it("an email only, with a magic link or code it says it sends", () => {
    expect(ways([heading("Log in"), input({ type: "email" }, "Work email"), text("We'll email you a magic link for a password-free sign in."), button("Continue")])).toEqual(["email_code"]);
    expect(ways([input({ type: "email" }), button("Email me a sign-in link")])).toEqual(["email_code"]);
  });

  it("a phone and a code by text", () => {
    expect(ways([input({ type: "tel" })])).toEqual(["phone_code"]);
    expect(ways([input({ type: "text", name: "mobile" }), button("Continue")])).toEqual(["phone_code"]);
    expect(ways([input({ type: "text" }, "Enter Mobile Number"), button("Get OTP")])).toEqual(["phone_code"]);
    // A field for either, on a page that says it sends an OTP: both codes.
    expect(ways([input({ type: "text" }, "Email or mobile number"), text("We will send you an OTP"), button("Continue")])).toEqual(["phone_code", "email_code"]);
  });

  it("split OTP boxes are the code step, not a sign-in form", () => {
    const r = readSignIn([heading("Enter the code"), ...Array.from({ length: 6 }, () => input({ type: "text", maxlength: "1", inputmode: "numeric" }))]);
    expect(r.ways).toEqual([]);
    expect(r.codeStep).toBe(true);
    expect(readSignIn([input({ type: "text", autocomplete: "one-time-code" }, "OTP")]).codeStep).toBe(true);
  });

  it("Google and Apple buttons only: providers, done in the browser, and no form", () => {
    const r = readSignIn([heading("Welcome back"), button("Continue with Google"), button("Sign in with Apple"), button("Facebook", "link")]);
    expect(r.ways).toEqual([]);
    expect(r.providers).toEqual(["Google", "Apple", "Facebook"]);
    expect(readSignIn([button("Continue with email")]).providers).toEqual([]);
    // A link's own note is no part of the name (live on a food-delivery site, 24 Nov): one Google, not two.
    expect(readSignIn([button("Sign in with Google"), button("Sign in with Google. Opens in new tab")]).providers).toEqual(["Google"]);
  });

  it("an email first and the rest on the next page: no code is guessed, and a forgotten-password line is no code", () => {
    expect(ways([heading("Sign in"), input({ type: "email" }, "Email address"), button("Next")])).toEqual(["identifier_first"]);
    expect(ways([input({ type: "text", autocomplete: "username" }, "Username"), text("Forgot your password? We'll email you a reset link."), button("Continue")])).toEqual(["identifier_first"]);
    expect(ways([button("Continue with email"), button("Continue with Google")])).toEqual(["identifier_first"]);
  });

  it("switches and tabs add their ways; the form on screen leads", () => {
    expect(ways([button("Login with OTP", "tab"), input({ type: "email" }), input({ type: "password" })])).toEqual(["password", "phone_code"]);
    expect(ways([input({ type: "email" }), button("Use phone number instead", "link")])).toEqual(["identifier_first", "phone_code"]);
    expect(ways([input({ type: "tel" }), button("Login with password", "link"), button("Sign in with a passkey")])).toEqual(["phone_code", "password", "passkey"]);
  });

  it("a dialog with a sign-in field is the sign-in: the page behind it is left out", () => {
    const dialog: SignInNode = { tag: "div", attrs: { "aria-modal": "true" }, role: "dialog", visible: true };
    const inIt = (n: SignInNode): SignInNode => ({ ...n, parent: dialog });
    expect(ways([input({ type: "email" }, "Subscribe to our newsletter"), dialog, inIt(input({ type: "tel" }, "Phone")), inIt(button("Send One Time Password"))])).toEqual(["phone_code"]);
  });

  it("an unclear page: nothing read, the page's own words kept", () => {
    const r = readSignIn([heading("Members area"), button("Sign in"), { ...input({ type: "password" }), visible: false }, input({ type: "hidden", name: "phone" }), input({ type: "checkbox" }, "Remember my phone")]);
    expect([r.ways, r.providers, r.codeStep]).toEqual([[], [], false]);
    expect(r.pageWords).toBe("Members area · Sign in");
  });
});

describe("the sign-in question's field (signInAsk)", () => {
  const seen = { ways: ["password", "phone_code"] as const, providers: ["Google"] };
  it("opens on the person's way when the page offers it, else the page's first form; never adds one", () => {
    expect(signInAsk({ ...seen, ways: [...seen.ways] }, "phone")).toEqual({ ways: ["password", "phone_code"], providers: ["Google"], opensOn: "phone_code" });
    expect(signInAsk({ ...seen, ways: [...seen.ways] })).toMatchObject({ opensOn: "password" });
    // Asked for an emailed code: the page has none, so it is said, never offered.
    expect(signInAsk({ ...seen, ways: [...seen.ways] }, "email_code")).toEqual({ ways: ["password", "phone_code"], providers: ["Google"], opensOn: "password", asked: "email_code" });
    // An email or username first takes any of them.
    expect(signInAsk({ ways: ["identifier_first"], providers: [] }, "phone")).toEqual({ ways: ["identifier_first"], providers: [], opensOn: "identifier_first" });
    // Providers only: nothing to open a form on.
    expect(signInAsk({ ways: [], providers: ["Google"] }, "password")).toEqual({ ways: [], providers: ["Google"], asked: "password" });
  });

  it("drops what is not a way, and repeats", () => {
    expect(signInAsk({ ways: ["password", "password", "phone" as never], providers: ["Google", "Google", " "] })).toEqual({ ways: ["password"], providers: ["Google"], opensOn: "password" });
  });

  it("is checked when read back: known ways once, opensOn among the form ways offered, asked not offered", () => {
    expect(parseSignInAsk({ ways: ["phone_code"], providers: [], opensOn: "phone_code" })).toEqual({ ways: ["phone_code"], providers: [], opensOn: "phone_code" });
    expect(parseSignInAsk({ ways: ["phone"], providers: [] })).toBeNull();
    expect(parseSignInAsk({ ways: ["password"], providers: [], opensOn: "phone_code" })).toBeNull();
    expect(parseSignInAsk({ ways: ["passkey"], providers: [], opensOn: "passkey" })).toBeNull();
    expect(parseSignInAsk({ ways: ["password"], providers: [], asked: "password" })).toBeNull();
    expect(parseSignInAsk({ ways: ["password", "password"], providers: [] })).toBeNull();
    expect(parseSignInAsk({ ways: [], providers: [], extra: 1 })).toBeNull();
    expect(SIGN_IN_WAYS).toEqual(["password", "phone_code", "email_code", "identifier_first", "passkey"]);
  });

  it("an answer must fit a way offered", () => {
    const phoneOnly = { ways: ["phone_code" as const], providers: [] };
    expect(signInAnswerProblem(phoneOnly, { type: "credentials" })).toMatch(/does not sign in with a password; it offers a phone number and a code sent by text/);
    expect(signInAnswerProblem(phoneOnly, { type: "code_login", channel: "sms" })).toBeNull();
    expect(signInAnswerProblem(phoneOnly, { type: "code_login", channel: "email" })).toMatch(/emailed code/);
    expect(signInAnswerProblem({ ways: ["identifier_first"], providers: [] }, { type: "code_login", channel: "email" })).toBeNull();
    expect(signInAnswerProblem({ ways: ["identifier_first"], providers: [] }, { type: "credentials" })).toBeNull();
    expect(signInAnswerProblem(phoneOnly, { type: "done" })).toBeNull();
  });

  it("says the ways in words, and asks how when none could be read", () => {
    expect(signInWaysText({ ways: ["password", "phone_code"], providers: ["Google"] })).toBe("a password (with an email, phone or username); a phone number and a code sent by text; or Google, in the browser");
    expect(signInWaysText({ ways: [], providers: [] })).toBe("");
    expect(signInHowQuestion("food.example", { ways: [], providers: [], pageWords: "Login · Continue" })).toMatch(/^How do you sign in to food.example\? .*it shows: "Login · Continue".*Never a password or code here\.$/);
  });

  it("the person's words for how they sign in never carry a secret", () => {
    expect(signInHowWords("with my phone number and a code")).toBe("with my phone number and a code");
    expect(signInHowWords("email and password, my password is hunter2")).toBe("email and password, my password [hidden]");
    expect(signInHowWords("phone 9876543210 then OTP")).toBe("phone [hidden] then OTP");
    expect(signInHowWords("Google, account ab12cd34ef")).toBe("Google, account [hidden]");
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
    expect(signInPreference(["log in to grocerysite with my phone", "actually use email and password"])).toBe("password");
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
    expect(asksSignInNumber("What phone number should GrocerySite use to send the sign-in OTP?")).toBe(true);
    expect(asksSignInNumber("Which mobile number should I use to log in?")).toBe(true);
    expect(asksSignInNumber("Please provide the phone number for your GrocerySite account so I can request the OTP.")).toBe(true);
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
    expect(approvalText("click", { ref: "e12" }, '[e12]<button aria-label="Remove 1 item from cart" data-testid="add_buttons_minus">−</button>', "www.grocery.example", "delete")).toBe("Press “Remove 1 item from cart” on grocery.example? It deletes or removes something.");
    expect(approvalText("click", { ref: "e3" }, "[e3]<button>Place order · ₹285</button>", "www.grocery.example", "pay")).toBe("Press “Place order · ₹285” on grocery.example? It pays or places an order.");
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
