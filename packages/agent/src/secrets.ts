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
  /** Every host glob a secret was ever usable on ("*": one scoped to none), expired ones included: a page there may show a value. */
  private readonly shownOn = new Set<string>();

  constructor(secrets: Record<string, string | SecretSpec> = {}) {
    for (const [name, spec] of Object.entries(secrets)) this.put(name, typeof spec === "string" ? { value: spec } : spec);
  }

  private put(name: string, spec: SecretSpec): void {
    this.secrets.set(name, spec);
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
    return this.secrets.size + this.retired.size;
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
    if (prev?.value && prev.value.length >= 3 && prev.value !== value) this.retired.set(prev.value, name);
    this.put(name, { value, allowedHosts, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Sign-in details the person typed on pilotfish's own page for `site`: two placeholders the model can
   * type, usable only on the site and its subdomains, masked like any secret. Replacing earlier ones
   * keeps the old values masked.
   */
  addLogin(site: string, username: string, password: string, as: "entered" | "signup" = "entered"): { username: string; password: string } {
    const base = site.replace(/[^a-zA-Z0-9_.-]/g, "_");
    // A new account's details read as what they are in the form: its email and its password.
    const names = as === "signup" ? { username: `${base}.signup_email`, password: `${base}.signup_password` } : { username: `${base}.entered_username`, password: `${base}.entered_password` };
    const allowedHosts = [site, `*.${site}`];
    for (const [name, value] of [[names.username, username], [names.password, password]] as const) {
      const prev = this.secrets.get(name);
      if (prev?.value && prev.value.length >= 3 && prev.value !== value) this.retired.set(prev.value, name);
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
    if (prev?.value && prev.value.length >= 3 && prev.value !== value) this.retired.set(prev.value, name);
    this.put(name, { value, allowedHosts: [site, `*.${site}`] });
    return name;
  }

  /**
   * Mask `value` as {{name}} in everything scrubbed from now on, without making it typeable: the token
   * of an emailed sign-in link, which shows up in the page's address once the link is opened.
   */
  hide(name: string, value: string): void {
    if (value.length >= 3) this.retired.set(value, name);
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
    if (!this.secrets.size && !this.issued.size && !this.retired.size) return text;
    let out = text;
    for (const [name, spec] of this.secrets) {
      if (!spec.value || spec.value.length < 3) continue;
      out = maskValue(out, spec.value, `{{${name}}}`);
    }
    for (const code of this.issued.keys()) out = out.split(code).join("{{totp_code}}");
    for (const [value, name] of this.retired) out = maskValue(out, value, `{{${name}}}`);
    return out;
  }

  auditLog(): ReadonlyArray<{ name: string; host: string; at: number; allowed: boolean }> {
    return this.audit;
  }

  private expire(): void {
    const now = Date.now();
    for (const [name, spec] of this.secrets) {
      if (spec.expiresAt === undefined || spec.expiresAt > now) continue;
      if (spec.value && spec.value.length >= 3) this.retired.set(spec.value, name);
      this.secrets.delete(name);
    }
    for (const [code, at] of this.issued) if (now - at > 10 * 60_000) this.issued.delete(code);
  }
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
