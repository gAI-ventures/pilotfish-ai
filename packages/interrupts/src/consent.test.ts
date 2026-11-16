// Privacy invariants of the consent engine that hold without a browser.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { evalSnippets } from "@duckduckgo/autoconsent";
import { ConsentEngine, OPT_IN_SNIPPETS } from "./consent.js";

const require = createRequire(import.meta.url);

describe("consent engine invariants", () => {
  it("always opts out, with the heuristic in reject-only mode", () => {
    const config = (new ConsentEngine() as unknown as { config: { autoAction: string; heuristicMode: string } }).config;
    expect(config.autoAction).toBe("optOut");
    expect(config.heuristicMode).toBe("reject");
    const off = (new ConsentEngine({ heuristics: false }) as unknown as { config: { heuristicMode: string } }).config;
    expect(off.heuristicMode).toBe("off");
  });

  it("ships rules in the compact encoding, which has no opt-in steps", () => {
    const compact = readFileSync(require.resolve("@duckduckgo/autoconsent/rules/compact-rules.json"), "utf8");
    expect(compact).not.toMatch(/"optIn"/);
  });

  it("refuses every eval snippet that accepts consent", () => {
    const accepting = /acceptAll|AcceptAll|allowAll|AllowAll|setConsent['"]?,\s*1|\(['"]save['"]\)/;
    const found = Object.entries(evalSnippets).filter(([, fn]) => accepting.test(String(fn))).map(([id]) => id);
    expect(found.length).toBeGreaterThan(0);
    for (const id of found) expect(OPT_IN_SNIPPETS.has(id), id).toBe(true);
    for (const id of ["EVAL_USERCENTRICS_API_3", "EVAL_CONSENTMANAGER_4", "EVAL_CONSENTMANAGER_NCMP_ACCEPT"]) expect(OPT_IN_SNIPPETS.has(id)).toBe(true);
  });

  it("reports errors to listeners and never throws them when nobody listens", () => {
    const engine = new ConsentEngine();
    const emit = (engine as unknown as { emit: (e: string, p: unknown) => void }).emit.bind(engine);
    expect(() => emit("error", { error: "arm: timed out" })).not.toThrow();
    const seen: unknown[] = [];
    engine.on("error", (e) => seen.push(e));
    emit("error", { error: "arm: timed out" });
    expect(seen).toHaveLength(1);
  });

  it("allows the opt-out snippets", () => {
    for (const id of ["EVAL_COOKIEBOT_3", "EVAL_CONSENTMANAGER_3", "EVAL_USERCENTRICS_API_2", "EVAL_DIDOMI_OPT_OUT"]) expect(OPT_IN_SNIPPETS.has(id), id).toBe(false);
  });
});
