import { defineConfig } from "vitest/config";

// Desktop smoke runner — headed Electron launches, so long timeouts and strict
// sequencing (the single-instance lock means only one app may live at a time).
// Run via `pnpm desktop:smoke`; the root `pnpm test` excludes this directory.
export default defineConfig({
  test: {
    include: ["smoke/**/*.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    fileParallelism: false,
  },
});
