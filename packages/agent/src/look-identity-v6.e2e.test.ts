// v6 proof on a real page (local server, real Chrome, no model): a commit that reaches Node only after a look's gather.
// The snapshot is of page A; during the gather (its cookie read) the page really commits page B, and Node's view of the
// document is held at A until after the gather, so every Node-side identity check passes. The page's own account of
// its document, read before and after the whole gather, must catch it: the look is not classified on A's snapshot and
// response with B's cookies and frames. Control: no change, the look is classified.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, type Browser, type Page } from "@pilotfish/browser";
import { captureSnapshot } from "@pilotfish/perception";
import { classifyPage, readPage, UnboundLookError } from "./interventions.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  "/a": html("Page A", `<h1>Page A</h1><p>${"Lamps and chairs. ".repeat(20)}</p>`),
  "/b": html("Page B", `<h1>Page B</h1><p>${"Tables and shelves. ".repeat(20)}</p><iframe src="/c"></iframe>`),
  "/c": html("Page C", `<p>An embedded frame.</p>`),
};

describe.skipIf(!E2E)("v6: the gather is checked against the page's own account of its document (fifth review)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", ...(req.url === "/b" ? { "set-cookie": "b_only=1; Path=/" } : {}) });
      res.end(body ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  /**
   * During the next gather's cookie read, Node's document is frozen at the current one, then the page really commits
   * `to`: Node hears of it only after the gather (the late event).
   */
  const commitUnheardDuringGather = (p: Page, to: string) => {
    const s = p.session as unknown as { send: (m: string, params?: unknown, o?: unknown) => Promise<unknown> };
    const send = s.send;
    let armed = true;
    s.send = async (m, params, o) => {
      if (m === "Network.getCookies" && armed) {
        armed = false;
        const held = { id: p.documentId, seq: p.documentSeq };
        for (const [k, v] of [["documentId", held.id], ["documentSeq", held.seq]] as const) Object.defineProperty(p, k, { get: () => v, set: () => undefined, configurable: true });
        await p.navigate(origin + to);
      }
      return send.call(s, m, params, o);
    };
  };

  const open = async (path: string) => {
    const ctx = await browser.createContext();
    const p = await browser.newPage({ browserContextId: ctx });
    await p.navigate(origin + path);
    return { p, done: async () => (await p.close(), await browser.disposeContext(ctx)) };
  };

  it("a commit Node hears of only after the gather: the look is not classified (UnboundLookError), and readPage gives unknown", async () => {
    const { p, done } = await open("/a");
    try {
      const snap = await captureSnapshot(p, { viewportBand: 1 });
      expect(snap.document).toBe(p.documentId);
      commitUnheardDuringGather(p, "/b");
      const err = await classifyPage(p, snap).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnboundLookError);
      expect((err as UnboundLookError).why).toBe("changed");
      // Node still holds A: every later capture disagrees with the page (B), so the look stays unknown.
      expect((await readPage(p, snap)).state).toBe("unknown");
    } finally {
      await done();
    }
  });

  it("control: no change during the gather: the look is classified on its own document", async () => {
    const { p, done } = await open("/a");
    try {
      const snap = await captureSnapshot(p, { viewportBand: 1 });
      const { result, input } = await classifyPage(p, snap);
      expect(result.category).toBe("none");
      expect(new URL(input.url ?? "about:blank").pathname).toBe("/a");
      expect(input.frameUrls).toHaveLength(1);
      expect((await readPage(p, snap)).state).toBe("known");
    } finally {
      await done();
    }
  });
});
