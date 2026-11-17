# Installing the pilotfish MCP server

These steps are for an AI agent (Cline, Claude Code, Cursor, Codex CLI…) setting up this server for its user.

## What it needs

- Node.js 22 or later (`node --version`).
- Google Chrome or Chromium installed on the same computer. It is found on its own; set `PILOTFISH_CHROME` to the
  browser's full path only if it is somewhere unusual.
- No account, no API key and no model key: the client's own model drives the browser through the `browser_*` tools,
  and this server makes no model calls.

## Add it to the client

Add this server entry to the client's MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "pilotfish": {
      "command": "npx",
      "args": ["-y", "@gaiventures/pilotfish-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

On Windows, if the client cannot start `npx` directly, use `"command": "cmd"` and
`"args": ["/c", "npx", "-y", "@gaiventures/pilotfish-mcp"]`.

## Check it works

1. Restart or reload the client's MCP servers; `pilotfish` should list its `browser_*` tools.
2. Call `browser_navigate` with `{ "url": "https://example.com" }`. A Chrome window opens and the reply shows the
   page's snapshot.

## Optional settings (environment variables)

- `PILOTFISH_HEADLESS=1` runs Chrome without a window.
- `PILOTFISH_CHROME=/path/to/chrome` picks the browser.

The full list of tools and settings: https://pilotfish.gai.ventures/docs/open-settings and
https://pilotfish.gai.ventures/docs/open-tools.
