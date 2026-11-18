// Handing human-only obstacles (a login the agent has no credentials for, a 2FA code, a CAPTCHA,
// a push approval, 3-D Secure) to the person, fast: a deterministic classifier spots them after
// every action, before any model call is spent on them; the run pauses, the host asks the human
// (live view, a code prompt), and the agent watches the page and continues on its own the moment
// the obstacle is gone. A CAPTCHA or bot check goes to the person after the challenge handler
// (challenges.ts; by default a short watch for one that clears by itself), never tried on a
// never-automate host.

import type { Page } from "@pilotfish/browser";
import { captureSnapshot, classifyInterruption, DocumentChangedError, gatherInterruptInput, isResolved, trackMainResponse, type InterruptInput, type Interruption, type MainResponseTracker, type Snapshot } from "@pilotfish/perception";

/** What the host shows the human. */
export interface InterventionRequest {
  id: string;
  category: Interruption["category"];
  vendor?: string;
  /** What the human has to do: solve or sign in through the live view, type a code, approve on a device. */
  needs: Interruption["needs"];
  input?: Interruption["input"];
  /** Number-matching push: the number to pick on the phone. */
  displayNumber?: string;
  /** The page's address, scrubbed (a sign-in link's token shows as a placeholder). */
  url: string;
  host: string;
  title: string;
  /** One-line explanation for the person. */
  message: string;
  /** JPEG of the viewport, base64 (absent when a sensitive field is visible). */
  screenshot?: string;
  /** The agent watches the page and continues by itself once the obstacle is gone: no answer is needed for that. */
  autoResume?: boolean;
  /** A sign-in the person may answer with their username and password typed on the host's page (`credentials`). */
  acceptsCredentials?: boolean;
  /** A sign-in the person may answer with "create an account for me" (`signup`): the host makes the details. */
  acceptsSignup?: boolean;
  /**
   * The ways the sign-in page on screen offers, read from its fields and buttons (`signInOffers`): a password,
   * a phone number (a code by text), an email. Empty when the page shows none of them (a "Sign in" button only).
   */
  signInOffers?: SignInMethod[];
  /** A sign-in the person may skip (a `skip` answer): the run goes on without an account, as far as the site lets it. */
  acceptsSkip?: boolean;
  /** A sign-in page's country code beside its phone field ("+91"), when it shows one: the card's phone form starts there. */
  dialCode?: string;
  /**
   * This site's sign-in was skipped earlier in the run, and the site will not go further without it: the host may
   * pause the run with the sign-in to fill in, rather than ask again.
   */
  afterSkip?: boolean;
}

/** A way to sign in a page offers: a password field, a phone / mobile number field, an email field. */
export type SignInMethod = "password" | "phone" | "email";

/** Details for an account pilotfish creates with the person's approval (the host generates the password and saves the login). */
export interface SignupDetails {
  email: string;
  password: string;
  /** The person's name, for a name field. */
  name?: string;
}

/**
 * `credentials`: the person typed their sign-in details on pilotfish's own page (never the model's chat).
 * `signup`: they have no account and approved creating one with these details. Only a sign-in hand-off takes either.
 */
export type InterventionResponse =
  | { status: "done" }
  | { status: "code"; code: string }
  | { status: "cancel"; reason?: string }
  | { status: "skip" }
  | { status: "credentials"; username: string; password: string }
  | ({ status: "signup" } & SignupDetails)
  | CodeLoginResponse;

/**
 * `code_login`: the person signs in with no password: the agent types their phone number (or email) and the site
 * sends a one-time code there (a text, an email), which the person then gives like any code.
 */
export interface CodeLoginResponse {
  status: "code_login";
  /** The phone number or email address the site sends the code to. */
  identifier: string;
  channel: "sms" | "email";
}

/**
 * What the agent hands the host along with a request. `signal` aborts when the agent no longer
 * needs an answer: the page shows the obstacle is gone, or the run ended. The host withdraws the
 * question then (closes the prompt, clears its pending slot).
 */
export interface InterventionContext {
  signal: AbortSignal;
}

/** An obstacle that is over, and how long the run waited for it. */
export interface InterruptionCleared {
  category: Interruption["category"];
  vendor?: string;
  host: string;
  /** The page's address, scrubbed. */
  url: string;
  /** "auto": cleared by itself (JS check); "person": the person handled it; "solver": the CAPTCHA solver. */
  by: "auto" | "person" | "solver";
  waitedMs: number;
}

/**
 * A CAPTCHA / bot challenge the solver may attempt before the person, passed to AgentOptions.solveChallenge.
 * The host wires the actual solver, per-site policy and budget; the agent only invokes this
 * and then watches the page. Never called for a never-automate host.
 */
export interface ChallengeSolveRequest {
  page: Page;
  category: "captcha" | "bot_challenge";
  vendor?: string;
  host: string;
  /** The page's origin and path, the query and fragment left out (it goes to a third-party solver). */
  url: string;
  signals: string[];
  signal?: AbortSignal;
}

/** solved: a token/cookie was applied and the page should clear; unsolved: tried and failed; skip: not attempted. */
export type ChallengeSolveOutcome = "solved" | "unsolved" | "skip";

/** A solve whose answer is not in the page yet: `apply` puts it in (a token, or a cookie and a reload); `drop` leaves it unused. */
export interface PreparedSolve {
  apply(): Promise<ChallengeSolveOutcome>;
  drop(): void;
}

export type SolveChallenge = ((req: ChallengeSolveRequest) => Promise<ChallengeSolveOutcome>) & {
  /**
   * The solve alone, nothing done to the page: the ladder starts it alongside the built-in handler and puts its
   * answer in only if the handler did not clear the check.
   */
  prepare?: (req: ChallengeSolveRequest) => Promise<"skip" | "unsolved" | PreparedSolve>;
};

/**
 * Sites pilotfish never automates: ticket sellers (the US BOTS Act makes circumventing a ticket
 * issuer's access controls unlawful) and India's Aadhaar authority (the Aadhaar Act, s.38). A
 * CAPTCHA or bot check on them ends the run instead of going to the person. Callers add their own.
 */
export const NEVER_AUTOMATE_HOSTS = ["ticketmaster.com", "*.ticketmaster.com", "livenation.com", "*.livenation.com", "uidai.gov.in", "*.uidai.gov.in"];

/** Whether `host` matches a glob ("*" for every site, "*.x.com" for x.com and its subdomains). */
export function hostMatches(host: string, glob: string): boolean {
  const h = host.toLowerCase();
  const g = glob.toLowerCase();
  return g === "*" || g === h || (g.startsWith("*.") && (h === g.slice(2) || h.endsWith(g.slice(1))));
}

/** Whether `host` is on the never-automate list (the defaults plus `extra`). */
export function neverAutomate(host: string, extra: string[] = []): boolean {
  return [...NEVER_AUTOMATE_HOSTS, ...extra].some((g) => hostMatches(host, g));
}

const trackers = new WeakMap<Page, MainResponseTracker>();

/** The main-document response tracker of a tab (attach it as early as possible: before navigating). */
export function responseTracker(page: Page): MainResponseTracker {
  let t = trackers.get(page);
  if (!t) {
    t = trackMainResponse(page);
    trackers.set(page, t);
  }
  return t;
}

/**
 * A look that cannot be bound to one document: its capture was unsettled (Snapshot.unsettled), the tab did not know
 * its document yet (Snapshot.document null), or the page committed another document between the capture and the end
 * of reading the rest (the response, the address, frames, cookies). It is not classified.
 */
export class UnboundLookError extends Error {
  constructor(
    url: string,
    readonly why: "unsettled" | "unknown_document" | "changed" | "unconfirmed",
  ) {
    super(`${why === "unknown_document" ? "the tab's document was not known yet" : why === "unconfirmed" ? "the page could not confirm which document it was on" : "the page loaded another document while it was read"} (${url}); not classified`);
    this.name = "UnboundLookError";
  }
}

/**
 * Whether the page is still on the document `snap` was bound to (Snapshot.documentSeq and document: an event count and
 * a loaderId, never a time). State read from a snapshot (a target to click, a URL, a password field) is used only
 * while this holds. Snapshots not made by captureSnapshot carry no binding and always pass.
 */
export function onDocumentOf(page: Page, snap: Snapshot): boolean {
  return snap.documentSeq === undefined || (page.documentSeq === snap.documentSeq && page.documentId === snap.document);
}

/**
 * Classify the current page of a tab. ~2-5 ms for the classifier plus two cheap CDP calls. Everything read is of the
 * document the snapshot was bound to: the response is that document's (Snapshot.document), and the page must still be
 * on it before and after the rest is read (address, frames, cookies), else UnboundLookError, as for a snapshot bound to
 * no document. Callers use readPage, which takes that as "unknown" and never as a page with nothing on it.
 */
export async function classifyPage(page: Page, snap: Snapshot): Promise<{ result: Interruption; input: InterruptInput }> {
  if (snap.unsettled) throw new UnboundLookError(snap.url, "unsettled");
  if (snap.document === null) throw new UnboundLookError(snap.url, "unknown_document");
  if (!onDocumentOf(page, snap)) throw new UnboundLookError(snap.url, "changed");
  // The gather itself asks the page, before and after, whether it is still on the snapshot's document.
  const input = await gatherInterruptInput(page, { snapshot: snap as unknown as InterruptInput["snapshot"], tracker: responseTracker(page), ...(snap.document !== undefined ? { document: snap.document } : {}) }).catch((e: unknown) => {
    if (e instanceof DocumentChangedError) throw new UnboundLookError(snap.url, e.seen ? "changed" : "unconfirmed");
    throw e;
  });
  if (!onDocumentOf(page, snap)) throw new UnboundLookError(snap.url, "changed");
  return { result: classifyInterruption(input), input };
}

/**
 * What a look at the page found. `known`: the classifier's reading of one document; `snap` and `input` (its URL, frames,
 * cookies, response) are of that same document, and `snap` may be a newer capture than the one passed: a caller takes
 * everything it uses from this reading (never the snapshot it passed in). `unknown`: no single document could be read
 * (`why`; `changed` when a document change was actually seen during the tries); it is no reading at all, never the
 * category "none": a caller keeps what it knew before, and says the page could not be verified rather than that it
 * needs nobody.
 */
export type PageRead =
  | { state: "known"; result: Interruption; input: InterruptInput; snap: Snapshot }
  | { state: "unknown"; why: string; changed: boolean; snap: Snapshot };

/** Captures readPage takes again, at most, when the document changed under a look. */
export const READ_TRIES = 3;

/**
 * Words for a look that could not be verified, for the model or a client: a document change is named only when one
 * was seen (`changed`); otherwise only that the page could not be read as one document.
 */
export function unreadNote(host: string, changed: boolean): string {
  return `Could not verify the page on ${host || "this tab"} for a sign-in, a code or a bot check: ${changed ? "it loaded another document while it was read" : "it could not be read as one document"}.`;
}

/**
 * Classify the page in `snap`, as one document: a look the page's document changed under (UnboundLookError "changed")
 * or bound to no document is captured again, up to READ_TRIES looks in all; then, or for any other failure, it is
 * "unknown".
 */
export async function readPage(page: Page, snap: Snapshot): Promise<PageRead> {
  let cur = snap;
  // A document change seen on any try: the only case the words may name one.
  let changed = false;
  for (let n = 1; ; n++) {
    try {
      const { result, input } = await classifyPage(page, cur);
      return { state: "known", result, input, snap: cur };
    } catch (e) {
      const why = e instanceof UnboundLookError ? e.why : e instanceof Error ? e.message : String(e);
      if (e instanceof UnboundLookError && (e.why === "changed" || e.why === "unsettled")) changed = true;
      if (!(e instanceof UnboundLookError) || n >= READ_TRIES || page.closed) return { state: "unknown", why, changed, snap: cur };
    }
    const next = await captureSnapshot(page, { viewportBand: 1, previous: cur }).catch(() => null);
    if (!next) return { state: "unknown", why: "capture failed", changed, snap: cur };
    cur = next;
  }
}

export { isResolved };

/** Waits for a site that answered with a rate limit before the run stops there as a block. */
export const RATE_WAITS_MS = [15_000, 45_000];

/**
 * A rate limit, not a ban: a 429 "Too many requests" page or Cloudflare's 1015 "You are being rate limited". It lifts
 * by itself, so the run waits and loads the page again before it stops there (treated as a hard block, it ended runs that a short wait would have saved).
 */
export function rateLimited(c: Interruption): boolean {
  return c.category === "hard_block" && c.signals.some((s) => /rate limit/i.test(s));
}

/** The page's Retry-After (seconds or an HTTP date) in ms, kept within 1-60 s; null when the server gives none. */
export function retryAfterMs(input: InterruptInput | null | undefined, now = Date.now()): number | null {
  const v = Object.entries(input?.response?.headers ?? {}).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
  if (!v) return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1_000 : Date.parse(v) - now;
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(1_000, ms)) : null;
}

/** Human-readable reason for a request. */
export function describeInterruption(i: Interruption, host: string): string {
  const who = i.vendor ? ` (${i.vendor})` : "";
  switch (i.category) {
    case "captcha":
    case "bot_challenge":
      return `${host} shows a CAPTCHA / bot check${who}. Please solve it in the live view; the run continues by itself once it is passed.`;
    case "login":
      return `${host} asks to sign in${who}. Please sign in in the live view (the agent has no credentials for it).`;
    case "otp":
      return `${host} asks for a verification code${i.input?.hint ? ` (${i.input.hint})` : ""}. Please send the code, or type it in the live view.`;
    case "push_approval":
      return `${host} sent a sign-in request to your device${i.displayNumber ? `; pick ${i.displayNumber}` : ""}. Please approve it.`;
    case "magic_link":
      return `${host} emailed a sign-in link${i.input?.hint ? ` (${i.input.hint})` : ""}. Please open it or paste it.`;
    case "passkey":
      return `${host} asks for a passkey / security key. Please sign in another way in the live view.`;
    case "payment_3ds":
      return `Your bank asks to confirm the payment (3-D Secure)${who}. Please complete it in the live view.`;
    case "http_auth":
      return `${host} asks for a username and password (HTTP authentication).`;
    case "hard_block":
      if (i.vendor === "geo") return `${host} is not available from the country this task browsed from. Another country's IP may reach it.`;
      return `${host} refused automated access${who}. A person cannot fix this from the live view.`;
    default:
      return `${host} needs your help (${i.category}).`;
  }
}

/** Per-site record of the obstacles runs met and how they ended. */
export interface SiteInterruptions {
  site: string;
  /** Runs that loaded a page of the site. */
  visits: number;
  /** Of those, runs that started with a saved profile for the site. */
  visitsWithProfile: number;
  /** Runs that met at least one CAPTCHA or bot check on the site. */
  challengedVisits: number;
  challengedVisitsWithProfile: number;
  /** Every obstacle, by category. */
  byCategory: Record<string, number>;
  autoCleared: number;
  /** Challenges a challenge handler cleared without the person. */
  solved: number;
  handedOff: number;
  /** Handed off and then gone (the person handled it). */
  resolved: number;
  /** Handed off and declined, timed out or never cleared. */
  unresolved: number;
  /** Hard blocks and never-automate stops. */
  stopped: number;
  /** Wait from hand-off to the page clearing, per resolved hand-off (ms). */
  resumeMs: number[];
}

/** The fields of a step event the stats read (any step event fits; only "interruption" ones count). */
type ObservedEvent = { type: string; category?: string; host?: string; handled?: string; waitedMs?: number };

/**
 * Challenge rate, time to resume and how often a saved profile skipped the check, per site.
 * Feed it a run's step events (`observe`), then call `endRun` with the sites the run visited.
 */
export class InterruptionStats {
  private readonly sites = new Map<string, SiteInterruptions>();
  private run = new Map<string, { challenged: boolean }>();

  constructor(private readonly siteOf: (host: string) => string = (h) => h) {}

  private entry(site: string): SiteInterruptions {
    let s = this.sites.get(site);
    if (!s) {
      s = { site, visits: 0, visitsWithProfile: 0, challengedVisits: 0, challengedVisitsWithProfile: 0, byCategory: {}, autoCleared: 0, solved: 0, handedOff: 0, resolved: 0, unresolved: 0, stopped: 0, resumeMs: [] };
      this.sites.set(site, s);
    }
    return s;
  }

  observe(e: ObservedEvent): void {
    if (e.type !== "interruption" || !e.host || !e.category || !e.handled) return;
    const site = this.siteOf(e.host);
    const s = this.entry(site);
    const r = this.run.get(site) ?? { challenged: false };
    this.run.set(site, r);
    const challenge = e.category === "captcha" || e.category === "bot_challenge";
    switch (e.handled) {
      case "asked":
        s.byCategory[e.category] = (s.byCategory[e.category] ?? 0) + 1;
        s.handedOff++;
        if (challenge) r.challenged = true;
        break;
      case "auto_cleared":
      case "auto_filled":
      case "credentials":
      case "left_to_model":
      case "solved":
        s.byCategory[e.category] = (s.byCategory[e.category] ?? 0) + 1;
        if (e.handled === "auto_cleared") s.autoCleared++;
        if (e.handled === "solved") s.solved++;
        if (challenge) r.challenged = true;
        break;
      case "resolved":
        s.resolved++;
        if (typeof e.waitedMs === "number") s.resumeMs.push(e.waitedMs);
        break;
      case "unresolved":
        s.unresolved++;
        break;
      case "stopped":
        s.byCategory[e.category] = (s.byCategory[e.category] ?? 0) + 1;
        s.stopped++;
        if (challenge) r.challenged = true;
        break;
    }
  }

  /** Close a run: every site it visited counts one visit (with or without a saved profile). */
  endRun(visited: Iterable<string>, withProfile: (site: string) => boolean = () => false): void {
    const sites = new Set([...visited].filter(Boolean).map((h) => this.siteOf(h)));
    for (const site of this.run.keys()) sites.add(site);
    for (const site of sites) {
      const s = this.entry(site);
      const profile = withProfile(site);
      s.visits++;
      if (profile) s.visitsWithProfile++;
      if (this.run.get(site)?.challenged) {
        s.challengedVisits++;
        if (profile) s.challengedVisitsWithProfile++;
      }
    }
    this.run = new Map();
  }

  /** Every site, with derived rates: challenge rate, profile skip rate, median and p90 time to resume. */
  summary(): Array<SiteInterruptions & { challengeRate: number; profileSkipRate: number | null; resumeP50Ms: number | null; resumeP90Ms: number | null }> {
    return [...this.sites.values()]
      .map((s) => {
        const sorted = [...s.resumeMs].sort((a, b) => a - b);
        const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
        return {
          ...s,
          challengeRate: s.visits ? s.challengedVisits / s.visits : 0,
          profileSkipRate: s.visitsWithProfile ? 1 - s.challengedVisitsWithProfile / s.visitsWithProfile : null,
          resumeP50Ms: pct(0.5),
          resumeP90Ms: pct(0.9),
        };
      })
      .sort((a, b) => b.visits - a.visits || a.site.localeCompare(b.site));
  }
}
