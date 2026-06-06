/**
 * IntakeScopeNoticeCard — the non-skippable system notice (intake-from-pinned
 * fork rule). When intake is forked from a PINNED session, the start ack carries
 * an IntakeScopeNotice (wire.ts, mirroring sessions.ts). It renders as the
 * forked session's FIRST part — a system notice that CANNOT be dismissed (no
 * close button), under the [data-intake-scope-notice] selector the UI checks key
 * off. The three points come verbatim off the wire.
 */

import type { IntakeScopeNotice } from "../api/wire.js";

export function IntakeScopeNoticeCard({ notice }: { notice: IntakeScopeNotice }): JSX.Element {
  return (
    <div className="scope-notice" data-intake-scope-notice="" role="note" aria-label="New search scope">
      <strong>Starting a new search</strong>
      <ul>
        {notice.points.map((p, i) => (
          <li key={i} data-testid={`scope-notice-point-${i}`}>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}
