// The hosted client against a scripted fetch: requests as the API takes them, typed errors from the error envelope,
// retries (429 after retryAfterS whatever the method; 5xx and network failures for reads only), wait, stream, pages.
import { describe, expect, it } from "vitest";
import { Pilotfish } from "./client.js";
import { AuthenticationError, BadRequestError, ConflictError, ConnectionError, NotFoundError, PaymentRequiredError, PilotfishError, RateLimitError, ServerError, WaitTimeoutError } from "./errors.js";
import { parseWebhook, signWebhook, verifyWebhook } from "./webhooks.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

function scripted(answers: Array<(c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url: new URL(String(input)), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const next = answers.shift();
    if (!next) throw new Error(`no answer scripted for ${c.method} ${c.url.pathname}`);
    return next(c);
  }) as typeof fetch;
  return { calls, client: (o: { maxRetries?: number } = {}) => new Pilotfish({ apiKey: "pf_test", baseUrl: "https://api.example/", fetch: fetchImpl, ...o }) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const job = (o: Record<string, unknown> = {}) => ({ id: "job_1", threadId: "job_1", status: "queued", task: "t", question: null, result: null, createdAt: 1, updatedAt: 1, finishedAt: null, ...o });

describe("Pilotfish (hosted client)", () => {
  it("needs a key, and sends it with each request to the base URL", async () => {
    const before = process.env["PILOTFISH_API_KEY"];
    delete process.env["PILOTFISH_API_KEY"];
    expect(() => new Pilotfish()).toThrow(/No API key/);
    if (before !== undefined) process.env["PILOTFISH_API_KEY"] = before;
    const s = scripted([() => json(job(), 201)]);
    const t = await s.client().tasks.create({ task: "find the lamp", maxSteps: 12, outputSchema: { type: "object" } });
    expect(t.id).toBe("job_1");
    const c = s.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.href).toBe("https://api.example/jobs");
    expect(c.headers["authorization"]).toBe("Bearer pf_test");
    expect(c.headers["user-agent"]).toMatch(/^pilotfish-sdk-ts\//);
    expect(c.body).toEqual({ task: "find the lamp", maxSteps: 12, outputSchema: { type: "object" } });
  });

  it("turns each error status into its class, with code, hint, docs, fields and the body", async () => {
    const cases: Array<[number, unknown]> = [
      [400, BadRequestError],
      [401, AuthenticationError],
      [402, PaymentRequiredError],
      [404, NotFoundError],
      [409, ConflictError],
      [500, ServerError],
    ];
    for (const [status, cls] of cases) {
      const s = scripted([() => json({ error: "nope", code: `c${status}`, hint: "do x", docs: "https://d", fields: [{ path: "task", message: "too short" }], balanceUsd: 0 }, status)]);
      const err = await s.client({ maxRetries: 0 }).tasks.create("x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls as typeof PilotfishError);
      expect(err).toMatchObject({ status, code: `c${status}`, message: "nope", hint: "do x", docs: "https://d", fields: [{ path: "task", message: "too short" }], body: { balanceUsd: 0 } });
    }
    // A body with no code: the status as the code.
    const s = scripted([() => new Response("gateway", { status: 502 })]);
    expect(await s.client({ maxRetries: 0 }).tasks.create("x").catch((e: PilotfishError) => e.code)).toBe("502");
  });

  it("retries a 429 after its retryAfterS, also for a POST (nothing was made), and gives up after maxRetries", async () => {
    const s = scripted([() => json({ error: "slow down", code: "start_rate", retryAfterS: 0 }, 429), () => json(job(), 201)]);
    expect((await s.client().tasks.create("x")).id).toBe("job_1");
    expect(s.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    const gives = scripted([0, 1, 2].map(() => () => json({ error: "slow down", code: "rate_limited" }, 429, { "retry-after": "0" })));
    const err = (await gives.client().tasks.get("job_1").catch((e: unknown) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterS).toBe(0);
    expect(gives.calls).toHaveLength(3);
  });

  it("retries 5xx and network failures on reads only", async () => {
    const read = scripted([() => json({ error: "boom" }, 503), () => Promise.reject(new TypeError("fetch failed")), () => json(job({ status: "done" }))]);
    expect((await read.client().tasks.get("job_1")).status).toBe("done");
    const write = scripted([() => json({ error: "boom" }, 503)]);
    expect(await write.client().tasks.create("x").catch((e: unknown) => e)).toBeInstanceOf(ServerError);
    const down = scripted([() => Promise.reject(new TypeError("fetch failed"))]);
    expect(await down.client().tasks.create("x").catch((e: unknown) => e)).toBeInstanceOf(ConnectionError);
  });

  it("waits for the end or a question; times out without stopping the task", async () => {
    const s = scripted([() => json(job({ status: "running" })), () => json(job({ status: "needs_input", question: { id: "q1", kind: "confirm" } })), () => json(job({ status: "running" })), () => json(job({ status: "done", result: { success: true, result: "42" } }))]);
    const c = s.client();
    expect((await c.tasks.wait("job_1", { pollMs: 1 })).question?.id).toBe("q1");
    expect((await c.tasks.wait("job_1", { pollMs: 1, returnOnQuestion: false })).result?.result).toBe("42");
    const slow = scripted([() => json(job({ status: "running" }))]);
    expect(await slow.client().tasks.wait("job_1", { timeoutMs: 0 }).catch((e: unknown) => e)).toBeInstanceOf(WaitTimeoutError);
  });

  it("answers, messages, follows up, continues and cancels with the API's bodies", async () => {
    const ok = () => json({ ok: true });
    const s = scripted([ok, ok, ok, () => json(job({ id: "job_2" }), 201), () => json(job({ id: "job_3" }), 201), ok]);
    const c = s.client();
    await c.tasks.answer("job_1", "q1", "yes");
    await c.tasks.answer("job_1", "q2", "the blue one");
    await c.tasks.message("job_1", "use the cheaper one");
    await c.tasks.followUp("job_1", { text: "now the chair", region: "us" });
    await c.tasks.continue("job_1");
    await c.tasks.cancel("job_1");
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["POST /jobs/job_1/answer", "POST /jobs/job_1/answer", "POST /jobs/job_1/message", "POST /jobs/job_1/followup", "POST /jobs/job_1/followup", "DELETE /jobs/job_1"]);
    expect(s.calls.map((x) => x.body)).toEqual([
      { questionId: "q1", answer: { type: "yes" } },
      { questionId: "q2", answer: { type: "text", text: "the blue one" } },
      { text: "use the cheaper one" },
      { text: "now the chair", region: "us" },
      { text: "Continue the task from where you left off." },
      undefined,
    ]);
  });

  it("streams each event once, asking only for what is new, until the task ends", async () => {
    const e = (seq: number) => ({ seq, at: seq, type: `e${seq}`, data: {} });
    const s = scripted([() => json(job({ status: "running" })), () => json({ events: [e(1), e(2)] }), () => json(job({ status: "done" })), () => json({ events: [e(3)] }), () => json({ events: [] })]);
    const seen: string[] = [];
    for await (const ev of s.client().tasks.stream("job_1", { pollMs: 1 })) seen.push(ev.type);
    expect(seen).toEqual(["e1", "e2", "e3"]);
    expect(s.calls.filter((c) => c.url.pathname.endsWith("/events")).map((c) => c.url.searchParams.get("after"))).toEqual([null, "2", "3"]);
  });

  it("pages through tasks by cursor, and runs a batch to its end", async () => {
    const s = scripted([() => json({ jobs: [job({ id: "a" })], nextCursor: "c1" }), () => json({ jobs: [job({ id: "b" })], nextCursor: null })]);
    const ids: string[] = [];
    for await (const t of s.client().tasks.iterate({ limit: 1 })) ids.push(t.id);
    expect(ids).toEqual(["a", "b"]);
    expect(s.calls[1]!.url.searchParams.get("cursor")).toBe("c1");
    expect(s.calls[0]!.url.searchParams.get("mine")).toBe("1");
    const batch = (status: string) => ({ id: "bat_1", name: null, status, counts: { total: 2 }, costUsd: 0, project: "default", createdAt: 1, updatedAt: 1, finishedAt: null, url: "u" });
    const b = scripted([() => json(batch("running"), 201), () => json(batch("running")), () => json(batch("done"))]);
    expect((await b.client().batches.run(["a", { task: "b", region: "us" }], { pollMs: 1 })).status).toBe("done");
    expect(b.calls[0]!.body).toEqual({ tasks: ["a", { task: "b", region: "us" }] });
  });

  it("downloads a file with its name and type", async () => {
    const s = scripted([() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf` } })]);
    const f = await s.client().tasks.downloadFile("job_1", "file_1");
    expect([...f.data]).toEqual([1, 2, 3]);
    expect(f).toMatchObject({ contentType: "application/pdf", filename: "résumé.pdf" });
  });
});

describe("webhooks", () => {
  it("verifies a signature made with the secret, refuses a changed body, another secret or an old one", async () => {
    const body = JSON.stringify({ type: "batch.finished", batchId: "bat_1", at: 1, data: { status: "done" } });
    const now = 1_800_000_000;
    const sig = await signWebhook("whsec", body, now);
    expect(sig).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(await verifyWebhook("whsec", sig, body, { now })).toBe(true);
    expect(await verifyWebhook("whsec", sig, new TextEncoder().encode(body), { now })).toBe(true);
    expect(await verifyWebhook("whsec", sig, `${body} `, { now })).toBe(false);
    expect(await verifyWebhook("other", sig, body, { now })).toBe(false);
    expect(await verifyWebhook("whsec", sig, body, { now: now + 301 })).toBe(false);
    expect(await verifyWebhook("whsec", null, body)).toBe(false);
    expect((await parseWebhook("whsec", sig, body, { now })).batchId).toBe("bat_1");
    await expect(parseWebhook("other", sig, body, { now })).rejects.toThrow(/does not match/);
  });

  it("matches the server's own signature (a fixed vector)", async () => {
    // HMAC-SHA256("secret", "1700000000.{}") as the server signs it (packages/server/src/webhooks.ts signWebhook).
    expect(await signWebhook("secret", "{}", 1_700_000_000)).toBe("t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163");
  });
});
