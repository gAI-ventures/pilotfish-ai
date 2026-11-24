// Interruption classifier: decides, deterministically and in milliseconds (no
// model call), whether the current page is gated by something only the human
// can get past — a CAPTCHA or bot challenge, a login wall, a 2FA/OTP prompt, a
// push / magic-link / passkey step, a 3-D Secure challenge, HTTP auth, or a hard
// block — so the agent can pause and hand off immediately.
//
// The classifier solves nothing and evades nothing: it only tells the agent what
// is in the way, so the agent can stop and ask (or pass the check to a handler
// the host registers, challenges.ts).
//
// Tiers run in order and stop at the first BLOCKING hit:
//   0/A  main-document response (status, headers, cookies) and input flags
//   B    frame URLs (vendor widgets, 3DS issuers, IdP hosts in the main frame)
//   C    the perception Snapshot (forms, visible text, DOM markers)
// "Present" is kept apart from "blocking": a reCAPTCHA v3 badge, DataDome or
// Akamai cookies on a normal page, a hidden 3DS device-data frame or a "Sign in"
// link in a header are reported as `present:` signals only. A visible widget
// that does not gate the page (a checkbox CAPTCHA inside a sign-up form, a login
// form in a sidebar) is returned with its category and `blocking: false`.
// Tier C favours precision over recall.

// ------------------------------------------------------------------ types

export type InterruptCategory =
  | "none"
  | "captcha"
  | "bot_challenge"
  | "hard_block"
  | "login"
  | "otp"
  | "push_approval"
  | "magic_link"
  | "passkey"
  | "payment_3ds"
  | "http_auth"
  | "fedcm";

export type InterruptNeeds =
  | "nothing"
  | "solve_in_live_view"
  | "login_in_live_view"
  | "code"
  | "approve_on_device"
  | "credentials"
  | "none_possible";

/** What the human has to hand back. `link` = a magic sign-in link (paste the URL, or click it). */
export interface InterruptInputRequest {
  kind: "code" | "link";
  /** Expected code length (from maxlength, the number of split boxes, or "6-digit" in the text). */
  length?: number;
  /**
   * Where `length` came from: the split boxes or the page's text ("6-digit") are exact; a single field's
   * maxlength is only an upper bound (maxlength=8 often takes a 6-digit code).
   */
  lengthFrom?: "boxes" | "text" | "maxlength";
  digitsOnly?: boolean;
  /** Refs of the field(s) to type into (split OTP boxes in order). */
  fieldRefs?: string[];
  /** Where the code went, e.g. "We sent a code to •••1234" or "authenticator app". */
  hint?: string;
  /** The code field's own label or the heading above it ("Enter a backup code"), never link text. */
  label?: string;
  /** Ref of an unticked "Remember this device" / "Don't ask again on this browser" / "Keep me signed in" box. */
  rememberRef?: string;
}

export interface Interruption {
  category: InterruptCategory;
  vendor?: string;
  /** True when the page cannot be used until the interruption is dealt with. */
  blocking: boolean;
  /** Likely to clear on its own within seconds (JS/PoW challenge): wait and re-classify before asking. */
  autoResolvable: boolean;
  /** Why. Presence-only detections are prefixed `present:`. Never contains secret values. */
  signals: string[];
  needs: InterruptNeeds;
  input?: InterruptInputRequest;
  /** Number-matching push (Microsoft/Okta/Google/Duo/GitHub): the number shown on screen to pick on the device. */
  displayNumber?: string;
  /**
   * The check is a widget drawn in the page (a HUMAN #px-captcha Press & Hold, an embedded Turnstile)
   * rather than a vendor page of its own. Set even when `blocking` is false: the model can still read
   * the page, but the runtime's challenge ladder should deal with the widget.
   */
  inPage?: boolean;
  /** The widget's box in page CSS pixels (as in the snapshot), with `inPage`. */
  rect?: InterruptRect;
  /**
   * The widget's node in the snapshot, with `inPage`: the runtime acts on it there, where a page script
   * may not reach it (a same-process frame, a closed shadow root).
   */
  widget?: { backendNodeId: number; frameId?: string };
}

/** The main-frame document response (the last one after redirects). Header names lower-cased. */
export interface MainResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
}

export interface CookieInfo {
  name: string;
  /** Optional, only used to notice a clearance cookie changing; pass a hash if you like. */
  value?: string;
}

export interface InterruptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Structural subset of `SnapNode` the classifier reads. A real `SnapNode`
 * satisfies it; tests can build plain objects.
 */
export interface InterruptNode {
  /** The CDP node id (a real SnapNode has one; test nodes may not). */
  backendNodeId?: number;
  tag: string;
  role?: string;
  name?: string;
  attrs: Record<string, string>;
  text?: string;
  value?: string;
  /** A checkbox's live state (the snapshot's AX "checked"). */
  checked?: boolean;
  visible: boolean;
  boxless?: boolean;
  interactive?: boolean;
  isIframe?: boolean;
  rect?: InterruptRect;
  ref?: string;
  frameId?: string;
  /** The owning frame session; only `url` is read (OOPIF document URL). */
  frame?: { url?: string } | null;
  nodeType?: number;
  parent?: InterruptNode | null;
  children: InterruptNode[];
}

/** Structural subset of `Snapshot`. */
export interface InterruptSnapshot {
  url: string;
  title: string;
  viewport: { x?: number; y?: number; width: number; height: number };
  scroll?: { x: number; y: number };
  nodes: InterruptNode[];
  root?: { frameId?: string };
}

export interface InterruptInput {
  /** Main-frame document response (status + lower-cased headers). */
  response?: MainResponse | null;
  /** Every frame URL in the page: main first, then all child frames (incl. cross-origin and closed shadow roots). */
  frameUrls?: string[];
  /** Cookies for the site: names, or {name, value}. */
  cookies?: Array<string | CookieInfo>;
  snapshot?: InterruptSnapshot | null;
  /** A FedCM account chooser / sign-in dialog is showing (FedCm.dialogShown). */
  fedcmDialog?: boolean | { dialogType?: string; title?: string };
  /** The browser asked for HTTP credentials (Fetch.authRequired). */
  httpAuthRequired?: boolean | { scheme?: string; realm?: string; origin?: string };
  /** Current main-frame URL when no snapshot is passed. */
  url?: string;
  /** `page.lastNavigationAt`: lets `isResolved` notice a reload to the same URL. */
  navigatedAt?: number;
}

// ------------------------------------------------------------------ signature tables (exported for docs/tests)

type FrameKind =
  | "recaptcha-anchor"
  | "recaptcha-bframe"
  | "hcaptcha"
  | "turnstile"
  | "cf-challenge"
  | "datadome"
  | "arkose-game"
  | "arkose"
  | "awswaf"
  | "geetest"
  | "imperva"
  | "mtcaptcha"
  | "yandex"
  | "friendly"
  | "perimeterx"
  | "3ds-challenge"
  | "3ds-method"
  | "duo";

export interface FrameSignature {
  id: string;
  vendor: string;
  kind: FrameKind;
  /** Human-readable pattern (also what the report lists). */
  pattern: string;
  match: (u: URL) => boolean;
}

const hostIs = (u: URL, ...hosts: string[]) => hosts.includes(u.hostname);
const hostEnds = (u: URL, ...suffixes: string[]) => suffixes.some((s) => u.hostname === s || u.hostname.endsWith("." + s));

export const FRAME_SIGNATURES: FrameSignature[] = [
  // Google reCAPTCHA v2/v3/Enterprise (Firefox CaptchaDetectionChild: www.google.com/recaptcha/(api2|enterprise)/, bframe = challenge).
  { id: "recaptcha-bframe", vendor: "recaptcha", kind: "recaptcha-bframe", pattern: "(www.google.com|www.recaptcha.net)/recaptcha/(api2|enterprise)/bframe", match: (u) => hostIs(u, "www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net") && /^\/recaptcha\/(api2|enterprise)\/bframe/.test(u.pathname) },
  { id: "recaptcha-anchor", vendor: "recaptcha", kind: "recaptcha-anchor", pattern: "(www.google.com|www.recaptcha.net)/recaptcha/(api2|enterprise)/anchor (size=invisible = v3/invisible, presence only)", match: (u) => hostIs(u, "www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net") && /^\/recaptcha\/(api2|enterprise|api)\/(anchor|fallback)/.test(u.pathname) },
  // hCaptcha (Firefox: newassets.hcaptcha.com/captcha/v1/…/static/hcaptcha.html, #frame=checkbox|challenge, skip size=invisible / checkbox-invisible).
  { id: "hcaptcha", vendor: "hcaptcha", kind: "hcaptcha", pattern: "(newassets|assets).hcaptcha.com/captcha/v1/…/static/hcaptcha.html#frame=checkbox|challenge", match: (u) => hostEnds(u, "hcaptcha.com") && /\/captcha\/v\d+\//.test(u.pathname) },
  // Cloudflare Turnstile (Firefox regex: challenges.cloudflare.com/cdn-cgi/challenge-platform/.+?/turnstile/if/ov2/av0/rcv/), or
  // the same path served on the site's own host, as a Turnstile click handler takes it: a frame
  // the click clicked and the classifier did not see drawn read as the same bare check.
  { id: "turnstile", vendor: "cloudflare", kind: "turnstile", pattern: "(challenges.cloudflare.com or the site's own host)/cdn-cgi/challenge-platform/…/turnstile/…", match: (u) => (hostIs(u, "challenges.cloudflare.com") && /\/cdn-cgi\/challenge-platform\/.*turnstile/.test(u.pathname)) || (u.pathname.startsWith("/cdn-cgi/challenge-platform/") && u.pathname.includes("/turnstile/")) },
  // Cloudflare managed / JS challenge page: orchestrate/chl_page, or __cf_chl_* tokens in the URL.
  { id: "cf-challenge", vendor: "cloudflare", kind: "cf-challenge", pattern: "/cdn-cgi/challenge-platform/…chl_page… or ?__cf_chl_(rt_tk|tk|f_tk|captcha_tk|jschl_tk)=", match: (u) => (/\/cdn-cgi\/challenge-platform\//.test(u.pathname) && /chl_page|\/orchestrate\/(managed|jsch|captcha)/.test(u.pathname)) || /[?&]__cf_chl_\w*=/.test(u.search) },
  // DataDome (Firefox: geo.captcha-delivery.com/captcha/; t=bv = banned visitor, t=fe = captcha shown; /interstitial/ = device check).
  { id: "datadome", vendor: "datadome", kind: "datadome", pattern: "geo.captcha-delivery.com/(captcha|interstitial)/ (t=bv = hard block)", match: (u) => hostEnds(u, "captcha-delivery.com") },
  // Arkose Labs / FunCaptcha (Firefox: client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/ = the puzzle).
  { id: "arkose-game", vendor: "arkose", kind: "arkose-game", pattern: "*.arkoselabs.com/fc/assets/ec-game-core/ (puzzle shown)", match: (u) => (hostEnds(u, "arkoselabs.com", "funcaptcha.com")) && /\/fc\/assets\/ec-game-core\/|\/fc\/gc\//.test(u.pathname) },
  { id: "arkose", vendor: "arkose", kind: "arkose", pattern: "client-api.arkoselabs.com, <company>-api.arkoselabs.com, iframe.arkoselabs.com, *.funcaptcha.com, octocaptcha.com", match: (u) => hostEnds(u, "arkoselabs.com", "funcaptcha.com", "arkoselabs.cn", "octocaptcha.com") },
  // AWS WAF CAPTCHA JS API / token hosts.
  { id: "awswaf", vendor: "aws-waf", kind: "awswaf", pattern: "*.captcha.awswaf.com, *.captcha-sdk.awswaf.com, *.token.awswaf.com", match: (u) => hostEnds(u, "awswaf.com") },
  // GeeTest v3/v4.
  { id: "geetest", vendor: "geetest", kind: "geetest", pattern: "static.geetest.com, gcaptcha4.geetest.com, api.geetest.com, api.geevisit.com", match: (u) => hostEnds(u, "geetest.com", "geevisit.com") },
  // Imperva / Incapsula block & captcha iframe.
  { id: "imperva", vendor: "imperva", kind: "imperva", pattern: "/_Incapsula_Resource?…", match: (u) => /\/_Incapsula_Resource/i.test(u.pathname) },
  { id: "mtcaptcha", vendor: "mtcaptcha", kind: "mtcaptcha", pattern: "service(2)?.mtcaptcha.com/mtcv1/client/iframe.html", match: (u) => hostEnds(u, "mtcaptcha.com") },
  { id: "yandex", vendor: "yandex-smartcaptcha", kind: "yandex", pattern: "smartcaptcha.yandexcloud.net/(checkbox|advanced)", match: (u) => hostEnds(u, "smartcaptcha.yandexcloud.net", "smartcaptcha.cloud.yandex.ru", "captcha-api.yandex.ru") },
  { id: "friendly", vendor: "friendly-captcha", kind: "friendly", pattern: "*.frcapi.com, *.friendlycaptcha.com (proof-of-work, no user task)", match: (u) => hostEnds(u, "frcapi.com", "friendlycaptcha.com", "friendlycaptcha.eu") },
  { id: "perimeterx", vendor: "human", kind: "perimeterx", pattern: "*.px-cdn.net, *.px-cloud.net, *.perimeterx.net (Press & Hold renders under #px-captcha)", match: (u) => hostEnds(u, "px-cdn.net", "px-cloud.net", "perimeterx.net", "pxchk.net") },
  // 3-D Secure. Device-data / method frames are hidden and present on normal checkouts: presence only.
  { id: "stripe-3ds-method", vendor: "stripe", kind: "3ds-method", pattern: "js.stripe.com/v3/three-ds-2-fingerprint*, hooks.stripe.com/3d_secure_2/fingerprint", match: (u) => (hostIs(u, "js.stripe.com") && /three-ds-2-fingerprint/.test(u.pathname)) || (hostIs(u, "hooks.stripe.com") && /fingerprint/.test(u.pathname)) },
  { id: "stripe-3ds", vendor: "stripe", kind: "3ds-challenge", pattern: "js.stripe.com/v3/(three-ds-2-challenge|authorize-with-url-inner)*, hooks.stripe.com/(3d_secure*|three_d_secure|redirect/authenticate)", match: (u) => (hostIs(u, "js.stripe.com") && /three-ds-2-challenge|authorize-with-url-inner/.test(u.pathname)) || (hostIs(u, "hooks.stripe.com") && /^\/(3d_secure|three_d_secure|redirect\/authenticate)/.test(u.pathname)) },
  { id: "cardinal-collect", vendor: "cardinal", kind: "3ds-method", pattern: "centinelapi.cardinalcommerce.com/V1/Cruise/Collect, geo.cardinalcommerce.com/DeviceFingerprintWeb", match: (u) => hostEnds(u, "cardinalcommerce.com") && /collect|fingerprint|songbird/i.test(u.pathname) },
  { id: "cardinal-stepup", vendor: "cardinal", kind: "3ds-challenge", pattern: "centinelapi(stag)?.cardinalcommerce.com/V*/Cruise/StepUp (and any other *.cardinalcommerce.com frame)", match: (u) => hostEnds(u, "cardinalcommerce.com") },
  { id: "adyen-3ds", vendor: "adyen", kind: "3ds-challenge", pattern: "*.adyen.com/…/threeds2…/challenge, test.adyen.com/hpp/3d/", match: (u) => hostEnds(u, "adyen.com", "adyenpayments.com") && /threeds2?|3ds|\/3d\//i.test(u.pathname) && !/fingerprint|method/i.test(u.pathname) },
  { id: "braintree-3ds", vendor: "braintree", kind: "3ds-challenge", pattern: "assets.braintreegateway.com/…/three-d-secure-bank-frame", match: (u) => hostEnds(u, "braintreegateway.com", "braintree-api.com") && /three-d-secure/.test(u.pathname) && !/complete/.test(u.pathname) },
  { id: "checkoutcom-3ds", vendor: "checkout.com", kind: "3ds-challenge", pattern: "*.checkout.com/…3ds…", match: (u) => hostEnds(u, "checkout.com") && /3ds|threeds/i.test(u.pathname + u.hostname) },
  // Duo (iframe prompt or Universal Prompt main frame).
  { id: "duo", vendor: "duo", kind: "duo", pattern: "api-*.duosecurity.com/frame/…", match: (u) => /^api-[\w-]+\.duosecurity\.com$/.test(u.hostname) || (hostEnds(u, "duosecurity.com") && /\/frame\//.test(u.pathname)) },
];

export interface IdpSignature {
  vendor: string;
  pattern: string;
  match: (u: URL) => boolean;
}

/** Identity-provider hosts: a login wall when they are the MAIN frame (as subframes they are "Sign in with…" buttons). */
export const IDP_SIGNATURES: IdpSignature[] = [
  { vendor: "google", pattern: "accounts.google.com (not /gsi/ buttons)", match: (u) => hostIs(u, "accounts.google.com") && !/^\/gsi\//.test(u.pathname) && !/^\/(RotateCookies|ListAccounts)/.test(u.pathname) },
  { vendor: "microsoft", pattern: "login.microsoftonline.com, login.microsoft.com, login.live.com, login.windows.net, *.b2clogin.com", match: (u) => hostIs(u, "login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net", "login.microsoftonline.us", "login.partner.microsoftonline.cn") || hostEnds(u, "b2clogin.com") },
  { vendor: "apple", pattern: "appleid.apple.com/(sign-in|auth/…), idmsa.apple.com", match: (u) => (hostIs(u, "appleid.apple.com") && /^\/(sign-?in|auth\/|$)/.test(u.pathname)) || hostIs(u, "idmsa.apple.com") },
  { vendor: "okta", pattern: "*.okta.com|*.oktapreview.com|*.okta-emea.com (/, /login, /signin, /oauth2, /sso, /idp, /app/*/sso)", match: (u) => hostEnds(u, "okta.com", "oktapreview.com", "okta-emea.com") && (u.pathname === "/" || /^\/(login|signin|oauth2|sso|idp|app\/[^/]+\/[^/]+\/sso)/.test(u.pathname)) },
  { vendor: "auth0", pattern: "*.auth0.com (/u/…, /login, /authorize)", match: (u) => hostEnds(u, "auth0.com") && /^\/(u\/|login|authorize|mf+a|usernamepassword|passwordless)/.test(u.pathname) },
  { vendor: "github", pattern: "github.com/(login|session|sessions/…)", match: (u) => hostIs(u, "github.com") && /^\/(login|session|sessions)(\/|$)/.test(u.pathname) },
  { vendor: "onelogin", pattern: "*.onelogin.com/login*", match: (u) => hostEnds(u, "onelogin.com") && /^\/(login|login2|trust)/.test(u.pathname) },
  { vendor: "pingidentity", pattern: "*.pingone.com, *.pingidentity.com (as/authorize, signon)", match: (u) => hostEnds(u, "pingone.com", "pingone.eu", "pingone.asia", "pingidentity.com") && /authorize|signon|login|flow|idp/i.test(u.pathname) },
  { vendor: "aws-cognito", pattern: "*.amazoncognito.com/(login|oauth2/authorize)", match: (u) => hostEnds(u, "amazoncognito.com") && /^\/(login|oauth2\/authorize|signup|mfa|forgotPassword)/.test(u.pathname) },
  { vendor: "keycloak", pattern: "/realms/*/protocol/openid-connect/auth, /realms/*/login-actions/", match: (u) => /^\/(auth\/)?realms\/[^/]+\/(protocol\/openid-connect\/auth|login-actions\/)/.test(u.pathname) },
  { vendor: "aws", pattern: "signin.aws.amazon.com, *.signin.aws.amazon.com, *.awsapps.com/start", match: (u) => hostEnds(u, "signin.aws.amazon.com") || (hostEnds(u, "awsapps.com") && /^\/start/.test(u.pathname)) },
  { vendor: "amazon", pattern: "www.amazon.<tld>/(ap/(signin|mfa|cvf|challenge)|ax/claim)", match: (u) => /(^|\.)amazon\.(com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.tr|ae|sa|eg|in|co\.jp|com\.au|sg|cn)$/.test(u.hostname) && /^\/(ap\/(signin|mfa|cvf|challenge|register)|ax\/claim)/.test(u.pathname) },
  { vendor: "yahoo", pattern: "login.yahoo.com", match: (u) => hostIs(u, "login.yahoo.com") },
  { vendor: "atlassian", pattern: "id.atlassian.com/login", match: (u) => hostIs(u, "id.atlassian.com") && /^\/login/.test(u.pathname) },
  { vendor: "salesforce", pattern: "login.salesforce.com, test.salesforce.com", match: (u) => hostIs(u, "login.salesforce.com", "test.salesforce.com") },
];

/** Cookies whose presence alone says "this site uses vendor X" (never blocking by themselves). */
export const PRESENCE_COOKIES: Array<{ vendor: string; re: RegExp }> = [
  { vendor: "cloudflare", re: /^(cf_clearance|__cf_bm|_cfuvid|cf_chl_\w+)$/ },
  { vendor: "datadome", re: /^datadome$/ },
  { vendor: "human", re: /^(_px\d?|_pxhd|_pxvid|_pxcts|_pxde|_pxff_\w+)$/ },
  { vendor: "akamai", re: /^(_abck|bm_sz|ak_bmsc|bm_sv|bm_mi|bm_so|sec_cpt)$/ },
  { vendor: "imperva", re: /^(incap_ses_\w+|visid_incap_\w+|nlbi_\w+|reese84|___utmvc)$/ },
  { vendor: "aws-waf", re: /^aws-waf-token$/ },
  { vendor: "kasada", re: /^(KP_UIDz|KP_UIDz-ssn|KP_REF)$/ },
];

/** Cookies that change when a challenge is passed. */
export const CLEARANCE_COOKIES = ["cf_clearance", "aws-waf-token", "datadome", "_px3", "_pxhd", "reese84", "sec_cpt", "KP_UIDz"];

/** Hidden inputs where widgets put their response token. */
const TOKEN_INPUT = /^(g-recaptcha-response(-\d+)?|h-captcha-response|cf-turnstile-response|frc-captcha-(solution|response)|mtcaptcha-verifiedtoken|smart-token|fc-token|verification-token|arkose[-_]?token|geetest_(validate|seccode)|captcha_output|aws-waf-token)$/i;

// ------------------------------------------------------------------ text patterns

const LOGIN_WORDS = /\b(sign|log)[\s-]?in\b|\blogin\b|\blogon\b|\bauthenticat(e|ion)\b|\bwelcome back\b|\benter (your )?password\b/i;

/**
 * Whole path segments only ("/login", "/users/sign_in", "/wp-login.php", "/Account/Login.aspx"),
 * never words inside a slug ("/blog/how-to-fix-login-problems").
 */
function segmentTest(tokens: string, prefixes = "user|users|member|members|customer|account|accounts|admin|portal|secure|my|wp|client|partner|staff|employee"): (pathname: string) => boolean {
  const re = new RegExp(`^((${prefixes})[-_]?)?(${tokens})([-_](\\w+))?$`, "i");
  return (pathname) =>
    pathname
      .split("/")
      .map((s) => decodeURIComponentSafe(s).replace(/\.(php|html?|aspx?|jsp|do|srf|cgi|action)$/i, ""))
      .some((s) => s.length > 0 && s.length <= 40 && re.test(s));
}
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
const LOGIN_SEGMENT = segmentTest("log[-_]?in|sign[-_]?in|login2|logon|authenticate|authorize|auth|sso|saml2?|oauth2?|openid(-connect)?|idp");
const LOGIN_PATH = { test: (pathname: string) => LOGIN_SEGMENT(pathname.split("?")[0]!) };
const AUTH_STEP_SEGMENT = segmentTest("mfa|2fa|two[-_]?factor|tfa|otp|totp|verify|verification|challenge|cvf|webauthn|passkey|magic[-_]?link|confirm|checkpoint|step[-_]?up|second[-_]?factor");
const AUTH_STEP_PATH = { test: (pathname: string) => AUTH_STEP_SEGMENT(pathname.split("?")[0]!) };
/** The auth-only part of AUTH_STEP_SEGMENT: never "verify", "confirm" or "challenge", which checkouts and accounts use too. */
const AUTH_ONLY_STEP_SEGMENT = segmentTest("mfa|2fa|two[-_]?factor|tfa|otp|totp|cvf|webauthn|passkey|magic[-_]?link|checkpoint|step[-_]?up|second[-_]?factor");
/** A title or heading that says a sign-in step ("Two-step verification", "Verify it's you"), not "Confirm your order". */
const SIGN_IN_STEP_WORDS = /\b(sign|log)[\s-]?in\b|\blogin\b|\btwo[- ](factor|step)\b|\b2-step\b|\b2fa\b|\bauthenticat|\bsecurity (code|check|key)\b|\bverification code\b|\bone[- ]time\b|\bpasscode\b|\b(confirm|verify) (it'?s|that it'?s) you\b|\bit'?s (really )?you\b|\bverify your identity\b/i;
const AUTH_WORDS = /\b(sign|log)[\s-]?in\b|\blogin\b|\bverif(y|ication)\b|\btwo[- ](factor|step)\b|\b2-step\b|\b2fa\b|\bauthenticat|\bsecurity (code|check|key)\b|\bone[- ]time\b|\bpasscode\b|\bconfirm (it'?s|that it'?s) you\b|\bit'?s (really )?you\b/i;
const RETURN_PARAM = /[?&](next|return_?to|return_?url|returnurl|continue|redirect(_?uri|_?url|_?to)?|dest(ination)?|back_?url|goto|service|relaystate|samlrequest|openid\.return_to|callback(_?url)?|forward(_?url)?|ru|rurl|target|origin_?url)=/i;
const CHALLENGE_SEGMENT = segmentTest("captcha|recaptcha|hcaptcha|challenge|sorry|blocked|verify|validate|human|bot[-_]?check|security[-_]?check|cdn-cgi|_incapsula_resource|interstitial|are[-_]?you[-_]?human", "bot|human|security|robot|access|validate|errors?");
const CHALLENGE_URL = { test: (pq: string) => CHALLENGE_SEGMENT(pq.split("?")[0]!) || /[?&](captcha|challenge|__cf_chl_\w*)=/i.test(pq) || /\/errors\/validatecaptcha/i.test(pq) };

export interface TextRule {
  category: InterruptCategory;
  vendor?: string;
  signal: string;
  /** All must match (lower-cased page text). */
  all: RegExp[];
  /** Match against the title instead of requiring a sparse page. */
  title?: RegExp;
  /** Needs the page to be small (gate-like) unless `title` matched. */
  sparse?: boolean;
  autoResolvable?: boolean;
}

/** Hard blocks: nothing the human can do in the live view. */
export const HARD_BLOCK_RULES: TextRule[] = [
  { category: "hard_block", vendor: "cloudflare", signal: "Cloudflare block page (\"Sorry, you have been blocked\")", all: [/sorry, you have been blocked/, /cloudflare|ray id/] },
  { category: "hard_block", vendor: "cloudflare", signal: "Cloudflare 10xx access-denied error", all: [/\berror\s*(1005|1006|1007|1008|1009|1010|1012|1020|1025)\b/, /cloudflare|ray id/, /access denied|banned|blocked|owner of this website/] },
  { category: "hard_block", vendor: "cloudflare", signal: "Cloudflare 1015 rate limit", all: [/you are being rate limited/, /cloudflare|ray id|error 1015/] },
  { category: "hard_block", vendor: "akamai", signal: "Akamai \"Access Denied … Reference #\"", all: [/access denied/, /you don'?t have permission to access/, /reference\s*#\s*[0-9a-f]+\.[0-9a-f.]+/] },
  { category: "hard_block", vendor: "imperva", signal: "Incapsula incident page", all: [/incapsula incident id|request unsuccessful\. incapsula/] },
  { category: "hard_block", vendor: "imperva", signal: "Imperva \"Pardon Our Interruption\"", all: [/pardon our interruption/], title: /pardon our interruption/i, sparse: true },
  { category: "hard_block", vendor: "sucuri", signal: "Sucuri firewall access denied", all: [/sucuri website firewall/, /access denied/] },
  { category: "hard_block", vendor: "aws-cloudfront", signal: "CloudFront \"Request blocked\"", all: [/the request could not be satisfied/, /request blocked/, /cloudfront/] },
  { category: "hard_block", vendor: "datadome", signal: "DataDome \"You have been blocked\"", all: [/you('ve| have) been blocked/, /datadome|captcha-delivery/] },
  { category: "hard_block", vendor: "google", signal: "Google \"This browser or app may not be secure\"", all: [/this browser or app may not be secure/] },
];

/** Challenge interstitials and text CAPTCHAs (checked after frame tiers; vendor frames are not part of this text). */
export const CHALLENGE_RULES: TextRule[] = [
  { category: "captcha", vendor: "human", signal: "PerimeterX/HUMAN \"Press & Hold\"", all: [/press (&|and) hold/, /human|robot|confirm/], sparse: true },
  { category: "captcha", vendor: "google", signal: "Google \"unusual traffic\" CAPTCHA", all: [/our systems have detected unusual traffic/] },
  { category: "captcha", vendor: "amazon", signal: "Amazon character CAPTCHA", all: [/(enter|type) the characters you see/, /robot|characters/] },
  { category: "captcha", vendor: "aws-waf", signal: "AWS WAF \"Let's confirm you are human\"", all: [/let'?s confirm you are human/] },
  { category: "bot_challenge", vendor: "cloudflare", signal: "Cloudflare challenge interstitial text", all: [/checking (your browser|if the site connection is secure)|verify(ing)? you are human by completing|needs to review the security of your connection|performing security verification|enable javascript and cookies to continue|ddos protection by cloudflare/], title: /^just a moment|^attention required|^one more step/i, sparse: true, autoResolvable: true },
  { category: "bot_challenge", signal: "generic \"checking your browser\" interstitial", all: [/checking your browser|please wait while we (verify|check)|browser check|verifying (that )?you are (a )?human|verify(ing)? you are human|verifying your (device|browser)/], sparse: true, autoResolvable: true },
  // "Solve this puzzle to protect your account" (17 Nov: a sign-in's puzzle page, its puzzle drawn by a script no frame
  // signature knows, read as the sign-in itself; the run ended there while the person was at hand to solve it).
  { category: "captcha", signal: "generic \"are you a robot\" gate", all: [/are you a (robot|human)|prove you('?re| are) (not a robot|human)|complete the (security check|captcha)|please verify you are (a )?human|i'?m not a robot|human verification|solve (this|the) puzzle/], sparse: true },
];

const OTP_TEXT = [
  /\b(verification|security|one[- ]time|authentication|confirmation|login|sign[- ]in|access|sms|text|email|\d[- ]digit|authenticator|2fa|two[- ]factor|backup|recovery) code\b/,
  /\benter (the |your )?(\d[- ]digit )?(code|otp|passcode|pin)\b/,
  /\b(sent|texted|emailed|send) (you )?(a |an |the )?(new )?(\d[- ]digit )?(code|otp|passcode|pin|verification code)\b/,
  /\bauthenticator app\b/,
  /\bone[- ]time (password|passcode|pin|code)\b/,
  /\b(two|2)[- ](factor|step) (authentication|verification)\b/,
  /\b(otp|totp|2fa|passcode)\b/,
];
const PUSH_TEXT = [
  /\bcheck your (phone|device|mobile( device)?|app)\b/,
  /\bapprove (the |this |your )?(sign[- ]?in|log[- ]?in|login)( request| attempt)?\b/,
  /\b(okta verify|duo push|duo mobile|microsoft authenticator|github mobile|google prompt)\b/,
  /\b(sent|send) (a |you a )?(push )?notification\b|\bpush notification\b/,
  /\btap (yes|approve|allow)\b/,
  /\bwaiting for (your )?approval\b/,
  /\benter the number shown\b|\bnumber (shown|displayed)\b/,
  /\bopen (the |your )[\w ]{0,30}app\b[^.]{0,60}\b(approve|number|tap|notification)\b/,
];
const MAGIC_STRONG = [
  /\b(magic|sign[- ]?in|log[- ]?in|login|one[- ]time|secure) link\b/,
  /\bclick (on )?the link (we|in (the|your|that) (e-?mail|message))\b/,
  /\b(sent|emailed) (you )?(a |an )?link\b[^.]{0,60}\b(sign|log)[- ]?in\b/,
  /\blink to (sign|log)[- ]?in\b/,
];
const MAGIC_WEAK = /\bcheck your (e-?mail|inbox|mail)\b/;
const PASSKEY_TEXT = [
  /\b(use|using|with|try) (a |your )?passkey\b/,
  /\b(insert|touch|tap|use|plug in) (your |the )?security key\b/,
  /\bwindows hello\b/,
  /\bpasskey\b[^.]{0,60}\b(confirm|verify|it'?s (really )?you)\b|\b(confirm|verify)\b[^.]{0,40}\bpasskey\b/,
  /\b(use your|scan with your) (fingerprint|face|screen lock)\b/,
];

const OTP_NAME = /\b(otp|totp|hotp|mfa|2fa|tfa|twofactor|one ?time|onetime|passcode|verification|verify|verif|vcode|code|token|pin|smscode|authcode|auth|challenge|approvals)\b/;
const OTP_NAME_EXCLUDE = /\b(promo|promotion|coupon|discount|gift|giftcard|voucher|postal|zip|zipcode|post|postcode|pincode|country|area|dial|referral|refer|invite|invitation|tracking|cvc|cvv|csc|cvn|cid|card|cc|iban|swift|bic|sort|routing|captcha|search|query|q|keyword|keywords|qty|quantity|amount|price|year|month|day|dob|age|color|colour|lang|language|currency|ssn|tax|vat|product|sku|item|reference|order|booking)\b/;
const SEARCH_NAME = /\b(q|query|search|searchterm|keywords?|field-keywords|s|k|find|lookup)\b/;
/** Field names that are clearly something other than a code. */
const NOT_A_CODE_NAME = /\b(feedback|comment|comments|message|subject|title|name|first|last|full|address|city|street|company|phone|mobile|website|url|note|notes|description|bio|helpful|reply|answer)\b/;
const USERNAME_NAME = /^(login|username|user|user_?name|email|e-?mail|identifier|identifierid|loginfmt|ap_email|login_field|login_email|login_id|loginid|userid|user_?id|uid|account|account_?name|j_username|session\[(email|username|login)\]|user\[(email|login)\]|signin_?email)$/i;

// ------------------------------------------------------------------ model

interface FrameEntry {
  url: string;
  u: URL | null;
  isMain: boolean;
  node?: InterruptNode;
  /** true/false from the snapshot, undefined when no snapshot node was found. */
  shown?: boolean;
  rect?: InterruptRect;
  frameIds: string[];
}

interface InputInfo {
  node: InterruptNode;
  type: string;
  ac: string[];
  maxLength: number | null;
  inputMode: string;
  nameish: string;
  tokens: string;
  inViewport: boolean;
  inDialog: boolean;
  inSearch: boolean;
}

interface View {
  text: string;
  lower: string;
  textNodes: InterruptNode[];
  headings: string[];
  inputs: InputInfo[];
  interactiveVp: number;
  elements: InterruptNode[];
  hasCardFields: boolean;
  /** DOM markers found in the same pass. */
  px?: InterruptNode;
  geetest?: InterruptNode;
  amazonCaptchaForm: boolean;
  cfChallengeMarkup: boolean;
  /** Text nodes outside links and buttons (see proseOf), built on first use. */
  _prose?: { nodes: InterruptNode[]; lower: string };
}

/** Text beyond this is not scanned: gates, block pages and auth steps are short. */
const MAX_TEXT = 8000;

interface Hit {
  category: InterruptCategory;
  vendor?: string;
  blocking: boolean;
  autoResolvable?: boolean;
  needs?: InterruptNeeds;
  signals: string[];
  input?: InterruptInputRequest;
  displayNumber?: string;
  inPage?: boolean;
  rect?: InterruptRect;
  widget?: Interruption["widget"];
  /** Only a presence signal, not a candidate. */
  presence?: boolean;
  priority?: number;
}

interface Model {
  input: InterruptInput;
  url: string;
  u: URL | null;
  title: string;
  status?: number;
  headers: Record<string, string>;
  cookies: Map<string, string | undefined>;
  snap: InterruptSnapshot | null;
  vw: number;
  vh: number;
  scrollY: number;
  mainFrameId: string;
  frames: FrameEntry[];
  vendorFrameIds: Set<string>;
  /** Frame ids whose content counts toward the page view (main + large first-party frames). */
  viewFrameIds: Set<string>;
  nodesByFrame: Map<string, InterruptNode[]>;
  ownerOf: Map<string, InterruptNode>;
  presence: string[];
  _view?: View;
  _gate?: boolean;
}

function parseUrl(s: string | undefined, base?: string): URL | null {
  if (!s) return null;
  try {
    return base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
}

function norm(s: string): string {
  let out = s.replace(/[‘’ʼ   ]/g, (c) => (c === " " || c === " " || c === " " ? " " : "'"));
  if (/\s\s|[\t\n\r\f]/.test(out)) out = out.replace(/\s+/g, " ");
  return out.trim();
}

function tokenize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function area(r?: InterruptRect): number {
  return r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
}

function isTextNode(n: InterruptNode): boolean {
  return n.nodeType === 3 || n.tag === "#text";
}

/** Element is rendered with a box and not pushed fully off-page (the hidden-reCAPTCHA-bframe trick: top:-10000px). */
function shownEl(n: InterruptNode, scrollY: number): boolean {
  if (!n.visible || !n.rect) return false;
  const r = n.rect;
  if (r.width < 2 || r.height < 2) return false;
  if (r.x + r.width <= 0) return false;
  if (r.y + scrollY + r.height <= 0) return false;
  return true;
}

function inViewport(n: InterruptNode, vw: number, vh: number): boolean {
  const r = n.rect;
  if (!r) return false;
  return r.x + r.width > 0 && r.y + r.height > 0 && r.x < vw && r.y < vh;
}

function textOfNode(n: InterruptNode, max = 300): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (c: InterruptNode) => {
    if (len > max) return;
    if (c.text) {
      parts.push(c.text);
      len += c.text.length + 1;
    }
    for (const ch of c.children) walk(ch);
  };
  walk(n);
  return norm(parts.join(" ")).slice(0, max);
}

function ancestors(n: InterruptNode, max = 40): InterruptNode[] {
  const out: InterruptNode[] = [];
  let p = n.parent ?? null;
  while (p && out.length < max) {
    out.push(p);
    p = p.parent ?? null;
  }
  return out;
}

function textVisible(t: InterruptNode): boolean {
  if (t.rect && (t.rect.width <= 0 || t.rect.height <= 0)) return false;
  let p = t.parent ?? null;
  // display:contents wrappers and zero-size containers (whose overflow still paints) are transparent.
  for (let guard = 0; p && guard < 8; guard++) {
    if (p.visible) return true;
    const zeroSize = !!p.rect && (p.rect.width === 0 || p.rect.height === 0);
    if (!p.boxless && !zeroSize) return false;
    p = p.parent ?? null;
  }
  return !p;
}

function isInteractive(n: InterruptNode): boolean {
  if (n.interactive !== undefined) return n.interactive;
  if (["a", "button", "input", "select", "textarea", "summary"].includes(n.tag)) return n.tag !== "a" || n.attrs["href"] !== undefined;
  return ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "menuitem", "tab", "switch"].includes(n.role ?? "");
}

function cookieMap(list: InterruptInput["cookies"]): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const c of list ?? []) {
    if (typeof c === "string") m.set(c, undefined);
    else if (c && c.name) m.set(c.name, c.value);
  }
  return m;
}

function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

function sameDoc(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname === b.pathname;
}

/** The response belongs to the document being classified (same origin + path as the current URL). */
function responseFresh(input: InterruptInput): boolean {
  const r = input.response;
  if (!r) return false;
  const cur = parseUrl(input.snapshot?.url || input.url);
  const ru = parseUrl(r.url);
  return !cur || !ru || sameDoc(cur, ru);
}

function buildModel(input: InterruptInput): Model {
  const snap = input.snapshot ?? null;
  const url = snap?.url || input.url || input.response?.url || input.frameUrls?.[0] || "";
  const m: Model = {
    input,
    url,
    u: parseUrl(url),
    title: norm(snap?.title ?? ""),
    // A response for another document (missed navigation, SPA pushState) says nothing about this page.
    status: responseFresh(input) ? input.response?.status : undefined,
    headers: responseFresh(input) ? lowerHeaders(input.response?.headers) : {},
    cookies: cookieMap(input.cookies),
    snap,
    vw: snap?.viewport.width || 1280,
    vh: snap?.viewport.height || 800,
    scrollY: snap?.scroll?.y ?? 0,
    mainFrameId: snap?.root?.frameId ?? snap?.nodes[0]?.frameId ?? "",
    frames: [],
    vendorFrameIds: new Set(),
    viewFrameIds: new Set(),
    nodesByFrame: new Map(),
    ownerOf: new Map(),
    presence: [],
  };

  // Frame ownership: the first node of a child document sits under its <iframe>.
  const iframeNodes: InterruptNode[] = [];
  const childFrameIds = new Map<InterruptNode, Set<string>>();
  const childUrl = new Map<InterruptNode, string>();
  if (snap) {
    for (const n of snap.nodes) {
      const fid = n.frameId ?? m.mainFrameId;
      let list = m.nodesByFrame.get(fid);
      if (!list) m.nodesByFrame.set(fid, (list = []));
      list.push(n);
      if (n.isIframe || n.tag === "iframe" || n.tag === "frame") iframeNodes.push(n);
      const p = n.parent;
      if (p && (p.isIframe || p.tag === "iframe" || p.tag === "frame") && fid !== (p.frameId ?? m.mainFrameId)) {
        if (!m.ownerOf.has(fid)) m.ownerOf.set(fid, p);
        let s = childFrameIds.get(p);
        if (!s) childFrameIds.set(p, (s = new Set()));
        s.add(fid);
        if (n.frame && p.frame && n.frame !== p.frame && n.frame.url && !childUrl.has(p)) childUrl.set(p, n.frame.url);
      }
    }
  }

  // Frame entries: snapshot iframes (with visibility) + reported frame URLs not matched to one.
  const base = url || undefined;
  const main = m.u;
  if (url) m.frames.push({ url, u: main, isMain: true, shown: true, frameIds: [m.mainFrameId] });
  // frameUrls[0] is the main frame by contract; the rest are children.
  const pool = (input.frameUrls ?? []).slice(1).map((s) => ({ s, u: parseUrl(s), used: false }));
  for (const n of iframeNodes) {
    const src = n.attrs["src"];
    const fromChild = childUrl.get(n);
    const srcU = parseUrl(src, base);
    let u = srcU && /^https?:$/.test(srcU.protocol) ? srcU : null;
    const cu = parseUrl(fromChild);
    if (cu && (!u || !sameDoc(cu, u))) u = cu; // navigated away from its src, or src was about:blank
    // Consume the matching reported frame URL (prefer exact, then same document ignoring query/hash).
    let match = pool.find((p) => !p.used && p.u && u && p.u.href === u.href) ?? pool.find((p) => !p.used && p.u && u && sameDoc(p.u, u));
    if (match) {
      match.used = true;
      if (match.u && u && match.u.hash && !u.hash) u = match.u;
    }
    if (!u) continue;
    m.frames.push({ url: u.href, u, isMain: false, node: n, shown: shownEl(n, m.scrollY), rect: n.rect, frameIds: [...(childFrameIds.get(n) ?? [])] });
  }
  for (const p of pool) {
    if (p.used || !p.u || !/^https?:$/.test(p.u.protocol)) continue;
    // Not found in the snapshot: if we have one, the frame is display:none'd or detached.
    m.frames.push({ url: p.s, u: p.u, isMain: false, shown: snap ? false : undefined, frameIds: [] });
  }

  // Vendor frames (and everything nested in them) are excluded from the page view.
  for (const f of m.frames) {
    if (f.isMain || !f.u) continue;
    if (FRAME_SIGNATURES.some((s) => s.match(f.u!)) || frame3dsByName(f.node)) for (const id of f.frameIds) m.vendorFrameIds.add(id);
  }
  const vpArea = m.vw * m.vh;
  const isVendor = (fid: string): boolean => {
    for (let id: string | undefined = fid, guard = 0; id !== undefined && guard < 20; guard++) {
      if (m.vendorFrameIds.has(id)) return true;
      const owner = m.ownerOf.get(id);
      id = owner ? (owner.frameId ?? m.mainFrameId) : undefined;
    }
    return false;
  };
  // Shown chain: each owning iframe visible.
  const chainShown = (fid: string): boolean => {
    for (let id: string | undefined = fid, guard = 0; id !== undefined && id !== m.mainFrameId && guard < 20; guard++) {
      const owner = m.ownerOf.get(id);
      if (!owner) return id === m.mainFrameId;
      if (!shownEl(owner, m.scrollY)) return false;
      id = owner.frameId ?? m.mainFrameId;
    }
    return true;
  };
  for (const fid of m.nodesByFrame.keys()) {
    if (fid === m.mainFrameId) {
      m.viewFrameIds.add(fid);
      continue;
    }
    if (isVendor(fid)) continue;
    if (!chainShown(fid)) continue;
    const owner = m.ownerOf.get(fid);
    const a = area(owner?.rect);
    const hasAuthInput = (m.nodesByFrame.get(fid) ?? []).some((n) => n.tag === "input" && n.visible && /password|email/i.test(n.attrs["type"] ?? ""));
    if (a >= 0.25 * vpArea || (hasAuthInput && (owner?.rect?.width ?? 0) >= 200 && (owner?.rect?.height ?? 0) >= 120)) m.viewFrameIds.add(fid);
  }
  return m;
}

function frame3dsByName(n?: InterruptNode): boolean {
  if (!n) return false;
  const s = `${n.attrs["name"] ?? ""} ${n.attrs["id"] ?? ""} ${n.attrs["title"] ?? ""} ${n.attrs["class"] ?? ""}`;
  return /threeDSIframe|threeds-?2?-?challenge|three-?d-?s(ecure)?-?(challenge|frame|iframe)|3ds-?(challenge|iframe)|challengeFrame|Cardinal-CCA-IFrame|stripe-challenge-frame|acsFrame|3d ?secure/i.test(s) && !/method|fingerprint/i.test(s);
}

/** Build a view (text, inputs, headings, interactive count) over nodes of the given frames. */
function buildView(m: Model, frameIds: Iterable<string>): View {
  const texts: string[] = [];
  const textNodes: InterruptNode[] = [];
  let textLen = 0;
  const headings: string[] = [];
  const inputs: InputInfo[] = [];
  const elements: InterruptNode[] = [];
  let interactiveVp = 0;
  let hasCardFields = false;
  let px: InterruptNode | undefined;
  let geetest: InterruptNode | undefined;
  let amazonCaptchaForm = false;
  let cfChallengeMarkup = false;
  for (const fid of frameIds) {
    for (const n of m.nodesByFrame.get(fid) ?? []) {
      if (isTextNode(n)) {
        if (n.text && textLen < MAX_TEXT && textVisible(n)) {
          texts.push(n.text);
          textNodes.push(n);
          textLen += n.text.length + 1;
        }
        continue;
      }
      const id = n.attrs["id"];
      if (id !== undefined) {
        if (id === "px-captcha") px = n;
        else if (id.startsWith("challenge-") || id === "cf-challenge-running") cfChallengeMarkup ||= /^(challenge-(form|running|stage|success|error-text|body-text)|cf-challenge-running)$/.test(id);
      }
      if (n.tag === "form") {
        const action = n.attrs["action"] ?? "";
        if (action.includes("__cf_chl_")) cfChallengeMarkup = true;
        if (/\/errors\/validatecaptcha/i.test(action)) amazonCaptchaForm = true;
      }
      if (!n.visible) {
        if (n.tag === "input" || n.tag === "textarea") elements.push(n); // hidden token inputs
        continue;
      }
      const cls = n.attrs["class"];
      if (!geetest && cls !== undefined && cls.includes("geetest_") && /\bgeetest_(box_wrap|box|panel|popup_wrap|fullpage_click)\b/.test(cls) && shownEl(n, m.scrollY) && area(n.rect) >= 150 * 150) geetest = n;
      elements.push(n);
      if (isInteractive(n) && inViewport(n, m.vw, m.vh)) interactiveVp++;
      if (/^h[1-3]$/.test(n.tag) || n.role === "heading" || n.attrs["role"] === "heading") {
        const t = textOfNode(n, 160);
        if (t) headings.push(t);
      }
      if (n.tag === "input" || n.tag === "textarea") {
        const type = (n.attrs["type"] ?? (n.tag === "textarea" ? "textarea" : "text")).toLowerCase();
        if (["hidden", "checkbox", "radio", "submit", "button", "image", "file", "range", "color", "reset"].includes(type)) continue;
        if (!shownEl(n, m.scrollY) || (n.rect && (n.rect.width < 8 || n.rect.height < 8))) continue;
        const ac = (n.attrs["autocomplete"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (ac.some((t) => t.startsWith("cc-"))) hasCardFields = true;
        const ml = parseInt(n.attrs["maxlength"] ?? "", 10);
        const nameish = [n.attrs["name"], n.attrs["id"], n.attrs["placeholder"], n.attrs["aria-label"], n.name, n.attrs["data-testid"]].filter(Boolean).join(" ");
        const anc = ancestors(n, 12);
        inputs.push({
          node: n,
          type,
          ac,
          maxLength: Number.isFinite(ml) && ml > 0 ? ml : null,
          inputMode: (n.attrs["inputmode"] ?? "").toLowerCase(),
          nameish,
          tokens: tokenize(nameish),
          inViewport: inViewport(n, m.vw, m.vh),
          inDialog: anc.some((a) => a.tag === "dialog" || a.role === "dialog" || a.role === "alertdialog" || a.attrs["role"] === "dialog" || a.attrs["aria-modal"] === "true"),
          inSearch: type === "search" || n.role === "searchbox" || anc.some((a) => a.role === "search" || a.attrs["role"] === "search" || a.tag === "search"),
        });
      }
    }
  }
  const text = norm(texts.join(" "));
  return { text, lower: text.toLowerCase(), textNodes, headings, inputs, interactiveVp, elements, hasCardFields, px, geetest, amazonCaptchaForm, cfChallengeMarkup };
}

function pageView(m: Model): View {
  return (m._view ??= buildView(m, m.viewFrameIds));
}

/** Gate-sized page: little text, few controls in view. */
function sparse(m: Model, v = pageView(m)): boolean {
  return v.lower.length <= 1500 && v.interactiveVp <= 30;
}

/** Not a content page: headings only count as cues on pages this small (a sidebar "Log in" widget has one too). */
function medium(v: View): boolean {
  return v.lower.length <= 3000 && v.interactiveVp <= 60;
}

function urlPathQuery(m: Model): string {
  return m.u ? m.u.pathname + m.u.search : "";
}

/** Strong auth context: an identity-provider host or an auth-step path segment. */
function authUrlContext(m: Model): string | null {
  if (m.u && IDP_SIGNATURES.some((s) => s.match(m.u!))) return "identity-provider host";
  if (m.u && (LOGIN_PATH.test(m.u.pathname) || AUTH_STEP_PATH.test(m.u.pathname))) return `auth-ish URL ${m.u.pathname.slice(0, 50)}`;
  return null;
}

/** Auth context: the URL, or an auth-ish title/heading on a page that is not a content page. */
function authContext(m: Model, v = pageView(m)): string | null {
  const strong = authUrlContext(m);
  if (strong) return strong;
  if (!medium(v)) return null;
  if (AUTH_WORDS.test(m.title)) return `auth-ish title "${m.title.slice(0, 60)}"`;
  const h = v.headings.find((t) => AUTH_WORDS.test(t) && t.length <= 100);
  if (h) return `auth-ish heading "${h.slice(0, 60)}"`;
  return null;
}

/** The page is a gate: the widget is (nearly) all there is. */
function isGate(m: Model): boolean {
  if (m._gate !== undefined) return m._gate;
  let gate = false;
  if (m.status !== undefined && [202, 403, 405, 429, 503].includes(m.status)) gate = true;
  else if (CHALLENGE_URL.test(urlPathQuery(m))) gate = true;
  else if (m.headers["cf-mitigated"] || m.headers["x-amzn-waf-action"]) gate = true;
  else if (m.snap) {
    const v = pageView(m);
    if (v.interactiveVp <= 4 && v.lower.length <= 800) gate = true;
    else if (CHALLENGE_RULES.some((r) => r.all.every((re) => re.test(v.lower)) && (!r.sparse || sparse(m, v)))) gate = true;
  }
  return (m._gate = gate);
}

// ------------------------------------------------------------------ tier 0 / A: flags and the main response

function* tierA(m: Model): Generator<Hit> {
  const h = m.headers;
  const st = m.status;
  const auth = m.input.httpAuthRequired;
  if (auth) {
    const scheme = typeof auth === "object" ? auth.scheme : undefined;
    yield { category: "http_auth", blocking: true, needs: "credentials", signals: [`browser requested HTTP credentials${scheme ? ` (${scheme})` : ""}`] };
  }
  const wwwAuth = h["www-authenticate"] ?? "";
  if (st === 401 && /^\s*(basic|digest|ntlm|negotiate)\b/i.test(wwwAuth)) {
    yield { category: "http_auth", blocking: true, needs: "credentials", signals: [`401 + www-authenticate: ${wwwAuth.split(/[\s,]/)[0]}`] };
  }
  if (st === 407 && h["proxy-authenticate"]) yield { category: "http_auth", vendor: "proxy", blocking: true, needs: "credentials", signals: ["407 proxy authentication required"] };

  if ((h["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
    yield { category: "bot_challenge", vendor: "cloudflare", blocking: true, autoResolvable: true, signals: [`cf-mitigated: challenge${st ? ` (${st})` : ""}`] };
  }
  const vm = (h["x-vercel-mitigated"] ?? "").toLowerCase();
  if (vm === "challenge") yield { category: "bot_challenge", vendor: "vercel", blocking: true, autoResolvable: true, signals: ["x-vercel-mitigated: challenge"] };
  if (vm === "deny") yield { category: "hard_block", vendor: "vercel", blocking: true, signals: ["x-vercel-mitigated: deny"] };

  const waf = (h["x-amzn-waf-action"] ?? "").toLowerCase();
  if (waf === "captcha") yield { category: "captcha", vendor: "aws-waf", blocking: true, signals: [`x-amzn-waf-action: captcha${st === 405 ? " + 405" : st ? ` (${st})` : ""}`] };
  if (waf === "challenge") yield { category: "bot_challenge", vendor: "aws-waf", blocking: true, autoResolvable: true, signals: [`x-amzn-waf-action: challenge${st === 202 ? " + 202" : st ? ` (${st})` : ""}`] };

  const headerNames = Object.keys(h);
  const cookieNames = [...m.cookies.keys()];
  const ddHeader = headerNames.find((k) => k.startsWith("x-datadome") || k === "x-dd-b");
  if ((st === 403 || st === 429) && (ddHeader || m.cookies.has("datadome"))) {
    const dd = m.frames.find((f) => f.u && hostEnds(f.u, "captcha-delivery.com"));
    const sig = `${st} + ${ddHeader ? `${ddHeader} header` : "datadome cookie"}`;
    if (dd?.u && /[?&]t=bv\b/.test(dd.u.search)) yield { category: "hard_block", vendor: "datadome", blocking: true, signals: [sig, "DataDome frame t=bv (banned visitor)"] };
    else if (dd?.u && /\/interstitial\//.test(dd.u.pathname)) yield { category: "bot_challenge", vendor: "datadome", blocking: true, autoResolvable: true, signals: [sig, "DataDome device-check interstitial"] };
    else yield { category: "captcha", vendor: "datadome", blocking: true, signals: [sig] };
  }

  const pxCookie = cookieNames.find((c) => /^_px/.test(c));
  const pxHeader = headerNames.find((k) => k.startsWith("x-px"));
  if (st === 403 && (pxCookie || pxHeader)) {
    const sig = `403 + ${pxHeader ? `${pxHeader} header` : `${pxCookie} cookie`}`;
    if (!m.snap) yield { category: "captcha", vendor: "human", blocking: true, signals: [sig, "no snapshot to look for #px-captcha"] };
    else if (pageView(m).px) yield { category: "captcha", vendor: "human", blocking: true, signals: [sig, "#px-captcha present (Press & Hold)"], ...inPageWidget(pageView(m).px!, m) };
    // Another vendor's own block page on a site behind both (Cloudflare's "Sorry, you have been blocked" under a
    // lingering _px3): the page's words name it, and tier C does.
    else if (!matchRules(m, pageView(m), HARD_BLOCK_RULES)) yield { category: "hard_block", vendor: "human", blocking: true, signals: [sig, "no #px-captcha widget"] };
  }

  const kp = headerNames.find((k) => k.startsWith("x-kpsdk-"));
  if (kp && st === 429) yield { category: "bot_challenge", vendor: "kasada", blocking: true, autoResolvable: true, signals: [`429 + ${kp} header`] };

  if (m.u && /(^|\.)google\.[a-z.]+$/.test(m.u.hostname) && /^\/sorry\//.test(m.u.pathname)) {
    yield { category: "captcha", vendor: "google", blocking: true, signals: [`final URL ${m.u.hostname}/sorry/`] };
  }

  if (st === 511) yield { category: "login", vendor: "captive-portal", blocking: true, signals: ["511 network authentication required"] };

  if (m.u) {
    const pq = m.u.pathname + m.u.search;
    if (/[?&]SAMLRequest=/i.test(m.u.search) || (LOGIN_PATH.test(m.u.pathname) && RETURN_PARAM.test(m.u.search))) {
      const idp = IDP_SIGNATURES.find((s) => s.match(m.u!));
      yield refineAuth(m, { category: "login", ...(idp ? { vendor: idp.vendor } : {}), blocking: true, signals: [`login URL with return parameter (${pq.slice(0, 80)})`] });
    }
  }

  // Presence only.
  const seen = new Set<string>();
  for (const name of cookieNames) {
    for (const p of PRESENCE_COOKIES) {
      if (p.re.test(name) && !seen.has(p.vendor)) {
        seen.add(p.vendor);
        m.presence.push(`present:${p.vendor} cookie ${name}`);
      }
    }
  }
  if (ddHeader && !seen.has("datadome")) m.presence.push(`present:datadome header ${ddHeader}`);
  if (kp && st !== 429) m.presence.push(`present:kasada header ${kp}`);
}

// ------------------------------------------------------------------ tier B: frames

const PRIORITY: Record<string, number> = {
  "hard_block": 0,
  "payment_3ds": 1,
  "captcha-challenge": 2,
  "bot_challenge": 3,
  "captcha": 4,
  "push_approval": 5,
  "login": 6,
};

function frameHits(m: Model): Hit[] {
  const hits: Hit[] = [];
  const gate = () => isGate(m);
  for (const f of m.frames) {
    const u = f.u;
    if (!u) continue;
    const where = f.isMain ? "main frame" : "frame";
    const shown = f.shown;
    const big = shown === true && (f.rect ? f.rect.width >= 150 && f.rect.height >= 150 : true);
    const desc = (s: FrameSignature) => `${where} ${s.vendor} ${u.hostname}${u.pathname.slice(0, 50)}`;
    const sig = FRAME_SIGNATURES.find((s) => s.match(u));
    if (!sig) {
      if (!f.isMain && frame3dsByName(f.node)) {
        if (big) hits.push({ category: "payment_3ds", blocking: true, signals: [`visible 3-D Secure iframe "${f.node?.attrs["name"] || f.node?.attrs["id"]}" (${u.hostname})`], priority: 1, ...needs3ds(m, f) });
        else m.presence.push(`present:3ds frame ${u.hostname} (hidden)`);
      }
      continue;
    }
    const vendor = sig.vendor;
    // A checkbox-style widget: blocking on a gate page, otherwise "present but will need the human at submit".
    const checkbox = (category: InterruptCategory, auto = false, extra: Pick<Hit, "inPage" | "rect"> = {}): void => {
      if (shown === false) {
        m.presence.push(`present:${desc(sig)} (hidden)`);
        return;
      }
      if (shown === undefined) {
        hits.push({ category, vendor, blocking: false, autoResolvable: auto, signals: [`${desc(sig)} (visibility unknown)`], priority: 4 });
        return;
      }
      const g = gate();
      hits.push({ category, vendor, blocking: g, autoResolvable: auto, signals: [`visible ${desc(sig)}${g ? " on a gate page" : " inside page content"}`], priority: 4, ...extra });
    };
    switch (sig.kind) {
      case "recaptcha-anchor": {
        if (/invisible/.test(u.searchParams.get("size") ?? "")) m.presence.push("present:recaptcha invisible/v3 (badge only)");
        else checkbox("captcha");
        break;
      }
      case "recaptcha-bframe":
      case "arkose-game": {
        if (shown === true && big) hits.push({ category: "captcha", vendor, blocking: true, signals: [`visible ${desc(sig)} (image/puzzle challenge open)`], priority: 2 });
        else if (sig.kind === "arkose-game" && shown === undefined) hits.push({ category: "captcha", vendor, blocking: true, signals: [`${desc(sig)} (puzzle frame exists)`], priority: 2 });
        else m.presence.push(`present:${desc(sig)} (challenge frame not shown)`);
        break;
      }
      case "hcaptcha": {
        const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
        const frame = hash.get("frame") ?? "";
        if (/invisible/.test(frame) || /invisible/.test(hash.get("size") ?? "")) m.presence.push("present:hcaptcha invisible");
        else if (frame === "challenge") {
          if (shown === true && big) hits.push({ category: "captcha", vendor, blocking: true, signals: [`visible ${desc(sig)}#frame=challenge`], priority: 2 });
          else m.presence.push("present:hcaptcha challenge frame (not shown)");
        } else checkbox("captcha");
        break;
      }
      case "turnstile": {
        if (shown === false || (f.rect && area(f.rect) < 100)) {
          m.presence.push("present:cloudflare turnstile (invisible/hidden)");
          break;
        }
        // The widget's box goes with the hit, so the runtime can click it or watch it clear.
        const widget = shown === true && f.rect ? { inPage: true, rect: { ...f.rect } } : {};
        if (cfChallengePage(m)) hits.push({ category: "bot_challenge", vendor, blocking: true, autoResolvable: true, signals: [`${desc(sig)} on a Cloudflare challenge page`], priority: 3, ...widget });
        else checkbox("captcha", true, widget);
        break;
      }
      case "cf-challenge":
        hits.push({ category: "bot_challenge", vendor, blocking: true, autoResolvable: true, signals: [`${where} Cloudflare challenge URL (${/__cf_chl_\w*/.exec(u.search)?.[0] ?? u.pathname.slice(0, 60)})`], priority: 3 });
        break;
      case "datadome": {
        if (/[?&]t=bv\b/.test(u.search)) hits.push({ category: "hard_block", vendor, blocking: true, signals: [`${desc(sig)} t=bv (banned visitor)`], priority: 0 });
        else if (/\/interstitial\//.test(u.pathname)) hits.push({ category: "bot_challenge", vendor, blocking: shown !== false, autoResolvable: true, signals: [`${desc(sig)} device-check interstitial`], priority: 3 });
        else if (/\/captcha\//.test(u.pathname) && shown !== false) hits.push({ category: "captcha", vendor, blocking: true, signals: [`${desc(sig)} (full-page captcha)`], priority: 2 });
        else m.presence.push(`present:${desc(sig)}`);
        break;
      }
      case "arkose":
      case "awswaf":
      case "mtcaptcha":
      case "geetest": {
        if (shown === true && big) hits.push({ category: "captcha", vendor, blocking: true, signals: [`visible ${desc(sig)} (challenge open)`], priority: 2 });
        else if (shown === true && sig.kind !== "geetest") checkbox("captcha");
        else m.presence.push(`present:${desc(sig)}`);
        break;
      }
      case "yandex": {
        if (/advanced/.test(u.pathname) && shown === true) hits.push({ category: "captcha", vendor, blocking: true, signals: [`visible ${desc(sig)} (challenge open)`], priority: 2 });
        else if (/advanced/.test(u.pathname)) m.presence.push(`present:${desc(sig)} (challenge not shown)`);
        else checkbox("captcha");
        break;
      }
      case "imperva": {
        if (shown === true && f.rect && area(f.rect) >= 0.4 * m.vw * m.vh) {
          const inner = buildView(m, f.frameIds).lower;
          if (/incident id|request unsuccessful/.test(inner) || !inner) hits.push({ category: "hard_block", vendor, blocking: true, signals: [`full-page ${desc(sig)}${inner ? " with incident ID" : ""}`], priority: 0 });
          else hits.push({ category: "bot_challenge", vendor, blocking: true, signals: [`full-page ${desc(sig)}`], priority: 3 });
        } else m.presence.push(`present:${desc(sig)}`);
        break;
      }
      case "friendly":
      case "perimeterx":
        m.presence.push(`present:${desc(sig)}${sig.kind === "friendly" ? " (proof-of-work, no user task)" : ""}`);
        break;
      case "3ds-method":
        m.presence.push(`present:${desc(sig)} (3DS device data)`);
        break;
      case "3ds-challenge": {
        if (shown === false || (shown === true && f.rect && (f.rect.width < 100 || f.rect.height < 100))) m.presence.push(`present:${desc(sig)} (hidden)`);
        else hits.push({ category: "payment_3ds", vendor, blocking: true, signals: [`${shown ? "visible " : ""}${desc(sig)}`], priority: 1, ...needs3ds(m, f) });
        break;
      }
      case "duo": {
        if (f.isMain || shown !== false) {
          const view = f.isMain ? pageView(m) : buildView(m, f.frameIds);
          const dn = findDisplayNumber(view);
          hits.push({ category: "push_approval", vendor, blocking: true, needs: "approve_on_device", signals: [`${desc(sig)} (Duo prompt)`], priority: 5, ...(dn ? { displayNumber: dn } : {}) });
        } else m.presence.push(`present:${desc(sig)}`);
        break;
      }
    }
  }
  // IdP host in the main frame.
  if (m.u) {
    const idp = IDP_SIGNATURES.find((s) => s.match(m.u!));
    if (idp) hits.push({ ...refineAuth(m, { category: "login", vendor: idp.vendor, blocking: true, signals: [`main frame on identity provider ${m.u.hostname}${m.u.pathname.slice(0, 40)}`] }), priority: 6 });
  }
  return hits.sort((a, b) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) || (a.priority ?? 9) - (b.priority ?? 9));
}

function* tierB(m: Model): Generator<Hit> {
  yield* frameHits(m);
}

/**
 * A check its response gave away (cf-mitigated) with its widget drawn: the widget's box from its frame, as tier B
 * has it, so the runtime sees a widget drawn anew on that page (a Turnstile frame after a refused click).
 */
function withWidget(hit: Hit, m: Model): Hit {
  if (hit.inPage || !hit.vendor || (hit.category !== "captcha" && hit.category !== "bot_challenge")) return hit;
  // Only the box is taken: what tier B would note as present stays out of this hit's signals.
  const noted = m.presence.length;
  const drawn = frameHits(m).find((h) => h.vendor === hit.vendor && h.inPage);
  m.presence.length = noted;
  return drawn ? { ...hit, inPage: true, ...(drawn.rect ? { rect: { ...drawn.rect } } : {}), ...(drawn.widget ? { widget: drawn.widget } : {}) } : hit;
}

function cfChallengePage(m: Model): boolean {
  if ((m.headers["cf-mitigated"] ?? "") === "challenge") return true;
  if (m.u && /[?&]__cf_chl_/.test(m.u.search)) return true;
  if (/^just a moment|^attention required/i.test(m.title)) return true;
  if (m.snap) {
    const v = pageView(m);
    // Challenge-page markup only; `cf-chl-widget-*` ids belong to every embedded Turnstile widget and do not count.
    if (v.cfChallengeMarkup) return true;
    if (/needs to review the security of your connection|verify(ing)? you are human by completing|performing security verification/.test(v.lower)) return true;
  }
  return false;
}

function needs3ds(m: Model, f: FrameEntry): Pick<Hit, "needs" | "input" | "displayNumber"> {
  if (!m.snap || f.frameIds.length === 0) return { needs: "solve_in_live_view" };
  // Walk all frames nested in the issuer frame (Stripe -> ACS is two levels).
  const ids = new Set<string>(f.frameIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [fid, owner] of m.ownerOf) {
      if (!ids.has(fid) && ids.has(owner.frameId ?? m.mainFrameId)) {
        ids.add(fid);
        grew = true;
      }
    }
  }
  const v = buildView(m, ids);
  const otp = detectOtp(m, v, true);
  if (otp) return { needs: "code", input: otp.input };
  if (PUSH_TEXT.some((re) => re.test(v.lower)) || /\b(banking|bank'?s|mobile) app\b/.test(v.lower)) {
    const dn = findDisplayNumber(v);
    return { needs: "approve_on_device", ...(dn ? { displayNumber: dn } : {}) };
  }
  return { needs: "solve_in_live_view" };
}

// ------------------------------------------------------------------ tier C: snapshot

function matchRules(m: Model, v: View, rules: TextRule[]): Hit | null {
  const small = sparse(m, v);
  for (const r of rules) {
    if (r.sparse && !small && !(r.title && r.title.test(m.title))) continue;
    if (!r.all.every((re) => re.test(v.lower))) continue;
    return { category: r.category, vendor: r.vendor, blocking: true, autoResolvable: r.autoResolvable, signals: [r.signal] };
  }
  return null;
}

/** `inPage`, the box and the node of a HUMAN #px-captcha that is drawn (a box of its own, not display:none). */
function inPageWidget(px: InterruptNode, m: Model): Pick<Hit, "inPage" | "rect" | "widget"> {
  if (!shownEl(px, m.scrollY)) return {};
  const widget = px.backendNodeId !== undefined ? { widget: { backendNodeId: px.backendNodeId, ...(px.frameId ? { frameId: px.frameId } : {}) } } : {};
  return { inPage: true, rect: { ...px.rect! }, ...widget };
}

/** Hard-block text, then challenge text (a solvable widget elsewhere already won in tier B). */
function detectBlockText(m: Model, v: View): Hit | null {
  const hard = matchRules(m, v, HARD_BLOCK_RULES);
  if (hard) {
    // PerimeterX block page with a Press & Hold widget is solvable, not hard.
    return hard;
  }
  const px = v.px;
  if (/access to this page has been denied/.test(v.lower)) {
    if (px) return { category: "captcha", vendor: "human", blocking: true, signals: ["\"Access to this page has been denied\" + #px-captcha (Press & Hold)"], ...inPageWidget(px, m) };
    if (sparse(m, v) || /access to this page has been denied/i.test(m.title) || m.status === 403) return { category: "hard_block", vendor: "human", blocking: true, signals: ["\"Access to this page has been denied\" without a solvable widget"] };
  }
  // A Press & Hold drawn over a full results page does not hide the page from the model, so it
  // is not blocking; `inPage` still hands it to the runtime's ladder rather than leaving it to the model.
  if (px && shownEl(px, m.scrollY)) return { category: "captcha", vendor: "human", blocking: isGate(m) || sparse(m, v), signals: ["visible #px-captcha (Press & Hold)"], ...inPageWidget(px, m) };
  if (v.geetest) return { category: "captcha", vendor: "geetest", blocking: true, signals: ["visible GeeTest challenge panel"] };
  if (v.amazonCaptchaForm) return { category: "captcha", vendor: "amazon", blocking: true, signals: ["form action /errors/validateCaptcha"] };
  const ch = matchRules(m, v, CHALLENGE_RULES);
  if (ch) {
    if (ch.vendor === "cloudflare" || (ch.category === "bot_challenge" && cfChallengePage(m))) {
      ch.vendor = "cloudflare";
      ch.autoResolvable = true;
    }
    return ch;
  }
  return null;
}

interface OtpFinding {
  input: InterruptInputRequest;
  signals: string[];
  strong: boolean;
}

function digitsOnlyOf(i: InputInfo): boolean {
  const pat = i.node.attrs["pattern"] ?? "";
  return i.inputMode === "numeric" || i.inputMode === "decimal" || i.type === "number" || i.type === "tel" || /^\^?(\[0-9\]|\\d)[*+{]/.test(pat);
}

function codeLengthFromText(lower: string): number | undefined {
  const m = /\b([4-8])[- ]digit\b/.exec(lower) ?? /\b(four|five|six|seven|eight)[- ]digit\b/.exec(lower);
  if (!m) return undefined;
  const words: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  return words[m[1]!] ?? Number(m[1]);
}

const MASK = /[•*●·xX]{2,}[\s•*●·xX-]*\d{2,4}\b|\(\*{3}\)\s*\*{3}-\d{2,4}|\bending (in|with) \d{2,4}\b|[\w.+-]*[•*●·]{2,}[\w.+-]*@[\w-]+(\.[\w-]+)+|\b[\w.+-]{1,3}\*{2,}@[\w.-]+/i;
const BLOCK_TAGS = new Set(["p", "div", "li", "label", "h1", "h2", "h3", "h4", "h5", "h6", "section", "form", "td", "main", "article", "header"]);

/** The sentence of the block element around `t` that contains `re` (text nodes split "sent to <b>•••1234</b>."). */
function sentenceAround(t: InterruptNode, re: RegExp): string | undefined {
  let block: InterruptNode | null = t.parent ?? null;
  while (block && !BLOCK_TAGS.has(block.tag)) block = block.parent ?? null;
  const text = block ? textOfNode(block, 400) : norm(t.text ?? "");
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const s = sentences.find((x) => re.test(x)) ?? (re.test(text) ? text : undefined);
  return s?.replace(/\s+([.,!?;:])/g, "$1").slice(0, 160);
}

const CONTROL_ROLES = new Set(["button", "link", "menuitem", "tab", "option", "radio"]);

/**
 * What the page says rather than offers to click: text nodes outside links, buttons and other controls.
 * "Use your authenticator app instead" or "Text •••1234 instead" on an email-code page is a choice, not
 * where this code went.
 */
function proseOf(v: View): { nodes: InterruptNode[]; lower: string } {
  if (v._prose) return v._prose;
  const nodes = v.textNodes.filter((t) => !ancestors(t, 8).some((a) => a.tag === "a" || a.tag === "button" || CONTROL_ROLES.has(a.role ?? "") || CONTROL_ROLES.has(a.attrs["role"] ?? "")));
  return (v._prose = { nodes, lower: norm(nodes.map((t) => t.text ?? "").join(" ")).toLowerCase() });
}

/** Where the code (or link) was sent: the sentence with a masked phone/email, else the channel. Read from the page's prose, never from links or buttons. */
function codeHint(v: View): string | undefined {
  const prose = proseOf(v);
  const masked = prose.nodes.find((t) => MASK.test(t.text ?? ""));
  if (masked) return sentenceAround(masked, MASK);
  if (/authenticator app|\bauthenticator\b|\btotp\b/.test(prose.lower)) return "authenticator app";
  const sentRe = /\b(sent|texted|emailed)\b[^.]{0,80}\b(code|otp|passcode|link)\b|\b(code|link)\b[^.]{0,40}\b(sent|texted|emailed)\b/i;
  const sent = prose.nodes.find((t) => sentRe.test(t.text ?? ""));
  if (sent) return sentenceAround(sent, sentRe);
  if (/\b(text message|sms)\b/.test(prose.lower)) return "SMS";
  if (/\be-?mail\b/.test(prose.lower)) return "email";
  return undefined;
}

/** A code field label that names no channel: a split box's own name, or just "code". */
const GENERIC_LABEL = /^((digit|character|char|box|number)\s*\d*( of \d+)?|\d+|(enter |type )?(the |your |a )?(\d[- ]digit )?((verification|security|one[- ]time|sign[- ]in|login|confirmation|access|authentication) )?(code|otp|pin|passcode))$/i;
/** Label words that say where a code comes from. */
const CHANNEL_WORDS = /\b(authenticator|app|backup|recovery|e-?mail|inbox|sms|text|phone|mobile)\b/i;

/** The nearest heading (h1-h6, role=heading) before `n` in document order, within the view. */
function headingAbove(v: View, n: InterruptNode): string | undefined {
  const i = v.elements.indexOf(n);
  for (let k = i - 1; k >= 0; k--) {
    const e = v.elements[k]!;
    if (/^h[1-6]$/.test(e.tag) || e.role === "heading" || e.attrs["role"] === "heading") {
      const t = textOfNode(e, 160);
      if (t) return t;
    }
  }
  return undefined;
}

/**
 * The code field's own label (its accessible name, aria-label or placeholder) when it names a channel,
 * else the heading above it ("Enter a backup code"), else the plain label. Never link text.
 */
function codeLabel(v: View, fields: InputInfo[]): string | undefined {
  const n = fields[0]?.node;
  if (!n) return undefined;
  const own = fields.length === 1 ? norm(n.name || n.attrs["aria-label"] || n.attrs["placeholder"] || n.attrs["title"] || "").slice(0, 120) : "";
  const useful = own && !GENERIC_LABEL.test(own) ? own : "";
  if (useful && CHANNEL_WORDS.test(useful)) return useful;
  return headingAbove(v, n) ?? (useful || own || undefined);
}

const REMEMBER = /\bremember (this |my )?(device|browser|computer|me)\b|\bdon'?t ask (me )?(again|for (a |codes? )?(again|on this))\b|\btrust this (device|browser|computer)\b|\b(keep me|stay) (signed|logged) in\b/i;

/**
 * An unticked "Remember this device" / "Don't ask again on this browser" / "Keep me signed in" box near
 * the code field (in its form, else within a few levels of it): its ref, for the agent to tick before
 * it enters the code.
 */
function rememberBox(m: Model, field: InterruptNode): string | undefined {
  const anc = ancestors(field, 8);
  const scope = anc.find((a) => a.tag === "form") ?? anc[Math.min(3, anc.length - 1)];
  if (!scope) return undefined;
  const stack = [...scope.children];
  while (stack.length) {
    const n = stack.shift()!;
    stack.push(...n.children);
    const box = (n.tag === "input" && (n.attrs["type"] ?? "").toLowerCase() === "checkbox") || n.role === "checkbox" || n.attrs["role"] === "checkbox";
    if (!box || n.attrs["disabled"] !== undefined) continue;
    const checked = n.checked ?? (n.attrs["aria-checked"] === "true" || n.attrs["checked"] !== undefined);
    if (checked) continue;
    const lab = ancestors(n, 4).find((a) => a.tag === "label");
    const text = `${n.name ?? ""} ${n.attrs["aria-label"] ?? ""} ${lab ? textOfNode(lab, 160) : n.parent ? textOfNode(n.parent, 160) : ""}`;
    if (!REMEMBER.test(text)) continue;
    // A styled box hides its input: the label is what takes the click then.
    const ref = n.ref ?? (n.visible ? undefined : lab?.ref);
    if (ref && (n.visible || lab?.visible || shownEl(n, m.scrollY))) return ref;
  }
  return undefined;
}

function detectOtp(m: Model, v: View, inIssuerFrame = false): OtpFinding | null {
  const lower = v.lower;
  const candidates = v.inputs.filter(
    (i) =>
      !i.inSearch &&
      !SEARCH_NAME.test(i.tokens) &&
      !["email", "password", "url", "date", "time", "datetime-local", "month", "week"].includes(i.type) &&
      !(i.type === "textarea" && !i.ac.includes("one-time-code")) &&
      !i.ac.some((t) => t.startsWith("cc-") || t === "postal-code" || t === "username" || t === "email"),
  );
  if (candidates.length === 0) return null;
  const textCue = OTP_TEXT.find((re) => re.test(lower) && !(re.source.includes("security") && v.hasCardFields && /security code/.test(lower) && !/\b(sent|texted|emailed)\b/.test(lower)));
  const build = (fields: InputInfo[], why: string[], strong: boolean, length?: number): OtpFinding => {
    const refs = fields.map((f) => f.node.ref).filter((r): r is string => !!r);
    const maxLen = fields.length === 1 && fields[0]!.maxLength && fields[0]!.maxLength >= 4 && fields[0]!.maxLength <= 8 ? fields[0]!.maxLength : undefined;
    const textLen = codeLengthFromText(lower);
    const len = length ?? maxLen ?? textLen;
    // A maxlength the text agrees with ("6-digit", maxlength=6) is exact too.
    const from: InterruptInputRequest["lengthFrom"] = length ? "boxes" : maxLen ? (textLen === maxLen ? "text" : "maxlength") : textLen ? "text" : undefined;
    const digits = fields.every(digitsOnlyOf) || /\b\d[- ]digit\b|\b(six|four|eight)[- ]digit\b/.test(lower);
    const hint = codeHint(v);
    const label = codeLabel(v, fields);
    const remember = fields[0] ? rememberBox(m, fields[0].node) : undefined;
    return {
      input: { kind: "code", ...(len ? { length: len, lengthFrom: from } : {}), digitsOnly: digits, ...(refs.length ? { fieldRefs: refs } : {}), ...(hint ? { hint } : {}), ...(label ? { label } : {}), ...(remember ? { rememberRef: remember } : {}) },
      signals: why,
      strong,
    };
  };
  // 1) autocomplete=one-time-code.
  const ac = candidates.filter((i) => i.ac.includes("one-time-code"));
  if (ac.length) {
    const split = ac.length >= 4 && ac.every((i) => i.maxLength === 1);
    return build(ac, [`autocomplete=one-time-code${split ? ` ×${ac.length}` : ""}`], true, split ? ac.length : undefined);
  }
  // 2) 4–8 single-character boxes in one row. Boxes with no maxlength count when narrow (90 px at most) and the page's
  // text asks for a code (24 Nov: a shopping site's six boxes had none, so its code page was no code prompt and the
  // model typed the whole code into the first box).
  const narrow = (i: InputInfo) => i.maxLength === null && !!i.node.rect && i.node.rect.width > 0 && i.node.rect.width <= 90;
  const singles = candidates.filter((i) => (i.maxLength === 1 || (!!textCue && narrow(i))) && ["text", "tel", "number", "password"].includes(i.type));
  if (singles.length >= 4) {
    // Up to five levels: a box may sit in wrappers of its own (24 Nov: a shopping site's six boxes shared only their
    // fourth ancestor, each in div > div > div of its own).
    for (let level = 1; level <= 5; level++) {
      const groups = new Map<InterruptNode, InputInfo[]>();
      for (const s of singles) {
        const a = ancestors(s.node, level)[level - 1];
        if (!a) continue;
        let g = groups.get(a);
        if (!g) groups.set(a, (g = []));
        g.push(s);
      }
      for (const g of groups.values()) {
        if (g.length < 4 || g.length > 8) continue;
        const ys = g.map((i) => i.node.rect!.y);
        const h = Math.max(...g.map((i) => i.node.rect!.height));
        if (Math.max(...ys) - Math.min(...ys) > h * 0.6) continue;
        // Unsized boxes are one width (within half again), as a code's boxes are.
        const ws = g.map((i) => i.node.rect!.width);
        if (g.some(narrow) && Math.max(...ws) > Math.min(...ws) * 1.5) continue;
        const sorted = [...g].sort((a, b) => a.node.rect!.x - b.node.rect!.x);
        const ctx = textCue || authContext(m, v) || g.every(digitsOnlyOf) || inIssuerFrame;
        if (!ctx) continue;
        return build(sorted, [`${g.length} single-character inputs in a row`, ...(textCue ? ["code prompt text"] : [])], true, g.length);
      }
    }
  }
  // 3) A code-named field with a 4–8 maxlength.
  const named = candidates.filter((i) => OTP_NAME.test(i.tokens) && !OTP_NAME_EXCLUDE.test(i.tokens));
  const sized = named.find((i) => i.maxLength !== null && i.maxLength >= 4 && i.maxLength <= 8);
  if (sized && (textCue || authContext(m, v) || sparse(m, v) || inIssuerFrame)) {
    return build([sized], [`code field "${sized.nameish.slice(0, 40)}" maxlength=${sized.maxLength}`, ...(textCue ? ["code prompt text"] : [])], true);
  }
  // 4) Strongly-named field (otp/totp/mfa/2fa…) or a lone short field, with prompt text on an auth-ish/sparse page.
  // Weakest evidence: prompt text + a field, on a page that is not a content page, with a URL-level auth context
  // (not just a title) or a gate-sized page.
  if (textCue && medium(v) && (authUrlContext(m) || sparse(m, v) || inIssuerFrame)) {
    const strongName = named.find((i) => /\b(otp|totp|hotp|mfa|2fa|tfa|passcode|one ?time|onetime|verification|vcode|authcode|smscode|pin|code)\b/.test(i.tokens));
    const lone = candidates.length === 1 ? candidates[0]! : undefined;
    const plausible = lone && lone.inViewport && !OTP_NAME_EXCLUDE.test(lone.tokens) && !NOT_A_CODE_NAME.test(lone.tokens) && (lone.maxLength === null || lone.maxLength <= 12);
    const pick = strongName ?? (plausible ? lone : undefined);
    if (pick) return build([pick], [`code prompt text + field "${pick.nameish.slice(0, 40) || pick.type}"`], false);
  }
  return null;
}

function findDisplayNumber(v: View): string | undefined {
  const lower = v.lower;
  const phrase = /\b(?:tap|select|choose|pick|press)\s+(?:the\s+number\s+)?(\d{2,3})\b/.exec(lower) ?? /\bnumber\s+(\d{2,3})\b/.exec(lower);
  if (phrase) return phrase[1];
  if (!/\b(number|digits?|code|match)\b/.test(lower)) return undefined;
  let best: { n: string; score: number } | undefined;
  for (const e of v.elements) {
    if (!e.visible || isInteractive(e)) continue;
    const own = e.children.filter(isTextNode).map((c) => c.text ?? "").join("").trim();
    if (!/^\d{2,3}$|^\d{6}$/.test(own)) continue;
    if (ancestors(e, 6).some((a) => ["a", "button", "li", "option", "td", "th", "label", "time"].includes(a.tag))) continue;
    const hintAttr = `${e.attrs["id"] ?? ""} ${e.attrs["class"] ?? ""} ${e.attrs["data-testid"] ?? ""}`;
    const score = (/display|sign|number|digit|match|challenge|verif|code/i.test(hintAttr) ? 100 : 0) + (e.rect?.height ?? 0);
    if (!best || score > best.score) best = { n: own, score };
  }
  return best?.n;
}

/** Auth steps after a password: otp, push, passkey, magic link. `ctx` is set when the caller already knows it is an auth page. */
function detectAuthStep(m: Model, v: View, ctxKnown: boolean): Hit | null {
  const ctx = ctxKnown ? "auth page" : authContext(m, v);
  const small = sparse(m, v);
  const otp = detectOtp(m, v);
  if (otp && (otp.strong || ctx || small)) {
    return { category: "otp", blocking: true, needs: "code", input: otp.input, signals: [...otp.signals, ...(ctx ? [ctx] : [])] };
  }
  // Text-only steps: these screens are tiny. A help article about 2FA ("check your phone", "check your email")
  // must not trip them, so they need a gate-sized page or an already-known auth page (IdP host, login wall).
  const gateLike = small || ctxKnown;
  if (!gateLike && !(ctx && medium(v))) return null;
  const textInputs = v.inputs.filter((i) => !i.inSearch && i.inViewport);
  const push = gateLike ? PUSH_TEXT.find((re) => re.test(v.lower)) : undefined;
  if (push) {
    const dn = findDisplayNumber(v);
    const vendor = /okta verify/.test(v.lower) ? "okta" : /duo (push|mobile)/.test(v.lower) ? "duo" : /microsoft authenticator|authenticator app/.test(v.lower) && m.u && /microsoft|live\.com/.test(m.u.hostname) ? "microsoft" : /github mobile/.test(v.lower) ? "github" : undefined;
    return { category: "push_approval", vendor, blocking: true, needs: "approve_on_device", ...(dn ? { displayNumber: dn } : {}), signals: [`push prompt text "${push.exec(v.lower)?.[0] ?? ""}"`, ...(dn ? [`number to match: ${dn}`] : []), ...(ctx ? [ctx] : [])] };
  }
  const passkey = gateLike ? PASSKEY_TEXT.find((re) => re.test(v.lower)) : undefined;
  if (passkey && textInputs.length === 0) {
    return { category: "passkey", blocking: true, needs: "login_in_live_view", signals: [`passkey / security key prompt "${passkey.exec(v.lower)?.[0] ?? ""}"`, "a remote browser cannot reach the user's authenticator; pick another method in the live view", ...(ctx ? [ctx] : [])] };
  }
  const strongMagic = MAGIC_STRONG.find((re) => re.test(v.lower));
  const weakMagic = MAGIC_WEAK.test(v.lower);
  // Strong phrasing ("we sent you a sign-in link") may sit on a medium auth page; bare "check your email" needs a gate.
  if ((strongMagic && (weakMagic || /\b(sent|emailed|check)\b/.test(v.lower))) || (weakMagic && ctx && gateLike)) {
    const hint = codeHint(v);
    return { category: "magic_link", blocking: true, needs: "approve_on_device", input: { kind: "link", ...(hint ? { hint } : {}) }, signals: [strongMagic ? "sign-in link sent text" : "\"check your email\" on an auth page", ...(ctx ? [ctx] : [])] };
  }
  return null;
}

/** Location cues: an identity-provider host, a login path, or a login title. */
function loginUrlCue(m: Model): string | null {
  if (m.u && IDP_SIGNATURES.some((s) => s.match(m.u!))) return "identity-provider host";
  if (m.u && LOGIN_PATH.test(m.u.pathname)) return `login URL ${m.u.pathname.slice(0, 50)}`;
  if (LOGIN_WORDS.test(m.title)) return `login title "${m.title.slice(0, 60)}"`;
  return null;
}

/** A login heading, counted only on pages that are not content pages. */
function loginHeadingCue(v: View): string | null {
  if (!medium(v)) return null;
  const h = v.headings.find((t) => LOGIN_WORDS.test(t) && t.length <= 80);
  return h ? `login heading "${h}"` : null;
}

function detectLogin(m: Model, v: View): Hit | null {
  const pw = v.inputs.filter((i) => i.type === "password" && !i.ac.includes("one-time-code"));
  const newPw = pw.filter((i) => i.ac.includes("new-password"));
  const loginPw = pw.filter((i) => !i.ac.includes("new-password"));
  if (pw.length && newPw.length && (newPw.length === pw.length || loginPw.some((i) => i.ac.includes("current-password")))) {
    m.presence.push(newPw.length === pw.length ? "present:sign-up form (new-password)" : "present:change-password form");
    return null;
  }
  const urlCue = loginUrlCue(m);
  const cues = urlCue ?? loginHeadingCue(v);
  const conditional = v.inputs.some((i) => i.ac.includes("webauthn"));
  const extra = conditional ? ["passkey conditional UI (autocomplete webauthn)"] : [];
  if (loginPw.length) {
    const p = loginPw.find((i) => i.inViewport) ?? loginPw[0]!;
    const modal = p.inDialog;
    const small = sparse(m, v);
    const dominant = modal || (p.inViewport && (!!cues || small));
    const why = [`visible password field${p.inViewport ? " in the viewport" : " below the fold"}`, ...(modal ? ["inside a modal dialog"] : []), ...(cues ? [cues] : []), ...(small ? [`small page (${v.interactiveVp} interactive, ${v.lower.length} chars)`] : [`${v.interactiveVp} interactive elements in view`]), ...extra];
    return { category: "login", blocking: dominant, needs: "login_in_live_view", signals: dominant ? why : [...why, "login form is not the dominant content"] };
  }
  // Identifier-first step (Google, Microsoft, Amazon, Okta): username/email field on a login page.
  const user = v.inputs.find((i) => i.inViewport && !i.inSearch && (i.ac.includes("username") || i.ac.includes("webauthn") || USERNAME_NAME.test(i.node.attrs["name"] ?? "") || USERNAME_NAME.test(i.node.attrs["id"] ?? "")));
  if (user && cues) {
    const strongUser = user.ac.includes("username") || user.ac.includes("webauthn");
    const otherFields = v.inputs.filter((i) => i !== user && !i.inSearch && i.inViewport && i.type !== "password").length;
    // A newsletter box is an email field without username semantics: it needs a login URL, or a login heading on a small page.
    if ((strongUser && otherFields <= 2) || (otherFields <= 1 && (urlCue || sparse(m, v)))) {
      return { category: "login", blocking: true, needs: "login_in_live_view", signals: [`identifier-first sign-in field "${(user.node.attrs["name"] ?? user.node.attrs["id"] ?? user.type).slice(0, 30)}"`, cues, ...extra] };
    }
  }
  return null;
}

/**
 * A site saying it does not serve the visitor's country or region ("This service is not available in your country",
 * "Not available in your region", HTTP 451). Not a bot defence: another exit in the same country, a headed browser or a
 * person in the live view changes nothing; only another country does.
 */
export const GEO_BLOCK_TEXT =
  /\b(?:(?:is|are)\s+)?(?:not|n[o']t|no\s+longer|currently\s+not)\s+(?:currently\s+|yet\s+)?(?:available|accessible|offered|supported|operating)\s+(?:in|from|for|to)\s+(?:your|this|the)\s+(?:country|region|location|area|territory|market)\b|\b(?:unavailable|restricted|blocked)\s+(?:in|from)\s+your\s+(?:country|region|location|area)\b|\bgeo-?(?:restricted|blocked|graphically\s+restricted)\b|\b(?:is|are)?\s*not\s+(?:available|accessible)\s+outside\s+(?:of\s+)?(?:the\s+)?(?:u\.?s\.?a?\.?|united\s+states|america|u\.?k\.?|united\s+kingdom|great\s+britain|eu|e\.u\.|european\s+union|eea|europe|india|canada|australia|japan|germany|france)\b|\b(?:is|are)\s+only\s+(?:available|accessible)\s+(?:in|within|to\s+(?:users|customers|residents)\s+(?:in|of))\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united\s+states|america|u\.?k\.?|united\s+kingdom|great\s+britain|eu|e\.u\.|european\s+union|eea|europe|india|canada|australia|japan|germany|france)\b|\b(?:access|service|content)\s+(?:from|in)\s+your\s+(?:country|region|location)\s+(?:is|has\s+been)\s+(?:restricted|blocked|denied|not\s+(?:permitted|allowed|supported))\b|\bwe\s+(?:do\s+not|don'?t|cannot|can'?t)\s+(?:currently\s+)?(?:serve|operate\s+in|ship\s+to|deliver\s+to|support)\s+(?:visitors\s+from\s+|users\s+(?:in|from)\s+)?your\s+(?:country|region|location|area)\b/i;

function geoBlock(m: Model, v: View): Hit | null {
  const head = `${m.title} ${v.headings.join(" ")}`;
  if (m.status === 451) return { category: "hard_block", vendor: "geo", blocking: true, signals: ["451 Unavailable For Legal Reasons"] };
  // In the title or a heading anywhere; in the text only on a small page (a help article may mention it in passing).
  const hit = GEO_BLOCK_TEXT.exec(head) ?? (sparse(m, v) ? GEO_BLOCK_TEXT.exec(v.lower) : null);
  return hit ? { category: "hard_block", vendor: "geo", blocking: true, signals: [`not served in this country: "${hit[0].slice(0, 80)}"`] } : null;
}

function genericBlock(m: Model, v: View): Hit | null {
  const geo = geoBlock(m, v);
  if (geo) return geo;
  if (!sparse(m, v)) return null;
  const st = m.status;
  const phrase = /\b(access (is )?denied|forbidden|you have been blocked|your (ip|ip address|request|access) (has been|was|is) (blocked|denied)|blocked by (the )?(website|site|security|firewall))\b/;
  const head = `${m.title} ${v.headings.join(" ")}`.toLowerCase();
  if (st && [403, 451].includes(st) && phrase.test(v.lower)) return { category: "hard_block", blocking: true, signals: [`${st} + "${phrase.exec(v.lower)![0]}" on a small page`] };
  if (st === 429 && /too many requests|rate limit/.test(v.lower)) return { category: "hard_block", blocking: true, signals: ["429 rate limited"] };
  if (!st && /\b(access denied|you have been blocked)\b/.test(head)) return { category: "hard_block", blocking: true, signals: [`title/heading "${head.slice(0, 60)}"`] };
  return null;
}

function* tierC(m: Model): Generator<Hit> {
  if (!m.snap) return;
  const v = pageView(m);
  const block = detectBlockText(m, v);
  if (block) yield block;
  const login = detectLogin(m, v);
  if (login?.blocking) {
    yield login;
    return;
  }
  const step = detectAuthStep(m, v, false);
  if (step) yield step;
  if (login) yield login;
  const g = genericBlock(m, v);
  if (g) yield g;
}

/** A login decided from the URL/host alone: prefer the more specific auth step the page actually shows. */
function refineAuth(m: Model, hit: Hit): Hit {
  if (!m.snap) return hit;
  const v = pageView(m);
  const hard = matchRules(m, v, HARD_BLOCK_RULES);
  if (hard) return { ...hard, vendor: hard.vendor ?? hit.vendor, signals: [...hard.signals, ...hit.signals] };
  // A check page at a sign-in address (a puzzle between the login and the account): the check, not the sign-in, so it
  // goes to the challenge ladder and the person. The provider is not the check's vendor: only the rule's own is kept.
  const check = matchRules(m, v, CHALLENGE_RULES);
  if (check) return { ...check, signals: [...check.signals, ...hit.signals] };
  if (v.inputs.some((i) => i.type === "password" && i.inViewport)) return { ...hit, needs: "login_in_live_view" };
  const step = detectAuthStep(m, v, true);
  if (step) return { ...step, vendor: step.vendor ?? hit.vendor, signals: [...step.signals, ...hit.signals] };
  return { ...hit, needs: "login_in_live_view" };
}

// ------------------------------------------------------------------ public API

const DEFAULT_NEEDS: Record<InterruptCategory, InterruptNeeds> = {
  none: "nothing",
  captcha: "solve_in_live_view",
  bot_challenge: "solve_in_live_view",
  hard_block: "none_possible",
  login: "login_in_live_view",
  otp: "code",
  push_approval: "approve_on_device",
  magic_link: "approve_on_device",
  passkey: "login_in_live_view",
  payment_3ds: "solve_in_live_view",
  http_auth: "credentials",
  fedcm: "nothing",
};

function finalize(hit: Hit, m: Model): Interruption {
  const signals = [...hit.signals, ...m.presence.filter((p) => !hit.signals.includes(p))].slice(0, 16);
  const out: Interruption = {
    category: hit.category,
    blocking: hit.blocking,
    autoResolvable: hit.autoResolvable ?? false,
    signals,
    needs: hit.needs ?? DEFAULT_NEEDS[hit.category],
  };
  if (hit.vendor) out.vendor = hit.vendor;
  if (hit.input) out.input = hit.input;
  if (hit.displayNumber) out.displayNumber = hit.displayNumber;
  if (hit.inPage) {
    out.inPage = true;
    if (hit.rect) out.rect = hit.rect;
    if (hit.widget) out.widget = hit.widget;
  }
  return out;
}

/**
 * Classify the page. Pure and synchronous; typically well under a millisecond
 * for tiers A/B and a few milliseconds over a large snapshot.
 */
export function classifyInterruption(input: InterruptInput): Interruption {
  const m = buildModel(input);
  const pending: Hit[] = [];
  for (const tier of [tierA, tierB, tierC]) {
    for (const hit of tier(m)) {
      if (hit.blocking) return finalize(tier === tierA ? withWidget(hit, m) : hit, m);
      pending.push(hit);
    }
  }
  const fed = input.fedcmDialog;
  if (fed) {
    const type = typeof fed === "object" && fed.dialogType ? ` (${fed.dialogType})` : "";
    pending.push({ category: "fedcm", blocking: false, autoResolvable: true, signals: [`FedCM dialog showing${type}; browser UI, not in the page or the live view — dismiss with FedCm.dismissDialog or ask the user`] });
  }
  if (pending.length) return finalize(pending[0]!, m);
  return finalize({ category: "none", blocking: false, signals: [] }, m);
}

// ------------------------------------------------------------------ resume predicates

export interface Resolution {
  resolved: boolean;
  signals: string[];
}

function navigated(before: InterruptInput, after: InterruptInput): string | null {
  if (after.navigatedAt && before.navigatedAt !== undefined && after.navigatedAt > before.navigatedAt) return "main-frame navigation";
  const ub = buildUrlKey(before);
  const ua = buildUrlKey(after);
  if (ub && ua && ub !== ua) return `URL changed (${ua.slice(0, 80)})`;
  const rb = before.response;
  const ra = after.response;
  if (rb && ra && (rb.status !== ra.status || rb.url !== ra.url)) return `new document response (${ra.status})`;
  return null;
}

function buildUrlKey(i: InterruptInput): string {
  const u = parseUrl(i.snapshot?.url || i.url || i.response?.url || i.frameUrls?.[0]);
  if (!u) return "";
  for (const k of [...u.searchParams.keys()]) if (/^__cf_chl_/.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.href;
}

function clearanceChanged(before: InterruptInput, after: InterruptInput): string | null {
  const b = cookieMap(before.cookies);
  const a = cookieMap(after.cookies);
  for (const name of CLEARANCE_COOKIES) {
    if (!a.has(name)) continue;
    if (!b.has(name)) return `clearance cookie ${name} set`;
    const vb = b.get(name);
    const va = a.get(name);
    if (va !== undefined && vb !== undefined && va !== vb) return `clearance cookie ${name} changed`;
  }
  return null;
}

function tokenFilled(after: InterruptInput): string | null {
  for (const n of after.snapshot?.nodes ?? []) {
    if (n.tag !== "input" && n.tag !== "textarea") continue;
    const nm = n.attrs["name"] ?? n.attrs["id"] ?? "";
    if (TOKEN_INPUT.test(nm) && (n.value ?? n.attrs["value"] ?? "").length > 0) return `token input ${nm} filled`;
  }
  return null;
}

function loginLocation(i: InterruptInput): boolean {
  const u = parseUrl(i.snapshot?.url || i.url || i.response?.url || i.frameUrls?.[0]);
  if (!u) return false;
  return IDP_SIGNATURES.some((s) => s.match(u)) || LOGIN_PATH.test(u.pathname) || /[?&]SAMLRequest=/i.test(u.search);
}

/** Steps after a password: a code, an approval on a device, an emailed link, a passkey. */
const AFTER_PASSWORD = new Set<InterruptCategory>(["otp", "push_approval", "magic_link", "passkey"]);

/**
 * An address that belongs to a sign-in: an identity provider, or a path with a login, sign-in, 2FA,
 * verify, checkpoint or challenge segment ("/login", "/checkpoint/challenge/…", "/sessions/two-factor").
 * A page there is not past the sign-in yet.
 */
export function isAuthUrl(url: string): boolean {
  const u = parseUrl(url);
  if (!u) return false;
  return loginLocation({ url }) || AUTH_STEP_PATH.test(u.pathname) || CHALLENGE_SEGMENT(u.pathname);
}

/** Why (or why not) the interruption of `category` seen in `before` is over in `after`. */
export function explainResolution(category: InterruptCategory, before: InterruptInput, after: InterruptInput): Resolution {
  const now = classifyInterruption(after);
  const ma = buildModel(after);
  const signals: string[] = [];
  const stillSame = now.blocking && now.category === category;
  switch (category) {
    case "none":
    case "fedcm":
      if (category === "fedcm" && after.fedcmDialog) return { resolved: false, signals: ["FedCM dialog still showing"] };
      return { resolved: true, signals: [] };
    case "captcha":
    case "bot_challenge": {
      const open = frameHits(ma).filter((h) => h.blocking && (h.category === "captcha" || h.category === "bot_challenge"));
      const puzzleOpen = open.some((h) => (h.priority ?? 9) <= 2); // image/puzzle challenge frame visible
      const gated = now.blocking && (now.category === "captcha" || now.category === "bot_challenge");
      // No way past it either: a block page (HUMAN's reads as one while its widget is off between holds, and its
      // collector rewrites _px3 meanwhile), or the check's own widget still drawn in the page (HUMAN's in-page
      // Press & Hold rewrites its cookie as the pointer moves over it).
      const was = classifyInterruption(before);
      const drawn = !!now.inPage && (now.category === "captcha" || now.category === "bot_challenge") && (!was.vendor || now.vendor === was.vendor);
      const blocked = now.category === "hard_block" || drawn;
      const nav = navigated(before, after);
      const cookie = clearanceChanged(before, after);
      const token = tokenFilled(after);
      signals.push(
        gated ? `still ${now.category}: ${now.signals[0] ?? ""}` : blocked ? `${drawn ? "widget still drawn" : "block page"}: ${now.signals[0] ?? ""}` : "challenge gone or hidden",
        ...(nav ? [nav] : []),
        ...(cookie ? [cookie] : []),
        ...(token ? [token] : []),
      );
      // Gate passed and the page moved on; or an inline widget produced its token (it stays drawn, ticked) and no puzzle is open.
      const resolved = (!gated && !blocked && !!(nav || cookie || token)) || (!!token && !puzzleOpen);
      return { resolved, signals };
    }
    case "login": {
      const fields = ma.snap ? pageView(ma).inputs.some((i) => i.type === "password" || i.ac.includes("username") || i.ac.includes("current-password")) : false;
      const onLogin = loginLocation(after);
      // The password went in, but a code, an approval or a checkpoint stands between it and the site:
      // the sign-in is not done yet (a live-view login is not "resolved" on the PIN page).
      const step = now.blocking && AFTER_PASSWORD.has(now.category) ? now.category : null;
      // A checkpoint address: an auth-only segment ("/checkpoint/…", "/mfa"), or "/verify", "/confirm" or
      // "/challenge" on a page whose title or a heading says it is a sign-in step. A checkout's
      // "/checkout/confirm" after the person signed in is the site, not a step.
      const checkpoint =
        !!ma.u &&
        (AUTH_ONLY_STEP_SEGMENT(ma.u.pathname) || (AUTH_STEP_PATH.test(ma.u.pathname) && (SIGN_IN_STEP_WORDS.test(ma.title) || (!!ma.snap && pageView(ma).headings.some((h) => h.length <= 100 && SIGN_IN_STEP_WORDS.test(h))))));
      signals.push(fields ? "login fields still visible" : "login fields gone", onLogin ? "still on a login host/path" : "left the login host/path");
      if (step) signals.push(`now ${step}`);
      if (checkpoint) signals.push("on a verification path");
      return { resolved: !fields && !onLogin && !(now.blocking && now.category === "login") && !step && !checkpoint, signals };
    }
    case "otp":
    case "push_approval":
    case "passkey":
    case "magic_link": {
      const v = ma.snap ? pageView(ma) : null;
      const prompt = v ? detectAuthStep(ma, v, true) : null;
      const same = prompt?.category === category || stillSame;
      signals.push(same ? `${category} prompt still shown` : `${category} prompt gone`);
      if (now.blocking && now.category !== category) signals.push(`now ${now.category}`);
      return { resolved: !same, signals };
    }
    case "payment_3ds": {
      const open = frameHits(ma).some((h) => h.category === "payment_3ds" && h.blocking);
      // A payment the person completes on the site's own page (a UPI QR to scan, an approval in their app, card details),
      // with no issuer frame: done once the page moves on from it (the site's confirmation, its next step).
      if (!frameHits(buildModel(before)).some((h) => h.category === "payment_3ds" && h.blocking)) {
        const nav = navigated(before, after);
        return { resolved: !open && !!nav, signals: [open ? "issuer frame shown" : nav ?? "still on the payment page"] };
      }
      return { resolved: !open, signals: [open ? "issuer frame still shown" : "issuer frame gone"] };
    }
    case "http_auth": {
      const pending = !!after.httpAuthRequired || after.response?.status === 401 || after.response?.status === 407;
      return { resolved: !pending, signals: [pending ? "credentials still requested" : "no auth challenge"] };
    }
    case "hard_block":
      return { resolved: !stillSame, signals: [stillSame ? "still blocked" : "block page gone"] };
  }
}

/** Resume predicate: has the interruption of `category` seen in `before` been dealt with in `after`? */
export function isResolved(category: InterruptCategory, before: InterruptInput, after: InterruptInput): boolean {
  return explainResolution(category, before, after).resolved;
}

export { DocumentChangedError, gatherInterruptInput, trackMainResponse, frameUrls } from "./interrupts-cdp.js";
export type { MainResponseTracker, GatherOptions } from "./interrupts-cdp.js";
