// browser_query's optional `schema`: the query's result checked against a JSON Schema, with the MCP SDK's own
// validator (Ajv, already loaded by the SDK), so no dependency of its own.

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

type Check = (value: unknown) => { valid: boolean; errorMessage?: string };

/** The schema is not one: thrown by schemaCheck with the reason. */
export class InvalidSchemaError extends Error {}

const CACHE_MAX = 32;
let ajv = new AjvJsonSchemaValidator();
let cache = new Map<string, Check>();
let meta: Check | null = null;

/** Ajv's errorsText ("data/0/price must be number, data must have required property 'x'") as `path: message` lines. */
export function errorLines(errorMessage: string | undefined, max = 5): string[] {
  if (!errorMessage) return [];
  return errorMessage
    .split(/, (?=data[/ ])/)
    .slice(0, max)
    .map((e) => {
      const m = /^data(\S*) ([\s\S]*)$/.exec(e);
      return m ? `${m[1] || "(root)"}: ${m[2]}` : e;
    });
}

/**
 * A check of values against `schema`, compiled once per distinct schema (a few kept). Throws InvalidSchemaError when
 * the schema is not a draft-07 JSON Schema or does not compile. `$schema` and `$id` are dropped: the validator is
 * draft-07, and an `$id` would tie the compiled schema to the first one sent under it.
 */
export function schemaCheck(schema: Record<string, unknown>): Check {
  const { $schema: _dialect, $id: _id, ...rest } = schema;
  const key = JSON.stringify(rest);
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size >= CACHE_MAX) {
    // A new validator lets go of every schema the old one compiled.
    ajv = new AjvJsonSchemaValidator();
    cache = new Map();
    meta = null;
  }
  meta ??= ajv.getValidator({ $ref: "http://json-schema.org/draft-07/schema#" });
  const shape = meta(rest);
  if (!shape.valid) throw new InvalidSchemaError(errorLines(shape.errorMessage, 1)[0] ?? "not a JSON Schema");
  let check: Check;
  try {
    check = ajv.getValidator(rest as never);
  } catch (e) {
    throw new InvalidSchemaError(String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200));
  }
  cache.set(key, check);
  return check;
}

/** The text browser_query shows when its result was cut (over 4,000 characters). */
const CUT = "...(truncated)";

/**
 * The value behind browser_query's text, checked against `check`. The text is the result as JSON, or a string result
 * as it is, so a text that parses is tried as JSON first and then as the string; an empty read carries a note after it.
 * Returns the value that passed, or the error lines of the first try.
 */
export function checkQueryText(textShown: string, check: Check): { ok: true; value: unknown } | { ok: false; lines: string[] } {
  if (textShown.endsWith(CUT)) return { ok: false, lines: ["(root): result over 4000 characters; return less"] };
  const empty = /^(\[\]|""|\s*) \(nothing matched\)/.exec(textShown);
  const tries: unknown[] = [];
  if (empty) tries.push(empty[1] === "[]" ? [] : "");
  else {
    try {
      tries.push(JSON.parse(textShown));
    } catch {
      // A string result, shown as it is.
    }
    tries.push(textShown);
  }
  let first: string[] | null = null;
  for (const value of tries) {
    const r = check(value);
    if (r.valid) return { ok: true, value };
    first ??= errorLines(r.errorMessage);
  }
  return { ok: false, lines: first ?? [] };
}
