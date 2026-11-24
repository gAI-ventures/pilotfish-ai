// A look whose document changes under it, on a real page: the page is sent to another document (a real navigation and
// commit) at the exact point a look gathers what it reads after its snapshot (the cookie read). Everything the agent
// then uses (the classification, the address, the fields, a target to click) must come from one document: the stale
// target is never clicked, a new one is picked from the page read, and sign-in state is the new document's. No model:
// a stub client; local pages only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, siteOf, type Browser, type Page } from "@pilotfish/browser";
import { captureSnapshot } from "@pilotfish/perception";
import { Agent, type InterventionRequest } from "./index.js";
import { readPage } from "./interventions.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const banner = (who: string) =>
  `<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:10px">We use cookies.<button onclick="fetch('/hit?${who}')">Accept all</button><button onclick="fetch('/hit?reject-${who}')">Reject all</button></div>`;
const PAGES: Record<string, string> = {
  "/a": page("Page A", `<h1>Page A</h1><p>${"Lamps and chairs. ".repeat(20)}</p>${banner("a")}`),
  "/b": page("Page B", `<h1>Page B</h1><p>${"Tables and shelves. ".repeat(20)}</p>${banner("b")}`),
  "/c": page("Page C", `<h1>Page C</h1><p>${"Rugs and mirrors. ".repeat(20)}</p>`),
  "/login": page("Sign in", `<h1>Sign in</h1><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`),
  "/dashboard": page("Dashboard", `<h1>Your orders</h1><p>${"Order 1042, shipped. ".repeat(10)}</p>`),
  "/phone-login": page("Phone sign-in", `<h1>Sign in with your mobile</h1><form><input name="mobile" type="tel" placeholder="Mobile number"><button>Send OTP</button></form>`),
};

describe.skipIf(!E2E)("a look whose document changes under it, on a real page (fifth review, v4)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/hit?")) {
        hits.push(req.url.slice(5));
        return void res.end("ok");
      }
      const html = PAGES[req.url ?? ""];
      res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(html ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  beforeEach(() => void (hits.length = 0));

  /**
   * The next look's gather (its cookie read, after the snapshot) first sends the page to `to` and waits for that
   * document: the document changes between a look's capture and the rest of its read, for real.
   */
  const moveOnNextGather = (p: Page, to: string) => {
    const session = p.session as unknown as { send: (m: string, params?: unknown, o?: unknown) => Promise<unknown> };
    const send = session.send.bind(session);
    let armed = true;
    session.send = async (m, params, o) => {
      if (m === "Network.getCookies" && armed) {
        armed = false;
        await p.navigate(origin + to);
      }
      return send(m, params, o);
    };
  };

  const create = async () => ({ id: "m", type: "message", role: "assistant", model: "fake", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const client = { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic;
  const open = async (path: string) => {
    const ctx = await browser.createContext();
    const p = await browser.newPage({ browserContextId: ctx });
    await p.navigate(origin + path);
    return { p, done: async () => (await p.close(), await browser.disposeContext(ctx)) };
  };

  it("readPage: a document change during the gather is read again, whole, on the new document (snapshot, address and identity together)", async () => {
    const { p, done } = await open("/c");
    try {
      const snap = await captureSnapshot(p, { viewportBand: 1 });
      expect(snap.document).toBe(p.documentId);
      moveOnNextGather(p, "/dashboard");
      const r = await readPage(p, snap);
      expect(r.state).toBe("known");
      expect(r.snap).not.toBe(snap);
      expect(new URL(r.snap.url).pathname).toBe("/dashboard");
      expect(r.state === "known" && new URL(r.input.url ?? "about:blank").pathname).toBe("/dashboard");
      expect(r.snap.document).toBe(p.documentId);
      expect(r.snap.title).toBe("Dashboard");
    } finally {
      await done();
    }
  });

  it("dismissing a banner: the target picked on page A is never clicked once the look read page B; B's own banner is picked again and closed", async () => {
    const { p, done } = await open("/a");
    try {
      const agent = new Agent(p, { client, model: "fake", contextEditing: false, interruptions: true });
      moveOnNextGather(p, "/b");
      const out = (await (agent as unknown as { dismissOverlays: () => Promise<{ done: string }> }).dismissOverlays()) as { done: string };
      await new Promise((r) => setTimeout(r, 300));
      expect(hits.filter((h) => h.endsWith("-a") || h === "a")).toEqual([]);
      expect(hits).toEqual(["reject-b"]);
      expect(out.done).toMatch(/consent banner/);
    } finally {
      await done();
    }
  });

  it("dismissing a banner: when the look read a page with no banner, nothing is clicked at all", async () => {
    const { p, done } = await open("/a");
    try {
      const agent = new Agent(p, { client, model: "fake", contextEditing: false, interruptions: true });
      moveOnNextGather(p, "/c");
      const out = (await (agent as unknown as { dismissOverlays: () => Promise<{ done: string }> }).dismissOverlays()) as { done: string };
      await new Promise((r) => setTimeout(r, 300));
      expect(hits).toEqual([]);
      expect(out.done).toBe("");
      expect(new URL(p.url).pathname).toBe("/c");
    } finally {
      await done();
    }
  });

  it("a sign-in under way: checked on the document read (the dashboard it moved to), never the old sign-in page's address with the new reading", async () => {
    const { p, done } = await open("/login");
    try {
      const signedIn: Array<{ site: string; url: string }> = [];
      const agent = new Agent(p, { client, model: "fake", contextEditing: false, interruptions: true, onSignedIn: (e) => void signedIn.push({ site: e.site, url: e.url }) });
      const site = siteOf(new URL(origin).hostname) || new URL(origin).hostname;
      (agent as unknown as { signingIn: Map<string, unknown> }).signingIn.set(site, { by: "person", typed: false });
      const snap = await captureSnapshot(p, { viewportBand: 1 });
      moveOnNextGather(p, "/dashboard");
      await (agent as unknown as { signInCheck: (s: unknown) => Promise<void> }).signInCheck(snap);
      expect(signedIn).toHaveLength(1);
      expect(new URL(signedIn[0]!.url).pathname).toBe("/dashboard");
    } finally {
      await done();
    }
  });

  it("asking the person to sign in: the question's address, title and sign-in ways are all of the document read (the phone sign-in it moved to)", async () => {
    const { p, done } = await open("/login");
    try {
      const asked: InterventionRequest[] = [];
      const agent = new Agent(p, { client, model: "fake", contextEditing: false, interruptions: true, onIntervention: async (req) => (asked.push(req), { status: "cancel" }) });
      moveOnNextGather(p, "/phone-login");
      await (agent as unknown as { askLogin: (r: string, k: "login") => Promise<unknown> }).askLogin("the task needs the account", "login");
      expect(asked).toHaveLength(1);
      expect(new URL(asked[0]!.url).pathname).toBe("/phone-login");
      expect(asked[0]!.title).toBe("Phone sign-in");
      expect(asked[0]!.signIn?.ways).toEqual(["phone_code"]);
    } finally {
      await done();
    }
  });
});
