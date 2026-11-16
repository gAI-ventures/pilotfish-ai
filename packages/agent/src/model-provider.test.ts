// The model provider hook (model-provider.ts): with none registered the core uses a model as asked, applies no
// context edit on the client and refuses a default client's calls; a registered one decides all three.
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { defaultClient } from "./budget.js";
import { DEFAULT_MODEL_PROVIDER, modelProvider, NO_PROVIDER_MESSAGE, registerModelProvider, type ModelProvider } from "./model-provider.js";

afterEach(() => registerModelProvider(null));

describe("the model provider", () => {
  it("with none registered: models as asked, no client-side edit, and a default client that refuses its calls (not its construction)", async () => {
    registerModelProvider(null);
    expect(modelProvider()).toBe(DEFAULT_MODEL_PROVIDER);
    expect(modelProvider().modelInUse("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelProvider().clientSideContextEdits("gpt-6-luna")).toBe(false);
    expect(modelProvider().jsonSchemaFormat?.("gpt-6-luna")).toBe(false);
    const client = defaultClient();
    await expect(client.messages.create({ model: "gpt-6-luna", max_tokens: 1, messages: [] })).rejects.toThrow(NO_PROVIDER_MESSAGE);
    await expect(client.beta.messages.create({ model: "gpt-6-luna", max_tokens: 1, messages: [] })).rejects.toThrow(NO_PROVIDER_MESSAGE);
  });

  it("a registered provider makes the default client and decides the model in use", async () => {
    const seen: string[] = [];
    const fake = { messages: { create: async (p: { model: string }) => (seen.push(p.model), { ok: true }) } } as unknown as Anthropic;
    const p: ModelProvider = { client: () => fake, modelInUse: (m) => (m.startsWith("claude-") ? "stand-in" : m), clientSideContextEdits: (m) => m === "stand-in" };
    registerModelProvider(p);
    expect(modelProvider()).toBe(p);
    expect(modelProvider().modelInUse("claude-haiku-5-5")).toBe("stand-in");
    expect(modelProvider().clientSideContextEdits("stand-in")).toBe(true);
    await defaultClient().messages.create({ model: "x", max_tokens: 1, messages: [] });
    expect(seen).toEqual(["x"]);
  });
});
