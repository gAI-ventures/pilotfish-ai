// A site that works by place: the first search waits until the run has set the site's delivery address or location
// (`placeGate`, `AgentOptions.placeFirst`). Typing into the place's own field is never held back; a "Place:" note (or a
// page tool that sets it) lets searching through; twice held at most; no gate without `placeFirst`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, type Browser } from "@pilotfish/browser";
import { Agent } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";
type Turn = Array<{ name: string; input: Record<string, unknown> }>;

function lastSeen(params: Anthropic.MessageCreateParams): string {
  const m = [...params.messages].reverse().find((x) => x.role === "user");
  const parts: string[] = [];
  const add = (c: unknown) => {
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) c.forEach(add);
    else if (c && typeof c === "object") {
      const b = c as { type?: string; text?: string; content?: unknown };
      if (b.type === "text" && b.text) parts.push(b.text);
      if (b.type === "tool_result") add(b.content);
    }
  };
  add(m?.content);
  return parts.join("\n");
}
function scripted(turns: Array<(seen: string, all: string) => Turn>): { client: Anthropic; seen: string[] } {
  const seen: string[] = [];
  let i = 0;
  let all = "";
  const create = async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    const s = lastSeen(params);
    seen.push(s);
    all = `${s}\n${all}`;
    const turn = (turns[i++] ?? (() => [{ name: "done", input: { success: true, result: "ok" } }]))(s, all);
    const content = turn.map((t, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: t.name, input: t.input }));
    return { id: `m${i}`, type: "message", role: "assistant", model: "fake", content, stop_reason: "tool_use", stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
  };
  return { client: { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic, seen };
}
const ref = (text: string, re: RegExp) => {
  const m = new RegExp(String.raw`\[((?:f\d+)?e\d+)\]<input[^\n]*${re.source}`).exec(text);
  if (!m) throw new Error(`no input for ${re} in ${text.slice(0, 1500)}`);
  return m[1]!;
};

const SHOP = `<!doctype html><html><head><meta charset="utf-8"><title>Corner Shop</title></head><body>
<header><span id="where">Delivering to: Puducherry</span>
<input id="area" aria-label="Search for area, street name" placeholder="Search for area, street name">
<input id="q" type="search" aria-label="Search for products" placeholder="Search for products"></header>
<main><h1>Groceries</h1><p id="out"></p></main>
<script>
  document.getElementById('area').addEventListener('change', (e) => { document.getElementById('where').textContent = 'Delivering to: ' + e.target.value; });
  document.getElementById('q').addEventListener('change', (e) => { document.getElementById('out').textContent = 'Results for ' + e.target.value + ' in ' + document.getElementById('where').textContent.replace('Delivering to: ', ''); });
</script></body></html>`;

describe.skipIf(!E2E)("a by-place site's first search waits for its place", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((_q, res) => (res.writeHead(200, { "content-type": "text/html; charset=utf-8" }), res.end(SHOP)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const run = async (placeFirst: boolean | undefined) => {
    const p = await browser.newPage();
    await p.navigate(origin + "/");
    const { client, seen } = scripted([
      // A search straight away, on the place the site picked.
      (s) => [{ name: "type", input: { ref: ref(s, /Search for products/), text: "dark chocolate", submit: true } }],
      // The place's own field is how it gets set: never held back.
      (_s, all) => [{ name: "type", input: { ref: ref(all, /Search for area/), text: "Koramangala, Bengaluru", submit: true } }],
      () => [{ name: "note", input: { text: "Place: Koramangala, Bengaluru (shown as Delivering to: Koramangala, Bengaluru)" } }],
      (_s, all) => [{ name: "type", input: { ref: ref(all, /Search for products/), text: "dark chocolate", submit: true } }],
      () => [{ name: "done", input: { success: true, result: "searched" } }],
    ]);
    await new Agent(p, { client, model: "fake", policy: { check: () => ({ kind: "allow" as const }) }, contextEditing: false, fastSettle: true, enableNotes: true, ...(placeFirst === undefined ? {} : { placeFirst: () => placeFirst }) }).run("add dark chocolate to my cart");
    const out = await p.main.evaluate<string>("document.getElementById('out').textContent");
    await p.close();
    return { seen, out };
  };

  it("held back until the place is set and noted, then searched in that place", async () => {
    const { seen, out } = await run(true);
    if (process.env["PLACE_DEBUG"]) console.log(seen.map((s, i) => `--- ${i}: ${s.slice(0, 700)}`).join(" ||| "));
    expect(seen[1]).toMatch(/Not yet: this site works by place/);
    expect(seen[2]).not.toMatch(/Not yet/);
    expect(out).toBe("Results for dark chocolate in Koramangala, Bengaluru");
  }, 60_000);

  it("no gate for a site not read as working by place (as before): the first search goes through in the site's own pick", async () => {
    for (const flag of [undefined, false]) {
      const { seen } = await run(flag);
      expect(seen[1]).not.toMatch(/Not yet: this site works by place/);
    }
  }, 90_000);

  it("held twice at most: a site whose place cannot be set never blocks the run", async () => {
    const p = await browser.newPage();
    await p.navigate(origin + "/");
    const search = (s: string, all: string): Turn => [{ name: "type", input: { ref: ref(`${s}\n${all}`, /Search for products/), text: "dark chocolate", submit: true } }];
    const { client, seen } = scripted([search, search, search, () => [{ name: "done", input: { success: true, result: "ok" } }]]);
    await new Agent(p, { client, model: "fake", policy: { check: () => ({ kind: "allow" as const }) }, contextEditing: false, fastSettle: true, enableNotes: true, placeFirst: () => true }).run("add dark chocolate to my cart");
    const held = seen.filter((s) => /Not yet: this site works by place/.test(s)).length;
    expect(held).toBe(2);
    expect(await p.main.evaluate<string>("document.getElementById('out').textContent")).toBe("Results for dark chocolate in Puducherry");
    await p.close();
  }, 60_000);
});
