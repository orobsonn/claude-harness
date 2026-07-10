# 03 — Shared library (public API)

**Phase:** 1  
**Depends on:** 00, 01, ADR-002  
**Implements:** pure modules under `core/shared/lib`  
**Out of scope:** plugins, spawn CLI, agent markdown, VPS crons

---

## 0. Global rules for every module

1. **Never throw** on validation/decision paths (ADR-002).  
2. No read of `process.env` secrets inside pure decision functions (inject if needed).  
3. No absolute path to `.claude` or `.opencode` without a `runtime`/`roots` parameter.  
4. Node builtins only preferred; zero npm deps in shared lib.  
5. Every export has unit tests in `core/shared/lib/**/*.test.mjs` (or colocated).  
6. English identifiers; JSDoc `@description` on files.

### Standard result shapes

```ts
// decisions (gates)
type Decision = {
  ok: boolean           // true = allow / valid
  decision: "allow" | "deny" | "warn"
  reason: string        // machine-readable short code + human detail
  details?: unknown
}

// validation
type ValidationResult = {
  ok: boolean
  errors: string[]      // empty if ok
}
```

---

## 1. `feature-id.mjs` (ids)

**Path:** `core/shared/lib/feature-id.mjs`  
**Source today:** `core/hooks/lib/gate-lib.mjs` + OC `plugin/lib/feature-id.ts`  
**Also owns session id validation** (same module — path-helpers imports from here).

### Exports

| Export | Signature | Behavior |
|---|---|---|
| `SAFE_FEATURE_ID` | `RegExp` | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `isSafeFeatureId(value)` | `(unknown) => boolean` | false if not string or regex fail; never throw |
| `SAFE_SESSION_ID` | `RegExp` | `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/` — no `/`, `\`, spaces |
| `isSafeSessionId(value)` | `(unknown) => boolean` | false if not string, length 0 or >128, regex fail, **or `value.includes("..")`** (reject dot-dot anywhere, even mid-string); never throw |
| `isSafeTaskId(value)` | `(unknown) => boolean` | same rules as feature_id (kebab-case) unless documented otherwise |

### Tests

- feature: accepts `user-auth-revamp`; rejects `../etc`, `UPPER`, `under_score`, empty, non-string  
- session: accepts `ses_0b26b3d3dffemhkidMaMZwfPZn`; rejects `../x`, `a/b`, `foo..bar`, empty, 200-char string  
- task: accepts `task-1`; rejects `../task`  

**T2 DoD must list:** `isSafeFeatureId`, `isSafeSessionId`, `isSafeTaskId` exports + tests green.

---

## 2. `path-helpers.mjs`

**Path:** `core/shared/lib/path-helpers.mjs`

### Types

```ts
type Runtime = "claude" | "opencode"

type Roots = {
  projectRoot: string
  runtime: Runtime
  sessionId?: string
  featureId?: string
}
```

### Exports

| Export | Returns |
|---|---|
| `runtimeDirName(runtime)` | `".claude"` \| `".opencode"` |
| `plansRoot(roots)` | `<project>/<runtimeDir>/plans` |
| `planDir(roots)` | Claude: `.../plans/<featureId>` · OC: `.../plans/<sessionId>-<featureId>` (require both ids for OC) |
| `gateStateDir(roots)` | `.../plans/.state/<sessionId>` |
| `gateStatePath(roots)` | `.../gate-state.json` |
| `handRecordPath(roots, taskId)` | PathResult → `{runtimeDir}/plans/.state/hand-records/<featureId>/<sessionId>/<taskId>.json` when `sessionId` present (OC default); Claude may use `<featureId>/<taskId>.json` if single-session-per-feature legacy — **OC must include sessionId** to avoid cross-session collision. Requires safe featureId + safe sessionId + safe taskId. |
| `sharedContextPath(roots)` | PathResult → `{planDir}/shared_context.md` |
| `findingsPath(projectRoot)` | PathResult → `<projectRoot>/findings.md` |

**API rule (single form):** every resolver returns

```ts
type PathResult = { ok: true; path: string } | { ok: false; reason: string }
```

Never return bare strings from public resolvers. Never throw. Do **not** mkdir.
Invalid/missing ids → `{ ok:false, reason }`.

Any resolver that embeds `sessionId` or `featureId` in a path MUST validate with `isSafeSessionId` / `isSafeFeatureId` first; invalid → `{ ok:false, reason }`.

### Tests

- OC plan dir includes session prefix  
- Claude plan dir has no session prefix  
- unsafe featureId → ok false  
- unsafe sessionId (`../`, `/`) → ok false  

---

## 3. `validate-plan.mjs`

**Path:** `core/shared/lib/validate-plan.mjs`  
**Source today:** `core/skills/creating-plans/references/validate-plan.mjs` + OC `tools/validate-plan.ts` logic

### Export

`validatePlan(plan: unknown, opts?: { expect?: "stub"|"full"|"any" }) => ValidationResult`  
Default `expect: "any"` (auto-detect).

### Must check (minimum)

- plan is object  
- `feature_id` safe (reuse isSafeFeatureId)  
- **Plan kinds** (locked):
  - **stub** (classify output): `kind: "stub"` (or detect: `tasks` empty + modes `no-ceremony|QUICK|LIGHT|FULL` uppercase triage). `tasks` **may be empty**. validatePlan(stub) only checks feature_id, mode, kind.
  - **full plan** (planner output): `kind: "full"` (or detect: non-empty tasks). Canonical mode lowercase `light`|`full`. `tasks` **must** be non-empty.
- `validatePlan(plan, { expect: "stub"|"full"|"any" })` — default `"any"` auto-detects; plan-gate uses `expect: "full"` before executors; classify uses stub builder only  
- each task: id, scope_paths, criterion_refs, locked_tests, depends_on acyclic  
- **locked_tests item shape (locked):** each entry is an object:
  ```ts
  {
    id: string              // stable test id, kebab or file#name
    path: string            // repo-relative test file path
    command?: string        // optional exact runner command; else project default test runner + path
    assertion?: string      // optional human/planner pin text
  }
  ```
  **Validation rules (deterministic):**
  - Every task in a full plan MUST have `locked_tests` as an **array**.
  - **Min length 1** for all tasks unless `task.kind === "docs"` OR `task.no_tests === true` (boolean, explicit).
  - If `no_tests: true`, `locked_tests` MUST be `[]` and `criterion_refs` still required.
  - Missing `locked_tests` key → error. `null` → error.
  - No string form `tests: "none"` — use `no_tests: true` only.

- valid complexity/severity tiers: `low|medium|high` (not haiku/sonnet/opus)  
- `demo` shape if present  
- `adversarial` focus when enabled  

### Tests

- golden valid full plan  
- cycle in depends_on → error  
- empty tasks on full plan / expect full → error  
- stub (`kind: stub`, tasks `[]`) + expect `stub` → ok  
- stub + expect `full` → error  
- legacy claude tier names → error  

OC `tools/validate-plan.ts` becomes thin wrapper calling shared (or shared is TS-compiled — prefer shared mjs called from tool via node, or duplicate-free port to TS that mirrors tests). **Single source:** implement once in shared mjs; OC tool shells out or imports if bundler allows.

---

## 4. `severity.mjs`

### Exports

| Export | Behavior |
|---|---|
| `normalizeSeverity(s)` | map to `low\|medium\|high\|critical`; unknown → `medium` or invalid in details |
| `maxSeverity(list)` | highest in list; empty → null |
| `severityRank(s)` | number for compare |

Never throw.

---

## 5. `merge-findings.mjs` (cross-family pure)

**Source:** `modules/codex-adversary/references/merge-findings.mjs`  
**Generalize:** families named by label string (`grok`, `openai`, `claude`, `codex`) not hardcoded.

### Exports

| Export | Behavior |
|---|---|
| `dedupKey(issue, fields?)` | stable key |
| `classifyFindings(familyAIssues, familyBIssues, labels)` | tagged union per policy prep |
| `finalizeFindings(classified, verdicts?)` | policy B: keep unless explicit refute |
| `securityVerdict(issues)` | SECURE/UNSAFE style summary if used |

### Finding object shape (locked)

```ts
type Finding = {
  id: string                    // stable id within family report (required)
  title: string
  severity: "low" | "medium" | "high" | "critical"
  evidence?: string
  family: string                // e.g. "grok" | "openai" — set by merge, not model prose alone
  // optional explicit refute of another finding:
  refutes?: {
    target_id: string           // Finding.id of the other family
    target_family: string
    reason: string              // non-empty
  }
}
```

**Association key for dedup/refute:** `dedupKey(finding)` default = normalize(`title`) + `severity` (override fields documented in DEDUP_FIELDS).  
**Explicit refute:** only when `refutes.target_id` + `refutes.target_family` match an existing finding **and** `refutes.reason` length ≥ 1. Vague disagreement in free text without `refutes` object does **not** drop the other finding.

### Policy B (locked)

- Finding from one family alone is **kept** unless the other family **explicitly refutes** it via the `refutes` object.  
- No majority vote.  
- See 07 for orchestrator wiring.

### Tests

- only-A finding kept  
- A finding + B `refutes` matching A.id → A dropped or marked refuted  
- B free-text disagreement without `refutes` → A still kept  
- dedup merges same key  

---

## 6. `merge-verdicts.mjs`

**Source:** `modules/codex-adversary/references/merge-verdicts.mjs`

### Export

`mergeVerdicts(primary, secondary, meta) => merged`

Family-agnostic field names. Never throw; malformed input → ok false / empty issues + reason.

---

## 7. `routing-validate.mjs`

### Export

`validateRouting(config: unknown) => ValidationResult`

Rules from 02-routing.md constraints + modelCapabilities effort flags consistency.

### Tests

- default operator JSON validates  
- missing dual on adversary → error  
- same provider on dual pair → error  
- supportsReasoningEffort false documented for grok-build  

---

## 8. `capture-oracle.mjs` (pure slices first)

**Source:** `capture-hand.mjs` / `dispatch-hand.mjs` pure functions

### Phase 1 pure exports (must)

| Export | Behavior |
|---|---|
| `checkScope(touchedPaths, scopePaths)` | Decision |
| `checkFrozen(touchedPaths, frozenPaths)` | Decision |
| `checkAllowedWrites(touchedPaths, allowedWrites)` | Decision |
| `excludeHarnessInternal(paths)` | filter |
| `isHarnessInternalPath(path)` | boolean |
| `evaluateRun({ dispatch, child })` | outcome enum without throwing |
| `parseTestsCount(stdout)` | number |
| `subtractUnchanged(...)` | paths |

### IO-bound capture

`captureResult` with real git/test runners stays in **runtime adapter** (06) but should call pure checks above. Optionally inject `git`/`test` functions for tests (already pattern in CC).

### Outcome enum (closed set)

Port from `dispatch-hand.mjs` `OUTCOME` — implement exactly these string values:

| Outcome | When |
|---|---|
| `DONE` | capture ran; tests green (non-vacuous); scope ok; frozen ok; no harness-internal leaks required by policy |
| `FAILED` | hand process finished but tests red, or scope/frozen/allowed-write violation, or vacuous green |
| `NOT_DONE` | hand did not complete meaningfully (timeout, crash without record, empty required deliverable) |
| `CONFIG_ERROR` | missing token/model/agent config before spawn (fail closed; do not treat as DONE) |
| `CAPTURE_ERROR` | capture itself could not run (git/test runner failure) — **not** DONE; do not escalate as successful hand |

**Never count as DONE:** model prose claiming success; OC process exit code 0; plugin deny followed by hallucinated text (probe P12).

### `no_tests: true` tasks (locked)

When the plan task has `no_tests: true` and `locked_tests: []`:

| Check | Rule |
|---|---|
| Test re-run | **skipped** (no vacuous-green possible) |
| `DONE` criteria | scope ok + frozen ok + capture ran + **no test requirement** |
| Vacuous green | N/A |
| Implementation tasks without `no_tests` | still require locked_tests length ≥ 1 and green tests for DONE |

`evaluateRun` must receive `task.no_tests` (boolean) from the adapter.

`evaluateRun` returns `{ ok: true, outcome, details }` or `{ ok: false, reason }` if inputs malformed — never throw.

---

## 9. `gate-state-shape.mjs` (optional split from gate-lib)

Pure: merge patch semantics, marker array helpers, without fs.

fs read/write of gate-state lives in CC hooks / OC plugins (05), using path-helpers.

---

## 9b. `complexity-scorer` (pure core)

**Path:** `core/shared/lib/complexity-scorer.mjs`  
**Source:** `creating-plans/references/complexity-scorer.mjs` + OC `tools/complexity-scorer.ts`

### Export

`scoreFile(sourceText: string, pathHint?: string) => { ok: true, score: number, band: "low"|"medium"|"high"|"max"|"split", signals: object } | { ok: false, reason: string }`

Bands (align with existing harness): low 0–10 · medium 11–30 · high 31–45 · max 46–60 · split 61+.

**Mapping to executor/sniper routing (locked):**

| Band | Dispatch |
|---|---|
| low | executor-low / sniper-low |
| medium | executor-medium / sniper-medium |
| high | executor-high / sniper-high |
| max | executor-high or dedicated `executor-max` if present in agents (same model tier as high unless routing adds max model) |
| split | **do not implement as one task** — planner must split; validate-plan / planner self-check rejects unsplittable 61+ without split |

`validate-plan` task complexity field remains `low|medium|high` (and optional `max` if schema extended). Scorer `split` is a planner signal, not a runnable tier.

OC `tools/complexity-scorer.ts` is a thin wrapper (read file + call shared). Track item **T5b**.

### Tests

- fixture file scores stable band  
- empty input → ok false or score 0 with documented behavior  

---

## 9c. `classify-stub` (pure write plan shape)

**Path:** `core/shared/lib/classify-stub.mjs`

### Export

`buildClassifyStub({ mode, featureId, sessionId }) => { ok, stub?, reason? }`

Produces the pre-plan **stub** object:
```json
{ "kind": "stub", "mode": "LIGHT", "feature_id": "...", "tasks": [], "session_id": "..." }
```
**IO** (mkdir + write) stays in OC `tools/classify.ts` / CC hook — shared only builds validated JSON object.

Modes: `no-ceremony` | `QUICK` | `LIGHT` | `FULL` (triage stub uppercase).  
featureId must pass `isSafeFeatureId`. sessionId must pass `isSafeSessionId` when provided.

**Plan-gate rule:** before executor dispatch, require file exists AND `validatePlan(plan, { expect: "full" }).ok`. A stub must **fail** `expect: "full"`. Stale stub = still stub kind or empty tasks after planner should have run.

Track: owned by **T5** with entry-gate markers.

---

## 10. What must NOT enter shared

| Item | Why |
|---|---|
| `spawn-hand` argv for claude/opencode | runtime-specific |
| Plugin `throw` | OC shell |
| Hook stdout JSON | CC shell |
| Telegram notify | VPS |
| Agent markdown | BOTH prose |
| Reading `OLLAMA_HAND_TOKEN` | secrets + runtime |

---

## 11. DoD by track item

| Track | Modules | Done when |
|---|---|---|
| T2 | feature-id, path-helpers | tests green; PathResult-only API |
| T3 | validate-plan | tests green; OC tool or CC script calls it |
| T4 | severity, merge-findings, merge-verdicts | tests green |
| T1 | routing-validate | tests green + default JSON |
| T5 | classify-stub (+ tool/hook IO) | stub validates; markers writable |
| T5b | complexity-scorer | tests green; OC tool wraps shared |
| T7 | capture-oracle pure | tests green; closed outcome enum; adapters use it |

---

## 12. References

- inventory/full-map.md § shared  
- ADR-002  
- existing tests in `gate-lib.test.mjs`, codex merge tests, OC validate-plan tests — port/adapt  
