// What the agent does with a CAPTCHA or a bot check before it hands it to the person (AgentOptions.challenges, or
// the handler a host registers at startup). The agent finds the check, keeps the never-automate list and owns the
// hand-off; a handler decides what is tried between the two. With none registered the check is watched for
// `autoClearMs` when it may clear by itself (a JavaScript or proof-of-work check), and then goes to the person.

import type { Page } from "@pilotfish/browser";
import type { InterruptInput, Interruption, Snapshot } from "@pilotfish/perception";
import type { AgentOptions } from "./agent.js";
import type { ChallengePolicy } from "./challenge-policy.js";

/** Where a challenge reached the agent from: the classifier, the model's ask_user (kind "check"), or a widget drawn in a usable page. */
export type ChallengeSource = "classifier" | "ask_user" | "inpage";

/** The check being worked on. `c`, `before` and `cur` follow the page as the tools below look at it again. */
export interface ChallengeCheck {
  c: Interruption;
  before: InterruptInput;
  cur: Snapshot;
  host: string;
  source: ChallengeSource;
}

/** The check is over for the caller: cleared, stopped (never-automate), or nothing once the run was cancelled. */
export interface ChallengeDone {
  kind: "done";
  out: { note: string; snap?: Snapshot };
}

/** The check is still on the page: the next step is the person. */
export interface ChallengeOpen {
  kind: "open";
  c: Interruption;
  before: InterruptInput;
  cur: Snapshot;
  /** An answer was already put in the page (the person is told to try submitting first). */
  solverTokenInjected: boolean;
}

export type ChallengeResult = ChallengeDone | ChallengeOpen;

/** What the agent gives a handler for one check. */
export interface ChallengeWork {
  check: ChallengeCheck;
  page: Page;
  /** The check's site's timings (challenge-policy.ts). */
  policy: ChallengePolicy;
  /** The run's options: the host callbacks a handler may use (solveChallenge, builtinChallenge, escalateChallenge). */
  options: Readonly<AgentOptions>;
  /** The run was cancelled: no verdict, no next step. */
  aborted(): boolean;
  /** The check's host, or where the page is now, is on the never-automate list. */
  excluded(): boolean;
  /** End the run as never-automate (the check's host, or the page's now). */
  stop(): ChallengeDone;
  /** The run was cancelled: nothing to report. */
  quit(): ChallengeDone;
  /** The check went: records it (onInterruptionCleared) and words the note for the model. */
  cleared(by: "auto" | "solver", how: string): Promise<ChallengeDone>;
  /**
   * Look at the page again: "clear" (no check or block page on it), "check" (a check or a block page: `check` becomes
   * it), "bare" (the vendor's own check page with no widget drawn yet: still this check), "unknown" (not read).
   */
  see(): Promise<"clear" | "check" | "bare" | "unknown">;
  /** see() is "clear". */
  look(): Promise<boolean>;
  /** Look every pollMs for up to `ms`: true once the check is gone. */
  watch(ms: number): Promise<boolean>;
  /** After an answer was put in: the page gets awaitGoneMs to show the check went, then one more look. */
  gone(): Promise<boolean>;
  /** True once the page loaded a new document after `since` (Page.lastDocumentAt; waiting up to `ms`) with content. */
  reloaded(since: number, ms: number): Promise<boolean>;
  /** The page's address with any secret the run holds masked. */
  scrub(text: string): string;
  /** The site has read clear on this run's browser before (a page with no check on it, answered under 400). */
  reachedClean(site: string): boolean;
}

export interface ChallengeHandler {
  /**
   * Every interruption the agent classifies on a page, before anything is done about it. `humanize()` switches the
   * run's input to the host's input driver for the rest of the session (browser/src/input-driver.ts).
   */
  seen?(c: Interruption, run: { page: Page; humanizing: boolean; humanize(): void }): void;
  /** Work on the check; "open" hands it on to the person. */
  work(w: ChallengeWork): Promise<ChallengeResult>;
}

/** What the agent does with no handler registered (see the top of this file). */
export const DEFAULT_CHALLENGES: ChallengeHandler = {
  async work(w) {
    if (w.aborted()) return w.quit();
    if (w.excluded()) return w.stop();
    const ms = w.check.c.autoResolvable ? w.policy.autoClearMs : 0;
    if (ms > 0 && (await w.watch(ms))) return w.cleared("auto", "cleared on its own");
    if (w.aborted()) return w.quit();
    if (w.excluded()) return w.stop();
    const { c, before, cur } = w.check;
    return { kind: "open", c, before, cur, solverTokenInjected: false };
  },
};

// Kept on globalThis: a process may load this module twice (a package's source and its build output, in tests), and
// both must see the one handler the host registered.
const SLOT = Symbol.for("pilotfish.challengeHandler");
type Slot = { [SLOT]?: ChallengeHandler | null };

/** Register the handler every agent uses unless its options name one (null: back to DEFAULT_CHALLENGES). */
export function registerChallengeHandler(h: ChallengeHandler | null): void {
  (globalThis as Slot)[SLOT] = h;
}

/** The registered handler, or DEFAULT_CHALLENGES. */
export function challengeHandler(): ChallengeHandler {
  return (globalThis as Slot)[SLOT] ?? DEFAULT_CHALLENGES;
}
