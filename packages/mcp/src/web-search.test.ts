import { describe, expect, it } from "vitest";
import { formatHits, hostAllowed, searchEngineQuery, webSearch } from "./web-search.js";

type Call = { url: string; init: RequestInit };
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fetchFn, calls };
};

const hits = [
  { title: "Paintball Fun Cologne", url: "https://pastimes.de/locations/paintball", snippet: "# Paintball Fun Cologne\nINDOOR\n## Adresse\nBruckner Straße 99", published_at: "2026-11-16T00:42:49Z" },
  { title: "", url: "https://adrenalinpark.de/koeln-paintball", description: "Lasertag und Paintball" },
  { title: "A script", url: "javascript:alert(1)", snippet: "x" },
  { title: "Not a url", url: "nope", snippet: "x" },
];

describe("browser_search's web search (Keenable, no browser)", () => {
  it("asks the keyless endpoint with the app's name and no key, and lists the hits numbered, one line of snippet each", async () => {
    const { fetchFn, calls } = answer(200, { query: "q", results: hits });
    const r = await webSearch("paintball Cologne", { fetch: fetchFn });
    expect(calls[0]!.url).toBe("https://api.keenable.ai/v1/search/public");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Keenable-Title"]).toBe("pilotfish");
    expect(headers["X-API-Key"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: "paintball Cologne", max_results: 10, snippet_max_length: 500 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('SEARCH RESULTS for "paintball Cologne" (2;');
    expect(r.text).toContain("1. Paintball Fun Cologne (2026-11-16)\n   https://pastimes.de/locations/paintball\n   Paintball Fun Cologne INDOOR Adresse Bruckner Straße 99");
    expect(r.text).toContain("2. adrenalinpark.de\n   https://adrenalinpark.de/koeln-paintball\n   Lasertag und Paintball");
    expect(r.text).not.toContain("javascript:");
    expect(r.text).not.toMatch(/check a value|browser_navigate/);
  });

  it("a key goes to the keyed endpoint; a site and a count are passed on", async () => {
    const { fetchFn, calls } = answer(200, { results: [] });
    await webSearch("q", { fetch: fetchFn, apiKey: "keen_x", site: "en.wikipedia.org", maxResults: 3 });
    expect(calls[0]!.url).toBe("https://api.keenable.ai/v1/search");
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("keen_x");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ max_results: 3, site: "en.wikipedia.org" });
  });

  it("no hits is one line saying what to do", async () => {
    const { fetchFn } = answer(200, { results: [] });
    expect((await webSearch("zzz", { fetch: fetchFn })).text).toMatch(/^NO RESULTS for "zzz"\. Try other words/);
  });

  it("a limit, a refused key, a server error, an unreadable answer and no answer are failures that say what to do instead", async () => {
    const limited = await webSearch("q", { fetch: answer(429, {}, { "retry-after": "30" }).fetchFn });
    expect(limited).toEqual({ ok: false, text: expect.stringMatching(/^SEARCH LIMIT: .*about 30 s.*own search\. A KEENABLE_API_KEY/) });
    expect((await webSearch("q", { fetch: answer(429, {}).fetchFn, apiKey: "k" })).text).not.toContain("KEENABLE_API_KEY");
    expect((await webSearch("q", { fetch: answer(401, {}).fetchFn, apiKey: "k" })).text).toMatch(/refused the key \(HTTP 401\)/);
    expect((await webSearch("q", { fetch: answer(503, {}).fetchFn })).text).toMatch(/^SEARCH FAILED: .*HTTP 503/);
    expect((await webSearch("q", { fetch: answer(200, "<html>").fetchFn })).text).toMatch(/could not be read/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await webSearch("q", { fetch: down })).toEqual({ ok: false, text: expect.stringMatching(/could not be reached/) });
    const slow = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as typeof fetch;
    expect((await webSearch("q", { fetch: slow, timeoutMs: 20 })).text).toMatch(/took too long/);
  });

  it("with allowed sites, only their results, and how many were left out", () => {
    const t = formatHits("q", hits, 8, ["*.example.com", "adrenalinpark.de"]);
    expect(t).toContain("1. adrenalinpark.de");
    expect(t).not.toContain("pastimes.de");
    expect(t).toContain("1 result outside the allowed sites left out.");
    expect(formatHits("q", hits.slice(0, 1), 8, ["example.com"])).toMatch(/^NO RESULTS for "q"\. 1 result outside/);
    expect(hostAllowed("de.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evil-example.com", ["*.example.com"])).toBe(false);
  });

  it("a long snippet is cut at a word, at most the count asked", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/`, snippet: "word ".repeat(200) }));
    const t = formatHits("q", many, 3);
    expect(t.match(/^\d+\. /gm)).toHaveLength(3);
    const line = t.split("\n").find((l) => l.startsWith("   word"))!;
    expect(line.length).toBeLessThanOrEqual(3 + 301);
    expect(line.endsWith("word…")).toBe(true);
  });
});

describe("searchEngineQuery: a search engine's own web results address", () => {
  it("reads the query from Google, Bing, DuckDuckGo, Brave, Yahoo and Ecosia web results", () => {
    expect(searchEngineQuery("https://www.google.com/search?q=a+b&hl=en")).toEqual({ host: "www.google.com", query: "a b" });
    expect(searchEngineQuery("https://www.google.co.uk/search?q=x&udm=14")?.query).toBe("x");
    expect(searchEngineQuery("https://www.bing.com/search?q=x")?.query).toBe("x");
    expect(searchEngineQuery("https://duckduckgo.com/?q=x&ia=web")?.query).toBe("x");
    expect(searchEngineQuery("https://html.duckduckgo.com/html/?q=x")?.query).toBe("x");
    expect(searchEngineQuery("https://search.brave.com/search?q=x")?.query).toBe("x");
    expect(searchEngineQuery("https://search.yahoo.com/search?p=x")?.query).toBe("x");
    expect(searchEngineQuery("https://www.ecosia.org/search?q=x")?.query).toBe("x");
  });
  it("leaves every other page alone: other tabs, Maps, Flights, a site's own search, no query", () => {
    for (const url of [
      "https://www.google.com/search?q=x&tbm=isch",
      "https://www.google.com/search?q=x&udm=2",
      "https://www.google.com/maps/search/gyms",
      "https://www.google.com/travel/flights?q=x",
      "https://www.google.com/",
      "https://www.google.com/search",
      "https://duckduckgo.com/about",
      "https://www.bing.com/maps?q=x",
      "https://shop.example/search?q=x",
      "https://scholar.google.com/scholar?q=x",
      "not a url",
    ])
      expect(searchEngineQuery(url)).toBeNull();
  });
});
