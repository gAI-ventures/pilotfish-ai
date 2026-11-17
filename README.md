# pilotfish MCP

[![npm: @gaiventures/pilotfish-mcp](https://img.shields.io/npm/v/@gaiventures/pilotfish-mcp?label=%40gaiventures%2Fpilotfish-mcp)](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp)
[![npm: @gaiventures/pilotfish-mcp-managed](https://img.shields.io/npm/v/@gaiventures/pilotfish-mcp-managed?label=%40gaiventures%2Fpilotfish-mcp-managed)](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp-managed)
[![MCP Registry: io.github.gAI-ventures/pilotfish](https://img.shields.io/badge/MCP_Registry-io.github.gAI--ventures%2Fpilotfish-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.gAI-ventures/pilotfish)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Give any MCP agent (Claude Code, Codex CLI, Cursor, ...) a real Chrome on your own computer. Free, no account, no
API key: your agent's own model reads each page and decides every step through the `browser_*` tools, and this
server makes no model calls. A page that offers its own tools through [WebMCP](https://webmachinelearning.github.io/webmcp/)
gets them listed with its snapshot, callable with `browser_page_tool`.

- **Install:** `npx -y @gaiventures/pilotfish-mcp` ([npm](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp))
- **Docs:** <https://pilotfish.gai.ventures/docs/open> (setup per client, tools, settings)
- **MCP Registry:** `io.github.gAI-ventures/pilotfish` ([listing](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.gAI-ventures/pilotfish))
- **Issues:** <https://github.com/gAI-ventures/pilotfish-mcp/issues>

## Install

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=pilotfish&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnYWl2ZW50dXJlcy9waWxvdGZpc2gtbWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_pilotfish-0098FF)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pilotfish%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540gaiventures%252Fpilotfish-mcp%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_pilotfish-24bfa5)](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pilotfish%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540gaiventures%252Fpilotfish-mcp%2522%255D%257D)

Each button opens the app with the server filled in, for you to review and add.

**Claude Code**, in a terminal:

```sh
claude mcp add pilotfish -- npx -y @gaiventures/pilotfish-mcp
```

or as a plugin, from this repository's plugin marketplace, inside Claude Code:

```text
/plugin marketplace add gAI-ventures/pilotfish-mcp
/plugin install pilotfish-browser@pilotfish
```

**Any other MCP client** (Codex CLI, Cline, Windsurf, ...): add this to its MCP settings.

```json
{
  "mcpServers": {
    "pilotfish": { "command": "npx", "args": ["-y", "@gaiventures/pilotfish-mcp"] }
  }
}
```

Node 22 or later and Google Chrome (or Chromium) on the same computer. Setup per client:
<https://pilotfish.gai.ventures/docs/open>.

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
| `plugins/pilotfish-browser` | The server as a plugin for Claude Code (`.claude-plugin/plugin.json`, `.mcp.json`) and Cursor (`.cursor-plugin/plugin.json`, `mcp.json`), listed by the marketplace files `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json`. |
| `.mcp.json` | The server entry, read by directories that index this repository; opening the repository in Claude Code offers to start it too. |

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
