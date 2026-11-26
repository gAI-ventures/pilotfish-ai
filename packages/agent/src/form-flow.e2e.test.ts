// Two steps a run missed on a code host (26 Nov), on local pages with a scripted model (no API tokens):
//  - a form sent in the same step its name was typed in, while the page still checked the name ("Checking
//    availability..."): the page ignores a submit until its check answers, so the press did nothing;
//  - a confirmation dialog the model's own click opened ("Make this public?", a line of text and one button), closed
//    at once by the harness's auto-dismiss as a content-free popup, so the model never saw it.
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
    const content = turn.map((t, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: t.name, input: t.input }));
    return {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content,
      stop_reason: content.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
  };
  return { client: { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic, requests };
}

/** The ref on the snapshot line whose element matches `re` (a line that starts with the ref, not a "removed" list). */
const refOf = (text: string, re: RegExp): string | null => {
  for (const line of text.split("\n")) {
    const m = /^\s*\*?\[((?:f\d+)?e\d+)\]/.exec(line);
    if (m && re.test(line)) return m[1]!;
  }
  return null;
};

const NEW_REPO = `<!doctype html><html><head><meta charset="utf-8"><title>New repository</title></head><body>
<h1>Create a new repository</h1>
<form id="f"><label for="n">Repository name</label> <input id="n" name="name" autocomplete="off"><p id="st"></p>
<p>Great names are short and memorable.</p><button id="go" type="submit">Create repository</button></form>
<script>
  const n = document.getElementById('n'), st = document.getElementById('st'), f = document.getElementById('f');
  let checking = false, ok = false, timer = 0;
  n.addEventListener('input', () => {
    ok = false; checking = true; st.textContent = 'Checking availability...';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await fetch('/check?name=' + encodeURIComponent(n.value)).then((x) => x.json());
      checking = false; ok = r.ok; st.textContent = ok ? 'Available.' : 'Taken.';
    }, 300);
  });
  // The page sends nothing while its check has not answered (a press then does nothing).
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (checking || !ok) return;
    await fetch('/create', { method: 'POST', body: n.value });
    document.body.innerHTML = '<h1>Repository created</h1><p>' + n.value + '</p>';
  });
</script></body></html>`;

const SETTINGS = `<!doctype html><html><head><meta charset="utf-8"><title>Settings</title></head><body>
<h1>Danger Zone</h1><p>Change repository visibility. This repository is currently private.</p>
<button id="pub" type="button">Change to public</button>
<dialog id="d" role="dialog" aria-modal="true" aria-labelledby="dh"><h2 id="dh">Make this repository public</h2><p>0 stars, 0 watchers</p><button id="x" type="button" aria-label="Close">×</button><button id="yes" type="button">I want to make this repository public</button></dialog>
<script>
  const d = document.getElementById('d');
  document.getElementById('pub').addEventListener('click', () => d.showModal());
  document.getElementById('x').addEventListener('click', () => d.close());
  document.getElementById('yes').addEventListener('click', async () => { await fetch('/public', { method: 'POST' }); d.close(); document.body.innerHTML = '<h1>This repository is now public</h1>'; });
</script></body></html>`;

// The same settings page, long, where the last confirmation asks the person to prove it is them again in a dialog over it.
const SETTINGS_SUDO = `<!doctype html><html><head><meta charset="utf-8"><title>Settings</title></head><body>
<h1>General</h1><h2>Danger Zone</h2><p>This repository is currently private.</p><button id="pub" type="button">Change to public</button>
${Array.from({ length: 60 }, (_, i) => `<h3>Setting ${i}</h3><p>Explains what setting number ${i} does for this repository and who it affects.</p>`).join("")}
<dialog id="sudo" role="dialog" aria-modal="true"><h2>Confirm access</h2><p>Signed in as @ada</p><a href="#" id="mail">Verify via email</a> <a href="#">Use your password</a></dialog>
<script>
  document.getElementById('pub').addEventListener('click', () => document.getElementById('sudo').showModal());
</script></body></html>`;

describe.skipIf(!E2E)("steps a run missed on a form and a confirmation dialog (scripted model)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  const posts: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST") {
        posts.push(url.pathname);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (url.pathname === "/check") {
        // The name check answers a moment later, as a server does.
        return void setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 400);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(url.pathname === "/new" ? NEW_REPO : url.pathname === "/settings" ? SETTINGS : url.pathname === "/settings-sudo" ? SETTINGS_SUDO : "<h1>Home</h1>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("a form filled and sent in one step is sent once the page has checked what was typed", async () => {
    posts.length = 0;
    const p = await browser.newPage();
    await p.navigate(`${origin}/new`);
    let filled = false;
    const { client } = scripted((seen) => {
      if (/Repository created/.test(seen)) return [{ name: "done", input: { success: true, result: "Created." } }];
      const name = refOf(seen, /<input[^\n]*name="name"/);
      const go = refOf(seen, /<button[^\n]*>Create repository/);
      if (!filled && name && go) {
        filled = true;
        return [{ name: "fill", input: { fields: [{ ref: name, value: "apply-jobs" }], submit_ref: go } }];
      }
      return [{ name: "done", input: { success: false, result: "The form is still open." } }];
    });
    const r = await new Agent(p, { client, model: "fake", policy: { check: () => ({ kind: "allow" as const }) }, contextEditing: false, fastSettle: true, enableFill: true, maxSteps: 6 }).run("create a repository called apply-jobs");
    await p.close();
    expect(posts).toEqual(["/create"]);
    expect(r.success).toBe(true);
  }, 60_000);

  it("a name typed with Enter is sent once the page has checked it", async () => {
    posts.length = 0;
    const p = await browser.newPage();
    await p.navigate(`${origin}/new`);
    let typed = false;
    const { client } = scripted((seen) => {
      if (/Repository created/.test(seen)) return [{ name: "done", input: { success: true, result: "Created." } }];
      const name = refOf(seen, /<input[^\n]*name="name"/);
      if (!typed && name) {
        typed = true;
        return [{ name: "type", input: { ref: name, text: "apply-jobs", submit: true } }];
      }
      return [{ name: "done", input: { success: false, result: "The form is still open." } }];
    });
    const r = await new Agent(p, { client, model: "fake", policy: { check: () => ({ kind: "allow" as const }) }, contextEditing: false, fastSettle: true, maxSteps: 6 }).run("create a repository called apply-jobs");
    await p.close();
    expect(posts).toEqual(["/create"]);
    expect(r.success).toBe(true);
  }, 60_000);

  it("a dialog the model's own click opened is left open for it, auto-dismiss on", async () => {
    posts.length = 0;
    const p = await browser.newPage();
    await p.navigate(`${origin}/settings`);
    let clicked = false;
    let shown = false;
    const { client } = scripted((seen) => {
      if (/now public/.test(seen)) return [{ name: "done", input: { success: true, result: "Public." } }];
      const yes = refOf(seen, /I want to make this repository public/);
      if (yes) {
        shown = true;
        return [{ name: "click", input: { ref: yes } }];
      }
      const pub = refOf(seen, /<button[^\n]*>Change to public/);
      if (!clicked && pub) {
        clicked = true;
        return [{ name: "click", input: { ref: pub } }];
      }
      return [{ name: "done", input: { success: false, result: "No dialog came up." } }];
    });
    const r = await new Agent(p, { client, model: "fake", policy: { check: () => ({ kind: "allow" as const }) }, contextEditing: false, fastSettle: true, autoDismiss: true, maxSteps: 6 }).run("make the repository public");
    await p.close();
    expect(shown).toBe(true);
    expect(posts).toEqual(["/public"]);
    expect(r.success).toBe(true);
  }, 60_000);

  it("a confirm-access dialog over a long settings page goes to the person, not the end of the run", async () => {
    const p = await browser.newPage();
    await p.navigate(`${origin}/settings-sudo`);
    let clicked = false;
    const asked: Array<{ category?: string }> = [];
    const { client } = scripted((seen) => {
      // A model that does what it is told about the step, else stops there and reports it (as the run did live).
      if (/prove it is them again/.test(seen)) return [{ name: "ask_user", input: { kind: "login", question: "The site asks to confirm access before making the repository public." } }];
      const pub = refOf(seen, /<button[^\n]*>Change to public/);
      if (!clicked && pub) {
        clicked = true;
        return [{ name: "click", input: { ref: pub } }];
      }
      return [{ name: "done", input: { success: false, result: "The site asks to confirm access by email." } }];
    });
    await new Agent(p, {
      client,
      model: "fake",
      policy: { check: () => ({ kind: "allow" as const }) },
      contextEditing: false,
      fastSettle: true,
      autoDismiss: true,
      interruptions: true,
      interventionPollMs: 250,
      maxSteps: 6,
      onIntervention: async (req) => (asked.push(req as { category?: string }), { status: "cancel" }),
    }).run("make the repository public");
    await p.close();
    expect(asked.map((a) => a.category)).toContain("login");
  }, 60_000);
});
