// Sign-in codes on a one-page shop's sign-in dialog (phone number, then the texted code), over the shapes code entry
// takes on the web: one transparent input laid over a row of drawn boxes (6 and 4 characters, with and without
// autocomplete=one-time-code), controlled boxes that keep their own state, plain boxes that move along by themselves,
// boxes that spread a pasted code but never move along, and a single field. A scripted model (no API tokens) does what
// a model does with the page it is shown: it opens the sign-in, asks the person, types the number, and types the code
// into the field it finds for it. Each shape must take the code once, never submit a wrong one, never press the code
// page's own "Edit phone number", and count as signed in only after the site accepted the code.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { launch, type Browser } from "@pilotfish/browser";
import { Agent, type InterventionRequest } from "./index.js";

const E2E = process.env.PILOTFISH_E2E === "1";
const PHONE = "+91 98765 43210";

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
    const seen = lastSeen(params);
    const turn = next(seen, i++);
    if (process.env["CODE_ENTRY_DEBUG"]) console.log(`--- turn ${i}
${seen.slice(0, 3_000)}
=> ${JSON.stringify(turn)}`);
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

/** The ref on the first snapshot line matching `re`, or null. */
const refOf = (text: string, re: RegExp): string | null => {
  const line = text.split("\n").find((l) => /\[(?:f\d+)?e\d+\]/.test(l) && re.test(l));
  return line ? /\[((?:f\d+)?e\d+)\]/.exec(line)![1]! : null;
};

/** Code widgets, by name: their markup inside the code step, and the script that runs them. */
interface Shape {
  len: number;
  html: string;
  js: string;
}
const box = "display:inline-flex;align-items:center;justify-content:center;width:44px;height:48px;border:1px solid #ccc;border-radius:8px;margin-right:6px;font-size:18px";
const inputBox = "width:40px;height:44px;margin-right:6px;text-align:center;font-size:18px";
const overlay = (len: number, attrs: string): Shape => ({
  len,
  html: `<div id="w" style="position:relative;width:${len * 50}px"><div aria-hidden="true">${Array.from({ length: len }, () => `<div class="b" style="${box}"></div>`).join("")}</div><input id="o" type="text" inputmode="numeric" ${attrs} style="position:absolute;inset:0;width:100%;height:100%;opacity:0"></div>`,
  // One field for the whole code: digits only, cut to the length, drawn into the boxes; sent once it is whole.
  js: `const o = document.getElementById('o'); const bs = [...document.querySelectorAll('#w .b')];
    const draw = () => bs.forEach((b, i) => (b.textContent = o.value[i] || ''));
    o.addEventListener('input', () => { o.value = o.value.replace(/\\D/g, '').slice(0, ${len}); draw(); if (o.value.length === ${len}) verify(o.value, () => { o.value = ''; draw(); }); });
    o.focus();`,
});
const SHAPES: Record<string, Shape> = {
  "overlay-6": overlay(6, `aria-label="OTP" autocomplete="one-time-code"`),
  "overlay-4": overlay(4, `aria-label="OTP" autocomplete="one-time-code"`),
  "overlay-6-plain": overlay(6, `aria-label="Enter code" autocomplete="off"`),
  // Boxes that keep the code in their own state and draw every box from it (as a framework's controlled inputs do):
  // the last character typed in a box is its own, focus moves on, Backspace in an empty box goes back; Verify sends.
  "controlled-6": {
    len: 6,
    html: `<div id="w">${Array.from({ length: 6 }, (_, i) => `<input class="c" type="tel" inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}" style="${inputBox}">`).join("")}</div><button type="button" id="v">Verify</button>`,
    js: `const cs = [...document.querySelectorAll('#w .c')]; const st = cs.map(() => '');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const draw = () => cs.forEach((c, i) => set.call(c, st[i]));
      cs.forEach((c, i) => {
        c.addEventListener('input', () => { const ch = c.value.replace(/\\D/g, '').slice(-1); st[i] = ch; draw(); if (ch && cs[i + 1]) cs[i + 1].focus(); });
        c.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !st[i] && i > 0) { e.preventDefault(); st[i - 1] = ''; draw(); cs[i - 1].focus(); } });
      });
      document.getElementById('v').addEventListener('click', () => verify(st.join(''), () => { st.fill(''); draw(); }));
      cs[0].focus();`,
  },
  // Plain boxes of one character that move along by themselves; Verify sends.
  "advance-4": {
    len: 4,
    html: `<div id="w">${Array.from({ length: 4 }, (_, i) => `<input class="c" type="text" maxlength="1" aria-label="Digit ${i + 1}" style="${inputBox}">`).join("")}</div><button type="button" id="v">Verify</button>`,
    js: `const cs = [...document.querySelectorAll('#w .c')];
      cs.forEach((c, i) => c.addEventListener('input', () => { if (c.value && cs[i + 1]) cs[i + 1].focus(); }));
      document.getElementById('v').addEventListener('click', () => verify(cs.map((c) => c.value).join(''), () => cs.forEach((c) => (c.value = ''))));
      cs[0].focus();`,
  },
  // Boxes with no maxlength that spread more than one character (a paste) over the boxes after them, and never move
  // along on one; Verify sends.
  "paste-6": {
    len: 6,
    html: `<div id="w">${Array.from({ length: 6 }, (_, i) => `<input class="c" type="text" inputmode="numeric" aria-label="Digit ${i + 1}" style="${inputBox}">`).join("")}</div><button type="button" id="v">Verify</button>`,
    js: `const cs = [...document.querySelectorAll('#w .c')];
      cs.forEach((c, i) => c.addEventListener('input', () => {
        const v = c.value.replace(/\\D/g, '');
        if (v.length > 1) { [...v].forEach((ch, k) => { if (cs[i + k]) cs[i + k].value = ch; }); cs[Math.min(i + v.length, cs.length) - 1].focus(); }
        else c.value = v;
      }));
      document.getElementById('v').addEventListener('click', () => verify(cs.map((c) => c.value).join(''), () => cs.forEach((c) => (c.value = ''))));
      cs[0].focus();`,
  },
  // Number boxes of maxlength 2 with a one-digit pattern (so a key typed over a full box can be told): the last digit a
  // box gets is its own, focus moves on, and the code is sent once every box holds one.
  "maxlen2-6": {
    len: 6,
    html: `<div id="w">${Array.from({ length: 6 }, (_, i) => `<input class="c" type="number" inputmode="numeric" maxlength="2" pattern="[0-9]{1}" aria-label="Digit ${i + 1}" style="${inputBox}">`).join("")}</div>`,
    js: `const cs = [...document.querySelectorAll('#w .c')]; let sent = false;
      cs.forEach((c, i) => c.addEventListener('input', () => {
        const ch = String(c.value).replace(/\\D/g, '').slice(-1); c.value = ch;
        if (ch && cs[i + 1]) cs[i + 1].focus();
        const v = cs.map((x) => x.value).join('');
        if (v.length === 6 && !sent) { sent = true; verify(v, () => { sent = false; cs.forEach((x) => (x.value = '')); }); }
      }));
      cs[0].focus();`,
  },
  // One plain field.
  "single-6": {
    len: 6,
    html: `<input id="s" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="Verification code" style="width:200px"><button type="button" id="v">Verify</button>`,
    js: `const s = document.getElementById('s'); document.getElementById('v').addEventListener('click', () => verify(s.value, () => (s.value = ''))); s.focus();`,
  },
};

const CODE6 = "482913";
const codeFor = (len: number) => CODE6.slice(0, len);

const shop = (shape: string) => {
  const sh = SHAPES[shape]!;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Corner Shop</title></head><body>
<header style="display:flex;gap:16px;padding:12px"><a href="/">Corner Shop</a><span>Select Location</span><button type="button" id="acct">Log in</button><button type="button">Cart</button></header>
<main style="padding:20px"><h1>Shop by Category</h1><p>Fruits, dairy, snacks and more, delivered in minutes.</p></main>
<dialog id="d" style="width:420px"><div id="step"></div></dialog>
<script>
  const d = document.getElementById('d'), step = document.getElementById('step');
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then((r) => r.json());
  function phone() {
    step.innerHTML = '<h2>Groceries delivered in minutes</h2><form id="f"><label for="m">Phone number</label> <input id="m" type="tel" inputmode="numeric" autocomplete="tel"> <button>Continue</button></form>';
    document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault(); await post('/api/send-code', { mobile: document.getElementById('m').value }); code(); });
    document.getElementById('m').focus();
  }
  function verify(v, clear) {
    post('/api/verify', { code: v }).then((r) => {
      if (r.ok) { d.close(); document.getElementById('acct').textContent = 'Account'; document.querySelector('main').insertAdjacentHTML('afterbegin', '<p id="hi">Hi Ada, your saved addresses: Home</p>'); }
      else { clear(); document.getElementById('err').textContent = 'Incorrect OTP. Please try again.'; }
    });
  }
  function code() {
    step.innerHTML = '<h2>OTP Verification</h2><button type="button" id="edit" aria-label="Edit phone number">OTP has been sent to +91 98•••••210 ✎</button><div style="margin-top:16px">${sh.html.replace(/'/g, "\\'")}</div><p id="err"></p><p>Didn\\'t get the code?</p><button type="button">Send SMS</button>';
    document.getElementById('edit').addEventListener('click', () => { post('/api/edit', {}); phone(); });
    ${sh.js}
  }
  document.getElementById('acct').addEventListener('click', () => { if (document.getElementById('acct').textContent === 'Log in') { d.showModal(); phone(); } });
</script></body></html>`;
};

export interface CodeRun {
  shape: string;
  success: boolean;
  /** Codes the site was sent, in order. */
  verifies: string[];
  /** Presses of the code page's "Edit phone number". */
  edits: number;
  /** When the agent reported the sign-in finished, relative to the first accepted code (ms; negative = before). */
  signedInAt: number[];
  numberSent: boolean;
  modelTurns: number;
}

describe.skipIf(!E2E)("sign-in codes over the shapes code entry takes (scripted model)", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let log: Array<{ path: string; body: Record<string, string>; at: number; shape: string }> = [];
  const runs: CodeRun[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<Record<string, string>>((r) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => r(Object.fromEntries(new URLSearchParams(b))));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const shape = /shape=([\w-]+)/.exec(req.headers.referer ?? "")?.[1] ?? url.searchParams.get("shape") ?? "";
      if (req.method === "POST") {
        const body = await read(req);
        log.push({ path: url.pathname, body, at: Date.now(), shape });
        const ok = url.pathname === "/api/verify" ? body["code"] === codeFor(SHAPES[shape]?.len ?? 6) : true;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok }));
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SHAPES[shape] ? shop(shape) : "<h1>Home</h1>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    // Old vs new, same checks: the table this file prints is the comparison (run it on each build).
    const out = process.env["CODE_ENTRY_OUT"];
    if (out) writeFileSync(out, JSON.stringify(runs, null, 1));
  });

  for (const shape of Object.keys(SHAPES)) {
    it(`${shape}: the person's code goes into the site once, whole, and the sign-in counts only after the site took it`, async () => {
      log = [];
      const len = SHAPES[shape]!.len;
      const p = await browser.newPage();
      await p.navigate(`${origin}/shop?shape=${shape}`);
      const asked: InterventionRequest[] = [];
      const signedIn: number[] = [];
      let typedNumber = false;
      let typedCode = false;
      let askedLogin = false;
      let askedCode = false;
      let pressedVerify = false;
      // Everything the model was shown, newest first: a turn whose page did not change, or changed in part, shows only
      // that, and the refs it was shown before stay valid.
      let shown = "";
      const { client, requests } = scripted((seen) => {
        shown = `${seen}\n${shown}`;
        if (/\bHi Ada\b/.test(seen)) return [{ name: "done", input: { success: true, result: "Signed in; the saved address is Home." } }];
        if (/Refused:|NOT submitted/.test(seen)) return [{ name: "done", input: { success: false, result: "The code could not be entered." } }];
        const phoneField = /<dialog>|Phone number/.test(seen) || !typedNumber ? refOf(shown, /<input[^\n]*label="Phone number"/) : null;
        const placeholder = /\{\{([^}]+\.entered_phone)\}\}/.exec(seen)?.[1];
        if (placeholder && !typedNumber && phoneField) {
          typedNumber = true;
          return [{ name: "type", input: { ref: phoneField, text: `{{${placeholder}}}`, submit: true } }];
        }
        if (/\{\{user_code\}\}/.test(seen) && !typedCode) {
          // The field the model finds for the code: an input named for it, else (none shown) the line that names it.
          const input = /\[((?:f\d+)?e\d+)\]<input[^>\n]*(?:OTP|one-time-code|[Cc]ode|Digit 1)/.exec(shown)?.[1];
          const into = input ?? refOf(shown, /OTP|[Cc]ode/);
          if (into) {
            typedCode = true;
            return [{ name: "type", input: { ref: into, text: "{{user_code}}" } }];
          }
        }
        // Typed, and the page still asks: its Verify button, once.
        const verifyButton = /\[((?:f\d+)?e\d+)\]<button[^>\n]*>Verify</.exec(shown)?.[1];
        if (typedCode && !pressedVerify && verifyButton && /OTP Verification/.test(shown)) {
          pressedVerify = true;
          return [{ name: "click", input: { ref: verifyButton } }];
        }
        if (!askedLogin) {
          const login = refOf(shown, /Log in/);
          if (login && !phoneField) return [{ name: "click", input: { ref: login } }];
          askedLogin = true;
          return [{ name: "ask_user", input: { kind: "login", question: "The shop needs you signed in." } }];
        }
        if (/OTP Verification/.test(seen) && !askedCode) {
          askedCode = true;
          return [{ name: "ask_user", input: { kind: "code", question: "Please share the OTP sent to your phone." } }];
        }
        return [{ name: "done", input: { success: false, result: "Not signed in." } }];
      });
      const r = await new Agent(p, {
        client,
        model: "fake",
        policy: { check: () => ({ kind: "allow" as const }) },
        contextEditing: false,
        fastSettle: true,
        interruptions: true,
        interventionPollMs: 250,
        maxSteps: 14,
        onSignedIn: () => void signedIn.push(Date.now()),
        askUser: async () => codeFor(len),
        onIntervention: async (req) => {
          asked.push(req);
          return req.needs === "code" || req.category === "otp" ? { status: "code", code: codeFor(len) } : { status: "code_login", identifier: PHONE, channel: "sms" };
        },
      }).run("sign in to the shop with my phone number and check my saved address");
      const verifies = log.filter((x) => x.path === "/api/verify").map((x) => x.body["code"] ?? "");
      const accepted = log.find((x) => x.path === "/api/verify" && x.body["code"] === codeFor(len));
      const run: CodeRun = {
        shape,
        success: r.success,
        verifies,
        edits: log.filter((x) => x.path === "/api/edit").length,
        signedInAt: signedIn.map((t) => (accepted ? t - accepted.at : -1)),
        numberSent: log.some((x) => x.path === "/api/send-code" && (x.body["mobile"] ?? "").replace(/\D/g, "").endsWith("9876543210")),
        modelTurns: requests.length,
      };
      runs.push(run);
      await p.close();
      expect(run.numberSent).toBe(true);
      // The code page's own controls were never pressed for the code.
      expect(run.edits).toBe(0);
      // One code sent, and it was the person's, whole.
      expect(verifies).toEqual([codeFor(len)]);
      expect(r.success).toBe(true);
      // Signed in once, after the site took the code, never on the code page.
      expect(run.signedInAt.length).toBe(1);
      expect(run.signedInAt[0]!).toBeGreaterThanOrEqual(0);
      // The number and the code never reached the model.
      expect(JSON.stringify(requests)).not.toContain("98765");
      expect(JSON.stringify(requests)).not.toContain(codeFor(len));
    }, 90_000);
  }
});
