#!/usr/bin/env bash
# =============================================================================
# Sandbox e2e for sync-daily.sh step 3 (auto-commit + push of the daily report).
#
# Builds faithful sibling sandboxes (AutoBroker / AutoBroker-dev-plan), copies the
# REAL hook in, and runs it. Asserts the adversarial-hardened guarantees:
#   c1 narrow-staged commit + push (only $TODAY.html + index.html)
#   c2 isolation (an unrelated dirty plan-repo file is NOT swept in)
#   c3 idempotent (a second run with identical inputs makes no commit)
#   c4 non-main skip (plan repo not on main -> zero commits)
#   c5 push-failure non-fatal (bad remote -> hook exits 0, local commit survives)
#   c6 empty-PLAN_REPO safety (plan repo absent -> code repo untouched, exit 0)
#
# No network, no real repos touched (everything under one mktemp dir). macOS ok.
# Run: bash .claude/hooks/sync-daily.test.sh
# =============================================================================
set -uo pipefail

HOOK_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-daily.sh"
TODAY="$(date +%Y-%m-%d)"
FAILS=0
pass(){ printf '  PASS: %s\n' "$1"; }
fail(){ printf '  FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

[ -f "$HOOK_SRC" ] || { echo "FATAL: hook not found: $HOOK_SRC" >&2; exit 2; }

ROOT_TMP="$(mktemp -d)"
trap 'rm -rf "$ROOT_TMP"' EXIT

# Build a fresh sandbox; echo its parent dir. Layout under <parent>:
#   AutoBroker (code repo, 1 commit today, real hook), AutoBroker-dev-plan (plan
#   repo, stub new-day.sh, main + bare origin), plan-remote.git (bare).
make_sandbox(){
  local p code plan remote
  p="$(mktemp -d "$ROOT_TMP/sbx.XXXXXX")"
  code="$p/AutoBroker"; plan="$p/AutoBroker-dev-plan"; remote="$p/plan-remote.git"

  mkdir -p "$code/.claude/hooks"
  git -C "$code" init -q -b main
  git -C "$code" config user.email t@t; git -C "$code" config user.name t
  echo x > "$code/f"; git -C "$code" add f
  git -C "$code" commit -q -m "phase0/x: seed today"
  cp "$HOOK_SRC" "$code/.claude/hooks/sync-daily.sh"
  # deliberately NO package.json in $code -> hook step-1 pnpm export is skipped

  mkdir -p "$plan/tools" "$plan/daily"
  cat > "$plan/tools/new-day.sh" <<'STUB'
#!/usr/bin/env bash
# stub new-day.sh: deterministically write a dated report + index into the plan
# repo (no LLM, no real generation — just the two files the hook stages).
set -uo pipefail
DATE="$1"
PLAN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
printf '<html>daily report %s</html>\n' "$DATE" > "$PLAN_ROOT/daily/$DATE.html"
printf '<html>rolling index</html>\n' > "$PLAN_ROOT/daily/index.html"
exit 0
STUB
  chmod +x "$plan/tools/new-day.sh"
  git -C "$plan" init -q -b main
  git -C "$plan" config user.email t@t; git -C "$plan" config user.name t
  git -C "$plan" add -A; git -C "$plan" commit -q -m "seed"
  git init -q --bare "$remote"
  git -C "$plan" remote add origin "$remote"
  git -C "$plan" push -q -u origin main

  echo "$p"
}

# run the REAL hook with cwd + CLAUDE_PROJECT_DIR = the sandbox code repo.
run_hook(){ ( cd "$1" && CLAUDE_PROJECT_DIR="$1" bash .claude/hooks/sync-daily.sh ); }

# ---- c1: narrow-staged commit + push ---------------------------------------
echo "c1 narrow-staged commit + push"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
run_hook "$code"; rc=$?
[ "$rc" = 0 ] && pass "exit 0" || fail "exit $rc"
subj="$(git -C "$plan" log -1 --pretty=%s 2>/dev/null)"
[ "$subj" = "docs(daily): auto-sync $TODAY" ] && pass "commit subject" || fail "subject: '$subj'"
files="$(git -C "$plan" diff-tree --no-commit-id --name-only -r HEAD | sort | tr '\n' ',')"
exp="daily/$TODAY.html,daily/index.html,"
[ "$files" = "$exp" ] && pass "only 2 daily files staged" || fail "files: '$files'"
[ "$(git -C "$plan" rev-parse HEAD)" = "$(git -C "$plan" rev-parse origin/main 2>/dev/null)" ] \
  && pass "pushed to remote" || fail "remote not advanced"

# ---- c2: isolation (an unrelated STAGED file is NOT swept into the commit) ---
# The load-bearing guarantee is that `commit -- <pathspec>` is a PARTIAL commit
# that excludes anything else already staged in the index. Pre-stage other.txt so
# this exercises that path (not just the weaker untracked-file case).
echo "c2 isolation"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
echo junk > "$plan/other.txt"
git -C "$plan" add other.txt
run_hook "$code" >/dev/null 2>&1
intree="$(git -C "$plan" diff-tree --no-commit-id --name-only -r HEAD | grep -c 'other.txt' || true)"
[ "$intree" = 0 ] && pass "other.txt excluded from the auto-sync commit" || fail "other.txt leaked into commit"
st="$(git -C "$plan" status --porcelain -- other.txt)"
case "$st" in
  'A '*) pass "other.txt still staged + uncommitted (partial commit isolated it)";;
  *)     fail "other.txt status: '$st'";;
esac

# ---- c3: idempotent (no second commit on identical inputs) ------------------
echo "c3 idempotent"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
run_hook "$code" >/dev/null 2>&1
n1="$(git -C "$plan" rev-list --count HEAD)"
run_hook "$code" >/dev/null 2>&1
n2="$(git -C "$plan" rev-list --count HEAD)"
[ "$n1" = "$n2" ] && pass "no 2nd commit (count stays $n2)" || fail "count $n1 -> $n2"

# ---- c4: non-main skip ------------------------------------------------------
echo "c4 non-main skip"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
git -C "$plan" checkout -q -b feature
n0="$(git -C "$plan" rev-list --count HEAD)"
run_hook "$code" >/dev/null 2>&1; rc=$?
n1="$(git -C "$plan" rev-list --count HEAD)"
[ "$rc" = 0 ] && pass "exit 0" || fail "exit $rc"
[ "$n0" = "$n1" ] && pass "no commit on non-main branch" || fail "count $n0 -> $n1"

# ---- c5: push-failure non-fatal --------------------------------------------
echo "c5 push-failure non-fatal"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
git -C "$plan" remote set-url origin "$P/does-not-exist.git"
n0="$(git -C "$plan" rev-list --count HEAD)"
run_hook "$code" >/dev/null 2>&1; rc=$?
n1="$(git -C "$plan" rev-list --count HEAD)"
[ "$rc" = 0 ] && pass "exit 0 despite push failure" || fail "exit $rc"
[ "$n1" -gt "$n0" ] && pass "local commit survived ($n0 -> $n1)" || fail "no local commit: $n0 -> $n1"

# ---- c6: plan-repo-absent safety -------------------------------------------
# With the plan repo gone, PLAN_NEWDAY no longer resolves, so the step-2 guard
# ([ -x "$PLAN_NEWDAY" ]) is false and the whole step-2 block (including the
# nested step 3) is skipped. Proves the hook makes NO stray commit on the code
# repo and still exits 0 when the plan repo can't be found.
echo "c6 plan-repo-absent safety"
P="$(make_sandbox)"; code="$P/AutoBroker"; plan="$P/AutoBroker-dev-plan"
cn0="$(git -C "$code" rev-list --count HEAD)"
mv "$plan" "$P/AutoBroker-dev-plan-moved"
run_hook "$code" >/dev/null 2>&1; rc=$?
cn1="$(git -C "$code" rev-list --count HEAD)"
[ "$rc" = 0 ] && pass "exit 0 when plan repo absent" || fail "exit $rc"
[ "$cn0" = "$cn1" ] && pass "code repo untouched (no stray commit)" || fail "code commits $cn0 -> $cn1"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
