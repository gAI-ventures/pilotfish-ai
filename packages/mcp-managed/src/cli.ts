#!/usr/bin/env node
// pilotfish-mcp-managed — your pilotfish account as an MCP server over stdio.
//   pilotfish-mcp-managed login            sign this machine in (shows a code to allow on pilotfish's page)
//   pilotfish-mcp-managed                  relay stdio ↔ pilotfish's hosted /mcp (the sign-in, or PILOTFISH_KEY)
//   pilotfish-mcp-managed --check          connect once, list the tools, exit
//   pilotfish-mcp-managed logout           sign this machine out
//
// stdout belongs to the protocol: diagnostics go to stderr.

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deviceLogin, logout, readSaved, tokenFileOf, TokenSource } from "./auth.js";
import { check, checkKey, DEFAULT_URL, endpointOf, relay, type ManagedOptions } from "./bridge.js";
import { VERSION } from "./version.js";

const USAGE = `pilotfish-mcp-managed — your pilotfish account (saved tasks, logins, cloud browser, stealth,
replays) as an MCP server over stdio.

  pilotfish-mcp-managed login      sign this machine in: open the page it shows (on any device), check the code, Allow
  pilotfish-mcp-managed logout     sign this machine out
  pilotfish-mcp-managed            relay stdio to pilotfish's hosted MCP endpoint
  pilotfish-mcp-managed --check    connect once, list the tools, exit
  pilotfish-mcp-managed --version  print the version

Environment:
  PILOTFISH_KEY         an organization API key (pf_...), instead of signing in: pilotfish app → Org settings → API keys
  PILOTFISH_URL         the pilotfish API (default ${DEFAULT_URL})
  PILOTFISH_TOKEN_FILE  where the sign-in is kept (default ~/.pilotfish/mcp-managed.json)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { check: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false }, version: { type: "boolean", short: "v", default: false } },
  });
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values.help) return void process.stderr.write(`${USAGE}\n`);
  const say = (m: string) => void process.stderr.write(`${m}\n`);
  const log = (m: string) => void process.stderr.write(`pilotfish-mcp-managed: ${m}\n`);
  const url = process.env["PILOTFISH_URL"]?.trim() || DEFAULT_URL;
  const file = process.env["PILOTFISH_TOKEN_FILE"]?.trim() || tokenFileOf();
  const command = positionals[0];
  if (command === "login") {
    try {
      await deviceLogin({ url, file, say });
      say(`Signed in. The sign-in is kept in ${file} (only you can read it).`);
      say(`Add the relay to your MCP client with: npx -y @gaiventures/pilotfish-mcp-managed`);
      process.exit(0);
    } catch (e) {
      log((e as Error).message);
      process.exit(1);
    }
  }
  if (command === "logout") {
    say((await logout(file)) ? `Signed out: the sign-in was revoked and ${file} removed.` : "This machine was not signed in.");
    process.exit(0);
  }
  if (command) {
    log(`unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
  }
  // An API key wins when set; else this machine's sign-in.
  let auth: Pick<ManagedOptions, "key" | "token">;
  if (process.env["PILOTFISH_KEY"]?.trim()) {
    try {
      auth = { key: checkKey(process.env["PILOTFISH_KEY"]) };
    } catch (e) {
      log((e as Error).message);
      process.exit(2);
    }
  } else {
    const saved = await readSaved(file);
    if (!saved) {
      log("Not signed in. Run: npx @gaiventures/pilotfish-mcp-managed login (or set PILOTFISH_KEY to an organization API key).");
      process.exit(2);
    }
    if (saved.url !== endpointOf(url).href.replace(/\/mcp\/?$/, "")) log(`the sign-in is for ${saved.url}, not ${url}: using ${saved.url}`);
    auth = { token: new TokenSource(saved, file) };
  }
  const target = auth.token ? auth.token.url : url;
  if (values.check) {
    try {
      const r = await check({ url: target, ...auth });
      process.stderr.write(`OK: ${endpointOf(target).href} (${r.server}), ${r.tools.length} tools: ${r.tools.join(", ")}\n`);
      process.exit(0);
    } catch (e) {
      log((e as Error).message);
      process.exit(1);
    }
  }
  const bridge = await relay(new StdioServerTransport(), { url: target, ...auth, log });
  const shutdown = () => void bridge.close().finally(() => process.exit(0));
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`pilotfish-mcp-managed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
