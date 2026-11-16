// Protocol-level tests that need no browser: the tool list (direct browser tools only), strict input
// validation, a start with no API key in the environment, and no model client anywhere in the package.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActOutcome } from "@pilotfish/agent";
import { configFromEnv } from "./config.js";
import { createMcpServer, Inputs, type PilotfishMcp } from "./server.js";
import { VERSION } from "./version.js";

const TOOLS = [
  "browser_actions", "browser_click", "browser_close", "browser_find", "browser_get_text", "browser_navigate", "browser_press", "browser_query",
  "browser_resume", "browser_screenshot", "browser_scroll", "browser_select", "browser_snapshot", "browser_tabs", "browser_type", "browser_wait",
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
    expect(Object.keys(Inputs).sort()).toEqual(TOOLS);
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
    expect(JSON.stringify(tools)).not.toContain("hunter2");
    expect(client.getInstructions()).toContain("{{pw}}");
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
