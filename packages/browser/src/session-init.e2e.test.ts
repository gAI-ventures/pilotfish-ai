// A session initializer registered while a tab is open (an extension's overrides on a launched browser's
// first tab) reaches that tab without the caller waiting, so a navigation sent at once can commit first: the
// page then sees the host (its own core count, no override script). Awaiting
// Browser.initialized() before the navigation gives the first document all of it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { availableParallelism } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type Browser } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

describe.skipIf(!E2E)("session initializers on a tab already open", () => {
  let site: Server;
  let url = "";
  let browser: Browser;
  beforeAll(async () => {
    // What the page's own first script sees.
    site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>-</title><script>document.title = String(window.__pfInit ?? "none") + ":" + navigator.hardwareConcurrency</script>`));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    browser = await launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    site?.close();
  });

  it("have run before the tab's first document once initialized() settles: it sees what they set up", async () => {
    const page = browser.allPages()[0] ?? (await browser.newPage());
    // A core count no host here has, and a marker script: slower to land than the page is to load.
    const cores = availableParallelism() === 3 ? 5 : 3;
    browser.addSessionInitializer(async (frame) => {
      await new Promise((r) => setTimeout(r, 400));
      await frame.session.send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: cores });
      await frame.session.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pfInit = 'ready'" });
    });
    await browser.initialized();
    await page.navigate(url);
    expect(await page.main.evaluate<string>("document.title")).toBe(`ready:${cores}`);
  });
});
