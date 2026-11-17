// The WebMCP tool list kept from Chrome's events (webmcp.ts), on a scripted CDP session: what is listed, what another
// document or an abort drops, how calls are answered (first answer wins, a form only fills, a silent tool is cancelled),
// and how inputs and outputs read to the model.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { CDPSession } from "@pilotfish/cdp";
import { describeToolInput, pageToolOutputText, PageTools } from "./webmcp.js";

/** A session that records what is sent and lets the test emit Chrome's events. */
function fakeSession(onInvoke: (params: Record<string, unknown>, id: string) => void = () => undefined) {
  const em = new EventEmitter();
  const sent: Array<{ method: string; params?: unknown }> = [];
  let n = 0;
  const session = {
    on: (event: string, l: (p: unknown) => void) => {
      em.on(event, l);
      return () => em.off(event, l);
    },
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "WebMCP.invokeTool") {
        const id = `inv${++n}`;
        onInvoke(params!, id);
        return { invocationId: id };
      }
      return {};
    },
  } as unknown as CDPSession;
  return { session, sent, emit: (event: string, params: unknown) => em.emit(event, params) };
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, frameId: "F1", ...extra });

describe("PageTools", () => {
  it("lists the main frame's tools first, leaves developer ones out, and drops a frame's tools with its document", async () => {
    const s = fakeSession();
    const tools = new PageTools(() => "F1");
    await tools.attach(s.session);
    expect(s.sent.map((x) => x.method)).toEqual(["WebMCP.enable"]);
    s.emit("WebMCP.toolsAdded", { tools: [tool("child_search", { frameId: "F2" }), tool("search"), tool("dump", { annotations: { debugging: true, readOnly: false } })] });
    s.emit("WebMCP.toolsAdded", { tools: [tool("search", { frameId: "F2", description: "the iframe's" }), tool("book", { annotations: { consequential: true, readOnly: false, untrustedContent: false, debugging: false } })] });
    expect(tools.list().map((t) => `${t.name}@${t.frameId}`)).toEqual(["search@F1", "book@F1", "child_search@F2"]);
    expect(tools.get("book")!.annotations).toEqual({ consequential: true });
    const rev = tools.revision;
    s.emit("WebMCP.toolsRemoved", { tools: [{ name: "book", frameId: "F1" }] });
    expect(tools.get("book")).toBeUndefined();
    expect(tools.revision).toBeGreaterThan(rev);
    // Another document in the main frame: Chrome sends no toolsRemoved, its tools go here.
    s.emit("Page.frameNavigated", { frame: { id: "F1", url: "https://x.example/next" }, type: "Navigation" });
    expect(tools.list().map((t) => t.name)).toEqual(["child_search", "search"]);
    s.emit("Page.frameDetached", { frameId: "F2" });
    expect(tools.list()).toEqual([]);
  });

  it("answers a call with the first answer Chrome gives, and its error's first line", async () => {
    let respond: (id: string) => void = () => undefined;
    const s = fakeSession((_p, id) => setTimeout(() => respond(id), 5));
    const tools = new PageTools(() => "F1");
    await tools.attach(s.session);
    s.emit("WebMCP.toolsAdded", { tools: [tool("search"), tool("boom")] });
    respond = (id) => {
      s.emit("WebMCP.toolResponded", { invocationId: id, status: "Completed", output: { content: [{ type: "text", text: "2 rooms" }] } });
      s.emit("WebMCP.toolResponded", { invocationId: id, status: "Completed", output: [] });
    };
    expect(await tools.invoke("search", { city: "Goa" })).toEqual({ status: "completed", output: { content: [{ type: "text", text: "2 rooms" }] } });
    expect(s.sent.at(-1)).toEqual({ method: "WebMCP.invokeTool", params: { frameId: "F1", toolName: "search", input: { city: "Goa" } } });
    respond = (id) => s.emit("WebMCP.toolResponded", { invocationId: id, status: "Error", errorText: "", exception: { description: "Error: nope\n    at execute (https://x.example/:1:2)" } });
    expect(await tools.invoke("boom", {})).toEqual({ status: "error", error: "Error: nope" });
    await expect(tools.invoke("missing", {})).rejects.toThrow(/no tool named "missing"/);
  });

  it("returns a form that only fills at once, and cancels a tool that never answers", async () => {
    const s = fakeSession();
    const tools = new PageTools(() => "F1");
    await tools.attach(s.session);
    s.emit("WebMCP.toolsAdded", { tools: [tool("contact", { backendNodeId: 7 }), tool("quick", { backendNodeId: 9, annotations: { autosubmit: true } }), tool("slow")] });
    expect(await tools.invoke("contact", { message: "hi" })).toEqual({ status: "filled" });
    const slow = await tools.invoke("slow", {}, { timeoutMs: 30 });
    expect(slow.status).toBe("timeout");
    expect(s.sent.at(-1)).toMatchObject({ method: "WebMCP.cancelInvocation" });
    // An autosubmit form is waited on like any tool.
    expect((await tools.invoke("quick", {}, { timeoutMs: 30 })).status).toBe("timeout");
  });

  it("turns the domain on even where Chrome lacks it, without failing", async () => {
    const tools = new PageTools(() => "F1");
    const session = { on: () => () => undefined, send: async () => Promise.reject(new Error("'WebMCP.enable' wasn't found")) } as unknown as CDPSession;
    await expect(tools.attach(session)).resolves.toBeUndefined();
    expect(tools.list()).toEqual([]);
  });
});

describe("how a page tool reads to the model", () => {
  it("prints its input as one line, required ones starred, choices listed", () => {
    expect(
      describeToolInput({
        type: "object",
        properties: { city: { type: "string", description: "City  name" }, beds: { type: "string", enum: ["1", "2"] }, flexible: { type: "boolean" }, x: {} },
        required: ["city"],
      }),
    ).toBe('city* (string): City name; beds ("1" | "2"); flexible (boolean); x (any)');
    expect(describeToolInput({ properties: { origin: { type: "string", pattern: "^[A-Z]{3}$" }, day: { type: "string", format: "date" }, n: { type: "number", minimum: 1, maximum: 9 } }, required: ["origin"] })).toBe(
      "origin* (string /^[A-Z]{3}$/); day (string date); n (number >=1 <=9)",
    );
    expect(describeToolInput(undefined)).toBe("");
    expect(describeToolInput({ properties: { a: { type: "string", description: "y".repeat(500) } } }, 50)).toHaveLength(50);
  });

  it("reads an MCP-style answer as its texts, a string as itself, anything else as JSON", () => {
    expect(pageToolOutputText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(pageToolOutputText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    expect(pageToolOutputText("plain")).toBe("plain");
    expect(pageToolOutputText({ rooms: 2 })).toBe('{"rooms":2}');
    expect(pageToolOutputText(undefined)).toBe("");
  });
});
