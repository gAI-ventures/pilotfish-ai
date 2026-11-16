import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Budget, BudgetExceededError, budgetFromEnv, guardClient } from "./budget.js";

/** A stand-in client: every call reports `usage`; counts the calls that reached it. */
function fake(usage: Partial<Anthropic.Usage>, model = "claude-opus-5-5") {
  let calls = 0;
  const msg = () => ({ id: "m", model, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } });
  const client = {
    messages: {
      create: async () => (calls++, msg()),
      stream: () => {
        calls++;
        const m = msg();
        return { finalMessage: async () => m, on: () => undefined };
      },
      countTokens: async () => ({ input_tokens: 5 }),
    },
    beta: { messages: { create: async () => (calls++, msg()) } },
    apiKey: "k",
  } as unknown as Anthropic;
  return { client, calls: () => calls };
}

describe("spending cap", () => {
  it("counts each response at list prices and refuses calls once the cap is reached, before they are sent", async () => {
    // Opus 5.5: 1M input = $4, so 100k input tokens = $0.40 a call.
    const f = fake({ input_tokens: 100_000 });
    const b = new Budget(1);
    const c = guardClient(f.client, b);
    await c.messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] });
    await c.beta.messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] } as never);
    expect(b.spentUsd).toBeCloseTo(0.8);
    await c.messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] });
    expect(b.exhausted).toBe(true);
    await expect(c.messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(c.beta.messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] } as never)).rejects.toThrow(/Budget reached/);
    expect(() => c.messages.stream({ model: "claude-opus-5-5", max_tokens: 1, messages: [] })).toThrow(BudgetExceededError);
    expect(f.calls()).toBe(3);
    // Other client methods pass through untouched.
    expect(await c.messages.countTokens({ model: "x", messages: [] })).toEqual({ input_tokens: 5 });
    expect((c as unknown as { apiKey: string }).apiKey).toBe("k");
  });

  it("prices cache reads and writes, counts streams, and prices an unknown model as Opus", async () => {
    const b = new Budget(100);
    const c = guardClient(fake({ cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-haiku-5-5").client, b);
    await c.messages.create({ model: "claude-haiku-5-5", max_tokens: 1, messages: [] });
    // 2M prompt tokens (1M cache read + 1M cache write) crosses Haiku 5.5's 100k long-context
    // threshold, so the 5x tier applies: cache read 0.05 + cache write 0.625 + output 2.5 per million.
    expect(b.spentUsd).toBeCloseTo(0.05 + 0.625 + 2.5);
    // Below the threshold, the base rate applies.
    const base = new Budget(100);
    await guardClient(fake({ cache_read_input_tokens: 1_000, cache_creation_input_tokens: 1_000, output_tokens: 1_000_000 }, "claude-haiku-5-5").client, base).messages.create({ model: "claude-haiku-5-5", max_tokens: 1, messages: [] });
    expect(base.spentUsd).toBeCloseTo((1_000 * 0.01 + 1_000 * 0.125 + 1_000_000 * 0.5) / 1e6);
    const s = c.messages.stream({ model: "claude-haiku-5-5", max_tokens: 1, messages: [] });
    await s.finalMessage();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.calls).toBe(2);
    const u = new Budget(100);
    await guardClient(fake({ input_tokens: 1_000_000 }, "some-new-model").client, u).messages.create({ model: "some-new-model", max_tokens: 1, messages: [] });
    expect(u.spentUsd).toBeCloseTo(4);
  });

  it("shares one cap across processes through a ledger file", async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), "pf-ledger-")), "spend.ledger");
    const a = new Budget(1, ledger);
    const b = new Budget(1, ledger);
    await guardClient(fake({ input_tokens: 150_000 }).client, a).messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] });
    await guardClient(fake({ input_tokens: 150_000 }).client, b).messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] });
    expect(a.spentUsd).toBeCloseTo(1.2);
    expect(b.exhausted).toBe(true);
    await expect(guardClient(fake({}).client, a).messages.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [] })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("charges spend the client did not see, such as another agent's own calls", () => {
    const b = new Budget(1, undefined, { limitUsd: 10, dir: mkdtempSync(join(tmpdir(), "pf-daily-")) });
    b.charge("other-agent", 0.7);
    b.charge("other-agent", 0);
    expect(b.spentUsd).toBeCloseTo(0.7);
    expect(b.spentTodayUsd).toBeCloseTo(0.7);
    b.charge("other-agent", 0.4);
    expect(b.exhausted).toBe(true);
  });

  it("reads the cap from the environment: an amount, off, or the caller's default", () => {
    expect(budgetFromEnv(10, {})?.limitUsd).toBe(10);
    expect(budgetFromEnv(null, {})).toBeNull();
    expect(budgetFromEnv(10, { PILOTFISH_BUDGET_USD: "2.5" })?.limitUsd).toBe(2.5);
    expect(budgetFromEnv(10, { PILOTFISH_BUDGET_USD: "off" })).toBeNull();
    expect(budgetFromEnv(10, { PILOTFISH_BUDGET_USD: "0", PILOTFISH_BUDGET_LEDGER: "x.ledger" })?.ledger).toBe("x.ledger");
    expect(() => budgetFromEnv(10, { PILOTFISH_BUDGET_USD: "lots" })).toThrow(/dollar amount/);
    expect(budgetFromEnv(3, {}, { limitUsd: 10, dir: "d" })?.daily?.limitUsd).toBe(10);
    expect(budgetFromEnv(3, {})?.daily).toBeUndefined();
  });
});
