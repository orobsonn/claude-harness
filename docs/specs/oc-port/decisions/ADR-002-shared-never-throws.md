# ADR-002 — shared/ never throws

**Status:** accepted  
**Date:** 2026-07-10

## Decision

All modules under `core/shared/lib` are pure (or pure-with-injected-IO for tests) and **never throw** for expected validation/decision paths. They return structured results.

## Context

Claude Code hooks are fail-**open** (exit 0; deny via stdout). OpenCode plugins are fail-**closed** (`throw` blocks the tool). Shared logic that throws would invert blast radius across runtimes.

## Consequences

- Claude shell maps `{ decision: "deny" }` → hook deny payload.  
- OC shell maps `{ decision: "deny" }` → `throw new Error(reason)`.  
- A throw escaping shared is a bug.  
- No “unified gate core with adapters that throw” abstraction.
