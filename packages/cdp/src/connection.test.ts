import { describe, expect, it } from "vitest";
import { Connection, CDPError, SessionClosedError } from "./connection.js";
import type { Transport } from "./transport.js";

/** In-memory transport that lets a test play the browser. */
class FakeTransport implements Transport {
  onMessage: ((m: string) => void) | null = null;
  onClose: ((r?: string) => void) | null = null;
  closed = false;
  sent: Array<Record<string, unknown>> = [];
  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  close(): void {
    this.closed = true;
    this.onClose?.("closed");
  }
  reply(obj: unknown): void {
    this.onMessage?.(JSON.stringify(obj));
  }
}

describe("Connection", () => {
  it("round-trips a typed command on the root session", async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.rootSession.send("Target.getTargets");
    expect(t.sent[0]).toMatchObject({ id: 1, method: "Target.getTargets" });
    t.reply({ id: 1, result: { targetInfos: [] } });
    await expect(p).resolves.toEqual({ targetInfos: [] });
  });

  it("routes events and commands by sessionId for flat child sessions", async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const attached: string[] = [];
    c.onSession((s, kind) => attached.push(`${kind}:${s.sessionId}`));
    t.reply({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "S1",
        targetInfo: { targetId: "T1", type: "page", title: "", url: "about:blank", attached: true, canAccessOpener: false },
        waitingForDebugger: false,
      },
    });
    const s1 = c.session("S1")!;
    expect(s1).toBeDefined();
    expect(attached).toEqual(["attached:S1"]);

    const evt = s1.waitFor("Page.loadEventFired");
    t.reply({ sessionId: "S1", method: "Page.loadEventFired", params: { timestamp: 1 } });
    await expect(evt).resolves.toEqual({ timestamp: 1 });

    const p = s1.send("Page.navigate", { url: "https://example.com" });
    expect(t.sent.at(-1)).toMatchObject({ sessionId: "S1", method: "Page.navigate", params: { url: "https://example.com" } });
    t.reply({ id: (t.sent.at(-1) as { id: number }).id, sessionId: "S1", result: { frameId: "F", loaderId: "L" } });
    await expect(p).resolves.toMatchObject({ frameId: "F" });

    t.reply({ method: "Target.detachedFromTarget", params: { sessionId: "S1", targetId: "T1" } });
    expect(c.session("S1")).toBeUndefined();
    await expect(s1.send("Page.reload")).rejects.toBeInstanceOf(SessionClosedError);
  });

  it("surfaces protocol errors as CDPError and refuses Runtime.enable", async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.rootSession.send("Browser.getVersion");
    t.reply({ id: 1, error: { code: -32601, message: "'Browser.getVersion' wasn't found" } });
    await expect(p).rejects.toBeInstanceOf(CDPError);
    await expect(c.rootSession.send("Runtime.enable")).rejects.toThrow(/sign of automation/);
    expect(t.sent.length).toBe(1);
  });

  it("allows Runtime.enable per command only when explicitly requested", async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.rawSend("Runtime.enable", {}, "S1", { allowForbiddenMethods: true });
    expect(t.sent.at(-1)).toMatchObject({ method: "Runtime.enable", sessionId: "S1" });
    t.reply({ id: (t.sent.at(-1) as { id: number }).id, result: {} });
    await expect(p).resolves.toEqual({});
    await expect(c.rootSession.send("Runtime.enable")).rejects.toThrow(/sign of automation/);
  });

  it("rejects all pending commands when the transport closes", async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.rootSession.send("Target.getTargets");
    t.close();
    await expect(p).rejects.toBeInstanceOf(SessionClosedError);
    expect(c.closed).toBe(true);
  });
});
