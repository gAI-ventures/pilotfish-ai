// The main-document response tracker binds each response to the document it loads (its loaderId), and a look to the
// document it read, by identity and event order, never by time.
import { describe, expect, it, vi } from "vitest";
import type { Page } from "@pilotfish/browser";
import { DocumentChangedError, gatherInterruptInput, trackMainResponse } from "./interrupts-cdp.js";
import { CAPTURE_TRIES, onOneDocument } from "./snapshot.js";

/** A page whose session events the test sends: main-frame responses and commits, in the order given. */
function fakePage() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  // The page's own account of its committed document (Page.getFrameTree), as the gather asks for it (v6).
  let committed = "";
  const page = {
    url: "http://x/",
    main: { frameId: "F" },
    lastNavigationAt: 0,
    frames: () => [],
    session: {
      on(name: string, fn: (e: unknown) => void) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
        return () => listeners.get(name)!.delete(fn);
      },
      send: async (method: string) => (method === "Network.getCookies" ? { cookies: [] } : method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F", loaderId: committed, url: "" } } } : {}),
    },
  } as unknown as Page;
  const emit = (name: string, e: unknown) => listeners.get(name)?.forEach((fn) => fn(e));
  return {
    page,
    response: (loaderId: string, url: string, status: number) => emit("Network.responseReceived", { type: "Document", frameId: "F", loaderId, response: { url, status, headers: { "X-Px": "1" } } }),
    commit: (loaderId: string, url: string) => ((committed = loaderId), emit("Page.frameNavigated", { frame: { id: "F", loaderId, url } })),
    listeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("trackMainResponse", () => {
  it("a response before any commit it saw is not the page's: latest stays unknown until that document commits", () => {
    const p = fakePage();
    const t = trackMainResponse(p.page);
    p.response("a", "http://x/block", 403);
    expect(t.latest).toBeNull();
    // Bound by identity, a look that read document "a" still gets its own response.
    expect(t.forDocument("a")).toMatchObject({ url: "http://x/block", status: 403, headers: { "x-px": "1" } });
    p.commit("a", "http://x/block");
    expect(t.latest).toMatchObject({ status: 403 });
    t.dispose();
    expect(p.listeners()).toBe(0);
  });

  it("the next document's response, in before its commit, does not displace the committed one's", () => {
    const p = fakePage();
    const t = trackMainResponse(p.page);
    p.response("a", "http://x/block", 403);
    p.commit("a", "http://x/block");
    p.response("b", "http://x/block", 200);
    expect(t.latest).toMatchObject({ status: 403 });
    expect(t.forDocument("a")).toMatchObject({ status: 403 });
    p.commit("b", "http://x/block");
    expect(t.latest).toMatchObject({ status: 200 });
    // A look that read the block page before that commit is still classified with the block page's response.
    expect(t.forDocument("a")).toMatchObject({ status: 403 });
  });

  it("a different loader's 204 or download, which never commits, does not displace the committed document's response", () => {
    const p = fakePage();
    const t = trackMainResponse(p.page);
    p.response("a", "http://x/list", 200);
    p.commit("a", "http://x/list");
    p.response("c", "http://x/ping", 204);
    p.response("d", "http://x/report.pdf", 200);
    expect(t.latest).toMatchObject({ url: "http://x/list", status: 200 });
    expect(t.forDocument("a")).toMatchObject({ url: "http://x/list" });
    expect(t.forDocument("c")).toMatchObject({ status: 204 });
  });

  it("orders responses and commits by their events, not their times: all in one millisecond", () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const p = fakePage();
      const t = trackMainResponse(p.page);
      p.response("a", "http://x/one", 403);
      p.commit("a", "http://x/one");
      p.response("b", "http://x/two", 200);
      expect(t.latest).toMatchObject({ url: "http://x/one" });
      p.commit("b", "http://x/two");
      p.response("c", "http://x/three", 404);
      p.commit("c", "http://x/three");
      expect(Date.now()).toBe(1_000);
      expect(t.latest).toMatchObject({ url: "http://x/three", status: 404 });
      expect(t.forDocument("a")).toMatchObject({ status: 403 });
      expect(t.forDocument("b")).toMatchObject({ status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a document restored from the back/forward cache its own response again, and nothing once it is no longer kept", () => {
    const p = fakePage();
    const t = trackMainResponse(p.page);
    p.response("a", "http://x/list", 200);
    p.commit("a", "http://x/list");
    p.response("b", "http://x/item", 404);
    p.commit("b", "http://x/item");
    p.commit("a", "http://x/list");
    expect(t.latest).toMatchObject({ url: "http://x/list", status: 200 });
    // Sixteen later responses push "a" out: unknown, never another document's.
    for (let i = 0; i < 16; i++) p.response(`n${i}`, `http://x/n${i}`, 200);
    expect(t.forDocument("a")).toBeNull();
    expect(t.latest).toBeNull();
  });

  it("gatherInterruptInput reads the response of the document the snapshot read, and none for a look bound to no document", async () => {
    const p = fakePage();
    const t = trackMainResponse(p.page);
    p.response("a", "http://x/block", 403);
    p.commit("a", "http://x/block");
    p.response("b", "http://x/block", 200);
    // b's response is in, its commit not yet: a look at "a" reads a's response.
    expect((await gatherInterruptInput(p.page, { tracker: t, document: "a" })).response).toMatchObject({ status: 403 });
    p.commit("b", "http://x/block");
    expect((await gatherInterruptInput(p.page, { tracker: t, document: "b" })).response).toMatchObject({ status: 200 });
    // v6: a gather for a document the page has left is refused (the page itself names another), never read as a's.
    const left = await gatherInterruptInput(p.page, { tracker: t, document: "a" }).catch((e: unknown) => e);
    expect(left).toBeInstanceOf(DocumentChangedError);
    expect((left as DocumentChangedError).seen).toBe(true);
    expect((await gatherInterruptInput(p.page, { tracker: t, document: null })).response).toBeNull();
    expect((await gatherInterruptInput(p.page, { tracker: t })).response).toMatchObject({ status: 200 });
  });
});

describe("onOneDocument", () => {
  /** A page whose document changes at the given captures (1-based), as a commit seen while that capture runs. */
  const changing = (at: number[]) => {
    const page = { documentSeq: 0, documentId: "d0" as string | null };
    let n = 0;
    const capture = async () => {
      n++;
      const read = page.documentId;
      if (at.includes(n)) {
        page.documentSeq++;
        page.documentId = `d${page.documentSeq}`;
      }
      return `capture ${n} read ${read}`;
    };
    return { page, capture };
  };

  it("binds a capture with no commit during it to the document it read", async () => {
    const { page, capture } = changing([]);
    expect(await onOneDocument(page, capture)).toEqual({ value: "capture 1 read d0", document: "d0", tries: 1 });
  });

  it("two document changes in a row, one during each of two captures: the third capture is bound to the third document", async () => {
    const { page, capture } = changing([1, 2]);
    expect(await onOneDocument(page, capture)).toEqual({ value: "capture 3 read d2", document: "d2", tries: 3 });
  });

  it("a change during every try is bound to no document (unknown), never paired with the last one", async () => {
    const { page, capture } = changing([1, 2, 3, 4]);
    const out = await onOneDocument(page, capture);
    expect(out.tries).toBe(CAPTURE_TRIES);
    expect(out.document).toBeUndefined();
  });

  it("a page that does not know its document gives a capture bound to none", async () => {
    const page = { documentSeq: 4, documentId: null };
    expect(await onOneDocument(page, async () => "x")).toEqual({ value: "x", document: null, tries: 1 });
  });

  it("a late commit event (v5): the page says it committed d1 while Node still holds d0: not bound; once Node has heard of it, bound to d1", async () => {
    const page = { documentSeq: 0, documentId: "d0" as string | null };
    let n = 0;
    const capture = async () => `capture ${++n}`;
    // The page committed d1 before the first capture read its elements; Node hears of it only after that capture.
    const corroborate = async () => {
      const said = "d1";
      if (n === 1) {
        page.documentSeq = 1;
        page.documentId = "d1";
      }
      return said;
    };
    // First try: Node's d0 against the page's d1 (and the seq moved after) → not settled; the second try agrees.
    expect(await onOneDocument(page, capture, CAPTURE_TRIES, corroborate)).toEqual({ value: "capture 2", document: "d1", tries: 2 });
  });

  it("a late commit Node never hears of within the tries is bound to no document; a page that cannot say is no confirmation", async () => {
    const stale = { documentSeq: 0, documentId: "d0" as string | null };
    const never = await onOneDocument(stale, async () => "x", CAPTURE_TRIES, async () => "d1");
    expect(never.document).toBeUndefined();
    expect(never.tries).toBe(CAPTURE_TRIES);
    const silent = await onOneDocument(stale, async () => "x", CAPTURE_TRIES, async () => undefined);
    expect(silent.document).toBeUndefined();
    // Control: the page agrees with Node at once.
    expect(await onOneDocument(stale, async () => "x", CAPTURE_TRIES, async () => "d0")).toEqual({ value: "x", document: "d0", tries: 1 });
  });
});
