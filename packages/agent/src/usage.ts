// Token usage per model and an estimated cost, so a browser_task result can say what it spent.
// Prices are Anthropic list prices in $ per million tokens (the table the cost reports use);
// a model missing from the table is counted in tokens but not in the estimate.

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A hosted web search call, in $ (OpenAI and Anthropic list prices, 11 Nov 2026). */
export const WEB_SEARCH_USD = 0.01;

/** `call`: a flat $ per call on top of the token rates (for a model or tool billed per call). */
interface Rate { in: number; out: number; cr: number; cw: number; call?: number }
/** A model's price: $ per million tokens (input, output, cache read, cache write), optional per-call and long-context rates. */
export type ModelRate = Rate & { long?: Rate & { above: number } };
// `long`: the higher rate for a call whose prompt exceeds `above` tokens (Haiku 5.5's long-context
// tier, ~5x). The budget guard reads this table, so without the tier a long
// Haiku call is undercounted and the spend cap can be overrun.
const PRICES: Record<string, ModelRate> = {
  "claude-opus-5-5": { in: 4, out: 20, cr: 0.2, cw: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cr: 0.2, cw: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125, long: { above: 100_000, in: 0.5, out: 2.5, cr: 0.05, cw: 0.625 } },
  // OpenAI models, standard rates from OpenAI's pricing page (27 Nov 2026). OpenAI caches by itself and reports no
  // cache writes, so cw is never charged; cr is its cached-input rate. A prompt over 272K tokens is billed 2x input
  // and cached input and 1.5x output for the whole call.
  "gpt-6-luna": { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125, long: { above: 272_000, in: 0.2, out: 0.75, cr: 0.02, cw: 0.125 } },
  "gpt-6.1-terra": { in: 1, out: 5, cr: 0.05, cw: 1.25, long: { above: 272_000, in: 2, out: 7.5, cr: 0.1, cw: 1.25 } },
  "gpt-6.1-sol": { in: 2, out: 10, cr: 0.1, cw: 2.5, long: { above: 272_000, in: 4, out: 15, cr: 0.2, cw: 2.5 } },
  "gpt-6.2-sol": { in: 2, out: 10, cr: 0.1, cw: 2.5, long: { above: 272_000, in: 4, out: 15, cr: 0.2, cw: 2.5 } },
  "gpt-6.2-astra": { in: 8, out: 40, cr: 0.4, cw: 10, long: { above: 272_000, in: 16, out: 60, cr: 0.8, cw: 10 } },
  "gpt-5-mini": { in: 0.25, out: 2, cr: 0.025, cw: 0.25 },
  "gpt-5-nano": { in: 0.05, out: 0.4, cr: 0.005, cw: 0.05 },
  // A hosted web search (OpenAI's web_search tool, Anthropic's web_search): $10 per 1,000 calls at both, one usage
  // event per call (`searchTask`); the pages it reads are input tokens of the model that searched.
  web_search: { in: 0, out: 0, cr: 0, cw: 0, call: WEB_SEARCH_USD },
};

/**
 * Add (or replace) a model's price in this table for this process. The core prices the models anyone may call; the
 * hosting application registers, at startup, the prices of models only it calls, so its budget guard and usage
 * totals count them. A rate may define `call` as a getter to read its price on each call.
 */
export function registerModelPrice(model: string, rate: ModelRate): void {
  PRICES[model] = rate;
}

/** The rate for this usage: the long-context tier when the prompt is over its threshold, else base. */
function rateFor(p: ModelRate, u: Usage): Rate {
  return p.long && u.input + u.cacheRead + u.cacheWrite > p.long.above ? p.long : p;
}

/** List-price USD of one call's usage; null for an unpriced model (unless `unknownAs` names a priced one). */
export function costOf(model: string, u: Usage, o: { unknownAs?: string } = {}): number {
  const base = PRICES[model] ?? (o.unknownAs ? PRICES[o.unknownAs] : undefined);
  if (!base) return 0;
  const p = rateFor(base, u);
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cr + u.cacheWrite * p.cw) / 1e6 + (p.call ?? 0);
}

export class UsageMeter {
  private readonly byModel = new Map<string, Usage>();
  // Cost is accumulated PER CALL: the long-context tier is a property of one request's prompt size,
  // so applying it to a model's cumulative totals would price every token at 5x once the running total
  // crosses the threshold. null = no priced model has been added yet.
  private cost: number | null = null;
  private readonly costByModel = new Map<string, number>();

  add(model: string, u: Usage): void {
    const cur = this.byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.input += u.input;
    cur.output += u.output;
    cur.cacheRead += u.cacheRead;
    cur.cacheWrite += u.cacheWrite;
    this.byModel.set(model, cur);
    if (PRICES[model]) {
      const c = costOf(model, u);
      this.cost = (this.cost ?? 0) + c;
      this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + c);
    }
  }

  get models(): string[] {
    return [...this.byModel.keys()];
  }

  /** Each model's tokens and its cost (summed per call), for a per-model spending breakdown. */
  perModel(): Array<{ model: string; usage: Usage; costUsd: number }> {
    return [...this.byModel].map(([model, usage]) => ({ model, usage: { ...usage }, costUsd: this.costByModel.get(model) ?? 0 }));
  }

  get total(): Usage {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const u of this.byModel.values()) {
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      t.cacheWrite += u.cacheWrite;
    }
    return t;
  }

  /** Estimated USD, summed per call; null when no model used is priced. */
  get costUsd(): number | null {
    return this.cost;
  }
}

/** 12345 → "12.3k". */
export function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
