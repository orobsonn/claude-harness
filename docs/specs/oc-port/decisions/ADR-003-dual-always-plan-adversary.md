# ADR-003 — Dual-eye always on plan-reviewer and adversary

**Status:** accepted  
**Date:** 2026-07-10

## Decision

On OpenCode default routing, **plan-reviewer** and **adversary** always run primary **Grok 4.5** and, in parallel or immediate sequence, a second-family **OpenAI** eye. Merge uses policy B (keep finding unless explicitly refuted).

## Context

Claude harness uses Opus as default adversary/plan-reviewer and activates Codex cross-family at key posts. Operator wants the same shape: strong primary + always-on second family at those posts—not optional, not every role.

## Consequences

- Orchestrator protocol must not skip dual when OpenAI is configured.  
- If OpenAI unauthenticated, dual is fail-open with explicit warning (do not fake dual).  
- compliance/security default single OpenAI family unless routing enables dual.  
- Codex CLI module remains Claude-target opt-in; OC uses native second provider via `task`.
