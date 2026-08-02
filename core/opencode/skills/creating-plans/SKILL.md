---
name: oc-creating-plans
description: "INTERNAL to the planner agent — NOT a main-loop skill. Do NOT invoke this directly from the orchestrator or main loop; instead dispatch the `planner` agent (always the planner model from routing), which runs this skill in isolation. Describes how the planner decomposes an approved spec/PRD into a validated execution-plan.json (atomic tasks, locked tests, severity tiers, adversarial flags, scope_paths) consumed by orchestrating-delivery."
source: adapted from pi-agent/skills/plan-make/SKILL.md
adaptation_date: 2026-06-01
---

<PLANNER-ONLY>
This skill runs ONLY inside the `planner` agent (always the planner model from routing), dispatched by orchestrating-delivery in Phase 1. If you are the main loop or the orchestrator and reached here directly, STOP: do not generate the plan yourself. **Dispatch the `planner` agent** and hand it the approved spec. Generating the plan in the main loop defeats the context isolation and the model routing the harness depends on (a cheap orchestrator must delegate architecture-grade reasoning to planner-tier model, not do it inline). The only exception is the `planner` agent itself running this skill.
</PLANNER-ONLY>

# Creating-Plans — Generating execution-plan.json from an approved spec

**This skill runs inside the planner agent (always the planner model from routing).** It does not write code, invoke orchestrating-delivery, or write a model-owned plan file. Its only output is exactly one validated JSON `execution-plan.json` returned in the reply; `planner-recovery` persists it.

**Announce at the start (in pt-br):** "Usando creating-plans para gerar o execution-plan.json a partir da spec aprovada."

**Pre-requisite:** approved spec/PRD with user journeys (UJs), acceptance criteria (ACs), and constraints.

**Contract source of truth (executable):** shared `validate-plan` (OC native tool `validate-plan`, or `core/shared/lib/validate-plan.mjs`).
**Valid example:** `references/example-plan.json` (if present) or schema self-check below.

User-facing messages are always in pt-br. All identifiers, JSON keys, file paths, and reasoning stay in English.

---

## Step 1 — Read the spec

Extract and list explicitly:
- User journeys (`#uj-N`) — these drive `demo.scenarios_from_refs`
- Acceptance criteria (`#ac-N.M`) — these drive `locked_tests` and `criterion_refs`
- Constraints and resolved product decisions — these seed `resolved_judgments`

If any AC is ambiguous (no testable outcome):
**INTERACTIVE:** stop and ask the user (in pt-br) before proceeding.
**HEADLESS:** there is no user to ask. Resolve the ambiguity yourself — pick the most defensible testable outcome for the AC and carry it forward; when you build the task that owns this AC (Step 6), write the resolution into that task's `resolved_judgments` and list its key in `resolved_judgments_model_resolved`. Both are task-level fields, so there is nothing to write yet at this step. Never return without a plan and never leave the AC without a stated, testable outcome.

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

**Pinned-signature rule:** if an earlier task's locked_test pins a function's call signature, a later task must not add a required positional parameter to it — prefer an optional parameter with a default, or dependency injection, to preserve the pinned signature (see Step 3 on locked_tests).

**Satisfiable-at-its-own-boundary rule — a plan that breaks it cannot be executed.** Every locked_test must pass with ONLY its owning task's changes in place, and nothing from a later task. A test that asserts a **stored type or a storage round-trip** therefore needs the schema/fixture change in the **same** task: a fixture that still creates the column with the old affinity coerces the value back and the test fails at its own boundary. Live failure: a plan split "convert the writer" (`task-2a`) from "convert the fixture" (`task-2b`) while `task-2a`'s locked tests asserted SQLite `typeof(...) = 'integer'` — `task-2a` could not pass its own tests, the same defect repeated in `task-4a`/`task-4b`, and three review rounds died on it. If you are deferring a fixture or schema change that one of your own locked_tests depends on, either move that change into the owning task or move the assertion to the task that owns the change. Never count on the executor "getting there in the next task".

Order tasks topologically: each task's `depends_on` must reference only tasks that appear earlier in the array.

---

## Step 3 — Derive locked_tests from ACs

For every AC in the spec, derive at least one entry in `locked_tests` for the task that covers it.

**A locked_test pins observable behavior — not that code ran.** The harness already proves the code *executes* (`tsc` + the test passing). The locked_test's job is to prove it does the *right thing*. So every locked_test must assert an **observable effect**: the response body or returned value, the persisted state, the emitted event, the error actually surfaced. A test that only asserts a status code, that a value `isDefined`/`toBeTruthy`, or that a call "does not throw" is **theatre** — it goes green while proving nothing, and a cheap executor will write exactly that to pass the gate. Reject it.

**Shape:** each `locked_test` is an **object** `{ "id", "path", "assertion", "fixture_paths?" }` (shared `validatePlan` is the source of truth — do **not** use legacy `test_path`):
- `id` — stable kebab id (e.g. `lt-shorten-201`) unique within the task.
- `path` — the **test file the TEST-AUTHOR transcribes** (a cheap hand transcribes the pinned assertions; the file is then frozen). After freeze, the **executor receives it READ-ONLY** — it never authors or edits the test. The path must live **within `scope_paths`** or the project's test directory (if a separate test dir, add it to the task's `scope_paths`). Multiple assertions may share one `path` — the test-author is dispatched ONCE per distinct `path` and transcribes ALL of that path's assertions into the single file.
- `assertion` — Given/When/Then reducible to one assertion on an observable: Given `<precondition>`, When `<action>`, Then `<observable outcome with a concrete value>`.
- `fixture_paths` (**optional** array of exact repo-relative paths) — when an assertion needs support data (an input data file, a snapshot, a sample the assertion references by name), **enumerate the fixture files here**. The test-author is then permitted to write exactly these files, and they are captured in the freeze manifest's dependency closure. Omit when the test needs no support data. Do NOT leave a fixture the test reads unenumerated — an unfrozen dependency breaks the deterministic gate.

```json
"locked_tests": [
  { "id": "lt-shorten-201", "path": "test/shorten.test.ts", "assertion": "Given a valid URL, When POST /shorten, Then 201 with body {slug, short_url} where short_url ends with slug" },
  { "id": "lt-import-csv", "path": "test/import.test.ts", "assertion": "Given the sample CSV, When POST /import, Then 200 with body {imported: 3}", "fixture_paths": ["test/fixtures/sample.csv"] }
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
- **Never pin an invariant the spec did not ask for.** Locked tests come from the ACs — no exceptions. If the codebase convinces you an EXTRA invariant is needed for the ACs to hold, express it as a `resolved_judgment` (a scalar the executor must honour) and explain it in the task description — never as a locked_test, never as a new AC. Live failure: a planner invented a "single clock" contract and pinned it with a locked_test asserting `Date.now()` is called exactly once in the inbound path, when the spec only required each write to use `Math.floor(Date.now() / 1000)`. Its own scope left three wrappers sampling the clock independently, so the test it wrote was unsatisfiable — and the review loop burned three rounds on a contradiction the plan itself introduced, then escalated a choice that only existed because of the invention. A locked_test no AC demands is scope creep with a test around it.
- **A locked_test must be satisfiable at its own task's boundary** (see the rule in Step 2): with only that task's changes applied, it passes.
- Every locked_test carries a `path` the test-author can write (within `scope_paths` or the project test dir).
- The **planner pins** the concrete assertion (the judgment); the dedicated **test-author** transcribes it into the test file under **compliance fidelity validation** (the orchestrator loop). The planner does not author the test file and does not in-run-validate it — fidelity is the compliance eye's job, validated before freeze. After compliance PASS the test is frozen (content-hash MANIFEST); the executor receives it read-only and implements production code until the frozen test goes green. The executor cannot edit or relax the frozen test. It is the deterministic gate.
- A targeted Vitest gate names exactly one normalized repo-relative `locked_tests[].path`. No globs, no forwarded runner options. The parent conductor runs it after the hand returns (`npx vitest run <path>`, the project's own test command, etc.), scoped to that one path only; executors and snipers do not receive Bash.
- An invariant with multiple branches/roles/states needs a locked_test per branch (one observable assertion each) — its locked_tests must cover ALL branches; a happy-path-only freeze is a gap.

> **Test path resolution:** a locked_test's test file must resolve repo paths module-relative via `resolve(dirname(fileURLToPath(import.meta.url)), "../...")` — never a hardcoded absolute path rooted at `/Users/` or `/home/`, which passes locally but reddens CI. See the executor / test-author guidance.

  > **Supersedes §3.7 'Chosen UX':** the orchestrator+compliance flow supersedes any prior description of the planner validating the test in-run. The planner's sole role is assertion-pinning; per-task fidelity validation belongs to compliance (a Claude eye).

---

## Step 3.1 — Migration and SQL locked_tests (cheap-hand rule)

When a task's `scope_paths` include `**/*.sql` or `**/migrations/**` and is routed to a cheap-hand executor by its complexity/severity key, a locked_test is mandatory and must be executable against a real database.

**Requirement:** each migration locked_test must:
1. **Spin up an ephemeral database** (in-memory SQLite, Docker container, or cloud sandbox) at a known baseline schema state.
2. **Apply the migration** against that baseline.
3. **Assert post-migration state** (schema changes, constraints, indexes, created rows, etc.) — **NOT a text-match assertion on the migration file itself**.

A locked_test that only reads the migration file and checks for keywords ("CREATE TABLE", "ADD COLUMN", "ALTER", etc.) is **theatre** — it proves the file was written but not that the migration is correct, syntactically valid, or even executable. The deterministic rail only works if the frozen test proves the migration *executes* and leaves the database in the expected state.

This rule closes the cheap-hand SQL gap: a tester eye (compliance, before freeze) cannot execute DDL in the schema checker (tsc/lint do not run databases), so the frozen locked_test itself becomes the deterministic gate that the executor cannot relax, rewrite, or weaken. The executor only passes when the migration actually works.

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

`complexity` (`low` | `medium` | `high` | `max`) selects only the executor dispatch key (absent → `severity`; `max` → high). The frozen `hand_tiers` values are model slugs, not agent suffixes.

**Optional deterministic cross-check:** for a band you're unsure of, run the OC tool `complexity-scorer` (or shared complexity-scorer) — a dependency-free heuristic returning a `low/medium/high/max/split` band. It is **advisory** (your residual-reasoning judgment is primary, and it scores the whole file, not the delta — a large file barely touched over-scores); use a surprising score as a prompt to re-judge, and treat `split`/`x-high` as a real signal to split.

| Complexity | Executor hand | When |
|---|---|---|
| **low** | `executor-low` | Trivial mechanical work — DDL/migration with no logic, constants/config/enums, a pure function fully covered by `locked_tests` |
| **medium** | `executor-medium` | **The default.** Most tasks: standalone logic, CRUD, transforms, wiring |
| **high** | `executor-high` | Genuinely complex AND not decomposable — atomic multi-pass logic, crash-safe state machines |
| **max** | `executor-high` (same model as high) | Scorer band 46–60; still not decomposable — do **not** invent `executor-max` |

**Decompose before reaching for the high hand.** If tempted to mark `complexity: high` or `max`, first try to split the task into smaller `medium` subtasks; keep high/max only when splitting is genuinely impossible. A high-`severity` task usually still runs a `medium`-`complexity` executor — severity raises *review*, not the executor model. `complexity` is **optional**: set it only where the residual reasoning diverges from `severity`; when absent, executor dispatch falls back to the severity key (`low`, `medium`, or `high`; `max` maps to `high`).

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

**`scope_paths`** (array of **exact file or directory paths**, min 1 — a directory entry conventionally ends with `/`, but the trailing slash is cosmetic: coverage follows **git-pathspec** semantics, so `src/handlers` and `src/handlers/` cover identically. These are **NOT globs**: the scope and allowed-write checks match by exact file OR directory prefix (by path component), not glob expansion. The same convention governs the pre-spawn guard and the capture scope check — one source of truth). The paths the executor may write or edit; the harness gate blocks writes outside them. Be specific — prefer `src/handlers/shorten.ts` (exact file) or `src/handlers/` (directory prefix) over a broad parent.

**Bug-fix scope rule:** when a task is a bug fix, locate the shared function the reported symptom routes through and confirm `scope_paths` covers **every caller the fix affects** — size the fix at the root, not the ticketed call site. Patching only the path the ticket names leaves sibling callers of the same function broken.

**Env/secret scope rule:** when a new env/secret var is consumed in tests, `scope_paths` MUST include all the files that make it usable — trace the project's actual topology (in a TS project typically three: test config + test-env types + runtime env types), never only the 1-2 files the test directly imports.

**`resolved_judgments`** (object, key → scalar): every product or technical decision the executor would otherwise decide arbitrarily. Keys must be specific; values must be concrete scalars — never prose sentences.

**HEADLESS:** there is no user to ask, in this step or any other. When you resolve a decision yourself instead of stopping (see the HEADLESS branches throughout this skill), track it: add the `resolved_judgments` key to the task-level array `resolved_judgments_model_resolved`, so compliance/adversary/PR review can tell an engine-made call apart from an operator-given one. Also state the resolution and its rationale in the task `description`. Neither is ever a reason to withhold the plan.

**`resolved_judgments_model_resolved`** (optional array of strings, task-level): the keys of **this same task's** `resolved_judgments` that the engine resolved with no operator input. Absent or `[]` is valid and is what an interactive run emits — the field never breaks an existing plan. A key the task does not resolve is an orphan: `validate-plan` rejects the plan naming the key. The `shipper` reads the marked keys (and their values) into a dedicated PR-body section, so the operator can veto an engine-made call before the merge.

```json
"resolved_judgments": { "ttl_seconds": 900, "algorithm": "HS256" },
"resolved_judgments_model_resolved": ["algorithm"]
```

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

If a decision is genuinely open (the product has not resolved it):
**INTERACTIVE:** stop and ask the user before writing the task.
**HEADLESS:** resolve it yourself with the most defensible technical default, write the concrete scalar into `resolved_judgments`, and add its key to `resolved_judgments_model_resolved`. Only a pure product trade-off with no defensible technical answer skips resolution — write the task anyway with your best default and note the trade-off in the task description so it surfaces as an open risk in the PR body; the plan is never withheld for it.

**`criterion_refs`** (array of `#ac-N.M` strings, min 1): the ACs this task is accountable for. Every AC in the spec must appear in at least one task's `criterion_refs`.

---

## Step 7 — Assemble model_strategy

Copy the exact routing snapshot appended by `planner-recovery`; do not reread routing or guess models. This snapshot is deterministic and the host adapter validates it before persisting the return.

**OC shape — exact `hand_tiers` plus fixed eye models:**

```json
"model_strategy": {
  "hand_tiers": { "low": "openai/gpt-5.6-luna", "medium": "openai/gpt-5.6-luna", "high": "openai/gpt-5.6-terra" },
  "planner": "<routing primary model>",
  "plan-reviewer": "<routing primary model>",
  "compliance": "<routing primary model>",
  "adversary": "<routing primary model>",
  "security": "<routing primary model>",
  "shipper": "<routing primary model>",
  "harvester": "<routing primary model>",
  "fallback": "optional opaque JSON"
}
```

`hand_tiers` must be exactly the three executor-tier values in the supplied snapshot; the values above are the default routing example. The seven hyphenated eye keys must exactly match that snapshot. `fallback` is optional opaque JSON. Legacy `tiers`, `plan_reviewer`, `executor`, `sniper`, top-level hand keys, and unknown keys are rejected.

**Hand roles (executor and sniper):**
- `executor` and `sniper` select their dispatch tier elsewhere; `max` maps to high.
- Neither hand role appears as a top-level strategy key.

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

Before returning the JSON, verify:

1. **Root envelope present:** `version: "1.0"`, `feature_id`, ISO-8601 `created_at`, and `mode` (from triage). The validator requires all four. `feature_id` is **not yours to choose**: copy the `[HARNESS_SESSION_FEATURE_ID]` value from the dispatch brief verbatim. The gate compares it for exact equality and refuses the entire plan on any difference — a renamed feature (even a more accurate one) spends the attempt and leaves the canonical plan untouched.
2. **AC coverage:** every `#ac-N.M` in the spec appears in at least one task's `criterion_refs`. List any gap — if found, add the missing task.
3. **locked_tests coverage:** every `criterion_ref` on a task has at least one locked_test (object `{id, path, assertion, fixture_paths?}`) derived from it.
4. **depends_on graph:** no dangling references (every dep ID exists in the tasks array), no cycles.
5. **resolved_judgments completeness:** no open decisions left as prose or empty values. Every key you resolved yourself (HEADLESS) is listed in the same task's optional `resolved_judgments_model_resolved`, and every entry there is a key that task actually resolves.
6. **scope_paths non-overlap:** tasks at the same DAG level (no dependency between them) do not share writable paths.
7. **model_strategy complete:** exact `hand_tiers` and all 7 fixed hyphenated eye roles match the supplied routing snapshot.

---

## Step 10 — Validate before finalizing

Run the validator against the generated inline JSON or its read-only canonical path. **Do not finalize the plan if validation fails.**

**Prefer the OC native tool** `validate-plan` (args: `path` and/or inline `plan`, optional `expect`). CLI fallback:

```bash
node core/shared/lib/validate-plan.mjs <path-to-plan.json>
# Exit 0 = OK. Exit 1 = schema errors — fix and re-run.
```

The shared validator (`core/shared/lib/validate-plan.mjs`) is dependency-free and the contract source of truth. It checks: required fields, type and enum constraints, `model_strategy` (no haiku/sonnet/opus in tier maps, no executor/sniper fixed keys, no legacy top-level tiers), complexity `low|medium|high|max`, `locked_tests` as objects `{id, path, assertion, fixture_paths?}`, cycle detection on `depends_on`, and the optional `resolved_judgments_model_resolved` (array of strings, each an existing key of the same task's `resolved_judgments`).

---

## Revision mode (plan-reviewer REVISE)

When the orchestrator re-dispatches you with an **existing plan + plan-reviewer findings** (each finding carries a `task_id` and a `planner_instruction`), do **not** regenerate from scratch:

1. Read the existing canonical plan JSON; do not write a replacement file yourself.
2. Apply **each** `planner_instruction` to its target `task_id` (or plan-wide for `(plan-wide)` findings) — a **targeted edit**, nothing else.
3. Keep every untouched task **byte-stable** — do not re-derive tasks the reviewer did not flag.
4. Re-run Step 9 self-review and Step 10 validation, then return the revised plan.

On REVISE, revise the plan against the reviewer's stated findings and return it for another review. If a finding requires a product decision, record it explicitly in the plan and ask the operator rather than inventing a runtime budget.

---

## Anti-patterns

- **Prose in resolved_judgments** — "use JWT with short TTL" is not a judgment. `{ "ttl_seconds": 900, "algorithm": "HS256" }` is.
- **Task scope too broad** — "implement the auth module" covers 4 concerns. Split by domain boundary.
- **locked_tests that assert nothing observable** — "error handling works" or "returns 201" (status only) are theatre. Assert the body / returned value / persisted state, not just a status code or that a value exists.
- **adversarial on trivial tasks** — config, types, schema wiring do not need adversarial review. Reserve it for high-risk tasks.
- **Incomplete model_strategy** — `hand_tiers` must be exactly low/medium/high approved slugs and all 7 fixed roles must be present. Legacy `tiers` is rejected. Partial snapshots break dispatch.
- **ACs without criterion_refs** — every AC must be owned by exactly one task. Unowned ACs mean unimplemented features.
- **resolved_judgments left open** — if you write `"algorithm": "TBD"`, resolve it before continuing: **INTERACTIVE** stop and ask the user; **HEADLESS** pick the most defensible default yourself and add the key to `resolved_judgments_model_resolved`. `TBD` is never a valid value in either mode.

---

## HARD-GATE — exit condition

The planner finalizes **only** when:
1. OC tool `validate-plan` (or CLI `node core/shared/lib/validate-plan.mjs`) returns ok (schema valid)
2. Every AC has at least one `criterion_ref` in a task
3. Every task has at least one locked_test (`{id, path, assertion}`)
4. No open `resolved_judgments` values

After the plan is valid, show a short summary to the user (in pt-br):

> "Plano gerado com N tasks (X high / Y medium / Z low). Tasks com adversarial: [IDs]."

**DO NOT write code. DO NOT invoke orchestrating-delivery directly. The only terminal action is handing the validated plan to the orchestrating-delivery skill.**
