// A hard spending cap on model calls. A guarded client refuses any call once the budget is spent
// (counted from each response's usage at list prices; a model missing from the price table is
// counted at Opus prices so the cap always holds). A process's default clients share one budget:
// PILOTFISH_BUDGET_USD (a dollar amount, or "off"), shared across processes through
// PILOTFISH_BUDGET_LEDGER, or whatever the process set (setProcessBudget). Uncapped unless set.

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelProvider } from "./model-provider.js";
import { costOf, WEB_SEARCH_USD, type Usage } from "./usage.js";

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
    readonly scope: "test set" | "day" = "test set",
  ) {
    super(
      scope === "day"
        ? `Daily budget reached: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)} spent on model calls today (UTC). No more live calls until tomorrow; only the person can raise PILOTFISH_DAILY_BUDGET_USD.`
        : `Budget reached: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)} spent on model calls. Raise PILOTFISH_BUDGET_USD to allow more.`,
    );
    this.name = "BudgetExceededError";
  }
}

/** A cap on what every test set on this machine spends in one UTC day, kept in `<dir>/<date>.ledger`. */
export interface DailyCap {
  limitUsd: number;
  dir: string;
}

function sumLedger(file: string): number {
  if (!existsSync(file)) return 0;
  let sum = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const n = Number(line);
    if (line && Number.isFinite(n)) sum += n;
  }
  return sum;
}

const utcDay = (now = new Date()): string => now.toISOString().slice(0, 10);

/**
 * A spending cap. With a `ledger` file the cap is shared by every process that names it (a
 * benchmark suite runs each task in its own process): each call's cost is appended to the file,
 * and what is spent is what the file adds up to.
 */
export class Budget {
  private own = 0;
  calls = 0;
  readonly byModel = new Map<string, number>();
  constructor(
    readonly limitUsd: number,
    readonly ledger?: string,
    readonly daily?: DailyCap,
  ) {
    if (!(limitUsd >= 0)) throw new Error("A budget is a non-negative number of US dollars");
    if (daily && !(daily.limitUsd >= 0 && Number.isFinite(daily.limitUsd))) throw new Error("A daily budget is a non-negative number of US dollars");
  }
  /** Spent so far: this process's own calls, or everything in the shared ledger. */
  get spentUsd(): number {
    if (!this.ledger || !existsSync(this.ledger)) return this.own;
    return sumLedger(this.ledger);
  }
  /** The dated ledger today's spend goes to (null without a daily cap). */
  get dailyLedger(): string | null {
    return this.daily ? join(this.daily.dir, `${utcDay()}.ledger`) : null;
  }
  /** Spent today (UTC) by every test set on this machine; 0 without a daily cap. */
  get spentTodayUsd(): number {
    const f = this.dailyLedger;
    return f ? sumLedger(f) : 0;
  }
  get exhausted(): boolean {
    return this.spentUsd >= this.limitUsd || (!!this.daily && this.spentTodayUsd >= this.daily.limitUsd);
  }
  /** Throws when nothing is left. */
  ensure(): void {
    if (this.daily) {
      const today = this.spentTodayUsd;
      if (today >= this.daily.limitUsd) throw new BudgetExceededError(today, this.daily.limitUsd, "day");
    }
    if (this.spentUsd >= this.limitUsd) throw new BudgetExceededError(this.spentUsd, this.limitUsd);
  }
  add(model: string, u: Partial<Anthropic.Usage> | undefined): void {
    if (!u) return;
    const usage: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    // A hosted web search is billed per call on top of its tokens.
    const searches = (u as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
    this.charge(model, costOf(model, usage, { unknownAs: "claude-opus-5-5" }) + searches * WEB_SEARCH_USD);
  }
  /** Counts spend the guarded client did not see (another agent's own calls, priced by the caller). */
  charge(model: string, usd: number): void {
    if (!(usd > 0)) return;
    this.own += usd;
    // One short line per call: appends this small are atomic, so concurrent processes do not clash.
    if (this.ledger) appendFileSync(this.ledger, `${usd.toFixed(8)}\n`);
    const day = this.dailyLedger;
    if (day) {
      mkdirSync(this.daily!.dir, { recursive: true });
      appendFileSync(day, `${usd.toFixed(8)}\n`);
    }
    this.calls++;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + usd);
  }
  describe(): string {
    const set = Number.isFinite(this.limitUsd) ? `$${this.spentUsd.toFixed(4)} of $${this.limitUsd.toFixed(2)}` : `$${this.spentUsd.toFixed(4)} (no per-set cap)`;
    const day = this.daily ? `; today $${this.spentTodayUsd.toFixed(4)} of $${this.daily.limitUsd.toFixed(2)}` : "";
    return `${set} in ${this.calls} calls${day}`;
  }
}

/**
 * PILOTFISH_BUDGET_USD: a dollar amount, or "off". Unset: `fallbackUsd` (null = no cap).
 * PILOTFISH_BUDGET_LEDGER: a file shared by the processes of one set of runs.
 * `daily`, when given, holds even when the per-set cap is off.
 */
export function budgetFromEnv(fallbackUsd: number | null, env: Record<string, string | undefined> = process.env, daily: DailyCap | null = null): Budget | null {
  const raw = env["PILOTFISH_BUDGET_USD"]?.trim();
  const ledger = env["PILOTFISH_BUDGET_LEDGER"]?.trim() || undefined;
  let limitUsd = fallbackUsd;
  if (raw && /^(off|none|unlimited)$/i.test(raw)) limitUsd = null;
  else if (raw) {
    limitUsd = Number(raw);
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new Error("PILOTFISH_BUDGET_USD must be a dollar amount (e.g. 3) or \"off\"");
  }
  if (limitUsd === null) return daily ? new Budget(Infinity, ledger, daily) : null;
  return new Budget(limitUsd, ledger, daily ?? undefined);
}

// Kept on globalThis: a process may load this module twice (a package's source and its build output, in tests), and
// both must share the one budget.
const SLOT = Symbol.for("pilotfish.processBudget");
type Slot = { [SLOT]?: Budget | null };

/** The budget every default client of this process shares (from the environment, decided once, unless set). */
export function processBudget(): Budget | null {
  const g = globalThis as Slot;
  if (g[SLOT] === undefined) g[SLOT] = budgetFromEnv(null);
  return g[SLOT] ?? null;
}

/** Set the budget every default client made from now on shares (null: none). */
export function setProcessBudget(b: Budget | null): Budget | null {
  (globalThis as Slot)[SLOT] = b;
  return b;
}

/** A client that refuses calls once `budget` is spent and counts every response against it. */
export function guardClient(client: Anthropic, budget: Budget): Anthropic {
  const wrapMessages = <T extends object>(messages: T): T =>
    new Proxy(messages, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === "create" && typeof value === "function") {
          return async (params: { model: string }, options?: unknown) => {
            budget.ensure();
            const r = (await (value as (p: unknown, o?: unknown) => Promise<unknown>).call(target, params, options)) as { model?: string; usage?: Anthropic.Usage };
            // A streaming create returns a Stream without usage: those go through stream() here.
            if (r && typeof r === "object" && "usage" in r) budget.add(r.model ?? params.model, r.usage);
            return r;
          };
        }
        if (prop === "stream" && typeof value === "function") {
          return (params: { model: string }, options?: unknown) => {
            budget.ensure();
            const s = (value as (p: unknown, o?: unknown) => { finalMessage(): Promise<Anthropic.Message> }).call(target, params, options);
            s.finalMessage().then(
              (m) => budget.add(m.model ?? params.model, m.usage),
              () => undefined,
            );
            return s;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const messages = wrapMessages(client.messages);
  const beta = new Proxy(client.beta, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      return prop === "messages" && value && typeof value === "object" ? wrapMessages(value) : value;
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "messages") return messages;
      if (prop === "beta") return beta;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/**
 * The client a library default uses: the registered model provider's (model-provider.ts; the hosted service's sends
 * Claude through Anthropic and OpenAI models through OpenAI), guarded by the process budget when there is one.
 */
export function defaultClient(opts?: ConstructorParameters<typeof Anthropic>[0]): Anthropic {
  const client = modelProvider().client(opts);
  const b = processBudget();
  return b ? guardClient(client, b) : client;
}
