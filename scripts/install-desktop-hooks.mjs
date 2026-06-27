#!/usr/bin/env node
/**
 * install-desktop-hooks.mjs — idempotent installer that symlinks the four
 * committed POSIX hook shims into the repo's git hooks directory and records
 * this checkout as the primary desktop-refresh binding.
 *
 * Run via: pnpm desktop:hooks:install (never as a postinstall — must not arm CI
 * or every fresh clone).
 *
 * CLI args:
 *   --repo-root <path>  override the repo root resolved via git (for test isolation)
 *
 * Env:
 *   AUTOBROKER_DATA_DIR  data directory override (default: ~/.autobroker-ts)
 */

import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOKS = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];

/** Hardcoded git allowlist — never resolve from $PATH or any user-writable source. */
const GIT_ALLOWLIST = ["/opt/homebrew/bin/git", "/usr/bin/git"];

function resolveGit() {
  for (const g of GIT_ALLOWLIST) {
    try {
      accessSync(g, constants.X_OK);
      return g;
    } catch {
      /* not found/executable — try next */
    }
  }
  throw new Error(`no executable git on allowlist: ${GIT_ALLOWLIST.join(", ")}`);
}

function gitCapture(git, args, cwd) {
  return execFileSync(git, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function expandTilde(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root" && argv[i + 1]) {
      out.repoRoot = argv[++i];
    }
  }
  return out;
}

/**
 * Install hooks into the given repo's git hooks directory. Exported so tests
 * can call it directly or run the installer as a subprocess (both are valid).
 *
 * opts:
 *   repoRoot   — absolute path to the repo root (must be a git work-tree)
 *   dataDir    — absolute path to the data dir (primary.json lands here)
 *   git        — git binary path (defaults to resolveGit())
 */
export async function install(opts = {}) {
  const git = opts.git ?? resolveGit();
  const repoRoot = opts.repoRoot
    ?? (process.env.AUTOBROKER_INSTALL_REPO_ROOT
        ? resolve(process.env.AUTOBROKER_INSTALL_REPO_ROOT)
        : resolve(gitCapture(git, ["rev-parse", "--show-toplevel"], process.cwd())));

  const dataDir = opts.dataDir
    ?? (process.env.AUTOBROKER_DATA_DIR
        ? resolve(expandTilde(process.env.AUTOBROKER_DATA_DIR))
        : join(homedir(), ".autobroker-ts"));

  // Hooks dir: git rev-parse --git-path hooks returns the common hooks dir
  // (worktree-correct: linked worktrees share the primary's hooks dir).
  const hooksRel = gitCapture(git, ["rev-parse", "--git-path", "hooks"], repoRoot);
  const hooksDir = hooksRel.startsWith("/") ? hooksRel : join(repoRoot, hooksRel);
  mkdirSync(hooksDir, { recursive: true });

  const shimDir = join(repoRoot, "scripts", "git-hooks");

  for (const name of HOOKS) {
    const shimPath = join(shimDir, name);
    const hookPath = join(hooksDir, name);

    // Ensure the committed shim is executable.
    chmodSync(shimPath, 0o755);

    // Relative symlink target so the link survives a repo move.
    const relTarget = relative(hooksDir, shimPath);

    // Idempotency: if it already points exactly where we want, leave it.
    let needsLink = true;
    try {
      const st = lstatSync(hookPath);
      if (st.isSymbolicLink()) {
        if (readlinkSync(hookPath) === relTarget) {
          needsLink = false; // already correct
        } else {
          unlinkSync(hookPath); // stale symlink → remove and re-link
        }
      } else {
        // A real file (not a symlink) — back it up before linking.
        renameSync(hookPath, hookPath + ".local.bak");
      }
    } catch {
      /* file absent — proceed to create */
    }

    if (needsLink) {
      symlinkSync(relTarget, hookPath);
    }
  }

  // Record this checkout as the primary desktop-refresh binding. Only the
  // primary checkout warms /Applications; linked worktrees pass primaryBinding
  // only when their toplevel matches this path.
  const primaryRepoPath = gitCapture(git, ["rev-parse", "--show-toplevel"], repoRoot);
  const refreshDir = join(dataDir, "desktop-refresh");
  mkdirSync(refreshDir, { recursive: true });
  writeFileSync(
    join(refreshDir, "primary.json"),
    JSON.stringify({ primaryRepoPath }, null, 2) + "\n",
  );

  console.log(
    "desktop-hooks: installed. The first relevant commit triggers a background desktop build " +
    "(kill switch: AUTOBROKER_DESKTOP_REFRESH=0).",
  );
}

// CLI entry: run only when invoked as main (never on import).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : undefined;
  install({ repoRoot }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
