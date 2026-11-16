// The managed MCP for stdio clients: relays every JSON-RPC message between a local transport (the
// client's stdio) and pilotfish's hosted MCP endpoint (Streamable HTTP, /mcp), with an organization API key or the
// person's own sign-in (`login`, the OAuth device flow: auth.ts) as the bearer token. Nothing is interpreted here: the tools, their answers and the job's
// questions are the hosted server's, so this works with whatever the server offers. Elicitation (the
// server asking the person) passes through both ways like any other message.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isJSONRPCRequest, isJSONRPCResultResponse, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { TokenSource } from "./auth.js";
import { VERSION } from "./version.js";

/** The hosted pilotfish API (its MCP endpoint is `${url}/mcp`). */
export const DEFAULT_URL = "https://pilotfish-be.gai.ventures";

export interface ManagedOptions {
  /** The pilotfish API's base URL, or its /mcp endpoint. Default DEFAULT_URL. */
  url?: string;
  /** One of the organization's API keys (`pf_...`; its admins make them in the app: Org settings → API keys). */
  key?: string;
  /** Or the person's own sign-in (`pilotfish-mcp-managed login`): its access token, refreshed as it runs out. */
  token?: TokenSource;
  /** Diagnostics (stderr in the CLI: stdout belongs to the protocol). */
  log?: (message: string) => void;
}

/** `https://host` or `https://host/mcp` → the MCP endpoint. */
export function endpointOf(url = DEFAULT_URL): URL {
  const u = new URL(url);
  if (!/\/mcp\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, "")}/mcp`;
  return u;
}

/** A key as the app hands it out; catches a pasted placeholder or a stray quote before any request. */
export function checkKey(key: string | undefined): string {
  const k = (key ?? "").trim();
  if (!k) throw new Error("PILOTFISH_KEY is not set: use one of your organization's API keys (an admin makes them in the pilotfish app: Org settings → API keys).");
  if (!/^pf_[A-Za-z0-9_-]{16,}$/.test(k)) throw new Error("PILOTFISH_KEY does not look like a pilotfish API key (pf_...). Copy it again from Org settings → API keys.");
  return k;
}

function remoteTransport(o: ManagedOptions): StreamableHTTPClientTransport {
  if (o.token) return new StreamableHTTPClientTransport(endpointOf(o.url), { fetch: o.token.fetch() });
  if (!o.key) throw new Error("No API key and no sign-in: set PILOTFISH_KEY, or run: npx @gaiventures/pilotfish-mcp-managed login");
  return new StreamableHTTPClientTransport(endpointOf(o.url), { requestInit: { headers: { authorization: `Bearer ${o.key}` } } });
}

/** What a failed relay tells the client: a refused key gets the way to a working one. */
export function explain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ended this sign-in|Run: npx/.test(m)) return m;
  if (/\b401\b|unauthori[sz]ed/i.test(m)) return "pilotfish refused the API key or sign-in (revoked, rotated, mistyped, or its organization was deleted). With a key: ask an admin of your organization for a current one (Org settings → API keys). Signed in: run npx @gaiventures/pilotfish-mcp-managed login again.";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m)) return `Cannot reach pilotfish (${m}). Check PILOTFISH_URL and your connection.`;
  return `pilotfish: ${m}`;
}

/** The hosted endpoint no longer knows the session (it was restarted or deployed, or the session went idle). */
function sessionGone(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 404 || /\bHTTP 404\b|Session not found/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Relay `local` ↔ the hosted endpoint until either side closes. A request the server cannot be
 * reached for is answered with a JSON-RPC error (the client's call returns instead of hanging).
 *
 * Hosted sessions live in the server's memory: after a deploy, or once a session sat idle, the server answers 404
 * "Session not found". The client of a stdio server never re-initializes, so the relay does it for it: a new remote
 * session, the client's own initialize replayed (and notifications/initialized), then the message sent again, once.
 */
export async function relay(local: Transport, o: ManagedOptions): Promise<{ close(): Promise<void> }> {
  let remote = remoteTransport(o);
  const initIds = new Set<string | number>();
  /** The client's initialize, replayed on a new remote session. */
  let initRequest: JSONRPCMessage | null = null;
  /** A new remote session under way: every message that met the 404 meanwhile waits for it. */
  let reopening: Promise<void> | null = null;
  const replays = new Map<string | number, (m: JSONRPCMessage) => void>();
  let reopened = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Ends the hosted session (DELETE) so the server lets go of it at once.
    await remote.terminateSession().catch(() => undefined);
    await Promise.all([remote.close().catch(() => undefined), local.close().catch(() => undefined)]);
  };
  const protocolFrom = (t: StreamableHTTPClientTransport, m: JSONRPCMessage) => {
    const v = isJSONRPCResultResponse(m) ? (m.result as { protocolVersion?: unknown }).protocolVersion : undefined;
    if (typeof v === "string") t.setProtocolVersion(v);
  };
  const wire = (t: StreamableHTTPClientTransport) => {
    t.onmessage = (m: JSONRPCMessage) => {
      // The answer to a replayed initialize is the relay's own: the client already has its session.
      if ("id" in m && m.id !== undefined && replays.has(m.id) && !("method" in m)) {
        replays.get(m.id)!(m);
        replays.delete(m.id);
        return;
      }
      // The negotiated version goes on every later HTTP request (the client SDK does this itself; a relay must).
      if (isJSONRPCResultResponse(m) && initIds.delete(m.id)) protocolFrom(t, m);
      void local.send(m).catch((e: unknown) => o.log?.(`relay to client: ${e instanceof Error ? e.message : String(e)}`));
    };
    t.onerror = (e) => o.log?.(explain(e));
    t.onclose = () => {
      if (t === remote) void close();
    };
  };
  /** A new remote session with the client's own initialize; the old transport is let go without closing the relay. */
  const reopen = (stale: StreamableHTTPClientTransport): Promise<void> => {
    if (remote !== stale) return reopening ?? Promise.resolve();
    reopening ??= (async () => {
      o.log?.("pilotfish ended the session (a restart or a long idle): opening a new one");
      const next = remoteTransport(o);
      wire(next);
      remote = next;
      void stale.close().catch(() => undefined);
      await next.start();
      const id = `pilotfish-relay-reinit-${++reopened}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answered = new Promise<JSONRPCMessage>((resolve, reject) => {
        replays.set(id, resolve);
        timer = setTimeout(() => reject(new Error("pilotfish did not answer the new session in 30 s")), 30_000);
      });
      const res = await Promise.all([answered, next.send({ ...(initRequest as object), id } as JSONRPCMessage)])
        .then(([r]) => r)
        .finally(() => {
          clearTimeout(timer);
          replays.delete(id);
        });
      if (!isJSONRPCResultResponse(res)) throw new Error(`pilotfish refused the new session: ${JSON.stringify((res as { error?: unknown }).error ?? res)}`);
      protocolFrom(next, res);
      await next.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().finally(() => {
      reopening = null;
    });
    return reopening;
  };
  const fail = (m: JSONRPCMessage, e: unknown) => {
    o.log?.(explain(e));
    if (isJSONRPCRequest(m)) void local.send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: explain(e) } }).catch(() => undefined);
  };
  local.onmessage = (m: JSONRPCMessage) => {
    if (isJSONRPCRequest(m) && m.method === "initialize") {
      initIds.add(m.id);
      initRequest = m;
    }
    void (async () => {
      // Sent at once (in order) unless a new session is being opened, which it then waits for.
      if (reopening) await reopening.catch(() => undefined);
      const via = remote;
      try {
        await via.send(m);
      } catch (e) {
        // Sent once more on a new session; an initialize, or a second refusal, goes back to the client.
        if (!sessionGone(e) || !initRequest || m === initRequest || closed) return fail(m, e);
        try {
          await reopen(via);
          await remote.send(m);
        } catch (e2) {
          fail(m, e2);
        }
      }
    })();
  };
  wire(remote);
  local.onerror = (e) => o.log?.(`client transport: ${e.message}`);
  local.onclose = () => void close();
  await remote.start();
  await local.start();
  return { close };
}

/** Connect with the key and list the tools: proves the URL and the key work. */
export async function check(o: ManagedOptions): Promise<{ server: string; tools: string[] }> {
  const client = new Client({ name: "pilotfish-mcp-managed-check", version: VERSION });
  try {
    await client.connect(remoteTransport(o));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    return { server: `${client.getServerVersion()?.name ?? "?"} ${client.getServerVersion()?.version ?? ""}`.trim(), tools };
  } catch (e) {
    throw new Error(explain(e));
  } finally {
    await client.close().catch(() => undefined);
  }
}
