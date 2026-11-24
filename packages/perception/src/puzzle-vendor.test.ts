// A check read from its words alone is named by where its puzzle loaded from (`vendorByResources`, `resourceHosts`).
import { describe, expect, it } from "vitest";
import { vendorByResources } from "./interrupts.js";

describe("vendorByResources", () => {
  it("names the service whose puzzle the page loaded", () => {
    expect(vendorByResources(["www.example.in", "ait.119ea3f1.eu-west-1.captcha.awswaf.com", "static.captcha.awswaf.com"])).toEqual({ vendor: "aws-waf", host: "ait.119ea3f1.eu-west-1.captcha.awswaf.com" });
    expect(vendorByResources(["client-api.arkoselabs.com"])?.vendor).toBe("arkose");
    expect(vendorByResources(["js.hcaptcha.com"])?.vendor).toBe("hcaptcha");
  });

  it("not from a silent token or an invisible score, and not when two services loaded", () => {
    expect(vendorByResources(["1c5c1ecf7303.e10058c8.ap-south-1.token.awswaf.com", "www.google.com", "www.gstatic.com"])).toBeNull();
    expect(vendorByResources(["ait.x.captcha.awswaf.com", "client-api.arkoselabs.com"])).toBeNull();
    expect(vendorByResources([])).toBeNull();
  });
});
