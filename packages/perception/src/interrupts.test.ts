// Unit tests for the interruption classifier: tiers A/B with plain objects, and
// tier C over hand-built snapshot trees (the e2e suite covers real snapshots).
import { describe, expect, it } from "vitest";
import { classifyInterruption, explainResolution, isAuthUrl, isResolved, type InterruptInput, type InterruptNode, type InterruptRect, type InterruptSnapshot } from "./interrupts.js";

// ---------------------------------------------------------------- tiny tree builder

let row = 0;
type Child = InterruptNode | string;
function E(tag: string, attrs: Record<string, string> = {}, children: Child[] = [], extra: Partial<InterruptNode> = {}): InterruptNode {
  const rect: InterruptRect = extra.rect ?? { x: 20, y: 20 + (row++ % 24) * 30, width: 280, height: 24 };
  const n: InterruptNode = { tag, attrs, visible: true, children: [], rect, ...extra };
  for (const c of children) {
    const child: InterruptNode = typeof c === "string" ? { tag: "#text", nodeType: 3, text: c, attrs: {}, visible: true, children: [], rect: { ...n.rect! } } : c;
    child.parent = n;
    n.children.push(child);
  }
  return n;
}
const T = (text: string) => text;
function S(url: string, body: Child[], { title = "", scroll = 0 }: { title?: string; scroll?: number } = {}): InterruptSnapshot {
  row = 0;
  const root = E("body", {}, body, { rect: { x: 0, y: 0, width: 1280, height: 2000 } });
  const nodes: InterruptNode[] = [];
  const walk = (n: InterruptNode, fid: string) => {
    n.frameId ??= fid;
    nodes.push(n);
    for (const c of n.children) walk(c, c.frameId ?? n.frameId);
  };
  walk(root, "main");
  return { url, title, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: scroll }, nodes, root: { frameId: "main" } };
}
const iframe = (src: string, rect: InterruptRect, content: Child[] = [], attrs: Record<string, string> = {}, frameId = `f${Math.random().toString(36).slice(2, 7)}`) =>
  E("iframe", { src, ...attrs }, content.length ? [E("html", {}, content, { frameId, rect })] : [], { isIframe: true, rect });
const lots = (n: number, prefix = "Article") => Array.from({ length: n }, (_, i) => E("p", {}, [`${prefix} paragraph ${i} with enough words to look like real editorial content about gardening and travel.`, E("a", { href: `/a/${i}` }, [`link ${i}`])]));

const classify = (i: InterruptInput) => classifyInterruption(i);

// ---------------------------------------------------------------- tier A

describe("tier A: main response", () => {
  it("cf-mitigated: challenge is a blocking, auto-resolvable Cloudflare bot challenge", () => {
    const r = classify({ response: { url: "https://shop.example/", status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare" } } });
    expect(r).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, autoResolvable: true, needs: "solve_in_live_view" });
  });

  it("headers are matched case-insensitively", () => {
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: { "CF-Mitigated": "challenge" } } }).category).toBe("bot_challenge");
  });

  it("AWS WAF captcha (405) and challenge (202)", () => {
    expect(classify({ response: { url: "https://a.example/", status: 405, headers: { "x-amzn-waf-action": "captcha" } } })).toMatchObject({ category: "captcha", vendor: "aws-waf", blocking: true, autoResolvable: false });
    expect(classify({ response: { url: "https://a.example/", status: 202, headers: { "x-amzn-waf-action": "challenge" } } })).toMatchObject({ category: "bot_challenge", vendor: "aws-waf", autoResolvable: true });
  });

  it("DataDome: 403 + cookie/header is a captcha, t=bv a hard block, /interstitial/ an auto challenge", () => {
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: {} }, cookies: ["datadome"] })).toMatchObject({ category: "captcha", vendor: "datadome", blocking: true });
    const bv = classify({ response: { url: "https://a.example/", status: 403, headers: { "x-datadome": "protected" } }, frameUrls: ["https://a.example/", "https://geo.captcha-delivery.com/captcha/?initialCid=x&cid=y&t=bv&referer=z"] });
    expect(bv).toMatchObject({ category: "hard_block", vendor: "datadome", needs: "none_possible" });
    const inter = classify({ response: { url: "https://a.example/", status: 403, headers: { "x-datadome-cid": "abc" } }, frameUrls: ["https://a.example/", "https://geo.captcha-delivery.com/interstitial/?initialCid=x"] });
    expect(inter).toMatchObject({ category: "bot_challenge", vendor: "datadome", autoResolvable: true });
  });

  it("DataDome / Akamai / Imperva cookies on a normal 200 page are presence only", () => {
    const r = classify({ response: { url: "https://a.example/", status: 200, headers: { "x-datadome": "protected" } }, cookies: ["datadome", "_abck", "bm_sz", "incap_ses_123_456", "__cf_bm"] });
    expect(r.category).toBe("none");
    expect(r.blocking).toBe(false);
    expect(r.needs).toBe("nothing");
    expect(r.signals).toEqual(expect.arrayContaining(["present:datadome cookie datadome", "present:akamai cookie _abck", "present:imperva cookie incap_ses_123_456", "present:cloudflare cookie __cf_bm"]));
  });

  it("PerimeterX/HUMAN: 403 + _px cookie is a captcha with #px-captcha, else a hard block", () => {
    const withWidget = S("https://a.example/", [E("h1", {}, ["Access to this page has been denied"]), E("div", { id: "px-captcha" }, [], { rect: { x: 400, y: 300, width: 310, height: 100 } })]);
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: {} }, cookies: ["_px3", "_pxhd"], snapshot: withWidget })).toMatchObject({ category: "captcha", vendor: "human", blocking: true });
    const noWidget = S("https://a.example/", [E("h1", {}, ["Access to this page has been denied"])]);
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: { "x-px-block": "1" } }, snapshot: noWidget })).toMatchObject({ category: "hard_block", vendor: "human", needs: "none_possible" });
    // Another vendor's block page under a _px3 cookie left from HUMAN's check is that vendor's (fourth review).
    const cf = S("https://a.example/", [E("h1", {}, ["Sorry, you have been blocked"]), E("p", {}, ["You are unable to access a.example"]), E("p", {}, ["Cloudflare Ray ID: 8f2b1c3d4e5f6a7b"])], { title: "Attention Required! | Cloudflare" });
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: {} }, cookies: ["_px3"], snapshot: cf })).toMatchObject({ category: "hard_block", vendor: "cloudflare" });
  });

  it("Kasada 429 + x-kpsdk-* is an auto-resolvable bot challenge", () => {
    expect(classify({ response: { url: "https://a.example/", status: 429, headers: { "x-kpsdk-ct": "0abc" } } })).toMatchObject({ category: "bot_challenge", vendor: "kasada", autoResolvable: true });
    expect(classify({ response: { url: "https://a.example/", status: 200, headers: { "x-kpsdk-ct": "0abc" } } }).category).toBe("none");
  });

  it("google.com/sorry/index is a captcha", () => {
    expect(classify({ url: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx&q=EgQ" })).toMatchObject({ category: "captcha", vendor: "google", blocking: true });
  });

  it("401 + Basic/Digest www-authenticate is http_auth; Bearer is not", () => {
    expect(classify({ response: { url: "https://a.example/admin", status: 401, headers: { "www-authenticate": 'Basic realm="admin"' } } })).toMatchObject({ category: "http_auth", needs: "credentials", blocking: true });
    expect(classify({ response: { url: "https://a.example/api", status: 401, headers: { "www-authenticate": "Bearer" } } }).category).toBe("none");
    expect(classify({ httpAuthRequired: { scheme: "Digest" }, url: "https://a.example/" })).toMatchObject({ category: "http_auth", needs: "credentials" });
  });

  it("a login path with a return parameter (or SAMLRequest) is a login wall", () => {
    for (const url of ["https://a.example/login?next=/orders", "https://a.example/users/sign_in?return_to=%2F", "https://a.example/signin?returnTo=/x", "https://a.example/auth/login?redirect_uri=https%3A%2F%2Fa.example", "https://idp.example/sso/saml?SAMLRequest=fZJ"]) {
      expect(classify({ url }), url).toMatchObject({ category: "login", blocking: true, needs: "login_in_live_view" });
    }
    // No return parameter and no snapshot: not enough evidence.
    expect(classify({ url: "https://a.example/login" }).category).toBe("none");
    // A return parameter on a non-login path means nothing.
    expect(classify({ url: "https://a.example/search?next=2" }).category).toBe("none");
  });

  it("Vercel mitigation headers", () => {
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: { "x-vercel-mitigated": "challenge" } } })).toMatchObject({ category: "bot_challenge", vendor: "vercel" });
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: { "x-vercel-mitigated": "deny" } } })).toMatchObject({ category: "hard_block", vendor: "vercel" });
  });
});

// ---------------------------------------------------------------- tier B

const BFRAME = "https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=6Le";
const ANCHOR = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le&co=aHR0&hl=en&v=abc&size=normal&cb=1";

describe("tier B: frames", () => {
  it("a visible reCAPTCHA bframe is a blocking image challenge", () => {
    const snap = S("https://a.example/signup", [...lots(5), iframe(ANCHOR, { x: 20, y: 400, width: 304, height: 78 }), iframe(BFRAME, { x: 300, y: 100, width: 400, height: 580 })]);
    expect(classify({ snapshot: snap, frameUrls: [snap.url, ANCHOR, BFRAME] })).toMatchObject({ category: "captcha", vendor: "recaptcha", blocking: true });
  });

  it("a reCAPTCHA checkbox inside a content form is present but not blocking; the hidden bframe is ignored", () => {
    const snap = S("https://a.example/contact", [...lots(8), E("form", {}, [E("input", { name: "email", type: "email" }), iframe(ANCHOR, { x: 20, y: 400, width: 304, height: 78 }), E("button", {}, ["Send"])]), iframe(BFRAME, { x: 0, y: -10000, width: 400, height: 580 })]);
    const r = classify({ snapshot: snap, frameUrls: [snap.url, ANCHOR, BFRAME] });
    expect(r).toMatchObject({ category: "captcha", vendor: "recaptcha", blocking: false, needs: "solve_in_live_view" });
  });

  it("a reCAPTCHA checkbox on a gate page blocks", () => {
    const snap = S("https://a.example/verify", [E("h1", {}, ["One more step"]), iframe(ANCHOR, { x: 20, y: 200, width: 304, height: 78 }), E("button", {}, ["Continue"])]);
    expect(classify({ snapshot: snap, frameUrls: [snap.url, ANCHOR] })).toMatchObject({ category: "captcha", blocking: true });
  });

  it("reCAPTCHA v3 / invisible is presence only", () => {
    const v3 = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le&co=x&hl=en&v=abc&size=invisible&cb=2";
    const snap = S("https://a.example/", [...lots(5), iframe(v3, { x: 1200, y: 700, width: 256, height: 60 })]);
    const r = classify({ snapshot: snap, frameUrls: [snap.url, v3] });
    expect(r.category).toBe("none");
    expect(r.signals).toContain("present:recaptcha invisible/v3 (badge only)");
  });

  it("hCaptcha: visible challenge frame blocks; checkbox in a form does not", () => {
    const base = "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html";
    const challenge = `${base}#frame=challenge&id=0x&host=a.example&sitekey=k`;
    const checkbox = `${base}#frame=checkbox&id=0x&host=a.example&sitekey=k`;
    const open = S("https://a.example/signup", [...lots(4), iframe(checkbox, { x: 20, y: 300, width: 303, height: 78 }), iframe(challenge, { x: 300, y: 50, width: 520, height: 570 })]);
    expect(classify({ snapshot: open, frameUrls: [open.url, checkbox, challenge] })).toMatchObject({ category: "captcha", vendor: "hcaptcha", blocking: true });
    const closed = S("https://a.example/signup", [...lots(8), iframe(checkbox, { x: 20, y: 300, width: 303, height: 78 }), iframe(challenge, { x: 300, y: 50, width: 520, height: 570 }, [], {}, "fc")]);
    closed.nodes.find((n) => n.attrs["src"] === challenge)!.visible = false;
    expect(classify({ snapshot: closed, frameUrls: [closed.url, checkbox, challenge] })).toMatchObject({ category: "captcha", blocking: false });
  });

  it("Turnstile: on a Cloudflare challenge page it is an auto bot challenge; in a form it is an inline captcha", () => {
    const ts = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAA/light/fbE/new/normal/auto/";
    const page = S("https://a.example/", [E("h1", {}, ["a.example"]), E("p", {}, ["Verify you are human by completing the action below."]), iframe(ts, { x: 20, y: 200, width: 300, height: 65 })], { title: "Just a moment..." });
    expect(classify({ snapshot: page, frameUrls: [page.url, ts] })).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, autoResolvable: true });
    // Embedded widgets carry cf-chl-widget-* ids too; that alone is not a challenge page.
    const form = S("https://a.example/newsletter", [...lots(8), E("form", {}, [E("input", { type: "email", name: "email" }), E("div", { id: "cf-chl-widget-ab12c" }, [iframe(ts, { x: 20, y: 300, width: 300, height: 65 })]), E("input", { type: "hidden", name: "cf-turnstile-response", id: "cf-chl-widget-ab12c_response" }, [], { visible: false }), E("button", {}, ["Subscribe"])])], { title: "Blog" });
    expect(classify({ snapshot: form, frameUrls: [form.url, ts] })).toMatchObject({ category: "captcha", vendor: "cloudflare", blocking: false, autoResolvable: true });
  });

  it("__cf_chl_ tokens in the main URL mean a Cloudflare challenge", () => {
    expect(classify({ url: "https://a.example/?__cf_chl_rt_tk=abc-123" })).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", autoResolvable: true });
  });

  it("frames whose existence means a shown challenge block even without a snapshot", () => {
    expect(classify({ url: "https://a.example/", frameUrls: ["https://a.example/", "https://geo.captcha-delivery.com/captcha/?initialCid=x&t=fe"] })).toMatchObject({ category: "captcha", vendor: "datadome", blocking: true });
    expect(classify({ url: "https://a.example/", frameUrls: ["https://a.example/", "https://client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/1.0/standard/index.html"] })).toMatchObject({ category: "captcha", vendor: "arkose", blocking: true });
    expect(classify({ url: "https://shop.example/checkout", frameUrls: ["https://shop.example/checkout", "https://centinelapi.cardinalcommerce.com/V2/Cruise/StepUp"] })).toMatchObject({ category: "payment_3ds", vendor: "cardinal", blocking: true });
    expect(classify({ url: "https://shop.example/checkout", frameUrls: ["https://shop.example/checkout", "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html"] })).toMatchObject({ category: "payment_3ds", vendor: "stripe" });
  });

  it("3DS device-data/method frames and hidden checkout frames are presence only", () => {
    const r = classify({ url: "https://shop.example/checkout", frameUrls: ["https://shop.example/checkout", "https://centinelapi.cardinalcommerce.com/V1/Cruise/Collect", "https://js.stripe.com/v3/three-ds-2-fingerprint-x.html", "https://js.stripe.com/v3/elements-inner-card-abc.html"] });
    expect(r.category).toBe("none");
    expect(r.signals.some((s) => s.startsWith("present:") && /3DS device data/.test(s))).toBe(true);
  });

  it("a visible 3DS challenge frame with a code box asks for the code", () => {
    const acs = "https://acs.bank.example/challenge";
    const stripe = "https://js.stripe.com/v3/three-ds-2-challenge-abc.html";
    const snap = S("https://shop.example/checkout", [
      ...lots(3),
      iframe(stripe, { x: 340, y: 80, width: 600, height: 600 }, [
        E("p", {}, ["We sent a one-time passcode to your phone ending in 4321."]),
        E("input", { name: "otp", maxlength: "6", inputmode: "numeric" }, [], { ref: "f2e1", rect: { x: 400, y: 300, width: 200, height: 30 } }),
        E("button", {}, ["Submit"]),
      ], {}, "stripeframe"),
    ]);
    const r = classify({ snapshot: snap, frameUrls: [snap.url, stripe, acs] });
    expect(r).toMatchObject({ category: "payment_3ds", vendor: "stripe", blocking: true, needs: "code" });
    expect(r.input).toMatchObject({ kind: "code", length: 6, digitsOnly: true, fieldRefs: ["f2e1"] });
    expect(r.input?.hint).toMatch(/ending in 4321/);
  });

  it("an iframe named threeDSIframe (Adyen) is a 3DS challenge when visible", () => {
    const snap = S("https://shop.example/pay", [...lots(3), iframe("https://acs.issuer.example/creq", { x: 300, y: 100, width: 500, height: 600 }, [], { name: "threeDSIframe" })]);
    expect(classify({ snapshot: snap, frameUrls: [snap.url, "https://acs.issuer.example/creq"] })).toMatchObject({ category: "payment_3ds", blocking: true });
  });

  it("Duo prompt frame is a push approval", () => {
    const duo = "https://api-1a2b3c4d.duosecurity.com/frame/v4/auth/prompt?sid=x";
    expect(classify({ url: "https://vpn.example/", frameUrls: ["https://vpn.example/", duo] })).toMatchObject({ category: "push_approval", vendor: "duo", needs: "approve_on_device" });
  });

  it("identity providers in the main frame are login walls; as subframes they are buttons", () => {
    for (const url of [
      "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      "https://login.live.com/login.srf",
      "https://appleid.apple.com/sign-in",
      "https://acme.okta.com/",
      "https://acme.us.auth0.com/u/login?state=x",
      "https://github.com/login",
      "https://github.com/login/oauth/authorize?client_id=x",
      "https://acme.onelogin.com/login2",
      "https://auth.pingone.com/env/as/authorize?client_id=x",
      "https://acme.auth.us-east-1.amazoncognito.com/login?client_id=x",
      "https://sso.acme.example/realms/main/protocol/openid-connect/auth?client_id=x",
    ]) {
      expect(classify({ url }), url).toMatchObject({ category: "login", blocking: true });
    }
    const gsi = "https://accounts.google.com/gsi/button?theme=outline&client_id=x";
    const snap = S("https://news.example/", [...lots(10), iframe(gsi, { x: 900, y: 10, width: 200, height: 40 })]);
    expect(classify({ snapshot: snap, frameUrls: [snap.url, gsi] }).category).toBe("none");
    // The Okta dashboard is not a login wall.
    expect(classify({ url: "https://acme.okta.com/app/UserHome" }).category).toBe("none");
  });

  it("an IdP page showing a number-matching prompt is a push approval with the number", () => {
    const snap = S("https://login.microsoftonline.com/common/login", [
      E("div", { role: "heading", id: "idDiv_SAOTCAS_Title" }, ["Approve sign in request"], { role: "heading" }),
      E("div", { id: "idDiv_SAOTCAS_Description" }, ["Open your Authenticator app, and enter the number shown to sign in."]),
      E("div", { id: "idRichContext_DisplaySign", class: "displaySign" }, ["42"], { rect: { x: 500, y: 300, width: 80, height: 60 } }),
      E("a", { href: "#" }, ["I can't use my Microsoft Authenticator app right now"]),
    ], { title: "Sign in to your account" });
    const r = classify({ snapshot: snap, frameUrls: [snap.url] });
    expect(r).toMatchObject({ category: "push_approval", blocking: true, needs: "approve_on_device", displayNumber: "42" });
  });

  it("a frame reported but absent from the snapshot is hidden (presence only)", () => {
    const snap = S("https://a.example/", [...lots(5)]);
    const r = classify({ snapshot: snap, frameUrls: [snap.url, BFRAME] });
    expect(r.category).toBe("none");
  });
});

// ---------------------------------------------------------------- tier C over built trees

describe("tier C: snapshot", () => {
  it("split six-box OTP with masked phone hint", () => {
    const boxes = Array.from({ length: 6 }, (_, i) => E("input", { type: "text", maxlength: "1", inputmode: "numeric", "aria-label": `Digit ${i + 1}` }, [], { ref: `e${i + 1}`, rect: { x: 400 + i * 50, y: 300, width: 40, height: 48 } }));
    const snap = S("https://a.example/verify", [E("h1", {}, ["Enter verification code"]), E("p", {}, ["Enter the 6-digit code we sent to ", E("b", {}, ["•••1234"]), "."]), E("div", { class: "otp" }, boxes), E("button", {}, ["Verify"])]);
    const r = classify({ snapshot: snap });
    expect(r).toMatchObject({ category: "otp", blocking: true, needs: "code" });
    expect(r.input).toMatchObject({ kind: "code", length: 6, digitsOnly: true, fieldRefs: ["e1", "e2", "e3", "e4", "e5", "e6"] });
    expect(r.input?.hint).toContain("•••1234");
  });

  it("says where a code's length came from: boxes and the page's text are exact, a lone field's maxlength only a bound (K6)", () => {
    const boxes = Array.from({ length: 6 }, (_, i) => E("input", { type: "text", maxlength: "1", inputmode: "numeric", "aria-label": `Digit ${i + 1}` }, [], { ref: `e${i + 1}`, rect: { x: 400 + i * 50, y: 300, width: 40, height: 48 } }));
    const split = S("https://a.example/verify", [E("h1", {}, ["Enter verification code"]), E("div", { class: "otp" }, boxes)]);
    expect(classify({ snapshot: split }).input).toMatchObject({ length: 6, lengthFrom: "boxes" });
    const loose = S("https://a.example/two-factor", [E("h1", {}, ["Two-factor authentication"]), E("p", {}, ["Enter the code from your authenticator app."]), E("input", { autocomplete: "one-time-code", maxlength: "8", inputmode: "numeric" }, [], { ref: "e2" })]);
    expect(classify({ snapshot: loose }).input).toMatchObject({ length: 8, lengthFrom: "maxlength" });
    const said = S("https://a.example/two-factor", [E("h1", {}, ["Two-factor authentication"]), E("p", {}, ["Enter the 6-digit code from your authenticator app."]), E("input", { autocomplete: "one-time-code", maxlength: "6", inputmode: "numeric" }, [], { ref: "e2" })]);
    expect(classify({ snapshot: said }).input).toMatchObject({ length: 6, lengthFrom: "text" });
    const textOnly = S("https://a.example/two-factor", [E("h1", {}, ["Two-factor authentication"]), E("p", {}, ["Enter the 6-digit code from your authenticator app."]), E("input", { autocomplete: "one-time-code", inputmode: "numeric" }, [], { ref: "e2" })]);
    expect(classify({ snapshot: textOnly }).input).toMatchObject({ length: 6, lengthFrom: "text" });
  });

  it("autocomplete=one-time-code", () => {
    const snap = S("https://a.example/sessions/two-factor", [E("h1", {}, ["Two-factor authentication"]), E("label", {}, ["Authentication code"]), E("input", { autocomplete: "one-time-code", inputmode: "numeric", maxlength: "6", name: "app_otp" }, [], { ref: "e3" }), E("p", {}, ["Open your two-factor authenticator (TOTP) app or browser extension to view your authentication code."])]);
    const r = classify({ snapshot: snap });
    expect(r.category).toBe("otp");
    expect(r.input).toMatchObject({ length: 6, digitsOnly: true, fieldRefs: ["e3"], hint: "authenticator app" });
  });

  it("a code prompt's label: the field's own when it names a channel, else the heading above it; never link text", () => {
    const backup = S("https://a.example/two-step", [E("h1", {}, ["Two-step verification"]), E("p", {}, ["Enter a backup code to sign in."]), E("form", {}, [E("input", { name: "code", "aria-label": "Backup code" }, [], { ref: "e3" }), E("button", {}, ["Verify"])])]);
    expect(classify({ snapshot: backup }).input).toMatchObject({ fieldRefs: ["e3"], label: "Backup code" });
    const boxes = Array.from({ length: 6 }, (_, i) => E("input", { type: "text", maxlength: "1", inputmode: "numeric", "aria-label": `Digit ${i + 1}` }, [], { ref: `e${i + 1}`, rect: { x: 400 + i * 50, y: 300, width: 40, height: 48 } }));
    const app = S("https://a.example/verify", [E("h1", {}, ["Enter the code from your authenticator app"]), E("div", { class: "otp" }, boxes)]);
    expect(classify({ snapshot: app }).input?.label).toBe("Enter the code from your authenticator app");
    // An email-code page that also links to a backup code and to a text message: the label is the
    // heading, and the hint is where the page says the code went, not a link's words.
    const email = S("https://a.example/verify", [
      E("h1", {}, ["Check your email"]),
      E("p", {}, ["We emailed a 6-digit code to a•••@example.com."]),
      E("form", {}, [E("input", { autocomplete: "one-time-code", maxlength: "6", "aria-label": "Verification code" }, [], { ref: "e4" }), E("button", {}, ["Verify"])]),
      E("p", {}, [E("a", { href: "/sms" }, ["Text •••1234 instead"]), " or ", E("a", { href: "/backup" }, ["use a backup code"])]),
    ]);
    const r = classify({ snapshot: email });
    expect(r.input).toMatchObject({ label: "Check your email", fieldRefs: ["e4"] });
    expect(r.input?.hint).toContain("a•••@example.com");
    // A link that names the authenticator app is a choice, not where this code went.
    const sms = S("https://a.example/verify", [E("h1", {}, ["Verify it's you"]), E("p", {}, ["Enter the code we sent you."]), E("form", {}, [E("input", { autocomplete: "one-time-code", maxlength: "6" }, [], { ref: "e5" })]), E("a", { href: "/app" }, ["Use your authenticator app instead"])]);
    expect(classify({ snapshot: sms }).input?.hint).not.toBe("authenticator app");
  });

  it("an unticked 'Remember this device' box beside the code field is offered for ticking; a ticked or unrelated one is not", () => {
    const mk = (checked: boolean, label = "Don't ask again on this device") =>
      S("https://a.example/checkpoint", [
        E("h1", {}, ["Two-step verification"]),
        E("p", {}, ["Enter the 6-digit code from your authenticator app."]),
        E("form", {}, [E("input", { autocomplete: "one-time-code", maxlength: "6" }, [], { ref: "e3" }), E("label", {}, [E("input", { type: "checkbox", name: "trust" }, [], { ref: "e4", checked }), label]), E("button", {}, ["Verify"])]),
      ]);
    expect(classify({ snapshot: mk(false) }).input?.rememberRef).toBe("e4");
    expect(classify({ snapshot: mk(false, "Remember this browser") }).input?.rememberRef).toBe("e4");
    expect(classify({ snapshot: mk(false, "Keep me signed in") }).input?.rememberRef).toBe("e4");
    expect(classify({ snapshot: mk(true) }).input?.rememberRef).toBeUndefined();
    expect(classify({ snapshot: mk(false, "Send me product news") }).input?.rememberRef).toBeUndefined();
  });

  it("login page: password in view on a login URL", () => {
    const snap = S("https://a.example/login", [E("h1", {}, ["Sign in to Acme"]), E("input", { type: "email", autocomplete: "username", name: "email" }), E("input", { type: "password", autocomplete: "current-password", name: "password" }), E("button", {}, ["Sign in"])], { title: "Sign in · Acme" });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "login", blocking: true, needs: "login_in_live_view" });
  });

  it("a password field in a modal dialog over a content page blocks", () => {
    const snap = S("https://news.example/story", [...lots(40), E("div", { role: "dialog", "aria-modal": "true" }, [E("input", { type: "email" }), E("input", { type: "password" }), E("button", {}, ["Log in"])], { role: "dialog", rect: { x: 400, y: 200, width: 400, height: 300 } })], { title: "Big story" });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "login", blocking: true });
  });

  it("a sidebar login form on a content page is not blocking", () => {
    const snap = S("https://forum.example/thread/42", [...lots(60), E("aside", {}, [E("h3", {}, ["Log in"]), E("input", { type: "text", name: "username" }), E("input", { type: "password", name: "password" }), E("button", {}, ["Log in"])])], { title: "Best tomato varieties - Garden Forum" });
    const r = classify({ snapshot: snap });
    expect(r.blocking).toBe(false);
    expect(["none", "login"]).toContain(r.category);
  });

  it("a header 'Sign in' link is not a login wall", () => {
    const snap = S("https://news.example/", [E("header", {}, [E("a", { href: "/" }, ["Home"]), E("a", { href: "/login" }, ["Sign in"])]), ...lots(30)], { title: "News" });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "none", blocking: false });
  });

  it("sign-up form (new-password) is not a login wall", () => {
    const snap = S("https://a.example/join", [E("h1", {}, ["Create your account"]), E("input", { type: "email", autocomplete: "email" }), E("input", { type: "password", autocomplete: "new-password" }), E("button", {}, ["Sign up"])]);
    const r = classify({ snapshot: snap });
    expect(r.category).toBe("none");
    expect(r.signals).toContain("present:sign-up form (new-password)");
  });

  it("newsletter email field and search box are neither login nor OTP", () => {
    const snap = S("https://blog.example/post", [E("form", { role: "search" }, [E("input", { type: "search", name: "q", maxlength: "6" })]), ...lots(20), E("h2", {}, ["Subscribe to our newsletter"]), E("input", { type: "email", name: "email", autocomplete: "email", placeholder: "you@example.com" }), E("button", {}, ["Subscribe"]), E("input", { name: "coupon_code", maxlength: "8", placeholder: "Coupon code" }), E("input", { name: "zip", maxlength: "5", inputmode: "numeric" })], { title: "Blog post" });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "none", blocking: false });
  });

  it("Cloudflare 1020 / Akamai / Incapsula block pages are hard blocks", () => {
    const cf = S("https://a.example/", [E("h1", {}, ["Sorry, you have been blocked"]), E("h2", {}, ["You are unable to access a.example"]), E("p", {}, ["Cloudflare Ray ID: 8f2b1c3d4e5f6a7b"])], { title: "Attention Required! | Cloudflare" });
    expect(classify({ snapshot: cf, response: { url: cf.url, status: 403, headers: { server: "cloudflare" } } })).toMatchObject({ category: "hard_block", vendor: "cloudflare", needs: "none_possible", blocking: true });
    const ak = S("https://a.example/", [E("h1", {}, ["Access Denied"]), E("p", {}, ["You don't have permission to access \"http://a.example/\" on this server."]), E("p", {}, ["Reference #18.2d351ab8.1729600000.5f3c2a1"])], { title: "Access Denied" });
    expect(classify({ snapshot: ak })).toMatchObject({ category: "hard_block", vendor: "akamai" });
    const inc = S("https://a.example/", [E("p", {}, ["Request unsuccessful. Incapsula incident ID: 1234000560012345678-123456789012345678"])]);
    expect(classify({ snapshot: inc })).toMatchObject({ category: "hard_block", vendor: "imperva" });
  });

  it("a HUMAN Press & Hold drawn over a full results page is an in-page captcha with its box; a hidden one is nothing", () => {
    const rect = { x: 485, y: 310, width: 310, height: 100 };
    const results = (pxExtra: Partial<InterruptNode>) =>
      S("https://www.zillow.com/austin-tx-78704/", [E("h1", {}, ["78704 Real Estate & Homes For Sale"]), ...lots(30, "Listing"), E("div", { id: "px-captcha" }, [], { rect, ...pxExtra })], { title: "78704 Real Estate - Zillow" });
    const shown = classify({ snapshot: results({}), cookies: ["_px3", "_pxvid"] });
    expect(shown).toMatchObject({ category: "captcha", vendor: "human", blocking: false, inPage: true, rect });
    expect(classify({ snapshot: results({ visible: false }), cookies: ["_px3"] })).toMatchObject({ category: "none", blocking: false });
    expect(classify({ snapshot: results({ visible: false }) }).inPage).toBeUndefined();
    expect(classify({ snapshot: results({ rect: { x: 0, y: 0, width: 0, height: 0 } }) }).category).toBe("none");
  });

  it("an in-page Press & Hold names its node, also when it is drawn in a frame of its own over the results (T2, 31 Oct)", () => {
    const rect = { x: 485, y: 310, width: 310, height: 100 };
    const inMain = S("https://www.zillow.com/homes/for_sale/78704_rb/", [E("h1", {}, ["78704 Real Estate & Homes For Sale"]), ...lots(30, "Listing"), E("div", { id: "px-captcha" }, [], { rect, backendNodeId: 812 })]);
    expect(classify({ snapshot: inMain, cookies: ["_px3"] })).toMatchObject({ category: "captcha", vendor: "human", inPage: true, rect, widget: { backendNodeId: 812, frameId: "main" } });
    // The modal as a full-page frame over the results: the press handler must find the node in that frame.
    const modal = iframe("about:blank", { x: 0, y: 0, width: 1280, height: 800 }, [E("h2", {}, ["Before we continue..."]), E("p", {}, ["Press & Hold to confirm you are a human (and not a bot)."]), E("div", { id: "px-captcha" }, [], { rect, backendNodeId: 977 })], {}, "pxmodal");
    const framed = S("https://www.zillow.com/homes/for_sale/78704_rb/", [E("h1", {}, ["78704 Real Estate & Homes For Sale"]), ...lots(30, "Listing"), modal]);
    expect(classify({ snapshot: framed, cookies: ["_px3"] })).toMatchObject({ category: "captcha", vendor: "human", inPage: true, widget: { backendNodeId: 977, frameId: "pxmodal" } });
    // A node without an id (a hand-built tree) still gets its box, with no widget node.
    expect(classify({ snapshot: S("https://a.example/", [E("h1", {}, ["Access to this page has been denied"]), E("div", { id: "px-captcha" }, [], { rect })]) }).widget).toBeUndefined();
  });

  it("the denied page's #px-captcha and a visible embedded Turnstile carry inPage and the widget box", () => {
    const rect = { x: 400, y: 300, width: 310, height: 100 };
    const denied = S("https://a.example/", [E("h1", {}, ["Access to this page has been denied"]), E("div", { id: "px-captcha" }, [], { rect })]);
    expect(classify({ response: { url: denied.url, status: 403, headers: {} }, cookies: ["_px3"], snapshot: denied })).toMatchObject({ category: "captcha", vendor: "human", blocking: true, inPage: true, rect });
    expect(classify({ snapshot: denied })).toMatchObject({ category: "captcha", vendor: "human", inPage: true, rect });
    const ts = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAA/light/fbE/new/normal/auto/";
    const tsRect = { x: 20, y: 300, width: 300, height: 65 };
    const form = S("https://a.example/newsletter", [...lots(8), E("form", {}, [E("input", { type: "email", name: "email" }), iframe(ts, tsRect), E("button", {}, ["Subscribe"])])], { title: "Blog" });
    expect(classify({ snapshot: form, frameUrls: [form.url, ts] })).toMatchObject({ category: "captcha", vendor: "cloudflare", blocking: false, inPage: true, rect: tsRect });
    const gate = S("https://a.example/", [E("h1", {}, ["a.example"]), E("p", {}, ["Verify you are human by completing the action below."]), iframe(ts, tsRect)], { title: "Just a moment..." });
    expect(classify({ snapshot: gate, frameUrls: [gate.url, ts] })).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, inPage: true, rect: tsRect });
    // Header-only verdicts have no widget to point at.
    expect(classify({ response: { url: "https://a.example/", status: 403, headers: { "cf-mitigated": "challenge" } } }).inPage).toBeUndefined();
  });

  it("a check its response gave away (cf-mitigated) carries its Turnstile frame's box once one is drawn, and none while it is not (fourth review)", () => {
    const ts = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAA/light/fbE/new/normal/auto/";
    const tsRect = { x: 20, y: 300, width: 300, height: 65 };
    const response = { url: "https://a.example/", status: 403, headers: { "cf-mitigated": "challenge" } };
    const page = (frame: boolean) => S("https://a.example/", [E("h1", {}, ["a.example"]), E("p", {}, ["Verify you are human by completing the action below."]), ...(frame ? [iframe(ts, tsRect)] : [])], { title: "Just a moment..." });
    const drawn = classify({ response, snapshot: page(true), frameUrls: [response.url, ts] });
    expect(drawn).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, inPage: true, rect: tsRect });
    // Tier A's verdict, with nothing tier B would have noted.
    expect(drawn.signals).toEqual(["cf-mitigated: challenge (403)"]);
    // The frame taken off after a refused click: the same check, with no widget on it.
    const off = classify({ response, snapshot: page(false), frameUrls: [response.url] });
    expect(off).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true });
    expect(off.inPage).toBeUndefined();
  });

  it("a Turnstile frame on the site's own /cdn-cgi/challenge-platform/…/turnstile/ path is drawn as one on Cloudflare's host is, as the built-in click takes it (fifth review)", () => {
    const own = "https://a.example/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAA/light/fbE/new/normal/auto/";
    const tsRect = { x: 20, y: 300, width: 300, height: 65 };
    const response = { url: "https://a.example/", status: 403, headers: { "cf-mitigated": "challenge" } };
    const page = (src: string) => S("https://a.example/", [E("h1", {}, ["a.example"]), E("p", {}, ["Verify you are human by completing the action below."]), iframe(src, tsRect)], { title: "Just a moment..." });
    expect(classify({ response, snapshot: page(own), frameUrls: [response.url, own] })).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, inPage: true, rect: tsRect });
    // Another frame under the challenge platform is no Turnstile widget.
    const other = "https://a.example/cdn-cgi/challenge-platform/scripts/jsd/main.js";
    expect(classify({ response, snapshot: page(other), frameUrls: [response.url, other] }).inPage).toBeUndefined();
  });

  it("HUMAN's denied text on a page served 403 with no widget is its block page, whatever the page's size or title (fourth review)", () => {
    const page = S("https://a.example/", [E("h1", {}, ["Access to this page has been denied"]), ...lots(20, "Footer")], { title: "Homes" });
    expect(classify({ response: { url: page.url, status: 403, headers: {} }, snapshot: page })).toMatchObject({ category: "hard_block", vendor: "human" });
    // Served 200, the same text on a full page is no block page.
    expect(classify({ response: { url: page.url, status: 200, headers: {} }, snapshot: page }).category).not.toBe("hard_block");
  });

  it("Cloudflare challenge text without headers is still a bot challenge", () => {
    const snap = S("https://a.example/", [E("h1", {}, ["a.example"]), E("p", {}, ["Performing security verification"]), E("p", {}, ["This website uses a security service to protect against malicious bots."])], { title: "Just a moment..." });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", autoResolvable: true });
  });

  it("push approval with number in text (Okta)", () => {
    const snap = S("https://acme.okta.com/signin/verify/okta/push", [E("h2", {}, ["Get a push notification"]), E("p", {}, ["On your mobile device, open the Okta Verify prompt, then tap 37 in Okta Verify to continue."])], { title: "Acme - Sign In" });
    expect(classify({ snapshot: snap })).toMatchObject({ category: "push_approval", displayNumber: "37" });
  });

  it("magic link: sign-in link sent; newsletter confirmation is not", () => {
    const ml = S("https://a.example/login/check-email", [E("h1", {}, ["Check your email"]), E("p", {}, ["We sent a sign-in link to j•••@example.com. Click the link in the email to log in."])]);
    expect(classify({ snapshot: ml })).toMatchObject({ category: "magic_link", needs: "approve_on_device", input: { kind: "link" } });
    const nl = S("https://blog.example/newsletter/thanks", [...lots(6), E("h1", {}, ["Thanks for subscribing!"]), E("p", {}, ["Check your inbox to confirm your subscription."])], { title: "Blog" });
    expect(classify({ snapshot: nl }).category).toBe("none");
  });

  it("passkey prompt with no text inputs", () => {
    const snap = S("https://accounts.example/signin/challenge/pk", [E("h1", {}, ["Use your passkey to confirm it's really you"]), E("p", {}, ["Your device will ask for your fingerprint, face, or screen lock"]), E("button", {}, ["Continue"]), E("button", {}, ["Try another way"])]);
    expect(classify({ snapshot: snap })).toMatchObject({ category: "passkey", blocking: true });
  });

  it("content pages that merely talk about verification, codes or approvals are not auth steps", () => {
    const howto = S("https://help.example/articles/verify-account", [
      E("h1", {}, ["How to verify your account"]),
      ...lots(25, "Help"),
      E("p", {}, ["Check your email for the verification code, then enter the code in the app."]),
      E("input", { type: "text", name: "feedback", placeholder: "Was this helpful?" }),
    ], { title: "How to verify your account - Help Center" });
    expect(classify({ snapshot: howto })).toMatchObject({ category: "none", blocking: false });
    const approvals = S("https://hr.example/requests/123", [E("h1", {}, ["Leave request #123"]), E("p", {}, ["Approve the request or send it back."]), E("button", {}, ["Approve request"]), E("button", {}, ["Reject"])], { title: "Approve request" });
    expect(classify({ snapshot: approvals }).category).toBe("none");
  });

  it("a response for another document is ignored (SPA navigated away)", () => {
    const snap = S("https://a.example/app/home", [...lots(10)]);
    const r = classify({ snapshot: snap, response: { url: "https://a.example/landing", status: 403, headers: { "cf-mitigated": "challenge" } } });
    expect(r.category).toBe("none");
  });

  it("FedCM dialog is non-blocking", () => {
    const snap = S("https://news.example/", [...lots(10)]);
    expect(classify({ snapshot: snap, fedcmDialog: { dialogType: "AccountChooser" } })).toMatchObject({ category: "fedcm", blocking: false, autoResolvable: true });
  });

  it("classifies a 10k-node snapshot quickly", () => {
    const big = S("https://news.example/", lots(3300));
    // Minimum of several runs: robust to other processes competing for the CPU.
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      classify({ snapshot: big, frameUrls: [big.url] });
      best = Math.min(best, performance.now() - t0);
    }
    expect(big.nodes.length).toBeGreaterThan(9000);
    expect(best).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------- resume predicates

describe("isResolved", () => {
  it("captcha: token filled resolves an inline widget; a gate needs the challenge gone plus a navigation or clearance", () => {
    const ts = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4/light/fbE/new/normal/auto/";
    const mk = (token: string) => S("https://a.example/signup", [...lots(8), iframe(ts, { x: 20, y: 300, width: 300, height: 65 }), E("input", { type: "hidden", name: "cf-turnstile-response" }, [], { visible: false, value: token })]);
    expect(isResolved("captcha", { snapshot: mk(""), frameUrls: ["https://a.example/signup", ts] }, { snapshot: mk("0.abc"), frameUrls: ["https://a.example/signup", ts] })).toBe(true);
    expect(isResolved("captcha", { snapshot: mk(""), frameUrls: ["https://a.example/signup", ts] }, { snapshot: mk(""), frameUrls: ["https://a.example/signup", ts] })).toBe(false);

    const gate = { response: { url: "https://a.example/", status: 403, headers: { "cf-mitigated": "challenge" } }, url: "https://a.example/", navigatedAt: 1, cookies: ["__cf_bm"] } satisfies InterruptInput;
    const same = { ...gate, navigatedAt: 1 };
    const passed = { response: { url: "https://a.example/", status: 200, headers: {} }, url: "https://a.example/", navigatedAt: 2, cookies: ["__cf_bm", { name: "cf_clearance", value: "h1" }] } satisfies InterruptInput;
    expect(isResolved("bot_challenge", gate, same)).toBe(false);
    const ex = explainResolution("bot_challenge", gate, passed);
    expect(ex.resolved).toBe(true);
    expect(ex.signals).toEqual(expect.arrayContaining(["main-frame navigation", "clearance cookie cf_clearance set"]));
  });

  it("captcha: a block page, or the check's own widget still drawn, is no way past it, whatever cookie changed (fourth review)", () => {
    const rect = { x: 400, y: 300, width: 310, height: 100 };
    const url = "https://www.zillow.com/homes/";
    const denied = (widget: boolean) => S(url, [E("h1", {}, ["Access to this page has been denied"]), ...(widget ? [E("div", { id: "px-captcha" }, [], { rect })] : [])], { title: "Access to this page has been denied" });
    const check = { response: { url, status: 403, headers: {} }, url, navigatedAt: 1, cookies: [{ name: "_px3", value: "seen" }], snapshot: denied(true) } satisfies InterruptInput;
    // HUMAN took its widget off after a hold and its collector rewrote _px3: its block page with no widget on it.
    const bare = { ...check, cookies: [{ name: "_px3", value: "rewritten" }], snapshot: denied(false) } satisfies InterruptInput;
    expect(explainResolution("captcha", check, bare)).toMatchObject({ resolved: false, signals: expect.arrayContaining([expect.stringMatching(/^block page: /), "clearance cookie _px3 changed"]) });
    // Another vendor's block page after a reload is none either; the results the reload brings are.
    const blocked = { response: { url, status: 403, headers: {} }, url, navigatedAt: 2, cookies: [{ name: "_px3", value: "passed" }], snapshot: S(url, [E("h1", {}, ["Sorry, you have been blocked"]), E("p", {}, ["You are unable to access zillow.com"]), E("p", {}, ["Cloudflare Ray ID: 8f2b1c"])], { title: "Attention Required! | Cloudflare" }) } satisfies InterruptInput;
    expect(isResolved("captcha", check, blocked)).toBe(false);
    const results = { response: { url, status: 200, headers: {} }, url, navigatedAt: 2, cookies: [{ name: "_px3", value: "passed" }], snapshot: S(url, [E("h1", {}, ["78704 Homes"]), ...lots(20, "Listing")]) } satisfies InterruptInput;
    expect(isResolved("captcha", check, results)).toBe(true);
    // HUMAN's in-page check over results rewrites _px3 as the pointer moves: not passed while its widget is drawn.
    const over = (widget: boolean, value: string) =>
      ({ url, cookies: [{ name: "_px3", value }], snapshot: S(url, [E("h1", {}, ["78704 Real Estate & Homes For Sale"]), ...lots(30, "Listing"), ...(widget ? [E("div", { id: "px-captcha" }, [], { rect })] : [])], { title: "78704 Real Estate - Zillow" }) }) satisfies InterruptInput;
    expect(isResolved("captcha", over(true, "a"), over(true, "b"))).toBe(false);
    expect(isResolved("captcha", over(true, "a"), over(false, "b"))).toBe(true);
  });

  it("login: fields gone and off the login path", () => {
    const login = S("https://a.example/login", [E("h1", {}, ["Sign in"]), E("input", { type: "password" }), E("button", {}, ["Sign in"])]);
    const home = S("https://a.example/dashboard", [...lots(10)]);
    const stillLoginPath = S("https://a.example/login", [E("p", {}, ["Redirecting…"])]);
    expect(isResolved("login", { snapshot: login }, { snapshot: home })).toBe(true);
    expect(isResolved("login", { snapshot: login }, { snapshot: stillLoginPath })).toBe(false);
    expect(isResolved("login", { snapshot: login }, { snapshot: login })).toBe(false);
  });

  it("login: a password that led to a code, an approval or a checkpoint is not signed in yet", () => {
    const login = S("https://a.example/login", [E("h1", {}, ["Sign in"]), E("input", { type: "password" }), E("button", {}, ["Sign in"])]);
    const pin = S("https://a.example/checkpoint/challenge/AgX1", [E("h1", {}, ["Let's do a quick verification"]), E("p", {}, ["Enter the code we sent to j•••@example.com."]), E("input", { name: "pin", maxlength: "6", inputmode: "numeric" }, [], { ref: "e2" })]);
    const pinElsewhere = S("https://a.example/home", [E("h1", {}, ["Enter verification code"]), E("p", {}, ["Enter the 6-digit code we sent to •••1234."]), E("input", { autocomplete: "one-time-code", maxlength: "6" }, [], { ref: "e2" })]);
    const push = S("https://a.example/session/approve", [E("h1", {}, ["Check your phone"]), E("p", {}, ["Tap Yes on the notification to continue."])]);
    const checkpoint = S("https://a.example/checkpoint/lg/remember", [E("h1", {}, ["Remember this browser?"]), E("button", {}, ["Yes"]), E("button", {}, ["Not now"])]);
    const home = S("https://a.example/feed", [...lots(10)]);
    expect(isResolved("login", { snapshot: login }, { snapshot: pin })).toBe(false);
    expect(explainResolution("login", { snapshot: login }, { snapshot: pinElsewhere })).toMatchObject({ resolved: false, signals: expect.arrayContaining(["now otp"]) });
    expect(isResolved("login", { snapshot: login }, { snapshot: push })).toBe(false);
    expect(explainResolution("login", { snapshot: login }, { snapshot: checkpoint })).toMatchObject({ resolved: false, signals: expect.arrayContaining(["on a verification path"]) });
    expect(isResolved("login", { snapshot: login }, { snapshot: home })).toBe(true);
  });

  it("login: back on a checkout or account page whose path says confirm or verify is signed in; a sign-in step there is not", () => {
    const login = S("https://shop.example.com/login", [E("h1", {}, ["Sign in"]), E("input", { type: "password" }), E("button", {}, ["Sign in"])]);
    for (const [url, title, h1] of [
      ["https://shop.example.com/checkout/confirm", "Review your order", "Confirm your order"],
      ["https://shop.example.com/confirm-order", "Shop", "Place your order"],
      ["https://shop.example.com/account/verify-email", "Shop", "Please verify your email address"],
    ] as const) {
      const after = S(url, [E("h1", {}, [h1]), ...lots(6, "Order")], { title });
      expect(isResolved("login", { snapshot: login }, { snapshot: after }), url).toBe(true);
    }
    // "/verify" that is still a sign-in step (its heading or title says so), and auth-only paths.
    const step = S("https://shop.example.com/account/verify", [E("h1", {}, ["Verify it's you"]), E("p", {}, ["Approve the sign-in on your phone to continue."])]);
    expect(explainResolution("login", { snapshot: login }, { snapshot: step })).toMatchObject({ resolved: false, signals: expect.arrayContaining(["on a verification path"]) });
    const titled = S("https://shop.example.com/challenge", [...lots(6, "Order")], { title: "Two-step verification" });
    expect(isResolved("login", { snapshot: login }, { snapshot: titled })).toBe(false);
    const mfa = S("https://shop.example.com/mfa/setup", [...lots(6, "Order")], { title: "Shop" });
    expect(isResolved("login", { snapshot: login }, { snapshot: mfa })).toBe(false);
  });

  it("isAuthUrl: identity providers and login, 2FA, verify, checkpoint and challenge paths", () => {
    for (const u of ["https://www.linkedin.com/checkpoint/challenge/AgX1", "https://a.example/login?next=/", "https://a.example/users/sign_in", "https://a.example/account/verify", "https://a.example/mfa", "https://accounts.google.com/v3/signin/challenge/pwd", "https://www.google.com/sorry/index"]) expect(isAuthUrl(u), u).toBe(true);
    for (const u of ["https://www.linkedin.com/feed/", "https://a.example/account/orders", "https://blog.example/how-to-fix-login-problems", "not a url"]) expect(isAuthUrl(u), u).toBe(false);
  });

  it("otp / push: prompt gone", () => {
    const otp = S("https://a.example/verify", [E("p", {}, ["Enter the verification code"]), E("input", { autocomplete: "one-time-code", maxlength: "6" })]);
    const done = S("https://a.example/home", [...lots(5)]);
    expect(isResolved("otp", { snapshot: otp }, { snapshot: otp })).toBe(false);
    expect(isResolved("otp", { snapshot: otp }, { snapshot: done })).toBe(true);
    const push = S("https://a.example/mfa", [E("h1", {}, ["Check your phone"]), E("p", {}, ["Tap Yes on the notification to sign in."])]);
    expect(isResolved("push_approval", { snapshot: push }, { snapshot: push })).toBe(false);
    expect(isResolved("push_approval", { snapshot: push }, { snapshot: done })).toBe(true);
  });

  it("3DS: issuer frame gone; http_auth: no 401", () => {
    const f = ["https://shop.example/pay", "https://centinelapi.cardinalcommerce.com/V2/Cruise/StepUp"];
    expect(isResolved("payment_3ds", { frameUrls: f, url: f[0] }, { frameUrls: f, url: f[0] })).toBe(false);
    expect(isResolved("payment_3ds", { frameUrls: f, url: f[0] }, { frameUrls: [f[0]!], url: f[0] })).toBe(true);
    const a = { response: { url: "https://a.example/", status: 401, headers: { "www-authenticate": "Basic" } } };
    expect(isResolved("http_auth", a, a)).toBe(false);
    expect(isResolved("http_auth", a, { response: { url: "https://a.example/", status: 200, headers: {} } })).toBe(true);
  });
});
