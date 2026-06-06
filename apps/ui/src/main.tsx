/**
 * main — the React root. Mounts <App/>. The UI never touches the product DB or
 * external APIs — it renders server state over /api + SSE only.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("main: #root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
