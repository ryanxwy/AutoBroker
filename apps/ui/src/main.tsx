/**
 * main — the React root (FRONTEND_LAYOUT §3 component tree: `main.tsx`). B1 ships
 * a minimal root mounting <App/>; the QueryClientProvider + React Router land
 * with the routed shell in M2-run2. The UI never touches the product DB or
 * external APIs — it renders server state over /api + SSE only.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("main: #root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
