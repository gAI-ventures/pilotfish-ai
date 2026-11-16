// Where the agent's model calls go when the caller passes no client. The core never names a provider: the hosting
// application registers one at startup (registerModelProvider). With none registered, a model is used as asked, no context edit is applied
// on the client, and a call through the default client is refused: pass AgentOptions.client (the open MCP passes
// one that refuses every call).

import type Anthropic from "@anthropic-ai/sdk";

export type ClientOptions = ConstructorParameters<typeof Anthropic>[0];

export interface ModelProvider {
  /** The client a caller that passed none gets: an Anthropic Messages-shaped client. */
  client(opts?: ClientOptions): Anthropic;
  /** The model a call actually goes to (a provider may stand one model in for another). */
  modelInUse(model: string): string;
  /** Whether this model's requests get old tool results cleared on the client (its API has no server-side context editing). */
  clientSideContextEdits(model: string): boolean;
  /** Whether this model takes a JSON schema as `output_config.format` (structured output by schema). */
  jsonSchemaFormat?(model: string): boolean;
  /** Whether this model takes that format with `strict: true` (its API enforces the schema; structureOutput, structured.ts). */
  strictJsonSchema?(model: string): boolean;
}

export const NO_PROVIDER_MESSAGE = "no model provider registered; pass AgentOptions.client";

/**
 * A client whose every call is refused (a rejected promise, as an API error is: never a throw where it is made, so
 * building an agent with no provider works until it calls a model).
 */
function refusingClient(): Anthropic {
  const refuse = async (): Promise<never> => {
    throw new Error(NO_PROVIDER_MESSAGE);
  };
  const messages = {
    create: refuse,
    stream: () => {
      const done = refuse();
      done.catch(() => undefined);
      const s = { on: () => s, finalMessage: () => done };
      return s;
    },
  };
  return new Proxy({} as Anthropic, {
    get(_t, prop) {
      if (prop === "messages") return messages;
      if (prop === "beta") return { messages };
      return undefined;
    },
  });
}

/** What the core does with no provider registered. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = {
  client: () => refusingClient(),
  modelInUse: (model) => model,
  clientSideContextEdits: () => false,
  jsonSchemaFormat: () => false,
  strictJsonSchema: () => false,
};

// Kept on globalThis: a process may load this module twice (a package's source and its build output, in tests), and
// both must see the one provider the host registered.
const SLOT = Symbol.for("pilotfish.modelProvider");
type Slot = { [SLOT]?: ModelProvider | null };

/** Register the provider every default client and model choice goes through (null: back to the defaults). */
export function registerModelProvider(p: ModelProvider | null): void {
  (globalThis as Slot)[SLOT] = p;
}

/** The registered provider, or the defaults (DEFAULT_MODEL_PROVIDER). */
export function modelProvider(): ModelProvider {
  return (globalThis as Slot)[SLOT] ?? DEFAULT_MODEL_PROVIDER;
}
