// WebMCP: tools a page offers to agents (W3C Web Machine Learning CG draft, webmachinelearning.github.io/webmcp).
// A page registers them with `document.modelContext.registerTool({ name, description, inputSchema, execute })`, or
// declares them on a form (`<form toolname tooldescription>`, `toolparamdescription` on its fields, `toolautosubmit`).
//
// We read and call them through Chrome's own DevTools domain, `WebMCP` (experimental; Chrome 157 measured, 17 Nov
// 2026), never through the page's JavaScript: `WebMCP.enable` reports every tool registered (`toolsAdded`, including
// those registered before it), `WebMCP.invokeTool` calls one in its frame, and `toolResponded` carries its answer.
// Nothing runs in the page's world and nothing a page can observe changes. The page API exists where Chrome turns the
// feature on: a page with the WebMCP origin trial's token (from Chrome 149), or every page when the browser is
// launched with `--enable-features=WebMCP` (LaunchOptions.webmcp, on by default). A Chrome without the domain answers
// the enable with an error, and the page simply offers no tools.
//
// What Chrome 157 does, measured on a local page:
//   * No `toolsRemoved` when a document goes: a frame's tools are dropped here when it commits another document or
//     is detached. Removing one (its registration's AbortSignal) does send `toolsRemoved`.
//   * A declarative form without `toolautosubmit` is filled in and its invocation stays open until the form is
//     submitted (by a person, or by our own click on its submit button, which goes through the policy like any click):
//     reported as `filled`, never waited on.
//   * A tool whose call navigates may answer twice (its own value, then `[]` after the commit): the first answer wins.
//   * A thrown error comes as status "Error" with the exception's description; a form without a submit button and
//     without `toolautosubmit` as status "Error" with errorText.

import type { CDPSession } from "@pilotfish/cdp";

/** Hints a page gives about a tool (WebMCP ToolAnnotations, as Chrome reports them). */
export interface PageToolAnnotations {
  /** Changes nothing. */
  readOnly?: boolean;
  /** Its output may carry content the site does not vouch for (user posts, third-party data). */
  untrustedContent?: boolean;
  /** Calling it has consequences (booking, paying, sending). */
  consequential?: boolean;
  /** Meant for developers' tooling, not for a person's tasks. */
  debugging?: boolean;
  /** A declarative form tool submits its form when called (`toolautosubmit`). */
  autosubmit?: boolean;
}

/** A tool the current page offers. */
export interface PageTool {
  name: string;
  description: string;
  /** JSON Schema of its input (declarative forms: one property per named field). */
  inputSchema?: Record<string, unknown>;
  annotations?: PageToolAnnotations;
  /** The frame that registered it. */
  frameId: string;
  /** Set for a declarative form tool: the form's node. */
  backendNodeId?: number;
}

/** What a call came to. */
export type PageToolResult =
  | { status: "completed"; output: unknown }
  | { status: "error"; error: string }
  | { status: "canceled" }
  /** A form without toolautosubmit: its fields are filled in and it waits to be submitted. */
  | { status: "filled" }
  /** No answer within the wait: the call was cancelled. */
  | { status: "timeout"; waitedMs: number };

interface Waiter {
  resolve: (r: PageToolResult) => void;
}

/** The WebMCP tools of one page (every frame session of it), kept current from Chrome's events. */
export class PageTools {
  /** frameId -> tool name -> tool, with the session that reports it (the frame's own, or its OOPIF's). */
  private readonly byFrame = new Map<string, Map<string, { tool: PageTool; session: CDPSession }>>();
  private readonly waiters = new Map<string, Waiter>();
  /** Answers that came before their invocation id was known to a waiter (Chrome says the response comes first). */
  private readonly early = new Map<string, PageToolResult>();
  private mainFrameId: () => string;
  private version = 0;

  constructor(mainFrameId: () => string) {
    this.mainFrameId = mainFrameId;
  }

  /** Changes each time the list does (a cheap check for "has the page's set of tools changed"). */
  get revision(): number {
    return this.version;
  }

  /** Listen on a frame session and turn the domain on. Safe on a Chrome without it. */
  attach(session: CDPSession): Promise<void> {
    session.on("WebMCP.toolsAdded", (e) => {
      for (const t of e.tools) {
        const tool: PageTool = {
          name: t.name,
          description: t.description ?? "",
          frameId: t.frameId,
          ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
          ...(t.annotations ? { annotations: compactAnnotations(t.annotations) } : {}),
          ...(t.backendNodeId !== undefined ? { backendNodeId: t.backendNodeId } : {}),
        };
        let m = this.byFrame.get(t.frameId);
        if (!m) this.byFrame.set(t.frameId, (m = new Map()));
        m.set(t.name, { tool, session });
      }
      this.version++;
    });
    session.on("WebMCP.toolsRemoved", (e) => {
      for (const t of e.tools) this.byFrame.get(t.frameId)?.delete(t.name);
      this.version++;
    });
    // Another document in a frame: its tools went with the old one (Chrome sends no toolsRemoved for that).
    session.on("Page.frameNavigated", (e) => this.dropFrame(e.frame.id));
    session.on("Page.frameDetached", (e) => this.dropFrame(e.frameId));
    session.on("WebMCP.toolResponded", (e) => {
      const r: PageToolResult =
        e.status === "Completed"
          ? { status: "completed", output: e.output }
          : e.status === "Canceled"
            ? { status: "canceled" }
            : { status: "error", error: errorText(e.errorText, e.exception?.description) };
      const w = this.waiters.get(e.invocationId);
      if (w) {
        this.waiters.delete(e.invocationId);
        w.resolve(r);
      } else if (!this.early.has(e.invocationId)) {
        // The first answer wins; a second one for the same call (after a navigation) is dropped. Keep a few only.
        this.early.set(e.invocationId, r);
        if (this.early.size > 50) this.early.delete(this.early.keys().next().value!);
      }
    });
    return session.send("WebMCP.enable").then(
      () => undefined,
      () => undefined,
    );
  }

  private dropFrame(frameId: string): void {
    if (this.byFrame.delete(frameId)) this.version++;
  }

  /**
   * The tools on offer now: the main frame's first, then any a child frame offers under a name not taken. Tools a page
   * marks as developer tooling (`debugging`) are left out.
   */
  list(): PageTool[] {
    const main = this.mainFrameId();
    const frames = [...this.byFrame.keys()].sort((a, b) => (a === main ? -1 : b === main ? 1 : 0));
    const out = new Map<string, PageTool>();
    for (const f of frames) {
      for (const { tool } of this.byFrame.get(f)!.values()) {
        if (tool.annotations?.debugging) continue;
        if (!out.has(tool.name)) out.set(tool.name, tool);
      }
    }
    return [...out.values()];
  }

  /** The tool listed under `name`, or undefined. */
  get(name: string): PageTool | undefined {
    return this.list().find((t) => t.name === name);
  }

  /**
   * Call a tool with `input` and wait for its answer (default 15 s, then it is cancelled). A form tool without
   * `toolautosubmit` returns `filled` once its fields are set.
   */
  async invoke(name: string, input: Record<string, unknown>, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<PageToolResult> {
    const tool = this.get(name);
    const entry = tool ? this.byFrame.get(tool.frameId)?.get(name) : undefined;
    if (!tool || !entry) throw new Error(`This page offers no tool named "${name}".`);
    const fillsOnly = tool.backendNodeId !== undefined && !tool.annotations?.autosubmit;
    const { invocationId } = await entry.session.send("WebMCP.invokeTool", { frameId: tool.frameId, toolName: name, input });
    const known = this.early.get(invocationId);
    if (known) {
      this.early.delete(invocationId);
      return known;
    }
    // A form that only fills answers once it is submitted: give its error (no submit button) a moment to come.
    const wait = fillsOnly ? Math.min(timeoutMs, 500) : timeoutMs;
    const started = Date.now();
    const answer = await new Promise<PageToolResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(invocationId);
        resolve(null);
      }, wait);
      timer.unref?.();
      this.waiters.set(invocationId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
    if (answer) return answer;
    if (fillsOnly) return { status: "filled" };
    await entry.session.send("WebMCP.cancelInvocation", { invocationId }).catch(() => undefined);
    return { status: "timeout", waitedMs: Date.now() - started };
  }
}

function compactAnnotations(a: PageToolAnnotations): PageToolAnnotations | undefined {
  const out: PageToolAnnotations = {};
  for (const k of ["readOnly", "untrustedContent", "consequential", "debugging", "autosubmit"] as const) if (a[k]) out[k] = true;
  return Object.keys(out).length ? out : undefined;
}

function errorText(text: string | undefined, exception: string | undefined): string {
  // The exception's description is its message then its stack: the first line says it.
  const first = (exception ?? "").split("\n")[0]!.trim();
  return (text?.trim() || first || "the tool failed").slice(0, 500);
}

/** A tool's output as text: an MCP-style `{ content: [{ type: "text", text }] }` read as its texts, a string as itself, else JSON. */
export function pageToolOutputText(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && Array.isArray((output as { content?: unknown }).content)) {
    const parts = ((output as { content: unknown[] }).content)
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : c && typeof c === "object" ? JSON.stringify(c) : String(c)))
      .filter((s) => s !== "");
    const structured = (output as { structuredContent?: unknown }).structuredContent;
    if (parts.length) return parts.join("\n");
    if (structured !== undefined) return JSON.stringify(structured);
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * A tool's input as one short line for the model: `city* (string): City; beds ("1" | "2")`. Required ones are
 * starred; a short pattern, a format and length or number bounds go with the type (`origin* (string /^[A-Z]{3}$/)`),
 * as a tool refuses what breaks them. Long schemas are cut at `maxChars`.
 */
export function describeToolInput(schema: Record<string, unknown> | undefined, maxChars = 900): string {
  const props = schema && typeof schema["properties"] === "object" && schema["properties"] ? (schema["properties"] as Record<string, Record<string, unknown>>) : {};
  const required = new Set(Array.isArray(schema?.["required"]) ? (schema!["required"] as string[]) : []);
  const parts = Object.entries(props).map(([k, p]) => {
    const en = Array.isArray(p["enum"]) ? (p["enum"] as unknown[]).slice(0, 8).map((v) => JSON.stringify(v)).join(" | ") + ((p["enum"] as unknown[]).length > 8 ? " | …" : "") : "";
    const base = en || (Array.isArray(p["type"]) ? (p["type"] as string[]).join("|") : typeof p["type"] === "string" ? p["type"] : "any");
    const pattern = typeof p["pattern"] === "string" && p["pattern"].length <= 40 ? ` /${p["pattern"]}/` : "";
    const format = typeof p["format"] === "string" ? ` ${p["format"]}` : "";
    const bounds = [p["minimum"] !== undefined ? `>=${String(p["minimum"])}` : "", p["maximum"] !== undefined ? `<=${String(p["maximum"])}` : ""].filter(Boolean).join(" ");
    const type = `${base}${format}${pattern && !en ? pattern : ""}${bounds ? ` ${bounds}` : ""}`;
    const desc = typeof p["description"] === "string" && p["description"] ? `: ${oneLine(p["description"], 80)}` : "";
    return `${k}${required.has(k) ? "*" : ""} (${type})${desc}`;
  });
  const s = parts.join("; ");
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
