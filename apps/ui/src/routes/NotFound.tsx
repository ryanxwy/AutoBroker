/**
 * NotFound — the '*' route (FRONTEND_LAYOUT §2). A minimal dead-end with a link
 * home.
 */

import { Link } from "../router.js";

export function NotFound({ path }: { path: string }): JSX.Element {
  return (
    <div data-testid="not-found">
      <h1>Not found</h1>
      <p className="muted">No page at {path}.</p>
      <Link to="/" data-testid="not-found-home">
        ← Back home
      </Link>
    </div>
  );
}
