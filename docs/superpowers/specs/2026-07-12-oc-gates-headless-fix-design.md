# Design: OpenCode gate plugins must enforce dual before delivery hands

**Date:** 2026-07-12  
**Mode:** FULL (sensitive harness rails; multi-file)  
**Status:** operator-approved (autonomous execution authorized)  
**Feature id:** `oc-gates-headless-fix`

## Problem (product)

On a project vendored from `core/opencode`, headless `opencode run` starts and can dispatch `task` → `executor-*` **without** a recorded dual attempt. Some gate plugins fail to load; entry-gate loads but does not block. Autonomous delivery is therefore not trustworthy.

## Goal

Restore fail-closed dual enforcement for delivery hands under real `opencode run` with a local vendor of `core/opencode`.

## Non-goals

- VPS cron / runtime selector / NDJSON cron parser (follow-up)
- Review session / auto-merge
- Changing ADR-003 policy (still require dual before executor/sniper)

## Evidence (probes 2026-07-12)

- Vendor from local core + release v0.40.0 both reproduce:
  - `plan-gate.ts`: `failed to load plugin` — `Plugin export is not a function`
  - `loop-guard.ts`: `Export named 'applyGateStatePatch' not found` (vendored shared path/export)
  - `task` + `executor-low` without dual → `status=completed`, process exit 0
- Working reference: `loop-guard` hook shape uses `(input, output)` with `input.tool` and `output.args`
- Plugin type: `Plugin = (input: PluginInput, options?) => Promise<Hooks>`

## Approach

1. Fix plugin module exports so OC runtime accepts entry-gate, plan-gate, loop-guard.
2. Align `tool.execute.before` with OC hook signature; extract `subagent_type` from the correct args bag.
3. Ensure routing + gate-state load from vendored project root (`input.directory` / worktree).
4. Fail-closed: missing/pending dual_status denies executor/sniper task dispatch.
5. Prove with hermetic unit tests + real `opencode run` probe on local vendor.

## Acceptance criteria

- **#ac-1** Local vendor of core: `opencode run --auto --agent build` logs **no** `failed to load plugin` for entry-gate, plan-gate, loop-guard.
- **#ac-2** Without recorded dual_status: `task`/`executor-low` → tool error whose message includes `[entry-gate]` or `[plan-gate]` (deny).
- **#ac-3** With valid recorded dual_status (`both` | `primary_only_failopen` | `primary_only_error`): same task is **not** denied for dual reasons.
- **#ac-4** Existing dual-enforcement unit tests remain green; add/adjust tests for hook arg extraction if needed.

## Locked decisions

| id | decision | operator_resolution |
|----|----------|---------------------|
| LD-1 | Scope = gate fix only; VPS headless later | approved |
| LD-2 | Source of truth = core/opencode (+ shared as needed) | approved |
| LD-3 | Validation includes real opencode run on vendored project | approved |
| LD-4 | Fail-closed without dual before delivery hands | approved |
| LD-5 | Autonomous execution until this problem is fixed | approved |

## User journeys

- **#uj-1** Operator vendors OC harness into a project and runs headless build: gates load; illegal executor dispatch is blocked until dual is recorded.
