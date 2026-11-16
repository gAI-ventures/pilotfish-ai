// How a person signs in to a site: what the sign-in page on screen offers (a password, a phone number that a
// code is texted to, an email), and which way the person asked for in their own words. Many sites sign in by
// phone and a texted code with no password at all (food delivery, ride hailing, banks and wallets in much of
// the world); the sign-in hand-off offers that way beside email and password, and picks the one the person
// asked for, else the one the page shows.

import type { SignInMethod } from "./interventions.js";

/** The parts of a snapshot node read here. */
export interface SignInNode {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
  name?: string;
  text?: string;
  visible?: boolean;
}

const PHONE_FIELD = /\b(phone|mobile|cell(phone)?|msisdn)\b|\bmob(ile)?[\s_-]?(no|num(ber)?)\b|\btel(ephone)?\b/i;
const EMAIL_FIELD = /\be-?mail\b/i;
/** A button or link that switches the form to a phone number or a one-time code. */
const PHONE_SWITCH = /\b(use|with|via|continue with|sign in with|log ?in with|login with) (your |a )?(phone|mobile)( number| no\.?)?\b|\b(log ?in|sign in|login) (with|via|using) (an? )?otp\b|\b(get|send|request) (an? )?(otp|one[- ]time (code|password))\b/i;

/**
 * The ways the sign-in page offers, from its visible fields and buttons: "password" (a password field), "phone"
 * (a field for a phone or mobile number, or a button that switches to one or sends an OTP), "email" (an email
 * field, or a field labelled for an email). A field labelled "Email or phone" counts for both. In the order
 * password, phone, email; empty when none shows.
 */
export function signInOffers(nodes: Iterable<SignInNode>): SignInMethod[] {
  let password = false;
  let phone = false;
  let email = false;
  for (const n of nodes) {
    if (n.visible === false) continue;
    const tag = n.tag.toLowerCase();
    if (tag === "input") {
      const type = (n.attrs["type"] ?? "text").toLowerCase();
      if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
      if (type === "password") {
        password = true;
        continue;
      }
      const label = [n.name, n.attrs["name"], n.attrs["id"], n.attrs["placeholder"], n.attrs["aria-label"], n.attrs["autocomplete"]].filter(Boolean).join(" ");
      if (type === "tel" || /\btel\b/i.test(n.attrs["autocomplete"] ?? "") || PHONE_FIELD.test(label)) phone = true;
      if (type === "email" || /\bemail\b/i.test(n.attrs["autocomplete"] ?? "") || EMAIL_FIELD.test(label)) email = true;
      continue;
    }
    if (tag === "button" || tag === "a" || n.role === "button" || n.role === "link" || n.role === "tab") {
      if (PHONE_SWITCH.test(n.name ?? "")) phone = true;
    }
  }
  return [...(password ? (["password"] as const) : []), ...(phone ? (["phone"] as const) : []), ...(email ? (["email"] as const) : [])];
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
 * A free-form question that asks the person for the phone number to sign in with ("What phone number should Swiggy use
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
 * inputmode=numeric); `maxLength`: its maxlength. With none of these the number goes in as given.
 */
export function fitPhone(value: string, f: { maxLength?: number; numeric?: boolean; dialCode?: string }): string {
  const t = value.trim();
  const plus = t.startsWith("+");
  let digits = t.replace(/\D/g, "");
  const dial = f.dialCode?.replace(/\D/g, "") ?? "";
  // The country code the page already shows is not typed again (given with its "+", or as a longer number led by it).
  if (dial && digits.startsWith(dial) && (plus || digits.length - dial.length >= 7)) digits = digits.slice(dial.length);
  const max = f.maxLength && f.maxLength > 0 ? f.maxLength : undefined;
  if (!dial && !f.numeric && !(max && t.length > max)) return t;
  // Too long for the field: the national number is its last digits (a country code or a trunk 0 in front).
  if (max && digits.length > max) digits = digits.slice(digits.length - max);
  return digits;
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

