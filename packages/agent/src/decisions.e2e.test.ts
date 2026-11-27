// How the executor decides to go on, stop or take a done (27 Nov review), on local pages with a scripted model (no API
// tokens): each case is one that misfired before.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, type Browser } from "@pilotfish/browser";
import { Agent } from "./index.js";
import { CUT_OFFS } from "./agent.js";

const E2E = process.env.PILOTFISH_E2E === "1";

type Turn = Array<{ name: string; input: Record<string, unknown> }> | { text: string; stop?: string };

function lastSeen(params: Anthropic.MessageCreateParams): string {
  const m = [...params.messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
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
  add(m.content);
  return parts.join("\n");
}

function scripted(next: (seen: string, turn: number) => Turn): { client: Anthropic; requests: Anthropic.MessageCreateParams[] } {
  const requests: Anthropic.MessageCreateParams[] = [];
  let i = 0;
  const create = async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    requests.push(params);
    const turn = next(lastSeen(params), i++);
    const content = Array.isArray(turn) ? turn.map((t, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: t.name, input: t.input })) : [{ type: "text", text: turn.text }];
    const stop = Array.isArray(turn) ? (content.length ? "tool_use" : "end_turn") : (turn.stop ?? "end_turn");
    return { id: `msg_${i}`, type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
  };
  return { client: { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic, requests };
}

const refOf = (text: string, re: RegExp): string | null => {
  for (const line of text.split("\n")) {
    const m = /^\s*\*?\[((?:f\d+)?e\d+)\]/.exec(line);
    if (m && re.test(line)) return m[1]!;
  }
  return null;
};

const allow = { check: () => ({ kind: "allow" as const }) };
const told = (requests: Anthropic.MessageCreateParams[]) => JSON.stringify(requests.map((r) => r.messages));

describe.skipIf(!E2E)("when the executor goes on, stops or takes a done (scripted model)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  const posts: string[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST") {
        posts.push(url.pathname);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (url.pathname === "/list") return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>List</title></head><body><h1>Results for ${url.searchParams.get("d") ?? "-"}</h1><button id="stuck">Load</button><p>Price ${100 + Number(url.searchParams.get("d") ?? 0)}</p></body></html>`);
      if (url.pathname === "/form") return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body><form id="f"><label for="n">Name</label><input id="n" name="name"><button id="go" type="submit" disabled>Send</button></form>
<script>
  // Every key autosaves (a first-party write); the submit stays disabled whatever is typed (the page wants more).
  document.getElementById('n').addEventListener('input', () => fetch('/autosave', { method: 'POST', body: 'x' }));
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); fetch('/send', { method: 'POST' }); });
</script></body></html>`);
      res.end("<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("three different addresses opened in a row are no loop; the same dead click three times is", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/list?d=0`);
    const { client, requests } = scripted((seen, n) => (n < 3 ? [{ name: "navigate", input: { url: `${origin}/list?d=${n + 1}` } }] : [{ name: "done", input: { success: true, result: "Compared three dates." } }]));
    await new Agent(p, { client, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 10 }).run("compare the prices of three dates");
    expect(told(requests)).not.toMatch(/repeated the same action/);
    // A click that does nothing, three times.
    const { client: c2, requests: r2 } = scripted((seen, n) => {
      const b = refOf(seen, /<button[^\n]*>Load/) ?? "e1";
      return n < 3 ? [{ name: "click", input: { ref: b } }] : [{ name: "done", input: { success: false, result: "The Load button did nothing." } }];
    });
    await new Agent(p, { client: c2, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 10 }).run("load more results");
    expect(told(r2)).toMatch(/repeated the same action \(click e\d+ with the same input\) three times/);
    await p.close();
  }, 60_000);

  it("a keep-going note is no failed action: with one real failure after it, no failures stall", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/list?d=1`);
    const stalls: string[] = [];
    const { client } = scripted((seen, n) =>
      n === 0 ? [{ name: "done", input: { success: false, result: "I only looked at one date." } }] : n === 1 ? [{ name: "click", input: { ref: "e999" } }] : [{ name: "done", input: { success: true, result: "Price 101 for date 1." } }],
    );
    await new Agent(p, { client, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 40, onStall: async (k) => (stalls.push(k), null) }).run("compare the prices of ten dates");
    expect(stalls).not.toContain("failures");
    await p.close();
  }, 60_000);

  it("a prose give-up with most steps left is sent back once; a second one ends the leg not done", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/list?d=1`);
    const { client, requests } = scripted((seen, n) =>
      n === 0 ? [{ name: "read_page", input: {} }] : n === 1 ? { text: "I could not find prices for the other nine dates on this site." } : { text: "I could not find prices for the other dates; the site shows only one date per page." },
    );
    const r = await new Agent(p, { client, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 40, proseIsDone: true }).run("compare the prices of ten dates");
    expect(told(requests)).toMatch(/Not yet: \d+ of your steps are left/);
    expect(r.success).toBe(false);
    // A prose answer is still taken as done.
    const { client: c2 } = scripted((seen, n) => (n === 0 ? [{ name: "read_page", input: {} }] : { text: "The price for date 1 is 101, shown on the results page." }));
    const r2 = await new Agent(p, { client: c2, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 40, proseIsDone: true }).run("tell me the price for date 1");
    expect(r2.success).toBe(true);
    await p.close();
  }, 60_000);

  it("replies cut off at the output limit end the leg after a few in a row, the second telling how to answer short", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/list?d=1`);
    const { client, requests } = scripted(() => ({ text: "Here are all the rows: 1, 2, 3", stop: "max_tokens" }));
    const r = await new Agent(p, { client, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 40 }).run("list every row");
    expect(requests.length).toBe(CUT_OFFS + 1);
    expect(r.success).toBe(false);
    expect(told(requests)).toMatch(/keep getting cut off at the output limit/);
    await p.close();
  }, 60_000);

  it("a done after a wait that changed nothing is taken; after a click that changed nothing it is held back", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/list?d=1`);
    const { client } = scripted(() => [{ name: "wait", input: { seconds: 1 } }, { name: "done", input: { success: true, result: "Price 101." } }]);
    expect((await new Agent(p, { client, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 10 }).run("read the price")).success).toBe(true);
    // The first click moves focus to the button (a change); the second does nothing at all.
    let load = "e1";
    const { client: c2, requests } = scripted((seen, n) => {
      load = refOf(seen, /<button[^\n]*>Load/) ?? load;
      if (n === 0) return [{ name: "click", input: { ref: load } }];
      if (n === 1) return [{ name: "click", input: { ref: load } }, { name: "done", input: { success: true, result: "Loaded." } }];
      return [{ name: "done", input: { success: true, result: "Price 101." } }];
    });
    await new Agent(p, { client: c2, model: "fake", policy: allow, contextEditing: false, fastSettle: true, maxSteps: 10 }).run("load and read the price");
    expect(told(requests)).toMatch(/done refused: .* had no observable effect/);
    await p.close();
  }, 60_000);

  it("a submit the page keeps disabled is not pressed, and an autosave while typing is no answer to a submit", async () => {
    posts.length = 0;
    const p = await browser.newPage();
    await p.navigate(`${origin}/form`);
    let finished = false;
    const { client, requests } = scripted((seen, n) => {
      if (n === 0) return [{ name: "fill", input: { fields: [{ ref: refOf(seen, /<input[^\n]*name="name"/) ?? "e1", value: "Ada" }], submit_ref: refOf(seen, /<button[^\n]*>Send/) ?? "e2" } }];
      return [{ name: "done", input: { success: false, result: "The Send button stays disabled." } }];
    });
    await new Agent(p, {
      client,
      model: "fake",
      policy: allow,
      contextEditing: false,
      fastSettle: true,
      enableFill: true,
      maxSteps: 4,
      finishWhen: (name, input, e) => (name === "fill" && e && e.writes?.some((w) => w.ok) ? ((finished = true), "submitted") : null),
    }).run("send the form with the name Ada");
    await p.close();
    expect(told(requests)).toMatch(/is still disabled, so it was NOT clicked/);
    expect(posts).not.toContain("/send");
    expect(finished).toBe(false);
  }, 60_000);
});
