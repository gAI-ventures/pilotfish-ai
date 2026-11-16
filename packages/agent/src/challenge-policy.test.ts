// The challenge policy decides only how long a run watches a human-only obstacle before handing it
// to a person. These tests pin the layering (defaults → environment → deployment → site) and the
// clamp, because every duration here is the step or the bound of a real watch loop: a zero poll
// would spin one forever rather than merely run it too fast.

import { describe, expect, it } from "vitest";
import { challengePolicy, challengePolicyFromEnv, DEFAULT_CHALLENGE_POLICY, MIN_POLL_MS } from "./challenge-policy.js";

describe("challengePolicy", () => {
  it("uses the defaults with nothing configured", () => {
    const { base, forSite } = challengePolicy({ env: {} });
    expect(base).toEqual(DEFAULT_CHALLENGE_POLICY);
    expect(forSite("example.com")).toEqual(DEFAULT_CHALLENGE_POLICY);
  });

  it("layers defaults over the environment over the deployment over the site", () => {
    const { forSite } = challengePolicy({
      env: { PILOTFISH_CHALLENGE_AUTO_CLEAR_MS: "2000" },
      defaults: { autoClearMs: 3000, pollMs: 500 },
      sites: { "bank.example": { autoClearMs: 9000 } },
    });
    expect(forSite("bank.example")).toEqual({ ...DEFAULT_CHALLENGE_POLICY, autoClearMs: 9000, pollMs: 500 });
    // A site without its own entry gets the deployment's defaults (not the environment's).
    expect(forSite("other.example").autoClearMs).toBe(3000);
    expect(forSite("other.example").pollMs).toBe(500);
  });

  it("resolves per site, and holds the same policy for one that is asked for twice", () => {
    const { forSite } = challengePolicy({ env: {}, sites: { "a.example": { pollMs: 250 } } });
    expect(forSite("a.example")).toBe(forSite("a.example"));
    expect(forSite("a.example").pollMs).toBe(250);
    expect(forSite("b.example").pollMs).toBe(DEFAULT_CHALLENGE_POLICY.pollMs);
    // No host (about:blank, a closed page): the base policy, never a throw.
    expect(forSite(null)).toEqual(DEFAULT_CHALLENGE_POLICY);
    expect(forSite(undefined)).toEqual(DEFAULT_CHALLENGE_POLICY);
    expect(forSite("")).toEqual(DEFAULT_CHALLENGE_POLICY);
  });

  it("reads the environment, ignoring values that are not usable numbers", () => {
    expect(challengePolicyFromEnv({ PILOTFISH_CHALLENGE_PERSON_WAIT_MS: "12000" })).toEqual({ personWaitMs: 12_000 });
    expect(challengePolicyFromEnv({ PILOTFISH_CHALLENGE_PERSON_WAIT_MS: "soon" })).toEqual({});
    expect(challengePolicyFromEnv({ PILOTFISH_CHALLENGE_PERSON_WAIT_MS: "-1" })).toEqual({});
    expect(challengePolicyFromEnv({ PILOTFISH_CHALLENGE_PERSON_WAIT_MS: "" })).toEqual({});
    expect(challengePolicyFromEnv({})).toEqual({});
  });

  it("gives a shorter self-clear window when a solver is available (solverGraceMs)", () => {
    // Default is shorter than the no-solver window, so a solvable check escalates to the cheap solver sooner.
    expect(DEFAULT_CHALLENGE_POLICY.solverGraceMs).toBe(4_000);
    expect(DEFAULT_CHALLENGE_POLICY.solverGraceMs).toBeLessThan(DEFAULT_CHALLENGE_POLICY.autoClearMs);
    expect(challengePolicyFromEnv({ PILOTFISH_CHALLENGE_SOLVER_GRACE_MS: "2000" })).toEqual({ solverGraceMs: 2_000 });
    expect(challengePolicy({ env: {}, defaults: { solverGraceMs: -1 } }).base.solverGraceMs).toBe(0);
    expect(challengePolicy({ env: {}, sites: { "slow.example": { solverGraceMs: 7000 } } }).forSite("slow.example").solverGraceMs).toBe(7_000);
  });

  it("holds a code question 30 s for the mailbox by default; the environment still overrides it", () => {
    // An emailed code takes seconds to land: 1.5 s always lost to it and pinged the person for nothing.
    expect(DEFAULT_CHALLENGE_POLICY.codeSourceMs).toBe(30_000);
    expect(challengePolicy({ env: { PILOTFISH_CHALLENGE_CODE_SOURCE_MS: "1500" } }).base.codeSourceMs).toBe(1_500);
  });

  it("floors the poll, so a watch loop always advances", () => {
    // Zero is the dangerous one: it is the step of the auto-clear, person-wait and await-gone loops.
    expect(challengePolicy({ env: { PILOTFISH_CHALLENGE_POLL_MS: "0" } }).base.pollMs).toBe(MIN_POLL_MS);
    expect(challengePolicy({ env: {}, sites: { "a.example": { pollMs: 0 } } }).forSite("a.example").pollMs).toBe(MIN_POLL_MS);
    expect(challengePolicy({ env: {}, defaults: { pollMs: -5 } }).base.pollMs).toBe(MIN_POLL_MS);
    // A useful poll is left alone.
    expect(challengePolicy({ env: { PILOTFISH_CHALLENGE_POLL_MS: "250" } }).base.pollMs).toBe(250);
  });

  it("holds every duration at or above zero", () => {
    const p = challengePolicy({ env: {}, defaults: { autoClearMs: -1, awaitGoneMs: -1, personWaitMs: -1, codeSourceMs: -1, clearedMs: -1, widgetReadMs: -1 } }).base;
    expect(p).toMatchObject({ autoClearMs: 0, awaitGoneMs: 0, personWaitMs: 0, codeSourceMs: 0, clearedMs: 0, widgetReadMs: 0 });
  });
});
