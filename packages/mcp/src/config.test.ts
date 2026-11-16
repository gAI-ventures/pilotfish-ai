import { describe, expect, it } from "vitest";
import { configFromEnv, parseHosts, parseSecrets } from "./config.js";

describe("parseSecrets", () => {
  it("accepts plain values and specs, and normalizes allowed hosts", () => {
    const s = parseSecrets(JSON.stringify({ pw: "hunter2", otp: { totp: "JBSWY3DPEHPK3PXP", allowedHosts: [" Example.com "] }, key: { value: "k-123", allowedHosts: ["*.api.example.com"] } }));
    expect(s).toEqual({
      pw: { value: "hunter2" },
      otp: { totp: "JBSWY3DPEHPK3PXP", allowedHosts: ["example.com"] },
      key: { value: "k-123", allowedHosts: ["*.api.example.com"] },
    });
  });

  it("treats an unset or blank variable as no secrets", () => {
    expect(parseSecrets(undefined)).toEqual({});
    expect(parseSecrets("  ")).toEqual({});
  });

  it("never quotes a value in an error", () => {
    const value = "s3cr3t-value-xyz";
    const bad = [
      `{"pw": "${value}"`, // not JSON: JSON.parse's own message would quote the input
      `["${value}"]`, // not an object
      JSON.stringify({ pw: { value, extra: true } }), // unknown key
      JSON.stringify({ pw: { allowedHosts: [value] } }), // neither value nor totp
      JSON.stringify({ pw: { totp: `${value}!` } }), // not base32
      JSON.stringify({ pw: 42 }),
      JSON.stringify({ "bad name": value }),
    ];
    for (const raw of bad) {
      let message = "";
      try {
        parseSecrets(raw);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, raw).toMatch(/^PILOTFISH_SECRETS/);
      expect(message).not.toContain(value);
    }
  });

  it("names the entry that is wrong", () => {
    expect(() => parseSecrets(JSON.stringify({ ok: "a", broken: { value: "" } }))).toThrow(/"broken"/);
  });
});

describe("parseHosts", () => {
  it("splits, trims, lower-cases and drops empties", () => {
    expect(parseHosts(" Example.com, *.shop.example.com ,, ")).toEqual(["example.com", "*.shop.example.com"]);
    expect(parseHosts(undefined)).toEqual([]);
  });
});

describe("configFromEnv", () => {
  it("defaults: a window where one can be shown, public hosts only, 3 min interventions, screenshots on", () => {
    expect(configFromEnv({}, "linux")).toEqual({ headless: true, allowedHosts: [], allowPrivateNetwork: false, secrets: {}, interventionTimeoutMs: 180_000, allowScreenshots: true });
    // The person signs in and solves CAPTCHAs in the window: headed on a desktop, headless only with no display.
    expect(configFromEnv({}, "win32").headless).toBe(false);
    expect(configFromEnv({}, "darwin").headless).toBe(false);
    expect(configFromEnv({ DISPLAY: ":0" }, "linux").headless).toBe(false);
    expect(configFromEnv({ WAYLAND_DISPLAY: "wayland-0" }, "linux").headless).toBe(false);
    expect(configFromEnv({ PILOTFISH_HEADLESS: "1" }, "win32").headless).toBe(true);
  });

  it("reads the flags", () => {
    const c = configFromEnv({
      PILOTFISH_HEADLESS: "0",
      PILOTFISH_ALLOWED_HOSTS: "a.com,*.b.com",
      PILOTFISH_ALLOW_PRIVATE: "1",
      PILOTFISH_INTERVENTION_TIMEOUT_MS: "5000",
      PILOTFISH_SECRETS: '{"pw":"x1y2z3"}',
    });
    expect(c).toMatchObject({ headless: false, allowedHosts: ["a.com", "*.b.com"], allowPrivateNetwork: true, interventionTimeoutMs: 5000, secrets: { pw: { value: "x1y2z3" } } });
    // Secrets configured: no screenshots unless asked for.
    expect(c.allowScreenshots).toBe(false);
    expect(configFromEnv({ PILOTFISH_SECRETS: '{"pw":"x1y2z3"}', PILOTFISH_ALLOW_SCREENSHOTS: "1" }).allowScreenshots).toBe(true);
    expect(configFromEnv({ PILOTFISH_HEADLESS: "false" }).headless).toBe(false);
    expect(configFromEnv({ PILOTFISH_INTERVENTION_TIMEOUT_MS: "soon" }).interventionTimeoutMs).toBe(180_000);
  });
  it("has no proxy, region or saved-profile settings (the plain local variant)", () => {
    const c = configFromEnv({ SOME_PROXY_USERNAME: "sp1", SOME_PROXY_PASSWORD: "pw", PILOTFISH_REGION: "US", PILOTFISH_PROXY: "http://h:1", PILOTFISH_PROFILE_DIR: "/tmp/p" });
    expect(Object.keys(c).sort()).toEqual(["allowPrivateNetwork", "allowScreenshots", "allowedHosts", "headless", "interventionTimeoutMs", "secrets"]);
  });

  it("has no model or API-key settings (the client's own model drives the browser)", () => {
    const c = configFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x", PILOTFISH_MODEL: "claude-haiku-5-5" });
    expect(c).toEqual(configFromEnv({}));
    expect(JSON.stringify(c)).not.toMatch(/sk-|claude/);
  });
});
