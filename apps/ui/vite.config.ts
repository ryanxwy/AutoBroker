import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the dashboard SPA.
 *
 * - dev: Vite dev server on :5173 proxies `/api` -> the backend on
 *   127.0.0.1:8100 (the single local process; the backend binds loopback).
 *   The proxy keeps SSE working: `/api/skill-runs/:id/stream` is a long-lived
 *   text/event-stream response — `changeOrigin` + no buffering is the default
 *   http-proxy behaviour, so EventSource streams through unbuffered.
 * - build: emits the static SPA into `dist/` (apps/server serves it with a
 *   SPA fallback in a later slice).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8100",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
