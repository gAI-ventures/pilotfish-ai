// MCP server e2e: an in-process server on an in-memory transport and a real (headless) Chromium, with
// no model anywhere: the test plays the client's model. Direct tools return evidence and keep secret
// values out of every result; a client that can ask its person (elicitation) confirms an irreversible
// click. And the real CLI, started over stdio with every API key unset, lists its tools and serves
// browser calls without a single model request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import { createMcpServer, type PilotfishMcp } from "./server.js";

const E2E = process.env.PILOTFISH_E2E === "1";
const SECRET = "hunter2-xyz";

// A long results page: 60 cards, each a title link, a price and a button, about 140 px apart.
const RESULTS_HTML = `<!doctype html><html><head><title>Results</title><style>.card{height:120px;margin:10px;border:1px solid #ccc}</style></head><body><h1>Results</h1>${Array.from(
  { length: 60 },
  (_, i) => `<div class="card"><a href="#r${i + 1}">Result ${i + 1} title</a><p>Price $${(i + 1) * 3}.00</p><button>Add ${i + 1}</button></div>`,
).join("")}</body></html>`;

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Console</title></head><body>
<h1>Console</h1>
<button id="go" onclick="document.getElementById('out').textContent='Launched the probe'">Launch</button>
<button id="del" onclick="document.getElementById('out').textContent='Draft deleted'">Delete draft</button>
<p id="out"></p>
<label for="tok">Access token</label><input id="tok" type="text">
<label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select>
<p><a href="/otp">Verify</a></p>
</body></html>`;

const OTP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Verify your identity</title></head>
<body><main style="width:420px;margin:60px auto">
<h1>Enter verification code</h1>
<p>Enter the 6-digit code we sent to <strong>•••1234</strong>. It expires in 10 minutes.</p>
<form onsubmit="event.preventDefault()"><div>
${[1, 2, 3, 4, 5, 6].map((i) => `<input type="text" inputmode="numeric" maxlength="1" aria-label="Digit ${i}" autocomplete="off" style="width:40px">`).join("\n")}
</div><button type="submit">Verify</button></form>
</main>
<script>
  document.addEventListener('input', () => {
    const v = [...document.querySelectorAll('input')].map((i) => i.value).join('');
    if (v.length === 6) { document.body.dataset.code = v; document.querySelector('main').innerHTML = '<h1>Account</h1><p>Welcome back, Ada.</p>'; }
  });
</script></body></html>`;

// Pages only a person can pass, and one nobody can.
const SIGNIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body><main style="width:380px;margin:60px auto">
<h1>Sign in to your account</h1><form onsubmit="event.preventDefault()"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>
<p><a href="/forgot">Forgot your password?</a></p></main></body></html>`;
const ROBOT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Security check</title></head><body><h1>Are you a robot?</h1>
<p>Please complete the security check to continue.</p><div style="width:300px;height:80px;border:1px solid #999">I'm not a robot</div></body></html>`;
const BLOCKED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Attention Required! | Cloudflare</title></head><body>
<h1>Sorry, you have been blocked</h1><p>You are unable to access this site.</p><p>Cloudflare Ray ID: 8f2a1b3c4d5e6f70</p></body></html>`;

// Results that are still loading: an interim price under the page's own progress bar, the final one 1.5 s later.
const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Flights</title></head><body><h1>Flights</h1>
<div role="tablist"><div role="tab" aria-selected="true">Best</div><div role="tab" id="cheap">Cheapest from ₹10,041 <div role="progressbar" aria-label="Fetching results" style="width:80px;height:4px;background:#36c"></div></div></div>
<p role="meter" aria-valuenow="65">Rated 4.3</p><div role="progressbar" aria-valuenow="65" aria-label="5 star" style="width:80px;height:6px;background:#fa0"></div>
<script>setTimeout(() => { document.getElementById('cheap').textContent = 'Cheapest from ₹9,564'; }, 1500);</script></body></html>`;
const SPINNER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Spinner</title></head><body><h1>Always busy</h1>
<div role="progressbar" style="width:40px;height:40px;background:#ccc"></div><button onclick="this.textContent='Pressed'">Press</button></body></html>`;

const textOf = (r: unknown): string => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

async function connect(pf: PilotfishMcp, capabilities: ConstructorParameters<typeof Client>[1] = {}): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await pf.server.connect(serverSide);
  const client = new Client({ name: "e2e", version: "1" }, capabilities);
  await client.connect(clientSide);
  return client;
}

describe.skipIf(!E2E)("mcp server e2e", () => {
  let site: Server;
  let origin: string;
  let pf: PilotfishMcp;
  let client: Client;

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const u = req.url ?? "/";
      res.end(u.startsWith("/loading") ? LOADING_HTML : u.startsWith("/spinner") ? SPINNER_HTML : u.startsWith("/otp") ? OTP_HTML : u.startsWith("/results") ? RESULTS_HTML : u.startsWith("/signin") ? SIGNIN_HTML : u.startsWith("/robot") ? ROBOT_HTML : u.startsWith("/blocked") ? BLOCKED_HTML : HOME_HTML);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const config: McpConfig = {
      headless: true,
      allowedHosts: ["127.0.0.1"],
      allowPrivateNetwork: true,
      secrets: { pw: { value: SECRET } },
      interventionTimeoutMs: 30_000,
      allowScreenshots: true,
    };
    pf = createMcpServer({ config });
    client = await connect(pf);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await pf?.close();
    site?.close();
  });

  it("drives the page with direct tools: refs, evidence, policy, no secret values", async () => {
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } });
    expect(nav.isError, textOf(nav)).toBeFalsy();
    expect(textOf(nav)).toContain("EVIDENCE");
    expect(textOf(nav)).toContain(`navigated: about:blank → ${origin}/`);

    const snap = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const ref = (re: RegExp) => {
      const m = re.exec(snap);
      if (!m) throw new Error(`no match for ${re} in:\n${snap}`);
      return m[1]!;
    };
    const launch = ref(/\[(e\d+)\]<button[^\n]*Launch/);
    const token = ref(/\[(e\d+)\]<input[^\n]*id="tok"/);
    const size = ref(/\[(e\d+)\]<select[^\n]*/);

    const click = textOf(await client.callTool({ name: "browser_click", arguments: { ref: launch } }));
    expect(click).toContain("EVIDENCE");
    expect(click).toContain("Launched the probe");

    // The value is typed by the broker; every result shows the placeholder instead.
    const typed = await client.callTool({ name: "browser_type", arguments: { ref: token, text: "{{pw}}" } });
    expect(typed.isError).toBeFalsy();
    expect(textOf(typed)).toContain("{{pw}}");
    expect(textOf(typed)).not.toContain(SECRET);
    const pageText = textOf(await client.callTool({ name: "browser_get_text", arguments: {} }));
    expect(pageText).toContain("Launched the probe");
    expect(pageText).not.toContain(SECRET);

    // Reading only what is needed: a read-only expression (secrets masked, writes refused), refs by words, a capped text.
    const q = await client.callTool({ name: "browser_query", arguments: { expression: "[document.title, document.getElementById('tok').value]" } });
    expect(q.isError).toBeFalsy();
    expect(textOf(q)).not.toContain(SECRET);
    expect(q.structuredContent).toBeUndefined();
    // With a schema: the same reply plus the value; a result that does not match is an error naming where.
    const expression = "[document.title, document.getElementById('tok').value]";
    const typedQ = await client.callTool({ name: "browser_query", arguments: { expression, schema: { type: "array", items: { type: "string" }, minItems: 2 } } });
    expect(typedQ.isError).toBeFalsy();
    expect(textOf(typedQ)).toBe(textOf(q));
    expect((typedQ.structuredContent as { value: string[] }).value[0]).toBe("Console");
    expect(JSON.stringify(typedQ.structuredContent)).not.toContain(SECRET);
    const wrong = await client.callTool({ name: "browser_query", arguments: { expression, schema: { type: "array", items: { type: "number" } } } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toMatch(/^ERROR schema_mismatch\n\/0: must be number\n\/1: must be number\nNext: fix the expression and run browser_query again\.$/);
    expect(textOf(wrong)).not.toContain(SECRET);
    const write = await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('button').click()" } });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/read-only/i);
    const found = textOf(await client.callTool({ name: "browser_find", arguments: { query: "Launch button" } }));
    expect(found).toMatch(/\[e\d+\]<button[^\n]*Launch/);
    const short = textOf(await client.callTool({ name: "browser_get_text", arguments: { max_chars: 500 } }));
    expect(short.length).toBeLessThan(700);
    expect((await client.callTool({ name: "browser_wait", arguments: { seconds: 0.5 } })).isError).toBeFalsy();
    // Several steps in one call: they run in order, and stop at the first that fails.
    const batch = textOf(await client.callTool({ name: "browser_actions", arguments: { actions: [{ action: "select", ref: size, values: ["Small"] }, { action: "press", key: "Tab" }] } }));
    expect(batch).toMatch(/^1\. [^\n]*\n2\. /);
    const broken = await client.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: "e999" }, { action: "press", key: "Tab" }] } });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toMatch(/1\. FAILED[^\n]*\nStopped: steps 2-2 were not run/);

    const selected = textOf(await client.callTool({ name: "browser_select", arguments: { ref: size, values: ["Large"] } }));
    expect(selected).toContain("Selected: Large");

    expect((await client.callTool({ name: "browser_press", arguments: { key: "Tab" } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "browser_scroll", arguments: { direction: "down" } })).isError).toBeFalsy();

    const shot = (await client.callTool({ name: "browser_screenshot", arguments: {} })) as CallToolResult;
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

    expect(textOf(await client.callTool({ name: "browser_tabs", arguments: {} }))).toBe(`t1 (current) ${origin}/`);

    // A stale or unknown ref fails with a reason instead of clicking something else.
    const missing = await client.callTool({ name: "browser_click", arguments: { ref: "e999" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No element with ref e999/);

    // An irreversible-looking click needs a person; this client cannot ask one (no elicitation).
    const del = await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Delete draft/) } });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/Blocked by policy: Target looks irreversible.*cannot ask/);

    // Policy before action: only 127.0.0.1 is allowed (localhost is another host).
    const blocked = await client.callTool({ name: "browser_navigate", arguments: { url: origin.replace("127.0.0.1", "localhost") + "/" } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain("Blocked by policy");
  }, 90_000);

  it("asks the person through elicitation when the client supports it: an irreversible click goes ahead on their yes", async () => {
    // A second connection (same browser) whose client can show forms to its user.
    const second = createMcpServer({ session: pf.session });
    const asker = await connect(second, { capabilities: { elicitation: {} } });
    const asked: string[] = [];
    asker.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push((req.params as { message: string }).message);
      return { action: "accept", content: { answer: "yes" } };
    });
    try {
      // The irreversible click the first client could not make goes ahead once the person confirms.
      await asker.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } });
      const snap = textOf(await asker.callTool({ name: "browser_snapshot", arguments: {} }));
      const del = /\[(e\d+)\]<button[^\n]*Delete draft/.exec(snap)?.[1];
      const clicked = await asker.callTool({ name: "browser_click", arguments: { ref: del! } });
      expect(clicked.isError).toBeFalsy();
      expect(textOf(clicked)).toContain("Draft deleted");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^Confirm action Press “Delete draft” on 127\.0\.0\.1\? It deletes or removes something\./);
    } finally {
      await asker.close();
      await second.close();
    }
  }, 120_000);

  it("an action returns the visible screen of a long results page, with counts; refs below it work after a scroll (4 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results` } }));
    expect(nav).toContain("Result 1 ");
    expect(nav).not.toContain("Result 60 ");
    expect(nav).toMatch(/\((\d+) interactive elements below the viewport; scroll down to reveal\)/);
    const below = Number(/\((\d+) interactive elements below the viewport/.exec(nav)![1]);
    expect(below).toBeGreaterThan(40);
    // browser_snapshot still gives three screens, whole_page everything.
    const three = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const refsShown = (t: string) => (t.slice(t.indexOf("PAGE SNAPSHOT")).match(/\[e\d+\]/g) ?? []).length;
    expect(refsShown(three)).toBeGreaterThan(refsShown(nav) * 1.8);
    expect(textOf(await client.callTool({ name: "browser_snapshot", arguments: { whole_page: true } }))).toContain("Result 60 ");
    // A scroll brings the next screen and its refs, which click.
    let seen = nav;
    for (let i = 0; i < 12 && !/\[(e\d+)\]<a[^\n]*Result 30 /.test(seen); i++) seen = textOf(await client.callTool({ name: "browser_scroll", arguments: { direction: "down" } }));
    const r30 = /\[(e\d+)\]<a[^\n]*Result 30 /.exec(seen)![1]!;
    expect(seen).toMatch(/interactive elements above the viewport/);
    const clicked = textOf(await client.callTool({ name: "browser_click", arguments: { ref: r30 } }));
    expect(clicked).toContain("/results#r30");
    // Any hint for more names this server's tools, never the agent's own.
    expect(nav + three + seen).not.toMatch(/read_page\(rootRef\)|use find\(\)/);
  });

  it("a page only a person can pass says so in the result; browser_resume waits for them and goes on (4 Nov)", async () => {
    // A sign-in: what it needs, where (the pilotfish window), and what to call after; no attempt to get past it.
    // Headless (this server): it says so, since nobody can sign in by hand there.
    const headless = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/signin` } }));
    expect(headless).toMatch(/NEEDS A PERSON \(login[^)]*\): .*asks to sign in/);
    expect(headless).toContain("This browser is headless");
    expect(headless).toContain("Docs: https://pilotfish.gai.ventures/docs/open-settings");
    // With a window (the default where one can be shown): the person does it there, then browser_resume.
    pf.session.config.headless = false;
    const signin = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/signin` } }));
    expect(signin).toMatch(/NEEDS A PERSON \(login[^)]*\): .*asks to sign in/);
    expect(signin).toContain("pilotfish browser window is open on it");
    expect(signin).toContain("browser_resume");
    expect(signin).toMatch(/\nDocs: https:\/\/pilotfish\.gai\.ventures\/docs\/open$/);
    // Still there: browser_resume says so (not an error), with the same request.
    const waiting = await client.callTool({ name: "browser_resume", arguments: { timeout_s: 5 } });
    expect(waiting.isError).toBeFalsy();
    expect(textOf(waiting)).toMatch(/NEEDS A PERSON \(login[\s\S]*Still waiting after 5 s/);
    // The person signs in in the window (here: the page moves on); browser_resume returns the page as it is now.
    const tab = await pf.session.page();
    const resumed = client.callTool({ name: "browser_resume", arguments: { timeout_s: 30 } });
    setTimeout(() => void tab.navigate(`${origin}/`).catch(() => undefined), 1_500);
    const after = textOf(await resumed);
    expect(after).toContain("The page needs nobody now");
    expect(after).toContain("Launch");
    // A one-time code: the person types it in the window; a CAPTCHA: the person solves it; a block: nobody can.
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/otp` } }))).toMatch(/NEEDS A PERSON \(otp[^)]*\): [^\n]*Please type the code/);
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/robot` } }))).toMatch(/NEEDS A PERSON \(captcha/);
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/blocked` } }))).toMatch(/BLOCKED: .*refused automated access/);
    // An ordinary page: nothing added.
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } }))).not.toMatch(/NEEDS A PERSON|BLOCKED|STOP:/);
    pf.session.config.headless = true;
  }, 120_000);

  it("each screen once: an action on a page just shown returns the lines that changed; navigate can leave the screen out (4 Nov)", async () => {
    await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results` } });
    const home = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } }));
    expect(home).toContain("PAGE SNAPSHOT");
    expect(home).toContain("<h1>Console");
    expect(home.slice(home.indexOf("PAGE SNAPSHOT"))).not.toMatch(/<\/(button|h1|label)>/);
    const launch = /\[(e\d+)\]<button[^\n]*Launch/.exec(home)![1]!;
    const click = textOf(await client.callTool({ name: "browser_click", arguments: { ref: launch } }));
    expect(click).toContain("EVIDENCE");
    expect(click).toMatch(/PAGE SNAPSHOT \([^)]*\): CHANGES ONLY since the page snapshot 1 browser result back/);
    expect(click).toContain("Launched the probe");
    // Lines it already has are not repeated, and their refs still work.
    expect(click).not.toContain("Access token");
    const size = /\[(e\d+)\]<select/.exec(home)![1]!;
    expect((await client.callTool({ name: "browser_select", arguments: { ref: size, values: ["Large"] } })).isError).toBeFalsy();
    // snapshot:false: what happened, no screen; browser_snapshot shows it.
    const quiet = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results`, snapshot: false } }));
    expect(quiet).toContain(`navigated: ${origin}/ → ${origin}/results`);
    expect(quiet).toContain("No page snapshot, as asked");
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    expect(quiet).not.toContain("Result 1 ");
    expect(textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }))).toContain("Result 1 ");
  }, 60_000);

  it("a page that says it is still loading is shown once it has finished; a spinner that never stops is waited for once (4 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/loading` } }));
    expect(nav).toMatch(/Waited \d+\.\d s for the page's own loading indicator to finish/);
    expect(nav).toContain("Cheapest from ₹9,564");
    expect(nav).not.toContain("₹10,041");
    // The rating bar (aria-valuenow 65) stayed on that page: a determinate bar is not loading, so the wait ended.
    // An indeterminate bar that never stops: one wait, a note, and no second wait on the same page.
    const spin = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/spinner` } }));
    expect(spin).toMatch(/still shows "loading" after 6\.\d s/);
    const press = /\[(e\d+)\]<button[^\n]*Press/.exec(spin)![1]!;
    const t0 = Date.now();
    const pressed = textOf(await client.callTool({ name: "browser_click", arguments: { ref: press } }));
    expect(pressed).toContain("Pressed");
    expect(pressed).not.toContain("still shows");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);

  it("closes the browser; the next call starts a fresh one", async () => {
    expect(pf.session.launched).toBe(true);
    expect(textOf(await client.callTool({ name: "browser_close", arguments: {} }))).toBe("Closed the browser.");
    expect(pf.session.launched).toBe(false);
  }, 30_000);
});

// The CLI as an MCP client starts it, over stdio: packages/mcp/dist/cli.js, or the npm package's cli.js when
// PILOTFISH_MCP_CLI names one (the release workflow points it at the packed package, installed as a user would).
describe.skipIf(!E2E)("the CLI over stdio, with no API key", () => {
  const cli = process.env["PILOTFISH_MCP_CLI"] || fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  /** The version the CLI must report: the installed npm package's own, or 0.0.0-dev for a build from this repository. */
  const expectedVersion = (): string =>
    process.env["PILOTFISH_MCP_CLI"] ? (JSON.parse(readFileSync(join(dirname(cli), "package.json"), "utf8")) as { version: string }).version : "0.0.0-dev";
  let site: Server;
  let origin: string;
  let provider: Server;
  let providerUrl: string;
  const modelCalls: string[] = [];

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const u = req.url ?? "/";
      res.end(u.startsWith("/signin") ? SIGNIN_HTML : u.startsWith("/loading") ? LOADING_HTML : HOME_HTML);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    // Where a model client would send its requests, were one made: a stand-in that records them.
    provider = createServer((req, res) => {
      modelCalls.push(`${req.method} ${req.url}`);
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    site?.close();
    provider?.close();
  });

  /** Starts the CLI with this machine's environment minus every key, token and model setting. */
  async function start(settings: Record<string, string>): Promise<{ client: Client; stderr: () => string }> {
    expect(existsSync(cli), `${cli} is missing: npm run build first`).toBe(true);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/API_KEY|AUTH_TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^PILOTFISH_/i.test(k)) env[k] = v;
    for (const k of ["PILOTFISH_CHROME", "PILOTFISH_ADBLOCK_OFFLINE"]) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, { PILOTFISH_HEADLESS: "1", ANTHROPIC_BASE_URL: providerUrl, OPENAI_BASE_URL: providerUrl, ...settings });
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) expect(env[k]).toBeUndefined();
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: "pipe" });
    let err = "";
    transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const client = new Client({ name: "stdio-e2e", version: "1" });
    await client.connect(transport);
    return { client, stderr: () => err };
  }

  it("lists only the browser tools and drives the page: refs, a secret, reading, policy, a person's page, no model request", async () => {
    const { client, stderr } = await start({ PILOTFISH_ALLOWED_HOSTS: "127.0.0.1", PILOTFISH_ALLOW_PRIVATE: "1", PILOTFISH_SECRETS: JSON.stringify({ pw: SECRET }) });
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as CallToolResult;
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("browser_navigate");
      expect(names.filter((n) => !n.startsWith("browser_") || n === "browser_task" || n === "browser_intervention")).toEqual([]);
      expect(client.getInstructions()).not.toMatch(/browser_task|API key/i);
      expect(client.getInstructions()).toContain("{{pw}}");
      // Its real version, to MCP clients and on the command line.
      expect(client.getServerVersion()).toMatchObject({ name: "pilotfish", version: expectedVersion() });
      expect((await promisify(execFile)(process.execPath, [cli, "--version"])).stdout.trim()).toBe(expectedVersion());

      const nav = await call("browser_navigate", { url: `${origin}/` });
      expect(nav.isError, `${textOf(nav)}\n${stderr()}`).toBeFalsy();
      expect(textOf(nav)).toContain("EVIDENCE");
      const snap = textOf(await call("browser_snapshot"));
      const ref = (re: RegExp) => re.exec(snap)?.[1] ?? "";
      expect(textOf(await call("browser_click", { ref: ref(/\[(e\d+)\]<button[^\n]*Launch/) }))).toContain("Launched the probe");
      // The secret is typed by name; no result shows its value.
      const typed = textOf(await call("browser_type", { ref: ref(/\[(e\d+)\]<input[^\n]*id="tok"/), text: "{{pw}}" }));
      expect(typed).toContain("{{pw}}");
      expect(typed + textOf(await call("browser_get_text"))).not.toContain(SECRET);
      expect(textOf(await call("browser_query", { expression: "document.title" }))).toContain("Console");
      expect(textOf(await call("browser_find", { query: "Launch button" }))).toMatch(/\[e\d+\]<button[^\n]*Launch/);
      expect(textOf(await call("browser_actions", { actions: [{ action: "select", ref: ref(/\[(e\d+)\]<select/), values: ["Large"] }, { action: "press", key: "Tab" }] }))).toMatch(/^1\. [^\n]*\n2\. /);
      // Secrets configured: no screenshot. An irreversible click needs a person this client cannot ask.
      expect(textOf(await call("browser_screenshot"))).toMatch(/Screenshots are off/);
      expect(textOf(await call("browser_click", { ref: ref(/\[(e\d+)\]<button[^\n]*Delete draft/) }))).toMatch(/Blocked by policy: Target looks irreversible.*cannot ask/);
      // A page still loading is shown once it has finished; a sign-in comes back for a person.
      expect(textOf(await call("browser_navigate", { url: `${origin}/loading` }))).toContain("Cheapest from ₹9,564");
      const signin = textOf(await call("browser_navigate", { url: `${origin}/signin` }));
      expect(signin).toMatch(/NEEDS A PERSON \(login[^)]*\)/);
      expect(signin).toContain("This browser is headless");
      expect(textOf(await call("browser_close"))).toBe("Closed the browser.");
      expect(modelCalls).toEqual([]);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("keeps the browser off private networks unless PILOTFISH_ALLOW_PRIVATE is set", async () => {
    const { client } = await start({});
    try {
      for (const url of [`${origin}/`, "http://10.1.2.3/"]) {
        const r = (await client.callTool({ name: "browser_navigate", arguments: { url } }, undefined, { timeout: 60_000 })) as CallToolResult;
        expect(r.isError, url).toBe(true);
        expect(textOf(r)).toMatch(/Blocked by policy: Navigation to private\/loopback address/);
      }
      await client.callTool({ name: "browser_close", arguments: {} });
    } finally {
      await client.close();
    }
    expect(modelCalls).toEqual([]);
  }, 120_000);
});
