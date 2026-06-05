// @vitest-environment happy-dom
/**
 * IntakeScopeNotice.test — the non-skippable system notice (FRONTEND_LAYOUT §10 /
 * 裁定⑧). Renders the three points under [data-intake-scope-notice] and has NO
 * dismiss control (it cannot be skipped).
 */

import { describe, expect, it } from "vitest";

import { IntakeScopeNoticeCard } from "./IntakeScopeNotice.js";
import type { IntakeScopeNotice } from "../api/wire.js";
import { render } from "../test/render.js";

const NOTICE: IntakeScopeNotice = {
  kind: "intake_scope_notice",
  source_pinned_profile_id: "p-old",
  forked_session_id: "s-new",
  points: ["Creating a NEW search profile.", "Pin and work on the new profile.", "The original session stays pinned."],
};

describe("IntakeScopeNoticeCard", () => {
  it("renders under the [data-intake-scope-notice] selector with all three points", () => {
    const r = render(<IntakeScopeNoticeCard notice={NOTICE} />);
    expect(r.container.querySelector("[data-intake-scope-notice]")).not.toBeNull();
    expect(r.query("scope-notice-point-0")).not.toBeNull();
    expect(r.query("scope-notice-point-1")).not.toBeNull();
    expect(r.query("scope-notice-point-2")).not.toBeNull();
    r.unmount();
  });

  it("is non-dismissable — no close/dismiss button anywhere in the notice", () => {
    const r = render(<IntakeScopeNoticeCard notice={NOTICE} />);
    const notice = r.container.querySelector("[data-intake-scope-notice]")!;
    expect(notice.querySelectorAll("button")).toHaveLength(0);
    r.unmount();
  });
});
