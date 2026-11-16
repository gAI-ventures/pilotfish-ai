// Tool schemas the model sees. Kept in one place, sorted by name at request
// time, with strict JSON schemas, so the rendered `tools` block is byte-stable
// across turns (prompt caching is a prefix match; tools render first).
//
// Design choices, each traced to published research:
//   * Ref-based targets ("e12"), never coordinates by default: ID-based action
//     spaces cut hallucinated actions from 34% to 2% on Mind2Web-Live.
//   * Every action returns EVIDENCE (structured before/after diff) and, when
//     the page changed, a fresh compact snapshot — so the model never has to
//     guess whether its last action did anything.
//   * `find` and `read_page(rootRef)` are cheap subtree queries; `screenshot`
//     and `zoom` are on-demand (vision costs 1–1.8K tokens per image).
//   * `run_js` exists because every 2026 leaderboard leader has a code tool,
//     but it is opt-in and runs in an isolated world.
//   * `done` is the only way to finish, and it requires evidence-backed claims.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const RefSchema = z.string().regex(/^f?\d*e\d+$/, 'An element ref like "e12" or "f1e3" from the latest page snapshot');

export const ToolInputs = {
  navigate: z.object({
    url: z.string().describe("Absolute URL to open (https://...). Use for direct navigation instead of typing into the address bar."),
  }),
  click: z.object({
    ref: RefSchema,
    button: z.enum(["left", "right", "middle"]).optional().describe("Default left"),
    double: z.boolean().optional().describe("Double-click"),
    modifiers: z.array(z.enum(["Shift", "Control", "Alt", "Meta"])).optional(),
    on_dialog: z.enum(["accept", "dismiss"]).optional().describe("How to answer a confirm/prompt dialog this click opens. Default: ordinary confirmations are accepted, irreversible ones go to the user"),
    prompt_text: z.string().optional().describe("Text to enter if the click opens a prompt() dialog"),
  }),
  click_xy: z.object({
    x: z.number().describe("CSS px from the viewport's left edge, as read off the latest screenshot"),
    y: z.number().describe("CSS px from the viewport's top edge"),
    button: z.enum(["left", "right", "middle"]).optional(),
    double: z.boolean().optional(),
  }),
  drag: z.object({
    from_ref: RefSchema.optional().describe("Element to drag (or give from_x/from_y)"),
    from_x: z.number().optional(),
    from_y: z.number().optional(),
    to_ref: RefSchema.optional().describe("Where to drop it (or give to_x/to_y)"),
    to_x: z.number().optional(),
    to_y: z.number().optional(),
  }),
  type_text: z.object({
    text: z.string().describe("Text typed into whatever has keyboard focus (canvas editors, after click_xy). {{secret}} placeholders work."),
  }),
  choose: z.object({
    ref: RefSchema.describe("An autocomplete/search box to type into, or a custom dropdown (button, combobox) to open"),
    value: z.string().describe("Text to type (for a box) and the option to pick: the best matching suggestion or option is clicked"),
    option: z.string().optional().describe("Exact option text to pick when it differs from what you type (e.g. type 'Goa', pick 'Goa, India')"),
  }),
  note: z.object({
    text: z.string().describe("A finding to keep: a value you read, which item you chose and why, a sub-result. Notes survive when old page snapshots are cleared, and the final check reads them."),
  }),
  upload_file: z.object({
    ref: RefSchema.describe("A file input, or the button that opens the file chooser"),
    files: z.array(z.string()).min(1).describe("Names of the files you were given (listed at the start of the task)"),
  }),
  read_file: z.object({
    file: z.string().describe('A download id from the evidence ("d1") or the name of a file you were given'),
    max_chars: z.number().int().min(500).max(100000).optional().describe("Default 30000"),
  }),
  switch_tab: z.object({
    tab: z.string().describe('Tab id from the TABS line, e.g. "t1"'),
  }),
  close_tab: z.object({
    tab: z.string().optional().describe("Tab id (default: the current tab)"),
  }),
  type: z.object({
    ref: RefSchema.describe("The input/textarea/contenteditable to type into"),
    text: z.string().describe("Text to enter. Use {{secret_name}} placeholders for credentials; they are substituted outside the model."),
    clear: z.boolean().optional().describe("Clear existing content first (default true)"),
    submit: z.boolean().optional().describe("Press Enter afterwards"),
    per_key: z.boolean().optional().describe("Dispatch one key event per character (for autocomplete/masked inputs). Slower."),
  }),
  fill: z.object({
    fields: z
      .array(
        z.object({
          ref: RefSchema.describe("An input, textarea, select, checkbox, radio or switch"),
          value: z.string().describe('Text to enter; for a <select> the option label; for a checkbox/radio/switch "true" (checked) or "false". {{secret_name}} placeholders work as in type.'),
        }),
      )
      .min(1)
      .max(40),
    submit_ref: RefSchema.optional().describe("Button to click after every field holds its value (omit to only fill)"),
  }),
  press: z.object({
    key: z.string().describe('Key or shortcut: "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Mod+a" (Mod = Cmd on macOS, Ctrl elsewhere)'),
  }),
  select_option: z.object({
    ref: RefSchema.describe("A <select> element"),
    values: z.array(z.string()).min(1).describe("Option labels or values to select"),
  }),
  scroll: z.object({
    direction: z.enum(["down", "up", "left", "right"]),
    amount: z.number().int().min(1).max(10).optional().describe("Viewport fractions (default 1 = roughly one screen)"),
    ref: RefSchema.optional().describe("Scroll inside this scroll container (|SCROLL| element) instead of the page"),
  }),
  hover: z.object({ ref: RefSchema }),
  go_back: z.object({}),
  wait: z.object({
    seconds: z.number().min(0.1).max(30).describe("Wait for slow pages; prefer small values and re-check evidence"),
  }),
  read_page: z.object({
    root_ref: RefSchema.optional().describe("Only this element's subtree"),
    whole_page: z.boolean().optional().describe("Include everything, not just the viewport band (default false)"),
    interactive_only: z.boolean().optional().describe("Omit context text (cheapest)"),
  }),
  find: z.object({
    query: z.string().describe("Words to look for in element role/name/text/attributes, e.g. 'add to cart' or 'email'"),
  }),
  get_text: z.object({
    max_chars: z.number().int().min(500).max(60000).optional().describe("Default 20000"),
    selector: z.string().min(1).max(300).optional().describe("Only the text inside the first element matching this CSS selector (e.g. 'main', '#results')"),
  }),
  screenshot: z.object({}),
  zoom: z.object({
    ref: RefSchema.optional().describe("Zoom on this element (padded)"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Or an explicit viewport region in CSS px"),
  }),
  run_js: z.object({
    expression: z.string().describe("JavaScript evaluated in the page (isolated world, DOM access, no page globals). Must return a JSON-serializable value. Use for reading data that is awkward through the tree."),
  }),
  query: z.object({
    expression: z.string().describe("Read-only JavaScript expression evaluated in the page (isolated world, DOM access). Return only the values you need as JSON, e.g. document.querySelector('#price')?.innerText. Must not click, type, submit or change the page."),
  }),
  collect: z.object({
    expression: z.string().describe("Read-only JavaScript expression that returns an array of strings, one per row now on the page, each in the shape the answer needs, e.g. [...document.querySelectorAll('article')].map(a => [a.querySelector('h3')?.innerText, a.querySelector('a')?.getAttribute('href')].join(' | ')). Must not click, type, submit or change the page."),
    count: z.number().int().min(1).max(500).describe("How many rows are wanted"),
  }),
  extract: z.object({
    instruction: z.string().describe("What to extract, e.g. 'all product names and prices in the results list'"),
    schema_json: z.string().optional().describe("Optional JSON Schema (as a JSON string) the result must match"),
  }),
  done: z.object({
    success: z.boolean(),
    result: z.string().describe("The answer the person reads (Markdown): the answer in one sentence, then the details as a short list. Complete: every item the task asked for, with the evidence you saw. Many rows or a long text a read returned in the shape asked for: never type them again. Write {{rows}} in their place for the rows of your latest collect, or {{last_read}} for your latest query, get_text or extract result in full, even where you were shown it cut short."),
    data_json: z.string().optional().describe("Structured output as a JSON string, if the task asked for structured data"),
  }),
  ask_user: z.object({
    question: z.string().describe("Only what the person alone can give: a 2FA code, a login, or a choice only they can make. With questions: one short line on what they are for."),
    questions: z
      .array(z.object({ question: z.string().describe("One thing to ask, short and complete on its own."), options: z.array(z.string()).optional().describe("The likely answers, when there are a few.") }))
      .optional()
      .describe("Several things the person must give, asked together in one form (one entry each): everything the task leaves to them that you know you will need, asked at once and as early as you know it, never one at a time. Not for codes, sign-ins or secrets."),
    kind: z.enum(["question", "code", "login", "signup", "passkey", "check"]).optional().describe('"code" for a verification/2FA code or anything secret: the answer is kept from you and typed as {{user_code}}. "login": the task needs an account here and you have no credentials: the person signs in through the live view (or has one created), then you continue. "signup": the task is to create an account here, or the person has none: they approve, then you get placeholders for its email and password and fill the sign-up form. "passkey": the site offers to create a passkey: the person decides whether pilotfish keeps one (then click create) or not (then dismiss it). "check": a CAPTCHA or bot check is on screen: the person passes it in the live view, then you continue.'),
  }),
} as const;

export type ToolName = keyof typeof ToolInputs;
export type ToolInput<N extends ToolName> = z.infer<(typeof ToolInputs)[N]>;

const DESCRIPTIONS: Record<ToolName, string> = {
  navigate: "Open a URL in the current tab. Returns evidence and a fresh page snapshot.",
  click: "Click an element by ref. Fails with a reason (obscured, stale, not visible) instead of clicking the wrong thing. Returns evidence + snapshot when the page changed. After a filter click, read the results in the same turn.",
  type: "Focus an element and enter text (clears existing text by default). Use submit:true to press Enter afterwards.",
  fill: "Fill several form fields in one action, then optionally click submit_ref. Every value is read back afterwards; if a field did not take its value the submit is NOT clicked and the field is reported. One evidence for the whole form. Use it for any form with 2+ fields.",
  click_xy: "Click at a viewport point read off a screenshot, when no ref fits: canvas, maps, charts, drawn widgets, or an element missing from the snapshot. Prefer refs: they survive layout changes and are hit-tested.",
  drag: "Drag an element or point onto another element or point (sortable lists, sliders, drag-and-drop uploads, maps).",
  type_text: "Type text into the element that currently has keyboard focus (canvas editors like Google Docs, after click_xy).",
  choose: "Pick from an autocomplete or a custom dropdown in one action: types the value (or opens the dropdown), waits for the suggestions, clicks the best match, and reports what was picked.",
  note: "Record a finding (values, choices, sub-results) for later steps and the final answer. Cheap; use it whenever you learn something the task needs. Read and note in the same turn.",
  upload_file: "Attach files to a file input (or to the upload button that opens the file chooser).",
  read_file: "Read a downloaded file or a file you were given as text (PDFs are extracted page by page).",
  switch_tab: "Work in another open tab (ids are on the TABS line, shown when more than one tab is open). Returns that tab's snapshot.",
  close_tab: "Close a tab (default: the current one) and continue in the tab that opened it.",
  press: "Press a key or shortcut on the focused element / page.",
  select_option: "Choose option(s) in a <select> by label or value.",
  scroll: "Scroll the page or a scroll container. Elements marked 'below the viewport' become visible after scrolling down.",
  hover: "Move the mouse over an element (opens hover menus/tooltips).",
  go_back: "Browser back.",
  wait: "Wait N seconds, then re-check the page. Use only when evidence says the network/DOM is still busy.",
  read_page: "Re-read the page tree (interactive elements have [refs]). Cheaper than a screenshot. Use root_ref to focus on a region.",
  find: "Search the current page for elements matching words; returns matching refs. Use before scrolling blindly.",
  get_text: "Readable text of the whole page (headings, paragraphs, links, field values). For reading content, not for finding targets.",
  screenshot: "Take a screenshot of the viewport. Use when layout/visual state matters (canvas, charts, images, ambiguous tree).",
  zoom: "Zoomed screenshot of an element or region for small text/icons.",
  run_js: "Run JavaScript in the page and return its value. Disabled unless the session allows it.",
  query: "Read values directly from the page with a small read-only JavaScript expression (returns JSON, max 4000 chars shown; a longer result is kept whole for {{last_read}} in done). Much cheaper than reading the whole page when you know what you need (a price, an order id, a count, a list of titles). What it stores on globalThis stays for later queries on the same page: collect rows there across scrolls of a list that unloads what scrolled away.",
  collect: "Gather the rows of a long or endless list (a feed, search results, reviews, a table that loads as it scrolls) in ONE call, instead of scrolling and reading by turns: starting at the top of the page, it is scrolled a screen at a time and your expression is run after each, every new row kept once and in order, until there are `count` rows or scrolling brings no more. Returns how many it has and the first of them; all of them are kept for {{rows}} in done's result.",
  extract: "Extract structured data from the current page text with a helper model. Returns JSON. Slow for a long list (the helper writes out every row): for many rows of the same shape, one query is far faster.",
  done: "Finish the task. Set success=false if the task cannot be completed and explain why. Never claim success without evidence from the page.",
  ask_user: "Pause and ask the person (blocks until answered), only for what they alone can give: a 2FA code, a login, a choice only they can make. Several values to ask (a form's details the task does not give): all in one call with questions, as soon as you know you need them. Not for confirmations (the system handles irreversible steps), not for ambiguities a reasonable reading settles, and never to have them look at or work the page for you, to ask how to work it (what to do about a step that will not work, where something is), or to read a progress note (refused).",
};

/**
 * The API accepts at most 20 strict tools per request. Strict (schema-guaranteed input) goes to the
 * tools used on almost every step; the rest are still validated locally (Zod, in Agent.execute).
 */
const STRICT_FIRST: ToolName[] = [
  "click", "type", "fill", "navigate", "done", "press", "select_option", "scroll", "find", "read_page",
  "get_text", "query", "note", "switch_tab", "go_back", "hover", "wait", "ask_user", "drag", "choose", "extract",
];
const MAX_STRICT = 20;
/**
 * The API also refuses a request whose strict tools have more than 24 optional parameters in all ("Schemas contains
 * too many optional parameters (25)... (limit: 24)", a 400 on every call of a run on a Claude model, 6 Nov). Strict
 * goes to the tools in STRICT_FIRST order while their optional parameters fit; one that would pass the limit stays
 * non-strict (still validated locally) and the next ones are still tried.
 */
export const MAX_STRICT_OPTIONAL = 24;

/** Optional parameters in a JSON schema: properties not required, at every level of nested objects. */
export function optionalParams(schema: unknown): number {
  if (!schema || typeof schema !== "object") return 0;
  const s = schema as { properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] };
  let n = 0;
  if (s.properties) {
    const req = new Set(s.required ?? []);
    for (const [k, v] of Object.entries(s.properties)) n += (req.has(k) ? 0 : 1) + optionalParams(v);
  }
  if (s.items) n += optionalParams(s.items);
  for (const a of s.anyOf ?? []) n += optionalParams(a);
  return n;
}

/** Build the Anthropic tool list (sorted; strict for up to 20 of them, within the optional-parameter limit) for a given enabled set. */
export function buildTools(enabled: ReadonlySet<ToolName>): Anthropic.Tool[] {
  const names = (Object.keys(ToolInputs) as ToolName[]).filter((n) => enabled.has(n)).sort();
  const schemas = new Map(names.map((n) => [n, toJsonSchema(ToolInputs[n]) as Anthropic.Tool.InputSchema]));
  const strict = new Set<ToolName>();
  let optional = 0;
  for (const n of new Set([...STRICT_FIRST, ...names])) {
    if (!enabled.has(n) || strict.size >= MAX_STRICT) continue;
    const o = optionalParams(schemas.get(n));
    if (optional + o > MAX_STRICT_OPTIONAL) continue;
    strict.add(n);
    optional += o;
  }
  return names.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    strict: strict.has(name),
    input_schema: schemas.get(name)!,
  }));
}

export const DEFAULT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "navigate", "click", "type", "press", "select_option", "scroll", "hover", "go_back", "wait",
  "read_page", "find", "get_text", "screenshot", "zoom", "extract", "done", "ask_user", "switch_tab", "close_tab", "read_file", "drag", "click_xy", "type_text", "choose",
]);

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Zod 4 ships a JSON Schema exporter; force draft-07-ish output with additionalProperties:false for strict mode.
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete json["$schema"];
  return stripForStrict(json);
}

function stripForStrict(node: Record<string, unknown>): Record<string, unknown> {
  // Strict tools need additionalProperties:false on every object. Optional
  // fields stay optional (omitted from `required`) rather than nullable: a
  // nullable enum would need null inside the enum list too, and the API
  // rejects schemas where they disagree.
  // Constraint keywords strict mode does not accept. They are still enforced
  // locally (Zod validation in Agent.execute), and are summarized into the
  // description so the model sees them.
  const notes: string[] = [];
  for (const [kw, label] of [
    ["minimum", "min"], ["maximum", "max"], ["exclusiveMinimum", "> "], ["exclusiveMaximum", "< "],
    ["minLength", "min length"], ["maxLength", "max length"], ["pattern", "pattern"],
    ["minItems", "min items"], ["maxItems", "max items"], ["multipleOf", "multiple of"], ["format", "format"],
  ] as const) {
    if (node[kw] !== undefined) {
      notes.push(`${label} ${String(node[kw])}`);
      delete node[kw];
    }
  }
  delete node["propertyNames"];
  if (notes.length) {
    const d = typeof node["description"] === "string" ? node["description"] : "";
    node["description"] = `${d}${d ? " " : ""}(${notes.join(", ")})`;
  }
  if (node["type"] === "object") {
    node["additionalProperties"] = false;
    const props = (node["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const k of Object.keys(props)) props[k] = stripForStrict(props[k]!);
    if (!node["required"]) node["required"] = [];
  }
  if (node["type"] === "array" && node["items"] && typeof node["items"] === "object") {
    node["items"] = stripForStrict(node["items"] as Record<string, unknown>);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[key])) node[key] = (node[key] as Record<string, unknown>[]).map(stripForStrict);
  }
  return node;
}
