// @vitest-environment happy-dom
/**
 * AssistantTurn.test — the gate-before-prose structural invariant.
 * Even when a `text` frame arrived BEFORE the `awaiting_user` frame in
 * the stream, the gate zone must render structurally ABOVE the text zone — the
 * zones are fixed JSX positions, never sorted by timestamp. Also: the gate hosts
 * the IntakeForm (data_collection) and a decline dispatches action 'decline'.
 */

import { describe, expect, it, vi } from "vitest";

import { AssistantTurn } from "./AssistantTurn.js";
import { ApiClient } from "../api/client.js";
import { click, render } from "../test/render.js";
import type { AssistantTurnView } from "../chat/messageModel.js";

function turnState(overrides: Partial<AssistantTurnView>): AssistantTurnView {
  return {
    runId: "run-1",
    skill: "search_profile_intake",
    status: "awaiting_approval",
    text: "",
    milestones: [],
    currentActivity: null,
    driverKind: "deepseek_apikey",
    awaitingUser: null,
    error: null,
    errorName: null,
    errorCode: null,
    resolution: null,
    ...overrides,
  };
}

/** A client whose fetch answers the STOP-picker's profile read. */
function stubClient(profiles: unknown[] = []): ApiClient {
  return new ApiClient({
    fetchImpl: (async () =>
      new Response(JSON.stringify(profiles), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

/** The non-turn props every render needs (STOP wiring defaults). */
function stopProps(over: Partial<{ onStartIntake: () => void; onPickStopProfile: (id: string) => void; client: ApiClient }> = {}) {
  return {
    client: over.client ?? stubClient(),
    onStartIntake: over.onStartIntake ?? ((): void => {}),
    onPickStopProfile: over.onPickStopProfile ?? ((): void => {}),
  };
}

describe("AssistantTurn — gate-before-prose ordering", () => {
  it("renders the gate zone structurally before the text zone, even with prose set first", () => {
    // Simulate the out-of-order case: prose text already accumulated AND a pending
    // suspend. The store reduced both; the component must still place the gate
    // above the prose by structure.
    const turn = turnState({
      text: "Here is some streamed prose that arrived before the form.",
      status: "awaiting_approval",
      awaitingUser: {
        decisionId: "d1",
        formKind: "data_collection",
        step: "collect",
        specInline: { kind: "data_collection", form_kind: "intake", seed_fields: null },
      },
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} {...stopProps()} />);

    const gate = r.get("turn-zone-gate");
    const text = r.get("turn-zone-text");
    // compareDocumentPosition: gate precedes text → DOCUMENT_POSITION_FOLLOWING bit.
    const rel = gate.compareDocumentPosition(text);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rel & Node.DOCUMENT_POSITION_PRECEDING).toBeFalsy();
    r.unmount();
  });

  it("the gate hosts the intake form; decline dispatches action 'decline'", () => {
    const onDecision = vi.fn();
    const turn = turnState({
      awaitingUser: {
        decisionId: "d1",
        formKind: "data_collection",
        step: "collect",
        specInline: { kind: "data_collection", form_kind: "intake", seed_fields: null },
      },
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={onDecision} {...stopProps()} />);
    expect(r.query("intake-form")).not.toBeNull();
    click(r.get("intake-decline"));
    expect(onDecision).toHaveBeenCalledWith("decline");
    r.unmount();
  });

  it("does NOT render the gate once the run is done (form collapsed)", () => {
    const turn = turnState({ status: "done", awaitingUser: null, text: "Created profile." });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} {...stopProps()} />);
    expect(r.query("turn-zone-gate")).toBeNull();
    expect(r.get("turn-zone-text").textContent).toContain("Created profile.");
    r.unmount();
  });
});

describe("AssistantTurn — typed STOP cards + resolution provenance", () => {
  /** Flush microtasks so the picker's profile fetch resolves. */
  async function flush(): Promise<void> {
    const { act } = await import("react");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("a DealerGeosearchStopError(no_active_profile) error renders the STOP card with the intake CTA", () => {
    const onStartIntake = vi.fn();
    const turn = turnState({
      skill: "dealer_geosearch",
      status: "error",
      error: "No active search profile found — run /search_profile_intake first.",
      errorName: "DealerGeosearchStopError",
      errorCode: "no_active_profile",
    });
    const r = render(
      <AssistantTurn turn={turn} submitting={false} onDecision={() => {}} {...stopProps({ onStartIntake })} />,
    );
    // The verbatim STOP wording stays on the error line; the card adds the CTA.
    expect(r.get("turn-error").textContent).toContain("No active search profile");
    expect(r.get("stop-card").getAttribute("data-stop-code")).toBe("no_active_profile");
    click(r.get("stop-intake-cta"));
    expect(onStartIntake).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("multiple_active_profiles renders the picker; picking re-launches with that profile id", async () => {
    const onPick = vi.fn();
    const profiles = [
      { search_profile_id: "prof-a", year: 2026, make: "Hyundai", model: "Tucson Hybrid", trim: "Limited" },
      { search_profile_id: "prof-b", year: 2026, make: "Hyundai", model: "Santa Fe Hybrid", trim: "Limited" },
    ];
    const turn = turnState({
      skill: "dealer_geosearch",
      status: "error",
      error: "Multiple active search profiles found.",
      errorName: "DealerGeosearchStopError",
      errorCode: "multiple_active_profiles",
    });
    const r = render(
      <AssistantTurn
        turn={turn}
        submitting={false}
        onDecision={() => {}}
        {...stopProps({ client: stubClient(profiles), onPickStopProfile: onPick })}
      />,
    );
    await flush(); // the picker fetches GET /api/profiles?status=active live.
    const options = r.container.querySelectorAll('[data-testid="stop-pick-option"]');
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toBe("2026 Hyundai Tucson Hybrid Limited");
    click(options[0] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("prof-a");
    r.unmount();
  });

  it("an untyped error (name mismatch) renders NO stop card — code alone never dispatches", () => {
    const turn = turnState({
      status: "error",
      error: "db locked",
      errorName: "SqliteError",
      errorCode: "no_active_profile", // adversarial: right code, wrong name.
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} {...stopProps()} />);
    expect(r.query("stop-card")).toBeNull();
    expect(r.query("turn-error")).not.toBeNull();
    r.unmount();
  });

  it("a done turn with resolution renders the provenance meta tag", () => {
    const turn = turnState({
      status: "done",
      awaitingUser: null,
      text: "Registered 3 new dealer candidate(s).",
      resolution: "pinned",
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} {...stopProps()} />);
    const tag = r.get("turn-resolution");
    expect(tag.getAttribute("data-resolution")).toBe("pinned");
    r.unmount();
  });
});
