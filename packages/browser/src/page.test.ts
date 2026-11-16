import { describe, expect, it } from "vitest";
import type { CDPSession, Protocol } from "@pilotfish/cdp";
import type { Browser } from "./browser.js";
import { Page, isBrowserOwnUrl } from "./page.js";

describe("a tab's address", () => {
  it("is that of the document that committed while the tab was being set up (a popup released before its frame tree is read)", async () => {
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    const emit = (event: string, e: unknown) => handlers.get(event)?.forEach((f) => f(e));
    const targetInfo = { targetId: "T1", type: "page", title: "", url: "", attached: true, canAccessOpener: false };
    const session = {
      sessionId: "S1",
      targetInfo,
      on: (event: string, fn: (e: unknown) => void) => {
        const set = handlers.get(event) ?? new Set();
        set.add(fn);
        handlers.set(event, set);
        return () => void set.delete(fn);
      },
      send: async (method: string) => {
        if (method !== "Page.getFrameTree") return {};
        // The tab was released at the end of its frame session's setup: its first document commits, and the
        // event is dispatched, before the tree's answer (read before the commit) comes back.
        emit("Page.frameNavigated", { frame: { id: "T1", loaderId: "L1", url: "https://site.test/popup", securityOrigin: "https://site.test", mimeType: "text/html" }, type: "Navigation" });
        return { frameTree: { frame: { id: "T1", url: "" } } };
      },
    };
    const browser = { viewport: { width: 1280, height: 800 }, sessionInitializers: [], connection: { session: () => undefined }, _clockOwnerMayHaveLeft: () => undefined };
    const page = new Page(browser as unknown as Browser, session as unknown as CDPSession, targetInfo as unknown as Protocol.Target.TargetInfo);
    await page._initialize();
    expect(page.url).toBe("https://site.test/popup");
  });
});

describe("which workers are the browser's own", () => {
  it("is only the browser's own scripts (and blob: URLs they made): a page's worker from any scheme is the page's", () => {
    for (const url of ["chrome-extension://abcdefghijklmnop/sw.js", "blob:chrome-extension://abcdefghijklmnop/0b7c", "chrome://new-tab-page/sw.js", "chrome-untrusted://x/w.js", "devtools://devtools/bundled/w.js", "edge://x/w.js", "brave://x/w.js", "CHROME-EXTENSION://x/sw.js"]) {
      expect(isBrowserOwnUrl(url), url).toBe(true);
    }
    // A page's: the worker initializers and the clock go to these (a blob: or data: SharedWorker included).
    for (const url of ["https://shop.example/sw.js", "http://127.0.0.1:8080/shared.js", "blob:https://shop.example/5f1e", "blob:null/5f1e", "data:text/javascript,onconnect=()=>{}", "", "https://chrome.example/w.js"]) {
      expect(isBrowserOwnUrl(url), url).toBe(false);
    }
  });
});
