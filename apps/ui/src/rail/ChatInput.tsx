/**
 * ChatInput — compose + slash parse + autocomplete. On
 * submit it parses the input: a `ready` slash result launches that skill direct;
 * non-slash prose launches freeform. A SLASH-PREFIXED input that does NOT
 * resolve to a known skill (unknown_skill / still-typing) NEVER falls through
 * to freeform (which would route it into intake) — it renders an inline hint
 * and keeps the text for correction. A `typing` result renders the up-to-8
 * skill autocomplete dropdown (Tab completes the first candidate). The parent
 * owns the actual launch (onSlash / onFreeform).
 */

import { useState } from "react";

import { parseSlashCommand, type SlashResult } from "./slashCommand.js";

export interface ChatInputProps {
  knownSkills: string[];
  disabled?: boolean;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
}

export function ChatInput({ knownSkills, disabled, onSlash, onFreeform }: ChatInputProps): JSX.Element {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const parsed: SlashResult = parseSlashCommand(text, knownSkills);
  const candidates = parsed.kind === "typing" ? parsed.candidates : [];

  const submit = (): void => {
    if (text.trim() === "") return;
    const r = parseSlashCommand(text, knownSkills);
    if (r.kind === "ready") {
      onSlash(r.skill, r.args, r.note);
    } else if (text.trim().startsWith("/")) {
      // An unresolved slash never becomes freeform→intake — hint and keep the
      // text so the user can fix the command.
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
    <div className="chat-input" data-testid="chat-input">
      <div style={{ flex: 1, position: "relative" }}>
        {hint !== null && (
          <p className="muted" data-testid="slash-unknown-hint" role="alert" style={{ margin: "0 0 4px" }}>
            {hint}
          </p>
        )}
        <textarea
          data-testid="chat-input-textarea"
          rows={2}
          value={text}
          placeholder="Describe your search, or type /search_profile_intake"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Tab" && candidates.length > 0) {
              e.preventDefault();
              complete(candidates[0]!);
            }
          }}
        />
        {candidates.length > 0 && (
          <ul className="card" data-testid="slash-autocomplete" style={{ position: "absolute", bottom: "100%", left: 0, right: 0, listStyle: "none", padding: 4, margin: 0 }}>
            {candidates.map((c) => (
              <li key={c}>
                <button type="button" data-testid={`slash-candidate-${c}`} onClick={() => complete(c)} style={{ width: "100%", textAlign: "left", border: "none", background: "none" }}>
                  /{c}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="btn-primary" data-testid="chat-send" disabled={disabled} onClick={submit}>
        Send
      </button>
    </div>
  );
}
