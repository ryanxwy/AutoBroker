/**
 * useLayout — the rail layout state as its own store slice (canvas-vs-
 * conversation split of the workbench). Persisted to localStorage so the
 * choice survives a refresh. Deliberately separate from useChat: layout is
 * device-local VIEW state, never conversation/run state.
 *
 * Dependency wall: app/ui layer. zustand + localStorage only.
 */

import { create } from "zustand";

/** The two workbench modes: canvas-dominant (default) or conversation-dominant
 *  (the chat rail takes the space, the canvas shrinks). */
export type WorkbenchMode = "canvas" | "conversation";

const STORAGE_KEY = "autobroker:rail-layout";

function loadMode(): WorkbenchMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "conversation" ? "conversation" : "canvas";
  } catch {
    return "canvas";
  }
}

interface LayoutState {
  mode: WorkbenchMode;
  setMode(mode: WorkbenchMode): void;
}

export const useLayout = create<LayoutState>()((set) => ({
  mode: typeof window === "undefined" ? "canvas" : loadMode(),
  setMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* view state only — persistence is best-effort */
    }
    set({ mode });
  },
}));
