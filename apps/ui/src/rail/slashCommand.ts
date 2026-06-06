/**
 * slashCommand — the pure slash parser. Syntax:
 * "/" skill args? prose?, key=value coerced to args, trailing prose → note.
 * Returns a discriminated union the ChatInput dispatches on: only `ready` runs a
 * slash launch; everything else (typing/unknown/non-slash) → freeform launch.
 * `typing` carries up to 8 candidate skill names for the autocomplete dropdown.
 */

export type SlashResult =
  | { kind: "empty" }
  | { kind: "non_slash"; text: string }
  | { kind: "typing"; partial: string; candidates: string[] }
  | { kind: "ready"; skill: string; args: Record<string, string>; note?: string }
  | { kind: "unknown_skill"; skill: string };

const MAX_CANDIDATES = 8;

export function parseSlashCommand(input: string, knownSkills: string[]): SlashResult {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "non_slash", text: input };

  const body = trimmed.slice(1);
  const tokens = body.split(/\s+/).filter(Boolean);
  const skill = tokens[0] ?? "";

  // Still typing the skill name (no trailing space yet) → autocomplete.
  const hasTrailingSpace = /\s$/.test(input) || tokens.length > 1;
  if (!hasTrailingSpace) {
    const candidates = knownSkills.filter((s) => s.startsWith(skill)).slice(0, MAX_CANDIDATES);
    if (candidates.length === 1 && candidates[0] === skill) {
      return { kind: "ready", skill, args: {} };
    }
    return { kind: "typing", partial: skill, candidates };
  }

  if (!knownSkills.includes(skill)) {
    return { kind: "unknown_skill", skill };
  }

  // Parse the rest: key=value pairs → args; remaining words → note.
  const args: Record<string, string> = {};
  const noteWords: string[] = [];
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq > 0) {
      args[tok.slice(0, eq)] = tok.slice(eq + 1);
    } else {
      noteWords.push(tok);
    }
  }
  const note = noteWords.join(" ").trim();
  return note === "" ? { kind: "ready", skill, args } : { kind: "ready", skill, args, note };
}
