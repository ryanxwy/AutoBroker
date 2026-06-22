import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Test files live beside their sources (src/**/*.test.ts) and are type-checked
// by `tsc --build` like any other source. Exclude the compiled copies in dist/
// so each test runs exactly once, from src. The desktop Electron smoke suite
// (headed, launches real windows) runs only via `pnpm desktop:smoke` — never
// in this default suite. `.claude/**` holds session tooling AND temporary git
// worktrees of this repo — without the exclude, every suite would be
// discovered twice and run concurrently against shared singletons.
export default defineConfig({
  test: {
    // Brake real send for the whole unit suite — the product is real-send-by-default,
    // but a unit test must never reach a real dealer (see vitest.setup.ts). Absolute
    // path (resolved from THIS config's location) so a child `vitest run` spawned
    // with a different CWD (e.g. the telemetry-egress spike, cwd=packages/workflows)
    // still finds it.
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "apps/desktop/smoke/**"],
  },
});
