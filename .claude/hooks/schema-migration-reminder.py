#!/usr/bin/env python3
"""PostToolUse(Edit|Write|MultiEdit) hook — advisory reminder to regenerate +
re-check the Drizzle migration when an edit touches the product schema.

WHY: the product schema source of truth is `packages/db/src/schema.ts`; migrations
are GENERATED with `pnpm db:generate` and the `pnpm db:check` empty-diff gate fails
until the new `packages/db/drizzle/NNNN_*.sql` (+ journal) is committed/staged. A
schema edit with no regenerated, staged migration passes a focused test yet goes
gate/CI-RED (a documented recurring trap). This nudges the in-loop fix to run
`pnpm db:generate` and confirm an empty `pnpm db:check` before pushing.

Non-blocking by intent (the edit already applied): exit 2 feeds a one-line advisory
back to Claude; exit 0 is silent. Throttled to at most once per 10 minutes via a temp
stamp so a burst of schema edits does not nag every keystroke. Any failure to run is a
silent exit 0 — never nag spuriously.
"""
import json
import os
import sys
import tempfile
import time

THROTTLE_SECONDS = 600
STAMP = os.path.join(tempfile.gettempdir(), "autobroker-schema-migration-reminder.stamp")


def is_relevant(path: str) -> bool:
    p = path.replace("\\", "/")
    # The product-schema source of truth (a change here needs a generated migration).
    return p.endswith("/packages/db/src/schema.ts") or p.endswith(
        "/packages/db/src/testRunRecords.ts"
    )


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    ti = data.get("tool_input") or {}
    path = ti.get("file_path", "") or ""
    if not is_relevant(path):
        sys.exit(0)

    # Throttle: stay silent if we already reminded within the window.
    try:
        if os.path.exists(STAMP) and (time.time() - os.path.getmtime(STAMP)) < THROTTLE_SECONDS:
            sys.exit(0)
    except Exception:
        pass
    try:
        open(STAMP, "w").close()
    except Exception:
        pass

    sys.stderr.write(
        "schema-migration-reminder: this edit changed the Drizzle product schema. "
        "Before pushing, run `pnpm db:generate` and confirm an empty `pnpm db:check` "
        "diff (stage the new packages/db/drizzle/NNNN_*.sql + journal). The "
        "drizzle-migration-reviewer agent covers the deeper traps — stale "
        "MIGRATION_SQLS test arrays, COALESCE ratchets (advisory).\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
