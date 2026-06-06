/**
 * toml — a minimal, focused TOML parser scoped to the harness case-file grammar
 * (the case-TOML schema in cases.ts). It is deliberately NOT a full TOML 1.0 implementation:
 * it supports exactly the constructs the case schema uses — table headers
 * `[a.b]`, array-of-table headers `[[a.b]]`, key = value where value is a string,
 * integer, float, boolean, or a single-line array of those scalars, plus `#`
 * comments and blank lines. This keeps harness/ DEPENDENCY-FREE (no toml lib in
 * node_modules; same spirit as the hand-rolled apps/ui/e2e runner) and avoids a
 * network install during offline runs.
 *
 * Anything outside that grammar (multi-line arrays, inline tables, dotted keys,
 * datetimes) FAILS LOUD with a line number — better a clear parse error than a
 * silently mis-read case. If a richer case grammar is later needed, swap this for
 * a vetted toml dependency; the parse boundary is this one function.
 */

export type TomlValue = string | number | boolean | null | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

class TomlParseError extends Error {
  constructor(line: number, message: string) {
    super(`TOML parse error (line ${line}): ${message}`);
    this.name = "TomlParseError";
  }
}

/** Parse one scalar / single-line-array value. */
function parseValue(raw: string, line: number): TomlValue {
  const v = raw.trim();
  if (v.length === 0) throw new TomlParseError(line, "empty value");

  // Array of scalars: [ a, b, c ] on a single line.
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) {
      throw new TomlParseError(line, "multi-line arrays are not supported in the case grammar");
    }
    const inner = v.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitTopLevel(inner, line).map((part) => parseValue(part, line));
  }

  // Inline table: not supported (the case grammar uses [table] / [[table]] headers).
  if (v.startsWith("{")) {
    throw new TomlParseError(line, "inline tables are not supported in the case grammar");
  }

  // String (double-quoted; supports \" and \\ escapes).
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new TomlParseError(line, "unterminated string");
    return unescapeString(v.slice(1, -1), line);
  }
  // Single-quoted (literal) string.
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new TomlParseError(line, "unterminated literal string");
    return v.slice(1, -1);
  }

  // Booleans.
  if (v === "true") return true;
  if (v === "false") return false;

  // Null — NOT standard TOML, but the case grammar uses bare `null` for the
  // nullable intake optional fields (the strict schema needs the key present with
  // an explicit null; a TOML-omitted key would be absent, not null).
  if (v === "null") return null;

  // Integer / float.
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[+-]?(\d+\.\d+|\d+(\.\d+)?[eE][+-]?\d+)$/.test(v)) return Number.parseFloat(v);

  throw new TomlParseError(line, `unrecognized value: ${raw}`);
}

/** Split a comma-separated list respecting quoted strings (no nested arrays). */
function splitTopLevel(s: string, line: number): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inStr) {
      cur += ch;
      if (ch === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      throw new TomlParseError(line, "nested arrays/tables are not supported in the case grammar");
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

function unescapeString(s: string, line: number): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === "\\") {
      const next = s[i + 1];
      i += 1;
      switch (next) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        default:
          throw new TomlParseError(line, `unsupported escape \\${next ?? ""}`);
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip a trailing `# comment` that is OUTSIDE any quoted string. */
function stripComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === inStr && line[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Navigate/create a nested table path (e.g. ["narrative", "profile"]). */
function ensureTable(root: TomlTable, path: string[], line: number): TomlTable {
  let cur: TomlTable = root;
  for (const key of path) {
    const existing = cur[key];
    if (existing === undefined) {
      const next: TomlTable = {};
      cur[key] = next;
      cur = next;
    } else if (Array.isArray(existing)) {
      // Array-of-tables: descend into the LAST element.
      const last = existing[existing.length - 1];
      if (last === undefined || last === null || typeof last !== "object" || Array.isArray(last)) {
        throw new TomlParseError(line, `cannot descend into non-table array at "${key}"`);
      }
      cur = last;
    } else if (existing !== null && typeof existing === "object") {
      cur = existing as TomlTable;
    } else {
      throw new TomlParseError(line, `key "${key}" is a scalar, not a table`);
    }
  }
  return cur;
}

/**
 * Parse TOML source into a nested JS object. Throws TomlParseError with a line
 * number on any unsupported/malformed construct (fail LOUD).
 */
export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  // The table the current key=value lines write into; starts at root.
  let context: TomlTable = root;
  const lines = source.split(/\r?\n/);

  for (let n = 0; n < lines.length; n += 1) {
    const lineNo = n + 1;
    const stripped = stripComment(lines[n]!).trim();
    if (stripped.length === 0) continue;

    // Array-of-table header: [[a.b]].
    if (stripped.startsWith("[[")) {
      if (!stripped.endsWith("]]")) throw new TomlParseError(lineNo, "malformed [[array-of-table]] header");
      const path = stripped.slice(2, -2).trim().split(".").map((p) => p.trim());
      const parentPath = path.slice(0, -1);
      const key = path[path.length - 1]!;
      const parent = ensureTable(root, parentPath, lineNo);
      const arr = parent[key];
      const elem: TomlTable = {};
      if (arr === undefined) {
        parent[key] = [elem];
      } else if (Array.isArray(arr)) {
        arr.push(elem);
      } else {
        throw new TomlParseError(lineNo, `key "${key}" is not an array-of-tables`);
      }
      context = elem;
      continue;
    }

    // Table header: [a.b].
    if (stripped.startsWith("[")) {
      if (!stripped.endsWith("]")) throw new TomlParseError(lineNo, "malformed [table] header");
      const path = stripped.slice(1, -1).trim().split(".").map((p) => p.trim());
      context = ensureTable(root, path, lineNo);
      continue;
    }

    // key = value.
    const eq = stripped.indexOf("=");
    if (eq === -1) throw new TomlParseError(lineNo, `expected key = value, got: ${stripped}`);
    const key = stripped.slice(0, eq).trim();
    if (key.length === 0) throw new TomlParseError(lineNo, "empty key");
    if (/[.[\]]/.test(key)) throw new TomlParseError(lineNo, `dotted/bracketed keys not supported: "${key}"`);
    const value = parseValue(stripped.slice(eq + 1), lineNo);
    context[key] = value;
  }

  return root;
}
