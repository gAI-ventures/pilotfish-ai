// The challenge handler with none registered: a check that may clear by itself is watched for autoClearMs, anything
// else goes straight to the person; a never-automate site or a cancelled run ends it first.

import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "@pilotfish/browser";
import type { InterruptInput, Interruption, Snapshot } from "@pilotfish/perception";
import { DEFAULT_CHALLENGE_POLICY } from "./challenge-policy.js";
import { challengeHandler, DEFAULT_CHALLENGES, registerChallengeHandler, type ChallengeDone, type ChallengeWork } from "./challenges.js";

function work(c: Partial<Interruption>, o: { clears?: boolean; excluded?: boolean; aborted?: boolean } = {}): { w: ChallengeWork; watched: number[] } {
  const watched: number[] = [];
  const done = (note: string): ChallengeDone => ({ kind: "done", out: { note } });
  const w: ChallengeWork = {
    check: { c: { category: "bot_challenge", blocking: true, autoResolvable: false, signals: [], needs: "solve_in_live_view", ...c } as Interruption, before: {} as InterruptInput, cur: {} as Snapshot, host: "a.example", source: "classifier" },
    page: {} as Page,
    policy: DEFAULT_CHALLENGE_POLICY,
    options: {},
    aborted: () => !!o.aborted,
    excluded: () => !!o.excluded,
    stop: () => done("stopped"),
    quit: () => done(""),
    cleared: async (_by, how) => done(how),
    see: async () => "unknown",
    look: async () => false,
    watch: async (ms) => {
      watched.push(ms);
      return !!o.clears;
    },
    gone: async () => false,
    reloaded: async () => false,
    scrub: (t) => t,
    reachedClean: () => false,
  };
  return { w, watched };
}

describe("DEFAULT_CHALLENGES", () => {
  afterEach(() => registerChallengeHandler(null));

  it("watches a self-clearing check for autoClearMs and goes on when it clears", async () => {
    const { w, watched } = work({ autoResolvable: true }, { clears: true });
    expect(await DEFAULT_CHALLENGES.work(w)).toEqual({ kind: "done", out: { note: "cleared on its own" } });
    expect(watched).toEqual([DEFAULT_CHALLENGE_POLICY.autoClearMs]);
  });

  it("hands a check that stays, or one that cannot clear by itself, to the person without trying anything", async () => {
    const stays = work({ autoResolvable: true });
    expect((await DEFAULT_CHALLENGES.work(stays.w)).kind).toBe("open");
    const captcha = work({ category: "captcha", autoResolvable: false, vendor: "human" });
    const r = await DEFAULT_CHALLENGES.work(captcha.w);
    expect(r).toMatchObject({ kind: "open", solverTokenInjected: false });
    expect(captcha.watched).toEqual([]);
  });

  it("stops on a never-automate site and does nothing once the run was cancelled", async () => {
    expect(await DEFAULT_CHALLENGES.work(work({ autoResolvable: true }, { excluded: true }).w)).toEqual({ kind: "done", out: { note: "stopped" } });
    expect(await DEFAULT_CHALLENGES.work(work({ autoResolvable: true }, { aborted: true }).w)).toEqual({ kind: "done", out: { note: "" } });
  });

  it("has no seen hook (input stays plain) and is what challengeHandler gives until a host registers one", () => {
    expect(DEFAULT_CHALLENGES.seen).toBeUndefined();
    expect(challengeHandler()).toBe(DEFAULT_CHALLENGES);
    const mine = { work: DEFAULT_CHALLENGES.work };
    registerChallengeHandler(mine);
    expect(challengeHandler()).toBe(mine);
  });
});
