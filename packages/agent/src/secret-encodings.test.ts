import { describe, expect, it } from "vitest";
import { SecretBroker } from "./secrets.js";

describe("bounded transformed-secret masking", () => {
  const value = 'Token+Slash/Quote"Back\\Line\nCafeé-123🙂';
  const forms = (v: string) => [Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), JSON.stringify(v).slice(1, -1), v.split("").map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("")];
  it.each(forms(value))("masks common reversible representation %s", (form) => {
    const b = new SecretBroker({ token: { value } });
    expect(b.scrub(`echo ${form} end`)).toBe("echo {{token}} end");
  });
  it("keeps encoded masks after a value is hidden/retired", () => {
    const b = new SecretBroker(); b.hide("token", value);
    for (const form of forms(value)) expect(b.scrub(form)).toBe("{{token}}");
  });
  it("does not treat case folding or arbitrary hashes as reversible encodings", () => {
    const b = new SecretBroker({ token: { value: "aBc" } });
    expect(b.scrub("ABC abc unrelated")).toBe("ABC abc unrelated");
  });
});
