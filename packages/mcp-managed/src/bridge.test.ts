// The stdio relay against a real Streamable HTTP MCP server (bearer-checked, like pilotfish's /mcp):
// tools, results, the server asking the person (elicitation) back through the relay, and a refused key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { check, checkKey, endpointOf, explain, relay } from "./bridge.js";

const KEY = "pf_test-key-0123456789abcdef";

describe("settings", () => {
  it("finds the MCP endpoint from the API's base URL or the endpoint itself", () => {
    expect(endpointOf("https://pilotfish-be.gai.ventures").href).toBe("https://pilotfish-be.gai.ventures/mcp");
    expect(endpointOf("https://pilotfish-be.gai.ventures/").href).toBe("https://pilotfish-be.gai.ventures/mcp");
    expect(endpointOf("https://x.example/api/mcp").href).toBe("https://x.example/api/mcp");
    expect(endpointOf().href).toBe("https://pilotfish-be.gai.ventures/mcp");
  });
  it("checks the key's shape before any request, and words failures for the person", () => {
    expect(checkKey(`  ${KEY}\n`)).toBe(KEY);
    expect(() => checkKey(undefined)).toThrow(/Org settings → API keys/);
    expect(() => checkKey("sk-ant-123")).toThrow(/does not look like/);
    expect(explain(new Error("Error POSTing to endpoint (HTTP 401): unauthorized"))).toMatch(/refused the API key/);
    expect(explain(new Error("fetch failed"))).toMatch(/Cannot reach pilotfish/);
  });
});

describe("relay", () => {
  let http: Server;
  let base = "";
  const seenAuth: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let inits = 0;

  beforeAll(async () => {
    http = createServer((req, res) => {
      void (async () => {
        seenAuth.push(req.headers.authorization ?? "");
        if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
        const sid = req.headers["mcp-session-id"];
        const t = typeof sid === "string" ? transports.get(sid) : undefined;
        if (t) return t.handleRequest(req, res);
        // As pilotfish's /mcp: a session it no longer has (a deploy, an idle one dropped) is 404.
        if (typeof sid === "string") return void res.writeHead(404, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}');
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        if (!isInitializeRequest(body)) return void res.writeHead(400).end();
        inits++;
        const mcp = new McpServer({ name: "pilotfish", version: "9.9.9" });
        mcp.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
        mcp.registerTool("ask", { inputSchema: {} }, async (_a, extra) => {
          const r = await mcp.server.elicitInput({ message: "Pick a colour", requestedSchema: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] } }, { relatedRequestId: extra.requestId });
          return { content: [{ type: "text", text: `${r.action}: ${String(r.content?.["colour"])}` }] };
        });
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, transport) });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      })().catch(() => res.headersSent || res.writeHead(500).end());
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  const textOf = (r: unknown) => ((r as CallToolResult).content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");

  it("passes tools, results and the server's questions through, with the key on every request", async () => {
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    const bridge = await relay(relaySide, { url: base, key: KEY });
    const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      expect(req.params.message).toBe("Pick a colour");
      return { action: "accept", content: { colour: "teal" } };
    });
    await client.connect(clientSide);
    expect(client.getServerVersion()).toMatchObject({ name: "pilotfish", version: "9.9.9" });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask", "echo"]);
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "hi" } }))).toBe("echo: hi");
    expect(textOf(await client.callTool({ name: "ask", arguments: {} }))).toBe("accept: teal");
    expect(seenAuth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
    await bridge.close();
    await client.close();
  });

  it("answers a request with the reason when the key is refused, instead of hanging", async () => {
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    await relay(relaySide, { url: base, key: "pf_wrong-key-0123456789abcdef" });
    const client = new Client({ name: "t", version: "1" });
    await expect(client.connect(clientSide)).rejects.toThrow(/refused the API key/);
    await expect(check({ url: base, key: "pf_wrong-key-0123456789abcdef" })).rejects.toThrow(/refused the API key/);
    expect(await check({ url: base, key: KEY })).toEqual({ server: "pilotfish 9.9.9", tools: ["echo", "ask"] });
  });

  it("opens a new session when the server lost the old one (a deploy), replaying the client's initialize, and sends the call again", async () => {
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    const bridge = await relay(relaySide, { url: base, key: KEY, log: (m) => logs.push(m) });
    const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { colour: "red" } }));
    await client.connect(clientSide);
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "before" } }))).toBe("echo: before");
    const before = inits;
    // The server restarts: every session it had is gone.
    await Promise.all([...transports.values()].map((t) => t.close().catch(() => undefined)));
    transports.clear();
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "after" } }))).toBe("echo: after");
    expect(inits).toBe(before + 1);
    // The new session has the client's own capabilities (the server can still ask it), and later calls use it.
    expect(textOf(await client.callTool({ name: "ask", arguments: {} }))).toBe("accept: red");
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "again" } }))).toBe("echo: again");
    expect(inits).toBe(before + 1);
    expect(logs.join(" ")).toMatch(/opening a new one/);
    await bridge.close();
    await client.close();
  });

  // The CLI as a stdio client starts it: dist/cli.js, or the npm package's cli.js when PILOTFISH_MCP_MANAGED_CLI names
  // one (the release workflow points it at the packed package, installed as a user would).
  it("the CLI relays over stdio, and --check lists the tools", async () => {
    const cli = process.env["PILOTFISH_MCP_MANAGED_CLI"] || fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    expect(existsSync(cli), `${cli} is missing: npm run build first`).toBe(true);
    const settings = { PILOTFISH_KEY: KEY, PILOTFISH_URL: base };
    const client = new Client({ name: "stdio", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env: settings, stderr: "pipe" }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask", "echo"]);
      expect(textOf(await client.callTool({ name: "echo", arguments: { text: "over stdio" } }))).toBe("echo: over stdio");
    } finally {
      await client.close();
    }
    // Its version: the installed npm package's own, or 0.0.0-dev for a build from this repository.
    const version = process.env["PILOTFISH_MCP_MANAGED_CLI"] ? (JSON.parse(readFileSync(join(dirname(cli), "package.json"), "utf8")) as { version: string }).version : "0.0.0-dev";
    expect((await promisify(execFile)(process.execPath, [cli, "--version"])).stdout.trim()).toBe(version);
    const { stderr } = await promisify(execFile)(process.execPath, [cli, "--check"], { env: { ...process.env, ...settings } });
    expect(stderr).toMatch(/^OK: .*\/mcp \(pilotfish 9\.9\.9\), 2 tools: echo, ask/);
    const refused = await promisify(execFile)(process.execPath, [cli, "--check"], { env: { ...process.env, ...settings, PILOTFISH_KEY: "pf_wrong-key-0123456789abcdef" } }).catch((e: { code: number; stderr: string }) => e);
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringMatching(/refused the API key/) });
  });
});
