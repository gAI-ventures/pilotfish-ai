# pilotfish browser

A plugin for Claude Code and Cursor that adds pilotfish's open MCP server (`@gaiventures/pilotfish-mcp`): a real
Google Chrome on your own computer that your agent drives through the `browser_*` tools. It opens pages, clicks,
types, fills forms and reads what each page says, and every action returns what changed on the page. Your agent's own
model decides every step; the server makes no model calls. Free and MIT licensed, with no account and no API key.

## Install

Claude Code:

```text
/plugin marketplace add gAI-ventures/pilotfish-ai
/plugin install pilotfish-browser@pilotfish
```

Cursor and VS Code: the install buttons in the [repository's README](https://github.com/gAI-ventures/pilotfish-ai#install) add the server in one click.

## What it needs

- Node.js 22 or later (the server starts with `npx -y @gaiventures/pilotfish-mcp`).
- Google Chrome or Chromium on the same computer. Set `PILOTFISH_CHROME` to its path if it is somewhere unusual, and
  `PILOTFISH_HEADLESS=1` to run it without a window.

## Use it

Ask your agent for something on the web, for example "open example.com and tell me the main heading". A Chrome window
opens and the agent works in it. Sign-ins, one-time codes and CAPTCHAs are handed to you in that window (the result
says `NEEDS A PERSON`), and the agent carries on once you have dealt with the page.

Tools, settings and setup per client: <https://pilotfish.gai.ventures/docs/open>. Issues: <https://github.com/gAI-ventures/pilotfish-ai/issues>.
