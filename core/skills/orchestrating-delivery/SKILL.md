---
name: orchestrating-delivery
description: "Conducts the LIGHT and FULL delivery loop of the Claude Harness — runs spec, plan, the per-task executor/compliance/adversary/sniper/gates cycle, final dual review, demo, and harvest. Dispatches a fresh subagent per role and curates layered ICM context for each; never writes code itself. Invoked by triaging-requests for LIGHT/FULL (QUICK runs inline and never reaches this skill)."
---

# Orchestrating-Delivery — The maestro of the development loop

**This skill is the conductor, not a worker.** It dispatches a fresh subagent per role/task, reads each structured output, and decides the next step. It does **not** implement, validate, or attack — those are the agents (`executor`, `compliance`, `adversary`, `sniper`, `security`, `shipper`, `harvester`). It owns the human HARD-GATES and the curation of layered context.

**Announce at the start (in pt-br):** "Usando orchestrating-delivery para conduzir a entrega no modo <LIGHT|FULL>."

Invoked by `triaging-requests` for **LIGHT** and **FULL**. QUICK never reaches here (it runs inline, commits via `committing-changes`).

All identifiers, JSON keys, and reasoning stay in English. **Every message to the operator — checkpoints, demo, critical exception — is pt-br and in product-language, never code-language.**

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
brainstorm (interactive: superpowers:brainstorming if available · headless: exploration subagents → synthesized spec)
   → spec → spec review → plan JSON (planner via creating-plans) → per-task loop
   → final dual review → demo → harvest
```

HARD-GATES (human, pt-br, product-language): **approve spec → approve plan → test demo**. The loop between those gates is fully autonomous.

---

## Model routing (single source of truth)

Model per role. **This table is authoritative** — when a role's model is named elsewhere in this skill, it must match here. Routing for the two boundary gates is done by an **explicit model override on the dispatch** (the Agent/Task `model` param), not by agent frontmatter — because the `adversary` agent is `opus` per-task and only becomes `fable` at the final gate, so frontmatter alone cannot express it.

| Role / step | Model | Why |
|---|---|---|
| orchestrator (this skill / main loop) | **sonnet** default (under validation — see note) | highest token volume; cheapest lever. Curation quality is being A/B'd vs opus before commit. |
| planner | opus | architecture-grade reasoning |
| **plan-reviewer (initial gate)** | **fable** | strongest tier audits the opus planner's output — the highest-leverage boundary check before execution. In HEADLESS this APPROVE *is* the gate (no human), so the premium is most justified here. |
| executor | `tiers[complexity]` (haiku/sonnet/opus) | reasoning-depth axis |
| compliance | sonnet | spec-vs-impl check |
| adversary (per-task) | opus | already strong; raise `effort` before raising tier |
| security | opus | conditional auditor |
| sniper | `tiers[severity]` (haiku/sonnet/opus) | grave bug never fixed by a weak model |
| **adversary (final dual review = final gate)** | **fable** | strongest tier hunts bugs across the whole feature — the last boundary before delivery. In HEADLESS the PR ships on this verdict, so the premium is most justified here. |
| compliance (final dual review) | sonnet | |
| security (final dual review) | opus | |
| harvester | sonnet | |
| shipper | sonnet | |

**Cost note (do not mistake for economy):** Fable is the **most expensive** model ($10/$50 per 1M vs opus $5/$25). It is placed on the two boundary gates as a deliberate **quality** investment, not a saving. The net economy of this routing comes from the **sonnet orchestrator default** (high-volume) — Fable on the gates *costs more* there, by design. On small runs with many checkpoints, watch that Fable does not outweigh the orchestrator saving — instrument `usage` per role to verify. **Fallback is safe:** frontmatter stays `opus`, so if the `fable` override is ever dropped, a gate falls back to opus, never to the weakest tier.

**Validation note (orchestrator = sonnet):** the sonnet default is under test. Context curation is judgment, not mechanics — a weak curation poisons every downstream agent. Before committing sonnet as the standing default, run one representative delivery and compare curation quality (did executor get the right scope? did adversary get what it needed?) against opus. Until then, the operator chooses the default via `/model`.

---

## Execution mode — interactive vs headless

The pipeline is identical; only **who occupies the human decision points** changes. Detect the mode first (same signal as `triaging-requests`): **HEADLESS** when the session is a cloud routine (env `$CLAUDE_CODE_REMOTE` set) or the trigger prompt says to run autonomously; otherwise **INTERACTIVE** (default).

| Touchpoint | INTERACTIVE (operator present) | HEADLESS (cloud routine) |
|---|---|---|
| Brainstorm / spec | `superpowers:brainstorming` if available, else inline | **dispatch exploration subagents** (distinct lenses → synthesize spec) — the reliable mechanism in cloud routines; prefer a `Workflow` only where the tool is available (local headless); then adversary attacks the spec |
| HARD-GATE 1 — spec | operator confirms | multi-agent validation (adversary on spec) → proceed; spec written into the PR body |
| HARD-GATE 2 — plan | operator confirms | `plan-reviewer` APPROVE → proceed; plan summary written into the PR body |
| HARD-GATE 3 — demo | operator tests output | auto-generate the demo artifact and auto-validate it against the ACs; attach to the PR |
| Critical exception | pause and ask the operator | **record as an open risk in the PR** (label/comment); do **not** block |
| Delivery | merge on operator authorization | **open a draft PR, never merge** |

**Headless golden rules (non-negotiable):**
1. **Never** `AskUserQuestion` or plan-mode — undefined in the cloud.
2. A human gate becomes **multi-agent validation**, never "auto-approve blindly". If validation fails and cannot self-resolve, **stop and report** in the PR — do not ship.
3. The real human gate is the **PR review** (asynchronous).
4. Durable knowledge is committed in the PR (`.claude/memory/`, `.claude/kaizen.md`) — the shipper opens the PR as a **draft** and never merges.

The gates below are written for INTERACTIVE; each carries its HEADLESS substitution inline.

---

## Phase 0 — Brainstorm and spec

1. Explore intent, user journeys (`#uj-N`), and acceptance criteria (`#ac-N.M`). **INTERACTIVE:** use `superpowers:brainstorming` **if available** (it is a marketplace plugin, not vendored — may be absent); else brainstorm inline with the operator.
   **HEADLESS:** there is no human to brainstorm with, so **simulate the exploration by dispatching read-only subagents**: fan out a small set of exploration agents over the trigger (issue/PR/prompt) + the codebase, each with a **distinct lens** (e.g. user-journeys, edge-cases/failure-modes, constraints/non-functionals), then **synthesize** their outputs into the spec (UJs `#uj-N` + ACs `#ac-N.M`). Subagent dispatch is the **reliable mechanism** — **cloud routines do not have the `Workflow` tool** (confirmed: workflows are unavailable in cloud sessions and require interactive per-run approval). **Prefer a `Workflow`** only when the tool is actually available (e.g. headless-local via `claude -p`), for deterministic/reproducible orchestration. A thin one-line trigger may use inline derivation. Either way the synthesized spec then goes through the spec-validation gate (adversary attacks it). Never run an interactive brainstorm in headless, and never hard-depend on the `superpowers:brainstorming` plugin (it does not load in cloud routines).
2. **Explicitly `Read`** the project's durable index — `.claude/memory/MEMORY.md` (the repo-committed project-pattern index; do not rely on native auto-load) and the root `CLAUDE.md` router table ("folder → what lives there") — to inform the spec. **Cold-start check:** if this is a non-trivial existing codebase and that index is cold (`.claude/memory/MEMORY.md` has no entries and the root `CLAUDE.md` router is unfilled), dispatch the `surveying-codebase` skill **first** to seed durable knowledge from the code itself, then read the now-populated index before shaping the spec. This is the orchestrator's macro view forming. There is no `learnings.md`.
3. Produce a spec with UJs, ACs, constraints, and resolved product decisions.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does and ask the operator to confirm. Do not show code or schema.
**HEADLESS:** no operator to confirm. Run the **adversary on the spec** (virgin) as validation; if it surfaces no blocking issue, proceed and write the spec into the PR body. If a blocking issue cannot self-resolve, stop and report it in the PR — do not proceed on a guess.

---

## Phase 1 — Plan

1. Dispatch the **planner** (opus) running the `creating-plans` skill. Hand it the approved spec.
2. The planner returns an `execution-plan.json` that passes **structural** validation (`validate-plan.mjs` — schema, enums, AC↔locked_test traceability, dependency cycles). Structure only — not engineering soundness.
3. **plan-reviewer** (**fable** — initial gate; dispatch with an explicit `model: fable` override; virgin, read-only) — audits the plan's **engineering soundness**: decomposition/SRP, whether `resolved_judgments` are correct, whether `locked_tests` truly pin the ACs, `scope_paths` vs. codebase reality, `severity`/`complexity` routing, and risks introduced by the decomposition itself. Consults curated mental models via the optional MV add-on (best-effort recall; never blocks if MV is absent). Returns `APPROVE | REVISE` + findings + a **product-language summary**.
   - **REVISE** → re-dispatch the planner in **revision mode**, handing it `{existing plan path, findings[] with each finding's `planner_instruction` and target `task_id`}`. The planner applies each instruction to its `task_id`, keeps every other task byte-stable, and re-runs its self-review + structural validation; then re-run plan-reviewer. **Cap at 2 revision loops**; if still REVISE, escalate the blocking finding to the operator in product language.
   - This is the engineering judgment the operator **cannot apply himself** — the validator checks shape, the plan-reviewer checks substance. It is the analog, at the plan layer, of the adversarial pass on the spec.
4. **Deterministic sensitive-path override:** compare the plan's `scope_paths` against the sensitive-path allowlist (`**/auth/**`, `**/payment|billing/**`, `**/*.sql`, migrations, `.env*`, `package.json`). Any match **forces FULL**, overriding the triage mode. When it fires, **rewrite `plan.mode` to `"full"` in the persisted plan and re-validate**, and record `effective_mode: "full"` in `shared_context.md` — so a later context-compaction re-read cannot silently revert to a stale `mode: "light"`. Key the LIGHT/FULL branch off the effective mode. Determinism on the plan, judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, and any product-relevant risk it flagged — and confirm. Never expose the JSON to the operator. The engineering audit already happened (plan-reviewer); the operator approves the **product-level go**, not the engineering.
**HEADLESS:** the plan-reviewer's **APPROVE is the gate** — on APPROVE, proceed and write the plan summary into the PR body. If it stays REVISE past the 2-loop cap, stop and open an issue (or PR comment) with the blocking finding — there is no operator to escalate to live.

---

## Context composition (the ICM rule — applies to every dispatch)

The orchestrator curates **layered** context per agent (budget 2k–8k tokens/step), never the whole conversation. Layers:

| Layer | Content | Who gets it |
|---|---|---|
| L0 | `.claude/CLAUDE.md` ("where I am") | all |
| L1 | feature objective ("where I'm going") | executor, sniper |
| L2 | task contract (`spec`, `severity`, `scope_paths`, `resolved_judgments`, `criterion_refs`, `locked_tests`) | executor, compliance, adversary |
| L3 | applicable rules/refs **+ the nested `CLAUDE.md` of the task's `scope_paths` folder(s)** | per role (executor always) |
| L4 | artifacts (diff, prior findings) | compliance, sniper — **never adversary** |

Curation rules:
- **L3 nested CLAUDE.md (deliberate, per task):** for each folder in the task's `scope_paths`, the orchestrator **reads that folder's `CLAUDE.md` (if present) and injects its content into L3** of the executor (and of any role acting on that folder). This is a deliberate read by the orchestrator — it does **not** rely on the native on-demand auto-load of nested `CLAUDE.md` (which has had version bugs). The nested file is the per-folder law (written by the harvester at harvest time); this is how that law reaches the agent working in the folder.
- **`shared_context` is a real file on disk** — `.claude/plans/<feature_id>/shared_context.md`, NOT just in-context memory. The orchestrator rewrites it after each task and reads from it to compose the next task's context. Persisting it keeps task-to-task traceability auditable and survives context compaction. **Ephemeral:** both `shared_context.md` and `findings.md` are run buffers — the harvester deletes both at the end. The durable audit is git (the run's commit/PR); durable knowledge is routed by the harvester to repo memory (`.claude/memory/`) / nested `CLAUDE.md` / `.claude/kaizen.md`.
- **executor** (and **sniper**) receive the curated `shared_context` — the **learnings worth carrying forward**: key decisions, gotchas, and insights surfaced during the spec review, the upfront adversarial pass, prior task runs, and adversarial/compliance findings. It is a knowledge ledger, not a task log — save only what helps a later step. Budget-capped.
- **compliance** enters lean: gets the **diff + ACs**, NOT the `shared_context` and NOT the adversary's findings.
- **adversary** enters **virgin** — no prior verdicts, no "compliance said X is ok", no conclusions from earlier tasks. The attack's value depends on having no anchor. This guardrail is non-negotiable.
- `shared_context` has a **ceiling** — prioritize the relevant; do not append everything, or every task gets more expensive.

---

## Phase 2 — The per-task loop (FULL, the core)

Before the first task, **initialize** `.claude/plans/<feature_id>/shared_context.md` with the learnings worth keeping from the spec review (and, in LIGHT, the upfront adversarial pass on the spec). It grows as the loop runs.

For each task in **topological order** (`depends_on`), compose layered ICM context and run:

**1. executor** — model = `tiers[task.complexity ?? task.severity]` (haiku/sonnet/opus; `complexity` is the reasoning-depth axis, decoupled from `severity`/review). Receives L0–L3 + curated `shared_context`. **First authors each `locked_test` as a real test file at its `test_path` and runs it red (TDD)**; then implements the task from intent until green; writes JSDoc; **after authoring, the `locked_tests` are frozen — must not weaken or edit them**. Reads back: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.

**2. compliance** (sonnet, read-only) — receives the **diff + ACs/locked_tests**, NOT the `shared_context`. Validates impl vs spec/AC. Reads back: `pass | partial | fail` + issues. Issues → step 5.

**3. adversary** (opus, read-only, **VIRGIN**) — only if `task.adversarial.enabled`. Receives task spec + `adversarial.focus` + the diff, **no prior verdicts**. Attests the canonical failure classes (each with a `file:fn` citation) and reports every real failure mode at honest severity with `fix_hint`. **Zero findings is a valid attested result — never fabricate to hit a count.** Issues → step 5.

**3b. security** (opus, read-only) — conditional: dispatch when the task's `scope_paths` hit the sensitive-path allowlist OR the task touches an external HTTP client, service entrypoint, webhook handler, or new/modified log statement (security.md's trigger surfaces). Returns `SECURE | UNSAFE` + issues → step 5.

**4. gates** (deterministic, **no LLM**) — run `locked_tests` + `tsc --noEmit` + lint. The executor materialized the `locked_tests` as runnable files at their `test_path` in step 1, so the gate has real tests to execute (never a vacuous green). The orchestrator runs these directly (Bash). Failure → step 5. This is the formal interface against orphan state (§2.3) — non-optional.

**5. sniper** — the **only fixer**. Applies **all** mapped issues from compliance + adversary + security + gates. Model = `tiers[issue.severity]`. **Severity resolution (total over all four sources):** use the finding's explicit `severity` when present; a gate failure or a compliance VIOLATED-locked-decision is auto-**high**; otherwise fall back to the owning `task.severity`; never dispatch below sonnet for a fail-class finding.
- LOW → sniper haiku · MEDIUM → sniper sonnet · **HIGH → sniper opus + re-dispatch adversary** (fresh virgin) after the fix.
- A grave bug is never fixed by a weak model. If a fix is bigger than surgical scope (re-architecture, not a fix), it is **not** a sniper job → escalation (re-dispatch executor or split the task).
- After sniper, re-run the relevant gate to confirm green.

**6. record + curate** — persist to disk after each step (never keep only in context — compaction would lose it):
- append this task's raw findings (decisions, gotchas, bugs found/fixed) to a running `findings.md` at the project root.
- rewrite `.claude/plans/<feature_id>/shared_context.md` with the **learnings worth carrying forward** so far — from the spec review, the upfront adversarial, this run, and adversarial/compliance findings worth keeping. Budget-capped; the adversary never reads this file (stays virgin).
These two files are the on-disk hand-off between steps and survive context compaction.

**7. escalation** — engineering, resolved inside the system, never handed to the human:
- retry same tier (bounded max) → bump tier → if still failing, **critical exception**. **INTERACTIVE:** pause and ask the operator in **product-language** ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa"), never a technical problem ("conserta esse race condition"). **HEADLESS:** do **not** pause — **record the risk as an open item in the PR** (product-language description) and continue; the human accepts or refuses it asynchronously at PR review.

Move to the next task only when its gates are green.

---

## LIGHT vs FULL

| | LIGHT | FULL |
|---|---|---|
| Plan | light plan (`mode: "light"`) | full plan |
| Spec analysis | spec-vs-codebase + adversarial **UPFRONT on the spec** (map tech debt before coding) | covered per task |
| Per-task review | **none** — executor with tiering only, no compliance/adversary between tasks | full loop (steps 2–5 per task) |
| Final review | **dual review only** (compliance + adversary, whole feature) | dual review + per-task loop |

LIGHT trades per-task review for a single upfront adversarial spec pass plus a final dual review. **Tiering of the executor applies in both modes** — a small feature can still generate debt if a high-severity task is run on a weak model.

In LIGHT, the upfront adversarial spec pass is a single **adversary** dispatch (virgin) against the spec + a read of the existing codebase, surfacing tech-debt risks before the plan is finalized.

---

## Phase 3 — Final dual review (both modes)

Scope = the **whole feature**, not one task. Roles, feature-wide scope:
- **compliance** (sonnet) — entire implementation vs spec.
- **adversary** (**fable** — final gate; dispatch with an explicit `model: fable` override; virgin) — hunts bugs across the full implementation. Note: the **per-task** adversary (Phase 2, step 3) stays **opus** — only this final-gate adversary is Fable.
- **security** (opus, virgin) — **dispatched in both LIGHT and FULL when `final_review.security` is true** (the planner sets it when the feature's aggregate `scope_paths`/tasks hit a security trigger). This is the only security pass LIGHT gets, so it is load-bearing: a LIGHT feature that wires an outbound HTTP call or a new entrypoint still gets audited here.

**Dispatch these synchronously (foreground).** They **gate the PR** — dispatch each and **capture its verdict before proceeding**. Do **not** background the adversary (or compliance/security) and poll for it: a backgrounded verdict can arrive **stale or out-of-band** (a poll may return earlier spec-review findings instead of the final verdict), and the gate would proceed on incomplete findings. Background dispatch is only for genuinely parallel, non-gating work.

Findings → sniper (tiered, same rules as step 5). Re-run gates after fixes. Only proceed when the feature-wide gates are green.

**Producer note:** the orchestrator is the **single producer** of `findings.md`. In FULL it appends per-task findings in the loop (step 6); in **LIGHT** (no per-task loop) it appends the final dual-review findings here, so the harvester is never handed an empty file.

---

## Phase 4 — Demo

Generate `demo-script.md` derived from the **UJs/ACs** (`demo.scenarios_from_refs`), **never from the implementation** — otherwise it is the student grading their own exam.
- `demo.type`: `smoke` (API/CLI) · `playwright` (complex UI) · `markdown` (batch/cron).

**HARD-GATE 3 — test demo (pt-br, product-language):** the operator validates the product by using the output. This is where the agentic success criterion is weakest (§2.2) — the human is insubstitutable here.
**HEADLESS:** the human is insubstitutable, so do **not** self-grade — instead **auto-generate the demo artifact** (smoke output / playwright trace / markdown) and **auto-validate it against the ACs** (`demo.scenarios_from_refs`), then **attach it to the draft PR** for the asynchronous human review (the real gate). If auto-validation fails, mark the PR and report the failure — never silently pass.

---

## Phase 5 — Harvest

Dispatch the **harvester** (sonnet) once. It consolidates the transient `findings.md`, routes each durable learning by blast-radius (project pattern → repo memory `.claude/memory/` + `.claude/memory/MEMORY.md` index · law of one folder → that folder's nested `CLAUDE.md` + root router row · global convention → `.claude/kaizen.md` proposal), logs kaizen proposals, updates local docs, then **deletes the ephemeral files — `findings.md`, `.claude/plans/<feature_id>/shared_context.md`, and `.claude/plans/mv-suggestions.md` if present** (git is the durable audit). It owns `recording-findings` / `distilling-learnings` / `proposing-improvements`. There is no `learnings.md`. It never auto-writes to MV/MP.

Delivery (branch/commit/push/PR via **shipper**). **INTERACTIVE:** happens only on explicit operator authorization — merge/deploy is an irreversible, outward-facing action (human checkpoint). **HEADLESS:** the shipper opens a **draft PR and never merges** — the PR review is the real human gate. Either way the shipper commits `.claude/memory/` and `.claude/kaizen.md` so durable knowledge persists.

---

## Human checkpoints (§11 — product only)

**INTERACTIVE:** the human is called **only** for PRODUCT decisions, always in pt-br, always product-language:
1. **Approve spec** (HARD-GATE 1).
2. **Approve plan** (HARD-GATE 2).
3. **Test demo** (HARD-GATE 3).
4. **Critical exception** — a product ambiguity or a risk only the product owner can accept/refuse. A critical finding is **translated to product impact** ("o login pode falhar se o usuário fizer X"), never presented as a technical problem.
5. **Before merge/deploy** — irreversible/outward-facing action.

Engineering (tier escalation, retry, sniper) is **never** delegated to the human.

**HEADLESS:** none of these pause the run. Gates 1–3 become multi-agent validation, the critical exception and the merge decision become **the draft PR** — every item above is surfaced in the PR body/labels for the **asynchronous** human review. The run never waits; it either ships a draft PR or stops and reports.

---

## Self-check before declaring delivery done

- All tasks' gates green (or product decision recorded for any accepted risk).
- Final dual review passed; sniper fixes re-gated.
- `demo-script.md` derived from UJs/ACs (not implementation), tested by the operator.
- Harvester ran; durable learnings routed (repo memory `.claude/memory/` / nested CLAUDE.md / `.claude/kaizen.md`); `findings.md` and `shared_context.md` deleted.
- Adversary entered virgin on every dispatch; no prior verdict leaked into it.
- Every operator message was product-language pt-br.
- **HEADLESS:** no gate paused the run; gates 1–3 became multi-agent validation; spec, plan summary, demo result, and any open risk are in the draft PR (product-language); the shipper opened a **draft** PR and did not merge; `.claude/memory/` and `.claude/kaizen.md` were committed.
