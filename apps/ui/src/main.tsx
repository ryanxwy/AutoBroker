/**
 * main — the React root. Mounts <App/>. The UI never touches the product DB or
 * external APIs — it renders server state over /api + SSE only.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
// Vendored fonts (local woff2 via npm — never a runtime font CDN request):
// Archivo variable with the width axis (font-stretch 125% = the expanded
// wordmark face), Fragment Mono for data/micro-labels, Source Serif 4
// variable (+ italic) for prose and notices.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/fragment-mono/400.css";
import "@fontsource/fragment-mono/400-italic.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
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
