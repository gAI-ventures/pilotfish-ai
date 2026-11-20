// Protocol-level tests that need no browser: the tool list (direct browser tools only), strict input
// validation, a start with no API key in the environment, and no model client anywhere in the package.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActOutcome } from "@pilotfish/agent";
import { configFromEnv } from "./config.js";
import { createMcpServer, Inputs, isBotWall, type PilotfishMcp } from "./server.js";
import { VERSION } from "./version.js";

const TOOLS = [
  "browser_actions", "browser_click", "browser_close", "browser_find", "browser_get_text", "browser_navigate", "browser_press", "browser_query",
  "browser_resume", "browser_screenshot", "browser_scroll", "browser_search", "browser_select", "browser_snapshot", "browser_tabs", "browser_type", "browser_wait",
];

/** Every credential a model client could pick up from the environment. */
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "PILOTFISH_MODEL"];

describe("tool input schemas", () => {
  it("are strict: unknown keys are rejected", () => {
    expect(Inputs.browser_click.safeParse({ ref: "e3" }).success).toBe(true);
    expect(Inputs.browser_click.safeParse({ ref: "e3", x: 10 }).success).toBe(false);
    expect(Inputs.browser_screenshot.safeParse({ full: true }).success).toBe(false);
  });

  it("are the direct browser tools only: no task runner of pilotfish's own", () => {
    // browser_page_tool (a page's WebMCP tools) is listed only once a page offers some (mcp.e2e.test.ts).
    expect(Object.keys(Inputs).sort()).toEqual([...TOOLS, "browser_page_tool"].sort());
  });

  it("take a page tool's name and an open object of arguments", () => {
    expect(Inputs.browser_page_tool.safeParse({ tool: "search_flights", arguments: { from: "DEL", to: { city: "BOM" } } }).success).toBe(true);
    expect(Inputs.browser_page_tool.safeParse({ tool: "search_flights" }).success).toBe(true);
    expect(Inputs.browser_page_tool.safeParse({ tool: "" }).success).toBe(false);
    expect(Inputs.browser_page_tool.safeParse({ tool: "x", arguments: "{}" }).success).toBe(false);
    expect(Inputs.browser_page_tool.safeParse({ tool: "x", input: {} }).success).toBe(false);
  });

  it("check refs, URLs and enums", () => {
    expect(Inputs.browser_click.safeParse({ ref: "f1e12" }).success).toBe(true);
    expect(Inputs.browser_click.safeParse({ ref: "button" }).success).toBe(false);
    expect(Inputs.browser_navigate.safeParse({ url: "https://example.com/a?b=1" }).success).toBe(true);
    expect(Inputs.browser_navigate.safeParse({ url: "https://example.com/", snapshot: false }).success).toBe(true);
    expect(Inputs.browser_navigate.safeParse({ url: "https://example.com/", snapshot: "no" }).success).toBe(false);
    expect(Inputs.browser_navigate.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(Inputs.browser_navigate.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(Inputs.browser_navigate.safeParse({ url: "example.com" }).success).toBe(false);
    expect(Inputs.browser_scroll.safeParse({ direction: "sideways" }).success).toBe(false);
    expect(Inputs.browser_select.safeParse({ ref: "e1", values: [] }).success).toBe(false);
  });

  it("check each browser_actions step as strictly as one tool: its own fields, all it needs, nothing of another action", () => {
    const steps = (...actions: unknown[]) => Inputs.browser_actions.safeParse({ actions });
    expect(
      steps(
        { action: "click", ref: "e1" },
        { action: "type", ref: "f1e2", text: "", submit: true },
        { action: "select", ref: "e3", values: ["Large"] },
        { action: "press", key: "Tab" },
        { action: "scroll", direction: "down" },
        { action: "wait", seconds: 1 },
      ).success,
    ).toBe(true);
    const refused = (step: unknown): string => {
      const r = steps(step);
      expect(r.success, JSON.stringify(step)).toBe(false);
      return r.error!.issues.map((i) => i.message).join("; ");
    };
    expect(refused({ action: "click" })).toMatch(/click needs ref/);
    expect(refused({ action: "type", ref: "e1" })).toMatch(/type needs text/);
    expect(refused({ action: "select", ref: "e1" })).toMatch(/select needs values/);
    expect(refused({ action: "press" })).toMatch(/press needs key/);
    expect(refused({ action: "scroll" })).toMatch(/scroll needs direction/);
    expect(refused({ action: "wait" })).toMatch(/wait needs seconds/);
    expect(refused({ action: "click", ref: "e1", text: "x" })).toMatch(/text is not a field of click \(it takes ref\)/);
    expect(refused({ action: "press", key: "Tab", ref: "e1" })).toMatch(/ref is not a field of press/);
    expect(refused({ action: "select", ref: "e1", values: ["a"], submit: true })).toMatch(/submit is not a field of select/);
    refused({ action: "click", ref: "the button" });
    refused({ action: "hover", ref: "e1" });
    refused({ action: "click", ref: "e1", x: 3 });
    expect(steps().success).toBe(false);
    expect(steps(...Array.from({ length: 11 }, () => ({ action: "press", key: "Tab" }))).success).toBe(false);
  });
});

describe("no model of its own", () => {
  it("nothing in the package imports, builds or runs a model client", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toContain("session.ts");
    for (const f of sources) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/from "(@anthropic-ai\/sdk|openai)"|\b(defaultClient|llmClient|Orchestrator|new Anthropic)\b/);
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@anthropic-ai/sdk");
    expect(Object.keys(pkg.dependencies)).not.toContain("openai");
  });

  it("starts and lists its tools with no API key in the environment", async () => {
    const saved = Object.fromEntries(MODEL_KEYS.map((k) => [k, process.env[k]]));
    for (const k of MODEL_KEYS) delete process.env[k];
    const pf = createMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "keyless", version: "1" });
    try {
      await pf.server.connect(serverSide);
      await client.connect(clientSide);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);
    } finally {
      await client.close();
      await pf.close();
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});

describe("MCP protocol (no browser)", () => {
  let pf: PilotfishMcp;
  let client: Client;

  beforeAll(async () => {
    pf = createMcpServer({ config: { ...configFromEnv({}), secrets: { pw: { value: "hunter2" } } } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  it("lists every tool with a strict schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      // Each word of the list is in every session's prompt: no JSON Schema dialect line, which no client needs.
      expect(t.inputSchema, t.name).not.toHaveProperty("$schema");
      expect(t.annotations, t.name).toBeDefined();
    }
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    expect(nav).toMatchObject({ title: "Open a URL", inputSchema: { type: "object", required: ["url"] }, execution: { taskSupport: "forbidden" } });
    // Secret names (never values) are advertised where the model types them.
    const type = tools.find((t) => t.name === "browser_type")!;
    expect(type.description).toContain("{{pw}}");
    // Choosing an option is reversible and repeatable: not destructive, idempotent.
    expect(tools.find((t) => t.name === "browser_select")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(JSON.stringify(tools)).not.toContain("hunter2");
    expect(client.getInstructions()).toContain("{{pw}}");
  });

  it("says the same thing in the tool list and the README: the snapshot option, and the verified-effect address rule (17 Nov)", async () => {
    const { tools } = await client.listTools();
    const readme = readFileSync(new URL("../README.npm.md", import.meta.url), "utf8");
    const row = (name: string) => readme.split(/\r?\n/).find((l) => l.startsWith(`| \`${name}\``)) ?? "";
    // Every tool whose schema takes `snapshot` says so in its README row, and no other tool does.
    for (const t of tools) {
      const takes = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>).includes("snapshot");
      expect(row(t.name).includes("snapshot?"), t.name).toBe(takes);
    }
    expect(tools.filter((t) => Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>).includes("snapshot")).map((t) => t.name).sort()).toEqual(
      ["browser_actions", "browser_click", "browser_navigate", "browser_press", "browser_scroll", "browser_select", "browser_type", "browser_wait"],
    );
    // The address rule, in both: built from the task's words or a shown parameter; the applied state checked on the
    // page (never the address or a search box) before results are used; else the site's form or an honest limit;
    // sign-in, session, identity and tracking values never written.
    const nav = tools.find((t) => t.name === "browser_navigate")!.description ?? "";
    for (const [desc, doc] of [
      ["build one from the task's own words", "built from the task's words"],
      ["change a parameter this site has shown you in an address or link", "changing a parameter the site has shown"],
      ["its page number included", "its page number included"],
      ["check on the page that what you meant was applied", "the page must show what was meant applied"],
      ["the results themselves", "the results themselves"],
      ["never the address or a search box, which can repeat a value the site ignored", "never the address or a search box, which can repeat a value the site ignored"],
      ["use the site's own form, or say in the answer what could not be applied", "the site's own form is used or the answer says what could not be applied"],
      ["Never write a sign-in, session, account, identity or tracking value yourself", "Sign-in, session, account, identity and tracking values are never written"],
      // An extremum from a sort: the top answers it only when the order ranks by the task's measure over its bounds.
      ["The top is the answer only when that order ranks by what the task asks over everything inside its bounds", "when that order does not rank by the task's measure over everything inside its bounds"],
      ["say how much was read and call the pick the best of those read, not the best", "says how much was read and calls its pick the best of those read, not the best"],
    ]) {
      expect(nav, desc).toContain(desc);
      expect(row("browser_navigate"), doc).toContain(doc);
    }
    // The @ notation for ARIA-role tags, in the snapshot description and its README row.
    const snapDesc = tools.find((t) => t.name === "browser_snapshot")!.description ?? "";
    expect(snapDesc).toContain("<@button> is a div or span with role=button, not a native <button>");
    expect(row("browser_snapshot")).toContain("`<@button>` is a div or span with `role=\"button\"`, not a native `<button>`");
    // Expectations (Stage C): exactly the acting tools that take `expect` say so in their README rows, with escalate.
    const takesExpect = tools.filter((t) => Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>).includes("expect")).map((t) => t.name).sort();
    expect(takesExpect).toEqual(["browser_click", "browser_navigate", "browser_press", "browser_select", "browser_type"]);
    for (const t of tools) expect(row(t.name).includes("expect?, escalate?"), t.name).toBe(takesExpect.includes(t.name));
    expect(readme).toContain("`MATCHED`, `UNMET`, `ALREADY HELD`");
    // The provenance-only wording is gone from both.
    for (const old of ["from memory or guesswork", "made up"]) {
      expect(nav).not.toContain(old);
      expect(row("browser_navigate")).not.toContain(old);
    }
  });

  it("lists types, required fields, enums and number ranges, but no check only the server needs; calls are still checked in full (18 Nov)", async () => {
    const { tools } = await client.listTools();
    // Nested objects only: each tool's own arguments stay closed (the test above).
    const listed = JSON.stringify(tools.map((t) => ({ ...t.inputSchema, additionalProperties: undefined })));
    for (const k of ['"pattern"', '"minLength"', '"maxLength"', '"format"', '"additionalProperties":false']) expect(listed, k).not.toContain(k);
    for (const k of ['"enum"', '"required"', '"minimum"', '"maxItems"']) expect(listed, k).toContain(k);
    // expect is spelled out on browser_click and pointed to elsewhere.
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(props("browser_click")["expect"]!["properties"] as object).sort()).toEqual(["gone", "in", "text", "url", "within"]);
    for (const name of ["browser_navigate", "browser_type", "browser_select", "browser_press"]) {
      expect(props(name)["expect"], name).toEqual({ description: "As in browser_click.", type: "object" });
    }
    // The checks left out of the list still run: a ref that is no ref, and an unknown field, are refused with a reason.
    const bad = await client.callTool({ name: "browser_click", arguments: { ref: "button one" } });
    expect(bad.isError).toBe(true);
    const extra = await client.callTool({ name: "browser_type", arguments: { ref: "e1", text: "x", expect: { text: "ok", colour: "red" } } });
    expect(extra.isError).toBe(true);
  });

  it("reports this package's version (a repository build: 0.0.0-dev; the npm package: its published version)", () => {
    expect(VERSION).toBe("0.0.0-dev");
    expect(client.getServerVersion()).toEqual({ name: "pilotfish", version: VERSION });
  });

  it("tells the client's model it drives: no task runner, model or API key of pilotfish's own", async () => {
    const said = `${client.getInstructions()}\n${JSON.stringify((await client.listTools()).tools)}`;
    expect(said).not.toMatch(/browser_task|browser_intervention|API key|ANTHROPIC|PILOTFISH_MODEL|pilotfish's own model/i);
    // Each rule once, in the description of the tool it is used with; the instructions hold only this server's settings.
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description!;
    expect(description("browser_navigate")).toMatch(/the site's own sort or tab for that order/);
    expect(description("browser_resume")).toMatch(/When a result says NEEDS A PERSON[^"]*tell the user[^"]*pilotfish browser window[^"]*call this/);
    expect(JSON.stringify(tools).match(/the site's own sort/g)).toHaveLength(1);
    expect(client.getInstructions()).toBe("Secrets are typed as placeholders and never shown: {{pw}}.");
  });

  it("sends no instructions at all when nothing is configured: every session's start costs only the cached tool list", async () => {
    const plain = createMcpServer({ config: configFromEnv({}) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "plain", version: "1" });
    try {
      await plain.server.connect(serverSide);
      await c.connect(clientSide);
      expect(c.getInstructions()).toBeUndefined();
    } finally {
      await c.close();
      await plain.close();
    }
  });

  it("rejects bad input before touching the browser", async () => {
    const r = await client.callTool({ name: "browser_click", arguments: { ref: "the blue button" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/Input validation error/);
    expect(pf.session.launched).toBe(false);
  });

  it("closes cleanly when no browser was ever started", async () => {
    const r = await client.callTool({ name: "browser_close", arguments: {} });
    expect(JSON.stringify(r.content)).toContain("No browser was open");
  });

  it("browser_resume with no browser says what to call", async () => {
    const r = await client.callTool({ name: "browser_resume", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("No browser is open. Next: browser_navigate to open one.");
  });
});

describe("browser_query schema (the query's result stubbed: no browser)", () => {
  let pf: PilotfishMcp;
  let client: Client;
  /** What the executor's query returns next, as the agent prints it; how many times it ran. */
  let next: ActOutcome = { ok: true, summary: "", text: "" };
  let ran = 0;
  const query = async (expression: string, schema?: Record<string, unknown>, shown?: string) => {
    if (shown !== undefined) next = { ok: true, summary: `query: ${shown.length} chars`, text: shown };
    return (await client.callTool({ name: "browser_query", arguments: { expression, ...(schema ? { schema } : {}) } })) as CallToolResult;
  };
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  beforeAll(async () => {
    pf = createMcpServer({ config: configFromEnv({}) });
    pf.session.act = async () => {
      ran++;
      return next;
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "schema", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  const PRICES = { type: "array", items: { type: "object", properties: { title: { type: "string" }, price: { type: "number" } }, required: ["title", "price"] } };

  it("no schema: the reply as before, and no structuredContent", async () => {
    const r = await query("x", undefined, '[{"title":"A","price":3}]');
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('[{"title":"A","price":3}]');
    expect(r.structuredContent).toBeUndefined();
  });

  it("a result that matches: the same reply, plus the parsed value under structuredContent.value", async () => {
    const r = await query("x", PRICES, '[{"title":"A","price":3},{"title":"B","price":4.5}]');
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('[{"title":"A","price":3},{"title":"B","price":4.5}]');
    expect(r.structuredContent).toEqual({ value: [{ title: "A", price: 3 }, { title: "B", price: 4.5 }] });
    // A string result is shown as it is: it matches a string schema even when it reads as JSON.
    expect((await query("x", { type: "string" }, "42")).structuredContent).toEqual({ value: "42" });
    expect((await query("x", { type: "string", minLength: 3 }, "plain words")).structuredContent).toEqual({ value: "plain words" });
    // An empty read (with its note) is the empty value.
    expect((await query("x", { type: "array", maxItems: 0 }, "[] (nothing matched)")).structuredContent).toEqual({ value: [] });
    // A JSON Schema dialect line is accepted.
    expect((await query("x", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "number" }, "7")).structuredContent).toEqual({ value: 7 });
  });

  it("a result that does not match: ERROR schema_mismatch, at most 5 path lines, then what to do", async () => {
    const r = await query("x", PRICES, JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, price: `$${i}` }))));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const lines = textOf(r).split("\n");
    expect(lines[0]).toBe("ERROR schema_mismatch");
    expect(lines.slice(1, -1)).toEqual(["/0/price: must be number", "/1/price: must be number", "/2/price: must be number", "/3/price: must be number", "/4/price: must be number"]);
    expect(lines.at(-1)).toBe("Next: fix the expression and run browser_query again.");
    expect(textOf(await query("x", { type: "object", required: ["a"] }, '{"b":1}'))).toBe("ERROR schema_mismatch\n(root): must have required property 'a'\nNext: fix the expression and run browser_query again.");
    expect(textOf(await query("x", PRICES, "[1,2]...(truncated)"))).toContain("(root): result over 4000 characters; return less");
    expect((await query("x", { type: "array", minItems: 1 }, "[] (nothing matched)")).isError).toBe(true);
  });

  it("an invalid schema: ERROR invalid_schema with the reason, and the query never runs", async () => {
    const before = ran;
    const bad = await query("x", { type: "nonsense" }, "1");
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^ERROR invalid_schema: \S/);
    expect(textOf(await query("x", { required: "title" }, "1"))).toMatch(/^ERROR invalid_schema: \/required: must be array$/);
    expect(textOf(await query("x", { $ref: "#/definitions/missing" }, "1"))).toMatch(/^ERROR invalid_schema: .*missing/);
    expect(ran).toBe(before);
  });

  it("a failed query is returned as it is, schema or not", async () => {
    next = { ok: false, summary: "query failed", text: "Error: x is not defined" };
    const r = await query("x", PRICES);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Error: x is not defined");
  });

  it("the parameter costs one short line in the tool list", async () => {
    const { tools } = await client.listTools();
    const q = tools.find((t) => t.name === "browser_query")!;
    expect(q.inputSchema.required).toEqual(["expression"]);
    expect(JSON.stringify((q.inputSchema.properties as Record<string, unknown>)["schema"])).toBe('{"description":"JSON Schema the result must match","type":"object"}');
  });
});

describe("output boundary scan (the executor stubbed: no browser; 18 Nov)", () => {
  const SECRET = "hunter2-xyz";
  let pf: PilotfishMcp;
  let client: Client;
  let next: ActOutcome | Error = { ok: true, summary: "", text: "" };
  let ran = 0;
  const say = (text: string): ActOutcome => ({ ok: true, summary: text.slice(0, 40), text });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const unsafe = (r: CallToolResult) => r.isError === true && textOf(r).startsWith("UNSAFE_OUTPUT") && r.structuredContent === undefined;

  beforeAll(async () => {
    pf = createMcpServer({ config: { ...configFromEnv({}), secrets: { pw: { value: SECRET }, pin: { value: "Zx" } } } });
    pf.session.act = async () => {
      ran++;
      if (next instanceof Error) throw next;
      return next;
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "boundary", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  it("control: a reply with no secret value is given exactly", async () => {
    next = say("plain page text");
    const r = await call("browser_get_text", {});
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("plain page text");
  });

  it("a secret value in text the executor returned unscrubbed is withheld whole", async () => {
    next = say(`see ${SECRET} here`);
    const r = await call("browser_get_text", {});
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("a configured value under 3 characters is withheld whole (control: the same reply without it is given)", async () => {
    next = say("hello world");
    expect((await call("browser_get_text", {})).isError).toBeFalsy();
    next = say("hello Zx");
    const r = await call("browser_get_text", {});
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Zx");
  });

  it("a secret as a structuredContent key is withheld whole, with no structured content (control: another key is given)", async () => {
    next = say('{"ok":1}');
    const ok = await call("browser_query", { expression: "x", schema: { type: "object" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ value: { ok: 1 } });
    next = say(`{"${SECRET}":1}`);
    const r = await call("browser_query", { expression: "x", schema: { type: "object" } });
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("a secret in a schema-constrained result is withheld before validation, never schema_mismatch (control: a short clean value validates)", async () => {
    next = say("abc");
    expect((await call("browser_query", { expression: "x", schema: { type: "string", maxLength: 3 } })).structuredContent).toEqual({ value: "abc" });
    next = say(SECRET);
    const r = await call("browser_query", { expression: "x", schema: { type: "string", maxLength: 3 } });
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(textOf(r)).not.toMatch(/schema_mismatch/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("KEY ONLY: a structured key holding the secret, where no text and no JSON value holds a recognized form of it, is withheld whole (control: a key without it is given)", async () => {
    // The text escapes one character of the key (h = "h"): no recognized form of the secret is in it; the parsed
    // value's only string holding the secret is its key.
    const keyOnly = '{"\\u0068unter2-xyz":1}';
    expect(keyOnly).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(keyOnly) as object)).toEqual([SECRET]);
    expect(Object.values(JSON.parse(keyOnly) as object)).toEqual([1]);
    next = say('{"\\u006fk":1}');
    const ok = await call("browser_query", { expression: "x", schema: { type: "object" } });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    expect(ok.structuredContent).toEqual({ value: { ok: 1 } });
    next = say(keyOnly);
    const r = await call("browser_query", { expression: "x", schema: { type: "object" } });
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("an invalid schema while a secret is configured: a truthful ERROR invalid_schema without the secret, the query never run; one whose diagnostic would echo the secret is withheld whole", async () => {
    const before = ran;
    const plain = await call("browser_query", { expression: "x", schema: { type: "nonsense" } });
    expect(plain.isError).toBe(true);
    expect(textOf(plain)).toMatch(/^ERROR invalid_schema: \S/);
    expect(JSON.stringify(plain)).not.toContain(SECRET);
    const echoing = await call("browser_query", { expression: "x", schema: { $ref: `#/definitions/${SECRET}` } });
    expect(echoing.isError).toBe(true);
    expect(JSON.stringify(echoing)).not.toContain(SECRET);
    expect(textOf(echoing)).toMatch(/^(UNSAFE_OUTPUT|ERROR invalid_schema)/);
    expect(echoing.structuredContent).toBeUndefined();
    expect(ran).toBe(before);
  });

  it("a thrown error holding a secret is withheld whole (control: a plain thrown error passes through as an error)", async () => {
    next = new Error("plain failure");
    const plain = await call("browser_click", { ref: "e1" });
    expect(plain.isError).toBe(true);
    expect(textOf(plain)).toContain("plain failure");
    next = new Error(`failed at https://x.example/?k=${SECRET}`);
    const r = await call("browser_click", { ref: "e1" });
    expect(unsafe(r), textOf(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("browser_get_text (the executor stubbed: no browser; 20 Nov)", () => {
  let pf: PilotfishMcp;
  let client: Client;
  let next: ActOutcome = { ok: true, summary: "", text: "" };
  const inputs: Record<string, unknown>[] = [];
  const read = async (args: Record<string, unknown> = {}) => (await client.callTool({ name: "browser_get_text", arguments: args })) as CallToolResult;
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const page = (body: string): ActOutcome => ({ ok: true, summary: "get_text", text: `PAGE TEXT (https://shop.example/):\n${body}` });

  beforeAll(async () => {
    pf = createMcpServer({ config: configFromEnv({}) });
    pf.session.act = async (_name, input) => {
      inputs.push(input);
      return next;
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "get-text", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  it("asks for 8,000 characters laid out with the main content first; a selector reads that part only, as before", async () => {
    next = page("x".repeat(700));
    await read();
    expect(inputs.at(-1)).toEqual({ max_chars: 8000, structured: true, main_first: true });
    await read({ selector: "#results", max_chars: 3000 });
    expect(inputs.at(-1)).toEqual({ max_chars: 3000, selector: "#results" });
    await read({ offset: 8000 });
    expect(inputs.at(-1)).toEqual({ max_chars: 8000, structured: true, main_first: true, offset: 8000 });
    await read({ mode: "links" });
    expect(inputs.at(-1)).toEqual({ max_chars: 8000, structured: true, main_first: true, mode: "links" });
  });

  it("the same long text twice in a row is one line the second time; a changed page or a short one comes whole", async () => {
    next = page("a".repeat(900));
    expect(textOf(await read())).toBe(`PAGE TEXT (https://shop.example/):\n${"a".repeat(900)}`);
    const again = textOf(await read());
    expect(again).toMatch(/^UNCHANGED: the same 935 characters as your last browser_get_text/);
    next = page("b".repeat(900));
    expect(textOf(await read())).toContain("bbbb");
    next = page("short");
    expect(textOf(await read())).toContain("short");
    expect(textOf(await read())).toContain("short");
  });

  it("an error or another kind of reply is given as it is and resets the memory", async () => {
    next = page("c".repeat(900));
    await read();
    next = { ok: false, summary: "failed", text: "Error: no page" };
    const r = await read();
    expect(r.isError).toBe(true);
    next = page("c".repeat(900));
    expect(textOf(await read())).toContain("cccc");
  });

  it("offset and mode are strict inputs", () => {
    expect(Inputs.browser_get_text.safeParse({ offset: 100, mode: "links" }).success).toBe(true);
    expect(Inputs.browser_get_text.safeParse({ offset: -1 }).success).toBe(false);
    expect(Inputs.browser_get_text.safeParse({ mode: "html" }).success).toBe(false);
  });
});

describe("isBotWall: a short bot-check or traffic-block page (20 Nov)", () => {
  it.each([
    "DuckDuckGo Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human. Select all squares containing a duck: Submit",
    "Brave Search Verifying you're not a bot Quick check before you continue searching. Verify",
    "Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.",
    "403 - Forbidden Sorry your network appears to be sending automated queries so we can't process your search at this time.",
    "Access Temporarily Suspended To prevent possible abuse of our service, your ability to connect has been suspended at this time.",
    "Confirm you're not a robot Our system has detected unusual traffic from your network. Please solve the challenge below.",
  ])("a wall: %s", (t) => expect(isBotWall(t)).toBe(true));
  it.each([
    "",
    "Tompkins Square Park is a 10.5-acre public park in the East Village neighborhood of Manhattan.",
    "Sign in to your account. Email Password Forgot password?",
    `${"A long article about how CAPTCHAs work and why sites ask you to prove you are human. ".repeat(30)}`,
  ])("not a wall: %s", (t) => expect(isBotWall(t)).toBe(false));
});

describe("browser_navigate notes (the executor stubbed: no browser; 20 Nov)", () => {
  let pf: PilotfishMcp;
  let client: Client;
  let navOk = true;
  let page: [string, string] = ["shop.example", "A normal page with products and prices."];
  const nav = async (url: string) => (await client.callTool({ name: "browser_navigate", arguments: { url, snapshot: false } })) as CallToolResult;
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  beforeAll(async () => {
    pf = createMcpServer({ config: { ...configFromEnv({}), headless: true } });
    pf.session.act = async (name) => {
      if (name === "query") return { ok: true, summary: "query", text: JSON.stringify(page) };
      return navOk ? { ok: true, summary: "navigate", text: "EVIDENCE: navigated" } : { ok: false, summary: "navigate: 404", text: "This URL does not exist on shop.example (HTTP 404)." };
    };
    pf.session.obstacle = async () => null;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "nav", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  it("a page that loaded clean gets no note; a bot-check page gets one line", async () => {
    expect(textOf(await nav("https://shop.example/"))).not.toMatch(/BOT CHECK|NOTE:/);
    page = ["search.example", "Unfortunately, bots use Search too. Please complete the following challenge to confirm this search was made by a human."];
    expect(textOf(await nav("https://search.example/?q=x"))).toMatch(/^BOT CHECK: search\.example answered with a bot check, which this headless browser cannot pass\./m);
    page = ["shop.example", "A normal page with products and prices."];
  });

  it("four failed addresses of the last six earn one nudge, then none until six more", async () => {
    navOk = false;
    const outs: string[] = [];
    for (let i = 0; i < 10; i++) outs.push(textOf(await nav(`https://shop.example/guess-${i}`)));
    navOk = true;
    const nudged = outs.map((o) => /^NOTE: \d of your last \d addresses failed/m.test(o));
    expect(nudged.filter(Boolean).length).toBe(2);
    expect(nudged.indexOf(true)).toBeLessThanOrEqual(3);
  });
});

describe("browser_search (21 Nov: a search API, no browser; the HTTP client stubbed)", () => {
  const connect = async (env: Record<string, string>, searchFetch?: typeof fetch, secrets = {}) => {
    const pf = createMcpServer({ config: { ...configFromEnv(env), secrets }, ...(searchFetch ? { searchFetch } : {}) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "search", version: "1" });
    await pf.server.connect(serverSide);
    await client.connect(clientSide);
    return { pf, client, close: async () => (await client.close(), await pf.close()) };
  };
  const names = async (env: Record<string, string>) => {
    const c = await connect(env);
    try {
      return (await c.client.listTools()).tools.map((t) => t.name);
    } finally {
      await c.close();
    }
  };

  it("is listed by default, and navigate points to it; off with PILOTFISH_SEARCH=0, and by default when the browser is limited to some sites", async () => {
    expect(await names({})).toContain("browser_search");
    expect(await names({ PILOTFISH_SEARCH: "0" })).not.toContain("browser_search");
    expect(await names({ PILOTFISH_ALLOWED_HOSTS: "example.com" })).not.toContain("browser_search");
    expect(await names({ PILOTFISH_ALLOWED_HOSTS: "example.com", PILOTFISH_SEARCH: "1" })).toContain("browser_search");
    const c = await connect({});
    try {
      const nav = (await c.client.listTools()).tools.find((t) => t.name === "browser_navigate")!.description!;
      expect(nav).toContain("search the web first with browser_search, not a search engine's own page,");
    } finally {
      await c.close();
    }
    const off = await connect({ PILOTFISH_SEARCH: "off" });
    try {
      const nav = (await off.client.listTools()).tools.find((t) => t.name === "browser_navigate")!.description!;
      expect(nav).toContain("search the web first with your own search tool to pick the site");
      expect(nav).not.toContain("browser_search");
    } finally {
      await off.close();
    }
  });

  it("answers with the results, never opening the browser; a key from the environment is used; a query holding a secret value never leaves", async () => {
    const sent: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(`${String(url)} ${String(init?.body)}`);
      return new Response(JSON.stringify({ results: [{ title: "Trout Lake Trail", url: "https://www.nps.gov/trout", snippet: "A lake trail" }] }), { status: 200 });
    }) as typeof fetch;
    const c = await connect({ KEENABLE_API_KEY: "keen_test" }, fetchFn, { pw: { value: "hunter2-secret" } });
    try {
      const r = (await c.client.callTool({ name: "browser_search", arguments: { query: "hikes near Seattle", max_results: 2 } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect((r.content[0] as { text: string }).text).toContain("1. Trout Lake Trail\n   https://www.nps.gov/trout");
      expect(sent[0]).toMatch(/^https:\/\/api\.keenable\.ai\/v1\/search \{"query":"hikes near Seattle","max_results":2/);
      expect(c.pf.session.launched).toBe(false);
      const leak = (await c.client.callTool({ name: "browser_search", arguments: { query: "who uses hunter2-secret" } })) as CallToolResult;
      expect(leak.isError).toBe(true);
      expect(sent).toHaveLength(1);
      expect(Inputs.browser_search.safeParse({ query: "x", site: "https://evil/" }).success).toBe(false);
      expect(Inputs.browser_search.safeParse({ query: "x", max_results: 11 }).success).toBe(false);
    } finally {
      await c.close();
    }
  });
});

describe("open and read in one call, and search engines' addresses (21 Nov; the executor and search stubbed)", () => {
  const calls: string[] = [];
  let navOk = true;
  const searched: string[] = [];
  const searchFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    searched.push(JSON.parse(String(init?.body)).query);
    return new Response(JSON.stringify({ results: [{ title: "Fafnir journal", url: "https://journal.finfar.org/articles/x", snippet: "Dragons" }] }), { status: 200 });
  }) as typeof fetch;
  const connect = async (env: Record<string, string>) => {
    const pf = createMcpServer({ config: configFromEnv(env), searchFetch });
    pf.session.act = async (name, input) => {
      calls.push(`${name} ${JSON.stringify(input)}`);
      if (name === "navigate") return navOk ? { ok: true, summary: "navigate", text: "EVIDENCE:\n- navigated: https://site.example/a" } : { ok: false, summary: "navigate", text: "navigate failed (navigation_failed): no such host" };
      if (name === "query") return { ok: false, summary: "query", text: "" };
      return { ok: true, summary: "get_text", text: `PAGE TEXT (https://site.example/a):\n${"words ".repeat(150)}` };
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "open-read", version: "1" });
    await pf.server.connect(serverSide);
    await client.connect(clientSide);
    return { client, close: async () => (await client.close(), await pf.close()) };
  };
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  it("browser_get_text with a url opens it without a snapshot, then reads it; a failed load is said as navigate says it, with nothing read", async () => {
    const c = await connect({ PILOTFISH_HEADLESS: "1" });
    try {
      calls.length = 0;
      const r = (await c.client.callTool({ name: "browser_get_text", arguments: { url: "https://site.example/a" } })) as CallToolResult;
      expect(calls[0]).toBe('navigate {"url":"https://site.example/a"}');
      expect(calls.at(-1)).toBe('get_text {"max_chars":8000,"structured":true,"main_first":true}');
      expect(textOf(r)).toMatch(/^PAGE TEXT \(https:\/\/site\.example\/a\)/);
      navOk = false;
      calls.length = 0;
      const bad = (await c.client.callTool({ name: "browser_get_text", arguments: { url: "https://nope.example/" } })) as CallToolResult;
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatch(/navigate failed/);
      expect(calls.some((x) => x.startsWith("get_text"))).toBe(false);
      expect(Inputs.browser_get_text.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    } finally {
      navOk = true;
      await c.close();
    }
  });

  it("headless, a search engine's results address is answered by the search API and the browser is not moved; its other pages, and a headed browser, open as asked", async () => {
    const c = await connect({ PILOTFISH_HEADLESS: "1" });
    try {
      calls.length = 0;
      searched.length = 0;
      const r = (await c.client.callTool({ name: "browser_navigate", arguments: { url: "https://www.google.com/search?q=Emily+Midkiff+2014+Fafnir", snapshot: false } })) as CallToolResult;
      expect(textOf(r)).toMatch(/^NOT OPENED: www\.google\.com's results page .* for "Emily Midkiff 2014 Fafnir"[^\n]*\nSEARCH RESULTS for "Emily Midkiff 2014 Fafnir" \(1;/);
      expect(calls).toEqual([]);
      const viaRead = (await c.client.callTool({ name: "browser_get_text", arguments: { url: "https://duckduckgo.com/?q=fafnir+dragons" } })) as CallToolResult;
      expect(textOf(viaRead)).toMatch(/^NOT OPENED: duckduckgo\.com's/);
      expect(searched).toEqual(["Emily Midkiff 2014 Fafnir", "fafnir dragons"]);
      expect(calls).toEqual([]);
      await c.client.callTool({ name: "browser_navigate", arguments: { url: "https://www.google.com/maps/search/gyms", snapshot: false } });
      expect(calls[0]).toMatch(/^navigate /);
    } finally {
      await c.close();
    }
    const headed = await connect({ PILOTFISH_HEADLESS: "0" });
    try {
      calls.length = 0;
      await headed.client.callTool({ name: "browser_navigate", arguments: { url: "https://www.bing.com/search?q=x", snapshot: false } });
      expect(calls[0]).toMatch(/^navigate /);
    } finally {
      await headed.close();
    }
    const off = await connect({ PILOTFISH_HEADLESS: "1", PILOTFISH_SEARCH: "0" });
    try {
      calls.length = 0;
      await off.client.callTool({ name: "browser_navigate", arguments: { url: "https://www.bing.com/search?q=x", snapshot: false } });
      expect(calls[0]).toMatch(/^navigate /);
    } finally {
      await off.close();
    }
  });
});
