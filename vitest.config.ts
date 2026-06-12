import { defineConfig } from "vitest/config";

// Test files live beside their sources (src/**/*.test.ts) and are type-checked
// by `tsc --build` like any other source. Exclude the compiled copies in dist/
// so each test runs exactly once, from src. The desktop Electron smoke suite
// (headed, launches real windows) runs only via `pnpm desktop:smoke` — never
// in this default suite.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "apps/desktop/smoke/**"],
  },
});
