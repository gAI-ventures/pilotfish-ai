# pilotfish MCP

Give any MCP agent (Claude Code, Codex CLI, Cursor, ...) a real Chrome on your own computer. Free, no account, no
API key: your agent's own model reads each page and decides every step through the `browser_*` tools, and this
server makes no model calls.

- **Install:** `npx -y @gaiventures/pilotfish-mcp` ([npm](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp))
- **Docs:** <https://pilotfish.gai.ventures/docs/open> (setup per client, tools, settings)
- **MCP Registry:** `io.github.gAI-ventures/pilotfish`

```json
{
  "mcpServers": {
    "pilotfish": { "command": "npx", "args": ["-y", "@gaiventures/pilotfish-mcp"] }
  }
}
```

## What is here

| Folder | What |
| --- | --- |
| `packages/mcp` | The local MCP server (stdio, or Streamable HTTP with `--http`): the tools, settings and the hand-off to a person. Published as `@gaiventures/pilotfish-mcp`. |
| `packages/mcp-managed` | A stdio relay to pilotfish's hosted MCP, for clients that only speak stdio. Published as `@gaiventures/pilotfish-mcp-managed`. |
| `packages/cdp` | A thin, typed Chrome DevTools Protocol client. |
| `packages/browser` | Launching Chrome and driving pages over raw CDP: frames, hit-tested input, settling after an action. |
| `packages/perception` | Structure-first page snapshots, element handles, and the evidence diff after each action. |
| `packages/interrupts` | Cookie banners and ads handled deterministically, with maintained rule sets. |
| `packages/agent` | The executor every tool runs through: policy before page-affecting actions, secrets typed as `{{name}}` and never shown to the model, evidence after. |

## The managed MCP

The hosted service (whole tasks run in pilotfish's cloud browser, saved logins, saved and scheduled tasks, replays)
is separate and is not in this repository. Connect to it at `https://pilotfish-be.gai.ventures/mcp`, or over stdio
with the relay in `packages/mcp-managed`: `npx -y @gaiventures/pilotfish-mcp-managed`. See
<https://pilotfish.gai.ventures/docs>.

## Build and test

Node 22 or later.

```sh
npm ci
npm run build
npm test                                                         # unit tests
PILOTFISH_E2E=1 npx vitest run packages/mcp --testTimeout 120000 # the MCP against a real Chrome
npm run package                                                  # the npm packages, in packages/*/npm-package
```

The browser tests use Google Chrome when it is installed; set `PILOTFISH_CHROME` to a Chromium binary to use another.

## Contributing

This repository is a mirror: it is published from pilotfish's own repository, and every sync replaces its whole tree.
Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
