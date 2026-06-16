// @vitest-environment happy-dom
/**
 * Settings.test — the Keys panel page. Proves: the four key rows + the Gmail
 * card render from the presence read; the first-run setup strip shows ONLY when
 * the required DeepSeek key is absent (gone once present).
 */

import { describe, expect, it } from "vitest";

import { ApiClient } from "../api/client.js";
import type { AsyncState } from "../api/useApi.js";
import type { EnvConfigResponse, KeyPresenceResponse, Mode } from "../api/wire.js";
import { render } from "../test/render.js";
import { Settings } from "./Settings.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const client = new ApiClient({ fetchImpl: (async () => new Response("{}")) as typeof fetch });

function presence(deepseek: boolean): AsyncState<KeyPresenceResponse> & { refetch: () => void; refreshing: boolean } {
  return {
    kind: "ok",
    data: {
      deepseek: { present: deepseek },
      anthropic: { present: false },
      openai: { present: false },
      google_places: { present: false },
      gmail: { connected: false },
    },
    refetch: () => {},
    refreshing: false,
  };
}

/** A resolved (empty) env read — the Environment panel needs it, but these tests
 *  assert the keys panel only, so an empty curated set keeps it inert. */
function env(): AsyncState<EnvConfigResponse> & { refetch: () => void; refreshing: boolean } {
  return { kind: "ok", data: { vars: [] }, refetch: () => {}, refreshing: false };
}

/** A resolved backend-mode read for the Diagnostics section. */
function mode(): AsyncState<Mode> & { refetch: () => void; refreshing: boolean } {
  return {
    kind: "ok",
    data: { active_db: "/tmp/autobroker.db", data_dir: "/tmp", demo: false },
    refetch: () => {},
    refreshing: false,
  };
}

describe("Settings — keys panel", () => {
  it("renders all four key rows + the Gmail card", () => {
    const r = render(
      <Settings
        client={client}
        presence={presence(false)}
        onChanged={() => {}}
        env={env()}
        onEnvChanged={() => {}}
        mode={mode()}
      />,
    );
    expect(r.query("settings-page")).not.toBeNull();
    expect(r.query("key-row-deepseek")).not.toBeNull();
    expect(r.query("key-row-google_places")).not.toBeNull();
    expect(r.query("key-row-anthropic")).not.toBeNull();
    expect(r.query("key-row-openai")).not.toBeNull();
    expect(r.query("gmail-card")).not.toBeNull();
    r.unmount();
  });

  it("shows the first-run setup strip when DeepSeek is absent", () => {
    const r = render(
      <Settings
        client={client}
        presence={presence(false)}
        onChanged={() => {}}
        env={env()}
        onEnvChanged={() => {}}
        mode={mode()}
      />,
    );
    expect(r.query("settings-setup-strip")).not.toBeNull();
    r.unmount();
  });

  it("hides the setup strip once DeepSeek is present", () => {
    const r = render(
      <Settings
        client={client}
        presence={presence(true)}
        onChanged={() => {}}
        env={env()}
        onEnvChanged={() => {}}
        mode={mode()}
      />,
    );
    expect(r.query("settings-setup-strip")).toBeNull();
    r.unmount();
  });
});
