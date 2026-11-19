// The local client against the open MCP's CLI over stdio and a real Chrome: no API key, no model calls. The MCP is this
// repository's build (packages/mcp/dist/cli.js), or the installed package named by PILOTFISH_MCP_CLI.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalBrowser, LocalToolError, type LocalQuestion } from "./local.js";

const E2E = process.env["PILOTFISH_E2E"] === "1";
const cli = process.env["PILOTFISH_MCP_CLI"] || fileURLToPath(new URL("../../mcp/dist/cli.js", import.meta.url));

const SHOP = `<!doctype html><title>Lamp shop</title><main><h1>Lamps</h1>
<ul id="items"><li class="item" data-price="25">Blue lamp</li><li class="item" data-price="40">Red lamp</li></ul>
<label>Name <input id="name"></label> <button id="save" onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('name').value">Save</button>
<p id="out"></p>
<button id="order" onclick="document.getElementById('out').textContent='Order placed'">Place order</button>
</main>`;

describe.skipIf(!E2E)("LocalBrowser (the open MCP over stdio)", () => {
  let site: Server;
  let origin: string;
  const env: Record<string, string> = {};

  beforeAll(async () => {
    expect(existsSync(cli), `${cli} is missing: npm run build first`).toBe(true);
    site = createServer((_req, res) => void (res.writeHead(200, { "content-type": "text/html" }), res.end(SHOP)));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    for (const k of ["PILOTFISH_ADBLOCK_OFFLINE"]) if (process.env[k]) env[k] = process.env[k]!;
  });
  afterAll(() => site?.close());

  const start = (o: { onQuestion?: (q: LocalQuestion) => boolean } = {}) =>
    LocalBrowser.start({ command: [process.execPath, cli], headless: true, allowPrivate: true, env, ...(process.env["PILOTFISH_CHROME"] ? { chrome: process.env["PILOTFISH_CHROME"] } : {}), ...o });

  it("navigates, finds, types, clicks, reads and screenshots, then closes", async () => {
    const b = await start();
    try {
      expect(b.serverInfo?.name).toBeTruthy();
      expect((await b.tools()).map((t) => t.name)).toContain("browser_navigate");
      const nav = await b.navigate(`${origin}/`);
      expect(nav.text).toContain("Lamps");
      const name = /\[(e\d+)\]<input[^\n]*/.exec((await b.find("Name input")).text)?.[1];
      const save = /\[(e\d+)\]<button[^>]*>Save/.exec((await b.snapshot()).text)?.[1];
      expect(name && save).toBeTruthy();
      await b.type(name!, "Ada");
      await b.click(save!, { expect: { text: "Saved: Ada" } });
      const prices = await b.query<number[]>("[...document.querySelectorAll('.item')].map((e) => Number(e.dataset.price))");
      expect(prices.value).toEqual([25, 40]);
      const typed = await b.query<{ count: number }>("({count: document.querySelectorAll('.item').length})", { schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } });
      expect(typed.value).toEqual({ count: 2 });
      expect((await b.getText({ selector: "#out" })).text).toContain("Saved: Ada");
      const jpeg = await b.screenshot();
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
      // A stale ref is the tool's error, thrown with its text.
      const err = await b.click("e9999").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LocalToolError);
      expect((err as LocalToolError).tool).toBe("browser_click");
    } finally {
      await b.close();
    }
  });

  it("asks onQuestion before an irreversible step, and the step runs on a yes", async () => {
    const asked: LocalQuestion[] = [];
    const b = await start({ onQuestion: (q) => (asked.push(q), true) });
    try {
      await b.navigate(`${origin}/`);
      const order = /\[(e\d+)\]<button[^>]*>Place order/.exec((await b.snapshot()).text)?.[1];
      await b.click(order!);
      expect(asked.length).toBe(1);
      expect(asked[0]!.kind).toBe("confirm");
      expect((await b.getText({ selector: "#out" })).text).toContain("Order placed");
    } finally {
      await b.close();
    }
  });

  it("without onQuestion an irreversible step is refused, and nothing happens", async () => {
    const b = await start();
    try {
      await b.navigate(`${origin}/`);
      const order = /\[(e\d+)\]<button[^>]*>Place order/.exec((await b.snapshot()).text)?.[1];
      const r = await b.click(order!).catch((e: LocalToolError) => e.result);
      expect(r.text).toMatch(/confirm|approv|refus|irreversible/i);
      expect((await b.getText({ selector: "#out" })).text).not.toContain("Order placed");
    } finally {
      await b.close();
    }
  });
});
