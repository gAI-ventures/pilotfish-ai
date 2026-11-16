// A session initializer registered while a tab is open runs on that tab's frames at once, without the
// caller waiting; Browser.initialized() settles once it has, so the tab's next navigation gets a document
// it already applied to (an extension's overrides and scripts, the routing). $0: no Chrome.
import { describe, expect, it } from "vitest";
import type { Connection } from "@pilotfish/cdp";
import { Browser } from "./browser.js";
import type { FrameSession, Page } from "./page.js";

/** A Browser with no Chrome behind it, and one open tab with one frame. */
function withOpenTab(): { browser: Browser; frame: FrameSession } {
  const browser = new Browser({ onClose: () => undefined } as unknown as Connection, null, {});
  const frame = { isMain: true } as unknown as FrameSession;
  const page = { targetId: "t1", frames: () => [frame] } as unknown as Page;
  (browser as unknown as { pages: Map<string, Page> }).pages.set("t1", page);
  return { browser, frame };
}

describe("session initializers on a tab already open", () => {
  it("initialized() settles only once they have run on it, a slow one and one that fails included", async () => {
    const { browser, frame } = withOpenTab();
    const done: string[] = [];
    browser.addSessionInitializer(async (f) => {
      await new Promise((r) => setTimeout(r, 150));
      if (f === frame) done.push("slow");
    });
    browser.addSessionInitializer(async () => {
      done.push("failing");
      throw new Error("the tab went away");
    });
    expect(done).toEqual(["failing"]);
    await browser.initialized();
    expect(done).toEqual(["failing", "slow"]);
    // Nothing pending: it settles at once.
    await browser.initialized();
  });

  it("one registered while another is still running is waited for too", async () => {
    const { browser } = withOpenTab();
    const done: string[] = [];
    browser.addSessionInitializer(async () => {
      await new Promise((r) => setTimeout(r, 50));
      done.push("first");
      browser.addSessionInitializer(async () => {
        await new Promise((r) => setTimeout(r, 100));
        done.push("second");
      });
    });
    await browser.initialized();
    expect(done).toEqual(["first", "second"]);
  });
});
