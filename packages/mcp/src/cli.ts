#!/usr/bin/env node
// pilotfish-mcp — pilotfish as an open MCP server (the client's model drives; no API key).
//   pilotfish-mcp                                       stdio (Claude Code, Claude Desktop, IDEs)
//   pilotfish-mcp --http [--port 8931] [--host 127.0.0.1]   Streamable HTTP at http://host:port/mcp
//
// Settings come from the environment (README.md). stdout belongs to the protocol in stdio mode:
// diagnostics go to stderr.

import { parseArgs } from "node:util";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { configFromEnv, type McpConfig } from "./config.js";
import { BrowserSession } from "./session.js";
import { createMcpServer } from "./server.js";
import { VERSION } from "./version.js";

const USAGE = `pilotfish-mcp — pilotfish browser automation as an open MCP server
Your MCP client's own model drives the browser: no API key, no model calls here.

  pilotfish-mcp                     serve over stdio (default)
  pilotfish-mcp --http [--port 8931] [--host 127.0.0.1]
                                    serve Streamable HTTP at http://host:port/mcp
  pilotfish-mcp --version           print the version

Environment (all optional): PILOTFISH_HEADLESS=1 (no window), PILOTFISH_ALLOWED_HOSTS,
PILOTFISH_ALLOW_PRIVATE=1, PILOTFISH_SECRETS (JSON), PILOTFISH_INTERVENTION_TIMEOUT_MS,
PILOTFISH_ALLOW_SCREENSHOTS=1, PILOTFISH_MCP_TOKEN (HTTP bearer token), PILOTFISH_CHROME.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string", default: "8931" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  let config: McpConfig;
  try {
    config = configFromEnv();
  } catch (e) {
    process.stderr.write(`pilotfish-mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }
  if (values.http) await serveHttp(config, values.host, Number(values.port));
  else await serveStdio(config);
}

async function serveStdio(config: McpConfig): Promise<void> {
  const pf = createMcpServer({ config });
  await pf.server.connect(new StdioServerTransport());
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Never leave a Chromium behind when the client goes away.
    void pf.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Streamable HTTP: one MCP session per client connection, one browser for the process (shared by
 * every session). Bind to loopback unless something with TLS and auth sits in front of it.
 */
async function serveHttp(config: McpConfig, host: string, port: number): Promise<void> {
  const token = process.env["PILOTFISH_MCP_TOKEN"];
  // Whoever reaches this port drives a browser: off loopback, a token is not optional.
  if (!LOOPBACK.has(host) && !token) throw new Error(`Refusing to serve on ${host} without PILOTFISH_MCP_TOKEN: anyone who can reach the port would control the browser.`);
  const session = new BrowserSession(config);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/mcp") return void res.writeHead(404).end();
      // DNS rebinding: a loopback server answers only loopback Host names.
      const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
      if (LOOPBACK.has(host) && !LOOPBACK.has(hostName)) return void res.writeHead(403).end("forbidden host");
      if (token && req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end("unauthorized");
      const sid = req.headers["mcp-session-id"];
      const existing = typeof sid === "string" ? transports.get(sid) : undefined;
      if (existing) return existing.handleRequest(req, res);
      if (sid) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      if (req.method !== "POST") return void res.writeHead(400).end("initialize first");
      const body = await readJson(req).catch(() => undefined);
      if (!isInitializeRequest(body)) return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad request: no valid session" }, id: null }));
      const pf = createMcpServer({ session });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
        void pf.close();
      };
      await pf.server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((e: unknown) => {
      process.stderr.write(`pilotfish-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(port, host, () => resolve()));
  const addr = http.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  process.stderr.write(`pilotfish-mcp: Streamable HTTP on http://${host.includes(":") ? `[${host}]` : host}:${bound}/mcp\n`);
  const shutdown = () => {
    http.close();
    void Promise.all([...transports.values()].map((t) => t.close().catch(() => undefined)))
      .then(() => session.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`pilotfish-mcp: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
