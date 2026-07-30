---
name: oc-orchestrating-delivery
description: "Drives the LIGHT and FULL delivery loop — spec, plan, per-task executor/compliance/adversary/sniper cycle, final review, demo, and harvest. Dispatches one subagent per role via the task tool; never writes code itself. Invoked by triaging-requests for LIGHT/FULL; QUICK runs inline and never reaches this skill."
license: MIT
compatibility: opencode
metadata:
  phase: delivery
  gate: hard
---

# Orchestrating-Delivery — The maestro of the development loop

**This skill is the conductor, not a worker.** It dispatches a fresh subagent per role/task via the `task` tool, reads each structured output, and decides the next step. It does **not** implement, validate, or attack — those are the agents (`executor-low/medium/high`, `test-author`, `compliance`, `adversary` + optional second eye, `sniper-low/medium/high`, `security`, `shipper`, `harvester`). It owns the human HARD-GATES and the curation of layered context.

**Announce at the start (pt-br):** "Usando orchestrating-delivery para conduzir a entrega no modo <LIGHT|FULL>."

Invoked by `oc-triaging-requests` for **LIGHT** and **FULL**. QUICK never reaches here (it runs inline, dispatching a single `executor-low`/`executor-medium` + gates + `shipper`).

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
  → HARD-GATE 2 → per-task loop → final review → demo → HARD-GATE 3 → harvest → ship
```

HARD-GATES (human, pt-br, product-language): **approve spec → approve plan → test demo**. The loop between those gates is fully autonomous.

---

## Interactive vs headless

Detect **first** (same signals as `oc-triaging-requests`):

- **HEADLESS** when the trigger says autonomous / VPS cron, or `$HARNESS_OBSERVABILITY_RUN_PATH` / `$HARNESS_OC_DATA_HOME` is set.
- Otherwise **INTERACTIVE**.

| Touchpoint | INTERACTIVE | HEADLESS |
|---|---|---|
| Brainstorm / spec | `oc-brainstorming` with operator | exploration + synthesize + **spec adversary** — never wait |
| HARD-GATE 1 (spec) | operator confirms | adversary clean → proceed; write spec into PR body |
| HARD-GATE 2 (plan) | operator confirms | primary `plan-reviewer` **APPROVE** is the gate |
| HARD-GATE 3 (demo) | operator tests | auto-validate ACs; attach to PR |
| Delivery | merge on operator OK | **draft PR only — never merge** |

**Headless golden rules:** never block on questions; never invent product decisions when the trigger is silent (stop + comment); never skip a configured optional eye; never dispatch `executor-*` until a **full** plan (not classify stub) exists and plan-gate allows.

---

## Dispatchable subagents (exact names only)

| Role | Exact `subagent_type` names |
|---|---|
| Plan | `planner`, optional `planner-fallback`, `plan-reviewer` (+ optional family-2 when `secondEyeModel` is set) |
| Implement | `executor-low`, `executor-medium`, `executor-high`, `test-author` |
| Verify | `compliance`, `adversary` (+ optional second eye when `secondEyeModel` is set), `security` |
| Fix | `sniper-low`, `sniper-medium`, `sniper-high` |
| Close | `harvester`, `shipper` |

There is **NO** single `executor` or `sniper` agent — tiered names only. Tier is chosen by you at dispatch; it is never hardcoded in the plan.

### Single evaluator (plan-reviewer + adversary)

**One required evaluator** by default (`plan-reviewer` / `adversary`). Optional second eye is opt-in and fail-open — dispatch `*-family-2` **only when** routing declares `secondEyeModel`. Task tool has no model field — second eye = second agent file when configured.

| Step | Action |
|---|---|
| 1 | Dispatch primary (`plan-reviewer` / `adversary`) |
| 2 | Read routing directly. Dispatch `plan-reviewer-family-2` / `adversary-family-2` only when `secondEyeModel` (or the legacy family-2 model) is present — virgin brief, fail-open. If absent → skip; the primary result is enough |
| 3 | On optional-eye auth, provider, or malformed failure → continue with the primary result; no retry storm and no invented findings |
| 4 | On a useful optional-eye result → **merge under policy B**: a single-family finding is **kept unless the other family refutes it — never majority voting**. Second-eye-only findings get their primary (Claude/primary-family) refutation folded in before the sniper. An adopted finding routes through the phase's normal remediation (plan-review finding → planner; adversary finding → sniper). It never overturns the primary verdict or creates a separate gate |

Never invent a second eye when routing does not configure one. With no configured second eye, advance from the primary verdict without blocking, secondary retry, or warning.

Every evaluator brief, primary or explicitly opted-in second eye, MUST require two separate passes: (1) internal consistency of the spec/plan/diff as a delivery contract, then (2) confrontation against every real file in `scope_paths` and its relevant callers/callees. Validate findings before accepting a report: adversary `evidence` must be repo-relative `file:anchor`; plan-reviewer `problem` must begin `Evidence: file:anchor — ` to preserve its exact-key schema. Use a function/exported symbol for code, or a real `<section>`, `<key>`, or `<operation>` for a non-executable surface. Any line-only, bare-file, missing, prose-only, or invented anchor makes the report unusable.

---

## Native tools (run directly, not via Task)

- `complexity-scorer` — scores a file path on a 0–60+ scale (0–10 low · 11–30 medium · 31–45 high · 46–60 max→`executor-high` · 61+ split). One call per path.
- `validate-plan` — deterministic structural gate for `execution-plan.json`: per-task presence of `criterion_refs` + `locked_tests`, acyclic + topologically-ordered `depends_on`, scalar `resolved_judgments`, valid tiers (no Claude slugs), `adversarial.focus` when enabled, `demo` shape. Does NOT check spec-AC semantic coverage — that is the plan-reviewer's job.
- `verify` — resolves a registered targeted-test snapshot to a concrete test path (feature/task ids in, `locked_tests[].path` out). Optional: the active hand can run the targeted test directly via bash just as well; `verify` stays available for the resolver's snapshot lookup when that is more convenient.
- `ceremony-next` — strict runtime consumer for a planner preflight denial object. Returns only the allowlisted brainstorming/adversary coordinator descriptor valid for current sealed state; any malformed, unknown, or state-inconsistent denial is rejected.
- **Bash gates** — `npm run typecheck` (tsc --noEmit), `npm test`, lint. Deterministic; no LLM in the gate.

---

## File writes

`build`'s `edit` permission is **allowed** (`agents/build.md`: `edit: allow` — see PR #495). Write
spec/decision-ledger content directly with the edit tool. Older revisions of this skill said `edit`
was denied here and showed a bash/heredoc workaround for every write, including a manual
`execution-plan.json` write — that predates the current `build.md` and is gone from this section
because it was also wrong on its own terms: **you never hand-write `execution-plan.json`, in `edit`
or in bash.** Phase 1 below (`planner-recovery`) persists it for you, atomically, on a usable planner
result — do not pre-empt that with a manual write.

---

## Phase 0 — Brainstorm + spec

1. Read the native durable index — global/project `AGENTS.md` and any root router table (folder → what lives there). This is your macro view.
   - **Cold-start check:** if this is a non-trivial existing codebase and the index is cold (no entries in MEMORY.md, root router unfilled), dispatch the `oc-surveying-codebase` skill **first** to seed durable knowledge from the code, then read the now-populated index before shaping the spec.
2. **Load and follow the `oc-brainstorming` skill** (INTERACTIVE or HEADLESS branch). Spec must include `#uj-N`, `#ac-N.M`, constraints, and locked decisions (operator-owned in interactive; trigger-derived + explicit open risks in headless).
3. Write the spec file directly with the **edit** tool (`build`'s `edit` is allowed — `agents/build.md`).
   - The canonical runtime copy is `.opencode/plans/<sessionID>-<feature_id>/spec.md`. This session+feature-bound artifact is the durable brainstorming completion evidence source; a docs copy alone is not restart evidence.
4. **Upfront spec-adversary (mandatory LIGHT/FULL):** identify the existing paths implicated by the spec and pass them as `scope_paths` (empty is valid only when no existing file is implicated). Dispatch `adversary` (+ optional `adversary-family-2` only when `roles.adversary.secondEyeModel` is set). The Task prompt MUST require both passes and `evidence: "file:anchor"`; use a function/exported symbol for code or a real `<section>`, `<key>`, or `<operation>` for a non-executable surface. Only a greenfield surface with no existing file is narrative N/A. It MUST follow the exact JSON schema and MUST NOT request `SHIP`/`BLOCK`, `verdict`, `mechanism`, `sweep`, `blockers`, or any extra field. Primary returns only `{ "issues": [...] }`.

   **Acceptance is defined, and "clean" is not the only way out.** No unresolved medium/high finding → the pass is accepted: stamp the marker and go to the plan. A material finding with rounds to spare → revise `spec.md` so it is answered (a criterion that pins the behaviour, or an explicit locked decision that accepts it), then re-attack. **Nothing refuses another round** — *this* loop, the Phase 0 spec-adversary, is never denied deterministically: no cap freezes it, and none hands the spec back on its own. **The `CAP = 3 rounds` under "Adversary re-dispatch stop-rule" does not govern it** — that rule bounds the **post-sniper** adversary re-dispatch (Phase 2 per-task, and the Phase 3 final review that inherits its rules), a different loop; reaching a third round *here* with a medium still open is **not**, by itself, a reason to hand the spec back. The one budget that does reach this loop is the `adversary_nudge`'s own convergence budget, and it advises rather than refuses: it warns as the rounds add up, then tells you to stop and escalate once the loop counts as not converging. (Rounds are not *failures*: a dispatch that fails outright — provider error, malformed report — stays bound by the same-agent retry K=3 in the escalation ladder.) So *you* decide when it stops: when the rounds stop producing progress, **stop and escalate to the operator** in product language (list the residual findings as a product decision: accept these risks, or change the spec) and wait. Headless has no human in the turn: record them in `spec.md` under an explicit "Open risks" heading, stamp, proceed, and put them in the PR body for the human gate there. The `adversary_nudge` on each round's return tells you which of the three you are in — follow it. Grinding out rounds hoping for an empty array is the failure mode: an adversary asked to find failure modes always finds one, and every spec rewrite opens fresh surface.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does AND surface **each locked decision in plain product terms**. **Do not show code or schema.**  
**HEADLESS:** no wait — adversary clean is the gate; record the spec summary in the PR body.

**Ordered official transition (all modes):** after spec approval/validation, call native `mark({ action: "brainstormed" })`; after the required primary spec-adversary result is accepted, call native `mark({ action: "adversary_fired" })`. Persist both before attempting planner dispatch. The first transition fingerprints the canonical `spec.md`; the second binds the runtime-captured primary adversary Task result. These are ordered and idempotent; never substitute Bash markers or prose claims.

---

## Phase 1 — Plan

0. **Planner preflight / resume:** attempt planner only after the two official ceremony transitions above. A denial is stable structured JSON with `code`, `missing_proof`, and `next_transition`. Pass that exact object to native `ceremony-next({ denial })`; execute only `descriptor.coordinator_step`, and after successful completion/acceptance call `descriptor.completion_transition`. The consumer is the authority for the closed mapping (`oc-brainstorming` skill or `adversary` Task); if it rejects, stop. Never derive role/tool names from denial strings, and never dispatch `explore`, `general`, or a diagnostic subagent. Preflight may restore a marker after process restart only from session+feature+phase-bound evidence that verifies against the canonical spec/result; an old/unsigned marker is not evidence. If proof is absent or invalid, resume the exact named phase or stop and report `missing_proof` without inventing a terminal state.

1. Dispatch `planner` via Task with the approved spec. The planner returns one `execution-plan.json` (schema in `planner.md`; the planner self-validates structure first).

   **Provider recovery:** `planner-recovery` atomically claims each Task using OpenCode's `callID` plus a persisted attempt token. **You do NOT write the plan.** On a usable planner result the plugin itself persists the returned plan at the canonical path (atomic temp+rename) and binds it in the same hook — the plan never passes through your output tokens, so it cannot be paraphrased, truncated, or dropped. `plan-gate` still verifies one coherent locked snapshot against the current attempt's session/feature, exact `plan.feature_id`, semantic hash, prior-file fingerprint, final file hash/mtime/size, and structural validity before persisting `usable`. A response carrying two or more distinct full plans is `plan_invalid` (fail-closed on ambiguity — never "the first one wins"), as is a plan whose `feature_id` does not match the session; in both cases the existing canonical file is left untouched. Missing/legacy planner state fails closed. Never reuse an old plan.

   Real Task rejection is observed through OpenCode's `message.part.updated` / `ToolStateError` event (not only `tool.execute.after`). Authentication, credit, timeout, and provider failures set `planner_status: "planner_unavailable"` plus a bounded `planner_retry_outcome`. If `roles.planner.fallback` is configured and its agent model matches, dispatch `planner-fallback` exactly once; otherwise report `delivery-blocked` in pt-br and stop. A malformed, empty, stub, or prose-only output is `plan_invalid` even when its prose says `429`/provider; it never activates fallback. Active claims have a bounded lease: an expired primary converges to the configured fallback policy, while an expired/failed fallback converges to `delivery-blocked`. Until gate-state says `usable`, do not dispatch plan reviewers, test-author, executors, or snipers.
   Planner is **primary-only**: on REVISE or `plan_invalid` / `planning_revision`, re-dispatch **`planner`** (same model). Do **not** dispatch `planner-fallback`. The **K=3 budget is per review round, not per session**: each plan-review round that persists a REVISE credits a fresh set of 3 attempts, so a revision loop can run the full `plan_review_count` budget. What K=3 still bounds is *failure* inside one round (unparseable plan, refused envelope, provider blip) — after 3 of those in the same round, stop and comment (`delivery-blocked` / product error), never `git push` / `gh pr`, never implement inline. Your stop signals remain the K=3 round budget above and the `revise_nudge` of step 4. When the gate denies further planner dispatch, escalate to the operator and stop. Denies arrive as an instruction in product language; follow it instead of ending the turn silently.

2. **CANONICAL PATH — written for you by `planner-recovery` at:**
   ```
   .opencode/plans/<sessionID>-<feature_id>/execution-plan.json
   ```
   Do **not** re-emit the plan through `cat >` / heredoc: hand-transcribing an 8 KB JSON is exactly how a run stranded itself at `plan_pending_write` with every downstream dispatch gated. The plugin overwrites any classify stub in place. `validate-plan` and `plan-reviewer` read from this exact path. If the Task metadata says the plan was refused, fix it **with the planner** — never write the file yourself.

3. Run the **`validate-plan` tool** on that file — a deterministic **structural** gate. On FAIL, hand its error list to `planner` and re-plan. **Cap 2 loops**, then escalate to the operator in product-language. **Scope:** this cap governs only this structural retry (schema errors on a `validate-plan` FAIL); it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the adversary re-dispatch stop-rule, nor the escalation ladder's same-agent retry.

4. Dispatch `plan-reviewer` (read-only) for **engineering soundness**, then attempt `plan-reviewer-family-2` only when `roles.plan-reviewer.secondEyeModel` is set → `APPROVE | REVISE`. Every brief MUST require both passes and schema-compatible `problem: "Evidence: file:anchor — ..."`, including non-executable `<section>`, `<key>`, or `<operation>` anchors when no function exists. On REVISE: hand findings to `planner`, re-plan, re-run `validate-plan`, re-review. **Keep looping until APPROVE** — YOU must not dispatch a writing hand (executor/sniper/test-author) while REVISE stands; this is orchestration discipline, not a runtime gate (nothing refuses the dispatch for you — #483), so stopping mid-loop and dispatching one anyway silently strands the run's quality bar, not the run itself. The budget is enforced by the gate (`plan_review_count`, 10 useful rounds), not by your judgment: the `revise_nudge` on the review's return tells you the round and what remains. **That number is a courtesy copy of `LOOP_THRESHOLDS.plan_review.deny` (`loop-decide.mjs`) and can go stale** — the rail moves, prose does not follow on its own. When the two disagree the nudge is right and this file is wrong: read the round you are on and the rounds remaining from the nudge, never from memory and never from this file. Escalate to the operator **only** when that nudge says the budget is exhausted. This loop has no second budget: every other numbered cap in this skill belongs to a different loop and says so in its own section.

5. **DETERMINISTIC sensitive-path override:** compare the plan's `scope_paths` against the allowlist:
   `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding/upgrading deps).
   **ANY match FORCES FULL**, overriding triage. Determinism on the plan; judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, product-relevant risks. **Never expose the JSON.**  
**HEADLESS:** plan-reviewer **APPROVE** is the gate (single evaluator by default). On REVISE the next action is always the same, whatever the round number: re-dispatch `planner` with the findings, then re-dispatch `plan-reviewer` exactly as in Phase 1 — and the optional second eye only when routing declares one. A single-evaluator APPROVE **satisfies** the gate when no second eye is configured. The `revise_nudge` returned by every review states the remaining `plan_review_count` budget and is the sole authority on when this loop ends — follow what it says, and do not ship without APPROVE.

**Primary failure cap (`primary_failure_cap_reached`):** after **3 consecutive** unusable returns from the **same primary evaluator** (provider error, empty, malformed, denied, timeout — every failure class except `gate_blocked`, the harness's own pre-dispatch deny, which never counts), **stop delivery**. The counter is `primary_review_failure_streak` and its cap is `LOOP_THRESHOLDS.primary_failure_streak.deny` (`loop-decide.mjs`, today `AGENT_RETRY_K`); **the number here is a courtesy copy of that rail and can go stale** — when the two disagree, the rail wins. It is **not** the `Cap 2 loops` of step 3: that one bounds `validate-plan` structural re-plans on its own counter, so a second consecutive eye failure here is **not**, on its own, a stop. It is not the escalation ladder's same-agent retry K=3 either: that one bounds re-dispatch of any role and ends in a critical exception, while this one is a gate-state status that blocks delivery until a ceremony restart — they share the value only because both derive from `AGENT_RETRY_K`. A *different* primary role failing starts its own streak — the streak belongs to the role that produced it. **Spec-phase exemption:** the Phase 0 spec-`adversary` (no task, spec pass not yet stamped) never writes this status — its streak stops that broken eye from being re-dispatched, but nothing is frozen: report it to the operator in product language and follow the Phase 0 rule (headless: record under "Open risks" and proceed). Do **not** reclassify to QUICK, do **not** `git push` / `gh pr` — host rails still deny delivery (`bash-decide.mjs`) until a canonical ceremony restart (new generation + bound plan). **Writing hands (executor/sniper/test-author) are NOT blocked by this status anymore** (#482: `decideReviewCapBeforeWriting` was removed) — but their work cannot ship until the restart clears delivery, so re-dispatching them without a restart plan just burns cost. Comment the issue/PR in pt-br with the blocked reason (and any `last_provider_diagnostic` on gate-state). **Scope:** this cap governs only consecutive primary dispatches that came back with no usable report — the eye never delivered a verdict. A REVISE is a review that ran successfully and never counts here; it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the adversary re-dispatch stop-rule.

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
- **Official Task shape only:** dispatch with `{ description, prompt, subagent_type }`. For every `test-author`, `executor-*`, or `sniper-*` dispatch, include exactly one strict identity marker in `prompt`: `[HARNESS_TASK_CONTEXT]{"task_id":"<task id exactly as in the bound plan>"}[/HARNESS_TASK_CONTEXT]`. Do not invent top-level `feature_id` or `task_id` Task args. The runtime derives feature identity from trusted session gate-state and verifies this prompt marker against the bound snapshot.

---

## Phase 2 — Per-task loop

**Ensure a feature branch (NOT main/master) before the first write-capable hand dispatch in this phase:** OC's per-task loop has no per-task commit — every write-capable hand writes straight to the working tree, uncommitted; commits only happen once, in `shipper`, at the very end of the run (unchanged). The first write-capable dispatch in this phase is **not always `executor`** — in LIGHT mode it can be the `sniper` fixing an upfront spec-adversary finding (see "LIGHT: upfront spec-adversary" right below), which runs BEFORE the per-task loop's own `test-author` (step a′) and `executor` (step b). Any of these hands — `sniper`, `test-author`, `executor` — writing to `main`/`master` with no branch reproduces exactly the bug this fix closes. So: before dispatching **any** of them for the first time in this run — the LIGHT upfront sniper pass included, not just the per-task loop's executor — run `git branch --show-current`; if it returns `main` or `master`, create and check out a feature branch with `git switch -c <type>/<feature_id>` (kebab-case `<type>` per git.md — `feat`/`fix`/`refactor`/`chore`/`docs`). If the session is already on a branch other than main/master, use it as-is — do not create a new one. `shipper`'s own "Create branch" step becomes a fallback/assertion for the case where this check already ran (see `shipper.md`).

**LIGHT** runs `executor + gates` per task, plus ONE upfront `adversary` pass on the spec before the loop, and a final review (Phase 3).
**FULL** runs the full loop below per task.

### LIGHT: upfront spec-adversary

In LIGHT mode, before the first task, dispatch `adversary` **VIRGIN** against the spec + a read of the existing codebase to surface tech-debt risks. Consume its findings before the first task: route every actionable finding — severity ≥ medium, or any finding with a `fix_hint` — to `sniper-<tiers[finding.severity]>`. Each sniper pass re-runs the affected gates. Zero findings (or all ≤ low with no `fix_hint`) is a valid outcome. Upfront findings not dispatched to a sniper must be explicitly recorded as accepted-risk in `shared_context.md` before the per-task loop begins.

### Adversary re-dispatch stop-rule (post-sniper re-gate)

After a sniper fix triggers an adversary re-dispatch, apply this rule before looping. Matches the Claude Code lane form (`isGrave` + red→green + spot-check + iteration cap) — OC-native markers and paths only.

- **One predicate, defined once: `blocking` = severity ≥ medium.** A round is **clean** when it returns **zero blocking findings** — only findings of severity ≤ low, or none at all. *"≤ low"* and *"zero blocking findings"* (step g) are **one criterion written twice, never two thresholds**: this section decides when the loop ends, and step g is where that same decision is written to gate-state as `regate-passed` — **the same mechanism seen from two sides**. A `low` never blocks: route it to a sniper or record it as accepted risk in `shared_context.md`, but it neither keeps this loop open nor withholds the stamp.
- **`isGrave(fix)` — the grave predicate (evaluated on the FIX/diff).** A HIGH fix is grave when ANY holds: (i) the finding belongs to **any canonical-critical-class** (orphan-state/overwrite, idempotency/retry-corruption, race, determinism, and the rest of `oc-canonical-critical-classes` — not a hand-picked subset); (ii) the fix's diff hits the **sensitive-path allowlist**; (iii) the fix is **re-architecture** or **touches >1 function/seam**. A real HIGH adversary finding is almost always in a canonical class. **Default is hard bias-to-grave:** when in doubt, treat the fix as grave → full virgin adversary re-gate. The light path is opt-in only when the fix is *provably* non-canonical and localized. **A medium that armed the rail** (any `sniper-medium` DONE) is **never** on the light path — always full virgin re-gate. Light path is HIGH + `!isGrave` only.
- **Grave HIGH fix (`isGrave(fix)`) → MANDATORY re-gate:** fresh virgin `adversary` AFTER the fix. Stamp `regate-passed` only on **zero blocking findings**.
- **Non-grave surgical HIGH fix (`!isGrave(fix)`) → CONDITIONAL light path** — satisfy the re-gate by the cheaper of:
  - **(a) red→green frozen-test shortcut** — valid ONLY if a frozen `locked_test` was **RED pre-fix on the exact flagged assertion and GREEN post-fix** *because of* the fix. A test that merely **stays green** is **INSUFFICIENT**. When valid, that test **IS** the re-gate — call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD.
  - **(b) virgin adversary spot-check** — a fresh virgin `adversary` returning **zero blocking findings**. On zero blocking findings, stamp `regate-passed` the same way.
- **Stop** when the round is **clean** per the predicate above (or a light-path success stamped `regate-passed`).
- **On stop with no blocking finding open** — the clean stop: advance to the next step alone. **Only a clean stop clears the rail** — it is exactly the condition step g stamps `regate-passed` on.
- **Re-gate→sniper iteration cap:** after **2** re-gate→sniper cycles still failing on a HIGH finding — **whether the same defect or a brand-new one the previous fix created** — escalate: do **not** re-sniper a third time. Re-dispatch the **executor one tier up** for the task that owns the surface (`executor-low` → `executor-medium`, `executor-medium` → `executor-high`). One tier step per task, never chained. Brief the escalated executor that the uncommitted diff inside its `scope_paths` is a failed attempt by a weaker tier which it may rewrite or delete — **and nothing else: everything outside `scope_paths`, plus this task's frozen `locked_tests` wherever they live, including *inside* `scope_paths`, stays untouched** (OC has no per-task commit; a deleted frozen test is unrecoverable). Record that this task's tier step is **SPENT** in `shared_context.md` (survives compaction). Because that dispatch rewrites the implementation, **restart this loop's round counter at 1** in the same `shared_context.md` write. The new implementation is re-attacked by a fresh-virgin `adversary`.
  - **When there is no step left to spend** — tier step already spent (read the flag off `shared_context.md`), or the failing executor is already `executor-high` — escalate to the operator under the CAP = 3 rule immediately. At most one stronger-hand attempt per task.
  - **Which failure this bullet governs:** an **adversary HIGH with the task's gates GREEN**. If the escalated executor's `locked_tests`/gates come back **RED**, the escalation ladder's tier step wins: that is the **terminal state for this task → CRITICAL EXCEPTION** — not another sniper round.
- **CAP = 3 rounds of this loop** with at least one ≥ medium finding still open: **ESCALATE to the operator in pt-br** — translate the open finding to product impact. Never advance silently past CAP with a ≥ medium open. You keep the round count per task in `shared_context.md` (compaction resets an in-memory counter). Round 1 is the re-dispatch that opens this loop; every further re-dispatch inside the same loop counts. No runtime counter holds this round number — stopping is your call. A dispatch that fails outright (provider error, malformed report) stays bound by same-agent retry K=3 in the escalation ladder.
- **Stopping with a blocking finding still open is never silent.** Record the still-open finding verbatim (severity, class, `fix_hint`) plus its `task_id` to `shared_context.md` **and** `findings.md` **via bash**, and keep that text to inject into the `shipper` brief as an open risk item for the PR body (buffers die at harvest / are budget-capped — buffer-only recording is equivalent to not recording). Escalate on the CAP = 3 channel. INTERACTIVE: operator decides (accept → disarm below; "repensa" → reopens **one** new loop at round 1 — **once** for that task; a second CAP escalation on the same task is **CRITICAL EXCEPTION**, stamps nothing, no further repensa). HEADLESS: write the open PR risk item — that record is the **SIGNAL, not the accept**; it authorizes no `regate-passed`, and the rail stays armed. The late failure this prevents is `bash-decide` denying `git push` / `gh pr` and `entry-decide` (Gate 3) denying the `shipper` dispatch hours later.
- **Phase 3 scope.** In the final review there is no per-task `task_id` and no tier step to spend: the CAP unit is the whole final review (count does not restart between findings); signal the open finding into the `shipper` brief by attacked surface; a stronger-hand climb may still use the owning task's executor one tier up, but does not restart a per-task counter that does not exist.
- **Accepted risk after the CAP escalation — how the orphan `regate_pending` is actually cleared.** The operator's accept clears nothing by itself. Close the rail mechanically, in this order:
  1. **Record the risk before clearing anything** — write the still-open finding plus the accept decision to both buffers **via bash** **and** keep that text for the `shipper` brief / PR body.
  2. **Stamp the marker.** Call native `mark` with `action: regate-passed` + that `task_id` + `sha` = HEAD — the same tool and action as a clean re-gate. No "accepted-risk" marker variant exists.
  3. **Never hand-edit or delete `gate-state.json` to unblock.**
  - Accepting clears that one `task_id` only, only after the CAP escalation actually reached the operator (or headless open-PR risk item). Never stamp `regate-passed` on an open HIGH merely because the loop is tiresome.
  - A loop that ends in CRITICAL EXCEPTION instead of accept stamps nothing. Leave `regate_pending` unmatched and say so in the operator comment.

There is no "loop until clean" contract. Convergence is declared by the stop criteria above, not by the absence of findings.

### Before the first task

Initialize `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** (`cat >` / heredoc) — a **real file on disk** (not in-context memory): the task-to-task knowledge ledger. On-disk so it survives context compaction and keeps task-to-task traceability auditable. (The feature-branch guarantee is already handled above, at the top of Phase 2 — it runs before this ledger init too, since LIGHT's upfront sniper pass can precede it.)

### Per-task steps (topological order via `depends_on`)

| # | Step | Who / How |
|---|---|---|
| a | Pick executor tier | `executor-<tiers[task.complexity ?? task.severity]>` (low/medium/high; `max`→high). If `complexity` absent, fall back to `severity`. Re-score a path via `complexity-scorer` tool if needed (one call/path). |
| a′ | Locked test + fidelity (when rail applies) | Dispatch `test-author` first (fidelity-**exempt** — it produces the locked test). Then dispatch `compliance` in **fidelity mode** (pre-freeze: full-observable fidelity only, no green required). On fidelity **FAIL** (`partial` counts as FAIL), re-dispatch the **same** `test-author` with the feedback — **at most 2 `test-author` dispatches per `test_path`** in this pre-freeze gate (initial + exactly one re-dispatch; `test-author` receives one `test_path` per dispatch, so the count is per `test_path`, never per task). A provider/transient Task failure is not a fidelity verdict and consumes no attempt. On fidelity **PASS at any point — including after the escalation below** — stamp disk marker **before** any executor spawn (see Fidelity-rail stamp below). Freeze the locked test, then proceed to implement. **A 3rd `test-author` dispatch for the same `test_path` in this gate is forbidden, and this case does NOT fall through to the generic same-agent K=3 rule** — escalate the transcription to a stronger hand instead (see "Test-author fidelity escalation" right after this table). |
| b | Implement | Dispatch `executor-<tier>` via Task / `run-hand` with curated L0–L4 context. **Precondition:** `fidelity_pass` stamped for this feature/task (executor spawn returns `CONFIG_ERROR` if missing). Reads back `DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`. `NEEDS_CONTEXT` → supply the missing `resolved_judgment` or escalate. (route to critical exception — do not retry) |
| c | Compliance | Dispatch `compliance` (read-only, bash allow) with **diff + ACs + locked_tests only** — NOT shared_context, NOT adversary findings. Reads back `pass \| partial \| fail`. |
| d | Adversary (if `task.adversarial.enabled`) | Dispatch `adversary` **VIRGIN**, then attempt `adversary-family-2` only when `roles.adversary.secondEyeModel` is set — no prior verdicts, no compliance output, no shared_context — with task spec + `adversarial.focus` + diff. Every brief MUST require both passes and repo-relative `evidence: "file:anchor"`, using a function/exported symbol for code or a real `<section>`, `<key>`, or `<operation>` for a non-executable surface. Require each agent's exact JSON schema; never ask for verdict/sweep/mechanism fields. Zero findings is a **VALID result — never re-dispatch to hit a count**. A missing, malformed, or unanchored primary report is **NOT a pass — halt and escalate**. |
| e | Security (conditional) | Dispatch `security` when the task touches auth/secrets/external-input/new-deps/SQL/service-entrypoint. Returns `SECURE \| UNSAFE` + issues. |
| f | Gates (deterministic, no LLM) | For a targeted Vitest file, run it directly via bash against the exact named path (or use `verify` for the resolver lookup). Run other prescribed gates through their existing channel. Failure → issue list. |
| g | Fix | Map ALL issues (compliance + adversary + security + gates) to `sniper-<tiers[issue.severity]>`. Sniper is the ONLY fixer (`edit` allow, `bash` deny, no new files). **HIGH fix — or a `medium` in an irreversible class (orphan-state/race/idempotency):** after the sniper returns DONE, call native `mark` with `action: regate-pending` + that task's `task_id` (host `obs-hand` also auto-arms sealed `regate_pending` — belt + suspenders). **The host arms the rail on ANY `sniper-medium`/`sniper-high` that returns DONE, whatever the finding's severity** — so an ordinary `medium` routed to `sniper-medium` leaves `regate_pending` armed too: run the same fresh-virgin re-dispatch and stamp `regate-passed`, or the push is denied at the end of the run. Then re-dispatch `adversary` fresh-virgin against the NEW surface the fix created (or take the light path when `!isGrave(fix)` — § Adversary re-dispatch stop-rule). On **zero blocking findings** — `blocking` = severity ≥ medium, so a clean round is one returning only ≤ low or none: the single stop predicate of § Adversary re-dispatch stop-rule, where this stamp and that loop's stop are the **same mechanism, not two thresholds** — call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. Unmatched `regate_pending` is **delivery-blocking** (`bash-decide` denies `git push` / `gh pr`). Documented exits: this clean re-gate; the independent `compliance` fidelity PASS re-gate of § Test-author fidelity escalation (that dispatch arms the rail too); and, once the CAP escalation is answered with accepted risk, the record-then-`regate-passed` disarm in § Adversary re-dispatch stop-rule. After sniper, re-run the affected gates. **The fixer is not the sniper forever:** after **2** re-gate→sniper cycles still leaving a HIGH open, the next fix goes to the **executor one tier up** (§ Adversary re-dispatch stop-rule iteration cap) — not a third sniper pass. |
| h | Record | Rewrite `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** with the budget-capped knowledge ledger so far; adversary never reads it. **The rewrite is read-modify-write:** read the file off disk first and carry its protected block — the round counter and the tier-step SPENT flag of § Adversary re-dispatch stop-rule — forward verbatim; the budget cap never evicts it and it is never rebuilt from memory. Append this task's raw finding blocks (compliance/adversary/security/sniper) to the run `findings.md` buffer at the project root **via bash** — it is the producer the harvester/`oc-recording-findings` consumes; if never written, the run's learnings are lost. |
| i | Escalate | See escalation ladder below. |

### Test-author fidelity escalation (compliance fidelity gate — distinct from generic K=3)

When the **compliance fidelity gate** (step a′) does not reach PASS within the **2** permitted `test-author` dispatches for a `test_path`, escalate transcription to a stronger hand — **not** the generic same-agent K=3. Matches the Claude Code rule (iteration cap 2 → stronger hand).

- **Escalate to `sniper-high`, don't retry to death.** After the 2nd `test-author` fidelity FAIL, dispatch **`sniper-high`** against the already-written test file (with `[HARNESS_TASK_CONTEXT]`), handing it the compliance fidelity feedback as `fix_hint` plus the full pinned-assertion list. Map compliance prose ("Problemas encontrados" + `NÃO` rows) into per-assertion instructions. Frame the brief so restoring named assertions inside the existing file **is** the defect (sniper refuses ambiguous scope). Tier is fixed at high by design. After DONE, re-dispatch `compliance` in fidelity mode — only `pass` is PASS; `partial`/`fail` are FAIL. No file on disk → no escalation; go straight to CRITICAL EXCEPTION.
- **CLOSE THE RE-GATE RAIL.** Host `obs-hand` auto-arms `regate_pending` on any `sniper-high`/`sniper-medium` DONE. The moment `compliance` returns fidelity **PASS**, call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. The independent compliance fidelity PASS is the re-gate of record for this rail.
- **On PASS, resume the normal rail.** Stamp `fidelity_pass` via native `mark`, freeze the locked test, dispatch the executor.
- **One extra attempt.** If the repaired transcription also fails fidelity — or `sniper-high` returns `BLOCKED`/`NEEDS_CONTEXT` — **stop immediately** as CRITICAL EXCEPTION. Do not re-dispatch.
- **Budget counts fidelity verdicts only** inside the pre-freeze gate. Provider/transient Task failure consumes no attempt and keeps same-agent K=3. Post-freeze maintenance edits are a different dispatch shape.

**Mid-run observability belt (Telegram outbox — fail-open, never gates delivery):** when `HARNESS_OBSERVABILITY_RUN_PATH` is set (VPS headless), emit the same curated events the drain already renders. Prefer structural producers (plugins `obs-plan-write` / `obs-eye` / `obs-hand` + classify `pipeline-type`). `obs-hand` emits `task-executing` (before) and `hand-ran` (after) for executor/sniper/test-author from the trusted session feature plus the required prompt task marker — do not rely on unsupported Task args or prose alone. Additionally, the conductor MUST run these observability-only mark-gate CLI side-effects (idempotent / fail-open if env unset):

```bash
# After the primary plan-reviewer result (APPROVE|REVISE):
node .opencode/plugin/lib/mark-gate.mjs plan-reviewed --verdict APPROVE

# After upfront / final spec adversary (obs only — map issues[] length; never ask the eye for a verdict string):
node .opencode/plugin/lib/mark-gate.mjs spec-adversaried --findings 0

# At the top of each task loop (1-based n / total from plan.tasks):
node .opencode/plugin/lib/mark-gate.mjs task-executing --n <n> --total <total>

# After final review (Phase 3) — observability only (does NOT stamp gate-state):
node .opencode/plugin/lib/mark-gate.mjs final-review-done
```

**Privileged ship markers (native `mark` only — never Bash / mark-gate CLI):**
- After Phase 3 join (FULL): `action: final-review` → sealed `final_review_done` (push-blocking).
- After operator demo (FULL interactive): `action: demo-done` → sealed `demo_done` (push-blocking when not headless).

Do not invent alternate event type strings — only the types in `notify-telegram` FEED_ALLOWLIST.

**Post-hand capture path (OC-native — Task hands, not CC spawn-hand):**

1. Host `obs-hand` writes the hand-record on Task terminal and, when outcome is DONE (Status line **or** git touched paths), **auto-stamps** sealed `hand_finished` + `capture_verified` + `capturedVerifiedAt`. You do **not** need `capture-hand.mjs` (Claude Code only).
2. Still call native `mark` `hand-finished` / `capture-verified` if the host did not stamp (belt). An `ok:false` here means the capture belt could **not** be stamped — never ship on a stamp you did not get. **Split by cause — never one blanket retry order:**
   - **The hand ran and refused — `BLOCKED` / `NEEDS_CONTEXT`, or the dispatch was denied before it ever ran (`CONFIG_ERROR`):** **CRITICAL EXCEPTION**, **no retry**. Do **not** re-dispatch. Same outlet as § Per-task steps step b and § Escalation ladder "Hand CONFIG_ERROR → critical exception". **Read the refusal off the Task read-back, never off the record:** the host records no `CONFIG_ERROR` status and may promote a `BLOCKED` hand to `DONE` when git shows touched paths — a record can hide a refusal.
   - **The dispatch itself broke — provider/transient Task failure:** re-dispatch under the **same-agent K=3** in § Escalation ladder — existing counter for this role(/task), not a fresh 3.
   - **`DONE_WITH_CONCERNS`:** neither branch — do **not** re-dispatch and do **not** route to critical exception on the unstampable record alone. The concern is judged by compliance/gates, then the escalation ladder's tier step when a compliance `fail`/`partial` or red gate confirms it. Carry the missing stamp as open risk / operator raise.
   - **Reading the cause:** a refusal is a verdict with a read-back. Absence of read-back is transient **only when the dispatch reached the provider**. A pre-dispatch gate deny (`[entry-gate] Blocked:…`) leaves no record — `mark` answers *"hand-record missing or unreadable"* — that is CONFIG_ERROR, CRITICAL EXCEPTION, no retry. Never infer either cause from the record's state alone.
3. Never use Bash or `mark-gate` CLI for privileged markers.
4. **Ship on the parent `build` session only.** `shipper` may draft PR text; conductor runs push/PR bash on the parent after capture is present.

**Fidelity-rail stamp (after compliance fidelity PASS → before executor):** Call the native `mark` tool with `action: fidelity` and the locked test's `task_id`. The tool derives session and feature identity from the runtime envelope and gate-state. This stamp **MUST** precede executor dispatch; Bash and direct module imports are not privileged marker surfaces.

An executor hand spawn is **DENIED** (`CONFIG_ERROR`) unless `fidelity_pass` contains this feature/task (optional `@sha`). `test-author` is exempt — it creates the test that enables fidelity. Freeze-commit alone is not enough; the stamp is the on-disk signal `run-hand` and the entry-gate consume. (route to critical exception — do not retry)

Advance to the next task only when its gates are green.

### Escalation ladder (engineering — never handed to the human)

Two distinct concerns, never mixed: **transient failure** (the dispatch itself broke — same tier, K=3 attempts) and **implementation failure** (the executor ran and its work does not hold — **one tier up, once**). The `test-author` fidelity gate is neither — it has its own rule.

**Carve-out — `test-author` fidelity gate (step a′) only:** the generic same-agent K=3 rule below does **NOT** govern a `test-author` FAIL at the compliance fidelity gate. That case: **2 `test-author` dispatches per `test_path`, then escalate transcription to `sniper-high`** (§ Test-author fidelity escalation). Provider/transient failures on that rail still get K=3 below.

**Same-agent retry K=3 (all Task roles — planner, eyes, hands):** on provider/transient Task failure, re-dispatch the **same** `subagent_type` up to **3** times. After 3 failures → **CRITICAL EXCEPTION** (stop + comment) — on this concern never swap models and never bump tier. You must count failures and stop at 3 yourself; success resets the counter for that role(/task). A REVISE is not a failure — it is a successful review answered with a re-plan.

- **Is a non-DONE capture record inside this trigger? Only when the cause is transient.** A `mark` `ok:false` for a record that never reached DONE (§ Post-hand capture path, step 2) is **inside** `on provider/transient Task failure` when *that* is why it never reached DONE. It is **outside** when the hand ran and refused (`BLOCKED` / `NEEDS_CONTEXT`) or was denied before it ran (`CONFIG_ERROR`): outlet is **CRITICAL EXCEPTION with no retry**. A `DONE_WITH_CONCERNS` record is outside too — nothing failed; the concern is the tier-escalation path's to judge when compliance/gates confirm it. The trigger is the **cause**, never the record's state.

**Executor tier escalation (implementation failure — one tier up, once per task):** when the executor **ran** and the work does not hold — the task's `locked_tests` / gates are still red after the sniper pass of step g, or the executor returned `DONE_WITH_CONCERNS` and the concern is confirmed by a compliance `fail`/`partial` or a red gate — re-dispatch the **EXECUTOR one tier up** for that same task: `executor-low` → `executor-medium`, `executor-medium` → `executor-high`. Never escalate the **sniper**. Matches the Claude Code form: one tier above, once.

- **The step is spent once per task.** No second tier step. If the escalated executor also fails its gates → **CRITICAL EXCEPTION**.
- **Top of the ladder:** failing executor already `executor-high` → **CRITICAL EXCEPTION** directly.
- **CRITICAL EXCEPTION is the outlet only after the step is spent (or does not exist)** — never surface a capacity failure to the operator while an unspent tier step remains.
- **NO working-tree reset before the escalated dispatch — OC has no per-task commit anchor.** Brief the escalated executor: the uncommitted diff inside its `scope_paths` is a **failed attempt by a weaker tier** — it may rewrite or delete that diff. Everything outside `scope_paths` — frozen `locked_tests` included — stays untouched.

**Hand CONFIG_ERROR → critical exception (NOT a tier escalation):** when a hand dispatch fails precondition / never ran (e.g. missing fidelity_pass stamp, CONFIG_ERROR), do NOT retry same tier and do NOT bump tier. Route to CRITICAL EXCEPTION: INTERACTIVE surface to operator in pt-br product language; HEADLESS record as open PR risk item.

A fix bigger than surgical scope (re-architecture) is **not** a sniper job → re-dispatch `executor-<tier>` or split the task. Available **at most once per task**, and only when the failure is a plan defect. **Any split/re-plan that re-runs `planner` → `planner-recovery` persists the revised plan** (§ Phase 1). Never hand-write `execution-plan.json`. Re-run `validate-plan` before resuming executors.

transient retry same tier within K=3 → still failing after 3 → **CRITICAL EXCEPTION**: translate to product impact, surface to operator in pt-br ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa?"), never as a technical problem.

## LIGHT vs FULL

| | LIGHT | FULL |
|---|---|---|
| Plan | light plan (`mode: "light"`) | full plan (`mode: "full"`) |
| Spec analysis | ONE upfront `adversary` pass (virgin) against the spec + codebase, before the per-task loop | covered per task |
| Per-task review | executor + gates only; no compliance/adversary between tasks | full loop (steps c–g per task) |
| Final review | compliance + adversary, whole feature | final review + per-task loop |

**Tiering of the executor applies in both modes** — a small feature can still generate debt if a high-severity task is run on a weak model.

---

## Phase 3 — Final review (both modes, feature-wide)

Scope = the **whole feature**, not one task.

- `compliance` — whole implementation vs spec.
- `adversary` — **VIRGIN**, hunts bugs across the full feature with both passes and repo-relative `evidence: "file:anchor"`, including non-executable anchors.

Findings → tiered sniper (same rules as Phase 2, step g). Re-run gates after fixes. Proceed only when feature-wide gates are green.

**Ship rail (FULL — privileged):** after the final review completes (every dispatched eye result collected, feature-wide gates green), call the native `mark` tool with `action: final-review`. This stamps sealed `final_review_done: true` on gate-state. **FULL `git push` / `gh pr` is denied without it** (`denied_class=final-review-missing`). Bash and `mark-gate` CLI cannot stamp this — host-issued native mark only.

Also emit the observability-only checkpoint (fail-open, does not gate delivery):

```bash
node .opencode/plugin/lib/mark-gate.mjs final-review-done
```

---

## Phase 4 — Demo

Generate a demo script derived from the **UJs/ACs** (`demo.scenarios_from_refs`), **never from the implementation** — otherwise it is the student grading their own exam.
- `demo.type`: `smoke` (API/CLI) · `playwright` (complex UI) · `markdown` (batch/cron).

**HARD-GATE 3 — test demo (pt-br, product-language):** the operator validates the product by using the output. The human is insubstitutable here.

**Ship rail (FULL interactive — privileged):** after the operator validates the demo, call the native `mark` tool with `action: demo-done`. This stamps sealed `demo_done: true` on gate-state. **Interactive FULL push is denied without it** (`denied_class=demo-missing`). Headless sessions (`gate-state.headless`, `CLAUDE_CODE_REMOTE`, or `OPENCODE_HEADLESS`) auto-validate the demo artifact against ACs and **do not** require `demo_done` for push.

---

## Phase 5 — Harvest + ship

- Dispatch `harvester` once: consolidates `findings.md`, routes durable learnings by blast-radius (project pattern → native MEMORY.md + index · law of one folder → that folder's nested `AGENTS.md` + root router row · global convention → kaizen proposal), then **deletes the ephemeral run buffers** — `findings.md` (project root) + `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` (git is the durable audit). It owns `oc-recording-findings` / `oc-distilling-learnings` / `oc-proposing-improvements`. It never auto-writes to memory.
- Delivery (branch/commit/push/PR via `shipper`) happens **only on explicit operator authorization** — merge/deploy is irreversible (human checkpoint). `shipper` never edits code.
- **FULL ship preconditions (bash-decide):** ceremony + regate + capture + **final-review** + **demo when interactive**. Missing final/demo → deny with explicit `denied_class`.

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
- Final review passed; sniper fixes re-gated. **DELIVERY-BLOCKING:** every `regate-pending` in gate-state has a matching `regate-passed` (same task_id) — refuse delivery while any HIGH/medium sniper fix is still `regate-pending` without its `regate-passed`.
- Demo script derived from UJs/ACs (not implementation), tested by the operator.
- `harvester` ran; durable learnings routed (native memory / nested AGENTS.md / kaizen); ephemeral buffers deleted.
- **adversary entered virgin on every dispatch** — no prior verdict leaked.
- Every operator message was pt-br product-language.
- No product code or test file was written by `build` itself, via the edit tool or bash — those only ever come from a dispatched executor/sniper/test-author. (`build`'s own orchestration artifacts — spec, plan cache, shared context, decision ledger — are written directly with the edit tool; see `## File writes` above.)
