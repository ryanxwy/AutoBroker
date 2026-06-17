#!/usr/bin/env python3
"""PostToolUse(Edit|Write|MultiEdit) hook — fast, advisory typecheck of the
workspace package that was just edited, so type errors surface in-loop instead
of waiting for the Stop-hook / green.sh full `tsc --build`.

Non-blocking by intent: the edit already applied. On a clean typecheck it is
silent (exit 0); on type errors it feeds the tsc output back to Claude as
feedback (exit 2) so the next step is a fix. Any failure to run (parse error,
non-source file, missing tooling, timeout) is a silent exit 0 — never nag
spuriously.

Scope: only .ts/.tsx files under packages/<x>, apps/<x>, or harness/. Uses
`tsc --build <pkg>/tsconfig.json` (every package is composite, so the upstream
deps in the five-layer wall are built incrementally first); harness/ is standalone
and not on the project-reference graph, so it uses its own `typecheck` script.
dist/ + *.tsbuildinfo are gitignored, so the emit is a throwaway build artifact.

Cost note: the FIRST run after a clean checkout builds the dependency closure
(slower); every subsequent edit is incremental (seconds). To turn this hook off
for a heavy session, remove its PostToolUse entry from .claude/settings.json.
"""
import json
import os
import re
import subprocess
import sys

WS = re.compile(r"(?:^|/)((?:packages|apps)/[^/]+|harness)(?:/|$)")


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    path = (data.get("tool_input") or {}).get("file_path", "") or ""
    if not path.endswith((".ts", ".tsx")):
        sys.exit(0)

    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        rel = os.path.relpath(path, root)
    except Exception:
        sys.exit(0)
    m = WS.search(rel)
    if not m:
        sys.exit(0)  # edited file is outside the typechecked workspace
    pkg_dir = m.group(1)

    if pkg_dir == "harness":
        cmd = ["pnpm", "--filter", "@autobroker/harness", "run", "typecheck"]
    else:
        cmd = ["pnpm", "exec", "tsc", "--build", f"{pkg_dir}/tsconfig.json"]

    try:
        proc = subprocess.run(
            cmd, cwd=root, capture_output=True, text=True, timeout=180
        )
    except Exception:
        sys.exit(0)  # tooling missing / timeout — stay quiet, fail-safe

    if proc.returncode == 0:
        sys.exit(0)

    out = (proc.stdout + proc.stderr).strip().splitlines()
    tail = "\n".join(out[-60:])
    sys.stderr.write(
        f"typecheck-edited-package: `{pkg_dir}` has type errors after this edit "
        f"(advisory — the edit applied). Fix before the gate:\n\n{tail}\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
