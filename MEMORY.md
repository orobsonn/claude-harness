# MEMORY.md — Project Durable Index

One line per durable, reusable, non-obvious project pattern or anti-pattern. Full prose under the anchor.

- [dual-status-enum](#dual-status-enum) — always persist dual_status as closed enum (primary_only_failopen | primary_only_error | both | pending) in gate-state/findings; primary_only_* is never full cross-family coverage
- [ephemeral-buffers-deleted-at-harvest](#ephemeral-buffers-deleted-at-harvest) — harvester deletes findings.md (root) + .opencode/plans/<feature_id>/shared_context.md after routing durable learnings; git is the audit trail
- [ceremony-on-disk](#ceremony-on-disk) — gate state (fidelity_pass, loop-guard counters, harvest-guard, entry/plan stamps, ownership tokens) lives exclusively on disk with RMW lock; never sole in-memory Map
- [dual-runtime-layout](#dual-runtime-layout) — core/claude-code/ + core/opencode/ + core/shared/ (pure) for port; mechanical move + shims in one commit; tests path-only

## dual-status-enum

**Why:** secondary family unavailable (auth, rate, infra) must not silently count as dual coverage; fail-open keeps primary findings but records the status explicitly so metrics and gates know it is not full dual.

**How to apply:** dispatch via dual-runtime.mjs helpers (driveDualEye, mergeDualVerdicts, dualStatusGatePatch); always check isFullDualCoverage(dual_status) before claiming cross-family; record in findings and gate-state patch.

## ephemeral-buffers-deleted-at-harvest

**Why:** findings.md and shared_context.md are single-run only; leaving them pollutes next run or leaks transient gotchas as if durable.

**How to apply:** at harvester end: rm -f findings.md; rm -f .opencode/plans/<feature_id>/shared_context.md ; verify no other run scratch; never commit them (already in .gitignore).

## ceremony-on-disk

**Why:** restart, compaction, cheap-hand dispatch, and loop convergence all require state that survives process death; in-memory only caused prior incidents with missed stamps.

**How to apply:** use core/opencode/plugin/lib/mark-gate.mjs + gate-lib for all stamps (fidelity, loop counters, harvest presence); entry-gate/plan-gate/loop-guard/harvest-guard read disk only; ownership token for RMW on locks.

## dual-runtime-layout

**Why:** allows incremental port without breaking existing Claude Code users; shared/ holds pure logic that both runtimes consume; mechanical move prevents behavior drift during transition.

**How to apply:** keep claude-code/ and opencode/ trees in sync via port tasks; update package.json bin/files + imports in lockstep; scope_paths in plan must list both when touching shared.

