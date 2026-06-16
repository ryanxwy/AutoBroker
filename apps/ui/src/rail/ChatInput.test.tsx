// @vitest-environment happy-dom
/**
 * ChatInput.test — the composer's correctness rules: Send disabled while empty,
 * Enter sends / Shift+Enter inserts a newline, and the IME composition guard
 * (Enter is ignored while isComposing) so a CJK candidate-confirm never sends a
 * half-typed message.
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { change, click, render } from "../test/render.js";
import { ChatInput } from "./ChatInput.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KNOWN = ["search_profile_intake", "dealer_geosearch"];

/** Dispatch a keydown (React reads e.nativeEvent.isComposing / keyCode). */
function keydown(node: HTMLElement, init: KeyboardEventInit): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

describe("ChatInput — composer correctness", () => {
  it("Send is disabled while empty and enabled once there is non-blank text", () => {
    const r = render(<ChatInput knownSkills={KNOWN} onSlash={() => {}} onFreeform={() => {}} />);
    const send = r.get("chat-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "hello");
    expect(send.disabled).toBe(false);

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "   ");
    expect(send.disabled).toBe(true);
    r.unmount();
  });

  it("Enter sends freeform; Shift+Enter does NOT", () => {
    const onFreeform = vi.fn();
    const r = render(<ChatInput knownSkills={KNOWN} onSlash={() => {}} onFreeform={onFreeform} />);
    const ta = r.get("chat-input-textarea") as HTMLTextAreaElement;

    change(ta, "find me a car");
    keydown(ta, { key: "Enter", shiftKey: true });
    expect(onFreeform).not.toHaveBeenCalled();

    keydown(ta, { key: "Enter" });
    expect(onFreeform).toHaveBeenCalledWith("find me a car");
    // sent → the field clears.
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).value).toBe("");
    r.unmount();
  });

  it("Enter during an IME composition is ignored (isComposing guard)", () => {
    const onFreeform = vi.fn();
    const r = render(<ChatInput knownSkills={KNOWN} onSlash={() => {}} onFreeform={onFreeform} />);
    const ta = r.get("chat-input-textarea") as HTMLTextAreaElement;

    change(ta, "ねこ");
    keydown(ta, { key: "Enter", isComposing: true });
    expect(onFreeform).not.toHaveBeenCalled();

    // a normal Enter after composition ends DOES send.
    keydown(ta, { key: "Enter" });
    expect(onFreeform).toHaveBeenCalledWith("ねこ");
    r.unmount();
  });

  it("the Send button click sends freeform", () => {
    const onFreeform = vi.fn();
    const r = render(<ChatInput knownSkills={KNOWN} onSlash={() => {}} onFreeform={onFreeform} />);
    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "hi");
    click(r.get("chat-send"));
    expect(onFreeform).toHaveBeenCalledWith("hi");
    r.unmount();
  });
});
