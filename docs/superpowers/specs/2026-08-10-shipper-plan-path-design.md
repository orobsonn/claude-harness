# Shipper plan path

## Goal

Make the OpenCode delivery conductor pass the exact, already-resolved execution-plan path to the shipper.

## Design

The Phase 5 shipper dispatch receives the canonical path resolved for the active run. For a resumed feature this is the adopted canonical plan path, never a directory reconstructed from the current session id. The shipper keeps its existing feature-id fallback only when that supplied path cannot be read.

## Constraints

- No new runtime state, marker, permission, or network call.
- The plan remains read-only for the shipper.
- A regression test covers both a fresh and resumed plan path.
