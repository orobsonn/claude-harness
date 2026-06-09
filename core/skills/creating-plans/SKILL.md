---
name: creating-plans
description: "Use when you have an approved spec/PRD and need to generate execution-plan.json before the orchestrating-delivery skill runs. Guides the planner (always Opus) to decompose the spec into atomic tasks with locked tests, severity tiers, adversarial flags, and scope_paths. Output is a validated JSON consumed by orchestrating-delivery."
source: adapted from pi-agent/skills/plan-make/SKILL.md
adaptation_date: 2026-06-01
---

# Creating-Plans — Generating execution-plan.json from an approved spec

**This skill runs inside the planner agent (always Opus).** It does not write code and does not invoke orchestrating-delivery. Its only output is a validated `execution-plan.json`.

**Announce at the start (in pt-br):** "Usando creating-plans para gerar o execution-plan.json a partir da spec aprovada."

**Pre-requisite:** approved spec/PRD with user journeys (UJs), acceptance criteria (ACs), and constraints.

**Contract source of truth (executable):** `references/validate-plan.mjs`
**Valid example:** `references/example-plan.json`

User-facing messages are always in pt-br. All identifiers, JSON keys, file paths, and reasoning stay in English.

---

## Step 1 — Read the spec

Extract and list explicitly:
- User journeys (`#uj-N`) — these drive `demo.scenarios_from_refs`
- Acceptance criteria (`#ac-N.M`) — these drive `locked_tests` and `criterion_refs`
- Constraints and resolved product decisions — these seed `resolved_judgments`

If any AC is ambiguous (no testable outcome), **stop and ask the user** (in pt-br) before proceeding.

---

## Step 2 — Decompose into tasks

**Unit of decomposition: the task** — not a micro-step, not a giant module.

Group into the same task when:
- Same file or tightly coupled files (shared context >70%)
- Natural implementation sequence with no intermediate verification point
- Same severity tier

Split into separate tasks when:
- Different domain (config/types vs logic vs auth vs API layer)
- Strong output dependency (one task's output is another's input) — express via `depends_on`
- Justified tier difference
- High-stakes scope that deserves its own adversarial review

**Size heuristic:** a task that would produce >400 lines of diff is likely too large — split it. A task <30 lines can probably merge with its neighbor.

Order tasks topologically: each task's `depends_on` must reference only tasks that appear earlier in the array.

---

## Step 3 — Derive locked_tests from ACs

For every AC in the spec, derive at least one entry in `locked_tests` for the task that covers it.

**A locked_test pins observable behavior — not that code ran.** The harness already proves the code *executes* (`tsc` + the test passing). The locked_test's job is to prove it does the *right thing*. So every locked_test must assert an **observable effect**: the response body or returned value, the persisted state, the emitted event, the error actually surfaced. A test that only asserts a status code, that a value `isDefined`/`toBeTruthy`, or that a call "does not throw" is **theatre** — it goes green while proving nothing, and a cheap executor will write exactly that to pass the gate. Reject it.

**Shape:** each `locked_test` is an **object** `{ "test_path": "...", "assertion": "..." }`:
- `assertion` — Given/When/Then reducible to one assertion on an observable: Given `<precondition>`, When `<action>`, Then `<observable outcome with a concrete value>`.
- `test_path` — the **test file the executor will author** (TDD: write it red, implement to green, then it is frozen). It must be writable by the executor — **within `scope_paths`** or the project's test directory (if a separate test dir, add it to the task's `scope_paths`). Multiple assertions may share one `test_path`.

```json
"locked_tests": [
  { "test_path": "test/shorten.test.ts", "assertion": "Given a valid URL, When POST /shorten, Then 201 with body {slug, short_url} where short_url ends with slug" }
]
```

**Good locked_test:** concrete, machine-verifiable, asserts the observable.
- "POST /shorten with valid URL returns 201 AND body `{slug, short_url}` where short_url ends with slug"
- "GET /:slug with unknown slug returns 404 with body `{error}` (not a 500, not an empty 200)"
- "after POST /shorten, the slug is readable via GET /:slug and 301-redirects to the original URL"

**Bad locked_test (reject these):**
- "the feature works correctly" / "error handling is implemented" — not verifiable
- "POST /shorten returns 201" — status only, never checks the body it must return
- "expect(result).toBeDefined()" / "toBeTruthy()" — passes for any non-null garbage
- "the handler does not throw" — absence of a crash is not correctness
- "follow best practices" — not a test

Rules:
- Every AC must map to at least one locked_test in some task.
- Each locked_test asserts an **observable** (body / returned value / persisted state / surfaced error) — never status-or-existence alone.
- A locked_test must be traceable to a `criterion_refs` entry on the same task.
- Every locked_test carries a `test_path` the executor can write (within `scope_paths` or the project test dir).
- The executor **authors** the test file from the assertion (red→green); **after authoring** it is frozen — the executor cannot edit or relax it. It is the deterministic gate.

---

## Step 4 — Classify severity (blast radius)

`severity` is the **blast-radius** signal: how much damage a defect here could cause. It drives the **review posture** — the adversarial decision (Step 5), the `final_review.security` flag (Step 8), reviewer rigor — **not** the executor model. The executor model is set separately by `complexity` (Step 4b).

| Severity | When |
|---|---|
| **low** | Config, types, schema, mechanical wiring, no branching logic |
| **medium** | Standalone business logic, CRUD endpoints, data transformation |
| **high** | Auth, payment, data integrity, concurrency, input from untrusted sources, complex domain logic |

When in doubt between medium and high, pick high — a wrong downgrade of scrutiny is more expensive than a wrong upgrade.

---

## Step 4b — Classify complexity (executor model)

`complexity` (low/medium/high) sets **only the executor model**, resolved from `model_strategy.tiers[complexity]` at dispatch (absent → falls back to `severity`). It measures **residual reasoning**: how much thinking is left for the executor *after* the plan has already resolved every decision (`resolved_judgments`), pinned behavior (`locked_tests`), named scope (`scope_paths`), and stated acceptance (`criterion_refs`). A well-specified task has **low residual complexity even in a hard domain** — the planner (Opus) front-loaded the thinking, so the executor just implements. This is independent of `severity`. Bias DOWN: a rich plan + the Opus review net (adversary + compliance + security) mean a cheap executor suffices; paying Opus to *generate* as well is double-paying. The expensive reasoning belongs at the ends — **plan** and **review** — not the middle.

**Optional deterministic cross-check:** for a band you're unsure of, run `node .claude/skills/creating-plans/references/complexity-scorer.mjs <file>` — a dependency-free heuristic returning a `low/medium/high/x-high` band. It is **advisory** (your residual-reasoning judgment is primary, and it scores the whole file, not the delta — a large file barely touched over-scores); use a surprising score as a prompt to re-judge, and treat an `x-high` as a real signal to split.

| Complexity | Executor model | When |
|---|---|---|
| **low** | haiku | Trivial mechanical work — DDL/migration with no logic, constants/config/enums, a pure function fully covered by `locked_tests` |
| **medium** | sonnet | **The default.** Most tasks: standalone logic, CRUD, transforms, wiring |
| **high** | opus | **Reserved.** Genuinely complex AND not decomposable — atomic multi-pass logic, crash-safe state machines |

**Decompose before reaching for Opus.** If tempted to mark `complexity: high`, first try to split the task into smaller `medium` subtasks; keep `high` only when splitting is genuinely impossible. A high-`severity` task usually still runs a `medium`-`complexity` executor — severity raises *review*, not the executor model. `complexity` is **optional**: set it only where the residual reasoning diverges from `severity`; when absent, executor dispatch falls back to `tiers[severity]`.

---

## Step 5 — Decide adversarial.enabled

Default: `{ "enabled": false }`.

Set `enabled: true` **only** when the task touches at least one of:
- Authentication / authorization
- Payment or billing
- Data integrity (writes that must be atomic or consistent)
- Concurrency / race conditions
- External input that reaches storage or execution
- Secrets, tokens, or cryptographic operations

When `enabled: true`, populate `focus` with specific attack vectors (non-empty array):
```json
"adversarial": {
  "enabled": true,
  "focus": [
    "auth-bypass-on-delete-endpoint",
    "timing-attack-on-token-comparison",
    "open-redirect-via-malicious-url-payload"
  ]
}
```

Do **not** enable adversarial on config, types, or trivial wiring tasks — it adds cost with no signal.

---

## Step 6 — scope_paths, resolved_judgments, criterion_refs

**`scope_paths`** (glob array, min 1): the paths the executor may write or edit. The harness gate blocks writes outside these paths. Be specific — prefer `src/handlers/shorten.ts` over `src/**`.

**`resolved_judgments`** (object, key → scalar): every product or technical decision the executor would otherwise decide arbitrarily. Keys must be specific; values must be concrete scalars — never prose sentences.

```json
// GOOD
"resolved_judgments": {
  "slug_generation": "nanoid 6 chars alphanumeric",
  "redirect_status": 301,
  "timing_safe_comparison": true
}

// BAD — prose, not judgments
"resolved_judgments": {
  "approach": "Use nanoid to generate slugs and redirect with 301"
}
```

If a decision is genuinely open (the product has not resolved it), **stop and ask the user** before writing the task.

**`criterion_refs`** (array of `#ac-N.M` strings, min 1): the ACs this task is accountable for. Every AC in the spec must appear in at least one task's `criterion_refs`.

---

## Step 7 — Assemble model_strategy

Read the harness settings (project or global config). Freeze the resolved tier aliases into the plan. This snapshot is deterministic — orchestrating-delivery uses exactly this, ignoring later config changes.

Required shape (validated by `references/validate-plan.mjs`):
```json
"model_strategy": {
  "tiers": { "low": "haiku", "medium": "sonnet", "high": "opus" },
  "planner":       "opus",
  "plan-reviewer": "opus",
  "compliance":    "sonnet",
  "adversary":     "opus",
  "security":      "opus",
  "shipper":       "sonnet",
  "harvester":     "sonnet"
}
```

Note: `executor` and `sniper` are NOT listed here — they are tier-variable. The executor resolves from `tiers[task.complexity ?? task.severity]` (reasoning depth); the sniper resolves from `tiers[issue.severity]` (defect gravity).

---

## Step 8 — final_review and demo

**`final_review`:** `compliance` and `adversary` must both be `true` — they signal that after all tasks complete, the full pipeline runs end-to-end compliance and adversarial review of the entire feature. Add **`security: true`** when the feature's aggregate `scope_paths`/tasks hit a security trigger (sensitive-path allowlist, or an external HTTP client / service entrypoint / webhook / log surface) — this is the only security pass LIGHT mode gets, so set it whenever a security surface is touched. `security` is optional and defaults to `false`.
```json
"final_review": { "compliance": true, "adversary": true, "security": true }
```

**`demo`:** derived from the UJs in the spec, never from the implementation.
- `type`: `"smoke"` for API/CLI features; `"playwright"` for complex UI; `"markdown"` for batch/cron
- `scenarios_from_refs`: the `#uj-N` anchors that the demo must exercise (at least one)

---

## Step 9 — Self-review the plan

Before writing the file, verify:

1. **Root envelope present:** `version: "1.0"`, kebab-case `feature_id`, ISO-8601 `created_at`, and `mode` (from triage). The validator requires all four.
2. **AC coverage:** every `#ac-N.M` in the spec appears in at least one task's `criterion_refs`. List any gap — if found, add the missing task.
3. **locked_tests coverage:** every `criterion_ref` on a task has at least one locked_test (object `{test_path, assertion}`) derived from it.
4. **depends_on graph:** no dangling references (every dep ID exists in the tasks array), no cycles.
5. **resolved_judgments completeness:** no open decisions left as prose or empty values.
6. **scope_paths non-overlap:** tasks at the same DAG level (no dependency between them) do not share writable paths.
7. **model_strategy complete:** all 7 fixed roles present (incl. `plan-reviewer`); tiers populated.

---

## Step 10 — Validate before finalizing

Run the validator against the generated JSON. **Do not finalize the plan if validation fails.**

```bash
node .claude/skills/creating-plans/references/validate-plan.mjs <path-to-plan.json>
# Exit 0 = OK. Exit 1 = schema errors — fix and re-run.
```

The validator is dependency-free (Node builtins only — no install, no node_modules). It checks: required fields, type and enum constraints, `model_strategy` (tiers + 7 fixed roles incl. `plan-reviewer`, no executor/sniper), `criterion_refs` regex (`#ac-`), `resolved_judgments` scalar values, `locked_tests` as objects `{test_path, assertion}`, `adversarial.focus` when enabled, `final_review.security` (optional boolean), `depends_on` no-dangling-refs, and cycle detection.

---

## Revision mode (plan-reviewer REVISE)

When the orchestrator re-dispatches you with an **existing plan + plan-reviewer findings** (each finding carries a `task_id` and a `planner_instruction`), do **not** regenerate from scratch:

1. Load the existing `plan.json`.
2. Apply **each** `planner_instruction` to its target `task_id` (or plan-wide for `(plan-wide)` findings) — a **targeted edit**, nothing else.
3. Keep every untouched task **byte-stable** — do not re-derive tasks the reviewer did not flag.
4. Re-run Step 9 self-review and Step 10 validation, then return the revised plan.

Bounded by the orchestrator at 2 revision loops; if a finding cannot be satisfied, say so explicitly rather than churning the plan.

---

## Anti-patterns

- **Prose in resolved_judgments** — "use JWT with short TTL" is not a judgment. `{ "ttl_seconds": 900, "algorithm": "HS256" }` is.
- **Task scope too broad** — "implement the auth module" covers 4 concerns. Split by domain boundary.
- **locked_tests that assert nothing observable** — "error handling works" or "returns 201" (status only) are theatre. Assert the body / returned value / persisted state, not just a status code or that a value exists.
- **adversarial on trivial tasks** — config, types, schema wiring do not need adversarial review. Reserve it for high-risk tasks.
- **Incomplete model_strategy** — all 7 fixed roles must be present with tier aliases (incl. `plan-reviewer`). Partial snapshots break dispatch.
- **ACs without criterion_refs** — every AC must be owned by exactly one task. Unowned ACs mean unimplemented features.
- **resolved_judgments left open** — if you write `"algorithm": "TBD"`, stop and resolve it with the user before continuing.

---

## HARD-GATE — exit condition

The planner finalizes **only** when:
1. `validate-plan.mjs` exits 0 (schema valid)
2. Every AC has at least one `criterion_ref` in a task
3. Every task has at least one locked_test
4. No open `resolved_judgments` values

After the plan is valid, show a short summary to the user (in pt-br):

> "Plano gerado com N tasks (X high / Y medium / Z low). Tasks com adversarial: [IDs]. Próximo passo: aprovar e entregar ao orquestrador `orchestrating-delivery`."

**DO NOT write code. DO NOT invoke orchestrating-delivery directly. The only terminal action is handing the validated plan to the orchestrating-delivery skill.**
