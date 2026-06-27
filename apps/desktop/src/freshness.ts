/**
 * freshness.ts — deterministic build-stamp for the desktop runtime source.
 *
 * Computes two stamps that together identify whether a cached desktop bundle
 * is still current: a SOURCE stamp (a git tree hash covering all runtime-source
 * paths) and a FRAMEWORK stamp (a hash of native-dep versions + builder configs).
 * A difference in either means the bundle must be rebuilt.
 *
 * Bias: a FALSE-NEGATIVE (real change that does not move the stamp → silently
 * runs stale code) is catastrophic; a FALSE-POSITIVE (irrelevant change → a
 * needless rebuild) costs only seconds. Every ambiguous path therefore throws
 * ForceRebuild — callers rebuild rather than run stale code.
 *
 * Imports: node built-ins only — node:child_process, node:crypto, node:fs,
 * node:module, node:path, node:os. No cross-package imports (layer rule,
 * apps/desktop = L5).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Git's canonical hash for an empty tree. A write-tree that returns this has
 *  produced no content and must never be used as a freshness stamp. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when any ambiguity or error prevents a reliable freshness check.
 *  Callers treat this as "must rebuild" — the safe direction. */
export class ForceRebuild extends Error {
  constructor(msg = "force rebuild") {
    super(msg);
    this.name = "ForceRebuild";
  }
}

/** Thrown when no executable git binary is found on the fixed allowlist. */
export class GitUnavailable extends Error {
  constructor(msg = "git not found on allowlist") {
    super(msg);
    this.name = "GitUnavailable";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The working-tree state stamp for the desktop runtime sources. */
export type SourceStamp = { state: "in-progress" } | { state: "ok"; source: string };

/** The combined stamp consumed by both the refresh script and the launch check. */
export type BuiltStamp =
  | { state: "in-progress" }
  | { state: "ok"; source: string; frameworkStamp: string; builtStamp: string };

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Hardcoded allowlist of git binary paths. NOT read from $PATH or any
 *  user-writable file — only these fixed system locations are trusted. */
const GIT_ALLOWLIST = ["/opt/homebrew/bin/git", "/usr/bin/git"] as const;

/** All workspace packages and top-level config files that affect the desktop
 *  runtime. Over-inclusive on purpose — test/doc/e2e entries are stripped by
 *  the exclude pathspecs. Any root that does not exist on disk is filtered out
 *  before the git add so the command never gets a pathspec error. */
const DEFAULT_ROOTS = [
  "apps/server",
  "apps/ui",
  "apps/desktop",
  "packages/core",
  "packages/model",
  "packages/workflows",
  "packages/tools",
  "packages/db",
  "packages/skills",
  "pnpm-lock.yaml",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
];

/** Magic pathspec excludes — files that must NOT affect the stamp even when
 *  they sit inside a watched root.  Test files, spec files, markdown docs,
 *  and dedicated test/e2e/harness dirs are excluded here. Build artifacts
 *  (dist/, node_modules/, *.tsbuildinfo) are already excluded by .gitignore
 *  and therefore by the git-add step itself. */
const DEFAULT_EXCLUDES = [
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/*.spec.*",
  ":(exclude,glob)**/*.test-d.ts",
  ":(exclude,glob)**/__tests__/**",
  ":(exclude,glob)**/*.md",
  ":(exclude,glob)apps/desktop/smoke/**",
  ":(exclude,glob)apps/ui/e2e/**",
  ":(exclude,glob)harness/**",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** sha256 hex of a string or Buffer. */
function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Spawn git and return trimmed stdout (encoding utf8).
 *  Any non-zero exit or ENOENT → throws ForceRebuild. */
function runGit(
  git: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
  try {
    return execFileSync(git, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch {
    throw new ForceRebuild(`git ${args[0] ?? "(unknown)"} failed`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the first executable git binary from the hardcoded allowlist.
 * Any caller-supplied candidates are tried first; the allowlist follows.
 * Throws GitUnavailable if no candidate is executable.
 */
export function resolveGit(extraCandidates?: string[]): string {
  const candidates = [...(extraCandidates ?? []), ...GIT_ALLOWLIST];
  for (const c of candidates) {
    try {
      // Probe the execute bit, not mere existence: a present-but-non-executable
      // candidate (e.g. a directory or a file without +x) is skipped.
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // not executable / not present — try the next candidate
    }
  }
  throw new GitUnavailable(`no executable git found; tried: ${candidates.join(", ")}`);
}

/**
 * Computes a tree-hash stamp covering all desktop runtime sources.
 *
 * Returns {state:"in-progress"} when a rebase/merge/cherry-pick is active
 * (both consumers back off during mid-operation tree states).
 *
 * Returns {state:"ok", source:<40-hex>} on success.
 *
 * Throws ForceRebuild on any git error, empty filtered-root list, or a
 * write-tree result equal to the empty-tree sentinel.
 *
 * Uses GIT_INDEX_FILE to populate a throwaway temp index — the real git
 * index is never touched. Gitignored paths (dist/, node_modules/, build
 * artifacts) drop out automatically because git add -A respects .gitignore.
 * git diff is intentionally NOT used here: it misses new untracked runtime
 * files that a real content change would introduce.
 */
export function computeSourceStamp(
  repoRoot: string,
  opts?: { git?: string; roots?: string[]; excludes?: string[] },
): SourceStamp {
  const git = opts?.git ?? resolveGit();
  const roots = opts?.roots ?? DEFAULT_ROOTS;
  const excludes = opts?.excludes ?? DEFAULT_EXCLUDES;

  // Resolve the .git directory so we can probe for in-progress markers.
  const gitDirRaw = runGit(git, ["-C", repoRoot, "rev-parse", "--git-dir"], { cwd: repoRoot });
  const gitDir = gitDirRaw.startsWith("/") ? gitDirRaw : join(repoRoot, gitDirRaw);

  // Return early when any in-progress operation is active.
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (existsSync(join(gitDir, marker))) {
      return { state: "in-progress" };
    }
  }

  // Filter roots to those that actually exist on disk.
  const existingRoots = roots.filter((r) => existsSync(join(repoRoot, r)));
  if (existingRoots.length === 0) {
    throw new ForceRebuild("no source roots exist — cannot compute a reliable stamp");
  }

  // Write a temp index (non-existent path so git starts from empty), run
  // git add -A over the filtered roots, remove excluded files, then write-tree
  // to produce a deterministic tree hash. Delete the temp dir afterward.
  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "autobroker-freshness-"));
    const tmpIndex = join(tmpDir, "index");
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    // Step 1: populate the temp index with all files in the filtered roots.
    // Excludes MUST be applied separately (step 2), NOT folded into this add.
    // Passing :(exclude,glob) pathspecs to `git add -A` against an empty index
    // silently produces the empty-tree SHA — reproduced on multiple git
    // versions, so this is a property of the single-pass shape itself, not a
    // bug in one release. The two-step (add roots, then rm --cached the
    // excludes) is therefore REQUIRED unconditionally — do not "simplify" it
    // back to a single add with exclude pathspecs on a newer git.
    runGit(git, ["-C", repoRoot, "add", "-A", "--", ...existingRoots], { cwd: repoRoot, env });

    // Step 2: remove excluded files from the temp index. Convert each
    // :(exclude,glob)... or :(exclude)... pattern to :(glob)... so git rm
    // --cached can match them. --ignore-unmatch prevents errors when a
    // pattern matches nothing (e.g. no *.md files in a small test fixture).
    if (excludes.length > 0) {
      const rmPatterns = excludes.map((e) => {
        if (e.startsWith(":(exclude,glob)")) return ":(glob)" + e.slice(":(exclude,glob)".length);
        if (e.startsWith(":(exclude)")) return ":(glob)" + e.slice(":(exclude)".length);
        return e;
      });
      runGit(
        git,
        ["-C", repoRoot, "rm", "--cached", "--ignore-unmatch", "-q", "--", ...rmPatterns],
        { cwd: repoRoot, env },
      );
    }

    const tree = runGit(git, ["-C", repoRoot, "write-tree"], { cwd: repoRoot, env });

    if (!/^[0-9a-f]{40}$/.test(tree) || tree === EMPTY_TREE) {
      throw new ForceRebuild(`write-tree returned unusable SHA: ${tree}`);
    }

    return { state: "ok", source: tree };
  } finally {
    if (tmpDir !== undefined) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Framework stamp helpers
// ---------------------------------------------------------------------------

/** Read and return the `version` field of a package.json on disk. */
function readVersion(pkgJsonPath: string): string {
  const pj = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
  const v = String(pj.version ?? "");
  if (!v) throw new ForceRebuild(`no version in ${pkgJsonPath}`);
  return v;
}

/**
 * Resolve the installed version of the LAST dep in `chain`, resolving each hop
 * relative to the previous package's own dir. Each hop uses node module
 * resolution (createRequire) so it follows pnpm's symlinked store correctly —
 * a hand-rolled node_modules walk-up misses pnpm's nested/symlinked deps.
 * Resolves a dep's entry file, then walks up to the package.json whose `name`
 * matches the dep (some packages do not export ./package.json).
 */
function chainVersion(fromPkgDir: string, chain: [string, ...string[]]): string {
  let pkgDir = fromPkgDir;
  let version = "";
  for (const dep of chain) {
    const req = createRequire(join(pkgDir, "package.json"));
    let dir = dirname(req.resolve(dep));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pj = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pj.name === dep) {
          version = String(pj.version ?? "");
          pkgDir = dir;
          break;
        }
      }
      if (dir === dirname(dir)) throw new ForceRebuild(`package root for ${dep} not found`);
      dir = dirname(dir);
    }
  }
  if (!version) throw new ForceRebuild(`no version resolved for ${chain[chain.length - 1]}`);
  return version;
}

// ---------------------------------------------------------------------------
// Public API (continued)
// ---------------------------------------------------------------------------

/**
 * sha256 of build-shape inputs that determine HOT vs COLD: the resolved
 * Electron version, sha256 of electron-builder.yml + bundle.mjs, and the
 * resolved installed versions of better-sqlite3, libsql, and playwright.
 *
 * Throws ForceRebuild if any input cannot be resolved.
 */
export function computeFrameworkStamp(repoRoot: string): string {
  try {
    const desktopDir = join(repoRoot, "apps", "desktop");

    // Electron version: resolve apps/desktop's installed electron/package.json
    // through node module resolution, then read .version.
    const desktopRequire = createRequire(join(desktopDir, "package.json"));
    const electronVersion = readVersion(desktopRequire.resolve("electron/package.json"));
    const builderYml = readFileSync(join(desktopDir, "electron-builder.yml"));
    const bundleMjs = readFileSync(join(desktopDir, "scripts", "bundle.mjs"));

    const bsqliteVersion = chainVersion(join(repoRoot, "packages", "db"), ["better-sqlite3"]);
    const libsqlVersion = chainVersion(join(repoRoot, "packages", "workflows"), [
      "@mastra/libsql",
      "@libsql/client",
      "libsql",
    ]);
    const playwrightVersion = chainVersion(join(repoRoot, "packages", "tools"), ["playwright"]);

    return sha256(
      [
        electronVersion,
        sha256(builderYml),
        sha256(bundleMjs),
        bsqliteVersion,
        libsqlVersion,
        playwrightVersion,
      ].join("\n"),
    );
  } catch (err) {
    if (err instanceof ForceRebuild) throw err;
    throw new ForceRebuild(`computeFrameworkStamp: ${String(err)}`);
  }
}

/**
 * Convenience entry point for both consumers.
 *
 * Resolves git (if not supplied), computes the source stamp and framework
 * stamp, then folds them into builtStamp = sha256(frameworkStamp + "\n" +
 * source). Returns {state:"in-progress"} when a git operation is mid-flight.
 *
 * Throws ForceRebuild or GitUnavailable on any unresolvable error.
 * Callers: the refresh script treats a throw as "rebuild"; the launch check
 * wraps this in try/catch and treats a throw as "launch the installed build
 * anyway".
 */
export function computeBuiltStamp(repoRoot: string, opts?: { git?: string }): BuiltStamp {
  const git = opts?.git ?? resolveGit();
  const sourceStamp = computeSourceStamp(repoRoot, { git });
  if (sourceStamp.state === "in-progress") {
    return { state: "in-progress" };
  }
  const frameworkStamp = computeFrameworkStamp(repoRoot);
  const builtStamp = sha256(frameworkStamp + "\n" + sourceStamp.source);
  return { state: "ok", source: sourceStamp.source, frameworkStamp, builtStamp };
}
