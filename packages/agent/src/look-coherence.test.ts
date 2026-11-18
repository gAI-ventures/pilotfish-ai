// A look reads one document: its snapshot, that document's response, and the address, frames and cookies read after
// it, with the page still on that document from before the rest is read to after. A tab that does not know its
// document yet, or a document change during the read, makes the look "unknown" (after READ_TRIES captures), never a
// mix of one document's elements and response with another's address or cookies. No browser: the page is a stub whose
// session answers the few CDP calls a look makes, and captures are mocked.
import { describe, expect, it, vi } from "vitest";
import type { Page } from "@pilotfish/browser";
import type { Snapshot } from "@pilotfish/perception";
import { classifyPage, READ_TRIES, readPage, UnboundLookError } from "./interventions.js";

/** A snapshot bound to the document the page is on now (as captureSnapshot binds it), counting captures. */
const captured = vi.hoisted(() => ({ count: 0 }));
const snapOf = (page: { url: string; documentId: string | null; documentSeq: number }) => ({
  takenAt: Date.now(),
  url: page.url,
  title: "Shop",
  viewport: { x: 0, y: 0, width: 1280, height: 800 },
  content: { width: 1280, height: 800 },
  scroll: { x: 0, y: 0 },
  root: null,
  nodes: [],
  byRef: new Map(),
  frames: [],
  frameIndex: new Map(),
  offscreen: { above: 0, below: 0 },
  band: { top: 0, bottom: 800 },
  keys: new Set(),
  refMemory: new Map(),
  maxRef: new Map(),
  document: page.documentId,
  ...(page.documentId !== null ? { documentSeq: page.documentSeq } : {}),
});

vi.mock("@pilotfish/perception", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pilotfish/perception")>();
  return { ...real, captureSnapshot: async (page: { url: string; documentId: string | null; documentSeq: number }) => (captured.count++, snapOf(page)) };
});

/**
 * A tab on document `doc`. `changes`: how many of its next cookie reads (part of a look's gather, after the snapshot)
 * come as the page commits another document at another address.
 */
function tab(doc: string | null, changes = 0) {
  const state = { changes, url: "https://shop.test/a", documentId: doc, documentSeq: doc === null ? 0 : 1 };
  const page = {
    get url() {
      return state.url;
    },
    get documentId() {
      return state.documentId;
    },
    get documentSeq() {
      return state.documentSeq;
    },
    closed: false,
    main: { frameId: "F" },
    lastNavigationAt: 0,
    frames: () => [],
    session: {
      on: () => () => undefined,
      send: async (method: string) => {
        // The page's own account of its committed document (v6: the gather asks it before and after).
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", loaderId: state.documentId, url: state.url } } };
        if (method !== "Network.getCookies") return {};
        if (state.changes > 0) {
          state.changes--;
          state.documentSeq++;
          state.documentId = `d${state.documentSeq}`;
          state.url = `https://shop.test/moved-${state.documentSeq}`;
        }
        return { cookies: [] };
      },
    },
  };
  return { page: page as unknown as Page, state };
}

describe("a look reads one document (fifth review, v3)", () => {
  it("stable control: a look on the document its snapshot was bound to is classified, with that document's address", async () => {
    const { page } = tab("d1");
    const { result, input } = await classifyPage(page, snapOf({ url: page.url, documentId: "d1", documentSeq: 1 }) as unknown as Snapshot);
    expect(result.category).toBe("none");
    expect(input.url).toBe("https://shop.test/a");
  });

  it("a document change during the gather (another address and cookies read after the snapshot) is UnboundLookError, not a mixed look", async () => {
    const { page } = tab("d1", 1);
    const err = await classifyPage(page, snapOf({ url: page.url, documentId: "d1", documentSeq: 1 }) as unknown as Snapshot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnboundLookError);
    expect((err as UnboundLookError).why).toBe("changed");
  });

  it("a snapshot of a document the page has since left is not read either", async () => {
    const { page, state } = tab("d1");
    const snap = snapOf({ url: page.url, documentId: "d1", documentSeq: 1 }) as unknown as Snapshot;
    state.documentSeq = 2;
    state.documentId = "d2";
    expect(((await classifyPage(page, snap).catch((e: unknown) => e)) as UnboundLookError).why).toBe("changed");
  });

  it("startup: a tab that does not know its document (null loader) gives an unknown look, not a look with no response", async () => {
    const { page } = tab(null);
    expect(((await classifyPage(page, snapOf(page as never) as unknown as Snapshot).catch((e: unknown) => e)) as UnboundLookError).why).toBe("unknown_document");
    captured.count = 0;
    const r = await readPage(page, snapOf(page as never) as unknown as Snapshot);
    expect(r.state).toBe("unknown");
    expect(captured.count).toBe(READ_TRIES - 1);
  });

  it("readPage: a change during one look's gather is captured again and read whole; a change during every look is unknown", async () => {
    const once = tab("d1", 1);
    captured.count = 0;
    const r = await readPage(once.page, snapOf({ url: once.page.url, documentId: "d1", documentSeq: 1 }) as unknown as Snapshot);
    expect(r.state).toBe("known");
    expect(captured.count).toBe(1);
    // The look it returns is the new capture, of the document the page moved to, with that document's address.
    expect(r.snap.document).toBe("d2");
    expect(r.state === "known" && r.input.url).toBe("https://shop.test/moved-2");

    const always = tab("d1", 99);
    captured.count = 0;
    const u = await readPage(always.page, snapOf({ url: always.page.url, documentId: "d1", documentSeq: 1 }) as unknown as Snapshot);
    expect(u).toMatchObject({ state: "unknown", why: "changed" });
    expect(captured.count).toBe(READ_TRIES - 1);
  });
});
