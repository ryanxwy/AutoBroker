/**
 * dependency-cruiser — mechanical enforcement of the five-layer one-way wall
 * and the SQLite/external-API ownership invariant (CLAUDE.md; ARCH_OVERVIEW).
 *
 * TS project references only police TYPE-level imports; a runtime `import` of
 * a package you don't reference still executes. These rules close that gap:
 *
 *   layer DAG (one-way):  core -> model -> workflows -> tools -> app
 *                         (db sits beside tools; only db+tools may know SQLite)
 *   framework ownership:  ai/@ai-sdk -> model only; @mastra -> workflows only;
 *                         drizzle/better-sqlite3 -> db only;
 *                         playwright/googleapis -> tools only.
 *
 * Run: pnpm lint:deps  (wired into CI).
 */
module.exports = {
  options: {
    // Keep node_modules edges in the graph (rules match on them) but never
    // traverse into them. NOTE: no `includeOnly` — it would drop the
    // node_modules target nodes before the rules ever see the edge.
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    // /dist/ = build output; apps/ui/e2e = the Playwright e2e harness (test
    // infrastructure that legitimately boots the full server stack + drives a
    // browser, so it lives OUTSIDE the layered src/ wall — like a .test file).
    // apps/desktop/smoke = the Electron shell's deterministic Playwright smoke
    // suite (same test-infrastructure carve-out); apps/desktop/bundle = the
    // generated self-contained server bundle (gitignored build artifact).
    exclude: { path: "/dist/|apps/ui/e2e/|apps/desktop/(smoke|bundle)/" },
  },
  forbidden: [
    // ---- layer DAG: lower layers must not reach up -------------------------
    {
      name: "core-imports-nothing-internal",
      severity: "error",
      comment: "core is pure types+Zod; it may not import any sibling layer.",
      from: { path: "^packages/core/" },
      to: { path: "^(packages/(model|workflows|tools|db|skills)|apps)/" },
    },
    {
      name: "model-only-core",
      severity: "error",
      from: { path: "^packages/model/" },
      to: { path: "^(packages/(workflows|tools|db|skills)|apps)/" },
    },
    {
      name: "workflows-never-app-or-db-direct",
      severity: "error",
      comment:
        "workflows may import core/model/tools — never app, and never db directly (DB access goes through tools).",
      from: { path: "^packages/workflows/" },
      to: { path: "^(packages/db|apps)/" },
    },
    {
      name: "tools-only-core-and-db",
      severity: "error",
      from: { path: "^packages/tools/" },
      to: { path: "^(packages/(model|workflows|skills)|apps)/" },
    },
    {
      name: "db-imports-nothing-internal",
      severity: "error",
      from: { path: "^packages/db/" },
      to: { path: "^(packages/(core|model|workflows|tools|skills)|apps)/" },
    },
    // ---- framework ownership ----------------------------------------------
    {
      name: "ai-sdk-only-in-model",
      severity: "error",
      comment:
        "AI SDK core (providers/generate) is the model layer's framework; invisible " +
        "in the packages. Sanctioned app-layer exceptions: apps/ui hosts the AI SDK " +
        "UI chat rail (@ai-sdk/react + the ai UIMessage/transport types) and " +
        "apps/server's /stream-v2 translator types its chunks against the ai " +
        "UIMessageChunk contract — neither may touch providers (registry stays in model).",
      from: {
        path: "^(packages/(core|workflows|tools|db|skills)|apps)/",
        pathNot: "^apps/(ui|server)/",
      },
      to: { path: "node_modules/(ai|@ai-sdk)/" },
    },
    {
      name: "app-ai-sdk-ui-binding-only",
      severity: "error",
      comment:
        "The app-layer carve-out is the UI binding ONLY: apps/ui+server may import " +
        "the ai package and @ai-sdk/react — never an @ai-sdk provider package " +
        "(provider wiring lives in packages/model).",
      from: { path: "^apps/(ui|server)/" },
      to: { path: "node_modules/@ai-sdk/", pathNot: "node_modules/@ai-sdk/react/" },
    },
    {
      name: "mastra-only-in-workflows",
      severity: "error",
      comment: "Mastra is the workflows backbone; invisible elsewhere.",
      from: { path: "^(packages/(core|model|tools|db|skills)|apps)/" },
      to: { path: "node_modules/@mastra/" },
    },
    {
      name: "sqlite-only-in-db",
      severity: "error",
      comment:
        "Only packages/db opens SQLite (tools reaches it via @autobroker/db).",
      from: { path: "^(packages/(core|model|workflows|tools|skills)|apps|harness)/" },
      to: { path: "node_modules/(better-sqlite3|drizzle-orm)/" },
    },
    {
      name: "side-effect-clients-only-in-tools",
      severity: "error",
      comment:
        "Playwright/Gmail clients are side-effect surfaces; only tools owns them. " +
        "One sanctioned exception: harness/uiDriver.ts launches the TEST browser " +
        "for the UI lane (dashboard-DOM user-action driver) — test infrastructure " +
        "like apps/ui/e2e, distinct from the product's browser service in tools.",
      from: {
        path: "^(packages/(core|model|workflows|db|skills)|apps|harness)/",
        pathNot: "^harness/uiDriver\\.ts$",
      },
      to: { path: "node_modules/(playwright|@googleapis|google-auth-library)/" },
    },
    // ---- core stays framework-free entirely --------------------------------
    {
      name: "core-framework-free",
      severity: "error",
      comment: "core may import zod and nothing else from node_modules.",
      from: { path: "^packages/core/" },
      to: {
        path: "node_modules/",
        pathNot: "node_modules/zod/",
      },
    },
  ],
};
