// Checking a webhook delivery. Each one carries `Pilotfish-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of
// "<t>.<raw body>" with your org's webhook secret (Org settings, or GET /org/webhook-secret), and `Pilotfish-Event`.
// Uses Web Crypto, so it runs in Node 18+, Deno, Bun and edge runtimes alike.

import { PilotfishError } from "./errors.js";

/** What a delivery's body holds. */
export interface WebhookEvent {
  type: "job.needs_input" | "job.finished" | "job.question_withdrawn" | "identity.login_saved" | "batch.finished" | (string & {});
  jobId?: string;
  batchId?: string;
  at: number;
  data: Record<string, unknown>;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, message: string): Promise<string> {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, te.encode(message)));
}

/** Constant-time comparison of two hex strings of the same length. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * True when `signature` (the `Pilotfish-Signature` header) signs `body` (the raw request body, exactly as received)
 * with `secret`, and is at most `toleranceS` seconds old (default 300).
 */
export async function verifyWebhook(secret: string, signature: string | null | undefined, body: string | Uint8Array, o: { toleranceS?: number; now?: number } = {}): Promise<boolean> {
  if (!signature) return false;
  const t = Number(/(?:^|,)\s*t=(\d+)/.exec(signature)?.[1]);
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(signature)?.[1];
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!t || !v1 || Math.abs(now - t) > (o.toleranceS ?? 300)) return false;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return same(await hmacHex(secret, `${t}.${text}`), v1);
}

/** The delivery's event, once its signature is checked; throws when it does not verify. */
export async function parseWebhook(secret: string, signature: string | null | undefined, body: string | Uint8Array, o: { toleranceS?: number; now?: number } = {}): Promise<WebhookEvent> {
  if (!(await verifyWebhook(secret, signature, body, o))) throw new PilotfishError(0, { error: "The webhook's signature does not match (or is too old).", code: "bad_signature" });
  return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as WebhookEvent;
}

/** A `Pilotfish-Signature` header for `body` (tests of your own endpoint). */
export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}
