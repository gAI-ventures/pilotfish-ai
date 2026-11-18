import { describe, expect, it } from "vitest";
import { pdfNameOf } from "./files.js";

describe("pdfNameOf", () => {
  it("names a viewer PDF after its address", () => {
    expect(pdfNameOf("https://www.irs.gov/pub/irs-pdf/fw8bene.pdf")).toBe("fw8bene.pdf");
    expect(pdfNameOf("https://bank.example/statements/2026-10?format=pdf")).toBe("2026-10.pdf");
    expect(pdfNameOf("https://x.example/docs/Annual%20Report%202025.PDF")).toBe("Annual Report 2025.PDF");
  });

  it("falls back to document.pdf when the address has no usable name", () => {
    expect(pdfNameOf("https://x.example/")).toBe("document.pdf");
    expect(pdfNameOf("not a url")).toBe("document.pdf");
    expect(pdfNameOf("https://x.example/%E2%9C%93")).toBe("document.pdf");
  });
});
