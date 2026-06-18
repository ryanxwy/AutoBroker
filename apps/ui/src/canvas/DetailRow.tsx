/**
 * DetailRow — one label/value row in a canvas detail modal's `<dl>`, shared by
 * the Inventory / Dealer / Incentive / Quote detail surfaces (it was duplicated
 * verbatim in each; the Quote copy — with the `emphasize` strong-wrap — is the
 * superset adopted here). Omitted entirely when `value` is null/empty, so a
 * missing field drops its row rather than fabricating a value.
 */

import type { ReactNode } from "react";

export function DetailRow({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: ReactNode;
  emphasize?: boolean;
}): JSX.Element | null {
  if (value === null || value === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{emphasize ? <strong>{value}</strong> : value}</dd>
    </>
  );
}
