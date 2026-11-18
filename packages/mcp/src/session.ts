// The one browser an MCP server process drives: launched on first use, armed with the consent
// engine before any page loads, and acted on by the direct tools through one executor Agent.
//
// Open: the MCP client's own model reads the pages and decides every step. This package makes no
// model calls and needs no API key; the executor is given a stand-in client that refuses one.
//
// Plain and local: the browser starts fresh on this machine's own IP and keeps nothing after it
// closes (no site profiles, no saved logins); no proxy, bot-check handling or CAPTCHA solving.

import { AsyncLocalStorage } from "node:async_hooks";
import { launch, type Browser, type LaunchOptions, type Page } from "@pilotfish/browser";
import {
  Agent,
  DefaultPolicy,
  SecretBroker,
  TabManager,
  type ActionContext,
  type ActionPolicy,
  type ActOptions,
  type ActOutcome,
  type AgentOptions,
  type PolicyDecision,
  type ToolName,
} from "@pilotfish/agent";
import { attachInterrupts, type Interrupts } from "@pilotfish/interrupts";
import type { McpConfig } from "./config.js";

/**
 * What Agent.obstacle() reports (kept structural): an obstacle, or a page that could not be verified (`unread`; `changed`
 * when a document change was seen while it was read), which is neither an obstacle nor a page that needs nobody.
 */
export type PageCheck = NonNullable<Awaited<ReturnType<Agent["obstacle"]>>>;
export type PageObstacle = Exclude<PageCheck, { unread: true }>;
export type PageUnread = Extract<PageCheck, { unread: true }>;

export interface SessionOptions {
  /** Extra launch options (tests pin a viewport, a Chromium path...). headless comes from the config. */
  launch?: Partial<LaunchOptions>;
}

/** What a model call through the executor's client fails with: none of the direct tools makes one. */
const NO_MODEL_CALLS = "pilotfish's open MCP makes no model calls: the MCP client's own model reads the page and decides the next step";

/**
 * The executor's client. Without one the Agent would build a model client from the environment; this one builds
 * nothing and refuses every call, so no API key is read and nothing is spent on one that happens to be set.
 */
const noModelClient = (): NonNullable<AgentOptions["client"]> => {
  const refuse = async (): Promise<never> => {
    throw new Error(NO_MODEL_CALLS);
  };
  return { messages: { create: refuse }, beta: { messages: { create: refuse } } } as unknown as NonNullable<AgentOptions["client"]>;
};

/**
 * A "confirm" needs a person. When the calling client cannot ask one (no elicitation), the action
 * is refused with that reason, instead of an agent reading the missing answer as the person's "no".
 */
class ConfirmThrough implements ActionPolicy {
  constructor(
    private readonly inner: ActionPolicy,
    private readonly canAsk: () => boolean,
  ) {}
  async check(ctx: ActionContext): Promise<PolicyDecision> {
    const d = await this.inner.check(ctx);
    if (d.kind !== "confirm" || this.canAsk()) return d;
    return { kind: "deny", reason: `${d.reason}. This needs a person's confirmation, and this MCP client cannot ask for one (no elicitation support)` };
  }
}

export class BrowserSession {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private interrupts: Interrupts | null = null;
  private tabs: TabManager | null = null;
  /** Executor for the direct tools, built on first use for the open browser. */
  private agent: Agent | null = null;
  /**
   * Output guard (18 Nov): how many scrubbed strings held a secret value in this server's life (every browser; it never
   * goes down). A tool call during which it rose is withheld whole (server.ts), whichever path printed the value.
   */
  secretOutputs = 0;
  /** The configured secrets, for the boundary scan while no browser (and so no executor) exists. */
  private configSecrets: SecretBroker | null = null;
  /** Direct tool calls run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The configured allowlist and private-network rule, for every tool. */
  private readonly policy: ActionPolicy;
  /** A request's confirmation channel must not be overwritten by another connection. */
  private readonly callContext = new AsyncLocalStorage<{ asker: ((question: string) => Promise<string | null>) | undefined }>();

  get asker(): ((question: string) => Promise<string | null>) | undefined {
    return this.callContext.getStore()?.asker;
  }

  /** Serialize the complete MCP request, including all steps in a batch and its hand-off. */
  run<T>(asker: ((question: string) => Promise<string | null>) | undefined, task: () => Promise<T>): Promise<T> {
    return this.enqueue(() => this.callContext.run({ asker }, task));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // act/obstacle/close called inside a request already hold its place in the queue.
    if (this.callContext.getStore()) return task();
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  constructor(
    readonly config: McpConfig,
    private readonly opts: SessionOptions = {},
  ) {
    this.policy = new DefaultPolicy({ allowedHosts: config.allowedHosts, allowPrivateNetwork: config.allowPrivateNetwork });
  }

  get launched(): boolean {
    return !!this.browser && !this.browser.closed;
  }

  /** The tab the agents work in, launching the browser on first use. */
  async page(): Promise<Page> {
    await this.ensure();
    return this.tabs!.current;
  }

  get tabTable(): TabManager | null {
    return this.tabs;
  }

  private async ensure(): Promise<Browser> {
    if (this.browser && !this.browser.closed) return this.browser;
    this.launching ??= this.start().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async start(): Promise<Browser> {
    const browser = await launch({ ...this.opts.launch, headless: this.config.headless });
    // Cookie banners are rejected by site rules before any model sees them, and ads and trackers
    // are blocked. Armed before the first navigation so every document gets it from its first byte.
    this.interrupts = await attachInterrupts(browser, { consent: true, adblock: true }).catch(() => null);
    const page = browser.allPages()[0] ?? (await browser.newPage());
    this.tabs = new TabManager(page);
    this.browser = browser;
    browser.on("disconnected", () => {
      // The window was closed or the browser crashed: the next call starts a fresh one.
      if (this.browser !== browser) return;
      this.reset();
    });
    return browser;
  }

  private reset(): void {
    this.agent?.dispose();
    this.agent = null;
    this.tabs?.dispose();
    this.tabs = null;
    this.interrupts?.detach();
    this.interrupts = null;
    this.browser = null;
  }

  /** Whether a password was typed into a password field in this browser (browser_close starts a fresh one). */
  hasTypedPasswords(): boolean {
    return !!this.agent?.hasTypedPasswords();
  }

  /**
   * Whether `text`, as given, holds a recognized form of a secret value (configured, issued, retired or typed in this
   * browser): the server's final scan of every outgoing reply. No side effect.
   */
  holdsSecret(text: string): boolean {
    if (this.agent) return this.agent.holdsSecretOutput(text);
    this.configSecrets ??= new SecretBroker(this.config.secrets);
    return this.configSecrets.holdsSecret(text);
  }

  /** A reply's text through the session's scrubber (secrets and typed passwords); as it is before a browser exists. */
  scrubReply(text: string): string {
    return this.agent ? this.agent.scrubOutput(text) : text;
  }

  private executor(): Agent {
    this.agent ??= new Agent(this.tabs!.current, {
      tabs: this.tabs!,
      client: noModelClient(),
      secrets: this.config.secrets,
      // The channel is read at question time, so it follows whichever client is calling.
      policy: new ConfirmThrough(this.policy, () => !!this.asker),
      consent: this.interrupts?.consent ?? undefined,
      allowScreenshots: this.config.allowScreenshots,
      askUser: (q) => this.asker?.(q) ?? Promise.resolve(null),
      // What the orchestrator's own executor uses for model-free actions.
      fastSettle: true,
      // browser_query: the client's model reads just the values it needs (read-only JavaScript in a world of its
      // own, page writes blocked) instead of a whole page's text in its context (a store's results page ran to
      // ~20,000 characters of text, where the values needed were ~2,900).
      enableQuery: true,
      // The same elements and words in lighter markup (link targets as paths, no generated ids): 3-23% smaller
      // screens on the sites measured, nothing a reader acts on or quotes left out.
      compactSnapshots: true,
      roleTags: true,
      actionReceipts: true,
      // Any secret value in output withholds the reply whole; never a readable placeholder in its grammar.
      guardSecretOutput: true,
      onSecretOutput: () => {
        this.secretOutputs++;
      },
      autoDismiss: true,
      // A page that says it is still loading is shown once it has finished (up to 6 s): a model answered from Google
      // Flights' Cheapest tab while it read "Fetching results" and an interim price (4 Nov).
      awaitLoading: true,
      // An action returns the visible screen, with counts of what is above and below: the client's model reads every
      // result again on each later call, and three screens of a results page ran to 24,000 characters (4 Nov).
      actionSnapshotBand: 0,
      snapshotMoreHint: "browser_scroll for the next screen, browser_get_text for the page's text, or browser_snapshot (whole_page) for every element",
      // A page's WebMCP tools are listed with its snapshot, for browser_page_tool (enabled once a page offers one).
      pageToolCall: "browser_page_tool",
    });
    return this.agent;
  }

  /**
   * One tool through the executor pipeline (policy gate, ref check, hit test, settle, evidence,
   * secret scrubbing), without a model call. Calls are serialized.
   */
  async act(name: ToolName, input: Record<string, unknown>, o: ActOptions = {}): Promise<ActOutcome> {
    return this.enqueue(async () => {
      await this.ensure();
      return this.executor().act(name, input, "", o);
    });
  }

  /**
   * What on the current page only a person can deal with (a sign-in, a code, a device approval, a CAPTCHA), or a
   * block nobody can (see Agent.obstacle); `unread` when the page could not be verified (a look that failed is one too:
   * never taken for a page that needs nobody); null when the page was read and needs nobody, or when no browser is
   * open. Serialized with the actions.
   */
  async obstacle(o: { fresh?: boolean } = {}): Promise<PageCheck | null> {
    return this.enqueue(async () => (this.launched ? this.executor().obstacle(o) : null)).catch((): PageUnread => ({ unread: true, changed: false, message: "Could not verify the page for a sign-in, a code or a bot check: the look at it failed.", host: "", url: "" }));
  }

  /** Close the browser. The next tool call launches a fresh one. */
  async close(): Promise<boolean> {
    return this.enqueue(async () => {
      const browser = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
      if (!browser) return false;
      this.reset();
      await browser.close().catch(() => undefined);
      return true;
    });
  }
  }
