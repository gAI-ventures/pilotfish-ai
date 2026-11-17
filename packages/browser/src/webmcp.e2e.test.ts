// WebMCP through Chrome's DevTools domain, on a real Chrome: a page's tools (registered in script, declared on forms)
// are listed and called, their answers come back, another document drops them, and a Chrome launched without the
// WebMCP flag still reads the tools of a page that carries the origin trial's token (a launch with webmcp: false).
// Skipped on a Chrome that has no WebMCP.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch } from "./launcher.js";
import type { Browser } from "./browser.js";
import type { Page } from "./page.js";

const E2E = process.env.PILOTFISH_E2E === "1";

const TOOLS_HTML = `<!doctype html><html><head><title>Rooms</title></head><body>
<h1>Rooms</h1><ul id="list"></ul><button id="drop" onclick="dropTemporary()">Drop</button>
<form toolname="contact_host" tooldescription="Write to the host" action="/sent" method="get">
  <label>Message <textarea name="message" required toolparamdescription="What to say"></textarea></label>
  <button type="submit">Send message</button>
</form>
<form toolname="quick_search" tooldescription="Search rooms by city and open the results" toolautosubmit action="/results" method="get">
  <input name="city" toolparamdescription="City name"><select name="beds"><option>1</option><option>2</option></select>
</form>
<script>
const mc = document.modelContext;
if (mc) {
  mc.registerTool({
    name: "search_rooms", description: "Find rooms in a city",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City" } }, required: ["city"] },
    annotations: { readOnlyHint: true },
    execute: async ({ city }) => {
      const rooms = [city + " Loft $80", city + " Studio $65"];
      document.getElementById("list").innerHTML = rooms.map((r) => "<li>" + r + "</li>").join("");
      return { content: [{ type: "text", text: JSON.stringify(rooms) }] };
    },
  });
  mc.registerTool({ name: "fail_tool", description: "Always fails", execute: async () => { throw new Error("no rooms today"); } });
  mc.registerTool({ name: "debug_dump", description: "Developer state", annotations: { debugging: true }, execute: async () => "state" });
  const ac = new AbortController();
  mc.registerTool({ name: "temporary", description: "Goes away", execute: async () => "x" }, { signal: ac.signal });
  window.dropTemporary = () => ac.abort();
}
</script></body></html>`;

async function hasWebMcp(page: Page): Promise<boolean> {
  return (await page.main.evaluate<string>("typeof document.modelContext")) === "object";
}

async function until<T>(f: () => T | undefined, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A WebMCP origin trial token signed with our own key, for `origin` (Chrome takes the key with --origin-trial-public-key). */
function trialToken(origin: string): { token: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const payload = Buffer.from(JSON.stringify({ origin, feature: "WebMCP", expiry: Math.floor(Date.now() / 1000) + 86_400 }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const version = Buffer.from([3]);
  const signature = sign(null, Buffer.concat([version, len, payload]), privateKey);
  return { token: Buffer.concat([version, signature, len, payload]).toString("base64"), publicKey: raw.toString("base64") };
}

describe.skipIf(!E2E)("WebMCP (Chrome's WebMCP domain)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let trial = { token: "", publicKey: "" };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      res.setHeader("content-type", "text/html");
      if (path === "/trial") res.setHeader("Origin-Trial", trial.token);
      if (path === "/" || path === "/trial" || path === "/plain") return res.end(TOOLS_HTML);
      res.end(`<!doctype html><title>${path}</title><p>${path}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    trial = trialToken(origin);
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("lists a page's tools (script and forms), calls them, and drops them with the document", async (ctx) => {
    const page = await browser.newPage();
    await page.navigate(`${origin}/`);
    if (!(await hasWebMcp(page))) return ctx.skip();
    const tools = await until(() => (page.webmcp.list().length >= 5 ? page.webmcp.list() : undefined));
    const names = tools.map((t) => t.name).sort();
    // A developer tool is left out; the one whose registration was aborted goes once it is.
    expect(names).toEqual(["contact_host", "fail_tool", "quick_search", "search_rooms", "temporary"]);
    const search = page.webmcp.get("search_rooms")!;
    expect(search.annotations).toEqual({ readOnly: true });
    expect(search.inputSchema).toMatchObject({ required: ["city"] });
    const form = page.webmcp.get("contact_host")!;
    expect(form.backendNodeId).toBeTypeOf("number");
    expect(form.inputSchema).toMatchObject({ properties: { message: { description: "What to say" } }, required: ["message"] });
    expect(page.webmcp.get("quick_search")!.annotations).toEqual({ autosubmit: true });

    // The page's own script lives in its world: a click on its button reaches it.
    await page.main.evaluate("document.getElementById('drop').click()");
    await until(() => !page.webmcp.get("temporary") || undefined);

    // A call answers with what the tool returned, and does what it does on the page.
    expect(await page.webmcp.invoke("search_rooms", { city: "Goa" })).toEqual({ status: "completed", output: { content: [{ type: "text", text: '["Goa Loft $80","Goa Studio $65"]' }] } });
    expect(await page.main.evaluate<string>("document.getElementById('list').innerText")).toContain("Goa Studio $65");
    // A thrown error comes back as its message.
    expect(await page.webmcp.invoke("fail_tool", {})).toEqual({ status: "error", error: "Error: no rooms today" });
    // A form without toolautosubmit is filled in and left for its submit button.
    expect(await page.webmcp.invoke("contact_host", { message: "Is it quiet?" })).toEqual({ status: "filled" });
    expect(await page.main.evaluate<string>("document.querySelector('textarea').value")).toBe("Is it quiet?");
    expect(page.url).toBe(`${origin}/`);
    await expect(page.webmcp.invoke("no_such_tool", {})).rejects.toThrow(/no tool named "no_such_tool"/);

    // A form with toolautosubmit submits itself: another document, and the tools of the old one are gone.
    const r = await page.webmcp.invoke("quick_search", { city: "Pune", beds: "2" });
    expect(r.status).toBe("completed");
    await until(() => (page.url.includes("/results") ? true : undefined));
    expect(page.url).toBe(`${origin}/results?city=Pune&beds=2`);
    expect(page.webmcp.list()).toEqual([]);
    await page.close();
  });

  it("without the WebMCP flag, reads only a page whose origin trial token turns it on", async (ctx) => {
    const plainBrowser = await launch({ headless: true, webmcp: false, args: [`--origin-trial-public-key=${trial.publicKey}`] });
    try {
      const page = await plainBrowser.newPage();
      await page.navigate(`${origin}/plain`);
      expect(await hasWebMcp(page)).toBe(false);
      expect(page.webmcp.list()).toEqual([]);
      await page.navigate(`${origin}/trial`);
      if (!(await hasWebMcp(page))) return ctx.skip();
      const names = (await until(() => (page.webmcp.list().length >= 5 ? page.webmcp.list() : undefined))).map((t) => t.name);
      expect(names).toContain("search_rooms");
      expect(await page.webmcp.invoke("search_rooms", { city: "Delhi" })).toMatchObject({ status: "completed" });
    } finally {
      await plainBrowser.close();
    }
  });
});
