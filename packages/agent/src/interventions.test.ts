import { describe, expect, it } from "vitest";
import type { Page } from "@pilotfish/browser";
import type { InterruptInput, Interruption, Snapshot } from "@pilotfish/perception";
import { classifyPage, describeInterruption, rateLimited, retryAfterMs, UnboundLookError } from "./interventions.js";

const hit = (category: Interruption["category"], signals: string[], vendor?: string): Interruption => ({ category, signals, blocking: true, needs: "none_possible", ...(vendor ? { vendor } : {}) }) as Interruption;
const withHeaders = (headers: Record<string, string>): InterruptInput => ({ response: { url: "https://a.example/", status: 429, headers } }) as InterruptInput;

describe("rate limits (review of 3 Nov)", () => {
  it("a 429 page and Cloudflare's 1015 are rate limits; a ban, a Google sign-in refusal and a Kasada 429 challenge are not", () => {
    expect(rateLimited(hit("hard_block", ["429 rate limited"]))).toBe(true);
    expect(rateLimited(hit("hard_block", ["Cloudflare 1015 rate limit"], "cloudflare"))).toBe(true);
    expect(rateLimited(hit("hard_block", ["Cloudflare block page (\"Sorry, you have been blocked\")"], "cloudflare"))).toBe(false);
    expect(rateLimited(hit("hard_block", ["Google \"This browser or app may not be secure\""], "google"))).toBe(false);
    expect(rateLimited(hit("bot_challenge", ["429 + x-kpsdk-ct header"], "kasada"))).toBe(false);
  });

  it("reads Retry-After in seconds or as a date, in any letter case, kept within 1-60 s", () => {
    expect(retryAfterMs(withHeaders({ "retry-after": "5" }))).toBe(5_000);
    expect(retryAfterMs(withHeaders({ "Retry-After": "0" }))).toBe(1_000);
    expect(retryAfterMs(withHeaders({ "retry-after": "3600" }))).toBe(60_000);
    const now = Date.parse("2026-11-04T10:00:00Z");
    expect(retryAfterMs(withHeaders({ "retry-after": "Wed, 04 Nov 2026 10:00:20 GMT" }), now)).toBe(20_000);
    expect(retryAfterMs(withHeaders({}))).toBeNull();
    expect(retryAfterMs(withHeaders({ "retry-after": "soon" }))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("a look bound to no document (fifth review)", () => {
  it("is not classified: a snapshot taken while the page kept committing other documents throws UnboundLookError", async () => {
    // No CDP call is made for it: the fake page has no session.
    const snap = { url: "http://x/block", unsettled: true, document: null } as unknown as Snapshot;
    await expect(classifyPage({} as Page, snap)).rejects.toBeInstanceOf(UnboundLookError);
  });
});

describe("hand-off messages for sign-in steps no hosted browser can finish", () => {
  const passkey = describeInterruption(hit("passkey", ["passkey"]), "login.example.com");

  it("a passkey or QR sign-in is explained as device-bound by design, with the ways forward, and never as an error", () => {
    expect(passkey).toContain("login.example.com");
    expect(passkey).toMatch(/by design/i);
    expect(passkey).toMatch(/Touch ID, Face ID, a security key/);
    expect(passkey).toMatch(/QR/);
    expect(passkey).toMatch(/password or a one-time code/);
    expect(passkey).toMatch(/live view/);
    expect(passkey).toMatch(/saved with pilotfish/);
    expect(passkey).toMatch(/local MCP/);
    expect(passkey).not.toMatch(/error|fail|unable|cannot be fixed|sorry/i);
  });

  it("a login hand-off says the signed-in session is reused on later runs", () => {
    const m = describeInterruption(hit("login", ["password field"]), "shop.example.com");
    expect(m).toMatch(/live view/);
    expect(m).toMatch(/reused on later runs/);
  });

  it("a code hand-off keeps the hint and offers the repeat-use ways (signed-in session, app password, 2FA off)", () => {
    const i = { ...hit("otp", ["code field"]), input: { hint: "sent to a***@x.com" } } as Interruption;
    const m = describeInterruption(i, "bank.example.com");
    expect(m).toContain("sent to a***@x.com");
    expect(m).toMatch(/send the code, or type it in the live view/);
    expect(m).toMatch(/app password/);
    expect(m).toMatch(/two-step verification/);
    expect(m).toMatch(/session is reused/);
  });

  it("a payment or bot check does not pick up the sign-in advice", () => {
    expect(describeInterruption(hit("payment_3ds", ["3ds"]), "pay.example.com")).not.toMatch(/app password/);
    expect(describeInterruption(hit("captcha", ["captcha"]), "x.example.com")).not.toMatch(/app password|reused/);
  });
});
