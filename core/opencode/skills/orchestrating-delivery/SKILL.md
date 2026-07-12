---
name: orchestrating-delivery
description: "Drives the LIGHT and FULL delivery loop — spec, plan, per-task executor/compliance/adversary/sniper cycle, final dual review, demo, and harvest. Dispatches one subagent per role via the task tool; never writes code itself. Invoked by triaging-requests for LIGHT/FULL; QUICK runs inline and never reaches this skill."
license: MIT
compatibility: opencode
metadata:
  phase: delivery
  gate: hard
---

# Orchestrating-Delivery — The maestro of the development loop

**This skill is the conductor, not a worker.** It dispatches a fresh subagent per role/task via the `task` tool, reads each structured output, and decides the next step. It does **not** implement, validate, or attack — those are the agents (`executor-low/medium/high`, `test-author`, `compliance`, `adversary` + dual eyes, `sniper-low/medium/high`, `security`, `shipper`, `harvester`). It owns the human HARD-GATES and the curation of layered context.

**Announce at the start (pt-br):** "Usando orchestrating-delivery para conduzir a entrega no modo <LIGHT|FULL>."

Invoked by `triaging-requests` for **LIGHT** and **FULL**. QUICK never reaches here (it runs inline, dispatching a single `executor-low`/`executor-medium` + gates + `shipper`).

> ⚠️ Invalid `subagent_type` returns an **explicit error** on OC 1.17.18 — still use exact tier names; do not rely on fuzzy match. NEVER dispatch a bare `executor` or `sniper`; always the exact tiered name (`executor-low`, `executor-medium`, `executor-high`, `sniper-low`, `sniper-medium`, `sniper-high`).

All identifiers, JSON keys, and internal reasoning stay in **English**. **Every message to the operator — checkpoints, demo, critical exceptions — is pt-br, product-language** (impact/tradeoffs/user behavior), never code-language.

---

## Position in the system

```
triaging-requests  →  orchestrating-delivery (you)  →  agents (workers)
                       owns: HARD-GATES + context curation + loop control
```

The operator is a product manager, not a developer. Engineering problems are solved **inside the system** (escalate tier, retry, sniper). The human is asked **only** product decisions (§ Human checkpoints).

---

## Macro-flow

```
brainstorm+spec → HARD-GATE 1 → plan (planner → validate-plan → plan-reviewer → deterministic override)
  → HARD-GATE 2 → per-task loop → final dual review → demo → HARD-GATE 3 → harvest → ship
```

HARD-GATES (human, pt-br, product-language): **approve spec → approve plan → test demo**. The loop between those gates is fully autonomous.

---

## Dispatchable subagents (exact names only)

| Role | Exact `subagent_type` names |
|---|---|
| Plan | `planner`, `plan-reviewer`, `plan-reviewer-openai` |
| Implement | `executor-low`, `executor-medium`, `executor-high`, `test-author` |
| Verify | `compliance`, `adversary`, `adversary-openai`, `security` |
| Fix | `sniper-low`, `sniper-medium`, `sniper-high` |
| Close | `harvester`, `shipper` |

There is **NO** single `executor` or `sniper` agent — tiered names only. Tier is chosen by you at dispatch; it is never hardcoded in the plan.

### Dual-always (plan-reviewer + adversary)

Always dispatch **both** primary and OpenAI dual eyes for plan-reviewer and adversary (ADR-003). Task tool has no model field — dual = two agent files.

**Runtime module:** `dual-runtime.mjs` in this skill folder — `driveDualEye`, `mergeDualFindings`, `mergeDualVerdicts`, `virginSecondaryBrief`, `isFullDualCoverage`, `dualStatusGatePatch`.

| Step | Action |
|---|---|
| 1 | Dispatch primary (`plan-reviewer` / `adversary`) |
| 2 | Dispatch secondary (`plan-reviewer-openai` / `adversary-openai`) with **virgin** brief — same contract, no primary verdict, no compliance output, no `shared_context` |
| 3 | On secondary auth/unavailable → `dual_status: "primary_only_failopen"`; keep primary findings only; **never invent** secondary findings; warn operator (pt-br) |
| 4 | On secondary infra error (rate limit / 5xx / crash) → `dual_status: "primary_only_error"`; **retry secondary once (K=1)**; if retry ok → upgrade to `both` + merge; if retry fails → keep primary only + warn; continue loop |
| 5 | On both ok → merge via policy B (shared `finalizeFindings` / `mergeVerdicts`); `dual_status: "both"` |
| 6 | Gate-state records **enum only**: `both` \| `primary_only_failopen` \| `pending` \| `primary_only_error` — never bare boolean. `primary_only_failopen` is **not** full dual coverage |

Never skip the second family when configured. Never treat fail-open as cross-family coverage for metrics.

---

## Native tools (run directly, not via Task)

- `complexity-scorer` — scores a file path on a 0–60+ scale (0–10 low · 11–30 medium · 31–45 high · 46–60 max→`executor-high` · 61+ split). One call per path.
- `validate-plan` — deterministic structural gate for `execution-plan.json`: per-task presence of `criterion_refs` + `locked_tests`, acyclic + topologically-ordered `depends_on`, scalar `resolved_judgments`, valid tiers (no Claude slugs), `adversarial.focus` when enabled, `demo` shape. Does NOT check spec-AC semantic coverage — that is the plan-reviewer's job.
- **Bash gates** — `npm run typecheck` (tsc --noEmit), `npm test`, lint. Deterministic; no LLM in the gate.

---

## File writes — bash only

`build`'s `edit` permission is **denied**. ALL file writes use bash with `cat >` / heredoc:

```bash
mkdir -p ".opencode/plans/<sessionID>-<feature_id>"
cat > ".opencode/plans/<sessionID>-<feature_id>/execution-plan.json" << 'EOF'
{ ... }
EOF
```

Never use the edit tool.

---

## Phase 0 — Brainstorm + spec

1. Read the native durable index — global/project `AGENTS.md` and any root router table (folder → what lives there). This is your macro view.
   - **Cold-start check:** if this is a non-trivial existing codebase and the index is cold (no entries in MEMORY.md, root router unfilled), dispatch the `surveying-codebase` skill **first** to seed durable knowledge from the code, then read the now-populated index before shaping the spec.
2. **Load and follow the `brainstorming` skill.** It elicits the operator's non-codifiable decisions one question at a time, proposes 2–3 approaches, presents the design for approval, and produces the spec (`#uj-N` user journeys, `#ac-N.M` acceptance criteria, constraints, and a **locked-decisions** section the operator owns). Because brainstorming asks the operator and waits, it runs here in `build` (primary), never in a headless subagent.
3. Write the spec file **via bash** (`cat >`) — `edit` is denied.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does AND surface **each locked decision in plain product terms** (e.g. "a foto não repete por X dias — confirma?"). The operator validates the decisions themselves, not just the framing. **Do not show code or schema.**

---

## Phase 1 — Plan

1. Dispatch `planner` via Task with the approved spec. The planner returns one `execution-plan.json` (schema in `planner.md`; the planner self-validates structure first).

2. **CANONICAL PATH — write/overwrite the full plan at:**
   ```
   .opencode/plans/<sessionID>-<feature_id>/execution-plan.json
   ```
   via bash (`cat >` / heredoc). The `<sessionID>-` prefix is **mandatory** — NEVER omit it and write to a path that starts directly with the feature_id. The planner output overwrites any classify stub in place (lowercase `mode: "light"|"full"`, non-empty `tasks`). `validate-plan` and `plan-reviewer` both read from this exact path.

3. Run the **`validate-plan` tool** on that file — a deterministic **structural** gate. On FAIL, hand its error list to `planner` and re-plan. **Cap 2 loops**, then escalate to the operator in product-language.

4. Dispatch `plan-reviewer` (read-only) for **engineering soundness** → `APPROVE | REVISE`. On REVISE: hand findings to `planner`, re-plan, re-run `validate-plan`, re-review. **Cap 2 revision loops**; if still REVISE, escalate the blocking finding to the operator in product-language.

5. **DETERMINISTIC sensitive-path override:** compare the plan's `scope_paths` against the allowlist:
   `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding/upgrading deps).
   **ANY match FORCES FULL**, overriding triage. Determinism on the plan; judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, product-relevant risks. **Never expose the JSON.** The operator approves the product-level go, not the engineering.

---

## Context curation — the ICM layers (applies to every dispatch)

Curate **layered** context per agent (budget ~2k–8k tokens/step), never the whole conversation.

| Layer | Content | Who gets it |
|---|---|---|
| L0 | global/project `AGENTS.md` ("where I am") | all |
| L1 | feature objective ("where I'm going") | executor, sniper |
| L2 | task contract (`spec`, `severity`, `scope_paths`, `resolved_judgments`, `criterion_refs`, `locked_tests`) | executor, compliance, adversary |
| L3 | applicable rules + the nested `AGENTS.md` of the task's `scope_paths` folder(s) — you read it and inject it | executor (always), any role acting on that folder |
| L4 | artifacts (diff, prior findings, curated `shared_context`) | executor, compliance, sniper — **never adversary** |

**Non-negotiable invariants:**
- **adversary enters VIRGIN on EVERY dispatch** — no leaked verdicts, no "compliance said X is ok", no shared_context, no conclusions from earlier tasks. The attack's value depends on having no anchor. This guardrail is non-negotiable.
- **compliance enters lean** — diff + ACs/locked_tests only; no shared_context, no adversary findings.
- **executor/sniper** receive the curated `shared_context` — a budget-capped knowledge ledger (key decisions, gotchas, insights), not a task log.
- L3 nested folder rules: you read that folder's `AGENTS.md` deliberately and inject it — do not rely on auto-load.

---

## Phase 2 — Per-task loop

**LIGHT** runs `executor + gates` per task, plus ONE upfront `adversary` pass on the spec before the loop, and a final dual review (Phase 3).
**FULL** runs the full loop below per task.

### LIGHT: upfront spec-adversary

In LIGHT mode, before the first task, dispatch `adversary` **VIRGIN** against the spec + a read of the existing codebase to surface tech-debt risks. Consume its findings before the first task: route every actionable finding — severity ≥ medium, or any finding with a `fix_hint` — to `sniper-<tiers[finding.severity]>`. Each sniper pass re-runs the affected gates. Zero findings (or all ≤ low with no `fix_hint`) is a valid outcome. Upfront findings not dispatched to a sniper must be explicitly recorded as accepted-risk in `shared_context.md` before the per-task loop begins.

### Adversary re-dispatch stop-rule

After a sniper fix triggers an adversary re-dispatch, apply this rule before looping:
- **Stop** when: the round returns ONLY findings of severity ≤ low, OR the same severity-tier distribution repeats across consecutive rounds with no reduction (stagnation).
- On stop: advance to the next step alone — do not wait for the operator.
- **CAP = 3 rounds** with at least one ≥ medium finding still open: **ESCALATE to the operator in pt-br** — translate the open finding to product impact ("o login pode falhar se o usuário fizer X — aceita o risco? / repensa?"). Never advance silently past CAP with a ≥ medium open.

There is no "loop until clean" contract. Convergence is declared by the stop criteria above, not by the absence of findings.

### Before the first task

Initialize `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** (`cat >` / heredoc) — a **real file on disk** (not in-context memory): the task-to-task knowledge ledger. On-disk so it survives context compaction and keeps task-to-task traceability auditable.

### Per-task steps (topological order via `depends_on`)

| # | Step | Who / How |
|---|---|---|
| a | Pick executor tier | `executor-<tiers[task.complexity ?? task.severity]>` (low/medium/high; `max`→high). If `complexity` absent, fall back to `severity`. Re-score a path via `complexity-scorer` tool if needed (one call/path). |
| a′ | Locked test + fidelity (when rail applies) | Dispatch `test-author` first (fidelity-**exempt** — it produces the locked test). Then dispatch `compliance` in **fidelity mode** (pre-freeze: full-observable fidelity only, no green required). On fidelity **PASS**, stamp disk marker **before** any executor spawn (see Fidelity-rail stamp below). Freeze the locked test, then proceed to implement. |
| b | Implement | Dispatch `executor-<tier>` via Task / `run-hand` with curated L0–L4 context. **Precondition:** `fidelity_pass` stamped for this feature/task (executor spawn returns `CONFIG_ERROR` if missing). Reads back `DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`. `NEEDS_CONTEXT` → supply the missing `resolved_judgment` or escalate. |
| c | Compliance | Dispatch `compliance` (read-only, bash allow) with **diff + ACs + locked_tests only** — NOT shared_context, NOT adversary findings. Reads back `pass \| partial \| fail`. |
| d | Adversary (if `task.adversarial.enabled`) | Dispatch `adversary` **VIRGIN** — no prior verdicts, no compliance output, no shared_context — with task spec + `adversarial.focus` + diff. Returns issues ranked by irreversibility (`category` + `severity` + `fix_hint`). Zero attested findings is a **VALID result** — never re-dispatch to hit a count. A `BLOCKED` return is **NOT a pass** — halt and escalate. |
| e | Security (conditional) | Dispatch `security` when the task touches auth/secrets/external-input/new-deps/SQL/service-entrypoint. Returns `SECURE \| UNSAFE` + issues. |
| f | Gates (deterministic, no LLM) | **You** run via Bash: task's `locked_tests` + `npm run typecheck` (tsc --noEmit) + lint. Failure → issue list. |
| g | Fix | Map ALL issues (compliance + adversary + security + gates) to `sniper-<tiers[issue.severity]>`. Sniper is the ONLY fixer (`edit` allow, `bash` deny, no new files). **HIGH fix — or a `medium` in an irreversible class (orphan-state/race/idempotency) — re-dispatch `adversary` fresh-virgin after, to attack the NEW surface the fix created.** Re-run the affected gate after every sniper pass. |
| h | Record | Rewrite `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** with the budget-capped knowledge ledger so far; adversary never reads it. Append this task's raw finding blocks (compliance/adversary/security/sniper) to the run `findings.md` buffer at the project root **via bash** — it is the producer the harvester/`recording-findings` consumes; if never written, the run's learnings are lost. |
| i | Escalate | See escalation ladder below. |

**Mid-run observability belt (Telegram outbox — fail-open, never gates delivery):** when `HARNESS_OBSERVABILITY_RUN_PATH` is set (VPS headless), emit the same curated events the drain already renders. Prefer structural producers (plugins `obs-plan-write` / `obs-eye` / `obs-hand` + classify `pipeline-type`). `obs-hand` emits `task-executing` (before) and `hand-ran` (after) for executor/sniper/test-author — do not rely on prose alone. **Every Task dispatch for a hand MUST pass top-level `feature_id` and `task_id`** (and optional `model`) so structural obs can fire; without them, obs-hand no-ops (no `unknown` spam). Additionally, the conductor MUST run these mark-gate CLI side-effects (idempotent / fail-open if env unset):

```bash
# After dual plan-reviewer merge (APPROVE|REVISE):
node .opencode/plugin/lib/mark-gate.mjs plan-reviewed --verdict APPROVE

# After upfront / final spec adversary (SHIP|BLOCK, findings count):
node .opencode/plugin/lib/mark-gate.mjs spec-adversaried --verdict SHIP --findings 0

# At the top of each task loop (1-based n / total from plan.tasks):
node .opencode/plugin/lib/mark-gate.mjs task-executing --n <n> --total <total>

# Right after each hand (executor/sniper/test-author) returns:
node .opencode/plugin/lib/mark-gate.mjs hand-finished --session <sessionId> --feature <feature_id> --task <task_id> --model <model_id>

# After final dual review join (Phase 3):
node .opencode/plugin/lib/mark-gate.mjs final-review-done
```

Do not invent alternate event type strings — only the types in `notify-telegram` FEED_ALLOWLIST.

**Fidelity-rail stamp (after compliance fidelity PASS → before executor):** When compliance returns fidelity **PASS** on the locked test, the orchestrator stamps `fidelity_pass` on disk via `stampFidelityPass` in `.opencode/plugin/lib/mark-gate.mjs` (writes through `mergeGateState` — never Map-only). This stamp **MUST** precede executor dispatch:

```bash
node --input-type=module -e "
import { stampFidelityPass } from './.opencode/plugin/lib/mark-gate.mjs';
const r = stampFidelityPass({
  projectRoot: process.cwd(),
  sessionId: '<session_id>',
  featureId: '<feature_id>',
  taskId: '<task_id>',
});
if (!r.ok) { console.error(r.reason); process.exit(1); }
console.log(JSON.stringify(r));
"
```

An executor hand spawn is **DENIED** (`CONFIG_ERROR`) unless `fidelity_pass` contains this feature/task (optional `@sha`). `test-author` is exempt — it creates the test that enables fidelity. Freeze-commit alone is not enough; the stamp is the on-disk signal `run-hand` and the entry-gate consume.

Advance to the next task only when its gates are green.

### Escalation ladder (engineering — never handed to the human)

retry same tier (bounded) → bump tier → still failing → **CRITICAL EXCEPTION**: translate to product impact, surface to operator in pt-br ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa?"), never as a technical problem.

A fix bigger than surgical scope (re-architecture) is **not** a sniper job → re-dispatch `executor-<tier>` or split the task. **Any split/re-plan that re-runs `planner` → write the new plan to `.opencode/plans/<sessionID>-<feature_id>/execution-plan.json` via bash and re-run `validate-plan` before resuming executors.**

---

## LIGHT vs FULL

| | LIGHT | FULL |
|---|---|---|
| Plan | light plan (`mode: "light"`) | full plan (`mode: "full"`) |
| Spec analysis | ONE upfront `adversary` pass (virgin) against the spec + codebase, before the per-task loop | covered per task |
| Per-task review | executor + gates only; no compliance/adversary between tasks | full loop (steps c–g per task) |
| Final review | dual review only (compliance + adversary, whole feature) | dual review + per-task loop |

**Tiering of the executor applies in both modes** — a small feature can still generate debt if a high-severity task is run on a weak model.

---

## Phase 3 — Final dual review (both modes, feature-wide)

Scope = the **whole feature**, not one task.

- `compliance` — whole implementation vs spec.
- `adversary` — **VIRGIN**, hunts bugs across the full feature.

Findings → tiered sniper (same rules as Phase 2, step g). Re-run gates after fixes. Proceed only when feature-wide gates are green.

---

## Phase 4 — Demo

Generate a demo script derived from the **UJs/ACs** (`demo.scenarios_from_refs`), **never from the implementation** — otherwise it is the student grading their own exam.
- `demo.type`: `smoke` (API/CLI) · `playwright` (complex UI) · `markdown` (batch/cron).

**HARD-GATE 3 — test demo (pt-br, product-language):** the operator validates the product by using the output. The human is insubstitutable here.

---

## Phase 5 — Harvest + ship

- Dispatch `harvester` once: consolidates `findings.md`, routes durable learnings by blast-radius (project pattern → native MEMORY.md + index · law of one folder → that folder's nested `AGENTS.md` + root router row · global convention → kaizen proposal), then **deletes the ephemeral run buffers** — `findings.md` (project root) + `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` (git is the durable audit). It owns `recording-findings` / `distilling-learnings` / `proposing-improvements`. It never auto-writes to memory.
- Delivery (branch/commit/push/PR via `shipper`) happens **only on explicit operator authorization** — merge/deploy is irreversible (human checkpoint). `shipper` never edits code.

---

## How to pick tier

Frozen tier map from the plan's `model_strategy.tiers` (`low→low, medium→medium, high→high, max→high`).

| Selector | Formula |
|---|---|
| Executor | `executor-<tiers[task.complexity ?? task.severity]>` → `executor-low / executor-medium / executor-high` (`max` maps to high) |
| Sniper | `sniper-<tiers[issue.severity]>` → `sniper-low / sniper-medium / sniper-high` |

Re-score a file with `complexity-scorer` (one call per path) when `task.complexity` is absent or you suspect mis-scoring. **Severity drives review posture/sniper tier (blast radius); complexity drives executor model (reasoning depth) — they are decoupled.**

---

## Gates — deterministic, you run them

You run gates yourself via Bash; no LLM in the gate:
- `npm run typecheck` (tsc --noEmit)
- `npm test` (the task's `locked_tests`)
- lint

A gate failure produces an issue list → tiered sniper (Phase 2, step g). Non-optional.

---

## Human checkpoints — product only, pt-br, product-language

The human is called **only** for PRODUCT decisions:
1. **Approve spec** (HARD-GATE 1).
2. **Approve plan** (HARD-GATE 2).
3. **Test demo** (HARD-GATE 3).
4. **Critical exception** — translate a critical finding to product impact ("o login pode falhar se o usuário fizer X"), never a technical problem.
5. **Before merge/deploy** — irreversible/outward-facing action.

Engineering (tier escalation, retry, sniper) is **NEVER** delegated to the human.

---

## Self-check before declaring delivery done

- All tasks' gates green (or a product decision recorded for any accepted risk).
- Final dual review passed; sniper fixes re-gated.
- Demo script derived from UJs/ACs (not implementation), tested by the operator.
- `harvester` ran; durable learnings routed (native memory / nested AGENTS.md / kaizen); ephemeral buffers deleted.
- **adversary entered virgin on every dispatch** — no prior verdict leaked.
- Every operator message was pt-br product-language.
- No file was written via the edit tool — all writes went through bash (`cat >` / heredoc).
