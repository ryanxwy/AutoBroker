/**
 * CanvasTabs — the presentational tab strip for the per-profile workbench. A
 * roving-tabindex `role="tablist"` of segmented buttons (the .modeswitch
 * ledger idiom), each carrying a live badge count when its domain has rows.
 *
 * Presentational ONLY: it takes the tab descriptors + the active key + an
 * onSelect callback; Canvas owns the active-tab state and the panel render.
 */

import type { KeyboardEvent } from "react";

export interface CanvasTab {
  key: string;
  label: string;
  /** Live row count for the badge; null = unknown/not-applicable (no badge). */
  count: number | null;
}

export interface CanvasTabsProps {
  tabs: CanvasTab[];
  active: string;
  onSelect: (key: string) => void;
}

export function CanvasTabs({ tabs, active, onSelect }: CanvasTabsProps): JSX.Element {
  // Roving keyboard nav: ArrowLeft/ArrowRight move the selection across tabs.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.key === active);
    if (i === -1) return;
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
    e.preventDefault();
    onSelect(tabs[next]!.key);
  };

  return (
    <div className="canvas-tabs" role="tablist" data-testid="canvas-tabs" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            type="button"
            key={tab.key}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? "on" : undefined}
            data-testid={`canvas-tab-${tab.key}`}
            onClick={() => onSelect(tab.key)}
          >
            {tab.label}
            {tab.count !== null && tab.count > 0 && (
              <span className="canvas-tab-badge">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
