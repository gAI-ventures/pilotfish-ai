// How a person signs in to a site: the ways the sign-in page on screen offers (a password, a phone number a code is
// texted to, an email a code or link is sent to, an email or username first with the rest on the next page, a passkey,
// a provider such as Google), and which way the person asked for in their own words. Many sites sign in by phone and
// a texted code with no password at all (food delivery, ride hailing, banks and wallets in much of the world).
//
// One source of truth (24 Nov): the sign-in question carries what `readSignIn` read from the live page as one field
// (`SignInAsk`, built by `signInAsk` and checked by `parseSignInAsk`), and every surface (the app's card, the answer
// page, the managed MCP's text, the REST question, both SDKs) shows those ways and no others. The person's preferred way
// only picks the one the form opens on, among them; when nothing could be read the question asks how they sign in, with
// the page's own words, rather than showing a guessed form.

import { z } from "zod";

/** Every way a sign-in page can offer. The app, the answer page, the managed MCP, the API docs and both SDKs list these and no others. */
export const SIGN_IN_WAYS = ["password", "phone_code", "email_code", "identifier_first", "passkey"] as const;
export type SignInWay = (typeof SIGN_IN_WAYS)[number];
/** The ways the person can give on pilotfish's own form; a passkey and a provider (Google…) are done in the live browser. */
export const FORM_WAYS: readonly SignInWay[] = ["password", "phone_code", "email_code", "identifier_first"];

/** What the sign-in page on screen was read to offer (`readSignIn`). */
export interface SignInSeen {
  /** In the page's order, the way its own form shows first leading. Empty when none could be read. */
  ways: SignInWay[];
  /** Sign-in providers it offers by name ("Google", "Apple"), done in the live browser. */
  providers: string[];
  /** The page's own words for its sign-in (headings, field labels, buttons), for the question when no way could be read. */
  pageWords?: string;
}

/** The sign-in question's one field (`JobQuestion.signIn`): what every surface shows, and the only ways an answer may take. */
export interface SignInAsk extends SignInSeen {
  /** The way the form opens on: the person's (`signInPreference`) when the page offers it, else the page's first. One of `ways`. */
  opensOn?: SignInWay;
  /** The way the person asked for when the page does not offer it: said beside the form, never added to `ways`. */
  asked?: SignInWay;
}

/** The parts of a snapshot node read here (a `SnapNode` is one). */
export interface SignInNode {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
  name?: string;
  text?: string;
  visible?: boolean;
  folded?: boolean;
  parent?: SignInNode | null;
}

const PHONE_FIELD = /\b(phone|mobile|cell(phone)?|msisdn)\b|\bmob(ile)?[\s_-]?(no|num(ber)?)\b|\btel(ephone)?\b/i;
const EMAIL_FIELD = /\be-?mail\b/i;
const USER_FIELD = /\b(user ?name|user ?id|log ?in( id| name)?|account (number|name|id)|member (id|number)|customer (id|number))\b/i;
const CODE_FIELD = /\b(otp|one[- ]time|verification|passcode|security code|code)\b/i;
/** A button or link that switches the form to a phone number or a one-time code by text. */
const PHONE_SWITCH = /\b(use|with|via|continue with|sign in with|log ?in with|login with) (your |a )?(phone|mobile)( number| no\.?)?\b|\b(log ?in|sign in|login) (with|via|using) (an? )?otp\b|\b(get|send|request) (an? )?(otp|one[- ]time (code|password))\b/i;
/** A button or link for a code or link sent by email ("Email me a sign-in link", "Send magic link"). */
const EMAIL_CODE_SWITCH = /\b(e-?mail|send) me an? (sign[- ]?in |log ?in |login |magic |one[- ]time )?(link|code)\b|\b(send|get|use|with) (an? )?(magic|sign[- ]?in|log ?in|login|e-?mail) (link|code)\b/i;
/** "Continue with email": an email way whose next step the page does not show. */
const EMAIL_SWITCH = /^(continue|sign ?in|log ?in|login|sign ?up) with (your )?e-?mail( address)?$/i;
const PASSWORD_SWITCH = /\b(sign ?in|log ?in|login|continue) (with|using) (a |your )?password\b|\buse (a |your )?password( instead)?\b/i;
const PASSKEY_SWITCH = /\bpass ?keys?\b/i;
const PROVIDER_BUTTON = /^(?:continue|sign ?in|log ?in|login|sign ?up|connect|join) (?:with|using|via|through) (.{1,40})$/i;
const NOT_PROVIDER = /^(?:(?:a|an|your|my)\s+)?(?:phone|mobile|e-?mail|password|otp|pass ?key|sms|code|number|one[- ]time|magic|link|user ?name|sso|single sign)/i;
const KNOWN_PROVIDERS = ["Google", "Apple", "Microsoft", "Facebook", "GitHub", "LinkedIn", "X", "Twitter", "Amazon", "Yahoo", "Okta", "Truecaller", "Slack", "Discord", "PayPal"];
const SSO = /\b(single sign[- ]on|sso)\b/i;
/** The page says it sends a code or link to sign in with ("We'll text you an OTP", "magic link", "one-time code"). */
const SENDS_CODE = /\b(we['’]ll|we will|we) (e-?mail|text|sms|send)( you)?\b[^.!?\n]{0,30}\b(code|otp|link|one[- ]time password)\b|\bmagic link\b|\b(one[- ]time|verification|log ?in|login|sign[- ]?in) (code|link)\b|\bone[- ]time password\b|\botp\b/i;
/** Words about a forgotten password, which do not make a page a code sign-in ("we'll email you a reset link"). */
const RECOVERY = /\b(forgot|forgotten|reset|recover|trouble)\b/i;
const SKIP_INPUT = new Set(["hidden", "checkbox", "radio", "submit", "button", "image", "file", "reset", "range", "color", "search", "date", "datetime-local", "month", "week", "time"]);

type Field = "password" | "phone" | "email" | "either" | "user" | "code";

/** A visible input's part in a sign-in form, or null. */
function fieldOf(n: SignInNode): Field | null {
  if (n.tag.toLowerCase() !== "input") return null;
  const type = (n.attrs["type"] ?? "text").toLowerCase();
  if (SKIP_INPUT.has(type)) return null;
  if (type === "password") return "password";
  const ac = (n.attrs["autocomplete"] ?? "").toLowerCase();
  if (ac.includes("one-time-code")) return "code";
  const label = [n.name, n.attrs["name"], n.attrs["id"], n.attrs["placeholder"], n.attrs["aria-label"], ac].filter(Boolean).join(" ");
  const phone = type === "tel" || /\btel\b/.test(ac) || PHONE_FIELD.test(label);
  const email = type === "email" || /\bemail\b/.test(ac) || EMAIL_FIELD.test(label);
  if (phone && email) return "either";
  if (phone) return "phone";
  if (email) return "email";
  if (/\busername\b/.test(ac) || USER_FIELD.test(label)) return "user";
  // A code box: labelled as one, or one character of a split code.
  if (CODE_FIELD.test(label) || n.attrs["maxlength"] === "1") return "code";
  return null;
}

const isControl = (n: SignInNode) => {
  const tag = n.tag.toLowerCase();
  const type = (n.attrs["type"] ?? "").toLowerCase();
  return tag === "button" || tag === "a" || (tag === "input" && (type === "submit" || type === "button")) || ["button", "link", "tab", "menuitem"].includes(n.role ?? "");
};
const isDialog = (n: SignInNode) => n.tag.toLowerCase() === "dialog" || n.role === "dialog" || n.role === "alertdialog" || n.attrs["aria-modal"] === "true";
const inDialog = (n: SignInNode) => {
  for (let a: SignInNode | null | undefined = n; a; a = a.parent) if (isDialog(a)) return true;
  return false;
};
const controlName = (n: SignInNode) => (n.name || n.attrs["value"] || n.attrs["aria-label"] || n.attrs["title"] || "").replace(/\s+/g, " ").trim();

/**
 * The account providers a site's "Continue with …" button can sign in with, by the site whose own sign-in page takes
 * that account's login: the person may give that login on pilotfish's form (sealed like any login, typed only there),
 * and the run signs in on the provider's page the site's button opens. Others are done in the live browser.
 */
export const PROVIDER_SITES: Readonly<Record<string, { site: string; hosts: readonly string[] }>> = {
  Google: { site: "google.com", hosts: ["google.com", "*.google.com"] },
  Microsoft: { site: "live.com", hosts: ["live.com", "*.live.com", "microsoftonline.com", "*.microsoftonline.com", "microsoft.com", "*.microsoft.com"] },
  Apple: { site: "apple.com", hosts: ["apple.com", "*.apple.com"] },
  Facebook: { site: "facebook.com", hosts: ["facebook.com", "*.facebook.com"] },
  GitHub: { site: "github.com", hosts: ["github.com", "*.github.com"] },
  LinkedIn: { site: "linkedin.com", hosts: ["linkedin.com", "*.linkedin.com"] },
  Amazon: { site: "amazon.com", hosts: ["amazon.com", "*.amazon.com"] },
  Yahoo: { site: "yahoo.com", hosts: ["yahoo.com", "*.yahoo.com"] },
};

/** A provider pilotfish can sign in with from a login the person gives (`PROVIDER_SITES`), by its name as read; else null. */
export function providerSite(name: string): { provider: string; site: string; hosts: readonly string[] } | null {
  const key = Object.keys(PROVIDER_SITES).find((p) => p.toLowerCase() === name.trim().toLowerCase());
  return key ? { provider: key, ...PROVIDER_SITES[key]! } : null;
}

/** The providers of a sign-in that pilotfish can sign in with from a login the person gives, in the page's order. */
export const signInLoginProviders = (a: Pick<SignInSeen, "providers">): string[] => a.providers.filter((p) => providerSite(p));

/**
 * A page's words that the way it was signing in by is used up: too many codes or tries, or "try other login
 * methods" (24 Nov: a food-delivery site's code dialog said "OTP attempts exhausted. Please try other login methods.").
 */
export const SIGN_IN_WAY_USED_UP =
  /\b(?:(?:otp|code|verification|login|sign[- ]?in)\s+)?(?:attempts?|tries|limit)\s+(?:(?:have|has)\s+been\s+)?(?:exhausted|exceeded|used up|reached)\b|\btoo many (?:attempts|tries|requests|otps?|codes)\b|\btry (?:another|other|a different) (?:login|sign[- ]?in|log[- ]?in|way|method)/i;

/** The provider a button names ("Continue with Google", a button named only "Apple"), or null. */
function providerOf(name: string): string | null {
  const known = KNOWN_PROVIDERS.find((p) => p.toLowerCase() === name.toLowerCase());
  if (known) return known;
  const m = PROVIDER_BUTTON.exec(name);
  if (m) {
    // A link's own note after the name is no part of it ("Sign in with Google. Opens in new tab", live on a food-delivery site, 24 Nov).
    const who = m[1]!.replace(/[.,;:(]\s*(?:opens?|opening|external|new (?:tab|window)).*$/i, "").replace(/\s+(account|id)$/i, "").trim();
    if (who && !NOT_PROVIDER.test(who)) return KNOWN_PROVIDERS.find((p) => p.toLowerCase() === who.toLowerCase()) ?? who;
  }
  return SSO.test(name) ? "SSO" : null;
}

/**
 * A link to an account provider's own page that is no sign-in (a "Facebook" or "LinkedIn" icon in a footer, to the
 * site's profile there): named like a provider, it offers no way to sign in to this site (24 Nov: a code dialog's page
 * offered Facebook and LinkedIn on the sign-in card from its footer's follow-us links).
 */
function profileLink(n: SignInNode, provider: string): boolean {
  if (!(n.tag === "a" || n.role === "link")) return false;
  let u: URL;
  try {
    u = new URL(n.attrs["href"] ?? "");
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const p = providerSite(provider);
  const host = u.hostname.toLowerCase();
  const theirs = p ? host === p.site || host.endsWith(`.${p.site}`) : host.includes(provider.toLowerCase());
  return theirs && !/(^|\/)(oauth2?|o\/oauth2|dialog\/oauth|auth(orize)?|log-?in|sign-?in|sso|uas\/oauth2)(\/|$)/i.test(u.pathname);
}

/** Words asking for a sign-in code, or saying one was sent: in a heading or a dialog, a code step is open. */
export const CODE_STEP_WORDS =
  /\botp\b|\bone[- ]time (?:password|code|passcode|pin)\b|\b(?:verification|security|sign[- ]?in|log ?in|login|confirmation) code\b|\benter (?:the |your )?(?:\d[- ]digit )?(?:code|passcode|pin)\b|\b(?:code|passcode)\b[^.!?\n]{0,40}\b(?:sent|texted|emailed)\b|\b(?:sent|texted|emailed)\b[^.!?\n]{0,40}\b(?:code|passcode)\b|\bverify (?:your )?(?:phone|mobile|number|e-?mail|account|identity)\b/i;

/** A shown heading, or a short line of text in a dialog, that asks for a sign-in code (`CODE_STEP_WORDS`). */
export function asksForCode(n: SignInNode): boolean {
  if (n.visible === false || n.folded) return false;
  const heading = n.role === "heading" || /^h[1-4]$/i.test(n.tag);
  const words = heading ? (n.name ?? "") : n.text && n.text.length <= 200 && inDialog(n) ? n.text : "";
  return !!words && CODE_STEP_WORDS.test(words);
}

/**
 * The ways the sign-in on screen offers, read from its visible fields, buttons, links and words, in every frame the
 * snapshot holds (a sign-in form in a cross-origin iframe, accounts.<site>, is read like the page's own). A dialog with
 * a sign-in field in it is the sign-in; the page behind it is left out. A password field makes the form a password
 * sign-in (a phone or email field beside it is its username); with no password field, a phone field is a phone and a
 * code by text, an email field an email and a code or link when the page says it sends one, else an email or username
 * first with the rest on the next page; a field for "email or phone" takes both codes when the page says it sends one.
 * Buttons and tabs add the ways they switch to ("Login with OTP", "Email me a link", "Use password", a passkey) and
 * providers ("Continue with Google"). `codeStep`: the page asks for a code and shows no sign-in field (the code was
 * sent): its question is the code's. `ways` is empty when none could be read; `pageWords` are the page's own words.
 */
export function readSignIn(all: Iterable<SignInNode>): SignInSeen & { codeStep: boolean } {
  const shown = [...all].filter((n) => n.visible !== false && !n.folded);
  const signInField = (n: SignInNode) => {
    const f = fieldOf(n);
    return !!f && f !== "code";
  };
  const nodes = shown.some((n) => signInField(n) && inDialog(n)) ? shown.filter(inDialog) : shown;
  const at = new Map<SignInWay, number>();
  const add = (w: SignInWay, i: number) => void (at.has(w) || at.set(w, i));
  const providers: string[] = [];
  const fields: Array<{ f: Field; i: number }> = [];
  const texts: string[] = [];
  const words: string[] = [];
  const word = (t: string | undefined) => {
    const s = (t ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (s && !words.includes(s)) words.push(s);
  };
  nodes.forEach((n, i) => {
    if (n.text) texts.push(n.text);
    const f = fieldOf(n);
    if (f) {
      fields.push({ f, i });
      if (f !== "code") word(n.name || n.attrs["placeholder"] || n.attrs["aria-label"]);
      return;
    }
    if (n.role === "heading" || /^h[1-4]$/i.test(n.tag)) word(n.name);
    if (!isControl(n)) return;
    const name = controlName(n);
    if (!name) return;
    if (PHONE_SWITCH.test(name)) add("phone_code", i);
    if (EMAIL_CODE_SWITCH.test(name)) add("email_code", i);
    if (PASSWORD_SWITCH.test(name)) add("password", i);
    if (PASSKEY_SWITCH.test(name)) add("passkey", i);
    const found = providerOf(name);
    const p = found && !profileLink(n, found) ? found : null;
    if (p && !providers.includes(p)) providers.push(p);
    if (p || PHONE_SWITCH.test(name) || EMAIL_CODE_SWITCH.test(name) || EMAIL_SWITCH.test(name) || PASSWORD_SWITCH.test(name) || /\b(sign ?in|log ?in|login|continue|next|otp|code)\b/i.test(name)) word(name);
  });
  // Said of signing in, not of a forgotten password.
  const said = texts.join("\n").split(/(?<=[.!?\n])/).filter((s) => !RECOVERY.test(s)).join(" ");
  // A button that sends a code or link ("Email me a sign-in link", "Get OTP") says so too.
  const sends = SENDS_CODE.test(said) || at.has("email_code") || nodes.some((n) => isControl(n) && /\b(get|send|request) (an? )?(otp|code|one[- ]time)/i.test(controlName(n)));
  const ids = fields.filter((x) => x.f !== "password" && x.f !== "code");
  const pw = fields.find((x) => x.f === "password");
  let first: SignInWay | undefined;
  if (pw) {
    first = "password";
    at.set("password", Math.min(at.get("password") ?? Infinity, ids[0]?.i ?? pw.i, pw.i));
  } else if (ids.length) {
    const { f, i } = ids[0]!;
    if (f === "phone") first = "phone_code";
    else if (f === "email") first = sends ? "email_code" : "identifier_first";
    else if (f === "either" && sends) {
      first = "phone_code";
      add("email_code", i);
    } else first = "identifier_first";
    add(first, i);
  }
  // "Continue with email": an email way, with a code when the page says it sends one.
  nodes.forEach((n, i) => {
    if (isControl(n) && EMAIL_SWITCH.test(controlName(n))) add(sends ? "email_code" : "identifier_first", i);
  });
  const rest = [...at.entries()].filter(([w]) => w !== first).sort((a, b) => a[1] - b[1]).map(([w]) => w);
  const ways = [...(first ? [first] : []), ...rest];
  // A code field, or (no field shows at all: one drawn over, in a widget of its own) a heading or dialog line asking
  // for the code the site sent (24 Nov: a code dialog whose field was drawn over got a sign-in card, not a code box).
  const codeStep = !pw && !ids.length && (fields.some((x) => x.f === "code") || (!fields.length && nodes.some(asksForCode)));
  const pageWords = words.join(" · ").slice(0, 200);
  return { ways, providers: providers.slice(0, 8), ...(pageWords ? { pageWords } : {}), codeStep };
}

/** How the person asked to sign in: a phone number and a texted code, an email and a code, or a password. */
export type SignInPreference = "phone" | "email_code" | "password";

const SAYS_PHONE = /\b(phone|mobile|cell)( ?(number|no\.?|num))?\b|\b(sms|otp)\b|\btext(ed)?( me)?( (a|the))? code\b|\bcode (by|via|over) (text|sms)\b|\bone[- ]time (code|password|pin)\b/i;
const SAYS_EMAIL_CODE = /\b(e-?mail|inbox)\b[^.?!\n]{0,40}\b(code|otp|link|magic link)\b|\b(code|otp|link|magic link)\b[^.?!\n]{0,40}\b(e-?mail|inbox)\b/i;
const SAYS_PASSWORD = /\bpassword\b|\b(e-?mail|username|user ?name|user id) and (my )?(pass(word)?|pwd)\b/i;
/** "without a password", "no password", "not with OTP": a way named only to rule it out. */
const NOT_PASSWORD = /\b(no|without( a| my)?|not (with|using)( a| my)?|don'?t have( a| my)?) password\b/i;
const NOT_PHONE = /\b(no|without( a| my)?|not (with|using|by)( a| my)?|don'?t have( a| my)?) (phone|mobile|otp|sms)\b/i;

/**
 * The way to sign in the person asked for in `texts` (the task, then the messages they sent while it ran,
 * oldest first): the latest that names one wins. "with my phone number and OTP" is "phone"; "send the code to my
 * email" is "email_code"; "use my email and password" is "password". Null when none says.
 */
export function signInPreference(texts: Iterable<string>): SignInPreference | null {
  let out: SignInPreference | null = null;
  for (const raw of texts) {
    const t = raw ?? "";
    if (!t.trim()) continue;
    const password = SAYS_PASSWORD.test(t) && !NOT_PASSWORD.test(t);
    const emailCode = SAYS_EMAIL_CODE.test(t);
    const phone = SAYS_PHONE.test(t.replace(SAYS_EMAIL_CODE, " ")) && !NOT_PHONE.test(t);
    // One message naming two ways ("my phone, not my password") is read by what it rules out first.
    if (phone && !emailCode) out = "phone";
    else if (emailCode && !phone) out = "email_code";
    else if (password && !phone && !emailCode) out = "password";
    else if (NOT_PASSWORD.test(t) && !phone && !emailCode) out = null;
  }
  return out;
}

/** A phone number as typed by a person: digits with spaces, dashes, dots, brackets and a leading +, 7 to 15 digits. */
export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  if (!/^\+?[\d\s().-]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
}

const NUMBER_ASKED = /\b(phone|mobile|cell)\s?(number|no\b\.?|#)|\bnumber\b[^?.!]{0,20}\b(phone|mobile)\b/i;
/** The question asks for a code, not a number: "the code sent to your mobile number", "enter the OTP". */
const CODE_ASKED = /\b(code|otp|pin|passcode)\b[^?.!]{0,30}\b(sent|texted|received|you got|you get|from)\b|\b(enter|what|type|share|give|tell)\b[^?.!]{0,15}\b(code|otp|pin|passcode)\b/i;
const SIGN_IN_WORDS = /\b(sign[- ]?in|log ?in|login|otp|verification|verify|one[- ]time)\b/i;

/**
 * A free-form question that asks the person for the phone number to sign in with ("What phone number should GrocerySite use
 * to send the sign-in OTP?"): it is the sign-in hand-off's to ask, whose form takes the number as a placeholder (it
 * never reaches the model) and opens on the phone way. Live, 6 Nov: asked as a question, it was shown as a code box,
 * since it names the OTP. A question for the code itself, or for a phone number with no sign-in in view (a delivery
 * contact on a checkout form), is not one. `onAuthPage`: the page's address is a sign-in page's.
 */
export function asksSignInNumber(question: string, onAuthPage = false): boolean {
  if (!NUMBER_ASKED.test(question) || CODE_ASKED.test(question)) return false;
  return onAuthPage || SIGN_IN_WORDS.test(question);
}

/**
 * A phone number as a phone field takes it. A person gives it as they write it ("+91 98765 43210", "(415) 555-0134");
 * many sign-in forms show the country code beside the field and take the national number only, as digits, up to
 * their maxlength (a 10-digit field cuts "+91 98765 43210" to "+91 98765 " and the site refuses it). `dialCode`: a
 * country code the page shows by the field ("+91"); `numeric`: the field takes digits only (type=number, or
 * inputmode=numeric); `maxLength`: its maxlength; `national`: the field says it takes the national number
 * (autocomplete=tel-national). With none of these the number goes in as given.
 *
 * A number given with its "+" and country code, for a field that takes digits only or the national number and shows
 * no country code: the country code is left out (24 Nov: a shopping site's tel-national, inputmode=numeric field with
 * no code beside it got "91" and the 10 digits; the site sent the code to another number).
 */
export function fitPhone(value: string, f: { maxLength?: number; numeric?: boolean; dialCode?: string; national?: boolean }): string {
  const t = value.trim();
  const plus = t.startsWith("+");
  let digits = t.replace(/\D/g, "");
  const dial = f.dialCode?.replace(/\D/g, "") ?? "";
  // The country code the page already shows is not typed again (given with its "+", or as a longer number led by it).
  if (dial && digits.startsWith(dial) && (plus || digits.length - dial.length >= 7)) digits = digits.slice(dial.length);
  else if (!dial && plus && (f.numeric || f.national)) {
    const cc = callingCode(digits);
    if (cc && digits.length - cc.length >= 6) digits = digits.slice(cc.length);
  }
  const max = f.maxLength && f.maxLength > 0 ? f.maxLength : undefined;
  if (!dial && !f.numeric && !f.national && !(max && t.length > max)) return t;
  // Too long for the field: the national number is its last digits (a country code or a trunk 0 in front).
  if (max && digits.length > max) digits = digits.slice(digits.length - max);
  return digits;
}

/**
 * The ITU country calling codes. They are a prefix code (no code begins another), so the one leading an international
 * number is found by its first one, two or three digits.
 */
const CALLING_CODES = new Set(
  (
    "1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 " +
    "211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 " +
    "250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 " +
    "370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 " +
    "590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 " +
    "800 808 850 852 853 855 856 870 878 880 881 882 883 886 888 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 979 992 993 994 995 996 998"
  ).split(" "),
);

/** The country calling code an international number's digits begin with ("91 98765 43210", spaces left out, → "91"), or "". */
export function callingCode(digits: string): string {
  for (const n of [1, 2, 3]) if (CALLING_CODES.has(digits.slice(0, n))) return digits.slice(0, n);
  return "";
}

/** The country code a page shows by a phone field ("+91", "IN +91", "(+1)"), from the texts around it, or undefined. */
export function dialCodeIn(texts: Iterable<string>): string | undefined {
  for (const t of texts) {
    const m = /(?:^|[\s(])\+\s?(\d{1,4})(?=$|[\s)▾▼⌄v-])/.exec(t ?? "");
    if (m) return `+${m[1]}`;
  }
  return undefined;
}

/** A sign-in page's address path ("/auth", "/login", "/sign-in", "/account/login/..."); a word in a slug does not count. */
export function isAuthPath(path: string): boolean {
  return /(^|\/)(auth|log-?in|sign-?in)(\/|$)/i.test(path);
}

const WAY = z.enum(SIGN_IN_WAYS);
/** `SignInAsk` as it may be stored, sent and read back: known ways only, each once, the way it opens on among them. */
export const SignInAskSchema = z
  .object({
    ways: z.array(WAY).max(SIGN_IN_WAYS.length),
    providers: z.array(z.string().trim().min(1).max(40)).max(8),
    opensOn: WAY.optional(),
    asked: WAY.optional(),
    pageWords: z.string().max(300).optional(),
  })
  .strict()
  .refine((a) => new Set(a.ways).size === a.ways.length && new Set(a.providers).size === a.providers.length, { message: "each way and provider once" })
  .refine((a) => !a.opensOn || (a.ways.includes(a.opensOn) && FORM_WAYS.includes(a.opensOn)), { message: "opensOn must be one of the form ways offered" })
  .refine((a) => !a.asked || !a.ways.includes(a.asked), { message: "asked is a way the page does not offer" });

/** A stored or received sign-in field, checked: null when it is not one. */
export function parseSignInAsk(x: unknown): SignInAsk | null {
  const r = SignInAskSchema.safeParse(x);
  if (!r.success) return null;
  const a = r.data;
  return { ways: a.ways, providers: a.providers, ...(a.opensOn ? { opensOn: a.opensOn } : {}), ...(a.asked ? { asked: a.asked } : {}), ...(a.pageWords ? { pageWords: a.pageWords } : {}) };
}

/** The ways a preference may open on, best first: a page that takes the email, phone or username first takes any. */
const PREFERRED: Record<SignInPreference, SignInWay[]> = {
  phone: ["phone_code", "identifier_first"],
  email_code: ["email_code", "identifier_first"],
  password: ["password", "identifier_first"],
};
const PREFERENCE_WAY: Record<SignInPreference, SignInWay> = { phone: "phone_code", email_code: "email_code", password: "password" };

/**
 * The sign-in question's field: what the page was read to offer (cleaned: known ways once, providers once, words
 * clipped), opening on the person's way when the page offers it, else on the page's own first form. The person's way
 * never adds one: one the page does not offer is `asked`, said beside the form.
 */
export function signInAsk(seen: Partial<SignInSeen> | null | undefined, prefers?: SignInPreference | null): SignInAsk {
  const ways = [...new Set((seen?.ways ?? []).filter((w): w is SignInWay => (SIGN_IN_WAYS as readonly string[]).includes(w)))];
  const providers = [...new Set((seen?.providers ?? []).map((p) => String(p).replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean))].slice(0, 8);
  const pageWords = (seen?.pageWords ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const want = prefers ? PREFERRED[prefers].find((w) => ways.includes(w)) : undefined;
  const opensOn = want ?? ways.find((w) => FORM_WAYS.includes(w));
  const asked = prefers && !want && !ways.includes(PREFERENCE_WAY[prefers]) ? PREFERENCE_WAY[prefers] : undefined;
  return { ways, providers, ...(opensOn ? { opensOn } : {}), ...(asked ? { asked } : {}), ...(pageWords ? { pageWords } : {}) };
}

/** Nothing of the sign-in could be read: the question asks how the person signs in, with the page's words. */
export const signInUnclear = (a: SignInSeen): boolean => !a.ways.length && !a.providers.length;

/** The page takes something typed on pilotfish's own form (a password, a phone or email for a code, an email or username first). */
export const signInHasForm = (a: SignInSeen): boolean => a.ways.some((w) => FORM_WAYS.includes(w));

/**
 * Why an answer does not fit what the page offers, or null: a password needs a password way (or an email or username
 * first), a phone for a code the phone way (or …first), an email for a code the email way (or …first). The same rule
 * every surface draws its forms by, checked again where answers arrive.
 */
export function signInAnswerProblem(a: SignInSeen, answer: { type: string; channel?: string; provider?: string }): string | null {
  const has = (...w: SignInWay[]) => w.some((x) => a.ways.includes(x));
  const offers = signInWaysText(a) || "no way pilotfish could read";
  // A provider's login: the page must offer that provider, and pilotfish must know its sign-in page.
  if (answer.type === "credentials" && answer.provider) {
    const p = providerSite(answer.provider);
    if (!p) return `pilotfish cannot sign in with ${answer.provider} from a login given here; sign in with it in the live browser.`;
    if (!a.providers.some((x) => x.toLowerCase() === p.provider.toLowerCase())) return `This page does not offer ${p.provider} sign-in; it offers ${offers}.`;
    return null;
  }
  if (answer.type === "credentials" && !has("password", "identifier_first")) return `This page does not sign in with a password; it offers ${offers}.`;
  if (answer.type === "code_login" && answer.channel === "sms" && !has("phone_code", "identifier_first")) return `This page does not sign in with a phone number and a texted code; it offers ${offers}.`;
  if (answer.type === "code_login" && answer.channel === "email" && !has("email_code", "identifier_first")) return `This page does not sign in with an emailed code or link; it offers ${offers}.`;
  return null;
}

/** Each way in words: the managed MCP's text, the answer page and the API docs say these; the app's card its own short labels. */
export const SIGN_IN_WAY_WORDS: Record<SignInWay, string> = {
  password: "a password (with an email, phone or username)",
  phone_code: "a phone number and a code sent by text",
  email_code: "an email address and a code or link sent there",
  identifier_first: "an email, phone or username first, then what the site asks next",
  passkey: "a passkey, in the browser",
};

/** The ways a page offers, in words, in its order: "a password (…); or Google, in the browser". "" when none. */
export function signInWaysText(a: SignInSeen): string {
  const parts = [...a.ways.map((w) => SIGN_IN_WAY_WORDS[w]), ...a.providers.map((p) => (providerSite(p) ? `${p} (your ${p} account's email and password, or in the browser)` : `${p}, in the browser`))];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join("; ")}; or ${parts[parts.length - 1]}`;
}

/** The question when nothing of a sign-in could be read: how does the person sign in here, with the page's own words. */
export function signInHowQuestion(site: string, a: SignInSeen): string {
  return `How do you sign in to ${site}? pilotfish could not tell from the page${a.pageWords ? ` (it shows: "${a.pageWords}")` : ""}. Say how, for example "email and password", "a code to my phone" or "Google", or sign in yourself in the browser. Never a password or code here.`;
}

/**
 * The person's words for how they sign in, as the run may see them: never a password or code, so anything after
 * "password", "PIN", "OTP" or "code", a run of four or more digits and a word mixing letters and digits are hidden; clipped.
 */
export function signInHowWords(text: string): string {
  return text
    .replace(/\b(password|passcode|pwd|pin|otp|code)\b(\s*(is|=|:))?\s+(?!(and|or|to|by|via|from|on|in|with|sent|texted)\b)\S+/gi, "$1 [hidden]")
    .replace(/\S*\d{4,}\S*/g, "[hidden]")
    .replace(/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{6,}\b/gi, "[hidden]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

