#!/usr/bin/env bash
# Launch a read-mostly sqlite MCP server over the AutoBroker (TS) database, so
# Claude can query test_run_records / parity tables directly when drafting daily
# reports, burndowns, or debugging. Mirrors the legacy launcher but points at the
# TS parity-period DB by default.
#
# Override the DB with AUTOBROKER_SQLITE_PATH; pin the server with MCP_SERVER_SQLITE_VERSION.
set -euo pipefail
DB="${AUTOBROKER_SQLITE_PATH:-$HOME/.autobroker-ts/autobroker.db}"
if [[ ! -f "$DB" ]]; then
  printf 'sqlite-mcp launcher: DB not found at %s\n' "$DB" >&2
  printf 'Create it first (Phase 0 cold-copy: scripts/cold-copy-sqlite.sh) or set AUTOBROKER_SQLITE_PATH.\n' >&2
  exit 1
fi
exec uvx "mcp-server-sqlite@${MCP_SERVER_SQLITE_VERSION:-latest}" --db-path "$DB"
