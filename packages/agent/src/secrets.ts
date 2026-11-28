// Credential broker. The model only ever sees symbolic names like
// {{login_password}}; values are substituted at Input.insertText time and
// scrubbed from everything that flows back toward the model or storage
// (snapshots, page text, evidence, errors). Values can be scoped to URL
// patterns so a secret for bank.example is never typed into evil.example.
//
// Two kinds besides fixed values: a TOTP seed generates the current 2FA code at substitution
// time (RFC 6238), and a short-lived secret holds a code the user typed for this one login
// (the agent fills it, the model sees only its placeholder).

import { createHmac } from "node:crypto";

export interface SecretSpec {
  /** The value. Optional when `totp` is set. */
  value?: string;
  /** Base32 TOTP seed (as in an authenticator app's setup key): `{{name}}` types the current 6-digit code. */
  totp?: string;
  /** Hostname globs where this secret may be used, e.g. ["*.example.com", "example.com"]. Empty = anywhere (not recommended). */
  allowedHosts?: string[];
  /** Forget the secret after this time (ms epoch). */
  expiresAt?: number;
}

export class SecretBroker {
  private readonly secrets = new Map<string, SecretSpec>();
  private readonly audit: Array<{ name: string; host: string; at: number; allowed: boolean }> = [];
  /** Codes generated from TOTP seeds recently: they are scrubbed like any value. */
  private readonly issued = new Map<string, number>();
  /** Values of expired short-lived secrets: no longer typed, still masked (a code may stay in a field). */
  private readonly retired = new Map<string, string>();
  /**
   * Values typed into password fields this session (addTyped), each with the names of the secrets it was typed from
   * by placeholder (none: typed as given): every form of them becomes TYPED_SECRET_MARK.
   */
  private readonly typed = new Map<string, string[]>();
  /**
   * The output guard (18 Nov; the open MCP sets it through AgentOptions.guardSecretOutput). scrub() first checks its
   * input as given, unmasked, for any form of any value held (configured secrets of any length, codes issued from
   * authenticator seeds, retired values, typed values), each value matched against that original text on its own,
   * never after another's replacement. Text with none is returned exactly as given: nothing in it is rewritten. Text
   * with one is reported (onOutputHit) and returned with TYPED_SECRET_MARK where the values were, never a readable
   * placeholder, so the caller withholds the whole output rather than give rewritten grammar. Off (the hosted agent
   * loop, whose model reads `{{name}}` placeholders): scrub() is as before.
   */
  guardOutput = false;
  /** Called once per scrub() whose input held a guarded value (output guard on). */
  onOutputHit: (() => void) | null = null;
  /** Each value's output forms (outputForms), built once. */
  private readonly formsCache = new Map<string, string[]>();
  /** Every host glob a secret was ever usable on ("*": one scoped to none), expired ones included: a page there may show a value. */
  private readonly shownOn = new Set<string>();
  /**
   * How recently each name was set or typed (a rising counter): when several secrets hold the same value (a phone saved
   * as one site's username and given again to sign in to another), the page shows it as the newest one's placeholder.
   * 24 Nov: a shopping site's sign-in typed its {{<site>.entered_phone}} and the page read back
   * another site's {{<site>.username}} (an older saved login with the same number); the model took the field for an unfilled
   * placeholder, asked the person to sign in again, and the end check failed the run on it.
   */
  private readonly recent = new Map<string, number>();
  private tick = 0;
  /** A secret's value as a field took it (a phone fitted to the field: country code left out, digits only) → its name. */
  private readonly typedForms = new Map<string, string>();

  constructor(secrets: Record<string, string | SecretSpec> = {}) {
    for (const [name, spec] of Object.entries(secrets)) this.put(name, typeof spec === "string" ? { value: spec } : spec);
  }

  private put(name: string, spec: SecretSpec): void {
    this.secrets.set(name, spec);
    this.recent.set(name, ++this.tick);
    for (const g of spec.allowedHosts?.length ? spec.allowedHosts : ["*"]) this.shownOn.add(g);
  }

  /**
   * Whether a picture of a page on `host` could show a secret's value: one is, or was, usable there (a sign-in
   * form, a filled field, an account page that shows the user name), or one is scoped to no host. Pixels cannot be
   * scrubbed, so the agent sends no screenshot of such a page; every other page keeps them.
   */
  mayShowOn(host: string): boolean {
    for (const g of this.shownOn) if (g === "*" || globHost(g, host)) return true;
    return false;
  }

  get size(): number {
    this.expire();
    return this.secrets.size + this.retired.size + this.typed.size;
  }

  /** How many passwords were typed into password fields this session (addTyped). */
  get typedCount(): number {
    return this.typed.size;
  }

  /**
   * Text typed into a field that was a password field before the action (17 Nov): from then on, wherever any form of
   * it would appear in output (raw, URL-encoded, JSON-escaped, base64; a value under 3 characters as a substring
   * anywhere), the scrubber puts TYPED_SECRET_MARK there instead of readable text. Readable rewriting is what
   * corrupted refs, numbers and wording; the mark lets the caller withhold that output whole (fail closed: the open
   * MCP answers UNSAFE_OUTPUT) instead of handing out text that is altered or that leaks.
   * Limitation, deliberate: after a one- or two-character password most later output carries the mark, so most later
   * replies are withheld and the task may not be completable in that session.
   */
  addTyped(value: string, from: string[] = []): void {
    if (!value) return;
    // `from`: the secrets it was substituted from (their identity kept; scope and refusal were settled by substitute()
    // and the caller's guard before typing). Registering it here keeps the actual value guarded for the rest of the
    // session, whatever later happens to those secrets (expiry, replacement, a value under 3 characters).
    this.typed.set(value, [...new Set([...(this.typed.get(value) ?? []), ...from])]);
  }

  /**
   * The form a field took a secret in, when the agent typed it fitted to the field (a phone number with the country code
   * the page shows left out, digits only): from then on that form is masked as `{{name}}` too, as the newest use of it.
   */
  addTypedForm(name: string, form: string): void {
    if (!form || form.length < 3 || !this.secrets.has(name)) return;
    this.typedForms.set(form, name);
    this.recent.set(name, ++this.tick);
  }

  /** The names of the secrets a typed value came from by placeholder (empty: typed as given; undefined: not typed). */
  typedFrom(value: string): readonly string[] | undefined {
    return this.typed.get(value);
  }

  /** Every value output must not carry (output guard): configured, issued, retired and typed, longest first. */
  private guarded(): string[] {
    this.expire();
    const out = new Set<string>();
    for (const spec of this.secrets.values()) if (spec.value) out.add(spec.value);
    for (const code of this.issued.keys()) out.add(code);
    for (const v of this.retired.keys()) out.add(v);
    for (const v of this.typed.keys()) out.add(v);
    for (const v of this.typedForms.keys()) out.add(v);
    return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  private formsOf(value: string): string[] {
    let f = this.formsCache.get(value);
    if (!f) this.formsCache.set(value, (f = outputForms(value)));
    return f;
  }

  /**
   * Whether `text`, as given, holds a form of a guarded value (output guard): any of outputForms() as a substring (so a
   * value under 3 characters anywhere), or a long value's clipped prefix. Each value is matched against `text` itself.
   */
  holdsSecret(text: string): boolean {
    for (const v of this.guarded()) {
      for (const f of this.formsOf(v)) if (text.includes(f)) return true;
      if (v.length >= 3 && maskValue(text, v, "\uE000") !== text) return true;
    }
    return false;
  }

  /**
   * Whether `text`, what a page draws (its text and field values), shows a secret's value as a person would read it
   * (`pictureRisk`): any value set, given, typed, retired or issued, as written (case and runs of spaces aside), and a
   * value mostly of digits (a phone number, a code) with the page's own spacing or dashes between them, or by its last
   * ten digits (a phone without its country code). A value under 4 characters cannot be told from other text: true.
   */
  shownIn(text: string): boolean {
    const page = text.replace(/\s+/g, " ").toLowerCase();
    for (const v of this.guarded()) {
      const flat = v.replace(/\s+/g, " ").trim();
      if (flat.length < 4) return true;
      if (page.includes(flat.toLowerCase())) return true;
      const digits = flat.replace(/\D/g, "");
      if (digits.length >= 6 && digits.length >= flat.replace(/ /g, "").length * 0.6) {
        for (const d of new Set([digits, digits.slice(-10)])) if (d.length >= 6 && digitsShown(text, d)) return true;
      }
    }
    return false;
  }

  /** Guarded text with every form of every value replaced by the mark, only ever between marks; nothing but the mark if any is left. */
  private maskGuarded(text: string): string {
    const between = (s: string, f: (seg: string) => string) => s.split(TYPED_SECRET_MARK).map(f).join(TYPED_SECRET_MARK);
    let out = text;
    for (const v of this.guarded()) {
      for (const form of [...this.formsOf(v)].sort((a, b) => b.length - a.length)) out = between(out, (seg) => seg.split(form).join(TYPED_SECRET_MARK));
      if (v.length >= 3) out = between(out, (seg) => maskValue(seg, v, TYPED_SECRET_MARK));
    }
    if (!out.includes(TYPED_SECRET_MARK) || out.split(TYPED_SECRET_MARK).some((seg) => this.holdsSecret(seg))) return TYPED_SECRET_MARK;
    return out;
  }

  names(): string[] {
    this.expire();
    return [...this.secrets.keys()];
  }

  /** A secret for one use window, e.g. the code the user typed for a 2FA prompt. */
  addEphemeral(name: string, value: string, allowedHosts: string[], ttlMs = 5 * 60_000): void {
    // Keep masking any previous value under this name (an earlier 2FA code may still be on the page
    // or in a URL); overwriting without retiring it would unmask that code.
    const prev = this.secrets.get(name);
    if (prev?.value && prev.value !== value) this.retired.set(prev.value, name);
    this.put(name, { value, allowedHosts, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Sign-in details the person typed on pilotfish's own page for `site`: two placeholders the model can
   * type, usable only on the site and its subdomains, masked like any secret. Replacing earlier ones
   * keeps the old values masked.
   */
  addLogin(site: string, username: string, password: string, as: "entered" | "signup" = "entered", hosts?: readonly string[]): { username: string; password: string } {
    const base = site.replace(/[^a-zA-Z0-9_.-]/g, "_");
    // A new account's details read as what they are in the form: its email and its password.
    const names = as === "signup" ? { username: `${base}.signup_email`, password: `${base}.signup_password` } : { username: `${base}.entered_username`, password: `${base}.entered_password` };
    // `hosts`: a provider's sign-in pages (a Microsoft account's live.com and microsoftonline.com).
    const allowedHosts = hosts?.length ? [...hosts] : [site, `*.${site}`];
    for (const [name, value] of [[names.username, username], [names.password, password]] as const) {
      const prev = this.secrets.get(name);
      if (prev?.value && prev.value !== value) this.retired.set(prev.value, name);
      this.put(name, { value, allowedHosts });
    }
    return names;
  }

  /**
   * The phone number or email address the person gave to sign in to `site` with a one-time code (no password):
   * one placeholder the model can type, usable only on the site and its subdomains, masked like any secret.
   */
  addIdentifier(site: string, value: string, kind: "phone" | "email"): string {
    const name = `${site.replace(/[^a-zA-Z0-9_.-]/g, "_")}.entered_${kind}`;
    const prev = this.secrets.get(name);
    if (prev?.value && prev.value !== value) this.retired.set(prev.value, name);
    this.put(name, { value, allowedHosts: [site, `*.${site}`] });
    return name;
  }

  /**
   * Mask `value` as {{name}} in everything scrubbed from now on, without making it typeable: the token
   * of an emailed sign-in link, which shows up in the page's address once the link is opened.
   */
  hide(name: string, value: string): void {
    if (value) this.retired.set(value, name);
  }

  /** Whether secret `name` may be typed for (or sent to) `host`. Unknown names: false. */
  allowedOn(name: string, host: string): boolean {
    const spec = this.secrets.get(name);
    return !!spec && this.hostAllowed(spec, host);
  }

  /** Whether `name` is an authenticator seed (each use is a new code). */
  isTotp(name: string): boolean {
    return !!this.secrets.get(name)?.totp;
  }

  /** Names of the secrets that may be typed on `host` (credentials for a sign-in form there). */
  namesFor(host: string): string[] {
    this.expire();
    return [...this.secrets].filter(([, spec]) => !spec.totp && spec.expiresAt === undefined && this.hostAllowed(spec, host)).map(([name]) => name);
  }

  /** The TOTP-backed secret usable on `host`, if any (for filling a 2FA field without asking). */
  totpFor(host: string): string | undefined {
    this.expire();
    for (const [name, spec] of this.secrets) if (spec.totp && spec.allowedHosts?.length && this.hostAllowed(spec, host)) return name;
    return undefined;
  }

  /** Replace {{name}} placeholders for use on `host`. Throws if a secret is not allowed there. */
  substitute(text: string, host: string): { text: string; used: string[] } {
    this.expire();
    const used: string[] = [];
    const out = text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, name: string) => {
      const spec = this.secrets.get(name);
      if (!spec) return m; // unknown placeholder stays literal so the model sees its mistake
      const allowed = this.hostAllowed(spec, host);
      this.audit.push({ name, host, at: Date.now(), allowed });
      if (!allowed) {
        throw new Error(`Secret "${name}" is not allowed on host "${host}" (allowed: ${spec.allowedHosts?.join(", ") || "none"})`);
      }
      used.push(name);
      this.recent.set(name, ++this.tick);
      if (spec.totp) {
        const code = totp(spec.totp);
        this.issued.set(code, Date.now());
        return code;
      }
      return spec.value ?? "";
    });
    return { text: out, used };
  }

  hostAllowed(spec: SecretSpec, host: string): boolean {
    if (!spec.allowedHosts?.length) return true;
    return spec.allowedHosts.some((g) => globHost(g, host));
  }

  /** Mask every secret value appearing in text (what the model and logs see). */
  scrub(text: string): string {
    if (this.guardOutput) {
      if (!this.holdsSecret(text)) return text;
      this.onOutputHit?.();
      return this.maskGuarded(text);
    }
    if (!this.secrets.size && !this.issued.size && !this.retired.size && !this.typed.size) return text;
    let out = text;
    // One placeholder per value: the name set or typed most recently (`recent`), so a value two secrets share reads as
    // the one this run gave or typed, not whichever was saved first. Longer values first, so a shorter one inside a
    // longer one never splits it.
    const named = new Map<string, string>();
    const take = (value: string, name: string) => {
      const was = named.get(value);
      if (!was || (this.recent.get(name) ?? 0) > (this.recent.get(was) ?? 0)) named.set(value, name);
    };
    for (const [name, spec] of this.secrets) if (spec.value && spec.value.length >= 3) take(spec.value, name);
    for (const [form, name] of this.typedForms) take(form, name);
    for (const [value, name] of [...named].sort((a, b) => b[0].length - a[0].length)) out = maskValue(out, value, `{{${name}}}`);
    for (const code of this.issued.keys()) out = out.split(code).join("{{totp_code}}");
    for (const [value, name] of this.retired) out = maskValue(out, value, `{{${name}}}`);
    for (const value of this.typed.keys()) out = value.length >= 3 ? maskValue(out, value, TYPED_SECRET_MARK) : maskShortValue(out, value, TYPED_SECRET_MARK);
    return out;
  }

  auditLog(): ReadonlyArray<{ name: string; host: string; at: number; allowed: boolean }> {
    return this.audit;
  }

  private expire(): void {
    const now = Date.now();
    for (const [name, spec] of this.secrets) {
      if (spec.expiresAt === undefined || spec.expiresAt > now) continue;
      // Retired whatever its length (18 Nov): the output guard matches a short value too; the readable scrub skips it.
      if (spec.value) this.retired.set(spec.value, name);
      this.secrets.delete(name);
    }
    // An issued code is retired before it leaves the issued list (18 Nov): a page may still show it after its window.
    for (const [code, at] of this.issued)
      if (now - at > 10 * 60_000) {
        this.retired.set(code, "totp_code");
        this.issued.delete(code);
      }
  }
}

/**
 * A per-owner guarded view of `broker` (18 Nov): the output guard on, with its own hit callback, for one agent; every
 * value, input substitution, host refusal and the typed registry are the shared broker's (a view never copies them), and
 * the shared broker and its other users keep their own mode and callbacks (the hosted loop stays readable).
 */
export function guardedView(broker: SecretBroker, onHit: (() => void) | null): SecretBroker {
  const view = Object.create(broker) as SecretBroker;
  view.guardOutput = true;
  view.onOutputHit = onHit;
  return view;
}


/**
 * Put where a password typed into a password field would appear in output (see SecretBroker.addTyped). Private-use
 * characters around a fixed word: never a readable stand-in, and a caller that finds it withholds the whole output.
 */
export const TYPED_SECRET_MARK = "\uE0F1typed-password\uE0F1";

/**
 * Whether `text` holds the digits `digits` in order with only a page's spacing between them (spaces, dashes, dots,
 * slashes, brackets), and no digit right before or after: "+91 98765-43210" holds 9876543210.
 */
export function digitsShown(text: string, digits: string): boolean {
  const body = [...digits].join("[\\s\\-./()]*");
  return new RegExp(`(?<!\\d)${body}(?!\\d)`).test(text);
}

/**
 * Every form of `value` the output guard looks for (SecretBroker.holdsSecret), whatever its length: the value and its
 * whitespace-collapsed form, each raw, encodeURIComponent, encodeURI, base64, base64url, JSON-escaped and fully
 * \u-escaped. Bounded like maskValue: no hashes, encryption, split strings or case changes.
 */
export function outputForms(value: string): string[] {
  const forms = new Set<string>();
  const collapsed = value.replace(/\s+/g, " ").trim();
  for (const v of new Set([value, collapsed])) {
    if (!v) continue;
    forms.add(v);
    for (const enc of [encodeURIComponent, encodeURI]) {
      try {
        forms.add(enc(v));
      } catch {
        /* lone surrogate */
      }
    }
    forms.add(Buffer.from(v, "utf8").toString("base64"));
    forms.add(Buffer.from(v, "utf8").toString("base64url"));
    forms.add(JSON.stringify(v).slice(1, -1));
    let unicode = "";
    for (let i = 0; i < v.length; i++) unicode += "\\u" + v.charCodeAt(i).toString(16).padStart(4, "0");
    forms.add(unicode);
  }
  return [...forms].filter(Boolean);
}

/**
 * A short value (1-2 characters) replaced by `mark` wherever it occurs as a substring: its raw, URL-encoded,
 * JSON-escaped, base64 and base64url forms, inside other words too (longest form first).
 */
export function maskShortValue(text: string, value: string, mark: string): string {
  if (!value) return text;
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1), Buffer.from(value, "utf8").toString("base64"), Buffer.from(value, "utf8").toString("base64url")]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    /* lone surrogate */
  }
  let out = text;
  for (const f of [...forms].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(f).join(mark);
  return out;
}

/**
 * A copy of `v` with every string VALUE passed through `f` (arrays and plain objects walked; numbers, booleans, null
 * and undefined kept; Sets, Maps and class instances other than plain objects returned as they are). Used at data
 * boundaries instead of text-substituting a serialized form, which escapes quotes, backslashes and newlines.
 */
export function scrubDeep<T>(v: T, f: (s: string) => string): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return f(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}

/**
 * Mask a secret value in `text`, defensively: the exact value, its whitespace-collapsed form (page
 * serialization collapses runs of whitespace, so a PEM key or a value with spaces would not match
 * raw), and any clipped prefix the serializer may emit (it truncates long values to `prefix + "…"`,
 * which would otherwise reveal most of a token). The clipped form is only masked for values long
 * enough to actually be truncated, so short codes and ordinary page text are never over-masked.
 */
export function maskValue(text: string, value: string, placeholder: string): string {
  if (!value || value.length < 3) return text;
  let out = text.split(value).join(placeholder);
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed && collapsed !== value && collapsed.length >= 3) out = out.split(collapsed).join(placeholder);
  // A secret in a URL is percent-encoded (login_hint=jane%40ex.com): mask that form too.
  for (const v of new Set([value, collapsed])) {
    let enc = "";
    try { enc = encodeURIComponent(v); } catch { /* lone surrogate */ }
    if (enc && enc !== v && enc.length >= 3) out = out.split(enc).join(placeholder);
  }
  // Common reversible representations in DOM, JSON and URLs. This is deliberately bounded:
  // arbitrary encryption, hashes, split strings and case-changing transforms are not covered.
  // Generate only from configured values, never by decoding or executing untrusted page text.
  const encoded = new Set<string>();
  for (const v of new Set([value, collapsed])) {
    if (v.length < 3) continue;
    encoded.add(Buffer.from(v, "utf8").toString("base64"));
    encoded.add(Buffer.from(v, "utf8").toString("base64url"));
    encoded.add(JSON.stringify(v).slice(1, -1));
    // JSON also allows every UTF-16 code unit escaped, including surrogate pairs.
    let unicode = "";
    for (let i = 0; i < v.length; i++) unicode += "\\u" + v.charCodeAt(i).toString(16).padStart(4, "0");
    encoded.add(unicode);
  }
  for (const form of encoded) if (form && form !== value && form.length >= 3) out = out.split(form).join(placeholder);
  // Only values that can be clipped (longer than the serializer's ~60-char caps) need prefix masking.
  // Scanned by hand, not with a regex: an optional-char pattern ("a?b?c?…") backtracks exponentially
  // on a near-miss (a long token that shares the head but has no trailing "…"), which would stall the
  // event loop for seconds on every observation. indexOf + a linear char walk is O(n·m) worst case.
  if (collapsed.length > 40) {
    const reveal = 6; // chars that must match literally before we extend, to avoid false hits
    const head = collapsed.slice(0, reveal);
    let result = "";
    let i = 0;
    for (;;) {
      const at = out.indexOf(head, i);
      if (at < 0) { result += out.slice(i); break; }
      let j = at + reveal;
      let k = reveal;
      while (j < out.length && k < collapsed.length && out[j] === collapsed[k]) { j++; k++; }
      if (out[j] === "…") {
        result += out.slice(i, at) + placeholder;
        i = j + 1;
      } else {
        result += out.slice(i, at + 1); // keep the text up to here; re-scan from the next char
        i = at + 1;
      }
    }
    out = result;
  }
  return out;
}

/** RFC 6238 TOTP (SHA-1, 30 s step, 6 digits), the scheme authenticator apps use by default. */
export function totp(base32Seed: string, at = Date.now(), digits = 6, stepS = 30): string {
  const key = base32Decode(base32Seed);
  const counter = Math.floor(at / 1000 / stepS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error("TOTP seed is not valid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function globHost(glob: string, host: string): boolean {
  if (glob === host) return true;
  if (glob.startsWith("*.")) {
    const base = glob.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return false;
}
