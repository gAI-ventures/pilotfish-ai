// v5 proofs on real pages (local server, real Chrome, no model): a commit Node hears of late is caught by the page's own
// account of its document; a sign-in under way and a question to the person are never decided with state from two
// documents (a page moving on during the cookie read, across hosts too); and a reading kept after looks that could not
// be verified is said as the last verified one. Each case has a control with no document change.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, siteOf, type Browser, type Page } from "@pilotfish/browser";
import { captureSnapshot } from "@pilotfish/perception";
import { Agent, type InterventionRequest, type StepEvent } from "./index.js";
import { readPage, responseTracker } from "./interventions.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES: Record<string, { status?: number; headers?: Record<string, string>; body: string }> = {
  "/a": { body: html("Page A", `<h1>Page A</h1><p>${"Lamps and chairs. ".repeat(20)}</p>`) },
  "/b": { body: html("Page B", `<h1>Page B</h1><p>${"Tables and shelves. ".repeat(20)}</p>`) },
  "/c": { body: html("Page C", `<h1>Page C</h1><p>${"Rugs and mirrors. ".repeat(20)}</p>`) },
  "/login": { body: html("Sign in", `<h1>Sign in</h1><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`) },
  "/dashboard": { headers: { "set-cookie": "sid=signed-in; Path=/" }, body: html("Dashboard", `<h1>Your orders</h1><p>${"Order 1042, shipped. ".repeat(10)}</p>`) },
  // HUMAN's block page before its widget is drawn (403, a _px3 cookie, no #px-captcha).
  "/pxbare": { status: 403, headers: { "set-cookie": "_px3=seen; Path=/" }, body: html("Access to this page has been denied", `<h1>Press &amp; Hold to confirm you are a human (and not a bot).</h1>`) },
  "/limited": { status: 429, headers: { "retry-after": "1" }, body: html("Too Many Requests", `<h1>Too many requests</h1><p>Please slow down.</p>`) },
};

describe.skipIf(!E2E)("v5: one document per decision, on real pages (fifth review)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let otherHost: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = PAGES[(req.url ?? "").split("?")[0]!];
      res.writeHead(p ? (p.status ?? 200) : 404, { "content-type": "text/html; charset=utf-8", ...(p?.headers ?? {}) });
      res.end(p?.body ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    otherHost = `http://localhost:${port}`;
    browser = await launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  type Send = (m: string, params?: unknown, o?: unknown) => Promise<unknown>;
  /** Wraps a session's send: before the n-th call of `method` (and every later one when `every`), `before` runs. */
  const hook = (session: unknown, method: string, before: () => Promise<unknown>, { from = 1, every = false } = {}) => {
    const s = session as { send: Send };
    const send = s.send;
    let n = 0;
    s.send = async (m, params, o) => {
      if (m === method) {
        n++;
        if (n === from || (every && n > from)) await before();
      }
      return send.call(s, m, params, o);
    };
    return () => void (s.send = send);
  };

  const create = async () => ({ id: "m", type: "message", role: "assistant", model: "fake", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const client = { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic;
  const open = async (path?: string) => {
    const ctx = await browser.createContext();
    const p = await browser.newPage({ browserContextId: ctx });
    if (path) await p.navigate(origin + path);
    return { p, done: async () => (await p.close(), await browser.disposeContext(ctx)) };
  };
  const agentOn = (p: Page, more: Record<string, unknown> = {}) =>
    new Agent(p, { client, model: "fake", contextEditing: false, interruptions: true, challenge: { defaults: { pollMs: 200, widgetAppearMs: 1_000 } }, ...more });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = (a: Agent) => a as unknown as Record<string, any>;

  beforeEach(() => undefined);

  describe("D: Chrome tells Node of a commit late (the capture read the new document's elements)", () => {
    it("the page's own account of its document disagrees with Node's: the capture is bound to no document, and the look is unknown", async () => {
      const { p, done } = await open("/a");
      try {
        const stale = { id: p.documentId, seq: p.documentSeq };
        await p.navigate(origin + "/b");
        // Node has not heard of /b's commit yet: its document is still /a's.
        for (const [k, v] of [["documentId", stale.id], ["documentSeq", stale.seq]] as const) Object.defineProperty(p, k, { get: () => v, set: () => undefined, configurable: true });
        const snap = await captureSnapshot(p, { viewportBand: 1 });
        expect(snap.title).toBe("Page B");
        expect(snap.unsettled).toBe(true);
        expect(snap.document).toBeNull();
        expect((await readPage(p, snap)).state).toBe("unknown");
      } finally {
        await done();
      }
    });

    it("control: Node and the page agree: the capture is bound to the document it read", async () => {
      const { p, done } = await open("/a");
      try {
        await p.navigate(origin + "/b");
        const snap = await captureSnapshot(p, { viewportBand: 1 });
        expect(snap.unsettled).toBeUndefined();
        expect(snap.document).toBe(p.documentId);
        expect(snap.documentSeq).toBe(p.documentSeq);
        expect((await readPage(p, snap)).state).toBe("known");
      } finally {
        await done();
      }
    });
  });

  describe("A: a sign-in under way is decided on one document", () => {
    const run = async (moveDuringCookieRead: boolean) => {
      const { p, done } = await open("/dashboard");
      const signedIn: string[] = [];
      const agent = agentOn(p, { onSignedIn: (e: { url: string }) => void signedIn.push(e.url) });
      const site = siteOf(new URL(origin).hostname) || new URL(origin).hostname;
      priv(agent)["signingIn"].set(site, { by: "person", typed: false, cookies: new Set<string>() });
      const unhook = moveDuringCookieRead ? hook(p.browser.root, "Storage.getCookies", () => p.navigate(origin + "/c")) : () => undefined;
      try {
        await priv(agent)["signInCheck"](await captureSnapshot(p, { viewportBand: 1 }));
        return { signedIn, kept: priv(agent)["signingIn"].has(site) as boolean };
      } finally {
        unhook();
        await done();
      }
    };

    it("the page moves on while the cookies are read: no sign-in is reported, and the sign-in under way is kept for a later look", async () => {
      const r = await run(true);
      expect(r.signedIn).toEqual([]);
      expect(r.kept).toBe(true);
    });

    it("control: the page stays: the sign-in is reported with the dashboard's address, and the entry goes", async () => {
      const r = await run(false);
      expect(r.signedIn.map((u) => new URL(u).pathname)).toEqual(["/dashboard"]);
      expect(r.kept).toBe(false);
    });
  });

  describe("B: a question to the person is of one document, or nobody is asked", () => {
    const run = async (moveTo: string | null) => {
      const { p, done } = await open("/login");
      const asked: InterventionRequest[] = [];
      const events: StepEvent[] = [];
      const agent = agentOn(p, { onIntervention: async (req: InterventionRequest) => (asked.push(req), { status: "cancel" }), onStep: (e: StepEvent) => void events.push(e) });
      const unhook = moveTo ? hook(p.browser.root, "Storage.getCookies", () => p.navigate(moveTo)) : () => undefined;
      try {
        const out = (await priv(agent)["askLogin"]("the task needs the account", "login")) as { summary: string; content: string };
        return { out, asked, handled: events.filter((e) => e.type === "interruption").map((e) => (e as { handled?: string }).handled) };
      } finally {
        unhook();
        await done();
      }
    };

    it("the page moves to another host while the cookie baseline is read: nobody is asked, and the model is told the page could not be verified", async () => {
      const r = await run(`${otherHost}/c`);
      expect(r.asked).toEqual([]);
      expect(r.handled).toEqual([]);
      expect(r.out.summary).toBe("ask_user: login unverified");
      expect(r.out.content).toMatch(/^Could not verify the page to ask the person to sign in on 127\.0\.0\.1: it loaded another document while it was read\. Nobody was asked\./);
    });

    it("the page moves within the same host while the baseline is read: nobody is asked either", async () => {
      const r = await run(`${origin}/c`);
      expect(r.asked).toEqual([]);
      expect(r.out.summary).toBe("ask_user: login unverified");
    });

    it("control: the page stays: one question, its host, address, title and sign-in ways all of the sign-in page", async () => {
      const r = await run(null);
      expect(r.asked).toHaveLength(1);
      expect(r.asked[0]).toMatchObject({ host: "127.0.0.1", title: "Sign in", signIn: { ways: ["password"], providers: [] }, autoResume: true });
      expect(new URL(r.asked[0]!.url).pathname).toBe("/login");
      expect(r.handled).toEqual(["asked", "unresolved"]);
    });
  });

  describe("B3: a reading kept after looks that could not be verified is said as the last verified one", () => {
    /** Every gather after the first look's reloads the page first: each later look sees a real document change. */
    const run = async (path: string, unverifiable: boolean) => {
      const { p, done } = await open();
      const agent = agentOn(p);
      responseTracker(p);
      await p.navigate(origin + path);
      const unhook = unverifiable ? hook(p.session, "Network.getCookies", () => p.navigate(origin + path), { from: 2, every: true }) : () => undefined;
      try {
        return (await priv(agent)["checkInterruptionInner"](await captureSnapshot(p, { viewportBand: 1 }))) as { note: string };
      } finally {
        unhook();
        await done();
      }
    };
    const LAST = /As the page read at its last look that could be verified; the looks after it could not be verified\./;

    it("HUMAN's block page, then only looks that could not be verified until the widget wait ends: the stop says it is the last verified reading", async () => {
      const out = await run("/pxbare", true);
      expect(out.note).toMatch(/^Stopped: /);
      expect(out.note).toMatch(LAST);
    }, 30_000);

    it("control: HUMAN's block page read on every look: the stop says nothing of the kind", async () => {
      const out = await run("/pxbare", false);
      expect(out.note).toMatch(/^Stopped: /);
      expect(out.note).not.toMatch(LAST);
    }, 30_000);

    it("a rate limit whose re-looks could not be verified: kept as the rate limit, and said as the last verified reading", async () => {
      const out = await run("/limited", true);
      expect(out.note).toMatch(/^Stopped: /);
      expect(out.note).toMatch(LAST);
    }, 30_000);

    it("control: a rate limit read on every re-look: stopped, with no such words", async () => {
      const out = await run("/limited", false);
      expect(out.note).toMatch(/^Stopped: /);
      expect(out.note).not.toMatch(LAST);
    }, 30_000);
  });
});
