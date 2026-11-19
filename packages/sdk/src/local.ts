// The local client: Chrome on your own machine and IP, driven from code through the open MCP's browser tools
// (@gaiventures/pilotfish-mcp, MIT). No account, no API key, no model calls: your code is the one deciding each step.
//
// It starts the open MCP as a child process and speaks MCP to it over stdio (newline-delimited JSON-RPC). The MCP is the
// installed `@gaiventures/pilotfish-mcp` when there is one, else `npx -y @gaiventures/pilotfish-mcp`.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { PilotfishError } from "./errors.js";
import { VERSION } from "./version.js";

const PROTOCOL = "2025-06-18";
const MCP_PACKAGE = "@gaiventures/pilotfish-mcp";

/** A tool's answer: its text (the page, what changed, what needs a person), pictures, and structured value. */
export interface ToolResult {
  text: string;
  images: Array<{ data: Uint8Array; mimeType: string }>;
  /** `browser_query` with a schema: `{value}`. */
  structured?: Record<string, unknown>;
  isError: boolean;
}

/** A tool answered with an error (a refused click, a stale ref, a bad expression). `result` has its whole text. */
export class LocalToolError extends PilotfishError {
  constructor(
    readonly tool: string,
    readonly result: ToolResult,
  ) {
    super(0, { error: result.text || `${tool} failed`, code: "tool_error" });
  }
}

/**
 * Something the MCP asks the person: `confirm` before a step that looks irreversible (pay, send, delete: answer true to
 * allow), or `handoff` when the page needs a person (a sign-in, a code, a CAPTCHA: answer true once it is done in the
 * browser window). Null or false declines.
 */
export interface LocalQuestion {
  kind: "confirm" | "handoff";
  message: string;
}

export interface LocalOptions {
  /** Hide the browser window. Default: a window where one can open. A hidden one cannot be signed in to by hand. */
  headless?: boolean;
  /** Hostnames the browser may visit, `*` wildcards allowed. Default: any public site. */
  allowedHosts?: string[];
  /** Allow localhost and private networks (testing your own app). */
  allowPrivate?: boolean;
  /** Secrets typed as `{{name}}`: `{"name": "value"}` or `{"name": {value?, totp?, allowedHosts?}}`. Never in any result. */
  secrets?: Record<string, string | { value?: string; totp?: string; allowedHosts?: string[] }>;
  /** The browser executable. Default: found automatically. */
  chrome?: string;
  /** Further environment variables for the MCP (its settings: https://pilotfish.gai.ventures/docs/open-settings). */
  env?: Record<string, string>;
  /** How to start the MCP: the command and its arguments. Default: the installed package, else npx. */
  command?: string[];
  /** Answers the MCP's questions to the person. Without it, irreversible steps are refused and a page that needs a person says so in the result. */
  onQuestion?: (q: LocalQuestion) => Promise<boolean | string | null> | boolean | string | null;
  /** Throw LocalToolError when a tool answers with an error (default true); false returns the result. */
  throwOnError?: boolean;
  /** Per-call timeout, ms. Default 5 min (browser_resume waits for a person). */
  timeoutMs?: number;
}

type Expect = { text?: string; gone?: string; url?: string; in?: string; within?: number };
type ActOpts = { snapshot?: boolean; expect?: Expect; escalate?: boolean };
/** One step of `actions`: `{action: "click", ref}`, `{action: "type", ref, text, submit?}`, `{action: "select", ref, values}`, `{action: "press", key}`, `{action: "scroll", direction}`, `{action: "wait", seconds, until?, gone?}`. */
export type Step = { action: "click" | "type" | "select" | "press" | "scroll" | "wait"; [key: string]: unknown };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The command that starts the open MCP: the installed package's cli.js, else npx. */
function defaultCommand(): string[] {
  if (process.env["PILOTFISH_MCP_CLI"]) return [process.execPath, process.env["PILOTFISH_MCP_CLI"]];
  try {
    const cli = createRequire(import.meta.url).resolve(`${MCP_PACKAGE}/cli.js`);
    return [process.execPath, cli];
  } catch {
    return [process.platform === "win32" ? "npx.cmd" : "npx", "-y", MCP_PACKAGE];
  }
}

const settingsEnv = (o: LocalOptions): Record<string, string> => ({
  ...(o.headless !== undefined ? { PILOTFISH_HEADLESS: o.headless ? "1" : "0" } : {}),
  ...(o.allowedHosts ? { PILOTFISH_ALLOWED_HOSTS: o.allowedHosts.join(",") } : {}),
  ...(o.allowPrivate ? { PILOTFISH_ALLOW_PRIVATE: "1" } : {}),
  ...(o.secrets ? { PILOTFISH_SECRETS: JSON.stringify(o.secrets) } : {}),
  ...(o.chrome ? { PILOTFISH_CHROME: o.chrome } : {}),
  ...(o.env ?? {}),
});

export class LocalBrowser {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  private exited = false;
  /** Why the MCP stopped, kept for every later call. */
  private stopped: Error | null = null;
  private stderrTail = "";
  /** The MCP's own name and version (initialize). */
  serverInfo: { name: string; version: string } | null = null;

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly o: LocalOptions,
  ) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => void (this.stderrTail = (this.stderrTail + chunk).slice(-4_000)));
    proc.on("exit", (code) => (this.exited = true, this.fail(new PilotfishError(0, { error: `The pilotfish MCP stopped (exit ${code}).${this.stderrTail ? ` ${this.stderrTail.trim().split("\n").slice(-3).join(" ")}` : ""}`, code: "mcp_exited" }))));
    proc.on("error", (e) => this.fail(new PilotfishError(0, { error: `Could not start the pilotfish MCP: ${e.message}`, code: "mcp_start_failed" })));
  }

  /** Start the open MCP and connect to it. The browser itself opens on the first call that needs it. */
  static async start(o: LocalOptions = {}): Promise<LocalBrowser> {
    const [cmd, ...args] = o.command ?? defaultCommand();
    const proc = spawn(cmd!, args, { env: { ...process.env, ...settingsEnv(o) }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && /\.cmd$/i.test(cmd!) });
    const b = new LocalBrowser(proc, o);
    const init = (await b.rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: o.onQuestion ? { elicitation: { form: {} } } : {},
      clientInfo: { name: "pilotfish-sdk-ts", version: VERSION },
    })) as { serverInfo?: { name: string; version: string } };
    b.serverInfo = init.serverInfo ?? null;
    b.notify("notifications/initialized", {});
    return b;
  }

  // ----------------------------------------------------------------------------------------- the tools

  /** Open an http(s) URL; returns what happened and the visible screen (`snapshot: false` leaves the screen out). */
  navigate(url: string, o: ActOpts = {}): Promise<ToolResult> {
    return this.call("browser_navigate", { url, ...o });
  }
  /** The page as a compact outline with refs (`[e12]<button>Search`); `wholePage` for all of it. */
  snapshot(o: { wholePage?: boolean } = {}): Promise<ToolResult> {
    return this.call("browser_snapshot", o.wholePage ? { whole_page: true } : {});
  }
  click(ref: string, o: ActOpts = {}): Promise<ToolResult> {
    return this.call("browser_click", { ref, ...o });
  }
  /** Replace a field's text (`{{name}}` types a secret); `submit` presses Enter after. */
  type(ref: string, text: string, o: ActOpts & { submit?: boolean } = {}): Promise<ToolResult> {
    return this.call("browser_type", { ref, text, ...o });
  }
  select(ref: string, values: string[], o: ActOpts = {}): Promise<ToolResult> {
    return this.call("browser_select", { ref, values, ...o });
  }
  /** A key or shortcut: `Enter`, `Escape`, `Control+a`. */
  press(key: string, o: ActOpts = {}): Promise<ToolResult> {
    return this.call("browser_press", { key, ...o });
  }
  scroll(direction: "up" | "down" | "left" | "right", o: { snapshot?: boolean } = {}): Promise<ToolResult> {
    return this.call("browser_scroll", { direction, ...o });
  }
  /** Up to 10 steps in one call (a form's fields and its submit). */
  actions(steps: Step[], o: { snapshot?: boolean } = {}): Promise<ToolResult> {
    return this.call("browser_actions", { actions: steps, ...o });
  }
  /** Read values with a JavaScript expression that returns JSON: `value` is the parsed result. It cannot change the page. */
  async query<T = unknown>(expression: string, o: { schema?: Record<string, unknown> } = {}): Promise<ToolResult & { value: T }> {
    const r = await this.call("browser_query", { expression, ...o });
    let value: unknown = r.structured?.["value"];
    if (value === undefined) {
      try {
        value = JSON.parse(r.text);
      } catch {
        value = r.text;
      }
    }
    return { ...r, value: value as T };
  }
  /** Elements anywhere on the page by their words, best match first (comma-separate several targets). */
  find(query: string): Promise<ToolResult> {
    return this.call("browser_find", { query });
  }
  /** The page's readable text (PDFs too), or one element's (`selector`). */
  getText(o: { maxChars?: number; selector?: string } = {}): Promise<ToolResult> {
    return this.call("browser_get_text", { ...(o.maxChars !== undefined ? { max_chars: o.maxChars } : {}), ...(o.selector !== undefined ? { selector: o.selector } : {}) });
  }
  /** A JPEG of the viewport. */
  async screenshot(): Promise<Uint8Array> {
    const r = await this.call("browser_screenshot", {});
    const img = r.images[0];
    if (!img) throw new LocalToolError("browser_screenshot", { ...r, isError: true });
    return img.data;
  }
  /** Wait up to `seconds` (0.5-10), or until `until` appears or `gone` goes. */
  wait(seconds: number, o: { until?: string; gone?: string; in?: string; snapshot?: boolean } = {}): Promise<ToolResult> {
    return this.call("browser_wait", { seconds, ...o });
  }
  /** After a result said NEEDS A PERSON: wait (default 300 s) until the person has dealt with the page. */
  resume(o: { timeoutS?: number } = {}): Promise<ToolResult> {
    return this.call("browser_resume", o.timeoutS !== undefined ? { timeout_s: o.timeoutS } : {});
  }
  /** Open tabs, or switch to one (`"t2"`). */
  tabs(o: { switchTo?: string } = {}): Promise<ToolResult> {
    return this.call("browser_tabs", o.switchTo !== undefined ? { switch_to: o.switchTo } : {});
  }
  /** A tool the page itself offers (WebMCP), as its snapshot's PAGE TOOLS line lists it. */
  pageTool(tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.call("browser_page_tool", { tool, arguments: args });
  }
  /** The tools the MCP offers now. */
  async tools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    return ((await this.rpc("tools/list", {})) as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools;
  }

  /** Any tool by name, with its arguments as the MCP takes them. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const raw = (await this.rpc("tools/call", { name, arguments: args })) as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    const content = raw.content ?? [];
    const r: ToolResult = {
      text: content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n"),
      images: content.filter((c) => c.type === "image" && c.data).map((c) => ({ data: Uint8Array.from(Buffer.from(c.data!, "base64")), mimeType: c.mimeType ?? "image/jpeg" })),
      ...(raw.structuredContent ? { structured: raw.structuredContent } : {}),
      isError: raw.isError === true,
    };
    if (r.isError && this.o.throwOnError !== false) throw new LocalToolError(name, r);
    return r;
  }

  /** Close the browser and stop the MCP. */
  async close(): Promise<void> {
    if (this.closed && this.exited) return;
    if (!this.closed) await this.call("browser_close", {}).catch(() => undefined);
    this.closed = true;
    if (this.exited) return;
    this.proc.stdin.end();
    const exited = new Promise<void>((r) => (this.exited ? r() : this.proc.once("exit", () => r())));
    const t = setTimeout(() => this.proc.kill(), 5_000);
    await exited;
    clearTimeout(t);
  }

  // ----------------------------------------------------------------------------------------- JSON-RPC over stdio

  private send(msg: unknown): void {
    if (this.closed || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.stopped ?? new PilotfishError(0, { error: "This browser is closed.", code: "closed" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        reject(new PilotfishError(0, { error: `${method} took longer than ${Math.round((this.o.timeoutMs ?? 300_000) / 1000)} s`, code: "timeout" }));
      }, this.o.timeoutMs ?? 300_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) void this.onRequest(msg.id, msg.method, msg.params ?? {});
      else if (msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id));
        if (!p) continue;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new PilotfishError(0, { error: msg.error.message ?? "MCP error", code: `mcp_${msg.error.code ?? "error"}` }));
        else p.resolve(msg.result);
      }
    }
  }

  /** The MCP's requests to us: ping, and questions for the person (elicitation). */
  private async onRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "ping") return this.send({ jsonrpc: "2.0", id, result: {} });
    if (method === "elicitation/create" && this.o.onQuestion) {
      const props = ((params["requestedSchema"] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>;
      const kind: LocalQuestion["kind"] = "done" in props ? "handoff" : "confirm";
      let answer: boolean | string | null = null;
      try {
        answer = await this.o.onQuestion({ kind, message: String(params["message"] ?? "") });
      } catch {
        answer = null;
      }
      if (answer === null || answer === false) return this.send({ jsonrpc: "2.0", id, result: { action: "decline" } });
      const content = kind === "handoff" ? { done: true } : { answer: answer === true ? "yes" : String(answer) };
      return this.send({ jsonrpc: "2.0", id, result: { action: "accept", content } });
    }
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  private fail(e: Error): void {
    this.closed = true;
    this.stopped ??= e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }
}
