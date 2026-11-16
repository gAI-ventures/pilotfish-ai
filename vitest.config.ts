import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const e2e = process.env.PILOTFISH_E2E === "1";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Browser e2e files each launch Chromes; half the CPUs keeps timing-sensitive tests deterministic.
    ...(e2e ? { maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)) } : {}),
  },
});
