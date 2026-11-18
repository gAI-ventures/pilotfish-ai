// A page the obstacle check could not read as one document (`unread`: it kept loading other documents) reaches the
// client as exactly that: never as a page that needs nobody, never as a check seen. In browser_actions it stops the
// batch after the step that ran, which is never run again. No browser: the session's act, page and obstacle are stubs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActOutcome } from "@pilotfish/agent";
import { configFromEnv } from "./config.js";
import { createMcpServer, type PilotfishMcp } from "./server.js";
import type { PageCheck } from "./session.js";

const UNREAD: PageCheck = { unread: true, changed: true, message: "Could not verify the page on shop.test for a sign-in, a code or a bot check: it loaded another document while it was read.", host: "shop.test", url: "https://shop.test/cart" };
const UNREADABLE: PageCheck = { unread: true, changed: false, message: "Could not verify the page on shop.test for a sign-in, a code or a bot check: it could not be read as one document.", host: "shop.test", url: "https://shop.test/cart" };

describe("a page that could not be checked, through the open MCP (fifth review, v3)", () => {
  let pf: PilotfishMcp;
  let client: Client;
  let acts: string[] = [];
  /** What each obstacle look returns, in order (then the last one again). */
  let looks: Array<PageCheck | null> = [];
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;

  beforeEach(async () => {
    acts = [];
    looks = [null];
    pf = createMcpServer({ config: configFromEnv({}) });
    pf.session.act = async (name: string): Promise<ActOutcome> => {
      acts.push(name);
      return { ok: true, summary: `${name} done`, text: name === "read_page" ? "Cart: 1 item" : `${name} done` };
    };
    pf.session.obstacle = async () => (looks.length > 1 ? looks.shift()! : looks[0]!);
    pf.session.page = async () => ({ lastDocumentAt: 1, url: "https://shop.test/cart", webmcp: { list: () => [] } }) as never;
    Object.defineProperty(pf.session, "launched", { get: () => true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "unread", version: "1" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client?.close();
    await pf?.close();
  });

  it("an acting tool's reply says the page could not be checked (not NEEDS A PERSON, not nothing); a page read clear adds nothing", async () => {
    looks = [UNREAD];
    const r = textOf(await call("browser_click", { ref: "e1" }));
    expect(r).toContain("COULD NOT VERIFY THE PAGE:");
    expect(r).toContain("it loaded another document while it was read");
    expect(r).not.toContain("NEEDS A PERSON");
    // No change seen: no change claimed.
    looks = [UNREADABLE];
    const plain = textOf(await call("browser_click", { ref: "e1" }));
    expect(plain).toContain("it could not be read as one document");
    expect(plain).not.toMatch(/loaded another document|kept changing/);
    looks = [null];
    expect(textOf(await call("browser_click", { ref: "e1" }))).not.toMatch(/COULD NOT VERIFY|NEEDS A PERSON/);
  });

  it("browser_resume (untilClear): looks that cannot be read never end the wait as clear, and the reply says so", async () => {
    looks = [UNREAD];
    const r = textOf(await call("browser_resume", { timeout_s: 5 }));
    expect(r).toContain("COULD NOT VERIFY THE PAGE:");
    expect(r).not.toContain("needs nobody");
    looks = [null];
    expect(textOf(await call("browser_resume", { timeout_s: 5 }))).toContain("The page needs nobody now.");
  }, 30_000);

  it("a check seen, then a page that cannot be read: the hand-off does not call it cleared", async () => {
    looks = [{ category: "bot_challenge", needs: "solve_in_live_view", blocking: true, autoResolvable: true, neverAutomate: false, message: "shop.test shows a CAPTCHA / bot check.", host: "shop.test", url: "https://shop.test/cart" }, UNREAD];
    const r = textOf(await call("browser_click", { ref: "e1" }));
    expect(r).not.toContain("cleared by itself");
    expect(r).toContain("COULD NOT VERIFY THE PAGE:");
  }, 30_000);

  it("browser_actions: an unreadable page after step 1 stops the batch there, says why, and runs step 1 once", async () => {
    looks = [UNREAD];
    const r = textOf(await call("browser_actions", { actions: [{ action: "click", ref: "e1" }, { action: "click", ref: "e2" }] }));
    expect(acts).toEqual(["click"]);
    expect(r).toContain("Stopped after step 1: the page could not be verified for a sign-in, a code or a check (it loaded another document while it was read); steps 2-2 were not run.");
    // Control: a page read clear runs both steps.
    acts = [];
    looks = [null];
    await call("browser_actions", { actions: [{ action: "click", ref: "e1" }, { action: "click", ref: "e2" }] });
    expect(acts).toEqual(["click", "click"]);
  });
});
