// Context editing for models the Anthropic API does not serve. Claude requests clear old tool results server-side
// (context_management, clear_tool_uses); an OpenAI model gets the same messages untouched, so its context only grows:
// on 4 Nov a GPT-6 Luna Best Buy run went from 8k to 111k input tokens over 40 calls, and on long runs the cached
// part of them was about 60% of its model cost. This applies the same edit before the request is sent.
//
// It must keep the provider's prompt cache useful, so the cleared part may only grow, and only in batches: a result is
// cleared once the context passes `trigger`, oldest first, `clearAtLeast` tokens at a time, never one of the latest
// `keep`, never a result of an excluded tool. The batches start from the oldest result every time, so the same
// conversation always clears the same results, and a request's prefix changes only when a new batch is needed.

import type Anthropic from "@anthropic-ai/sdk";

export interface ClearToolUses {
  /** Clear once the estimated input passes this many tokens. */
  trigger: number;
  /** The latest tool results never cleared. */
  keep: number;
  /** Clear in batches of at least this many tokens (each batch costs the provider's cache once). */
  clearAtLeast: number;
  /** Tools whose results are kept whatever their age (notes). */
  exclude?: string[];
  /** Tokens before the messages (system prompt and tools), counted toward the trigger. */
  baseTokens?: number;
}

/** What a cleared result says instead. */
export const CLEARED_RESULT = "[An older tool result, cleared to save context. The page as it is now is in a later result.]";

/** A rough token count: 4 characters a token, an image 1,600. */
export function estimateTokens(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) return content.reduce((n: number, b) => n + estimateTokens(b), 0);
  if (content && typeof content === "object") {
    const b = content as { type?: string; text?: string; content?: unknown; input?: unknown; thinking?: string };
    if (b.type === "image") return 1_600;
    if (typeof b.text === "string") return Math.ceil(b.text.length / 4);
    if (typeof b.thinking === "string") return Math.ceil(b.thinking.length / 4);
    if (b.content !== undefined) return estimateTokens(b.content);
    if (b.input !== undefined) return Math.ceil(JSON.stringify(b.input).length / 4);
  }
  return 0;
}

/** `messages` with the oldest tool results cleared as `edit` says (the input is not changed). */
export function clearOldToolResults(messages: Anthropic.MessageParam[], edit: ClearToolUses): Anthropic.MessageParam[] {
  const total = (edit.baseTokens ?? 0) + messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (total <= edit.trigger) return messages;
  // Tool names by tool_use id, for the excluded tools.
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
  // Every tool result, oldest first: [message index, block index, tokens].
  const results: Array<[number, number, number]> = [];
  messages.forEach((m, i) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return;
    m.content.forEach((b, j) => {
      if (b.type === "tool_result") results.push([i, j, estimateTokens(b.content)]);
    });
  });
  const candidates = results.slice(0, Math.max(0, results.length - edit.keep)).filter(([i, j]) => {
    const b = (messages[i]!.content as Anthropic.ContentBlockParam[])[j] as Anthropic.ToolResultBlockParam;
    return !(edit.exclude ?? []).includes(names.get(b.tool_use_id) ?? "") && b.content !== CLEARED_RESULT;
  });
  let cleared = 0;
  let n = 0;
  while (total - cleared > edit.trigger && n < candidates.length) {
    let batch = 0;
    while (batch < edit.clearAtLeast && n < candidates.length) batch += candidates[n++]![2];
    cleared += batch;
  }
  if (!n) return messages;
  const clear = new Set(candidates.slice(0, n).map(([i, j]) => `${i}:${j}`));
  return messages.map((m, i) => {
    if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some((_, j) => clear.has(`${i}:${j}`))) return m;
    return {
      ...m,
      content: m.content.map((b, j) => (clear.has(`${i}:${j}`) && b.type === "tool_result" ? { ...b, content: CLEARED_RESULT } : b)),
    };
  });
}
