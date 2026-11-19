// The hosted client: pilotfish's REST API (https://pilotfish.gai.ventures/docs/api) with an API key from Org settings →
// API keys. Tasks run in pilotfish's cloud browser and are paid from your org's credits.

import { ConnectionError, errorFor, PilotfishError, WaitTimeoutError } from "./errors.js";
import type {
  Answer,
  Batch,
  BatchRequest,
  CredentialCreate,
  FollowUpRequest,
  Identity,
  IdentityCreate,
  LoginLink,
  Page,
  SavedTask,
  SavedTaskOptions,
  Schedule,
  ScheduleRule,
  SessionFile,
  Task,
  TaskEvent,
  TaskRequest,
  TaskStatus,
  Usage,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://pilotfish-be.gai.ventures";
/** The text the app sends to carry a paused task on. */
export const CONTINUE_TEXT = "Continue the task from where you left off.";

const ENDED = new Set<TaskStatus>(["done", "failed", "cancelled"]);
const env = (k: string): string | undefined => (typeof process !== "undefined" ? process.env?.[k] : undefined) || undefined;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export interface ClientOptions {
  /** An API key (`pf_…`, Org settings → API keys). Default: the `PILOTFISH_API_KEY` environment variable. */
  apiKey?: string;
  /** Default: `PILOTFISH_BASE_URL`, else https://pilotfish-be.gai.ventures. */
  baseUrl?: string;
  /** Tries after the first for a 429 (after its `retryAfterS`), a 5xx or a network failure on a read. Default 2. */
  maxRetries?: number;
  /** Per-request timeout, ms. Default 60 s. */
  timeoutMs?: number;
  /** Your own fetch (tests, proxies). */
  fetch?: typeof fetch;
}

export interface WaitOptions {
  /** Give up waiting after this long, ms (the task carries on). Default 30 min. */
  timeoutMs?: number;
  /** How often to look, ms. Default 2 s. */
  pollMs?: number;
  /** Also return when the task waits on a question (status `needs_input`). Default true. */
  returnOnQuestion?: boolean;
  signal?: AbortSignal;
}

type Query = Record<string, string | number | boolean | undefined>;

export class Pilotfish {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  readonly tasks: Tasks;
  readonly batches: Batches;
  readonly identities: Identities;
  readonly savedTasks: SavedTasks;
  readonly schedules: Schedules;
  readonly usage: UsageApi;

  constructor(o: ClientOptions = {}) {
    const key = o.apiKey ?? env("PILOTFISH_API_KEY");
    if (!key) throw new PilotfishError(0, { error: "No API key: pass apiKey, or set PILOTFISH_API_KEY (Org settings → API keys).", code: "no_api_key" });
    this.apiKey = key;
    this.baseUrl = (o.baseUrl ?? env("PILOTFISH_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = o.maxRetries ?? 2;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.tasks = new Tasks(this);
    this.batches = new Batches(this);
    this.identities = new Identities(this);
    this.savedTasks = new SavedTasks(this);
    this.schedules = new Schedules(this);
    this.usage = new UsageApi(this);
  }

  /** One API call: JSON in and out, typed errors, retries on 429 (after its `retryAfterS`) and, for reads, on 5xx and network failures. */
  async request<T>(method: string, path: string, o: { body?: unknown; query?: Query; raw?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.send(method, path, o);
    if (o.raw) return res as unknown as T;
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** The raw response of a call that returns a file (its bytes). */
  async download(path: string, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType: string; filename: string | null }> {
    const res = await this.send("GET", path, { ...(signal ? { signal } : {}) });
    const cd = res.headers.get("content-disposition") ?? "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
    const plain = /filename="([^"]+)"/i.exec(cd)?.[1];
    return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream", filename: star ? decodeURIComponent(star) : (plain ?? null) };
  }

  private async send(method: string, path: string, o: { body?: unknown; query?: Query; signal?: AbortSignal }): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const read = method === "GET" || method === "HEAD";
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            "user-agent": `pilotfish-sdk-ts/${VERSION}`,
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
          signal,
        });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        if (read && attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt, o.signal);
          continue;
        }
        throw new ConnectionError(`${method} ${path}: ${e instanceof Error ? e.message : String(e)}`, e);
      }
      if (res.ok || (res.status >= 300 && res.status < 400)) return res;
      const body: Record<string, unknown> = await res
        .json()
        .then((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : { error: String(b) }))
        .catch(() => ({ error: `HTTP ${res.status}` }));
      const header = res.headers.get("retry-after");
      const retryAfter = typeof body["retryAfterS"] === "number" ? body["retryAfterS"] : header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
      // A 429 refused the request before anything was made, so it is safe to send again, whatever the method.
      if (res.status === 429 && attempt < this.maxRetries) {
        await sleep(Math.min(60, retryAfter ?? 2 ** attempt) * 1000, o.signal);
        continue;
      }
      // 501 (a feature this server does not have, such as MP4 replays) is not retried: it will not change.
      if (read && res.status >= 500 && res.status !== 501 && attempt < this.maxRetries) {
        await sleep(500 * 2 ** attempt, o.signal);
        continue;
      }
      throw errorFor(res.status, retryAfter !== undefined && body["retryAfterS"] === undefined ? { ...body, retryAfterS: retryAfter } : body);
    }
  }
}

const enc = encodeURIComponent;

/** Tasks (the API's jobs): run, watch, answer, steer, follow up, and read their files and replays. */
export class Tasks {
  constructor(private readonly c: Pilotfish) {}

  /** Start a task; returns at once with its id (and `url`, `appUrl`, `answerUrl`). */
  create(req: TaskRequest | string): Promise<Task> {
    return this.c.request("POST", "/jobs", { body: typeof req === "string" ? { task: req } : req });
  }

  /** Start a task and wait for it to end (or to wait on a question, unless `returnOnQuestion: false`). */
  async run(req: TaskRequest | string, o: WaitOptions = {}): Promise<Task> {
    const t = await this.create(req);
    return this.wait(t.id, o);
  }

  /** A task with its result, question, settings, cost so far and live view. */
  get(id: string): Promise<Task> {
    return this.c.request("GET", `/jobs/${enc(id)}`);
  }

  /** Wait until the task ends, or waits on a question (unless `returnOnQuestion: false`). Throws WaitTimeoutError after `timeoutMs`. */
  async wait(id: string, o: WaitOptions = {}): Promise<Task> {
    const until = Date.now() + (o.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const t = await this.get(id);
      if (ENDED.has(t.status)) return t;
      if (o.returnOnQuestion !== false && (t.status === "needs_input" || t.question)) return t;
      if (Date.now() >= until) throw new WaitTimeoutError(`Task ${id} is still ${t.status}: it carries on; wait again or cancel it.`);
      await sleep(o.pollMs ?? 2_000, o.signal);
    }
  }

  /** Your tasks, newest first (a key: the tasks it started). One page; `iterate` walks them all. */
  async list(o: { status?: TaskStatus; limit?: number; cursor?: string; project?: string; identity?: string } = {}): Promise<Page<Task>> {
    const r = await this.c.request<{ jobs: Task[]; nextCursor: string | null }>("GET", "/jobs", { query: { mine: 1, ...o } });
    return { items: r.jobs, nextCursor: r.nextCursor };
  }

  /** Every task, page after page. */
  async *iterate(o: { status?: TaskStatus; limit?: number; project?: string; identity?: string } = {}): AsyncGenerator<Task> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...o, ...(cursor ? { cursor } : {}) });
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** The task's events (steps, questions, files…), or those after `after` (an event's `seq`). */
  async events(id: string, after?: number): Promise<TaskEvent[]> {
    return (await this.c.request<{ events: TaskEvent[] }>("GET", `/jobs/${enc(id)}/events`, { query: { after } })).events;
  }

  /** Each new event as it happens, until the task ends. */
  async *stream(id: string, o: { pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<TaskEvent> {
    let after = -1;
    for (;;) {
      const t = await this.get(id);
      // Every event the API lists has a seq; one without (never expected) is yielded once by its position.
      const seen = new Set<string>();
      const fresh = (events: TaskEvent[]) => events.filter((e) => (e.seq !== undefined ? e.seq > after : !seen.has(JSON.stringify(e)) && (seen.add(JSON.stringify(e)), true)));
      for (const e of fresh(await this.events(id, after >= 0 ? after : undefined))) {
        after = Math.max(after, e.seq ?? after);
        yield e;
      }
      if (ENDED.has(t.status)) {
        for (const e of fresh(await this.events(id, after >= 0 ? after : undefined))) yield e;
        return;
      }
      await sleep(o.pollMs ?? 1_000, o.signal);
    }
  }

  /** The next instruction in the same session: the same browser while it is kept, the same sign-ins, what earlier turns found. */
  followUp(id: string, req: FollowUpRequest | string): Promise<Task> {
    return this.c.request("POST", `/jobs/${enc(id)}/followup`, { body: typeof req === "string" ? { text: req } : req });
  }

  /** Carry a paused task on (`paused: true`, `next: "continue"`), as the app's Continue does. */
  continue(id: string): Promise<Task> {
    return this.followUp(id, CONTINUE_TEXT);
  }

  /** Answer the task's open question (`task.question.id`). Codes and passwords go on its `answerUrl`, never here. */
  async answer(id: string, questionId: string, answer: Answer | "yes" | "no" | "done" | "cancel" | "skip" | (string & {})): Promise<void> {
    const a: Answer = typeof answer === "string" ? (["yes", "no", "done", "cancel", "skip"].includes(answer) ? ({ type: answer } as Answer) : { type: "text", text: answer }) : answer;
    await this.c.request("POST", `/jobs/${enc(id)}/answer`, { body: { questionId, answer: a } });
  }

  /** Tell a running task something in the person's words; it reads it before its next step. */
  async message(id: string, text: string): Promise<void> {
    await this.c.request("POST", `/jobs/${enc(id)}/message`, { body: { text } });
  }

  /** Stop a task for good (what it spent stays charged). */
  async cancel(id: string): Promise<void> {
    await this.c.request("DELETE", `/jobs/${enc(id)}`);
  }

  /** Take control: the agent stops at its next turn and the browser is the person's (the live view's control token). */
  pause(id: string): Promise<{ ok: true; control: string }> {
    return this.c.request("POST", `/jobs/${enc(id)}/pause`);
  }

  /** Hand the browser back: the agent carries on from where the person left it. */
  resume(id: string): Promise<{ ok: true; control: string }> {
    return this.c.request("POST", `/jobs/${enc(id)}/resume`);
  }

  /** The same task again with the same settings, as a new task in a new session. */
  rerun(id: string): Promise<Task> {
    return this.c.request("POST", `/jobs/${enc(id)}/rerun`);
  }

  /** The task's whole session: its turns with their events, its files, and the browser kept for a follow-up. */
  thread(id: string): Promise<{ threadId: string; jobs: Array<Task & { events: TaskEvent[] }>; files: SessionFile[]; kept?: unknown }> {
    return this.c.request("GET", `/jobs/${enc(id)}/thread`);
  }

  /** The session's files: attached, downloaded by the run, or PDFs it read. */
  async files(id: string, o: { offset?: number; limit?: number } = {}): Promise<{ files: SessionFile[]; total: number }> {
    return this.c.request("GET", `/jobs/${enc(id)}/files`, { query: o });
  }

  /** One file's bytes, with its name and type. */
  downloadFile(id: string, fileId: string): Promise<{ data: Uint8Array; contentType: string; filename: string | null }> {
    return this.c.download(`/jobs/${enc(id)}/files/${enc(fileId)}`);
  }

  /** The screenshots taken after the steps that changed the page. */
  async frames(id: string): Promise<Array<{ seq: number; at: number; step?: number; label: string; url: string }>> {
    return (await this.c.request<{ frames: Array<{ seq: number; at: number; step?: number; label: string; url: string }> }>("GET", `/jobs/${enc(id)}/frames`)).frames;
  }

  /** The replay video (MP4), while it is kept (7 days by default). */
  replayMp4(id: string): Promise<{ data: Uint8Array; contentType: string; filename: string | null }> {
    return this.c.download(`/jobs/${enc(id)}/replay.mp4`);
  }

  /** Delete the task's session from history (soft: its record and cost are kept for billing). */
  async deleteSession(id: string): Promise<void> {
    await this.c.request("DELETE", `/jobs/${enc(id)}/history`);
  }
}

/** Batches: many tasks in one request, run one after another, their results collected together. */
export class Batches {
  constructor(private readonly c: Pilotfish) {}

  /** Start a batch (up to 100 tasks). Each task is charged when it runs; if credits run out the rest are skipped. */
  create(req: BatchRequest | Array<string | TaskRequest>): Promise<Batch> {
    return this.c.request("POST", "/batches", { body: Array.isArray(req) ? { tasks: req } : req });
  }

  /** Start a batch and wait for every task to end. */
  async run(req: BatchRequest | Array<string | TaskRequest>, o: Omit<WaitOptions, "returnOnQuestion"> = {}): Promise<Batch> {
    const b = await this.create(req);
    return this.wait(b.id, o);
  }

  /** A batch with each task's status, job id, cost and result. */
  get(id: string): Promise<Batch> {
    return this.c.request("GET", `/batches/${enc(id)}`);
  }

  /** Wait until the batch ends (done, cancelled or stopped). Throws WaitTimeoutError after `timeoutMs` (default 2 h). */
  async wait(id: string, o: Omit<WaitOptions, "returnOnQuestion"> = {}): Promise<Batch> {
    const until = Date.now() + (o.timeoutMs ?? 2 * 3_600_000);
    for (;;) {
      const b = await this.get(id);
      if (b.status !== "running") return b;
      if (Date.now() >= until) throw new WaitTimeoutError(`Batch ${id} is still running: it carries on; wait again or cancel it.`);
      await sleep(o.pollMs ?? 3_000, o.signal);
    }
  }

  /** Your batches, newest first (without their items). */
  async list(o: { status?: Batch["status"]; limit?: number; cursor?: string } = {}): Promise<Page<Batch>> {
    const r = await this.c.request<{ batches: Batch[]; nextCursor: string | null }>("GET", "/batches", { query: o });
    return { items: r.batches, nextCursor: r.nextCursor };
  }

  /** Cancel: the running task is cancelled and the rest are skipped (never run, never charged). */
  cancel(id: string): Promise<Batch> {
    return this.c.request("POST", `/batches/${enc(id)}/cancel`);
  }
}

/** Identities: your product's end users in a shared project (an org key's project), each with their own logins, sessions, IP and device. */
export class Identities {
  constructor(private readonly c: Pilotfish) {}

  /** Make one; with an `externalUserId` you already used, you get that one back (`existed: true`). */
  create(o: IdentityCreate = {}): Promise<Identity> {
    return this.c.request("POST", "/identities", { body: o });
  }
  get(id: string): Promise<Identity> {
    return this.c.request("GET", `/identities/${enc(id)}`);
  }
  async list(o: { externalUserId?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Identity> & { total: number }> {
    const r = await this.c.request<{ identities: Identity[]; nextCursor: string | null; total: number }>("GET", "/identities", { query: o });
    return { items: r.identities, nextCursor: r.nextCursor, total: r.total };
  }
  update(id: string, o: Partial<IdentityCreate>): Promise<Identity> {
    return this.c.request("PATCH", `/identities/${enc(id)}`, { body: o });
  }
  /** Wipes its logins, sessions and device; its tasks and their cost are kept. */
  async delete(id: string): Promise<void> {
    await this.c.request("DELETE", `/identities/${enc(id)}`);
  }
  /** What its tasks cost, since `since` (ms since the epoch; default: all of them). */
  usage(id: string, o: { since?: number } = {}): Promise<Usage> {
    return this.c.request("GET", `/identities/${enc(id)}/usage`, { query: o });
  }
  /** Save a login for it from your own server (the values are sealed and never read back). */
  addCredential(id: string, o: CredentialCreate): Promise<{ credential: string; identity: string; site: string; account: string }> {
    return this.c.request("POST", `/identities/${enc(id)}/credentials`, { body: o });
  }
  async credentials(id: string): Promise<NonNullable<Identity["logins"]>> {
    return (await this.c.request<{ credentials: NonNullable<Identity["logins"]> }>("GET", `/identities/${enc(id)}/credentials`)).credentials;
  }
  async setDefaultCredential(id: string, credential: string): Promise<void> {
    await this.c.request("PUT", `/identities/${enc(id)}/credentials/${enc(credential)}/default`);
  }
  async deleteCredential(id: string, credential: string): Promise<void> {
    await this.c.request("DELETE", `/identities/${enc(id)}/credentials/${enc(credential)}`);
  }
  /** A one-time page where the end user types their own login for these sites. */
  loginLink(id: string, o: { sites: string[]; account?: string; ttlMinutes?: number; webhookUrl?: string }): Promise<LoginLink> {
    return this.c.request("POST", `/identities/${enc(id)}/link`, { body: o });
  }
}

/** Saved tasks (in your Personal project): run again with their settings, by hand or on a schedule. */
export class SavedTasks {
  constructor(private readonly c: Pilotfish) {}
  async list(): Promise<SavedTask[]> {
    return (await this.c.request<{ tasks: SavedTask[] }>("GET", "/saved-tasks")).tasks;
  }
  create(o: { name: string; task: string; options?: SavedTaskOptions; fromJob?: string }): Promise<SavedTask> {
    return this.c.request("POST", "/saved-tasks", { body: o });
  }
  update(id: string, o: { name?: string; task?: string; options?: SavedTaskOptions }): Promise<SavedTask> {
    return this.c.request("PUT", `/saved-tasks/${enc(id)}`, { body: o });
  }
  async delete(id: string): Promise<void> {
    await this.c.request("DELETE", `/saved-tasks/${enc(id)}`);
  }
  /** Run it, with changes for this run only. */
  run(id: string, o: Record<string, unknown> & { extraInstructions?: string; startUrl?: string | null; region?: string | null; sites?: string[]; stealth?: boolean; solve?: boolean; outputSchema?: Record<string, unknown> | null } = {}): Promise<Task> {
    return this.c.request("POST", `/saved-tasks/${enc(id)}/run`, { body: o });
  }
}

/** Schedules: a saved task run by itself. What would stop a run with nobody there is settled first (409 `not_ready`). */
export class Schedules {
  constructor(private readonly c: Pilotfish) {}
  async list(): Promise<Schedule[]> {
    return (await this.c.request<{ schedules: Schedule[] }>("GET", "/schedules")).schedules;
  }
  /** Schedule a saved task (`savedTaskId`), or a new task saved with it (`task`, `name`, `options`). */
  create(o: { rule: ScheduleRule; savedTaskId?: string; name?: string; task?: string; options?: SavedTaskOptions; paused?: boolean }): Promise<Schedule> {
    return this.c.request("POST", "/schedules", { body: o });
  }
  update(savedTaskId: string, o: { rule?: ScheduleRule; paused?: boolean; name?: string; task?: string }): Promise<Schedule> {
    return this.c.request("PUT", `/schedules/${enc(savedTaskId)}`, { body: o });
  }
  async delete(savedTaskId: string): Promise<void> {
    await this.c.request("DELETE", `/schedules/${enc(savedTaskId)}`);
  }
}

/** Spending: yours (a key: its own), by kind, day, model and task, and what is left of an allowance. */
export class UsageApi {
  constructor(private readonly c: Pilotfish) {}
  /** The last `days` (default 30), or `from`/`to` (YYYY-MM-DD). */
  get(o: { days?: number; from?: string; to?: string } = {}): Promise<Usage> {
    return this.c.request("GET", "/me/usage", { query: o });
  }
}
