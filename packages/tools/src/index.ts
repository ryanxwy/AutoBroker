/**
 * @autobroker/tools — Layer 4 public surface.
 *
 * The ONLY layer that touches SQLite or external APIs. In-process
 * tool({execute}) closures for Gmail, browser, DB, plus pure calc/validators,
 * fronted by the L2 in-process gate (the single side-effect path).
 *
 * Dependency wall: tools may import core and db — never workflows or app.
 */

// L2 gate bridge + L1 env fuse — the single side-effect path.
export {
  requestApproval,
  withGate,
  ExternalMutationsBlockedError,
  MalformedGateRequestError,
  type MutationKind,
  type GateRequest,
  type GateVerdict,
  type Approver,
} from "./gate/index.js";

// Gmail (fake/real send seam, default fake).
export {
  GmailTool,
  buildRaw,
  redactBudget,
  type SendMode,
  type OutboundEmail,
  type SendResult,
} from "./gmail.js";

// Browser (Playwright-native; mutating submit wrapped by the gate).
export {
  BrowserTool,
  type PageLike,
  type DealerLeadForm,
} from "./browser.js";

// DB (Drizzle + better-sqlite3 connection factory).
export { openDb, resolveDataDir } from "./db.js";

// Pure offer math.
export {
  validateOfferMath,
  OFFER_MATH_TOLERANCE_USD,
  STATE_DOC_FEE_CAP,
  type OfferLineItems,
  type OfferMathResult,
} from "./calc.js";

// Pure validators (post-validation + safety rules).
export {
  postValidate,
  assertNoBudget,
  assertPhonePolicy,
  type ValidationResult,
} from "./validators.js";
