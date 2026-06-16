/**
 * ChatInput — the Claude-style composer: a rounded box that OWNS the look, a
 * transparent textarea that auto-grows from ONE line to multi-line (capped, then
 * scrolls), and the Send button INTEGRATED inside the box (a round ink glyph).
 *
 * Submit parses the input: a `ready` slash launches that skill direct; non-slash
 * prose launches freeform. A SLASH-PREFIXED input that does NOT resolve to a
 * known skill NEVER falls through to freeform — it renders an inline hint and
 * keeps the text. A `typing` result renders the autocomplete (Tab completes).
 *
 * Two correctness rules baked into the keydown: Enter sends / Shift+Enter inserts
 * a newline, and Enter is IGNORED while an IME composition is active (isComposing
 * / keyCode 229) so CJK candidate-confirm never sends a half-typed message.
 */

import { useEffect, useRef, useState } from "react";

import { SendIcon } from "../shell/icons.js";
import { parseSlashCommand, type SlashResult } from "./slashCommand.js";

export interface ChatInputProps {
  knownSkills: string[];
  disabled?: boolean;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
}

const MAX_HEIGHT = 200;

/** Auto-resize a textarea to its content: reset to auto FIRST (so it can shrink),
 *  then grow to scrollHeight, capping + scrolling past MAX_HEIGHT. */
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  if (el.scrollHeight > MAX_HEIGHT) {
    el.style.height = `${MAX_HEIGHT}px`;
    el.style.overflowY = "auto";
  } else {
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = "hidden";
  }
}

export function ChatInput({ knownSkills, disabled, onSlash, onFreeform }: ChatInputProps): JSX.Element {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const parsed: SlashResult = parseSlashCommand(text, knownSkills);
  const candidates = parsed.kind === "typing" ? parsed.candidates : [];
  const canSend = text.trim() !== "" && disabled !== true;

  // Re-grow on every text change (typing, Tab-complete, AND the post-send clear —
  // it collapses back to one line when text becomes "").
  useEffect(() => {
    if (textareaRef.current !== null) autoGrow(textareaRef.current);
  }, [text]);

  const submit = (): void => {
    if (text.trim() === "") return;
    const r = parseSlashCommand(text, knownSkills);
    if (r.kind === "ready") {
      onSlash(r.skill, r.args, r.note);
    } else if (text.trim().startsWith("/")) {
      const unknown = r.kind === "unknown_skill" ? r.skill : r.kind === "typing" ? r.partial : "";
      setHint(
        `Unknown command /${unknown} — known commands: ${knownSkills.map((s) => `/${s}`).join(", ")}`,
      );
      return;
    } else {
      onFreeform(text);
    }
    setHint(null);
    setText("");
  };

  const complete = (skill: string): void => {
    setHint(null);
    setText(`/${skill} `);
  };

  return (
    <form
      className="composer"
      data-testid="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {hint !== null && (
        <p className="muted slash-unknown-hint" data-testid="slash-unknown-hint" role="alert">
          {hint}
        </p>
      )}
      <div className="composer-anchor">
        {candidates.length > 0 && (
          <ul
            className="card"
            data-testid="slash-autocomplete"
            style={{ position: "absolute", bottom: "100%", left: 0, right: 0, listStyle: "none", padding: 4, margin: "0 0 6px" }}
          >
            {candidates.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  data-testid={`slash-candidate-${c}`}
                  onClick={() => complete(c)}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "none" }}
                >
                  /{c}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="chat-input-textarea"
            rows={1}
            value={text}
            aria-label="Message"
            placeholder="Describe your search, or type /search_profile_intake"
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                if (canSend) submit();
              } else if (e.key === "Tab" && candidates.length > 0) {
                e.preventDefault();
                complete(candidates[0]!);
              }
            }}
          />
          <button
            type="submit"
            className="composer-send"
            aria-label="Send message"
            data-testid="chat-send"
            disabled={!canSend}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </form>
  );
}
