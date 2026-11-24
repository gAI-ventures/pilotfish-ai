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

describe("a value two secrets share reads as the newest one (24 Nov, a Flipkart sign-in)", () => {
  it("a number given for this site wins over a saved login elsewhere with the same number", () => {
    const b = new SecretBroker({ "swiggy.com.username": { value: "9876543210", allowedHosts: ["swiggy.com"] } });
    b.addIdentifier("flipkart.com", "9876543210", "phone");
    expect(b.scrub("Phone Number: 9876543210")).toBe("Phone Number: {{flipkart.com.entered_phone}}");
  });

  it("typing a placeholder makes it the newest: the page then shows that name", () => {
    const b = new SecretBroker({ "a.com.username": { value: "same-user@example.com", allowedHosts: ["a.com"] }, "b.com.username": { value: "same-user@example.com", allowedHosts: ["b.com"] } });
    expect(b.scrub("same-user@example.com")).toBe("{{b.com.username}}");
    b.substitute("{{a.com.username}}", "a.com");
    expect(b.scrub("user: same-user@example.com")).toBe("user: {{a.com.username}}");
  });

  it("a phone fitted to its field is masked as the name it was typed from, in readable and guarded output", () => {
    const b = new SecretBroker({ "swiggy.com.username": { value: "9876543210", allowedHosts: ["swiggy.com"] } });
    const name = b.addIdentifier("flipkart.com", "+91 98765 43210", "phone");
    b.substitute(`{{${name}}}`, "www.flipkart.com");
    b.addTypedForm(name, "9876543210");
    expect(b.scrub("+91 [Phone Number: 9876543210]")).toBe("+91 [Phone Number: {{flipkart.com.entered_phone}}]");
    b.guardOutput = true;
    expect(b.holdsSecret("9876543210")).toBe(true);
  });

  it("a typed form of an unknown name, or one under 3 characters, is not kept", () => {
    const b = new SecretBroker();
    b.addTypedForm("nope", "9876543210");
    b.addTypedForm("nope", "12");
    expect(b.scrub("9876543210")).toBe("9876543210");
  });

  it("a shorter value inside a longer one never splits it", () => {
    const b = new SecretBroker({ short: "4321", long: "98765-4321-00" });
    expect(b.scrub("id 98765-4321-00 and 4321")).toBe("id {{long}} and {{short}}");
  });
});

describe("typed passwords (fifth review, 17 Nov): every form becomes the withholding mark", () => {
  it("short values as substrings in raw, URL-encoded, JSON-escaped and base64 forms, inside other words too", async () => {
    const { maskShortValue, TYPED_SECRET_MARK: M } = await import("./secrets.js");
    expect(maskShortValue("Pinqok and query", "q", M)).toBe(`Pin${M}ok and ${M}uery`);
    expect(maskShortValue("/glue?p=az%26b", "z&", M)).toBe(`/glue?p=a${M}b`);
    expect(maskShortValue("B64:cQ==end", "q", M)).toBe(`B64:${M}end`);
    expect(maskShortValue('{"v":"az&b"}', "z&", M)).toBe(`{"v":"a${M}b"}`);
  });
  it("the broker's scrub puts the mark for short and long typed passwords; configured secrets keep their placeholder", async () => {
    const { TYPED_SECRET_MARK: M } = await import("./secrets.js");
    const b = new SecretBroker({ api: "configured-key" });
    b.addTyped("q");
    b.addTyped("longer-secret");
    expect(b.scrub("Hello q, longer-secret, configured-key")).toBe(`Hello ${M}, ${M}, {{api}}`);
  });
});

describe("output guard (18 Nov: 9504402 and its corrections)", () => {
  const SECRET = "hunter2-xyz";
  const RESERVED = "p@ss/w%rd&x?#";

  it("guard off (the hosted loop): input substitution, host refusal and readable placeholders as before; a short value is not rewritten", () => {
    const b = new SecretBroker({ pw: { value: SECRET, allowedHosts: ["a.example"] }, pin: "Zx" });
    expect(b.substitute("{{pw}}", "a.example").text).toBe(SECRET);
    expect(() => b.substitute("{{pw}}", "evil.example")).toThrow(/not allowed/);
    expect(b.scrub(`k=${SECRET}`)).toBe("k={{pw}}");
    expect(b.scrub("Zx here")).toBe("Zx here");
    b.addTyped("typedpw", ["pw"]);
    expect(b.typedFrom("typedpw")).toEqual(["pw"]);
    expect(b.typedFrom("other")).toBeUndefined();
  });

  it("guard on: clean text comes back exactly (no rewrite); any recognized form of any value, short included, is reported and marked, never a placeholder", async () => {
    const { TYPED_SECRET_MARK: M } = await import("./secrets.js");
    const b = new SecretBroker({ pw: SECRET, pin: "Zx", res: RESERVED });
    let hits = 0;
    b.guardOutput = true;
    b.onOutputHit = () => hits++;
    const clean = '[e12]<button>Save\n  "{{pw}}" typed literally';
    expect(b.scrub(clean)).toBe(clean);
    expect(hits).toBe(0);
    const dirty = [`raw ${SECRET}`, `uri /landing/${encodeURI(RESERVED)}`, `component ${encodeURIComponent(RESERVED)}`, `b64 ${Buffer.from(SECRET).toString("base64")}`, `json ${JSON.stringify(RESERVED)}`, "short Zx"];
    for (const t of dirty) {
      const out = b.scrub(t);
      expect(out, t).toContain(M);
      expect(out, t).not.toMatch(/\{\{(pw|pin|res)\}\}/);
      for (const v of [SECRET, RESERVED, encodeURI(RESERVED), encodeURIComponent(RESERVED), "Zx"]) expect(out, t).not.toContain(v);
    }
    expect(hits).toBe(dirty.length);
  });

  it("an issued authenticator code stays guarded after its 10-minute window ends (it is retired, not dropped)", () => {
    const seed = "JBSWY3DPEHPK3PXP";
    const b = new SecretBroker({ otp: { totp: seed, allowedHosts: ["a.example"] } });
    b.guardOutput = true;
    const t0 = Date.now();
    const realNow = Date.now;
    try {
      const code = b.substitute("{{otp}}", "a.example").text;
      // Issued only: never registered as a typed password, so only the issued/retired path can guard it.
      expect(b.typedFrom(code)).toBeUndefined();
      expect(b.typedCount).toBe(0);
      expect(b.holdsSecret(`Echo ${code}`)).toBe(true);
      Date.now = () => t0 + 11 * 60_000; // past the 10-minute removal
      expect(b.holdsSecret(`Echo ${code}`)).toBe(true);
      expect(b.scrub(`Echo ${code}`)).not.toContain(code);
    } finally {
      Date.now = realNow;
    }
  });

  it("a shared broker: each guarded view reports only to its own owner; the shared broker and other users stay readable", async () => {
    const { guardedView } = (await import("./secrets.js")) as unknown as { guardedView: (b: SecretBroker, onHit: (() => void) | null) => SecretBroker };
    const shared = new SecretBroker({ pw: { value: SECRET, allowedHosts: ["a.example"] } });
    let a = 0;
    let c = 0;
    const viewA = guardedView(shared, () => a++);
    const viewC = guardedView(shared, () => c++);
    viewA.scrub(`k=${SECRET}`);
    expect([a, c]).toEqual([1, 0]);
    viewC.scrub("nothing here");
    expect([a, c]).toEqual([1, 0]);
    // The shared broker itself (the hosted loop's) is unchanged: readable placeholder, no guard, no callback.
    expect(shared.guardOutput).toBe(false);
    expect(shared.scrub(`k=${SECRET}`)).toBe("k={{pw}}");
    expect([a, c]).toEqual([1, 0]);
    // Input through a view: the same substitution and refusal.
    expect(viewA.substitute("{{pw}}", "a.example").text).toBe(SECRET);
    expect(() => viewA.substitute("{{pw}}", "evil.example")).toThrow(/not allowed/);
  });
});
