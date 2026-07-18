---
name: creating-plans
description: "INTERNAL to the planner agent — NOT a main-loop skill. Do NOT invoke this directly from the orchestrator or main loop; instead dispatch the `planner` agent (always the planner model from routing), which runs this skill in isolation. Describes how the planner decomposes an approved spec/PRD into a validated execution-plan.json (atomic tasks, locked tests, severity tiers, adversarial flags, scope_paths) consumed by orchestrating-delivery."
source: adapted from pi-agent/skills/plan-make/SKILL.md
adaptation_date: 2026-06-01
---

<PLANNER-ONLY>
This skill runs ONLY inside the `planner` agent (always the planner model from routing), dispatched by orchestrating-delivery in Phase 1. If you are the main loop or the orchestrator and reached here directly, STOP: do not generate the plan yourself. **Dispatch the `planner` agent** and hand it the approved spec. Generating the plan in the main loop defeats the context isolation and the model routing the harness depends on (a cheap orchestrator must delegate architecture-grade reasoning to planner-tier model, not do it inline). The only exception is the `planner` agent itself running this skill.
</PLANNER-ONLY>

# Creating-Plans — Generating execution-plan.json from an approved spec

**This skill runs inside the planner agent (always the planner model from routing).** It does not write code and does not invoke orchestrating-delivery. Its only output is a validated `execution-plan.json`.

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

**Pinned-signature rule:** if an earlier task's locked_test pins a function's call signature, a later task must not add a required positional parameter to it — prefer an optional parameter with a default, or dependency injection, to preserve the pinned signature (see Step 3 on locked_tests).

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
- Every locked_test carries a `path` the test-author can write (within `scope_paths` or the project test dir).
- The **planner pins** the concrete assertion (the judgment); a cheap **test-author** (Ollama hand) transcribes it into the test file under **compliance fidelity validation** (the orchestrator loop). The planner does not author the test file and does not in-run-validate it — fidelity is the compliance eye's job, validated before freeze. After compliance PASS the test is frozen (content-hash MANIFEST); the executor receives it read-only and implements production code until the frozen test goes green. The executor cannot edit or relax the frozen test. It is the deterministic gate.
- A targeted Vitest gate names exactly one normalized repo-relative `locked_tests[].path`. Do not put `npx`, `npm exec`, `bunx`, `pnpm dlx`, globs, or forwarded runner options in the plan/brief. Emit `verify({ feature_id, task_id, denied_class: "targeted_vitest", test_path })`: top-level coordination receives only a descriptor; the runtime-bound active hand may execute the FD-pinned local Vitest entrypoint without Bash.
- An invariant with multiple branches/roles/states needs a locked_test per branch (one observable assertion each) — its locked_tests must cover ALL branches; a happy-path-only freeze is a gap.

> **Test path resolution:** a locked_test's test file must resolve repo paths module-relative via `resolve(dirname(fileURLToPath(import.meta.url)), "../...")` — never a hardcoded absolute path rooted at `/Users/` or `/home/`, which passes locally but reddens CI. See the executor / test-author guidance.

  > **Supersedes §3.7 'Chosen UX':** the orchestrator+compliance flow supersedes any prior description of the planner validating the test in-run. The planner's sole role is assertion-pinning; per-task fidelity validation belongs to compliance (a Claude eye).

---

## Step 3.1 — Migration and SQL locked_tests (cheap-hand rule)

When a task's `scope_paths` include `**/*.sql` or `**/migrations/**` **and** the task is routed to a cheap-hand executor (resolved from `tiers` in the model_strategy), a locked_test is mandatory and must be executable against a real database.

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

`complexity` (`low` | `medium` | `high` | `max`) sets **only the executor model**, resolved from `model_strategy.tiers[complexity]` at dispatch (absent → falls back to `severity`) — the executor is a HAND, never an eye. It measures **residual reasoning**: how much thinking is left for the executor *after* the plan has already resolved every decision (`resolved_judgments`), pinned behavior (`locked_tests`), named scope (`scope_paths`), and stated acceptance (`criterion_refs`). A well-specified task has **low residual complexity even in a hard domain** — the planner front-loaded the thinking, so the executor just implements. This is independent of `severity`. Bias DOWN: a rich plan + the review net (adversary + compliance + security) mean a cheaper executor usually suffices. **`max` (scorer 46–60) still dispatches `executor-high`** — there is no separate `executor-max` agent.

**Optional deterministic cross-check:** for a band you're unsure of, run the OC tool `complexity-scorer` (or shared complexity-scorer) — a dependency-free heuristic returning a `low/medium/high/max/split` band. It is **advisory** (your residual-reasoning judgment is primary, and it scores the whole file, not the delta — a large file barely touched over-scores); use a surprising score as a prompt to re-judge, and treat `split`/`x-high` as a real signal to split.

| Complexity | Executor hand | When |
|---|---|---|
| **low** | `executor-low` | Trivial mechanical work — DDL/migration with no logic, constants/config/enums, a pure function fully covered by `locked_tests` |
| **medium** | `executor-medium` | **The default.** Most tasks: standalone logic, CRUD, transforms, wiring |
| **high** | `executor-high` | Genuinely complex AND not decomposable — atomic multi-pass logic, crash-safe state machines |
| **max** | `executor-high` (same model as high) | Scorer band 46–60; still not decomposable — do **not** invent `executor-max` |

**Decompose before reaching for the high hand.** If tempted to mark `complexity: high` or `max`, first try to split the task into smaller `medium` subtasks; keep high/max only when splitting is genuinely impossible. A high-`severity` task usually still runs a `medium`-`complexity` executor — severity raises *review*, not the executor model. `complexity` is **optional**: set it only where the residual reasoning diverges from `severity`; when absent, executor dispatch falls back to `tiers[severity]`.

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

Read the harness routing (`harness.routing.json` / AGENTS.md). Freeze **abstract role/tier keys** into the plan — never Claude tier names (`haiku`/`sonnet`/`opus`) and never model provider slugs inside `tiers` values. This snapshot is deterministic — orchestrating-delivery uses exactly this, ignoring later config changes.

**OC shape — `tiers` + fixed eye roles (abstract names):**

```json
"model_strategy": {
  "tiers": { "low": "low", "medium": "medium", "high": "high", "max": "max" },
  "planner": "planner",
  "plan_reviewer": "plan-reviewer-family-1",
  "compliance": "compliance",
  "adversary": "adversary-family-1",
  "security": "security",
  "shipper": "shipper",
  "harvester": "harvester"
}
```

`tiers` VALUES are bare keys (`low`/`medium`/`high`/`max`), **never** prefixed (`"executor-low"` would dispatch `executor-executor-low`). The shared `validate-plan` rejects `haiku`/`sonnet`/`opus` inside `tiers`/`hand_tiers`, rejects legacy top-level `low`/`medium`/`high` keys, and rejects fixed `executor`/`sniper` keys.

**Hand roles (executor and sniper):**
- `executor` resolves from `tiers[task.complexity ?? task.severity]` at dispatch (`max` → `executor-high`)
- `sniper` resolves from `tiers[issue.severity]` at dispatch
- Both hand roles are **never** listed explicitly in model_strategy — they resolve from the `tiers` map at dispatch

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
3. **locked_tests coverage:** every `criterion_ref` on a task has at least one locked_test (object `{id, path, assertion, fixture_paths?}`) derived from it.
4. **depends_on graph:** no dangling references (every dep ID exists in the tasks array), no cycles.
5. **resolved_judgments completeness:** no open decisions left as prose or empty values.
6. **scope_paths non-overlap:** tasks at the same DAG level (no dependency between them) do not share writable paths.
7. **model_strategy complete:** all 7 fixed roles present; `tiers` populated with bare keys (no Claude slugs).

---

## Step 10 — Validate before finalizing

Run the validator against the generated JSON. **Do not finalize the plan if validation fails.**

**Prefer the OC native tool** `validate-plan` (args: `path` and/or inline `plan`, optional `expect`). CLI fallback:

```bash
node core/shared/lib/validate-plan.mjs <path-to-plan.json>
# Exit 0 = OK. Exit 1 = schema errors — fix and re-run.
```

The shared validator (`core/shared/lib/validate-plan.mjs`) is dependency-free and the contract source of truth. It checks: required fields, type and enum constraints, `model_strategy` (no haiku/sonnet/opus in tier maps, no executor/sniper fixed keys, no legacy top-level tiers), complexity `low|medium|high|max`, `locked_tests` as objects `{id, path, assertion, fixture_paths?}`, cycle detection on `depends_on`.

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
- **Incomplete model_strategy** — all 7 fixed roles must be present; `tiers` uses bare keys (no Claude slugs). Partial snapshots break dispatch.
- **ACs without criterion_refs** — every AC must be owned by exactly one task. Unowned ACs mean unimplemented features.
- **resolved_judgments left open** — if you write `"algorithm": "TBD"`, stop and resolve it with the user before continuing.

---

## HARD-GATE — exit condition

The planner finalizes **only** when:
1. OC tool `validate-plan` (or CLI `node core/shared/lib/validate-plan.mjs`) returns ok (schema valid)
2. Every AC has at least one `criterion_ref` in a task
3. Every task has at least one locked_test (`{id, path, assertion}`)
4. No open `resolved_judgments` values

After the plan is valid, show a short summary to the user (in pt-br):

> "Plano gerado com N tasks (X high / Y medium / Z low). Tasks com adversarial: [IDs]. Próximo passo: aprovar e entregar ao orquestrador `orchestrating-delivery`."

**DO NOT write code. DO NOT invoke orchestrating-delivery directly. The only terminal action is handing the validated plan to the orchestrating-delivery skill.**
