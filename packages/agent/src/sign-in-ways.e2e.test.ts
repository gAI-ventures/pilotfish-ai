// What a sign-in question offers, read from real pages (24 Nov): the ways a page shows in its own fields, buttons and
// words (a password form, a magic link, a phone OTP, split code boxes, Google and Apple only, an email first, an unclear
// page, a form in a cross-origin frame inside a dialog), and the agent around it, with a scripted model and no API
// tokens: the question waits for a dialog still drawing, carries the ways of the form in its frame, never asks again
// for a login the person already gave (the model gets its placeholder back), asks for the code once it was sent, and
// asks how the person signs in where nothing could be read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, type Browser } from "@pilotfish/browser";
import { captureSnapshot } from "@pilotfish/perception";
import { Agent, readSignIn, type InterventionRequest } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";

type Turn = Array<{ name: string; input: Record<string, unknown> }>;

/** The text of the last user message the model was shown (text blocks and tool results). */
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
  if (m) add(m.content);
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
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
  };
  return { client: { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic, requests };
}

/** The last ref in `text` whose line matches `re`. */
const lastRef = (text: string, re: RegExp) => {
  const line = text.split("\n").filter((l) => /\[(?:f\d+)?e\d+\]/.test(l) && re.test(l)).pop();
  if (!line) throw new Error(`no ref for ${re} in:\n${text.slice(-3_000)}`);
  return /\[((?:f\d+)?e\d+)\]/.exec(line)![1]!;
};

const allow = { check: () => ({ kind: "allow" as const }) };

describe.skipIf(!E2E)("sign-in ways read from the live page", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let other: string;
  const posts: Array<{ path: string; body: Record<string, string> }> = [];
  const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main style="width:480px;margin:40px auto">${body}</main></body></html>`;
  const read = (req: IncomingMessage) =>
    new Promise<Record<string, string>>((r) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => r(Object.fromEntries(new URLSearchParams(b))));
    });
  /** A dialog holding a sign-in frame, drawn `ms` after load (a login modal still opening). */
  const dialogWith = (src: string, ms: number) =>
    `<h1>Restaurants near you</h1><input type="search" placeholder="Search for a restaurant"><script>setTimeout(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.innerHTML = '<iframe src="${src}" style="width:420px;height:420px;border:0"></iframe>'; document.body.append(d); }, ${ms});</script>`;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const html = (h: string) => (res.writeHead(200, { "content-type": "text/html; charset=utf-8" }), res.end(h));
      const go = (to: string) => (res.writeHead(303, { location: to }), res.end());
      if (req.method === "POST") {
        const body = await read(req);
        posts.push({ path: url.pathname, body });
        if (url.pathname === "/accounts/login") return body["mobile"] === "+91 98765 43210" ? go("/accounts/otp") : go("/accounts/login?e=1");
        if (url.pathname === "/accounts/otp") return body["otp"] === "482913" ? go("/accounts/done") : go("/accounts/otp?e=1");
        return go("/");
      }
      switch (url.pathname) {
        case "/pw":
          return html(page("Sign in", `<h1>Sign in</h1><form><label for="e">Email</label><input id="e" type="email" autocomplete="username"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"><button>Sign in</button></form><a href="/forgot">Forgot password?</a>`));
        case "/magic":
          return html(page("Log in", `<h1>Log in</h1><p>We'll email you a magic link for a password-free sign in.</p><form><label for="e">Work email</label><input id="e" type="email"><button>Continue</button></form>`));
        case "/phone":
          return html(page("Login", `<h1>Login</h1><form><label for="m">Mobile number</label><div><button type="button">+91</button><input id="m" type="tel" maxlength="10"></div><button>Get OTP</button></form>`));
        case "/split":
          return html(page("Verify", `<h1>Enter the 6-digit code</h1><form>${Array.from({ length: 6 }, (_, i) => `<input aria-label="Digit ${i + 1}" maxlength="1" inputmode="numeric">`).join("")}<button>Verify</button></form>`));
        case "/social":
          return html(page("Welcome", `<h1>Welcome back</h1><button>Continue with Google</button><button>Sign in with Apple</button>`));
        case "/idf":
          return html(page("Sign in", `<h1>Sign in</h1><form><label for="e">Email</label><input id="e" type="email" autocomplete="username"><button>Next</button></form>`));
        case "/unclear":
          return html(page("Members", `<h1>Members area</h1><p>This part of the site is for members.</p><button>Sign in</button>`));
        case "/oopif":
          // The sign-in form on another site's frame (accounts.<site>), inside a dialog: an out-of-process frame.
          return html(page("Order food", dialogWith(`${other}/accounts/login`, 0)));
        case "/zlogin":
          // The same, on this site's own accounts page, drawn 1.2 s after load.
          return html(page("Order food", dialogWith("/accounts/login", 1_200)));
        case "/accounts/login":
          return html(page("Login", `<h2>Login</h2><form method="post" action="/accounts/login"><label for="m">Phone number</label><input id="m" name="mobile" type="tel"><button>Send One Time Password</button></form><p>or</p><button type="button">Continue with Google</button>`));
        case "/accounts/otp":
          return html(page("Verify", `<h2>Enter OTP</h2><p>We sent a 6-digit code by SMS.</p><form method="post" action="/accounts/otp"><input name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="OTP"><button>Verify</button></form>`));
        case "/accounts/done":
          return html(page("Welcome", `<h2>Welcome back, Ada</h2>`));
      }
      html(page("Home", "<h1>Home</h1>"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    other = origin.replace("127.0.0.1", "localhost");
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const readAt = async (path: string, waitMs = 0) => {
    const p = await browser.newPage();
    try {
      await p.navigate(origin + path);
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      return readSignIn((await captureSnapshot(p, { viewportBand: 1 })).nodes);
    } finally {
      await p.close();
    }
  };

  it("reads each kind of sign-in page as it is", async () => {
    expect((await readAt("/pw")).ways).toEqual(["password"]);
    expect((await readAt("/magic")).ways).toEqual(["email_code"]);
    expect((await readAt("/phone")).ways).toEqual(["phone_code"]);
    const split = await readAt("/split");
    expect([split.ways, split.codeStep]).toEqual([[], true]);
    const social = await readAt("/social");
    expect([social.ways, social.providers]).toEqual([[], ["Google", "Apple"]]);
    expect((await readAt("/idf")).ways).toEqual(["identifier_first"]);
    const unclear = await readAt("/unclear");
    expect([unclear.ways, unclear.providers]).toEqual([[], []]);
    expect(unclear.pageWords).toContain("Members area");
  }, 90_000);

  it("reads a sign-in form in a cross-origin frame inside a dialog, and leaves out the page behind it", async () => {
    const r = await readAt("/oopif", 1_000);
    expect(r.ways).toEqual(["phone_code"]);
    expect(r.providers).toEqual(["Google"]);
  }, 60_000);

  it("a login dialog still drawing, a phone given, asked again, then the code: one sign-in question, then the code's", async () => {
    posts.length = 0;
    const p = await browser.newPage();
    await p.navigate(origin + "/zlogin");
    const asked: InterventionRequest[] = [];
    let all = "";
    const results: string[] = [];
    const { client } = scripted((seen, turn) => {
      all += `\n${seen}`;
      if (turn > 0) results.push(seen);
      if (turn === 0 || turn === 1) return [{ name: "ask_user", input: { kind: "login", question: "Zomato needs you signed in to order." } }];
      if (turn === 2) return [{ name: "type", input: { ref: lastRef(all, /Phone number|type="tel"/), text: "{{127.0.0.1.entered_phone}}", submit: true } }];
      if (turn === 3) return [{ name: "ask_user", input: { kind: "login", question: "Please sign in to continue." } }];
      if (turn === 4 && /\{\{user_code\}\}/.test(seen)) return [{ name: "type", input: { ref: lastRef(all, /name="otp"|OTP/), text: "{{user_code}}", submit: true } }];
      return [{ name: "done", input: { success: /Welcome back, Ada/.test(all), result: "signed in" } }];
    });
    const codes: Array<{ question: string; secret?: boolean }> = [];
    const r = await new Agent(p, {
      client,
      model: "fake",
      policy: allow,
      contextEditing: false,
      fastSettle: true,
      interruptions: true,
      interventionPollMs: 250,
      onIntervention: async (req) => {
        asked.push(req);
        return asked.length === 1 ? { status: "code_login", identifier: "+91 98765 43210", channel: "sms" } : { status: "code", code: "482913" };
      },
      askUser: async (question, o) => (codes.push({ question, ...(o?.secret ? { secret: true } : {}) }), "482913"),
    }).run("order my usual from Zomato");
    // The first question waited for the dialog and read the phone way in its frame (and Google beside it).
    expect(asked[0]).toMatchObject({ category: "login", signIn: { ways: ["phone_code"], providers: ["Google"] } });
    // Asked again with the phone given: not the person; the model got its placeholder back.
    expect(results[1]).toMatch(/Not asked again/);
    expect(results[1]).toContain("{{127.0.0.1.entered_phone}}");
    // Asked for a login once the code was sent: the code's question (kept from the model), not a third sign-in.
    const third = asked.length === 2 ? asked[1]!.needs : codes[0]?.secret ? "code" : "none";
    expect(asked.length + codes.length).toBe(2);
    expect(third).toBe("code");
    expect(posts.map((x) => x.path)).toEqual(["/accounts/login", "/accounts/otp"]);
    expect(posts[1]!.body["otp"]).toBe("482913");
    expect(r.success).toBe(true);
    await p.close();
  }, 120_000);

  it("a page whose sign-in cannot be read: the person is asked how they sign in, and nothing secret of the answer reaches the model", async () => {
    const p = await browser.newPage();
    await p.navigate(origin + "/unclear");
    const asked: InterventionRequest[] = [];
    const { client, requests } = scripted((_seen, turn) =>
      turn === 0 ? [{ name: "ask_user", input: { kind: "login", question: "The members area needs an account." } }] : [{ name: "done", input: { success: false, result: "asked how" } }],
    );
    await new Agent(p, {
      client,
      model: "fake",
      policy: allow,
      contextEditing: false,
      fastSettle: true,
      interruptions: true,
      interventionPollMs: 250,
      onIntervention: async (req) => (asked.push(req), { status: "how", text: "with my phone 9876543210 and an OTP" }),
    }).run("open the members area");
    expect(asked[0]!.signIn).toMatchObject({ ways: [], providers: [] });
    expect(asked[0]!.signIn?.pageWords).toContain("Members area");
    const shown = JSON.stringify(requests[1]);
    expect(shown).toContain("with my phone [hidden] and an OTP");
    expect(shown).not.toContain("9876543210");
    await p.close();
  }, 60_000);
});
