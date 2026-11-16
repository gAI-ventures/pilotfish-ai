import { describe, expect, it } from "vitest";
import { hostLegacyPatterns, hostTouchesProtected, hostUrlPattern, isCmpRequest, isNeverBlocked, isSensorRequest, ruleUrlPattern } from "./hosts.js";

describe("allow-list", () => {
  it.each([
    "https://challenges.cloudflare.com/turnstile/v0/api.js",
    "https://www.recaptcha.net/recaptcha/api.js",
    "https://www.google.com/recaptcha/api.js",
    "https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js",
    "https://newassets.hcaptcha.com/captcha/v1/x.js",
    "https://client-api.arkoselabs.com/v2/api.js",
    "https://x.funcaptcha.com/fc/gt2",
    "https://geo.captcha-delivery.com/captcha/",
    "https://collector-pxabc.perimeterx.net/api/v2/collector",
    "https://client.px-cdn.net/PXabc/main.min.js",
    "https://abc.edge.sdk.awswaf.com/abc/challenge.js",
    "https://static.geetest.com/v4/gt4.js",
    "https://js.stripe.com/v3/",
    "https://m.stripe.network/inner.html",
    "https://www.paypal.com/sdk/js",
    "https://checkoutshopper-live.adyen.com/checkoutshopper/sdk.js",
    "https://assets.braintreegateway.com/web/3/js/client.min.js",
    "https://centinelapi.cardinalcommerce.com/V1/Cruise/Songbird.js",
    "https://accounts.google.com/gsi/client",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://appleid.apple.com/auth/authorize",
    "https://acme.okta.com/oauth2/v1/authorize",
    "https://tenant.eu.auth0.com/authorize",
    "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js",
    "https://consent.cookiebot.com/uc.js",
    "https://app.usercentrics.eu/browser-ui/latest/loader.js",
    "https://sdk.privacy-center.org/loader.js",
    "https://cdn.consentmanager.net/delivery/cmp.min.js",
    "https://cdn.privacy-mgmt.com/wrapperMessagingWithoutDetection.js",
    "https://fundingchoicesmessages.google.com/i/pub-123",
    "https://cmp.osano.com/x/osano.js",
    "https://cdn-cookieyes.com/client_data/x/script.js",
    "https://experience.tinypass.com/xbuilder/experience/load",
  ])("never blocks %s", (url) => {
    expect(isNeverBlocked(url)).toBe(true);
  });

  it.each([
    "https://www.google.com/search?q=x",
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
    "https://notstripe.com/x.js",
    "https://stripe.com.evil.example/x.js",
    "https://www.gstatic.com/images/x.png",
  ])("does not protect %s", (url) => {
    expect(isNeverBlocked(url)).toBe(false);
  });

  it.each([
    "https://www.zillow.com/HYx10rg3/init.js",
    "https://www.zillow.com/HYx10rg3/xhr/api/v2/collector",
    "https://www.zillow.com/HYx10rg3/captcha/captcha.js?a=c&u=1",
    "https://www.walmart.com/px/PXu6b0qd2S/init.js",
    "https://www.walmart.com/px/PXu6b0qd2S/xhr/api/v2/collector",
    "https://collector-pxhyx10rg3.px-client.net/api/v2/collector",
    "https://collector-px0py5pczn.octopart.com/api/v2/collector",
    "https://www.homedepot.com/akam/13/pixel_3c0a7b21",
    "https://www.homedepot.com/akam/13/3c0a7b21",
    "https://www.nike.com/_bm/_data",
    "https://dd.leboncoin.fr/js/",
    "https://www.example.com/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e",
    "https://www.example.com/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js",
    "https://www.example.com/cdn-cgi/challenge-platform/h/b/jsd/r/abc",
  ])("never blocks the first-party sensor request %s", (url) => {
    expect(isNeverBlocked(url)).toBe(true);
  });

  it.each([
    "https://www.example.com/api/v2/collector", // the generic tracker path stays blockable
    "https://www.example.com/static/init.js",
    "https://www.example.com/akam/pixel.gif",
    "https://add.example.com/js/",
  ])("leaves %s to the lists", (url) => {
    expect(isSensorRequest(url)).toBe(false);
    expect(isNeverBlocked(url)).toBe(false);
  });

  it("protects sensor subdomains from wholesale blocking, but only under the full allow-list", () => {
    expect(hostTouchesProtected("dd.leboncoin.fr")).toBe(true);
    expect(hostTouchesProtected("collector-px0py5pczn.octopart.com")).toBe(true);
    expect(hostTouchesProtected("dd.leboncoin.fr", ["stripe.com"])).toBe(false);
    expect(isCmpRequest("https://www.zillow.com/HYx10rg3/init.js")).toBe(false);
  });

  it("flags hosts whose wholesale block would cover a protected host", () => {
    expect(hostTouchesProtected("google.com")).toBe(true); // accounts.google.com, www.google.com/recaptcha
    expect(hostTouchesProtected("x.stripe.com")).toBe(true);
    expect(hostTouchesProtected("doubleclick.net")).toBe(false);
  });

  it("recognises consent-manager requests", () => {
    expect(isCmpRequest("https://cdn.cookielaw.org/consent/abc.json")).toBe(true);
    expect(isCmpRequest("https://www.googletagmanager.com/gtm.js")).toBe(false);
  });
});

describe("patterns", () => {
  it("builds URLPattern host and path patterns", () => {
    expect(hostUrlPattern("doubleclick.net")).toBe("*://{*.}?doubleclick.net:*/*");
    expect(ruleUrlPattern("www.google.com/recaptcha")).toBe("*://www.google.com:*/recaptcha*");
    expect(hostLegacyPatterns("a.com")).toContain("*://*.a.com/*");
  });

  it("refuses anything that is not a plain hostname", () => {
    expect(() => hostUrlPattern("a.com/*")).toThrow();
    expect(() => hostUrlPattern("{x}")).toThrow();
  });
});
