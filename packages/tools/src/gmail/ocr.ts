/**
 * Image OCR — macOS Vision text recognition for an attachment image buffer.
 *
 * SCOPE: this runs the platform's on-device Vision OCR over a single image
 * (png/jpg/etc.) and returns the recognized text. It is the IMAGE path's text
 * source — PDFs are NEVER routed here (a text-less PDF is an honest failure, not
 * an OCR target; see attachmentText.ts).
 *
 * PLATFORM: Vision OCR is darwin-only. Off macOS the runner degrades GRACEFULLY
 * — it returns a typed `{ ok: false, reason: "unavailable" }` and NEVER throws,
 * NEVER calls the network, NEVER touches an LLM or an API key. The caller marks
 * the message as failed-no-text and moves on.
 *
 * MECHANISM: we shell out to a small local helper (`autobroker attachment ocr
 * <imagePath>`) that wraps the macOS Vision framework and prints the recognized
 * text to stdout. The image bytes are staged to a private temp file (0600),
 * passed by path, and unlinked afterwards. The helper binary is a local,
 * on-device process — no remote call. If the helper is absent or errors, the
 * runner returns a typed failure rather than throwing.
 *
 * FALLBACK CLASSIFICATION: OCR is the equivalent/transient fallback for an image
 * whose text could not be read by a richer path (native vision lives in the
 * model layer, not here). It is auto-allowed, never a suspend — but it must be
 * voiced, so a successful OCR carries a trace span the caller can render. A pure
 * tools-layer runner has no emitter, so it RETURNS the span in its result.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

/** The local Vision helper command. It takes one image path and prints the
 *  recognized text to stdout. Overridable for tests via the runner option. */
const OCR_HELPER = "autobroker";
const OCR_HELPER_ARGS = ["attachment", "ocr"] as const;

/** Max time to wait for the on-device OCR helper before giving up (failed, no
 *  retry). On-device Vision is fast; a long wait means the helper is wedged. */
const OCR_TIMEOUT_MS = 30_000;

/** The trace span a successful image OCR records so the caller can voice the
 *  transient/equivalent fallback (image had no text layer → OCR'd on-device). */
export interface OcrFallbackSpan {
  kind: "image_ocr_vision";
  detail: string;
}

/** The typed OCR outcome. `ok:true` → recognized `text` (may be empty when the
 *  image genuinely has no text) plus the voiced span. `ok:false` distinguishes
 *  an honest "could not OCR" (helper failed) from "this platform has no Vision"
 *  (unavailable) — neither throws, neither hits the network. */
export type OcrResult =
  | { ok: true; text: string; fallback: OcrFallbackSpan }
  | { ok: false; reason: "unavailable" | "failed"; detail: string };

/** Minimal seam for running the helper subprocess — injected in tests so the
 *  OCR mapping is exercised with NO real Vision call. Resolves to the helper's
 *  stdout; rejects on a non-zero exit / missing binary / timeout. */
export type OcrRunner = (imagePath: string) => Promise<string>;

/** Options for {@link runImageOcr}. */
export interface OcrOptions {
  /** Override the platform check (tests). Defaults to the real `os.platform()`. */
  platformName?: string;
  /** Override the subprocess invocation (tests). Defaults to the real helper. */
  runner?: OcrRunner;
}

/** The real helper runner: invoke the local Vision CLI on an image path and
 *  return its stdout. Never used when an OCR runner is injected. */
function defaultRunner(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      OCR_HELPER,
      [...OCR_HELPER_ARGS, imagePath],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * OCR one image buffer via the on-device macOS Vision helper.
 *
 *   - off darwin → `{ ok: false, reason: "unavailable" }` (graceful degrade);
 *   - darwin → stage the bytes to a 0600 temp file, run the helper, return the
 *     recognized text + the voiced fallback span;
 *   - helper missing / errors / times out → `{ ok: false, reason: "failed" }`
 *     (no retry, no network).
 *
 * NEVER throws. The temp file is always unlinked, success or failure.
 */
export async function runImageOcr(
  bytes: Uint8Array,
  filename: string,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const plat = opts.platformName ?? platform();
  const runner = opts.runner ?? defaultRunner;

  // Vision is darwin-only — degrade gracefully everywhere else.
  if (plat !== "darwin") {
    return {
      ok: false,
      reason: "unavailable",
      detail: `image OCR needs macOS Vision; not available on ${plat}`,
    };
  }

  // Stage the bytes to a private temp file the helper can read by path. The
  // directory is created 0700 by mkdtemp; the image itself is forced 0600.
  let dir: string | undefined;
  let imagePath: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "autobroker-ocr-"));
    imagePath = join(dir, safeName(filename));
    writeFileSync(imagePath, bytes, { mode: 0o600 });
    chmodSync(imagePath, 0o600);
  } catch (err) {
    if (dir !== undefined) cleanup(dir);
    return { ok: false, reason: "failed", detail: stageError(err) };
  }

  try {
    const stdout = await runner(imagePath);
    return {
      ok: true,
      text: stdout.trim(),
      fallback: {
        kind: "image_ocr_vision",
        detail: `image ${filename || "(unnamed)"} read via on-device macOS Vision OCR`,
      },
    };
  } catch (err) {
    // Helper missing, non-zero exit, or timeout → honest failure, no retry. The
    // caller marks the message failed; no LLM/key/network is involved here.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "failed", detail };
  } finally {
    cleanup(dir);
  }
}

/** Reduce a declared filename to a safe basename for the temp file (the helper
 *  only needs a readable path; we never trust the declared name's directory). */
function safeName(filename: string): string {
  const base = filename.replace(/[/\\]/g, "_").trim();
  return base === "" ? "image.bin" : base;
}

/** Best-effort temp-dir removal — never throws (cleanup must not mask a result). */
function cleanup(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — a leftover temp file must never fail an OCR call.
  }
}

function stageError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `could not stage image for OCR: ${detail}`;
}
