// How long the run gives a human-only obstacle to clear by itself, and how hard it looks before
// handing it off. These are timing constants only: how long to wait for a check that may pass on its
// own, and how long to watch a page after a sign-in or a code was entered. What is tried on a check
// before the person is the challenge handler's (challenges.ts), not governed here.
//
// With no handler registered, a check that may clear by itself is watched for `autoClearMs` (8 s), then
// handed to the person. The vendor windows (Cloudflare 12 s, HUMAN (PerimeterX) 20 s, DataDome 6 s) and
// the widget timings are for a handler that watches a vendor's check longer.
//
// Tuning them changes what a run costs in wall-clock time and how often it bothers the person:
// - a low `autoClearMs` hands checks over early (more hand-offs, less waiting);
// - a high one spends the time on every check a site never clears by itself.
//
// Defaults are the values that were tuned on the hand-off suite. PILOTFISH_CHALLENGE_* overrides them
// for a deployment, and a per-site entry overrides both for that registrable domain.

export interface ChallengePolicy {
  /** How long a bot check that may clear by itself is watched before it goes to a person (ms). Default 8000. */
  autoClearMs: number;
  /**
   * How long a self-clearing check is watched before escalating when a SOLVER is wired (ms). Default 4000
   * — shorter than `autoClearMs`, because a solver is a cheap, fast fallback, so there is no need to wait
   * the full window for a free self-clear. The watch still returns the instant the page clears.
   */
  solverGraceMs: number;
  /** How often the page is looked at during that window (ms). Default 1000. */
  pollMs: number;
  /** How long the page is watched after a code or link was used, before concluding it did not take (ms). Default 6000. */
  awaitGoneMs: number;
  /** How long the page is watched after a person handled an obstacle, before asking again (ms). Default 6000. */
  personWaitMs: number;
  /**
   * How long a code source (a saved recovery code, the person's mailbox) may take before the person
   * is asked in parallel (ms). Default 30000: an emailed code usually lands within it, so the person is
   * not pinged for a code the inbox is about to give. A source with nothing to offer answers null at
   * once and the person is asked at once; past this, whoever answers first wins.
   */
  codeSourceMs: number;
  /** How long the host's onInterruptionCleared callback may take before the run moves on (ms). Default 3000. */
  clearedMs: number;
  /** The watch window for a Cloudflare check, where a handler uses vendor windows (ms). Default 12000. */
  cloudflareClearMs: number;
  /** The watch window for a HUMAN (PerimeterX) check, where a handler uses vendor windows (ms). Default 20000. */
  humanClearMs: number;
  /** The watch window for a DataDome check, where a handler uses vendor windows (ms). Default 6000. */
  datadomeClearMs: number;
  /**
   * How long a check page with no widget drawn on it yet is looked at for one before it counts as a block (ms):
   * HUMAN's block page reads as a hard block until its script has drawn its Press & Hold. Default 8000.
   */
  widgetAppearMs: number;
  /**
   * How long a drawn widget that needs a person's input and cannot clear by itself (HUMAN's Press & Hold) is looked
   * at before a handler acts on it, never longer than the vendor's window. Default 20000, HUMAN's own window. A
   * shorter read is for a deployment or a site that has measured it (PILOTFISH_CHALLENGE_WIDGET_READ_MS, or the
   * site's entry). A check page with nothing drawn on it yet keeps the vendor's window.
   */
  widgetReadMs: number;
}

export const DEFAULT_CHALLENGE_POLICY: ChallengePolicy = {
  autoClearMs: 8_000,
  solverGraceMs: 4_000,
  pollMs: 1_000,
  awaitGoneMs: 6_000,
  personWaitMs: 6_000,
  codeSourceMs: 30_000,
  clearedMs: 3_000,
  cloudflareClearMs: 12_000,
  humanClearMs: 20_000,
  datadomeClearMs: 6_000,
  widgetAppearMs: 8_000,
  widgetReadMs: 20_000,
};

/** A partial override, by environment variable or for a site. */
export type ChallengePolicyOverride = Partial<Record<keyof ChallengePolicy, number>>;

export interface ChallengePolicyOptions {
  /** Per registrable domain ("ticketmaster.com" → { autoClearMs: 15000 }). */
  sites?: Record<string, ChallengePolicyOverride>;
  /** Applied to every site, under any per-site entry. */
  defaults?: ChallengePolicyOverride;
  env?: Record<string, string | undefined>;
}

/** PILOTFISH_CHALLENGE_AUTO_CLEAR_MS → autoClearMs; a non-number or a negative is ignored. */
const ENV_KEYS: Record<string, keyof ChallengePolicy> = {
  PILOTFISH_CHALLENGE_AUTO_CLEAR_MS: "autoClearMs",
  PILOTFISH_CHALLENGE_SOLVER_GRACE_MS: "solverGraceMs",
  PILOTFISH_CHALLENGE_POLL_MS: "pollMs",
  PILOTFISH_CHALLENGE_AWAIT_GONE_MS: "awaitGoneMs",
  PILOTFISH_CHALLENGE_PERSON_WAIT_MS: "personWaitMs",
  PILOTFISH_CHALLENGE_CODE_SOURCE_MS: "codeSourceMs",
  PILOTFISH_CHALLENGE_CLEARED_MS: "clearedMs",
  PILOTFISH_CHALLENGE_CLOUDFLARE_CLEAR_MS: "cloudflareClearMs",
  PILOTFISH_CHALLENGE_HUMAN_CLEAR_MS: "humanClearMs",
  PILOTFISH_CHALLENGE_DATADOME_CLEAR_MS: "datadomeClearMs",
  PILOTFISH_CHALLENGE_WIDGET_APPEAR_MS: "widgetAppearMs",
  PILOTFISH_CHALLENGE_WIDGET_READ_MS: "widgetReadMs",
};

/**
 * The overrides in the environment, as a policy override. A variable that is unset, blank or not a
 * number is ignored: an empty `PILOTFISH_CHALLENGE_AUTO_CLEAR_MS=` in a deployment's environment
 * must not read as a zero (which would hand every check over at once).
 */
export function challengePolicyFromEnv(env: Record<string, string | undefined> = process.env): ChallengePolicyOverride {
  const out: ChallengePolicyOverride = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/**
 * The shortest gap between two looks at the page. Every watch loop advances by `pollMs`, so a zero
 * (which the environment and a per-site entry both allow, since "no wait at all" is a reasonable
 * thing to ask for elsewhere) would step the loop without ever reaching its deadline. 100 ms is well
 * under any useful poll and still leaves the page alone between looks.
 */
export const MIN_POLL_MS = 100;

/**
 * A resolved policy, held to values a watch loop can run on: every duration at or above zero, and the
 * poll long enough to make progress. Out-of-range values would hang a loop, not merely slow it.
 */
function clamp(p: ChallengePolicy): ChallengePolicy {
  return {
    ...p,
    autoClearMs: Math.max(0, p.autoClearMs),
    solverGraceMs: Math.max(0, p.solverGraceMs),
    awaitGoneMs: Math.max(0, p.awaitGoneMs),
    personWaitMs: Math.max(0, p.personWaitMs),
    codeSourceMs: Math.max(0, p.codeSourceMs),
    clearedMs: Math.max(0, p.clearedMs),
    cloudflareClearMs: Math.max(0, p.cloudflareClearMs),
    humanClearMs: Math.max(0, p.humanClearMs),
    datadomeClearMs: Math.max(0, p.datadomeClearMs),
    widgetAppearMs: Math.max(0, p.widgetAppearMs),
    widgetReadMs: Math.max(0, p.widgetReadMs),
    pollMs: Math.max(MIN_POLL_MS, p.pollMs),
  };
}

/**
 * The policy a run uses: the defaults, over the environment, over the deployment's own defaults, and
 * finally the site's entry. A run resolves it per host, because the site is what a check belongs to.
 */
export function challengePolicy(opts: ChallengePolicyOptions = {}): { forSite: (site: string | null | undefined) => ChallengePolicy; base: ChallengePolicy } {
  const env = challengePolicyFromEnv(opts.env);
  const base = clamp({ ...DEFAULT_CHALLENGE_POLICY, ...env, ...opts.defaults });
  const sites = opts.sites ?? {};
  const cache = new Map<string, ChallengePolicy>();
  const forSite = (site: string | null | undefined): ChallengePolicy => {
    if (!site) return base;
    const hit = cache.get(site);
    if (hit) return hit;
    const resolved = clamp({ ...base, ...sites[site] });
    cache.set(site, resolved);
    return resolved;
  };
  return { forSite, base };
}

/**
 * The vendor's own watch window for a check (Cloudflare 12 s, HUMAN 20 s, DataDome 6 s), or `autoClearMs` for
 * any other vendor.
 */
export function vendorClearMs(policy: ChallengePolicy, vendor: string | undefined): number {
  switch (vendor) {
    case "cloudflare":
      return policy.cloudflareClearMs;
    case "human":
      return policy.humanClearMs;
    case "datadome":
      return policy.datadomeClearMs;
    default:
      return policy.autoClearMs;
  }
}
