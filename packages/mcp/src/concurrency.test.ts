import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { BrowserSession } from "./session.js";
import { configFromEnv } from "./config.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Real MCP transports and session queue, a fake executor: no Chrome or model is needed to test routing.
describe("concurrent MCP callers", () => {
  it.each([false, true])("keeps a queued action's confirmation on its own connection (second can elicit: %s)", async (secondCanElicit) => {
    const session = new BrowserSession(configFromEnv({}));
    const entered = deferred(), release = deferred();
    const runtime = session as unknown as { ensure: () => Promise<unknown>; executor: () => unknown };
    runtime.ensure = async () => ({});
    runtime.executor = () => ({
      act: async (name: string) => {
        if (name === "click") {
          entered.resolve();
          await release.promise;
          const answer = await session.asker?.("Confirm this caller's action");
          return { ok: answer === "yes", text: answer ?? "no asker", summary: "confirmation" };
        }
        return { ok: true, text: "read", summary: "read" };
      },
    });
    const first = createMcpServer({ session }), second = createMcpServer({ session });
    const a = new Client({ name: "can-confirm", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    const b = new Client({ name: "other-caller", version: "1" }, secondCanElicit ? { capabilities: { elicitation: { form: {} } } } : {});
    const [ac, as] = InMemoryTransport.createLinkedPair(), [bc, bs] = InMemoryTransport.createLinkedPair();
    let questions = 0, wrongQuestions = 0;
    if (secondCanElicit) b.setRequestHandler(ElicitRequestSchema, async () => { wrongQuestions++; return { action: "accept", content: { answer: "yes" } }; });
    a.setRequestHandler(ElicitRequestSchema, async () => { questions++; return { action: "accept", content: { answer: "yes" } }; });
    try {
      await first.server.connect(as); await a.connect(ac);
      await second.server.connect(bs); await b.connect(bc);
      const click = a.callTool({ name: "browser_click", arguments: { ref: "e1" } });
      await entered.promise;
      const query = b.callTool({ name: "browser_query", arguments: { expression: "document.title" } });
      // Let the second request reach the server while the first executor is paused.
      await new Promise((r) => setTimeout(r, 20));
      release.resolve();
      const result = await click; await query;
      expect(questions).toBe(1);
      expect(wrongQuestions).toBe(0);
      expect(result.isError).not.toBe(true);
    } finally { release.resolve(); await a.close(); await b.close(); await first.close(); await second.close(); }
  });
  /** Two connected clients on one session, both able to answer questions; counts who was asked. */
  async function twoClients(act: (name: string, input: Record<string, unknown>, session: BrowserSession) => Promise<unknown>) {
    const session = new BrowserSession(configFromEnv({}));
    const runtime = session as unknown as { ensure: () => Promise<unknown>; executor: () => unknown; page: () => Promise<unknown> };
    runtime.ensure = async () => ({});
    runtime.page = async () => ({ lastDocumentAt: 0 });
    runtime.executor = () => ({ act: (name: string, input: Record<string, unknown>) => act(name, input, session) });
    const first = createMcpServer({ session }), second = createMcpServer({ session });
    const a = new Client({ name: "a", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    const b = new Client({ name: "b", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    const asked = { a: 0, b: 0 };
    a.setRequestHandler(ElicitRequestSchema, async () => { asked.a++; return { action: "accept", content: { answer: "yes" } }; });
    b.setRequestHandler(ElicitRequestSchema, async () => { asked.b++; return { action: "accept", content: { answer: "yes" } }; });
    const [ac, as] = InMemoryTransport.createLinkedPair(), [bc, bs] = InMemoryTransport.createLinkedPair();
    await first.server.connect(as); await a.connect(ac);
    await second.server.connect(bs); await b.connect(bc);
    const close = async () => { await a.close().catch(() => {}); await b.close().catch(() => {}); await first.close(); await second.close(); };
    return { session, a, b, asked, close };
  }
  const confirm = async (session: BrowserSession) => {
    const answer = await session.asker?.("Confirm");
    return { ok: answer === "yes", text: answer ?? "no answer", summary: answer ?? "no answer" };
  };

  it("asks every step of a batch on its own caller's connection, and the batch completes before the next request", async () => {
    const entered = deferred(), release = deferred();
    const order: string[] = [];
    const t = await twoClients(async (name, input, session) => {
      if (name === "click") {
        order.push(`click ${String(input["ref"])}`);
        if (input["ref"] === "e1") { entered.resolve(); await release.promise; }
        return confirm(session);
      }
      order.push(name);
      return { ok: true, text: "read", summary: "read" };
    });
    try {
      const batch = t.a.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: "e1" }, { action: "click", ref: "e2" }] } });
      await entered.promise;
      const other = t.b.callTool({ name: "browser_click", arguments: { ref: "e9" } });
      await new Promise((r) => setTimeout(r, 20));
      release.resolve();
      await batch; await other;
      expect(order).toEqual(["click e1", "click e2", "click e9"]);
      expect(t.asked).toEqual({ a: 2, b: 1 });
    } finally { release.resolve(); await t.close(); }
  });

  it("after a request fails, the next caller's request runs and asks only that caller", async () => {
    const t = await twoClients(async (name, input, session) => {
      if (input["ref"] === "boom") throw new Error("fixture failure");
      return confirm(session);
    });
    try {
      const failed = await t.a.callTool({ name: "browser_click", arguments: { ref: "boom" } });
      expect(failed.isError).toBe(true);
      const next = await t.b.callTool({ name: "browser_click", arguments: { ref: "e1" } });
      expect(next.isError).not.toBe(true);
      expect(t.asked).toEqual({ a: 0, b: 1 });
    } finally { await t.close(); }
  });

  it("a caller that disconnects while its action waits gets no answer, and the next caller is asked on its own connection", async () => {
    const entered = deferred(), release = deferred();
    const answers: string[] = [];
    const t = await twoClients(async (name, input, session) => {
      if (input["ref"] === "e1") { entered.resolve(); await release.promise; }
      const r = await confirm(session);
      answers.push(`${String(input["ref"])}:${r.text}`);
      return r;
    });
    try {
      const gone = t.a.callTool({ name: "browser_click", arguments: { ref: "e1" } }).catch(() => "closed");
      await entered.promise;
      await t.a.close();
      release.resolve();
      await gone;
      const next = await t.b.callTool({ name: "browser_click", arguments: { ref: "e2" } });
      expect(next.isError).not.toBe(true);
      expect(answers).toEqual(["e1:no answer", "e2:yes"]);
      expect(t.asked).toEqual({ a: 0, b: 1 });
    } finally { release.resolve(); await t.close(); }
  });

  it("keeps multi-step requests atomic and releases the queue after a failure", async () => {
    const session = new BrowserSession(configFromEnv({}));
    const entered = deferred(), release = deferred();
    const order: string[] = [];
    const first = session.run(undefined, async () => {
      order.push("batch step 1"); entered.resolve(); await release.promise;
      order.push("batch step 2");
    });
    await entered.promise;
    const other = session.run(undefined, async () => { order.push("other request"); throw new Error("fixture failure"); });
    const failed = expect(other).rejects.toThrow("fixture failure");
    const last = session.run(undefined, async () => { order.push("next request"); });
    release.resolve(); await first; await failed; await last;
    expect(order).toEqual(["batch step 1", "batch step 2", "other request", "next request"]);
  });
});
