# 05 — Gates: Claude hooks ↔ OpenCode plugins

**Phase:** 1  
**Depends on:** 03-shared-lib (feature-id, paths, validate-plan), ADR-002  
**Implements:** deterministic enforcement shells  
**Out of scope:** hand capture (06), vendor (08)

---

## 1. Failure direction

| Runtime | Deny mechanism | Process exit |
|---|---|---|
| Claude hook | stdout permission deny; process exit 0 | 0 |
| OC plugin | `throw` in `tool.execute.before` | **still 0** (probe) |

Shared returns Decision; shell maps direction.

**Never** use process exit code as session success oracle (09, 06).

---

## 2. Matrix

| Capability | Claude | OpenCode | Shared |
|---|---|---|---|
| Entry order (triage before delivery agents) | `entry-gate.mjs` | `plugin/entry-gate.ts` | role sets, feature id |
| Plan validation before execute | plan-write-gate + validate | `plugin/plan-gate.ts` + tool | validate-plan |
| Classify / triage stamp | classify.mjs, stamp-triage | `tools/classify.ts` | mode set, paths |
| Markers / gate-state | mark.mjs, gate-lib fs | plugin + disk JSON | shape helpers |
| Reinject after compact | reinject-state SessionStart | `chat.message` / compacting hooks | read state |
| Version check | version-check | chat.message advisory | compare versions |
| Loop convergence | prose + idle nudge | `plugin/loop-guard.ts` | counters **on disk** |
| Harvest buffer presence | — | `plugin/harvest-guard.ts` | — |
| Codex nudge | codex-eye-nudge | **DROP** → dual task protocol (07) | merge |

---

## 3. Disk state (invariant 4)

Path: `path-helpers.gateStatePath(roots)`

Minimum fields (align with existing gate-lib):

- session_id, feature_id, mode  
- ceremony flags (triaged, brainstormed, …) as needed by entry-gate  
- arrays of markers (hand_finished, capture_verified, …)  
- loop counters for plan-review and adversary-sniper (loop-guard)  
- `dual_status` optional until T8; when present must be enum from 07 (`both` | `primary_only_failopen` | `pending` | `primary_only_error`) — never bare boolean  

**Write:** temp file + rename.  
**Forbidden:** sole source of truth in plugin module-level `Map` (old OC port regression).

---

## 4. OC plugin implementation rules

1. Import or bundle shared decisions (copy shared mjs into vendor or resolve path).  
2. On deny: `throw new Error(reason)` with stable prefix e.g. `[entry-gate]`.  
3. Do not read hand tokens from env.  
4. Relative plugin paths in opencode.json.  
5. Project plugins auto-load; combined with global until cutover (10).  
6. `--pure` disables **all** plugins including project — not a substitute for cutover.

### Hooks available (probe + types)

- `tool.execute.before` / `after`  
- `tool.definition`  
- `chat.message`  
- `chat.params` (mutate options; respect supportsReasoningEffort)  
- `experimental.session.compacting`  

No Stop/SubagentStop equivalent — capture is external (06).

---

## 5. Entry-gate behavior (semantic parity)

Block delivery `task` subagent types (planner, executor*, sniper*, …) until ceremony satisfied for mode:

- QUICK: lighter bar  
- LIGHT/FULL: triage + brainstorm markers as designed in CC entry-gate  

Exact flag names: port from `core/hooks/entry-gate.mjs` + gate-lib; do not invent a weaker ceremony.

---

## 5b. Fidelity rail (test-author vs executor)

Port the CC resolution explicitly (do not “read CC and guess”):

| Role | Requires `fidelity-pass` / frozen test before spawn? |
|---|---|
| `test-author` | **NO** — it *produces* the locked test that enables fidelity |
| `executor` / hand impl spawn | **YES** — blocked until fidelity stamp + freeze exist for that task |
| `sniper` | per existing CC policy (usually must not rewrite frozen tests; re-gate rules apply) |

Entry-gate / spawn adapter MUST special-case `test-author` so the chicken-and-egg cannot deadlock: blocking all hands until fidelity-pass also blocks the role that creates fidelity-pass.

## 6. Plan-gate behavior

Before executor dispatch (or on plan write): 

- plan file exists at canonical path  
- **`validatePlan(plan, { expect: "full" }).ok`** — stubs (`kind: "stub"` or empty tasks) **must deny**  
- classify/tool may write stubs without passing `expect: "full"`  
- after planner, overwriting stub with full plan is required before any executor `task`  

---

## 7. DoD (T5) — MVP

**MVP in T5:** entry-gate + plan-gate + classify tool/stub + disk gate-state + fidelity special-case for test-author.

**Later (same phase 1, not blocking T5 checkbox if tracked separately):** reinject, version-check, harvest-guard polish — list as T5c optional or fold into T5 notes.

- [ ] entry-gate + plan-gate under `core/opencode/plugin` use shared + disk state  
- [ ] `classify` tool (or hook) writes stub via shared `buildClassifyStub` + markers entry-gate reads  
- [ ] fidelity rail: test-author allowed without fidelity-pass; executor hand blocked until pass  
- [ ] loop-guard counters on disk (minimum: plan-review loop + adversary loop)  
- [ ] tests: deny throws; allow passes; state survives second process; test-author not deadlocked  
- [ ] no absolute `/Users/...` plugin paths in examples  
- [ ] IMPLEMENTATION-TRACK T5 done  

---

## 8. References

- probe-results: throw deny, exit 0, global+project plugins, pure  
- 03 path-helpers, feature-id, validate-plan  
