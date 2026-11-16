import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Request } from "@ghostery/adblocker";
import { abpPathPattern, buildEngine, deriveTierA, loadLists, UPSTREAM_LISTS } from "./lists.js";

const blocks = (engine: ReturnType<typeof buildEngine>, url: string, type = "script") =>
  engine.match(Request.fromRawDetails({ url, sourceUrl: "https://news.example/", type: type as never })).match;

describe("buildEngine", () => {
  const engine = buildEngine(
    [
      "||ads.example^",
      "||cdn.cookielaw.org^",
      "/cookieconsent.min.js",
      "||tinypass.com^",
      "||js.stripe.com^",
      "##.ad-slot",
      "##.cookie-banner",
      "###onetrust-banner-sdk",
      "##.paywall-overlay",
      "news.example##+js(set-constant, x, 1)",
    ].join("\n"),
  );

  it("keeps ordinary ad rules", () => {
    expect(blocks(engine, "https://ads.example/x.js")).toBe(true);
    const css = engine.getCosmeticsFilters({ url: "https://news.example/", hostname: "news.example", domain: "news.example", classes: ["ad-slot", "cookie-banner", "paywall-overlay"], ids: ["onetrust-banner-sdk"], hrefs: [], getBaseRules: false, getRulesFromDOM: true, getRulesFromHostname: true });
    expect(css.styles).toContain(".ad-slot");
    // Consent banners must stay visible to autoconsent; paywalls are never hidden.
    expect(css.styles).not.toMatch(/cookie-banner|onetrust|paywall/);
    expect(css.scripts).toEqual([]);
  });

  it("strips rules that would stop a consent manager, a paywall or a payment provider loading", () => {
    expect(blocks(engine, "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js")).toBe(false);
    expect(blocks(engine, "https://example.org/js/cookieconsent.min.js")).toBe(false);
    expect(blocks(engine, "https://experience.tinypass.com/x.js")).toBe(false);
    expect(blocks(engine, "https://js.stripe.com/v3/")).toBe(false);
  });
});

describe("deriveTierA", () => {
  const text = [
    "||popular.example^$third-party",
    "||popular.example/path/ads.js", // rules targeting a domain raise its prevalence score
    "||cdn.popular.example/pixel.gif",
    "||popular.example^$script,domain=a.example|b.example",
    "@@||popular.example/ok.js$domain=good.example",
    "||rare-123abc.com^",
    "||typed.example^$script", // typed: not whole-host
    "||scoped.example^$domain=site.example", // site-scoped: not whole-host
    "||accounts.google.com^", // protected
    "||withsub.example^",
    "@@||safe.withsub.example^", // generic exception below a blocked host -> allow entry
    "@@||withsub.example/widget/*.js^$script", // generic path exception -> path allow entry
    "@@||withsub.example/x.js$redirect-rule", // cancels a surrogate only: unblocks nothing
    "||excepted.example^",
    "@@||excepted.example^", // generic exception at the host -> not in Tier A
    "||surrogate.example^",
    "||surrogate.example/tag.js$script,redirect=noopjs", // surrogate URL -> allowed through Tier A
    "||wild.example^",
    "||wild.example^*/x.js$script,redirect=noopjs", // surrogate for an unexpressible URL set -> Tier B only
    "||bad.example^",
    "||bad.example^$badfilter",
    "||a.split.example^",
    "||b.split.example^",
    "||cdn.split.example^",
    "||split.example^", // domain-level rule supersedes subdomain rules
  ].join("\n");
  const t = deriveTierA(text);

  it("keeps whole-host rules and drops typed, scoped, protected, excepted and badfiltered ones", () => {
    expect(new Set(t.hosts)).toEqual(new Set(["popular.example", "rare-123abc.com", "withsub.example", "surrogate.example", "split.example"]));
  });

  it("ranks by prevalence", () => {
    expect(t.hosts[0]).toBe("popular.example");
  });

  it("turns exceptions and surrogate URLs into allow entries", () => {
    expect(t.allow).toEqual(
      expect.arrayContaining([
        { host: "withsub.example", pattern: "*://{*.}?safe.withsub.example:*/*" },
        { host: "withsub.example", pattern: "*://{*.}?withsub.example:*/widget/*.js*" },
        { host: "surrogate.example", pattern: "*://{*.}?surrogate.example:*/tag.js*" },
      ]),
    );
    expect(t.allow).toHaveLength(3);
    expect(t.siteAllow["good.example"]).toEqual(["popular.example"]);
    // `$third-party` rules do not apply on their own site.
    expect(t.siteAllow["popular.example"]).toEqual(["popular.example"]);
  });

  it("caps the list", () => {
    expect(deriveTierA(text, 2).hosts).toHaveLength(2);
  });

  it("converts ABP paths to URLPattern prefixes that are never narrower", () => {
    expect(abpPathPattern("/tag/js/gpt.js")).toBe("/tag/js/gpt.js*");
    expect(abpPathPattern("/a/*.js^")).toBe("/a/*.js*");
    expect(abpPathPattern("/ads.js?v=1")).toBe("/ads.js*");
    expect(abpPathPattern("/c2/plugin(x).js")).toBe("/c2/plugin\\(x\\).js*");
    expect(abpPathPattern("^*/x.js")).toBeNull();
    expect(abpPathPattern("/{weird}")).toBeNull();
  });
});

describe("loadLists fallback order", () => {
  const offline = () => Promise.reject(new Error("offline"));

  it("uses upstream lists, resolves !#include, and caches the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-adblock-"));
    try {
      const seen: string[] = [];
      const fetchText = async (url: string) => {
        seen.push(url);
        if (url.endsWith("/filters.txt")) return "!#include filters-2024.txt\n||main.example^";
        if (url.endsWith("/filters-2024.txt")) return "||included.example^";
        if (url.includes("resources")) throw new Error("HTTP 404");
        return "||upstream.example^";
      };
      const first = await loadLists({ cacheDir: dir, fetchText });
      expect(first.source).toBe("upstream");
      expect(first.tierA.hosts).toEqual(expect.arrayContaining(["upstream.example", "main.example", "included.example"]));
      expect(seen).toContain(UPSTREAM_LISTS[0]![0]);
      const second = await loadLists({ cacheDir: dir, fetchText: offline });
      expect(second.source).toBe("cache");
      expect(second.tierA.hosts).toEqual(first.tierA.hosts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the mirror, then a stale cache with a background refresh, then the seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-adblock-"));
    try {
      const mirrorOnly = async (url: string) => {
        if (url.includes("easylist.to") || url.includes("adblockplus.org") || url.includes("ublockorigin")) throw new Error("down");
        return "||mirror.example^";
      };
      expect((await loadLists({ cacheDir: dir, fetchText: mirrorOnly })).source).toBe("mirror");

      const refreshed = new Promise<unknown>((resolve) => {
        void loadLists({ cacheDir: dir, maxAgeMs: 0, fetchText: mirrorOnly, onRefresh: resolve }).then((r) => expect(r.source).toBe("stale-cache"));
      });
      expect(await refreshed).toHaveProperty("source", "mirror");

      const empty = mkdtempSync(join(tmpdir(), "pf-adblock-"));
      const seed = await loadLists({ cacheDir: empty, fetchText: offline });
      rmSync(empty, { recursive: true, force: true });
      expect(seed.source).toBe("seed");
      expect(seed.tierA.hosts).toContain("doubleclick.net");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
