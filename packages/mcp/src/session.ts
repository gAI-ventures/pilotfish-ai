// The one browser an MCP server process drives: launched on first use, armed with the consent
// engine before any page loads, and acted on by the direct tools through one executor Agent.
//
// Open: the MCP client's own model reads the pages and decides every step. This package makes no
// model calls and needs no API key; the executor is given a stand-in client that refuses one.
//
// Plain and local: the browser starts fresh on this machine's own IP and keeps nothing after it
// closes (no site profiles, no saved logins); no proxy, bot-check handling or CAPTCHA solving.

import { launch, type Browser, type LaunchOptions, type Page } from "@pilotfish/browser";
import {
  Agent,
  DefaultPolicy,
  TabManager,
  type ActionContext,
  type ActionPolicy,
  type ActOutcome,
  type AgentOptions,
  type PolicyDecision,
  type ToolName,
} from "@pilotfish/agent";
import { attachInterrupts, type Interrupts } from "@pilotfish/interrupts";
import type { McpConfig } from "./config.js";

/** What Agent.obstacle() reports (kept structural: the agent package does not export the type by name). */
export type PageObstacle = NonNullable<Awaited<ReturnType<Agent["obstacle"]>>>;

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
  /** Direct tool calls run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The configured allowlist and private-network rule, for every tool. */
  private readonly policy: ActionPolicy;
  /**
   * How the direct tools put a question to the person behind the MCP client (elicitation), set by
   * the server for the connection making the current call. Undefined when the client cannot ask:
   * policy confirmations are then refused.
   */
  asker: ((question: string) => Promise<string | null>) | undefined;

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
      autoDismiss: true,
      // A page that says it is still loading is shown once it has finished (up to 6 s): a model answered from Google
      // Flights' Cheapest tab while it read "Fetching results" and an interim price (4 Nov).
      awaitLoading: true,
      // An action returns the visible screen, with counts of what is above and below: the client's model reads every
      // result again on each later call, and three screens of a results page ran to 24,000 characters (4 Nov).
      actionSnapshotBand: 0,
      snapshotMoreHint: "browser_scroll for the next screen, browser_get_text for the page's text, or browser_snapshot (whole_page) for every element",
    });
    return this.agent;
  }

  /**
   * One tool through the executor pipeline (policy gate, ref check, hit test, settle, evidence,
   * secret scrubbing), without a model call. Calls are serialized.
   */
  async act(name: ToolName, input: Record<string, unknown>, o: { snapshot?: boolean } = {}): Promise<ActOutcome> {
    const next = this.queue.then(async () => {
      await this.ensure();
      return this.executor().act(name, input, "", o);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * What on the current page only a person can deal with (a sign-in, a code, a device approval, a CAPTCHA), or a
   * block nobody can (see Agent.obstacle); null when nothing, or when no browser is open. Serialized with the actions.
   */
  async obstacle(o: { fresh?: boolean } = {}): Promise<PageObstacle | null> {
    if (!this.launched) return null;
    const next = this.queue.then(() => this.executor().obstacle(o));
    this.queue = next.catch(() => undefined);
    return next.catch(() => null);
  }

  /** Close the browser. The next tool call launches a fresh one. */
  async close(): Promise<boolean> {
    const browser = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    if (!browser) return false;
    this.reset();
    await browser.close().catch(() => undefined);
    return true;
  }
}
