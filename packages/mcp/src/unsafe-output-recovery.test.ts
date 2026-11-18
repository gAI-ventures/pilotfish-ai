// A withheld reply (UNSAFE_OUTPUT) says how a client can recover, in the same words whatever triggered it (18 Nov,
// credential usability lane). The executor is stubbed, as in server.test.ts: no browser.
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActOutcome } from "@pilotfish/agent";
import { configFromEnv } from "./config.js";
import { createMcpServer, type PilotfishMcp } from "./server.js";

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const say = (text: string): ActOutcome => ({ ok: true, summary: text.slice(0, 40), text });

const open: PilotfishMcp[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const pf of open.splice(0)) await pf.close().catch(() => undefined);
});

/** A server whose only secret is `value`, whose executor answers `reply`; the reply to one call of `tool`. */
async function withheldFor(value: string, reply: string | Error, tool = "browser_get_text", args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const pf = createMcpServer({ config: { ...configFromEnv({}), secrets: { s: { value } } } });
  pf.session.act = async () => {
    if (reply instanceof Error) throw reply;
    return say(reply);
  };
  open.push(pf);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await pf.server.connect(serverSide);
  const c = new Client({ name: "recovery", version: "1" });
  clients.push(c);
  await c.connect(clientSide);
  return (await c.callTool({ name: tool, arguments: args })) as CallToolResult;
}

/** The part of a withheld reply after the tool-specific action sentence: from "No page text or refs are given". */
const tail = (r: CallToolResult) => textOf(r).slice(textOf(r).indexOf("No page text or refs are given"));

describe("UNSAFE_OUTPUT recovery instructions", () => {
  it("say what clears a withheld value: a fresh page, browser_close (every client of this server, sign-ins lost), and for a configured secret a longer REAL credential changed at its source (never a padded or replaced guard value), else the protection stays", async () => {
    const r = await withheldFor("hunter2-xyz", "page text hunter2-xyz");
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toMatch(/^UNSAFE_OUTPUT: this reply is withheld\./);
    expect(t).toMatch(/browser_navigate/);
    expect(t).toMatch(/password typed into a password field stays guarded until browser_close/);
    expect(t).toMatch(/browser_close[^.]*every client of this server[^.]*sign-ins are lost/);
    expect(t).toMatch(/configured secret is guarded for the server's life/);
    expect(t).toMatch(/the value may be too short to guard without matching ordinary text/);
    expect(t).toMatch(/Do not pad or replace the configured value while the real credential is unchanged: that would remove its protection/);
    expect(t).toMatch(/Where the service allows it, tell the user to change the real credential to a longer one at its source, then update PILOTFISH_SECRETS to match and restart the server/);
    expect(t).toMatch(/if the credential cannot be changed, its protection stays and such replies stay withheld/);
    expect(t).not.toMatch(/set a longer one in PILOTFISH_SECRETS/);
    expect(t).not.toContain("hunter2-xyz");
  });

  it("are the same words whatever triggered the withholding (long or 1-character secret, read or action, thrown error): they reveal nothing about the value", async () => {
    const tails = [
      tail(await withheldFor("hunter2-xyz", "page text hunter2-xyz")),
      tail(await withheldFor("e", "ordinary page text")),
      tail(await withheldFor("Zx", "Zx", "browser_click", { ref: "e1" })),
      tail(await withheldFor("hunter2-xyz", new Error("failed at https://x.example/?k=hunter2-xyz"), "browser_click", { ref: "e1" })),
    ];
    expect(tails[0]).toMatch(/^No page text or refs are given/);
    for (const t of tails) expect(t).toBe(tails[0]);
  });

  it("hold none of the existing fixtures' short values or their recognized forms (q, z&, Zx, Rq), nor words those fixtures forbid", async () => {
    const t = tail(await withheldFor("hunter2-xyz", "page text hunter2-xyz"));
    for (const v of ["q", "z&", "Zx", "Rq", "Zq7xK"])
      for (const f of [v, encodeURIComponent(v), encodeURI(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")]) expect(t, f).not.toContain(f);
    expect(t).not.toMatch(/\b(ran|succeeded|worked)\b/);
    expect(t).not.toContain("Continue");
    expect(t).not.toMatch(/\[(?:f\d+)?e\d+\]/);
    expect(t).not.toContain("\n");
  });
});
