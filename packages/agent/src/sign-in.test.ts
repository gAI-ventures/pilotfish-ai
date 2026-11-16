// The two sign-in decisions other parts of the system build on, tested directly: where a code prompt's
// code comes from (the channel a code source answers for, and whether the saved authenticator key may be
// tried), and whether a page is past a sign-in (when onSignedIn fires). Plus the small rules around them.
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapNode } from "@pilotfish/perception";
import { codeChannel, codeFits, codeFor, hasPasswordField, linkTokens, nearStepBoundary, nearText, offersOtherWay, signInFinished } from "./agent.js";

describe("codeChannel", () => {
  it("authenticator wording wins, wherever it is", () => {
    expect(codeChannel({ hint: "authenticator app" })).toBe("app");
    expect(codeChannel({ label: "Enter the code from your authenticator app" })).toBe("app");
    expect(codeChannel({ label: "Two-step verification", near: "Open Google Authenticator and enter the 6-digit code." })).toBe("app");
    expect(codeChannel({ near: "Enter the code shown in your verification app" })).toBe("app");
    expect(codeChannel({ label: "Use your 2FA app", hint: "We sent a code to •••1234" })).toBe("app");
    expect(codeChannel({ near: "Enter the code from the Okta Verify app" })).toBe("app");
  });

  it("a recovery code only from the field's label or heading", () => {
    expect(codeChannel({ label: "Backup code" })).toBe("recovery");
    expect(codeChannel({ label: "Enter one of your 8-digit backup codes" })).toBe("recovery");
    expect(codeChannel({ label: "Recovery code" })).toBe("recovery");
    // The hint and the prose around the field never decide it (a page that only offers one).
    expect(codeChannel({ label: "Check your email", hint: "We emailed a code to a•••@example.com.", near: "Lost access? Use a backup code." })).toBe("email");
    expect(codeChannel({ hint: "Use a backup code" })).toBe("unknown");
  });

  it("an email address or the inbox is email; a phone, SMS or a text message is sms", () => {
    expect(codeChannel({ hint: "We emailed a 6-digit code to a•••@gmail.com." })).toBe("email");
    expect(codeChannel({ label: "Verification code", near: "Check your inbox for the code." })).toBe("email");
    expect(codeChannel({ hint: "Enter the 6-digit code we sent to •••1234." })).toBe("sms");
    expect(codeChannel({ hint: "SMS" })).toBe("sms");
    expect(codeChannel({ near: "We texted a code to (***) ***-5309" })).toBe("sms");
    expect(codeChannel({ near: "Enter the code sent to your phone ending in 42" })).toBe("sms");
    // The label speaks first, then the hint, then the prose around the field.
    expect(codeChannel({ label: "Code sent by email", hint: "SMS" })).toBe("email");
    expect(codeChannel({ hint: "We sent a code to •••1234", near: "Didn't get the email?" })).toBe("sms");
  });

  it("says unknown when the page does not say", () => {
    expect(codeChannel({})).toBe("unknown");
    expect(codeChannel({ label: "Verification code", near: "Enter the code to continue." })).toBe("unknown");
  });
});

describe("signInFinished", () => {
  it("a page past every auth step finishes the sign-in", () => {
    expect(signInFinished({ category: "none", url: "https://www.linkedin.com/feed/", passwordField: false })).toBe(true);
    expect(signInFinished({ category: null, url: "https://shop.example/account/orders", passwordField: false })).toBe(true);
    // A non-auth classification (a FedCM prompt, a 3-D Secure frame) does not hold it back.
    expect(signInFinished({ category: "fedcm", url: "https://shop.example/", passwordField: false })).toBe(true);
  });

  it("a login, code, approval, link, passkey, check or block page does not", () => {
    for (const category of ["login", "otp", "push_approval", "magic_link", "passkey", "captcha", "bot_challenge", "http_auth", "hard_block"]) {
      expect(signInFinished({ category, url: "https://shop.example/home", passwordField: false })).toBe(false);
    }
  });

  it("a visible password field does not", () => {
    expect(signInFinished({ category: "none", url: "https://shop.example/home", passwordField: true })).toBe(false);
  });

  it("a login, verify, 2FA, checkpoint or challenge address does not, nor an identity provider", () => {
    for (const url of [
      "https://www.linkedin.com/checkpoint/challenge/AgH1x2",
      "https://www.linkedin.com/checkpoint/lg/login-submit",
      "https://github.com/sessions/two-factor/app",
      "https://shop.example/login?next=/orders",
      "https://shop.example/users/sign_in",
      "https://shop.example/account/verify",
      "https://shop.example/mfa",
      "https://shop.example/2fa/totp",
      "https://accounts.google.com/v3/signin/challenge/pwd",
      "https://login.microsoftonline.com/common/oauth2/authorize",
    ]) {
      expect(signInFinished({ category: "none", url, passwordField: false }), url).toBe(false);
    }
    // A slug that only mentions it is a page.
    expect(signInFinished({ category: "none", url: "https://blog.example/how-to-fix-login-problems", passwordField: false })).toBe(true);
  });
});

/** A tiny snapshot: nodes with parents and children, in document order. */
function snap(url: string, build: (el: (tag: string, attrs?: Record<string, string>, kids?: Array<SnapNode | string>, extra?: Partial<SnapNode>) => SnapNode) => SnapNode): Snapshot {
  const nodes: SnapNode[] = [];
  const byRef = new Map<string, SnapNode>();
  const el = (tag: string, attrs: Record<string, string> = {}, kids: Array<SnapNode | string> = [], extra: Partial<SnapNode> = {}): SnapNode => {
    const n = { tag, attrs, nodeType: 1, role: extra.role ?? "", name: "", visible: true, children: [], parent: null, ...extra } as unknown as SnapNode;
    for (const k of kids) {
      const c = typeof k === "string" ? ({ tag: "#text", nodeType: 3, text: k, attrs: {}, role: "", name: "", visible: false, children: [], parent: null } as unknown as SnapNode) : k;
      c.parent = n;
      n.children.push(c);
    }
    return n;
  };
  const root = build(el);
  const walk = (n: SnapNode) => {
    nodes.push(n);
    if (n.ref) byRef.set(n.ref, n);
    n.children.forEach(walk);
  };
  walk(root);
  return { url, title: "", nodes, byRef, root } as unknown as Snapshot;
}

describe("nearText and the field", () => {
  it("reads the prose around a code field, leaving links and buttons out", () => {
    const s = snap("https://a.example/verify", (el) =>
      el("body", {}, [
        el("main", {}, [
          el("h1", {}, ["Check your email"]),
          el("p", {}, ["We emailed a 6-digit code to a•••@example.com. It expires in 10 minutes, so enter it soon."]),
          el("form", {}, [el("input", { name: "code" }, [], { ref: "e3" }), el("button", {}, ["Verify"], { role: "button" })]),
          el("p", {}, [el("a", { href: "/sms" }, ["Text me a code instead"], { role: "link" }), " ", el("a", { href: "/backup" }, ["Use a backup code"], { role: "link" })]),
        ]),
      ]),
    );
    const near = nearText(s, ["e3"]);
    expect(near).toMatch(/emailed a 6-digit code to a•••@example\.com/);
    expect(near).not.toMatch(/Text me|backup|Verify/);
    expect(codeChannel({ label: "Check your email", near })).toBe("email");
    expect(nearText(s, ["e99"])).toBe("");
    expect(nearText(s)).toBe("");
  });

  it("finds a visible password field", () => {
    const login = snap("https://a.example/login", (el) => el("body", {}, [el("input", { type: "password" }, [], { ref: "e1" })]));
    const hidden = snap("https://a.example/feed", (el) => el("body", {}, [el("input", { type: "password" }, [], { ref: "e1", visible: false })]));
    expect(hasPasswordField(login)).toBe(true);
    expect(hasPasswordField(hidden)).toBe(false);
  });

  it("a push page offers another way only when a link or button says so", () => {
    const other = snap("https://a.example/push", (el) => el("body", {}, [el("h1", {}, ["Check your phone"]), el("a", { href: "/other" }, ["Try another way"], { role: "link", name: "Try another way" })]));
    const methods = snap("https://a.example/push", (el) => el("body", {}, [el("button", {}, ["Use a different method"], { role: "button", name: "Use a different method" })]));
    const none = snap("https://a.example/push", (el) => el("body", {}, [el("h1", {}, ["Check your phone"]), el("p", {}, ["Tap Yes on the notification. Try another way if it does not arrive."]), el("a", { href: "/help" }, ["Help"], { role: "link", name: "Help" })]));
    expect(offersOtherWay(other)).toBe(true);
    expect(offersOtherWay(methods)).toBe(true);
    // Prose that mentions it is not a control that offers it.
    expect(offersOtherWay(none)).toBe(false);
  });
});

describe("code rules", () => {
  it("a code fits a field of its length (spaces and dashes aside), or any field that does not say", () => {
    expect(codeFits("123456", { length: 6 })).toBe(true);
    expect(codeFits("123456", undefined)).toBe(true);
    expect(codeFits("123456", {})).toBe(true);
    expect(codeFits("1111-2222", { length: 8 })).toBe(true);
    expect(codeFits("123456", { length: 8 })).toBe(false);
    expect(codeFits("12345678", { length: 6 })).toBe(false);
  });

  it("a length read from a single field's maxlength is an upper bound; boxes and the page's text are exact (K6)", () => {
    // A 6-digit code (or the saved key's) in a maxlength=8 field.
    expect(codeFor("123456", { length: 8, lengthFrom: "maxlength" })).toBe("123456");
    expect(codeFits("000000", { length: 8, lengthFrom: "maxlength" })).toBe(true);
    expect(codeFor("12345678", { length: 8, lengthFrom: "maxlength" })).toBe("12345678");
    expect(codeFor("123456789", { length: 8, lengthFrom: "maxlength" })).toBeNull();
    expect(codeFor("123", { length: 8, lengthFrom: "maxlength" })).toBeNull();
    // Eight boxes, or "Enter the 8-digit code": exact.
    expect(codeFor("123456", { length: 8, lengthFrom: "boxes" })).toBeNull();
    expect(codeFor("123456", { length: 8, lengthFrom: "text" })).toBeNull();
  });

  it("a code that fits only without its spaces or dashes is typed without them", () => {
    expect(codeFor("1234 5678", { length: 8, lengthFrom: "boxes" })).toBe("12345678");
    expect(codeFor("1111-2222", { length: 8, lengthFrom: "boxes" })).toBe("11112222");
    expect(codeFor("ABC-123", { length: 6, lengthFrom: "boxes" })).toBe("ABC123");
    expect(codeFor("ABC-123", { length: 6, lengthFrom: "maxlength" })).toBe("ABC123");
    expect(codeFor("1234 5678", { length: 8, lengthFrom: "maxlength" })).toBe("12345678");
    // One that fits as given keeps its form (a field that takes the dash).
    expect(codeFor("1111-2222", { length: 10, lengthFrom: "maxlength" })).toBe("1111-2222");
    expect(codeFor(" 135790 ", { length: 6 })).toBe("135790");
    expect(codeFor("1111-2222")).toBe("1111-2222");
  });

  it("a second authenticator try only for a code that went in within 3 s of a 30 s step boundary", () => {
    const step = 30_000 * 57_000_000;
    expect(nearStepBoundary(step + 28_500)).toBe(true);
    expect(nearStepBoundary(step + 1_000)).toBe(true);
    expect(nearStepBoundary(step + 27_000)).toBe(true);
    expect(nearStepBoundary(step + 15_000)).toBe(false);
    expect(nearStepBoundary(step + 3_500)).toBe(false);
  });

  it("a sign-in link's token parts: long query values, path segments and fragment values", () => {
    const parts = linkTokens("https://www.example.com/magic/eyJhbGciOiJIUzI1NiJ9.abc/verify?token=Q1w2E3r4T5y6U7i8O9p0&uid=42&next=%2Ffeed#state=Zx9Yw8Vu7Ts6Rq5Po4");
    expect(parts).toEqual(expect.arrayContaining(["eyJhbGciOiJIUzI1NiJ9.abc", "Q1w2E3r4T5y6U7i8O9p0", "Zx9Yw8Vu7Ts6Rq5Po4"]));
    expect(parts).not.toContain("42");
    expect(parts).not.toContain("verify");
    expect(linkTokens("https://a.example/k/" + encodeURIComponent("abc/def+ghi==jklmnop"))).toEqual(expect.arrayContaining(["abc/def+ghi==jklmnop"]));
    expect(linkTokens("not a url")).toEqual([]);
  });

  it("a token-named parameter's value is a token whatever its length; other short values are not", () => {
    const short = linkTokens("https://app.example.com/verify?code=482913&email=jane%40x.com&lang=en");
    expect(short).toContain("482913");
    expect(short).not.toContain("jane%40x.com");
    expect(short).not.toContain("en");
    expect(linkTokens("https://app.example.com/v?t=Ab12Cd34Ef")).toContain("Ab12Cd34Ef");
    expect(linkTokens("https://app.example.com/v?otp=773105&next=home")).toEqual(["773105"]);
    // A word in a token-named parameter is no token ("?code=US", "?key=search"), nor a value so short it
    // would mask a price or a year wherever it shows.
    expect(linkTokens("https://app.example.com/v?code=US&key=search&t=2026")).toEqual([]);
  });

  it("an auth callback's fragment tokens, after a client-side route too", () => {
    const parts = linkTokens("https://app.site.com/#access_token=eyJ.a1&refresh_token=r3fr35h&token_type=bearer&expires_in=3600");
    expect(parts).toEqual(expect.arrayContaining(["eyJ.a1", "r3fr35h"]));
    expect(parts).not.toContain("bearer");
    expect(linkTokens("https://app.site.com/#/callback?code=9f8e7d")).toContain("9f8e7d");
  });
});
