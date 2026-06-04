import { defineConfig } from "vitest/config";

// Test files live beside their sources (src/**/*.test.ts) and are type-checked
// by `tsc --build` like any other source. Exclude the compiled copies in dist/
// so each test runs exactly once, from src.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
