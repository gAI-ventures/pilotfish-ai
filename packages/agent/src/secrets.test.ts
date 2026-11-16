import { describe, expect, it } from "vitest";
import { SecretBroker, totp } from "./secrets.js";

// RFC 6238 appendix B: seed "12345678901234567890" (base32 below), SHA-1.
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totp(RFC_SEED, 59_000, 8)).toBe("94287082");
    expect(totp(RFC_SEED, 1_111_111_109_000, 8)).toBe("07081804");
    expect(totp(RFC_SEED, 20_000_000_000_000, 8)).toBe("65353130");
    expect(totp(RFC_SEED, 59_000)).toBe("287082");
  });
});

describe("SecretBroker", () => {
  it("types the current TOTP code, scoped to its hosts, and scrubs it afterwards", () => {
    const b = new SecretBroker({ bank_2fa: { totp: RFC_SEED, allowedHosts: ["*.bank.example"] } });
    expect(b.totpFor("login.bank.example")).toBe("bank_2fa");
    expect(b.totpFor("evil.example")).toBeUndefined();
    const { text } = b.substitute("{{bank_2fa}}", "login.bank.example");
    expect(text).toMatch(/^\d{6}$/);
    expect(b.scrub(`value "" -> "${text}"`)).toBe('value "" -> "{{totp_code}}"');
    expect(() => b.substitute("{{bank_2fa}}", "evil.example")).toThrow(/not allowed/);
  });

  it("masks a long secret even when the page clipped or whitespace-collapsed it", () => {
    const token = "github_pat_11ABCDEFG0123456789_" + "y".repeat(60); // > 60 chars, gets clipped
    const b = new SecretBroker({ token: { value: token, allowedHosts: ["example.com"] }, key: { value: "line one\n  line two\twith spaces" } });
    // Exact value.
    expect(b.scrub(`got ${token} ok`)).toBe("got {{token}} ok");
    // The serializer collapses whitespace: a multi-line value must still be masked.
    expect(b.scrub("field = line one line two with spaces here")).toContain("{{key}}");
    // A clipped value ("prefix…") must not reveal a usable prefix.
    const clipped = token.replace(/\s+/g, " ").slice(0, 79) + "…";
    expect(b.scrub(`value="${clipped}"`)).toBe('value="{{token}}"');
    // A short unrelated token that merely shares a prefix is left alone.
    expect(b.scrub("github_pat_short… and plain text")).toContain("github_pat_short…");
  });

  it("scrubs a long secret against adversarial near-miss text without stalling (ReDoS guard)", () => {
    // A long secret and page text that share the head and a long run, then diverge with NO trailing
    // ellipsis — the worst case for prefix masking (an optional-char regex is O(2^n) here). The page is
    // NOT a superstring of the secret, so only the clip scan can touch it. Must stay fast.
    const secret = "eyJhbG" + "a".repeat(1200);
    const b = new SecretBroker({ jwt: { value: secret } });
    const page = "token: eyJhbG" + "a".repeat(1100) + "b".repeat(100) + " end";
    const t0 = Date.now();
    const out = b.scrub(page);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toContain("token: eyJhbG"); // the near-miss (not the secret) is left alone
    // The real clipped secret ("prefix…") is still masked.
    expect(b.scrub(`v="${secret.slice(0, 79)}…"`)).toBe('v="{{jwt}}"');
  });

  it("hides a sign-in link's token in everything scrubbed, raw or percent-encoded, without making it typeable", () => {
    const b = new SecretBroker();
    const token = "tk_8f3a9c2b7e1d4f60a5b9";
    b.hide("link_token", token);
    b.hide("link_token", "a/b c+d==long-enough-value");
    expect(b.scrub(`https://a.example/verify?token=${token}&next=/`)).toBe("https://a.example/verify?token={{link_token}}&next=/");
    expect(b.scrub(`v=${encodeURIComponent("a/b c+d==long-enough-value")}`)).toBe("v={{link_token}}");
    expect(b.names()).not.toContain("link_token");
    expect(b.substitute("{{link_token}}", "a.example").text).toBe("{{link_token}}");
    expect(b.size).toBeGreaterThan(0);
  });

  it("keeps a code the user typed only for its host and only for its time window", () => {
    const b = new SecretBroker();
    b.addEphemeral("otp", "482913", ["accounts.example.com"], 50);
    expect(b.substitute("{{otp}}", "accounts.example.com").text).toBe("482913");
    expect(b.scrub("code 482913")).toBe("code {{otp}}");
    expect(() => b.substitute("{{otp}}", "other.example")).toThrow();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(b.names()).not.toContain("otp");
        expect(b.substitute("{{otp}}", "accounts.example.com").text).toBe("{{otp}}");
        // No longer typed, still masked: the code may still sit in a field the model reads.
        expect(b.scrub("field shows 482913")).toBe("field shows {{otp}}");
        expect(b.size).toBeGreaterThan(0);
        resolve();
      }, 80),
    );
  });
});
