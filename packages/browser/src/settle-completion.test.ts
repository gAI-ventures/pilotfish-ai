import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./page.js";

// Exercise the actual adaptive settle implementation with a controlled clock, not a copy of its loop.
const settleFast = (Page.prototype as unknown as { settleFast: (opts: { since: number }, start: number) => Promise<unknown> }).settleFast;
afterEach(() => vi.useRealTimers());

describe("adaptive settle completion", () => {
  it("does not round a completed onset probe up to the next 15 ms poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const evaluate = vi.fn(async (script: string) => {
      expect(script).toContain("10"); // 140 ms of the 150 ms onset window has already elapsed.
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10));
    });
    const frame = { network: { requestsSince: () => 0 }, evaluate };
    const page = { url: "https://fixture.test/", main: frame, frames: () => [frame], lastNavigationAt: 0 };
    let finished = false;
    const pending = settleFast.call(page, { since: 860 }, 1000).then((result) => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toBe(true);
    await expect(pending).resolves.toMatchObject({ networkIdle: true, mutationsQuiet: true, elapsedMs: 10 });
  });

  it("still waits for the full onset window when nothing starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const evaluate = vi.fn(async (script: string) => {
      expect(script).toContain("150");
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150));
    });
    const frame = { network: { requestsSince: () => 0 }, evaluate };
    const page = { url: "https://fixture.test/", main: frame, frames: () => [frame], lastNavigationAt: 0 };
    let finished = false;
    const pending = settleFast.call(page, { since: 1000 }, 1000).then((result) => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(149);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    await expect(pending).resolves.toMatchObject({ elapsedMs: 150 });
  });
});
