// A reload by key is refused before it reaches the page (a Google Flights retry, 4 Nov, pressed Control+r and lost the
// search it had set up). No browser: the page is a stub that records key presses.
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";

function agentOnStub() {
  const pressed: string[] = [];
  const page = {
    url: "https://www.google.com/travel/flights/search?tfs=abc",
    press: async (key: string) => void pressed.push(key),
    loadState: async () => ({ readyState: "complete", pendingRequests: 0, contentType: "text/html" }),
  };
  const tabs = { current: page, count: 1, onTab: () => () => undefined, dispose: () => undefined, describe: () => "" };
  const client = { messages: { create: async () => ({}) }, beta: { messages: { create: async () => ({}) } } } as unknown as Anthropic;
  const agent = new Agent(page as never, { client, model: "fake", contextEditing: false, tabs: tabs as never, policy: { check: () => ({ kind: "allow" }) } });
  return { agent, pressed };
}

describe("press", () => {
  it("refuses a reload shortcut without pressing it, and says how to load the page again on purpose", async () => {
    for (const key of ["Control+r", "Meta+Shift+R", "F5"]) {
      const { agent, pressed } = agentOnStub();
      const out = await agent.act("press", { key });
      expect(out.ok, key).toBe(false);
      expect(out.text).toContain("reloads the page");
      expect(out.text).toContain("navigate to its URL");
      expect(pressed, key).toEqual([]);
    }
  });
});
