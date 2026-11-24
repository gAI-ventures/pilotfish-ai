// The shapes the REST API takes and gives (https://pilotfish.gai.ventures/docs/api). Field names are the API's own.

/** What a task may do without asking: only with the person's explicit say-so. */
export interface PreApproved {
  kinds: Array<"pay" | "delete" | "send" | "transfer" | "cancel">;
  maxAmount?: number;
  currency?: string;
  hosts?: string[];
}

/** A file for the task to upload or read: its bytes in base64 (up to 10 files, 25 MB in all). */
export interface UploadFile {
  name: string;
  type?: string;
  data: string;
}

/** POST /jobs: a task and its settings. Only `task` is needed. */
export interface TaskRequest {
  /** What to do, with every value that matters (dates, quantities, filters, what to report back). */
  task: string;
  /** Open this page first. */
  startUrl?: string;
  /** The model every step runs on: `gpt-6-luna` (the default), `gpt-5-mini` or `gpt-5-nano`. */
  model?: string;
  /** Browser actions across the whole run (1-200). */
  maxSteps?: number;
  /** How long the run may take, ms (10 s to 1 h). */
  timeoutMs?: number;
  /** The country to browse from, two letters (`us`, `in`). Omitted: your settings, else the site's market. */
  region?: string;
  /** Further sites whose saved logins and profiles the task may use. */
  sites?: string[];
  /** Which of your accounts on those sites. */
  login?: string;
  /** Which account on each site: `{"linkedin.com": "work"}` (`""` the main one). */
  accounts?: Record<string, string>;
  /** In a shared project: run as this identity (`idn_…`). */
  identity?: string;
  /** The identity's saved logins to use, by id (`cred_…`). */
  credentials?: string[];
  /** Final steps that run without asking (pay, send…): only with the person's say-so. */
  preApproved?: PreApproved;
  /** Hosts the run may visit (all when omitted). */
  allowedHosts?: string[];
  /** Stealth browsing; on by default, false turns it off. */
  stealth?: boolean;
  /** Clearing CAPTCHAs and bot checks by itself; on by default. */
  solve?: boolean;
  /**
   * How much the run asks the person: `auto` (the default) only what it can't do without them, `manual` also every
   * choice the task leaves open, `accept_all` decides every open choice itself from the task, the session and the site.
   * Sign-ins, codes and final steps (pay, send, delete) are the person's in every mode unless the task's words approve them.
   */
  askMode?: "auto" | "manual" | "accept_all";
  /** Your own egress proxy (`http://user:pass@host:port`, https, socks4/5). */
  proxy?: string;
  /** Where `job.needs_input` and `job.finished` go, signed (verifyWebhook). */
  webhookUrl?: string;
  /** A JSON Schema (root `type: "object"`) for the answer: the result's `data` then validates against it. */
  outputSchema?: Record<string, unknown>;
  /** A trial run before scheduling: it walks the task up to its final step, never takes it, and reports. */
  trial?: boolean;
  /** Attachments. */
  files?: UploadFile[];
  /** Any other field the API takes. */
  [key: string]: unknown;
}

export type TaskStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled";

/**
 * The ways a sign-in page can offer, as `Question.signIn.ways` lists them (the API's own list, kept equal to it by the
 * API's tests). `password`: an email, phone or username and a password. `phone_code`: a phone number and a code sent by
 * text. `email_code`: an email address and a code or link sent there. `identifier_first`: the email, phone or username
 * first, the rest on the site's next page. `passkey`: a passkey, in the browser.
 */
export const SIGN_IN_WAYS = ["password", "phone_code", "email_code", "identifier_first", "passkey"] as const;
export type SignInWay = (typeof SIGN_IN_WAYS)[number];

/**
 * A sign-in question's ways (`Question.signIn`, category `login`), read from the live page when it was asked. Show the
 * person these and no others; the details themselves are typed on `answerUrl`, never sent through the API by you.
 */
export interface SignInAsk {
  /** In the page's order, the way its own form shows first leading. Empty with no `providers`: it could not be read. */
  ways: SignInWay[];
  /** Providers it offers by name ("Google", "Apple"), done in the browser. */
  providers: string[];
  /** The way the form opens on: the person's when the page offers it, else the page's first. One of `ways`. */
  opensOn?: SignInWay;
  /** The way the person asked for that the page does not offer (never one of `ways`). */
  asked?: SignInWay;
  /** The page's own words for its sign-in. */
  pageWords?: string;
}

/** A question a task is waiting on (status `needs_input`). Codes and passwords are answered on `answerUrl`, never here. */
export interface Question {
  id: string;
  kind?: string;
  /** For a hand-off: what the page shows (`login`, `captcha`, `otp`…). */
  category?: string;
  /** The question in words. */
  message?: string;
  text?: string;
  question?: string;
  options?: string[];
  /** A sign-in (category `login`): the ways its page offers. Read it with `signInOf`, which checks it. */
  signIn?: SignInAsk;
  askedAt?: number;
  expiresAt?: number;
  [key: string]: unknown;
}

/**
 * A sign-in question's ways, checked, or null when the question is not a sign-in or carries none: known ways only (a way
 * from a newer API is left out), each once; `opensOn` only when it is one of them; `asked` only when it is not. `unclear`:
 * nothing could be read, so the question asks how the person signs in (answer it with `{type: "text"}` in their words,
 * never a password or code; or they sign in in the browser).
 */
export function signInOf(q: Question | null | undefined): (SignInAsk & { unclear: boolean }) | null {
  const s = q?.signIn as unknown;
  if (q?.category !== "login" || !s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (!Array.isArray(o["ways"]) || !Array.isArray(o["providers"])) return null;
  const known = (w: unknown): w is SignInWay => (SIGN_IN_WAYS as readonly unknown[]).includes(w);
  const ways = [...new Set(o["ways"].filter(known))];
  const providers = [...new Set(o["providers"].filter((p): p is string => typeof p === "string" && p.trim() !== ""))];
  const opensOn = known(o["opensOn"]) && ways.includes(o["opensOn"]) && o["opensOn"] !== "passkey" ? o["opensOn"] : undefined;
  const asked = known(o["asked"]) && !ways.includes(o["asked"]) ? o["asked"] : undefined;
  const pageWords = typeof o["pageWords"] === "string" ? o["pageWords"] : undefined;
  return { ways, providers, ...(opensOn ? { opensOn } : {}), ...(asked ? { asked } : {}), ...(pageWords ? { pageWords } : {}), unclear: !ways.length && !providers.length };
}

/** What a finished task found. */
export interface TaskResult {
  success?: boolean;
  /** The answer, in words. */
  result?: string;
  /** `done`, `partial` or `failed`. */
  outcome?: string;
  stopReason?: string;
  steps?: number;
  /** The answer as JSON, when the task had an `outputSchema` and it validated. */
  data?: Record<string, unknown>;
  /** Why there is no `data`: `{code: "schema_mismatch" | "no_answer", errors?}`. */
  dataError?: { code: string; errors?: string[] };
  /** A failed task's error: its code, a colon, what happened. */
  error?: string;
  report?: Record<string, unknown>;
  blocked?: { category?: string; [key: string]: unknown };
  paused?: boolean;
  next?: string;
  costUsd?: number;
  [key: string]: unknown;
}

export interface Cost {
  modelUsd: number;
  proxyUsd: number;
  browserUsd: number;
  captchaUsd: number;
  totalUsd: number;
}

/** A task (a job) as the API shows it. */
export interface Task {
  id: string;
  /** The session it belongs to (its first task's id): follow-ups share it. */
  threadId: string;
  status: TaskStatus;
  task: string;
  question: Question | null;
  result: TaskResult | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  project?: string;
  identity?: string;
  /** A paused task (out of its per-task spend, a question unanswered): `next` says how to carry on. */
  paused?: boolean;
  /** What to do next: `continue` (follow up), `answer`, `sign_in`, `retry_region`. */
  next?: "continue" | "answer" | "sign_in" | "retry_region";
  /** On creation: the task in the API, its page in the app, and where a person answers its questions. */
  url?: string;
  appUrl?: string;
  answerUrl?: string;
  /** GET /jobs/:id: the settings it ran with, its cost so far, the live view while it runs. */
  settings?: Record<string, unknown>;
  cost?: Cost;
  control?: string | null;
  live?: { sessionId: string; viewToken: string; controlToken?: string; shareUrl: string } | null;
  [key: string]: unknown;
}

/** One of a task's events (steps, questions, files…). */
export interface TaskEvent {
  seq?: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/** An answer to a task's question. */
export type Answer =
  | { type: "yes" }
  | { type: "no" }
  | { type: "done" }
  | { type: "skip" }
  | { type: "cancel"; reason?: string }
  | { type: "text"; text: string }
  | { type: "code"; code: string };

/** A file of a task's session (attached, or downloaded by the run). */
export interface SessionFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  origin: string;
  url: string;
  createdAt?: number;
  [key: string]: unknown;
}

/** A follow-up: the next instruction in the same session (same browser while it is kept, same sign-ins). */
export interface FollowUpRequest {
  text: string;
  model?: string;
  region?: string;
  /** This turn's answer schema; `null` drops the session's. */
  outputSchema?: Record<string, unknown> | null;
  files?: UploadFile[];
  /** A login to sign in with (`{site, username, password}` or a code login), sealed on the server and typed as placeholders. */
  login?: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ------------------------------------------------------------------------------------------------- batches

export type BatchStatus = "running" | "done" | "cancelled" | "stopped";

/** POST /batches: up to 100 tasks, run one after another. */
export interface BatchRequest {
  /** The tasks, in order: each its words, or a whole task request. */
  tasks: Array<string | TaskRequest>;
  /** Settings every task gets unless it sets its own. */
  defaults?: Omit<Partial<TaskRequest>, "task">;
  name?: string;
  /** Where `batch.finished` goes, signed (verifyWebhook). */
  webhookUrl?: string;
}

export interface BatchItem {
  index: number;
  task: string;
  /** `pending` (not started), the task's status once started, `failed` (refused at its start), or `skipped` (never run). */
  status: "pending" | TaskStatus | "skipped";
  jobId: string | null;
  error?: string;
  costUsd: number;
  result: TaskResult | null;
  startedAt: number | null;
  endedAt: number | null;
  appUrl?: string;
  /** Where a person answers the task's questions: in the batch's own view for its maker, never in a webhook. */
  answerUrl?: string;
}

export interface Batch {
  id: string;
  name: string | null;
  status: BatchStatus;
  /** Why a batch stopped early: its code, a colon, what happened (`no_credits: …`). */
  reason?: string;
  counts: { total: number; pending: number; running: number; done: number; failed: number; cancelled: number; skipped: number };
  costUsd: number;
  project: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  url: string;
  /** Each task (GET /batches/:id; not in lists). */
  items?: BatchItem[];
}

// ------------------------------------------------------------------------------------------------- identities

/** One of your product's end users, in a shared project: their own logins, sessions, IP address and device. */
export interface Identity {
  id: string;
  label: string;
  externalUserId: string | null;
  project: string;
  country: string | null;
  deviceOs: "windows" | "macos" | null;
  email: string | null;
  saveLogins: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  /** GET /identities/:id: saved logins (masked) and signed-in sites. */
  logins?: Array<{ credential: string; site: string; account: string; username: string; hasPassword: boolean; hasTotp: boolean; default: boolean }>;
  signedIn?: Array<{ site: string; account: string }>;
  /** POST with an `externalUserId` you had already: the identity you had. */
  existed?: boolean;
  [key: string]: unknown;
}

export interface IdentityCreate {
  label?: string;
  externalUserId?: string;
  country?: string | null;
  deviceOs?: "windows" | "macos" | null;
  email?: string | null;
  saveLogins?: boolean;
}

export interface CredentialCreate {
  site: string;
  username: string;
  password?: string;
  totp?: string;
  otp?: "email" | "sms";
  account?: string;
  default?: boolean;
}

export interface LoginLink {
  url: string;
  expiresAt: number;
  sites: string[];
  webhookUrl?: string;
}

// ------------------------------------------------------------------------------------------------- saved tasks and schedules

/** The settings a saved task keeps. */
export interface SavedTaskOptions {
  startUrl?: string;
  region?: string;
  sites?: string[];
  login?: string;
  preApproved?: PreApproved;
  model?: string;
  allowedHosts?: string[];
  stealth?: boolean;
  solve?: boolean;
  outputSchema?: Record<string, unknown>;
  askMode?: "auto" | "manual" | "accept_all";
}

export interface SavedTask {
  id: string;
  name: string;
  task: string;
  options: SavedTaskOptions;
  runs?: number;
  lastRunAt?: number | null;
  [key: string]: unknown;
}

/** When a schedule runs: `repeat` once (with `date`), daily, weekdays, weekly (with `days`, 1 = Monday) or monthly (with `day`, 1-28), at `time` (HH:MM) in `tz`. */
export interface ScheduleRule {
  repeat: "once" | "daily" | "weekdays" | "weekly" | "monthly";
  time: string;
  tz: string;
  date?: string;
  days?: number[];
  day?: number;
}

export interface Schedule {
  savedTaskId: string;
  rule: ScheduleRule;
  paused: boolean;
  nextRunAt: number | null;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  describe?: string;
  task?: SavedTask | null;
  [key: string]: unknown;
}

/** GET /me/usage: spending by kind, day, model and task, and what is left of an allowance. */
export type Usage = Record<string, unknown>;
