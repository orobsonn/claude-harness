# Probe results — OC gates under vendored headless (2026-07-12)

**Binary:** opencode 1.17.18  
**Method:** `vendor-core --runtime opencode` from local repo + `opencode run --dir <vendor> --format json --auto --agent build`

## Matrix

| ID | Setup | Result |
|----|--------|--------|
| V2 | plugin deny bash | exit 0; tool_use state.status=error (exit not oracle) |
| V6 | no --auto, bash ask | auto-reject permission; status=error |
| V7 | --auto | bash completed |
| V8/V15 | stdin prompt | works (incl. 12KB) |
| V25 | release vendor v0.40.0 | plan-gate fail load; executor-low task completed without dual |
| V26 | **local core vendor** | plan-gate fail load; loop-guard fail applyGateStatePatch; executor-low completed without dual |
| V27 | post-fix probe (DENY) | tool_use status=error + [entry-gate|plan-gate] prefix; exit=0 not oracle |
| V28 | post-fix probe (ALLOW) | hermetic enforceDualFromDiskOrThrow dual_status=both → allow |
| V29 | post-fix probe (load) | plugins load cleanly; no "failed to load plugin" |

## Implications

1. Gate bugs are in core/runtime integration, not missing vendor.
2. Must fix before VPS OC headless.
3. Hook signature likely `(input, output)` with args on output (see loop-guard).

## Post-fix (2026-07-12 evening)

| ID | Result |
|----|--------|
| V30 | Dynamic-import plugin factories (loop-guard pattern): **no** `failed to load plugin` for entry/plan/loop |
| V31 | `task`→`executor-low` without dual → `tool_use.state.status=error` with `[plan-gate]` / gate-state-unreadable |
| V32 | `node scripts/probe-oc-gates-headless.mjs` → **All checks passed** (DENY + AC-1 load + hermetic ALLOW) |

Root cause of load failure: static `import` of `dual-enforcement.mjs` from plugin `.ts` made OC report `Plugin export is not a function`. Fix: dynamic `import()` inside Plugin factory like loop-guard.
