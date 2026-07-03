/**
 * profile/ barrel — the tools-layer search_profiles + audit_log surface.
 * The ONLY write path for the product profile tables.
 */

export {
  rowToProfile,
  profileToRow,
  type SearchProfileRow,
} from "./adapter.js";

export {
  validate,
  create,
  resolveActive,
  update,
  replace,
  close,
  restore,
  purge,
  parseLocation,
  synthProfileId,
  readProfileRow,
  closeProfileStatusPlain,
  listProfileRows,
  listProfileDealerRows,
  type PurgeResult,
  type ValidateResult,
  type ParsedLocation,
  type ResolvedCoordinates,
  type CreateOpts,
  type CreateResult,
} from "./profileService.js";

export {
  resolveActiveProfile,
  type ResolveResult,
  type ResolverTrace,
} from "./resolver.js";

export {
  makeFakePhone,
  resolveStoredPhone,
  type Rng,
} from "./fakePhone.js";

export { writeAuditLog, AUDIT_ACTIONS, type AuditAction, type AuditEntry } from "./audit.js";

export {
  ActiveSlotConflict,
  IdentityLockedError,
  IDENTITY_FIELDS,
  CoordinatesNotResolvedError,
  MissingRequiredFieldError,
} from "./errors.js";
