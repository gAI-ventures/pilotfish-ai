import { describe, expect, it } from "vitest";
import { buildTools, DEFAULT_TOOLS, MAX_STRICT_OPTIONAL, optionalParams, ToolInputs } from "./tools.js";
import { SecretBroker } from "./secrets.js";
import { DefaultPolicy, isPrivateHost, parseMoney, totalFromText, type PreApproval } from "./policy.js";
import { hostMatches, InterruptionStats, neverAutomate } from "./interventions.js";
import { dateTaken, missingPage, nearMisses, proseAnswer, StallTracker, STOPPED_BY, taskLanguage } from "./agent.js";
import { challengePolicy, DEFAULT_CHALLENGE_POLICY, vendorClearMs } from "./challenge-policy.js";
import type { Snapshot, SnapNode } from "@pilotfish/perception";

/** Evidence of an action for the stall tracker: where it went and what it set. */
const ev = (from: string, to: string, values: Array<[string, string]> = [], states: string[] = []) => ({
  urlBefore: from,
  urlAfter: to,
  navigated: from !== to,
  valueChanges: values.map(([ref, v]) => ({ ref, description: ref, from: "", to: v })),
  stateChanges: states,
});

describe("stall rules", () => {
  const form = "https://shop.test/checkout";
  it("a form filled field by field on one URL is not a loop", () => {
    const t = new StallTracker();
    for (let i = 1; i <= 8; i++) {
      t.record(`type e${i}`, form, ev(form, form, [[`e${i}`, `value ${i}`]]));
      expect(t.sameUrlLoop()).toBe(false);
    }
  });

  it("clicks on the same two controls with no new state are a loop", () => {
    const t = new StallTracker();
    for (const ref of ["e1", "e2", "e1", "e2"]) t.record(`click ${ref}`, form, ev(form, form));
    expect(t.sameUrlLoop()).toBe(true);
    // Four different controls that change nothing are a loop too...
    const u = new StallTracker();
    for (const ref of ["e1", "e2", "e3", "e4"]) u.record(`click ${ref}`, form, ev(form, form));
    expect(u.sameUrlLoop()).toBe(true);
    // ...but four filters ticked one after another are progress.
    const v = new StallTracker();
    for (const ref of ["e1", "e2", "e3", "e4"]) v.record(`click ${ref}`, form, ev(form, form, [], [`${ref} checked: false → true`]));
    expect(v.sameUrlLoop()).toBe(false);
    // Ticking one off and on again sets nothing new the second time.
    const w = new StallTracker();
    for (const s of ["false → true", "true → false", "false → true", "true → false"]) w.record("click e5", form, ev(form, form, [], [`e5 checked: ${s}`]));
    expect(w.sameUrlLoop()).toBe(true);
  });

  it("replays T5: a productive form fill ending in a late-committing submit does not stall", () => {
    // T5 (30 Oct) flagged "stall (loop)" at the end of a form fill: the submit's URL was read before
    // its navigation committed. Now each action is recorded with the URL its evidence settled on.
    const t = new StallTracker();
    t.record("navigate", "https://stays.test/", ev("about:blank", "https://stays.test/"));
    t.record("type e4", "https://stays.test/", ev("https://stays.test/", "https://stays.test/", [["e4", "Goa"]]));
    t.record("click e9", "https://stays.test/", ev("https://stays.test/", "https://stays.test/", [], ["e9 selected: false → true"]));
    t.record("type e12", "https://stays.test/", ev("https://stays.test/", "https://stays.test/", [["e12", "2"]]));
    expect(t.sameUrlLoop()).toBe(false);
    // The submit committed late: its evidence shows the results URL, and the window starts over.
    t.record("click e15", "https://stays.test/search?ss=Goa", ev("https://stays.test/", "https://stays.test/search?ss=Goa"));
    t.record("click e3", "https://stays.test/search?ss=Goa", ev("https://stays.test/search?ss=Goa", "https://stays.test/search?ss=Goa", [], ["e3 checked: false → true"]));
    expect(t.sameUrlLoop()).toBe(false);
    expect(t.progressed(8)).toBe(true);
  });

  it("replays T4: moving between pages at the budget mark is progress; eight steps that go nowhere are not", () => {
    // T4 (30 Oct) climbed to Opus 6 ms after step 24 while moving between /lx-sedan-4d and /options.
    const t = new StallTracker();
    const pages = ["https://cars.test/lexus/es/2024/", "https://cars.test/lexus/es/2024/lx-sedan-4d/", "https://cars.test/lexus/es/2024/options/"];
    for (let i = 0; i < 16; i++) t.record(i % 3 ? "get_text" : "navigate", pages[Math.min(2, Math.floor(i / 6))]!, i % 3 ? undefined : ev(pages[0]!, pages[Math.min(2, Math.floor(i / 6))]!));
    expect(t.progressed(8)).toBe(true);
    // Eight reads and clicks on pages already seen, with no value set and no note: a stall.
    const stuck = new StallTracker();
    stuck.record("navigate", pages[0]!, ev("about:blank", pages[0]!));
    for (let i = 0; i < 8; i++) stuck.record(i % 2 ? "read_page" : "click e7", pages[0]!, i % 2 ? undefined : ev(pages[0]!, pages[0]!));
    expect(stuck.progressed(8)).toBe(false);
    // A note in the window is progress.
    expect(stuck.progressed(8, 1)).toBe(true);
  });
});

describe("prose answers", () => {
  const answer = "The cheapest 2-guest stay in Goa is Sea Breeze Villa at $82 a night, rated 4.6.";
  it("takes a prose final answer as done only after acting, without a question or an open gate", () => {
    expect(proseAnswer(answer, { steps: 3, gated: false, task: "find a stay" })).toBe(true);
    expect(proseAnswer(answer, { steps: 0, gated: false, task: "find a stay" })).toBe(false);
    expect(proseAnswer("Which city did you mean, Goa in India or Goa in the Philippines?", { steps: 3, gated: false, task: "find a stay" })).toBe(false);
    expect(proseAnswer(answer, { steps: 3, gated: true, task: "find a stay" })).toBe(false);
    expect(proseAnswer("Done.", { steps: 3, gated: false, task: "find a stay" })).toBe(false);
    expect(proseAnswer(answer, { steps: 3, gated: false, task: "return the stays as JSON" })).toBe(false);
  });

  it("narration that announces the next step is not an answer", () => {
    for (const t of [
      "I applied the RTX 5080 filter. Next I will sort the results by price, low to high.",
      "The filter is set. Next, I'll open the first result to read its price.",
      "Let me scroll down to see the rest of the listings on this page.",
      "Now I need to pick the check-in date in the calendar widget.",
      "I'm going to open the reviews tab to read the rating details.",
      "The page shows these options for the room type, which are listed below:",
    ]) {
      expect(proseAnswer(t, { steps: 3, gated: false, task: "find the cheapest card" }), t).toBe(false);
    }
    // An answer that closes politely, or sums up what was done, is still an answer.
    expect(proseAnswer("The cheapest RTX 5080 is the Zotac Solid at $999.99. Let me know if you need more.", { steps: 3, gated: false, task: "find it" })).toBe(true);
    expect(proseAnswer("I searched for RTX 5080, then I applied the In stock filter; the cheapest is the Zotac Solid at $999.99.", { steps: 3, gated: false, task: "find it" })).toBe(true);
  });
});

describe("tool feedback", () => {
  it("a 404 or 410, or an error path with a matching title, is a page that does not exist; text alone is not", () => {
    expect(missingPage(404, "https://kbb.test/lexus/es/2024/", "Lexus ES")).toBe(true);
    expect(missingPage(410, "https://kbb.test/a", "")).toBe(true);
    expect(missingPage(200, "https://kbb.test/error404/", "Page Not Found | KBB")).toBe(true);
    expect(missingPage(undefined, "https://kbb.test/not-found", "404 - not found")).toBe(true);
    // A results page that says "not found" in its text (or even its title) is a page.
    expect(missingPage(200, "https://shop.test/search?q=widgets", "Results: 0 items not found")).toBe(false);
    expect(missingPage(200, "https://shop.test/error404/", "Shop")).toBe(false);
  });

  it("a 404 that renders a real page (an SPA's 404 fallback, an empty search) is a page; one that says so or shows nothing is not", () => {
    const app = `Dashboard Projects Settings ${"Project Alpha updated 2 hours ago by Jane. ".repeat(20)}`;
    expect(missingPage(404, "https://app.github.io/projects/alpha", "Alpha · Projects", app)).toBe(false);
    expect(missingPage(404, "https://shop.test/search?q=zzzz", "Search", `Shop Home Deals Help ${"We couldn't find any results for zzzz. Try a different search. ".repeat(10)}`)).toBe(false);
    expect(missingPage(404, "https://kbb.test/lexus/es/2024/", "Lexus ES", `Kelley Blue Book Cars for sale ${"Sorry, we can't find that page. ".repeat(20)}`)).toBe(true);
    expect(missingPage(404, "https://kbb.test/lexus/es/2024/", "Page Not Found", app)).toBe(true);
    expect(missingPage(404, "https://kbb.test/lexus/es/2024/", "Lexus ES", "Kelley Blue Book")).toBe(true);
    expect(missingPage(404, "https://kbb.test/error404/", "Lexus ES", app)).toBe(true);
    expect(missingPage(410, "https://kbb.test/a", "Gone", app)).toBe(true);
  });

  it("ranks the closest labels for a find with no exact hit", () => {
    const node = (ref: string, role: string, name: string): SnapNode => ({ ref, role, name, tag: role === "link" ? "a" : role === "checkbox" ? "input" : "button", attrs: {}, visible: true, children: [] }) as unknown as SnapNode;
    const nodes = [node("e1", "button", "Sign in"), node("e2", "checkbox", "Ships today"), node("e3", "link", "Shipping & returns"), node("e4", "checkbox", "Free shipping"), node("e5", "button", "Get it by tomorrow")];
    const snap = { nodes } as unknown as Snapshot;
    const near = nearMisses(snap, "Shipping - get it today checkbox");
    expect(near.map((n) => n.ref)).toContain("e4");
    expect(near.map((n) => n.ref)).toContain("e5");
    expect(near.map((n) => n.ref)).not.toContain("e1");
    expect(near.length).toBeLessThanOrEqual(5);
    expect(nearMisses(snap, "zzz qqq")).toEqual([]);
  });
});

describe("challenge watch windows", () => {
  it("gives each vendor its own watch window", () => {
    const p = challengePolicy({ env: {} }).base;
    expect(vendorClearMs(p, "cloudflare")).toBe(12_000);
    expect(vendorClearMs(p, "human")).toBe(20_000);
    expect(vendorClearMs(p, "datadome")).toBe(6_000);
    expect(vendorClearMs(p, "recaptcha")).toBe(DEFAULT_CHALLENGE_POLICY.autoClearMs);
    expect(vendorClearMs(p, undefined)).toBe(8_000);
    expect(vendorClearMs(challengePolicy({ env: { PILOTFISH_CHALLENGE_HUMAN_CLEAR_MS: "5000" } }).base, "human")).toBe(5_000);
  });
});

describe("InterruptionStats", () => {
  const ev = (host: string, category: string, handled: string, waitedMs?: number) => ({ type: "interruption", host, category, handled, ...(waitedMs !== undefined ? { waitedMs } : {}) });
  const site = (h: string) => h.split(".").slice(-2).join(".");
  it("gives challenge rate, profile skip rate and time to resume per site", () => {
    const s = new InterruptionStats(site);
    // Run 1, no profile: a CAPTCHA on www.shop.test handed off and resolved in 8 s.
    s.observe(ev("www.shop.test", "captcha", "asked"));
    s.observe(ev("www.shop.test", "captcha", "resolved", 8_000));
    s.endRun(["www.shop.test", "cdn.other.test"]);
    // Run 2, with a profile: no challenge.
    s.endRun(["shop.test"], (x) => x === "shop.test");
    // Run 3, with a profile: a bot check that cleared by itself.
    s.observe(ev("shop.test", "bot_challenge", "auto_cleared", 2_000));
    s.endRun(["shop.test"], () => true);
    // Run 4: handed off, declined.
    s.observe(ev("shop.test", "captcha", "asked"));
    s.observe(ev("shop.test", "captcha", "unresolved", 30_000));
    s.endRun([]);
    const [shop, other] = s.summary();
    expect(shop).toMatchObject({ site: "shop.test", visits: 4, visitsWithProfile: 2, challengedVisits: 3, challengedVisitsWithProfile: 1, handedOff: 2, resolved: 1, unresolved: 1, autoCleared: 1, byCategory: { captcha: 2, bot_challenge: 1 } });
    expect(shop!.challengeRate).toBeCloseTo(0.75);
    expect(shop!.profileSkipRate).toBeCloseTo(0.5);
    expect(shop!.resumeP50Ms).toBe(8_000);
    expect(other).toMatchObject({ site: "other.test", visits: 1, challengedVisits: 0, profileSkipRate: null, resumeP50Ms: null });
  });
  it("ignores events without a host and non-interruption events", () => {
    const s = new InterruptionStats();
    s.observe({ type: "usage" });
    s.observe({ type: "interruption", category: "captcha", handled: "asked" });
    s.endRun([]);
    expect(s.summary()).toEqual([]);
  });
});

describe("tool schemas", () => {
  it("builds sorted schemas with closed objects and optional fields left optional, strict for the main tools", () => {
    const tools = buildTools(DEFAULT_TOOLS);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    for (const t of tools) {
      if (["click", "type", "navigate", "done", "find"].includes(t.name)) expect(t.strict).toBe(true);
      const schema = t.input_schema as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
    }
    const click = tools.find((t) => t.name === "click")!.input_schema as { properties: Record<string, { type?: unknown; enum?: unknown[] }>; required: string[] };
    expect(click.required).toEqual(["ref"]);
    expect(click.properties["button"]!.enum).toEqual(["left", "right", "middle"]);
    expect(click.properties["button"]!.type).toBe("string");
  });

  it("validates refs", () => {
    expect(ToolInputs.click.safeParse({ ref: "e12" }).success).toBe(true);
    expect(ToolInputs.click.safeParse({ ref: "f2e7" }).success).toBe(true);
    expect(ToolInputs.click.safeParse({ ref: "12" }).success).toBe(false);
    expect(ToolInputs.click.safeParse({ ref: "button" }).success).toBe(false);
  });
});

describe("strict tools", () => {
  it("never marks more than 20 tools strict (the API rejects more), even with every tool enabled", () => {
    const all = buildTools(new Set(Object.keys(ToolInputs) as Array<keyof typeof ToolInputs>));
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((t) => t.strict).length).toBe(20);
    expect(all.find((t) => t.name === "click")!.strict).toBe(true);
  });

  it("keeps the strict tools' optional parameters within the API's 24 (6 Nov: 25 failed every call of a Claude-model run)", () => {
    for (const set of [DEFAULT_TOOLS, new Set(Object.keys(ToolInputs) as Array<keyof typeof ToolInputs>)]) {
      const tools = buildTools(set);
      const optional = tools.filter((t) => t.strict).reduce((n, t) => n + optionalParams(t.input_schema), 0);
      expect(optional).toBeLessThanOrEqual(MAX_STRICT_OPTIONAL);
      // The main tools and the sign-in question stay strict; a rarely used one with many options gives way.
      for (const name of ["click", "type", "navigate", "done", "ask_user"]) expect(tools.find((t) => t.name === name)?.strict, name).toBe(true);
    }
  });
});

describe("SecretBroker", () => {
  it("substitutes placeholders only on allowed hosts and scrubs values", () => {
    const b = new SecretBroker({ pw: { value: "s3cret-value", allowedHosts: ["*.example.com"] }, token: "tok-123456" });
    expect(b.substitute("{{pw}}", "login.example.com").text).toBe("s3cret-value");
    expect(() => b.substitute("{{pw}}", "evil.com")).toThrow(/not allowed/);
    expect(b.substitute("{{unknown}}", "x.com").text).toBe("{{unknown}}");
    expect(b.scrub("page says s3cret-value and tok-123456")).toBe("page says {{pw}} and {{token}}");
    expect(b.auditLog().length).toBe(2);
  });
});

describe("DefaultPolicy", () => {
  const policy = new DefaultPolicy({ allowedHosts: ["*.shop.test", "shop.test"] });
  it("blocks private networks and non-allowlisted hosts", () => {
    expect(policy.check({ tool: "navigate", input: { url: "http://169.254.169.254/latest" }, url: "", task: "" })).toMatchObject({ kind: "deny" });
    expect(policy.check({ tool: "navigate", input: { url: "https://evil.test/" }, url: "", task: "" })).toMatchObject({ kind: "deny" });
    expect(policy.check({ tool: "navigate", input: { url: "https://www.shop.test/cart" }, url: "", task: "" })).toEqual({ kind: "allow" });
    expect(policy.check({ tool: "navigate", input: { url: "file:///etc/passwd" }, url: "", task: "" })).toMatchObject({ kind: "deny" });
  });
  it("refuses to act on a page outside the allowed hosts, but lets the agent navigate back", () => {
    expect(policy.check({ tool: "click", input: { ref: "e1" }, url: "https://evil.test/login", task: "", target: "[e1]<button>Next</button>" })).toMatchObject({ kind: "deny" });
    expect(policy.check({ tool: "type", input: { ref: "e1", text: "x" }, url: "https://evil.test/", task: "" })).toMatchObject({ kind: "deny" });
    expect(policy.check({ tool: "navigate", input: { url: "https://shop.test/" }, url: "https://evil.test/", task: "" })).toEqual({ kind: "allow" });
    expect(policy.check({ tool: "click", input: { ref: "e1" }, url: "https://www.shop.test/", task: "", target: "[e1]<button>Next</button>" })).toEqual({ kind: "allow" });
    expect(policy.check({ tool: "press", input: { key: "Space" }, url: "https://shop.test/", task: "", target: 'Enter; activates the focused button: "Place order"' })).toMatchObject({ kind: "confirm" });
  });
  it("treats filter, sort and menu controls as reversible even when their label reads like a payment", () => {
    expect(policy.check({ tool: "click", input: { ref: "e12" }, url: "https://shop.test/jobs", task: "", target: '[e12]<button type="button" id="salaryType_filter_button">Pay</button>' })).toEqual({ kind: "allow" });
    expect(policy.check({ tool: "click", input: { ref: "e3" }, url: "https://shop.test/", task: "", target: '[e3]<button aria-haspopup="menu">Share</button>' })).toEqual({ kind: "allow" });
    expect(policy.check({ tool: "click", input: { ref: "e9" }, url: "https://shop.test/checkout", task: "", target: "[e9]<button>Pay $45.00</button>" })).toMatchObject({ kind: "confirm" });
  });
  it("asks for confirmation on irreversible-looking targets", () => {
    expect(policy.check({ tool: "click", input: { ref: "e1" }, url: "https://shop.test", task: "", target: '[e1]<button>Place order</button>' })).toMatchObject({ kind: "confirm" });
    expect(policy.check({ tool: "click", input: { ref: "e1" }, url: "https://shop.test", task: "", target: '[e1]<button>Next</button>' })).toEqual({ kind: "allow" });
  });
  it("lets a task pre-approve kinds of irreversible step, within an amount limit when one is set", async () => {
    const at = (preApproved: PreApproval | undefined, target: string, extra: { pageTotal?: () => Promise<ReturnType<typeof parseMoney>>; url?: string } = {}) =>
      new DefaultPolicy({ preApproved }).check({ tool: "click", input: { ref: "e1" }, url: extra.url ?? "https://shop.test/checkout", task: "", target, ...(extra.pageTotal ? { pageTotal: extra.pageTotal } : {}) });
    expect(await at(undefined, "[e1]<button>Place order</button>")).toMatchObject({ kind: "confirm", write: "pay" });
    expect(await at({ kinds: ["pay"] }, "[e1]<button>Place order</button>")).toEqual({ kind: "allow", note: "pre-approved pay" });
    expect(await at({ kinds: ["pay"] }, "[e1]<button>Delete account</button>")).toMatchObject({ kind: "confirm", write: "delete" });
    expect(await at({ kinds: ["send"], hosts: ["mail.test"] }, "[e1]<button>Send</button>")).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/does not cover shop\.test/) });
    // The amount on the button decides; then the page's total; unreadable or over the limit asks.
    expect(await at({ kinds: ["pay"], maxAmount: 50, currency: "USD" }, "[e1]<button>Pay $45.00</button>")).toMatchObject({ kind: "allow" });
    expect(await at({ kinds: ["pay"], maxAmount: 40, currency: "USD" }, "[e1]<button>Pay $45.00</button>")).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/over the pre-approved 40 USD/) });
    expect(await at({ kinds: ["pay"], maxAmount: 5000, currency: "USD" }, "[e1]<button>Pay ₹1,299</button>")).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/not in USD/) });
    expect(await at({ kinds: ["pay"], maxAmount: 50 }, "[e1]<button>Place order</button>", { pageTotal: async () => ({ value: 45, currency: "USD", text: "$45.00" }) })).toMatchObject({ kind: "allow" });
    expect(await at({ kinds: ["pay"], maxAmount: 50 }, "[e1]<button>Place order</button>", { pageTotal: async () => null })).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/could not be read/) });
  });
  it("reads money and checkout totals the way shops write them", () => {
    expect(parseMoney("Pay ₹1,23,456.50 now")).toEqual({ value: 123456.5, currency: "INR", text: "₹1,23,456.50" });
    expect(parseMoney("Total 45 EUR")).toMatchObject({ value: 45, currency: "EUR" });
    expect(parseMoney("Rs. 1,299")).toMatchObject({ value: 1299, currency: "INR" });
    expect(parseMoney("$5.00 off, pay $40.00")).toMatchObject({ value: 40, currency: "USD" });
    expect(parseMoney("Place order")).toBeNull();
    expect(totalFromText("Subtotal $40.00\nShipping $5.00\nOrder total\n$45.00\nTotal savings $3.00")).toMatchObject({ value: 45 });
    expect(totalFromText("Items 2\nTotal: £12.50")).toMatchObject({ value: 12.5, currency: "GBP" });
    expect(totalFromText("No prices here")).toBeNull();
  });
  it("knows the sites pilotfish never automates, plus the caller's own", () => {
    expect(neverAutomate("shop.test")).toBe(false);
    expect(neverAutomate("www.ticketmaster.com")).toBe(true);
    expect(neverAutomate("ticketmaster.com")).toBe(true);
    expect(neverAutomate("myaadhaar.uidai.gov.in")).toBe(true);
    expect(neverAutomate("notticketmaster.com")).toBe(false);
    expect(neverAutomate("shop.test", ["*.shop.test"])).toBe(true);
    expect(hostMatches("a.b.shop.test", "*.shop.test")).toBe(true);
    expect(hostMatches("SHOP.test", "shop.TEST")).toBe(true);
  });
  it("classifies private hosts", () => {
    // 172.31.255.255 is the last address of 172.16.0.0/12; 198.51.100.1 (a documentation address) is public to the classifier.
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "[::1]", "foo.internal"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "198.51.100.1"]) expect(isPrivateHost(h)).toBe(false);
  });
});

describe("a real user's flight session (23-24 Nov): dates the site rewrote, the task's language, giving up early", () => {
  it("a typed date the field took and wrote its own way counts as filled; another date does not", () => {
    expect(dateTaken("Dec 27, 2026", "CN, 27 thg 12")).toBe(true);
    expect(dateTaken("Dec 27, 2026", "Sun, Dec 27")).toBe(true);
    expect(dateTaken("2026-12-08", "Tue, Dec 8")).toBe(true);
    expect(dateTaken("27/12/2026", "So., 27. Dez.")).toBe(true);
    expect(dateTaken("12/01/2026", "Thứ 3, 1 thg 12")).toBe(true);
    expect(dateTaken("Dec 12, 2026", "12月12日")).toBe(true);
    expect(dateTaken("Dec 27, 2026", "CN, 20 thg 12")).toBe(false);
    expect(dateTaken("Dec 27, 2026", "Sun, Nov 27")).toBe(false);
    expect(dateTaken("Hanoi", "Hà Nội")).toBe(false);
  });

  it("reads an English task from the person's words before the harness's own lines", () => {
    expect(taskLanguage("TASK:\nFind the cheapest round trip from Hanoi to Ho Chi Minh City in December for me\nTODAY: Tuesday")).toBe("en");
    expect(taskLanguage("Tìm vé máy bay khứ hồi rẻ nhất từ Hà Nội đến Thành phố Hồ Chí Minh vào tháng 12\nPLAN (a guide):\n1. Open the site and find the cheapest one")).toBeNull();
    expect(taskLanguage("Book it")).toBeNull();
  });

  it("a result that names what stopped it is taken; one that only says it could not finish is not", () => {
    expect(STOPPED_BY.test("The site asks me to sign in before it shows prices.")).toBe(true);
    expect(STOPPED_BY.test("Google Flights showed “Oops, something went wrong” after Reload.")).toBe(true);
    expect(STOPPED_BY.test("The page says it is not available in your country or region.")).toBe(true);
    // Something only the person can give (24 Nov: the delivery area asked and not answered).
    expect(STOPPED_BY.test("Please share the delivery address or area to check the prices on Zomato.")).toBe(true);
    expect(STOPPED_BY.test("I need your delivery area before I can check prices.")).toBe(true);
    expect(STOPPED_BY.test("I could not complete a reliable comparison of the 10 date pairs or verify three cheapest options. No booking or payment was made.")).toBe(false);
    expect(STOPPED_BY.test("no flight results with specific times were reached")).toBe(false);
  });
});
