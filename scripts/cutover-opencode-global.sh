#!/usr/bin/env bash
# cutover-opencode-global.sh — operator entry for T10 global OC harness cutover.
# Default: preflight only (never deletes).
# Apply: requires --apply --i-confirm-cutover after preflight PASS.
# See scripts/cutover-opencode-global.md for full runbook (backup/rollback).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_CLI="$ROOT/scripts/cutover-preflight.test.mjs"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/cutover-opencode-global.sh                 # preflight only (default)
  ./scripts/cutover-opencode-global.sh --preflight     # same
  ./scripts/cutover-opencode-global.sh --dry-run-apply # plan backup+remove (no delete)
  ./scripts/cutover-opencode-global.sh --apply --i-confirm-cutover
                                                      # backup then remove harness from
                                                      # ~/.config/opencode (keeps personal)

Hard gates (preflight blocks delete if any fail):
  1. T11 parity + project-vendored smoke recorded done on IMPLEMENTATION-TRACK
  2. Project plugin paths are project-relative (not absolute home)
  3. No phase-2 OC VPS artifacts; T12–T14 remain pending
  4. Runbook documents backup + rollback before global delete

EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$NODE_CLI" ]]; then
  echo "error: missing $NODE_CLI" >&2
  exit 2
fi

# Default = preflight
if [[ $# -eq 0 ]]; then
  exec node "$NODE_CLI" --preflight
fi

exec node "$NODE_CLI" "$@"
