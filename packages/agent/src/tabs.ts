// The tabs of one browser session and the one the agent works in. Shared by every Agent a
// RoutedAgent creates, so a tab opened in one step is still the current tab in the next.
//
// Policy (as other browser agents handle popups): follow a new tab only when the
// agent's own action opened it; when the current tab closes (an OAuth popup closing itself after
// sign-in), go back to its opener. Only tabs this session opened are tracked: a tab another
// session or the user opened in the same browser is never adopted (nor shown to the model).

import type { DialogHandler, Page } from "@pilotfish/browser";

interface Tab {
  id: string;
  page: Page;
  openedAt: number;
}

export class TabManager {
  private readonly tabs: Tab[] = [];
  private seq = 0;
  private cur: Page;
  private notes: string[] = [];
  private readonly offs: Array<() => void> = [];
  private readonly onAddHooks: Array<(page: Page) => void> = [];
  /** Answers JS dialogs on every tab (set by the agent that currently drives the session). */
  dialogPolicy: DialogHandler | null = null;
  /** Until when a new tab without an opener link (rel=noopener) counts as opened by our action. */
  private unlinkedUntil = 0;

  /** Targets that existed before this session started (the browser's initial tab may finish attaching late). */
  private readonly preexisting: Set<string>;
  /**
   * Tabs Chrome created for us that are still initializing (the "page" event comes after their
   * domains are set up, which under load can outlast an action's settle window).
   */
  private readonly opening = new Map<string, number>();
  private readonly openingWaiters = new Set<() => void>();

  constructor(page: Page) {
    this.cur = page;
    this.preexisting = new Set(page.browser.allPages().map((p) => p.targetId));
    this.add(page);
    this.offs.push(
      page.browser.on("page", (p) => {
        this.opened(p.targetId);
        if (this.adopts(p)) this.add(p);
      }),
    );
    this.offs.push(
      page.browser.on("pageClosed", (p) => {
        this.opened(p.targetId);
        this.closed(p);
      }),
    );
    this.offs.push(
      page.browser.root.on("Target.targetCreated", (e) => {
        const t = e.targetInfo;
        if (t.type !== "page" || this.preexisting.has(t.targetId)) return;
        const ours = t.openerId ? this.tabs.some((x) => x.page.targetId === t.openerId) : Date.now() <= this.unlinkedUntil && t.browserContextId === this.tabs[0]?.page.targetInfo.browserContextId;
        if (ours) this.opening.set(t.targetId, Date.now());
      }),
      page.browser.root.on("Target.targetDestroyed", (e) => this.opened(e.targetId)),
    );
  }

  /** A target finished initializing (or went away): it is no longer pending. */
  private opened(targetId: string): void {
    if (!this.opening.delete(targetId)) return;
    if (!this.opening.size) for (const w of [...this.openingWaiters]) w();
  }

  /**
   * Wait (at most `timeoutMs`) until tabs our actions opened have finished initializing, so the
   * action's evidence can report and switch to them. Returns at once when none is pending.
   */
  async settleOpens(timeoutMs = 3_000): Promise<void> {
    for (const [id, at] of this.opening) if (Date.now() - at > 15_000) this.opening.delete(id); // never attached
    if (!this.opening.size) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.openingWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.openingWaiters.add(done);
    });
  }

  /** Mark the span of one of our own actions: tabs opening without an opener link in it are ours. */
  expectTabs(ms: number): void {
    this.unlinkedUntil = Date.now() + ms;
  }

  private adopts(p: Page): boolean {
    if (this.preexisting.has(p.targetId)) return false;
    if (p.openerId && this.tabs.some((t) => t.page.targetId === p.openerId)) return true;
    const ctx = this.tabs[0]?.page.targetInfo.browserContextId;
    return !p.openerId && Date.now() <= this.unlinkedUntil && p.targetInfo.browserContextId === ctx;
  }

  get current(): Page {
    return this.cur;
  }

  get count(): number {
    return this.tabs.length;
  }

  /** Run on every tab, now and when one opens (dialog handlers, session setup). */
  onTab(hook: (page: Page) => void): void {
    this.onAddHooks.push(hook);
    for (const t of this.tabs) hook(t.page);
  }

  idOf(page: Page): string | undefined {
    return this.tabs.find((t) => t.page === page)?.id;
  }

  byId(id: string): Page | undefined {
    return this.tabs.find((t) => t.id === id.trim().toLowerCase())?.page;
  }

  /** Tabs opened at or after `since` (ms epoch), oldest first. */
  openedSince(since: number): Page[] {
    return this.tabs.filter((t) => t.openedAt >= since && !t.page.closed).map((t) => t.page);
  }

  async switchTo(page: Page): Promise<void> {
    if (page === this.cur) return;
    this.cur = page;
    // Headed sessions: show the tab the agent works in (also what a live-view watcher sees).
    await page.bringToFront().catch(() => undefined);
  }

  /** Notes about tabs that closed on their own since the last call (for evidence). */
  takeNotes(): string {
    const n = this.notes.join(" ");
    this.notes = [];
    return n;
  }

  /** One line per tab, for the snapshot header when more than one tab is open. */
  describe(): string {
    return this.tabs
      .filter((t) => !t.page.closed)
      .map((t) => `${t.id}${t.page === this.cur ? " (current)" : ""} ${t.page.url}`)
      .join(" | ");
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private add(page: Page): void {
    if (this.idOf(page) || page.closed) return;
    this.tabs.push({ id: `t${++this.seq}`, page, openedAt: Date.now() });
    page.dialogHandler = (d) => (this.dialogPolicy ? this.dialogPolicy(d) : { accept: d.type === "alert" });
    for (const hook of this.onAddHooks) hook(page);
  }

  private closed(page: Page): void {
    const i = this.tabs.findIndex((t) => t.page === page);
    if (i < 0) return;
    const [gone] = this.tabs.splice(i, 1);
    if (page !== this.cur || !this.tabs.length) return;
    const opener = this.tabs.find((t) => t.page.targetId === page.openerId) ?? this.tabs[this.tabs.length - 1]!;
    this.cur = opener.page;
    this.notes.push(`Tab ${gone!.id} closed; back in ${opener.id} (${opener.page.url}).`);
    void opener.page.bringToFront().catch(() => undefined);
  }
}
