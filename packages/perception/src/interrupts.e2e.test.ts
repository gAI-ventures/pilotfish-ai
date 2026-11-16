// Interruption classifier e2e: real Chromium snapshots of local fixture pages
// (fixtures/interrupts/*.html), inputs gathered over CDP the way the agent will.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser, type Page } from "@pilotfish/browser";
import { captureSnapshot, classifyInterruption, explainResolution, gatherInterruptInput, trackMainResponse, type InterruptInput, type Interruption, type MainResponseTracker } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";
const FIXTURES = new URL("./fixtures/interrupts/", import.meta.url);

const LOREM = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>Paragraph ${i + 1}. The committee met on Tuesday to review the proposal, and residents spoke for and against the plan. ` +
      `Supporters said the new green space would give families somewhere to walk, while critics worried about the cost of upkeep and parking. ` +
      `<a href="/story/${i}">Read the related story</a> or <a href="/topic/${i}">follow this topic</a>.</p>`,
  ).join("\n");

const HEADERS: Record<string, Record<string, string>> = {
  "hard-block.html": { server: "cloudflare", "cf-ray": "8d3f1a2b3c4d5e6f-AMS" },
  "cf-challenge.html": { server: "cloudflare", "cf-mitigated": "challenge", "cf-ray": "8d3f1a2b3c4d5e6f-AMS" },
};
const STATUS: Record<string, number> = { "hard-block.html": 403, "cf-challenge.html": 403 };

describe.skipIf(!E2E)("interrupt classifier e2e", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let crossOrigin: string;
  let page: Page;
  let tracker: MainResponseTracker;
  const timings: number[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      const name = path.replace(/^\/fx\//, "");
      if (!path.startsWith("/fx/") || !/^[\w-]+\.html$/.test(name)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      let html: string;
      try {
        html = readFileSync(new URL(name, FIXTURES), "utf8");
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      html = html.replace(/<!--LOREM:(\d+)-->/g, (_, n: string) => LOREM(Number(n))).replace("{{ACS}}", `${crossOrigin}/fx/acs.html`);
      res.writeHead(STATUS[name] ?? 200, { "content-type": "text/html; charset=utf-8", ...(HEADERS[name] ?? {}) });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    crossOrigin = `http://localhost:${port}`; // different site -> out-of-process iframe
    browser = await launch({ headless: true });
    page = await browser.newPage();
    tracker = trackMainResponse(page);
  }, 60_000);

  afterAll(async () => {
    tracker?.dispose();
    await browser?.close();
    server?.close();
    if (timings.length) {
      // eslint-disable-next-line no-console
      console.log(`classifyInterruption: ${timings.length} pages, max ${Math.max(...timings).toFixed(2)} ms, mean ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(2)} ms`);
    }
  });

  async function load(name: string): Promise<{ input: InterruptInput; r: Interruption }> {
    await page.navigate(`${origin}/fx/${name}`);
    await page.settle();
    const snapshot = await captureSnapshot(page);
    const input = await gatherInterruptInput(page, { snapshot, tracker });
    const t0 = performance.now();
    const r = classifyInterruption(input);
    timings.push(performance.now() - t0);
    // eslint-disable-next-line no-console
    console.log(name.padEnd(24), JSON.stringify(r));
    return { input, r };
  }

  // ------------------------------------------------------------ positives

  it("login page -> blocking login", async () => {
    const { r } = await load("login.html");
    expect(r).toMatchObject({ category: "login", blocking: true, needs: "login_in_live_view" });
  });

  it("split 6-digit OTP -> otp with six refs, digits only, masked-phone hint", async () => {
    const { r } = await load("otp-split.html");
    expect(r).toMatchObject({ category: "otp", blocking: true, needs: "code" });
    expect(r.input?.length).toBe(6);
    expect(r.input?.digitsOnly).toBe(true);
    expect(r.input?.fieldRefs).toHaveLength(6);
    expect(r.input?.hint).toContain("•••1234");
  });

  it("autocomplete=one-time-code -> otp, length 6, authenticator app", async () => {
    const { r } = await load("otp-autocomplete.html");
    expect(r).toMatchObject({ category: "otp", blocking: true, needs: "code" });
    expect(r.input).toMatchObject({ kind: "code", length: 6, digitsOnly: true, hint: "authenticator app" });
    expect(r.input?.fieldRefs).toHaveLength(1);
  });

  it("push approval with number matching -> displayNumber", async () => {
    const { r } = await load("push-number.html");
    expect(r).toMatchObject({ category: "push_approval", blocking: true, needs: "approve_on_device", displayNumber: "42" });
  });

  it("magic link -> magic_link with masked-email hint", async () => {
    const { r } = await load("magic-link.html");
    expect(r).toMatchObject({ category: "magic_link", blocking: true, input: { kind: "link" } });
    expect(r.input?.hint).toContain("j•••@example.com");
  });

  it("Cloudflare 1020 block page (403) -> hard_block, none_possible", async () => {
    const { r, input } = await load("hard-block.html");
    expect(input.response?.status).toBe(403);
    expect(r).toMatchObject({ category: "hard_block", vendor: "cloudflare", blocking: true, needs: "none_possible" });
  });

  it("cf-mitigated header seen by the response tracker -> auto-resolvable bot challenge", async () => {
    const { r, input } = await load("cf-challenge.html");
    expect(input.response?.headers["cf-mitigated"]).toBe("challenge");
    expect(r).toMatchObject({ category: "bot_challenge", vendor: "cloudflare", blocking: true, autoResolvable: true });
  });

  it("3DS challenge in a cross-origin iframe with a code box -> payment_3ds needing a code", async () => {
    const { r, input } = await load("checkout-3ds.html");
    expect(input.frameUrls?.some((u) => u.startsWith(crossOrigin))).toBe(true);
    expect(r).toMatchObject({ category: "payment_3ds", blocking: true, needs: "code" });
    expect(r.input).toMatchObject({ kind: "code", length: 6, digitsOnly: true });
    expect(r.input?.fieldRefs?.[0]).toMatch(/^f\d+e\d+$/); // ref inside the OOPIF
    expect(r.input?.hint).toMatch(/ending in 4321/);
  });

  // ------------------------------------------------------------ negatives: zero false positives

  for (const [name, why] of [
    ["content-signin-link.html", "header Sign in link + hidden login modal"],
    ["newsletter.html", "newsletter email box"],
    ["search.html", "search box, ZIP, PIN code, promo code fields"],
    ["signup.html", "sign-up form with new-password"],
  ] as const) {
    it(`${name} (${why}) -> none`, async () => {
      const { r } = await load(name);
      expect(r.category).toBe("none");
      expect(r.blocking).toBe(false);
      expect(r.needs).toBe("nothing");
    });
  }

  it("sidebar login on a content page -> not blocking", async () => {
    const { r } = await load("sidebar-login.html");
    expect(r.blocking).toBe(false);
    expect(["none", "login"]).toContain(r.category);
  });

  // ------------------------------------------------------------ resume predicates

  it("login resolves after leaving the login page", async () => {
    const before = (await load("login.html")).input;
    const after = (await load("content-signin-link.html")).input;
    expect(explainResolution("login", before, before).resolved).toBe(false);
    expect(explainResolution("login", before, after).resolved).toBe(true);
  });

  it("otp resolves when the code form goes away", async () => {
    const before = (await load("otp-split.html")).input;
    await page.main.evaluate(`document.querySelector('main').innerHTML = '<h1>Welcome back</h1><p>You are signed in.</p>'`);
    const snapshot = await captureSnapshot(page);
    const after = await gatherInterruptInput(page, { snapshot, tracker });
    expect(explainResolution("otp", before, before).resolved).toBe(false);
    expect(explainResolution("otp", before, after).resolved).toBe(true);
  });

  it("bot challenge resolves after the clearance reload", async () => {
    const before = (await load("cf-challenge.html")).input;
    const after = (await load("content-signin-link.html")).input;
    const res = explainResolution("bot_challenge", before, after);
    expect(res.resolved).toBe(true);
    expect(res.signals.join(" ")).toMatch(/navigation|URL changed|new document/);
  });
});
