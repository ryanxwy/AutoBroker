/**
 * daily_digest deterministic core — the zero-LLM read aggregation + render +
 * file-artifact writer the digest skill and the `GET /api/digest` route use.
 * Pure reads (raw prepared statements) + a deterministic 7-section renderer +
 * an atomic local-file sink + the live JSON projection for the page. No LLM,
 * no budget figures, no external mutation.
 */

export {
  bucketFreshness,
  FRESH_WINDOW_MS,
  STALE_WINDOW_MS,
  type FreshnessBucket,
} from "./freshness.js";

export {
  generateDigest,
  NO_ACTIVE_SEARCHES,
  DEFAULT_OFFERS_LIMIT,
  type DigestPayload,
  type DigestProfileGroup,
  type DigestOffer,
  type FreshnessMix,
  type NextAction,
  type GenerateDigestArgs,
} from "./generateDigest.js";

export {
  renderDigestText,
  digestHeadline,
  NO_ACTIVE_SEARCHES_TEXT,
} from "./renderDigest.js";

export {
  writeDigestArtifact,
  type WriteDigestArtifactArgs,
} from "./writeDigestArtifact.js";

export {
  buildDigestView,
  type DigestView,
  type DigestViewProfile,
  type DigestViewQuoteRow,
  type BuildDigestViewArgs,
} from "./digestView.js";

export {
  lastDigestAtKey,
  readLastDigestAt,
  writeLastDigestAt,
} from "./digestWatermark.js";
