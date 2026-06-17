/**
 * Shared audit-flag collapsing for the quote views (compare + raw foldout).
 *
 * The audit can attach many MISSING_REBATE codes (one per applicable incentive);
 * collapse those into a single "N rebates not applied" chip while keeping every
 * DISTINCT flag (DOC_FEE_CAP, MATH_SANITY, MISSING_BREAKDOWN, MODE_MISMATCH, …)
 * as its own pill. The collapsed chip keeps the MISSING_REBATE code (stable
 * testid); distinct flags keep their first-seen order.
 */
export function collapseAuditFlags(codes: readonly string[]): { code: string; label: string }[] {
  const out: { code: string; label: string }[] = [];
  let rebates = 0;
  for (const code of codes) {
    if (code === "MISSING_REBATE") rebates += 1;
    else out.push({ code, label: code });
  }
  if (rebates > 0) {
    out.push({
      code: "MISSING_REBATE",
      label: rebates === 1 ? "1 rebate not applied" : `${rebates} rebates not applied`,
    });
  }
  return out;
}
