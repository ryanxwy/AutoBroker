/**
 * App — the B1 scaffold shell. NOT the full FRONTEND_LAYOUT §2 app shell (TopBar
 * + routed main + ChatRail + banners) — that lands with the routed components in
 * M2-run2. This bare App exists to prove the scaffold renders AND that the typed
 * API client reaches the backend: on mount it calls GET /api/skills via
 * apiClient and shows the decoded manifest (or the typed ApiError).
 *
 * Dependency wall: app/ui layer. Imports react + the api client only.
 */

import { useEffect, useState } from "react";

import { apiClient, ApiError } from "./api/client.js";
import type { SkillManifest } from "./api/wire.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; skills: SkillManifest[] }
  | { kind: "error"; message: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiClient
      .listSkills()
      .then((skills) => {
        if (!cancelled) setState({ kind: "ok", skills });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "unknown error";
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>AutoBroker</h1>
      <p>Dashboard scaffold (B1). The chat rail and home land in M2-run2.</p>
      <section aria-label="skills">
        <h2>Registered skills</h2>
        {state.kind === "loading" && <p>Loading skills…</p>}
        {state.kind === "error" && (
          <p role="alert">Backend unreachable: {state.message}</p>
        )}
        {state.kind === "ok" && (
          <ul>
            {state.skills.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong> — {s.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
