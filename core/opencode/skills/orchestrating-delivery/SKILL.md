---
name: oc-orchestrating-delivery
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
  → HARD-GATE 2 → per-task loop → final dual review → demo → HARD-GATE 3 → harvest → ship
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
| HARD-GATE 2 (plan) | operator confirms | `plan-reviewer` dual **APPROVE** is the gate |
| HARD-GATE 3 (demo) | operator tests | auto-validate ACs; attach to PR |
| Delivery | merge on operator OK | **draft PR only — never merge** |

**Headless golden rules:** never block on questions; never invent product decisions when the trigger is silent (stop + comment); never skip dual eyes when configured; never dispatch `executor-*` until a **full** plan (not classify stub) exists and plan-gate allows.

---

## Dispatchable subagents (exact names only)

| Role | Exact `subagent_type` names |
|---|---|
| Plan | `planner`, optional `planner-fallback`, `plan-reviewer-family-1`, `plan-reviewer-family-2` |
| Implement | `executor-low`, `executor-medium`, `executor-high`, `test-author` |
| Verify | `compliance`, `adversary-family-1`, `adversary-family-2`, `security` |
| Fix | `sniper-low`, `sniper-medium`, `sniper-high` |
| Close | `harvester`, `shipper` |

There is **NO** single `executor` or `sniper` agent — tiered names only. Tier is chosen by you at dispatch; it is never hardcoded in the plan.

### Dual-always (plan-reviewer + adversary)

Always dispatch mandatory family 1 and attempt optional family 2 for plan-reviewer and adversary (ADR-003). Task tool has no model field — dual = two canonical agent files.

**Runtime module:** `dual-runtime.mjs` in this skill folder — `driveDualEye`, `mergeDualFindings`, `mergeDualVerdicts`, `virginSecondaryBrief`, `isFullDualCoverage`, `dualStatusGatePatch`.

| Step | Action |
|---|---|
| 1 | Dispatch primary (`plan-reviewer-family-1` / `adversary-family-1`) |
| 2 | Dispatch secondary (`plan-reviewer-family-2` / `adversary-family-2`) with **virgin** brief — same contract, no primary verdict, no compliance output, no `shared_context` |
| 3 | On secondary auth/unavailable → `dual_status: "primary_only"`; record the reason separately; keep primary findings only; **never invent** secondary findings; warn operator (pt-br) |
| 4 | On secondary infra error (rate limit / 5xx / crash) → retry secondary once (K=1); if retry ok → upgrade to `both` + merge; if retry fails → `dual_status: "primary_only"`, record failure separately, keep primary only + warn |
| 5 | On both ok → merge via policy B (shared `finalizeFindings` / `mergeVerdicts`); `dual_status: "both"` |
| 6 | Active gate-state records **enum only**: `both` \| `primary_only` \| `pending` — never bare boolean. `primary_only` is **not** full dual coverage; legacy fail-open/error values are read-only compatibility |

Never skip the second family when configured. Never treat fail-open as cross-family coverage for metrics.

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
4. **Upfront spec-adversary (mandatory LIGHT/FULL):** dispatch `adversary-family-1` (+ optional `adversary-family-2`). The Task prompt MUST say to follow the agent's exact JSON schema and MUST NOT request `SHIP`/`BLOCK`, `verdict`, `mechanism`, `sweep`, `blockers`, or any extra field. Family 1 returns only `{ "issues": [...] }`.

   **Acceptance is defined, and "clean" is not the only way out.** No unresolved medium/high finding → the pass is accepted: stamp the marker and go to the plan. A material finding with rounds to spare → revise `spec.md` so it is answered (a criterion that pins the behaviour, or an explicit locked decision that accepts it), then re-attack. **Nothing refuses another round** — *this* loop, the Phase 0 spec-adversary, is never denied deterministically: no cap freezes it, and none hands the spec back on its own. **The `CAP = 3 rounds` under "Adversary re-dispatch stop-rule" does not govern it** — that rule bounds the **post-sniper** adversary re-dispatch (Phase 2 per-task, and the Phase 3 final review that inherits its rules), a different loop; reaching a third round *here* with a medium still open is **not**, by itself, a reason to hand the spec back. The one budget that does reach this loop is the `adversary_nudge`'s own convergence budget, and it advises rather than refuses: it warns as the rounds add up, then tells you to stop and escalate once the loop counts as not converging. (Rounds are not *failures*: a dispatch that fails outright — provider error, malformed report — stays bound by the same-agent retry K=3 in the escalation ladder.) So *you* decide when it stops: when the rounds stop producing progress, **stop and escalate to the operator** in product language (list the residual findings as a product decision: accept these risks, or change the spec) and wait. Headless has no human in the turn: record them in `spec.md` under an explicit "Open risks" heading, stamp, proceed, and put them in the PR body for the human gate there. The `adversary_nudge` on each round's return tells you which of the three you are in — follow it. Grinding out rounds hoping for an empty array is the failure mode: an adversary asked to find failure modes always finds one, and every spec rewrite opens fresh surface.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does AND surface **each locked decision in plain product terms**. **Do not show code or schema.**  
**HEADLESS:** no wait — adversary clean is the gate; record the spec summary in the PR body.

**Ordered official transition (all modes):** after spec approval/validation, call native `mark({ action: "brainstormed" })`; after the required primary spec-adversary result is accepted, call native `mark({ action: "adversary_fired" })`. Persist both before attempting planner dispatch. The first transition fingerprints the canonical `spec.md`; the second binds the runtime-captured primary adversary Task result. These are ordered and idempotent; never substitute Bash markers or prose claims.

---

## Phase 1 — Plan

0. **Planner preflight / resume:** attempt planner only after the two official ceremony transitions above. A denial is stable structured JSON with `code`, `missing_proof`, and `next_transition`. Pass that exact object to native `ceremony-next({ denial })`; execute only `descriptor.coordinator_step`, and after successful completion/acceptance call `descriptor.completion_transition`. The consumer is the authority for the closed mapping (`oc-brainstorming` skill or `adversary-family-1` Task); if it rejects, stop. Never derive role/tool names from denial strings, and never dispatch `explore`, `general`, or a diagnostic subagent. Preflight may restore a marker after process restart only from session+feature+phase-bound evidence that verifies against the canonical spec/result; an old/unsigned marker is not evidence. If proof is absent or invalid, resume the exact named phase or stop and report `missing_proof` without inventing a terminal state.

1. Dispatch `planner` via Task with the approved spec. The planner returns one `execution-plan.json` (schema in `planner.md`; the planner self-validates structure first).

   **Provider recovery:** `planner-recovery` atomically claims each Task using OpenCode's `callID` plus a persisted attempt token. **You do NOT write the plan.** On a usable planner result the plugin itself persists the returned plan at the canonical path (atomic temp+rename) and binds it in the same hook — the plan never passes through your output tokens, so it cannot be paraphrased, truncated, or dropped. `plan-gate` still verifies one coherent locked snapshot against the current attempt's session/feature, exact `plan.feature_id`, semantic hash, prior-file fingerprint, final file hash/mtime/size, and structural validity before persisting `usable`. A response carrying two or more distinct full plans is `plan_invalid` (fail-closed on ambiguity — never "the first one wins"), as is a plan whose `feature_id` does not match the session; in both cases the existing canonical file is left untouched. Missing/legacy planner state fails closed. Never reuse an old plan.

   Real Task rejection is observed through OpenCode's `message.part.updated` / `ToolStateError` event (not only `tool.execute.after`). Authentication, credit, timeout, and provider failures set `planner_status: "planner_unavailable"` plus a bounded `planner_retry_outcome`. If `roles.planner.fallback` is configured and its agent model matches, dispatch `planner-fallback` exactly once; otherwise report `delivery-blocked` in pt-br and stop. A malformed, empty, stub, or prose-only output is `plan_invalid` even when its prose says `429`/provider; it never activates fallback. Active claims have a bounded lease: an expired primary converges to the configured fallback policy, while an expired/failed fallback converges to `delivery-blocked`. Until gate-state says `usable`, do not dispatch plan reviewers, test-author, executors, or snipers.
   Planner is **primary-only**: on REVISE or `plan_invalid` / `planning_revision`, re-dispatch **`planner`** (same model). Do **not** dispatch `planner-fallback`. The **K=3 budget is per review round, not per session**: each plan-review round that persists a REVISE credits a fresh set of 3 attempts, so a revision loop can run the full `plan_review_count` budget. What K=3 still bounds is *failure* inside one round (unparseable plan, refused envelope, provider blip) — after 3 of those in the same round, stop and comment (`delivery-blocked` / product error), never `git push` / `gh pr`, never implement inline. A separate session-lifetime ceiling stops a pathological run: **`PLANNER_SESSION_DISPATCH_CEILING`** — today **13** planner dispatches, derived as `plan_review` deny (10) + K (3), not picked — counted by the gate itself on `planner_dispatches_total`, and cleared by no reset. **You never keep that count.** The only number you track is the K=3 round budget above; exhausting it is a round-budget stop, never this ceiling, and a run that has spent it may still be far from 13. You learn the ceiling fired one way only: the gate's own deny, which names it explicitly. Until that deny arrives, assume the session still has margin **on this ceiling specifically** — never report `delivery-blocked` on a session ceiling you inferred from your own tally. That is not a licence to loop: your stop signals remain the round budget above and the `revise_nudge` of step 4. When it does arrive, escalate to the operator and stop. Both denies now arrive as an instruction in product language; follow it instead of ending the turn silently.

2. **CANONICAL PATH — written for you by `planner-recovery` at:**
   ```
   .opencode/plans/<sessionID>-<feature_id>/execution-plan.json
   ```
   Do **not** re-emit the plan through `cat >` / heredoc: hand-transcribing an 8 KB JSON is exactly how a run stranded itself at `plan_pending_write` with every downstream dispatch gated. The plugin overwrites any classify stub in place. `validate-plan` and `plan-reviewer` read from this exact path. If the Task metadata says the plan was refused, fix it **with the planner** — never write the file yourself.

3. Run the **`validate-plan` tool** on that file — a deterministic **structural** gate. On FAIL, hand its error list to `planner` and re-plan. **Cap 2 loops**, then escalate to the operator in product-language. **Scope:** this cap governs only this structural retry (schema errors on a `validate-plan` FAIL); it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the adversary re-dispatch stop-rule, nor the escalation ladder's same-agent retry.

4. Dispatch `plan-reviewer-family-1` (read-only) for **engineering soundness**, then attempt `plan-reviewer-family-2` → `APPROVE | REVISE`. On REVISE: hand findings to `planner`, re-plan, re-run `validate-plan`, re-review. **Keep looping until APPROVE** — YOU must not dispatch a writing hand (executor/sniper/test-author) while REVISE stands; this is orchestration discipline, not a runtime gate (nothing refuses the dispatch for you — #483), so stopping mid-loop and dispatching one anyway silently strands the run's quality bar, not the run itself. The budget is enforced by the gate (`plan_review_count`, 10 useful rounds), not by your judgment: the `revise_nudge` on the review's return tells you the round and what remains. **That number is a courtesy copy of `LOOP_THRESHOLDS.plan_review.deny` (`loop-decide.mjs`) and can go stale** — the rail moves, prose does not follow on its own. When the two disagree the nudge is right and this file is wrong: read the round you are on and the rounds remaining from the nudge, never from memory and never from this file. Escalate to the operator **only** when that nudge says the budget is exhausted. This loop has no second budget: every other numbered cap in this skill belongs to a different loop and says so in its own section.

5. **DETERMINISTIC sensitive-path override:** compare the plan's `scope_paths` against the allowlist:
   `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding/upgrading deps).
   **ANY match FORCES FULL**, overriding triage. Determinism on the plan; judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, product-relevant risks. **Never expose the JSON.**  
**HEADLESS:** plan-reviewer dual **APPROVE** is the gate. On REVISE the next action is always the same pair, whatever the round number: re-dispatch `planner` with the findings, then re-dispatch both plan-reviewer families exactly as in Phase 1 (dual is the gate — a single-family review never satisfies it). The `revise_nudge` returned by every review states the remaining `plan_review_count` budget and is the sole authority on when this loop ends — follow what it says, and do not ship without APPROVE.

**Primary failure cap (`primary_failure_cap_reached`):** after **3 consecutive** unusable returns from the **same family-1 eye** (provider error, empty, malformed, denied, timeout — every failure class except `gate_blocked`, the harness's own pre-dispatch deny, which never counts), **stop delivery**. The counter is `primary_review_failure_streak` and its cap is `LOOP_THRESHOLDS.primary_failure_streak.deny` (`loop-decide.mjs`, today `AGENT_RETRY_K`); **the number here is a courtesy copy of that rail and can go stale** — when the two disagree, the rail wins. It is **not** the `Cap 2 loops` of step 3: that one bounds `validate-plan` structural re-plans on its own counter, so a second consecutive eye failure here is **not**, on its own, a stop — though the rail refuses a new reservation once the streak plus any *open* family-1 reservations reach the cap, so serialize family-1 dispatches and your count matches its. It is not the escalation ladder's `Same-agent retry K=3` either: that one bounds re-dispatch of any role and ends in a critical exception, while this one is a gate-state status that blocks delivery until a ceremony restart — they share the value only because both derive from `AGENT_RETRY_K`. A *different* family-1 role failing starts its own streak — the streak belongs to the role that produced it. **Spec-phase exemption:** the Phase 0 spec-`adversary` (no task, spec pass not yet stamped) never writes this status — its streak stops that broken eye from being re-dispatched, but nothing is frozen: report it to the operator in product language and follow the Phase 0 rule (headless: record under "Open risks" and proceed). Do **not** reclassify to QUICK, do **not** `git push` / `gh pr` — host rails still deny delivery (`bash-decide.mjs`) until a canonical ceremony restart (new generation + bound plan). **Writing hands (executor/sniper/test-author) are NOT blocked by this status anymore** (#482: `decideReviewCapBeforeWriting` was removed) — but their work cannot ship until the restart clears delivery, so re-dispatching them without a restart plan just burns cost. Comment the issue/PR in pt-br with the blocked reason (and any `last_provider_diagnostic` on gate-state). **Scope:** this cap governs only consecutive family-1 dispatches that came back with no usable report — the eye never delivered a verdict. A REVISE is a review that ran successfully and never counts here; it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the adversary re-dispatch stop-rule.

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

**LIGHT** runs `executor + gates` per task, plus ONE upfront `adversary` pass on the spec before the loop, and a final dual review (Phase 3).
**FULL** runs the full loop below per task.

### LIGHT: upfront spec-adversary

In LIGHT mode, before the first task, dispatch `adversary-family-1` **VIRGIN** against the spec + a read of the existing codebase to surface tech-debt risks. Consume its findings before the first task: route every actionable finding — severity ≥ medium, or any finding with a `fix_hint` — to `sniper-<tiers[finding.severity]>`. Each sniper pass re-runs the affected gates. Zero findings (or all ≤ low with no `fix_hint`) is a valid outcome. Upfront findings not dispatched to a sniper must be explicitly recorded as accepted-risk in `shared_context.md` before the per-task loop begins.

### Adversary re-dispatch stop-rule

After a sniper fix triggers an adversary re-dispatch, apply this rule before looping:
- **One predicate, defined once: `blocking` = severity ≥ medium (#545 #ac-1.2).** A round is **clean** when it returns **zero blocking findings** — only findings of severity ≤ low, or none at all. *"≤ low"* and *"zero blocking findings"* (step g) are **one criterion written twice, never two thresholds**: this section decides when the loop ends, and step g is where that same decision is written to gate-state as `regate-passed` — **the same mechanism seen from two sides (#545 #ac-1.1)**. A `low` never blocks: route it to a sniper or record it as accepted risk in `shared_context.md`, but it neither keeps this loop open nor withholds the stamp.
- **Stop** when: the round is **clean** per the predicate above, OR the same severity-tier distribution repeats across consecutive rounds with no reduction (stagnation).
- On stop with **no blocking finding open** — the clean stop, and the stagnation that stagnates on ≤ low only: advance to the next step alone, do not wait for the operator. **Only a clean stop clears the rail** — it is exactly the condition step g stamps `regate-passed` on. A stagnation stop is *not* clean and authorizes no stamp (next bullet).
- **Stopping with a blocking finding still open is never silent, and never a solo advance (#545 #ac-1.3).** **Precedence, before anything else:** if the stagnation carries a `high` still open and this task's Axis-2 tier step is **not yet spent** (read the flag off `shared_context.md`, never off memory), the stronger-hand rule below wins and **this is not a stop at all** — the next fix goes to the executor one tier up, the round counter restarts at 1, and nothing in this bullet applies. Engineering is never delegated to the operator while a stronger hand is unspent. What this bullet governs is the remainder: a stagnation with only `medium` open, or with a `high` open once that tier step is spent (or the owner already is `executor-high`) — the "no step left to spend" case below.
  In that remainder the loop stops with the `regate_pending` step g armed for that `task_id` still unmatched — and an unmatched entry surfaces only at the END of the run, when `bash-decide` denies `git push` / `gh pr` and `entry-decide` (Gate 3) denies the `shipper` dispatch, hours later, naming only the `task_id` and never the finding or its `fix_hint` (a compaction in between re-injects `unmatched_regates`, but nothing else surfaces it). So:
  1. **Record — three destinations, not two.** Write the still-open finding verbatim (severity, class, `fix_hint`) plus its `task_id` and the fact that its rail is still armed to `shared_context.md` **and** `findings.md` **via bash** (step h), at the moment the loop stops and before the next task starts — **and keep that text to inject literally into the `shipper` brief as an open risk item for the PR body**. Both buffers are deleted by the `harvester` in Phase 5 before the ship, and the `shared_context.md` ledger is budget-capped (step h), so buffer-only recording is equivalent to not recording at all — the same rule the accepted-risk disarm below states for the same reason.
  2. **Escalate now.** Raise it on the CAP = 3 escalation channel below and in the same terms — **this *is* that escalation, reached early by stagnation instead of by round 3**, and the "never advance silently with a ≥ medium open" of that bullet governs here identically. INTERACTIVE: the operator's answer decides (accept → advance; "repensa" → the fix that follows opens a NEW loop at round 1 — **once** for that finding, never again: item 3 caps the repeat). HEADLESS: there is no operator, so the record of step 1 is written as an open PR risk item per the entry policy's critical-exception mapping and the run advances on it — but **that record is the SIGNAL, not the accept**: it authorizes no `regate-passed`, and the rail stays armed. It becomes the accept-of-record of the disarm below only in the exhausted case that opens this bullet (tier step spent, or already `executor-high`), never merely because a stagnation ended the loop early.
  3. **Ceiling — "repensa" is granted ONCE per finding; the second stagnation is terminal (#565 #ac-1.1).** The "repensa" branch of item 2 reopens the loop at round 1, and stagnation fires again from round 2 — so nothing in items 1–2 stops the same task from stagnating on the **same** finding a second time and putting the identical decision in front of the operator again, and again. That sequence is capped, and the cap is a terminal state, not another escalation: when the `stagnation_key` (item 4) of the finding that motivates the escalation **in front of you** is **already recorded as escalated-and-answered-`repensa`**, the loop does **not** escalate. This holds **in both directions and for either stop** — this bullet's stagnation and the `CAP = 3` round below reopen the loop at round 1 in the same words, so an escalation of either kind both *records* a key when it is answered `repensa` and is *replaced by this terminal* when it meets one already recorded (a loop reopened after `repensa` that reaches round 3 without ever stagnating is the same ping-pong through the sibling exit, and ends here too). It ends the task in **CRITICAL EXCEPTION**: stop and comment in pt-br product language, in the same register as the CAP escalation but as a decision that is now about scope rather than about accepting a risk (*"tentamos duas vezes e o mesmo problema volta — não dá pra resolver dentro deste escopo"*). **This CRITICAL EXCEPTION carries no question:** it does **not** use the *"(a) aceita (b) repensa"* template of § Escalation ladder — no answer reopens the loop, the task is over, and an operator who still wants another attempt is re-scoping, which happens in a new run. **It stamps nothing**: `regate_pending` for that `task_id` stays unmatched, and the comment must say so **and name the consequence** — `git push` / `gh pr` and the `shipper` dispatch stay denied for the **whole run**, and with no per-task commit in OC (§ Phase 2) the other tasks' work stays uncommitted in the working tree — so a restart is not mistaken for a ship-blocked bug, the same convention as the CRITICAL EXCEPTION branch of § Accepted risk below. The terminal itself never stamps — § Accepted risk says the same of every loop that ends in CRITICAL EXCEPTION instead of accept. What can still clear the rail is the operator answering **this comment** with accept: that is a product decision, it runs the record-then-stamp disarm of that section unchanged, and it is never a second `repensa` (nothing reopens the loop). **Precedence is untouched:** this item lives inside the remainder this bullet opened with, so the Axis-2 check still runs FIRST — a second stagnation carrying a `high` while the task's tier step is still unspent is a **climb, not a stop**, and never reaches this ceiling. Engineering is never delegated to the operator with a stronger hand unspent, and it is never delegated **twice**. **Phase 3** has no task (§ Phase 2 scope, below): there the terminal ends the **final review** instead — it arms no new `regate_pending`, any Phase 2 rail already unmatched stays unmatched, and the comment identifies the finding by the attacked surface, exactly as item 4's key does.
  4. **The tracking key: what it is, when it is written, what it survives (#565 #ac-1.3).** `stagnation_key` = `task_id` + the finding's `category` + its `scope` + **the `file:function` anchor its `evidence` cites** — the enclosing function or exported symbol, **never a line number**: each `repensa` produces a new fix that shifts lines, so a line-anchored key would fail to match its own repeat and the ceiling would never fire at all. If the `evidence` cites only a line, take the function that contains it; if the surface has no function (a prose/doc file), take its section heading. Lowercase, and strip the repo prefix from the path. `category` and `scope` are literal report fields; the anchor is a mechanical read of one short `evidence` string — the smallest judgement the report leaves you — and all three are deliberately **not** the finding's `description` or `fix_hint`: every round re-attacks **fresh-virgin** and re-words the same defect from scratch, so a key hanging on prose lets a re-titled repeat walk through the ceiling. **`evidence` is in the key for the opposite reason:** `category` + `scope` alone is exactly the signature the climb rule below calls the *expected* case — *"a fix that keeps growing fresh races on its own surface"*, same class, same file, **different** defect — and with the one or two paths a task usually scopes it would collapse into "the canonical class of this task", terminating a finding the operator has never seen. Drift cuts the other way and is accepted deliberately: a re-label (a different `category`, an anchor moved to the caller) reads as a **new** key and gets its own escalation. **The same tie-break settles the residual collision** — a defect the fix grew inside the very function the previous one lived in: when `category`, `scope` and the anchor all match but the report describes a **different trigger sequence** than the one recorded, it is a new key. The prose is never the key; it is the tie-break, and this ceiling always breaks toward asking once more, never toward silencing a finding the operator has not seen. **When:** the line is written **at the moment the operator's answer arrives** — not at the loop's stop (item 1), where no answer exists yet — via bash, and **before the reopened loop's first re-dispatch**. A key with no answer recorded arms nothing. **Where:** in the same `shared_context.md` write **via bash** (step h) that carries this loop's round counter and the Axis-2 SPENT flag — one line per key plus its answer (`repensa`/`accept`) — and it is **load-bearing gate state, not knowledge: the ledger's budget cap never evicts it, and it is never held in memory alone**, the same protection the counter and the SPENT flag need for the same reason. **What "survives compaction" means concretely:** step h *rewrites* the whole ledger from what is in context, so every step-h rewrite is **read-modify-write** — read the file off disk first and copy that protected block **verbatim** into the new version, never reconstructing it from memory; a rewrite whose **read** of the file failed is aborted rather than written (a task whose block does not exist yet is not a failed read — it is the first write), and step h's `findings.md` append is a separate write that the abort never holds back. Nothing in the runtime holds any of this — no gate-state marker counts stagnations, `regate_pending` says only that a rail is armed, and the adversary never reads the ledger (step h) — so computing and writing the key is **yours**, not the runtime's and not the agent's. **Scope and cleanup:** keys are per `task_id`, so the next task in the same run starts with none of them and never inherits another task's ceiling; when a task ends by a clean stop or an accept, its keys leave the protected block on the next step-h rewrite, so the block carries the current task's keys plus its counter and flag and nothing else (a terminal stops the run, so there is no next rewrite and nothing to clean). They are run-scoped and never need to survive the `harvester` — this terminal fires inside Phase 2/3, before the ship. In **Phase 3** there is no `task_id` (§ Phase 2 scope, next bullet): the key is that final review's `category` + `scope` + `evidence` anchor alone, identifying the finding by the attacked surface exactly as that carve-out already does.
  5. **The ceiling matches an exact repeat and nothing else (#565 #ac-1.2).** A stagnation whose key is **not** already recorded is a first stagnation and follows items 1–2 unchanged, however many other keys this task has already burned: a different `category`, a different `scope`, and — the case that decides this criterion — **the same `category` on the same `scope` with a different `evidence` anchor**, which is the brand-new finding the previous fix created (the failure mode § the climb rule below exists for), not the old one returning. Each carries its own key and flows normally; the operator still gets that decision once. A finding that was genuinely fixed does not come back, so it never matches anything. Only the exact repeat — same task (in Phase 3, the same final review), same `category`, same `scope`, same anchor, same trigger, already answered `repensa` once — is terminal. HEADLESS never reaches this ceiling at all: with no operator there is no `repensa`, item 2 advances the run on the signal instead of reopening the loop, so no key is ever recorded as answered — which is why item 3's terminal has no headless branch of its own.
  - **Phase 2 scope.** In Phase 3's final dual review there is no `task_id` and no next task (§ CAP = 3): the signal is still emitted at the moment the loop stops, but its only destination is the `shipper` brief, and it identifies the finding by the attacked surface instead of by `task_id`.
  Advancing itself clears nothing: the rail is cleared only by a later clean re-gate or, once that escalation is answered with accept, by the record-then-stamp disarm below.
- **CAP = 3 rounds *of this loop*** with at least one ≥ medium finding still open: **ESCALATE to the operator in pt-br** — translate the open finding to product impact ("o login pode falhar se o usuário fizer X — aceita o risco? / repensa?"). Never advance silently past CAP with a ≥ medium open. **Which counter this is:** the one **you**, the orchestrator, keep — per task and per loop, never read off gate-state (see the bullet below); carry the current round in `shared_context.md` (step h rewrites it anyway), because a counter that lives only in context silently resets to 1 on compaction, exactly on the long runs where the cap matters. Round 1 is the re-dispatch that OPENS this loop (the first one after the fix that answered the previous adversary round); **every further re-dispatch inside the same loop counts too**, including the ones that follow the snipers this loop's own findings triggered — otherwise the count resets every round and the cap is unreachable. It restarts only when the loop closes or the attacked surface is replaced: the stop criteria above, the next task, an Axis-2 executor tier-step that rewrites this task's implementation, or the operator's answer to a CAP escalation (accept → advance; "repensa" → the fix that follows opens a NEW loop at round 1, so escalating never ping-pongs — **and the reopened loop cannot ping-pong back**: an escalation of this bullet whose finding was already answered `repensa` once is replaced by a terminal instead of asking the operator the same question again, whether the reopened loop got there by stagnating again or by reaching round 3 without stagnating (stagnation bullet, item 3, #565 #ac-1.1)). In Phase 3's final dual review there is no task: the unit is that whole final review — ONE loop over the feature-wide surface, and the count does **not** restart between findings. No runtime counter holds this round number and nothing refuses round 4 for you — stopping is your call. Rounds are not *failures*, though: a dispatch that fails outright (provider error, malformed report) is not a round — it feeds the family-1 primary failure streak, which is **run-wide per role** (not per task, unlike the escalation ladder's K=3) and clears only on a useful report; once that streak is spent the runtime **does** refuse the next adversary dispatch and stamps `primary_failure_cap_reached`, which is delivery-blocking. **Scope:** this cap governs only this post-sniper adversary re-dispatch loop; it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the escalation ladder's same-agent retry below.
- **The round is NOT `adversary_loop_count`** — never read it off that number. `adversary_loop_count` (gate-state, `loop-decide.mjs`) is **run-wide observability, and never the escalation decision of *this* loop** (in Phase 0 its `adversary_nudge` does drive that loop's stop — here it drives nothing): it increments on every *useful* family-1 adversary outcome of the whole run — the Phase 0 spec pass, LIGHT's upfront spec pass, each task's step d, each of this loop's re-dispatches, and the Phase 3 final review, clean passes included (a malformed/failed report and every family-2 outcome credit nothing) — and it never denies an adversary dispatch nor freezes the run, unlike `plan_review_count`, which does deny. It is also **not surfaced to you**: the only loop warning delivered on the metadata channel (`loop_guard_warning`) is the plan-review round-rail, so a warning you see there is never about this loop. Concretely: the Phase 0 spec pass alone already left the number above zero, and tasks 1 and 2 each running one clean per-task adversary put it at 3 or beyond before *this* loop has run a single round — matching the CAP against it escalates a decision the loop has not earned. Its `adversary_nudge` belongs to the Phase 0 spec loop and goes quiet once `adversary_fired` is stamped, which happens before Phase 1 — so it never speaks for this loop; if that marker is ever missing, a spec-loop nudge surfaces here anyway, in either flavour: "revise `spec.md` and re-attack", or — once the run-wide count is spent — "stop, escalate, stamp `adversary_fired`, dispatch `planner`". Ignore both for this loop's decision, and report the missing marker as a ceremony anomaly (Phase 1 preflight requires it) rather than acting on the nudge.

- **After 2 sniper-fixed rounds still leaving a HIGH open, climb the hand — do not re-sniper a third time (#544 #ac-1.1).** Rounds 1 and 2 of this loop belong to the sniper. When both have been answered by a sniper fix and this loop still has a `high` finding open — **whether it is the same defect or a brand-new one the previous fix created** (a fix that keeps growing fresh races on its own surface is exactly the failure mode this rule exists for) — the next fix does **not** go to `sniper-<tier>`. Escalate that one fix to the **executor one tier up** for the task that owns the surface (`executor-low` → `executor-medium`, `executor-medium` → `executor-high`), the same move the Claude Code lane makes (`core/claude-code/skills/orchestrating-delivery/SKILL.md`, "Re-gate→sniper iteration cap": *"do not loop the cheap sniper indefinitely on a grave finding"*). This **is** the task's Axis-2 tier step and is spent under § Escalation ladder Axis 2 exactly as written — one step per task, never chained, and **no working-tree reset in OC**: brief the escalated executor that the uncommitted diff inside its `scope_paths` is a failed attempt by a weaker tier which it may rewrite or delete — **and nothing else: everything outside `scope_paths`, plus this task's frozen `locked_tests` wherever they live, including *inside* `scope_paths`, stays untouched.** OC has no per-task commit (§ Phase 2), so a deleted frozen test is unrecoverable and would turn the gate green by vacuity. Because that dispatch rewrites this task's implementation, it also **restarts this loop's round counter at 1** (a reset boundary already listed above) — and in the same `shared_context.md` write that carries the round, record that **this task's Axis-2 tier step is SPENT**: that flag is the entire floor of this escape and, exactly like the counter, does not survive compaction unless it is on disk. The new implementation is then re-attacked by a fresh-virgin `adversary-family-1` like any other fix, and any HIGH it returns is snipered normally.
  - **When there is no step left to spend** — the task's Axis-2 tier step is already spent (read the flag off `shared_context.md`, never off memory), or the failing executor is already `executor-high` (top of the ladder) — there is no stronger hand to climb to. Do **not** manufacture extra sniper rounds to fill the gap: escalate to the operator under the CAP = 3 rule **immediately**, without waiting for a 3rd round that has no fix left to produce it. The ladder is finite by construction — at most one stronger-hand attempt per task, then the decision is the operator's, so this escape can never itself become an endless loop.
  - **Which failure this bullet governs, and which belongs to Axis 2.** This rule fires on an **adversary HIGH with the task's gates GREEN**. If the escalated executor's `locked_tests`/gates come back **RED**, § Escalation ladder Axis 2 wins outright: that is the **terminal state for this task → CRITICAL EXCEPTION** — not another sniper round, not another CAP escalation.
  - **Phase 2 scope.** This is the per-task loop of step g. In Phase 3's final dual review there is no task to own a tier step: a fix may still be escalated to the owning task's executor one tier up, but the final-review round count does **not** restart (§ CAP = 3, "the count does not restart between findings").
- **Accepted risk after the CAP escalation — how the orphan `regate_pending` is actually cleared (#544 #ac-1.2).** The step-g fix that opened this loop armed sealed `regate_pending` for that `task_id`, and an unmatched entry **denies `git push` / `gh pr` and the `shipper` dispatch indefinitely** — the operator's *"aceito o risco, pode seguir"* is a product decision that by itself clears nothing. When the CAP escalation is answered with **accept** (INTERACTIVE: the operator answers accept; HEADLESS: there is no operator, so the CAP escalation is recorded as an open PR risk item per the entry policy's critical-exception mapping, and that record is the decision of record — the PR review is the human gate), close the rail mechanically, in this order:
  1. **Record the risk before clearing anything — and the durable destination is the PR body.** `findings.md` and `shared_context.md` are buffers the `harvester` **deletes in Phase 5, before the ship**, so recording only there is equivalent to not recording at all. Write the still-open finding verbatim (severity, class, `fix_hint`) plus the accept decision to both buffers **via bash** (step h) **and** keep that text to inject literally into the `shipper` brief as an open risk item for the PR body. Without that carry-over the disarm is not authorized: once the marker is stamped, this record is the only trace the risk was ever taken.
  2. **Stamp the marker.** Call native `mark` with `action: regate-passed` + that `task_id` + `sha` = HEAD — the same tool and the same action as a clean re-gate. This is the **only** surface that clears `regate_pending`: bash and the `mark-gate` CLI refuse every privileged marker, and the native tool requires the matching `regate_pending` entry to already exist. There is deliberately **no** "accepted-risk" marker variant and none is needed — the accepted risk lives in the record of step 1, never in gate-state. **Which is exactly why step 1 is the only control there is:** gate-state keeps no distinction between this stamp and a clean re-gate, and the runtime cannot tell that an escalation ever happened. In HEADLESS, where the precondition is text you write yourself, the stamp is legitimate only once the risk item is in the `shipper` brief.
  3. **Never hand-edit or delete `gate-state.json` to unblock.** Neither is a documented path: an edited `regate_pending` that stops being a JSON array denies **fail-closed** (a worse deadlock), and deleting the file discards `fidelity_pass` / `final_review_done` along with the rail.
  - **Accepting is a decision, not a free loop exit.** It clears that one `task_id` only, it is available **only after** the CAP escalation actually reached the operator (or, headless, was written as the open PR risk item), and it never replaces the stronger-hand attempt above — a tier step still unspent means the engineering is not finished, and engineering is never delegated to the human. Never stamp `regate-passed` on an open HIGH merely because the loop is tiresome.
  - **A loop that ends in CRITICAL EXCEPTION instead of accept stamps nothing.** Leave `regate_pending` unmatched and say so in the operator comment, so a restart is not mistaken for a ship-blocked bug (same convention as the fidelity rail above).

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
| d | Adversary (if `task.adversarial.enabled`) | Dispatch `adversary-family-1` **VIRGIN**, then attempt `adversary-family-2` — no prior verdicts, no compliance output, no shared_context — with task spec + `adversarial.focus` + diff. Require each agent's exact JSON schema; never ask for verdict/sweep/mechanism fields. Returns issues ranked by irreversibility (`category` + `severity` + `fix_hint`). Zero findings is a **VALID result** — never re-dispatch to hit a count. A missing or malformed primary report is **NOT a pass** — halt and escalate. |
| e | Security (conditional) | Dispatch `security` when the task touches auth/secrets/external-input/new-deps/SQL/service-entrypoint. Returns `SECURE \| UNSAFE` + issues. |
| f | Gates (deterministic, no LLM) | For a targeted Vitest file, run it directly via bash against the exact named path (or use `verify` for the resolver lookup). Run other prescribed gates through their existing channel. Failure → issue list. |
| g | Fix | Map ALL issues (compliance + adversary + security + gates) to `sniper-<tiers[issue.severity]>`. Sniper is the ONLY fixer (`edit` allow, `bash` deny, no new files). **HIGH fix — or a `medium` in an irreversible class (orphan-state/race/idempotency):** after the sniper returns DONE, call native `mark` with `action: regate-pending` + that task's `task_id` (host `obs-hand` also auto-arms sealed `regate_pending` — belt + suspenders). **The host arms the rail on ANY `sniper-medium`/`sniper-high` that returns DONE, whatever the finding's severity** (`plugin/lib/regate-arm.mjs` + `plugin/obs-hand.ts` key off role + outcome only) — so an ordinary `medium` routed to `sniper-medium` leaves `regate_pending` armed too: run the same fresh-virgin re-dispatch and stamp `regate-passed`, or the push is denied at the end of the run. Then re-dispatch `adversary-family-1` fresh-virgin against the NEW surface the fix created. On **zero blocking findings** — `blocking` = severity ≥ medium, so a clean round is one returning only ≤ low or none: the single stop predicate of § Adversary re-dispatch stop-rule, where this stamp and that loop's stop are the same mechanism, not two thresholds (#545 #ac-1.1, #ac-1.2) — call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. A **stagnation** stop is not clean and authorizes no stamp: it leaves this rail armed, and that section requires the open finding to be signalled at the moment you advance, not discovered at push time. Unmatched `regate_pending` is **delivery-blocking** (bash-decide denies `git push` / `gh pr`) — and its documented exits are: this clean re-gate; the independent `compliance` fidelity PASS re-gate of § Test-author fidelity escalation (that dispatch arms the rail too); and, once the CAP escalation is answered with accepted risk, the record-then-`regate-passed` disarm in § Adversary re-dispatch stop-rule. **The fixer is not the sniper forever:** when 2 rounds of that loop were already answered by a sniper fix and a HIGH is still open, the next fix goes to the executor one tier up, not to a third sniper (same section). Re-run the affected gate after every sniper pass. |
| h | Record | Rewrite `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** with the budget-capped knowledge ledger so far; adversary never reads it. **The rewrite is read-modify-write:** read the file off disk first and carry its protected block — the round counter, the Axis-2 SPENT flag and the `stagnation_key` lines of § Adversary re-dispatch stop-rule — forward verbatim; the budget cap never evicts it and it is never rebuilt from memory. Append this task's raw finding blocks (compliance/adversary/security/sniper) to the run `findings.md` buffer at the project root **via bash** — it is the producer the harvester/`oc-recording-findings` consumes; if never written, the run's learnings are lost. |
| i | Escalate | See escalation ladder below. |

### Test-author fidelity escalation (compliance fidelity gate — distinct from generic K=3)

When the **compliance fidelity gate** (step a′) does not reach PASS within the 2 permitted `test-author` dispatches for a `test_path`, that is a **dedicated rule** — **not** the generic same-agent K=3 retry rule of the Escalation ladder below. The transcription escalates to a stronger hand for that one `test_path`; the run does **not** die and the ceremony is **not** restarted (#534).

> **Parity note (source-repo provenance — this path does NOT exist in an OpenCode-only vendored project, so nothing needs to be opened; the rule is quoted in full here).** The Claude Code lane of this harness carries the same rule at `core/claude-code/skills/orchestrating-delivery/SKILL.md`, **Phase 2 step 1b** — *"Iteration cap: 2 — after 2 FAIL cycles, escalate transcription to a stronger hand (skip the cheap test-author; use the compliance-tier model to author the test directly)"* — restated at its step 7 as *"If the compliance fidelity gate (step 1b) fails after 2 cycles, the escalation is to a stronger Claude eye for the transcription, not an `escalation_fallback` ticket dispatch."* CC escalates by raising the **model** of the transcription (its Agent dispatch takes a model override). OC's `task` tool has **no model field** (see § Dual-always), so OC escalates by dispatching a **different agent file** whose model is the strong tier. **The step is smaller than CC's, and saying so matters:** CC climbs to an eye-tier model, OC climbs one tier *within the cheap-hand family*. What is preserved is the guarantee that **one stronger attempt happens before the run dies** — not model-strength parity with CC.

- **Escalate to `sniper-high`, don't retry to death (#534 #ac-1.1).** After the 2nd `test-author` fidelity FAIL for a `test_path`, do **not** dispatch `test-author` a 3rd time, and do **not** charge this to the generic K=3 same-agent budget. Dispatch **`sniper-high`** against the already-written test file (carrying the mandatory `[HARNESS_TASK_CONTEXT]` prompt marker like any hand dispatch — § Context curation), handing it the compliance fidelity feedback as the `fix_hint` plus the full pinned-assertion list for that `test_path`.
  - **Deriving the `fix_hint` (the eye does not emit one).** `compliance` returns prose, not a finding object: map its **"Problemas encontrados"** entries plus the rows marked `NÃO` in its fidelity table into an explicit per-assertion instruction. The sniper applies a `fix_hint` **literally**, so name each pinned observable to restore and where.
  - **Pre-authorize the shape of the work in the brief.** `sniper-high`'s contract is "one defect, minimum delta, no new files" and it emits `BLOCKED` on an ambiguous hint or scope creep. State in the brief that **restoring the named pinned assertions inside this existing file IS the exact defect and IS the minimum delta** — adding the missing `test()` blocks is the fix, not scope creep. Without that framing the honest sniper refuses the job.
  - **Tier is fixed here, by design.** This is the one dispatch where the sniper tier does **not** derive from `issue.severity` (§ How to pick tier): the high tier *is* the reason for the escalation. `sniper-high` is kept on the strong coder tier in `harness.routing.json`; never name a model slug in prose or at dispatch.
  - **Why `sniper-high` and not a stronger eye:** the runtime only accepts `executor`, `sniper`, and `test-author` as writing hands, and of those only `test-author` and `sniper` are **exempt from the fidelity rail** — the executor is denied pre-stamp by construction. Every eye (`compliance`, `adversary-*`, `security`, `plan-reviewer-*`) is `edit: deny` and cannot author a file at all. `sniper-high` is therefore the only dispatchable role that is both stronger than the cheap hand and permitted to write here. It is also already the harness's designated fixer, and an unfaithful transcription is exactly a surgical fix: an existing file whose named assertion must be restored.
  - **The freeze has not happened yet at step a′** (it comes after the fidelity stamp), so the post-freeze prohibition on a hand touching the locked test is simply not in play — this rule does not weaken it.
  - **`compliance` stays the independent judge.** After `sniper-high` returns DONE, re-dispatch `compliance` in fidelity mode over the repaired file. The agent that wrote the transcription never validates it — author and judge remain separate, which is the entire reason the fidelity gate exists. **Verdict mapping:** only `pass` is a fidelity PASS; `partial` and `fail` both count as FAIL and consume the attempt.
  - **No file on disk → no escalation.** If the `test-author` dispatches left **no** test file at `test_path`, `sniper-high` cannot help (it patches existing files and emits `BLOCKED` rather than creating one). Go straight to the CRITICAL EXCEPTION below.
- **CLOSE THE RE-GATE RAIL — this dispatch arms it automatically (delivery-blocking if ignored).** The host `obs-hand` auto-arms sealed `regate_pending` for **any** `sniper-high`/`sniper-medium` Task that returns DONE — it keys off role + outcome only and has no notion of which pipeline step dispatched it, so this fidelity dispatch arms it exactly like a step-g fix would. An unmatched `regate_pending` **denies the `shipper` dispatch and denies `git push` / `gh pr`** at the end of the run. So, the moment `compliance` returns fidelity **PASS** on the repaired file, call native `mark` with `action: regate-passed` + that `task_id` + `sha` = HEAD. **The independent `compliance` fidelity PASS is the re-gate of record for this rail** — the step-g adversary re-gate exists to attack the new *production* surface a fix created, and this fix touched a pre-freeze test file, not production. If the escalation ends in CRITICAL EXCEPTION instead, the run stops anyway; note the unmatched `regate_pending` in the operator comment so a restart is not mistaken for a ship-blocked bug.
- **On PASS, resume the normal rail (#534 #ac-1.1).** A fidelity PASS on the repaired file is an ordinary PASS: stamp `fidelity_pass` via native `mark` (§ Fidelity-rail stamp), freeze the locked test, then dispatch the executor — exactly as if the first `test-author` dispatch had passed. There is no separate post-escalation path; skipping the stamp here would deny the executor spawn with `CONFIG_ERROR` and kill the run the rule exists to save.
- **One extra attempt — the safety net still ends the run (#534 #ac-1.2).** If the repaired transcription **also** fails fidelity — **or if `sniper-high` returns `BLOCKED`/`NEEDS_CONTEXT` instead of a repair** — **stop immediately and comment in pt-br** as a CRITICAL EXCEPTION (product language; headless records it as an open PR risk item). Do **not** re-dispatch `sniper-high`, `test-author`, or any other role for this `test_path` in either direction, and do **not** read the generic "Same-agent retry K=3" paragraph as granting a fresh 3-dispatch budget to the newly-involved role. The escalation buys exactly one extra attempt before the run stops; it never replaces the final safety net.
- **What the attempt budget counts — and what it does not (#534 #ac-1.4).** The 2-dispatch cap and the no-retry rule above count **fidelity verdicts only**, and only inside the **pre-freeze** gate at step a′. A **provider/transient Task failure** (429, timeout, 5xx, crash) on `test-author` **or** on the `compliance` eye is not a fidelity verdict: it does not consume an attempt and keeps the generic K=3 same-agent retry below, unchanged. Likewise, the ban on a 3rd `test-author` dispatch is scoped to this pre-freeze gate — the agent's legitimate **post-freeze maintenance edit** (a fixture bug, an environment-specific read swap) is a different dispatch shape and is not counted or forbidden here. Outside this rail, every Task role — planner, eyes, and hands — keeps the generic K=3 behaviour exactly as written.

**Mid-run observability belt (Telegram outbox — fail-open, never gates delivery):** when `HARNESS_OBSERVABILITY_RUN_PATH` is set (VPS headless), emit the same curated events the drain already renders. Prefer structural producers (plugins `obs-plan-write` / `obs-eye` / `obs-hand` + classify `pipeline-type`). `obs-hand` emits `task-executing` (before) and `hand-ran` (after) for executor/sniper/test-author from the trusted session feature plus the required prompt task marker — do not rely on unsupported Task args or prose alone. Additionally, the conductor MUST run these observability-only mark-gate CLI side-effects (idempotent / fail-open if env unset):

```bash
# After dual plan-reviewer merge (APPROVE|REVISE):
node .opencode/plugin/lib/mark-gate.mjs plan-reviewed --verdict APPROVE

# After upfront / final spec adversary (obs only — map issues[] length; never ask the eye for a verdict string):
node .opencode/plugin/lib/mark-gate.mjs spec-adversaried --findings 0

# At the top of each task loop (1-based n / total from plan.tasks):
node .opencode/plugin/lib/mark-gate.mjs task-executing --n <n> --total <total>

# After final dual review join (Phase 3) — observability only (does NOT stamp gate-state):
node .opencode/plugin/lib/mark-gate.mjs final-review-done
```

**Privileged ship markers (native `mark` only — never Bash / mark-gate CLI):**
- After Phase 3 join (FULL): `action: final-review` → sealed `final_review_done` (push-blocking).
- After operator demo (FULL interactive): `action: demo-done` → sealed `demo_done` (push-blocking when not headless).

Do not invent alternate event type strings — only the types in `notify-telegram` FEED_ALLOWLIST.

**Post-hand capture path (OC-native — Task hands, not CC spawn-hand):**

1. Host `obs-hand` writes the hand-record on Task terminal and, when outcome is DONE (Status line **or** git touched paths), **auto-stamps** sealed `hand_finished` + `capture_verified` + `capturedVerifiedAt`. You do **not** need `capture-hand.mjs` (that is Claude Code only).
2. Still call native `mark` `hand-finished` / `capture-verified` if the host did not stamp (belt) — if mark returns `ok:false` because record is not DONE, treat as hand failure and re-dispatch the hand, do not ship. The budget for that re-dispatch is the **same-agent K=3 defined below in § Escalation ladder** — 3 attempts of *this specific hand*, counted per role(/task), reset on success. It is that role(/task)'s **existing** counter, not a fresh 3: attempts this hand already burned earlier in the task still count against it. It is **not** the planner's K=3 (per plan-review round) and **not** the adversary's CAP = 3 rounds (§ Adversary re-dispatch stop-rule); rounds already spent by those counters do not consume this hand's attempts.
3. Never use Bash or `mark-gate` CLI for privileged markers.
4. **Ship on the parent `build` session only.** Do **not** rely on `shipper` Task child for `git push` / `gh pr` (child sessions are not writing-hand-bound). `shipper` may draft PR title/body text; conductor runs push/PR bash on the parent after capture is present.

**Fidelity-rail stamp (after compliance fidelity PASS → before executor):** Call the native `mark` tool with `action: fidelity` and the locked test's `task_id`. The tool derives session and feature identity from the runtime envelope and gate-state. This stamp **MUST** precede executor dispatch; Bash and direct module imports are not privileged marker surfaces.

An executor hand spawn is **DENIED** (`CONFIG_ERROR`) unless `fidelity_pass` contains this feature/task (optional `@sha`). `test-author` is exempt — it creates the test that enables fidelity. Freeze-commit alone is not enough; the stamp is the on-disk signal `run-hand` and the entry-gate consume. (route to critical exception — do not retry)

Advance to the next task only when its gates are green.

### Escalation ladder (engineering — never handed to the human)

Two distinct axes on this ladder, never mixed: **transient failure** (the dispatch itself broke — same tier, K=3 attempts) and **implementation failure** (the executor ran and its work does not hold — one tier up, K=1 tier step). Each has its own counter; neither consumes the other's budget. The `test-author` fidelity gate is neither — it has its own rule (carve-out right below).

**Carve-out — `test-author` fidelity gate (step a′) only:** the generic same-agent K=3 rule below does **NOT** govern a `test-author` FAIL at the compliance fidelity gate. That one case has its own rule — **2 `test-author` dispatches per `test_path`, then escalate the transcription to `sniper-high`** ("Test-author fidelity escalation", right after the Per-task steps table). No **fidelity-verdict** retry budget applies to any role on that rail: neither `test-author` nor `sniper-high` gets a fresh K=3 for a FAIL there. The CRITICAL EXCEPTION below applies when the `sniper-high` transcription also fails fidelity **or returns `BLOCKED`/`NEEDS_CONTEXT`**. The carve-out covers **fidelity verdicts only** — a provider/transient Task failure on that rail still gets the K=3 rule below — and it is scoped to that gate alone: `planner`, the eyes, and every hand outside the fidelity rail keep the K=3 rule exactly as written.

**Same-agent retry K=3 — Axis 1 (all Task roles — planner, eyes, hands):** on provider/transient Task failure, re-dispatch the **same** `subagent_type` (same model) up to **3** times. After 3 failures → **product error / CRITICAL EXCEPTION** (stop + comment) — on this axis never swap models and never bump tier (a broken dispatch is no evidence that the model was too weak; tier escalation belongs to Axis 2). **The host does NOT block the 4th dispatch anymore** (#482: the in-session brake was removed and is not replaced — cron-a-exit.mjs is the real per-issue ceiling, outside this session). You must count failures and stop at 3 yourself; success resets the counter for that role(/task). **Scope:** this cap governs only a single role's transient provider failures on one dispatch — never a review verdict; it never bounds the plan-reviewer APPROVE/REVISE loop, whose only budget is `plan_review_count` (see HARD-GATE 2), nor the adversary re-dispatch stop-rule above, nor Axis 2's tier step below. A REVISE is not a failure for this counter — it is a successful review, answered with a re-plan, never retried as if the dispatch itself broke.

transient retry same tier within K=3 → still failing after 3 → **CRITICAL EXCEPTION**: translate to product impact, surface to operator in pt-br ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa?"), never as a technical problem.

**Axis 2 — Executor tier escalation (implementation failure — K=1 tier step per task, not a retry count):** when the executor **ran** and the work does not hold — the task's `locked_tests` / gates are still red after the sniper pass of step g, or the executor returned `DONE_WITH_CONCERNS` and the concern is confirmed by a compliance `fail`/`partial` or a red gate on the same task — that is a model-capacity failure, not a transient one. Re-dispatch the **EXECUTOR one tier up** for that same task: `executor-low` → `executor-medium`, `executor-medium` → `executor-high`. Never escalate the **sniper** — the sniper rescues surgical findings; only a stronger executor fixes a structurally wrong implementation.

- **The step is spent once per task.** The escalated executor carries its own Axis-1 count (K=3 is per `subagent_type`(/task)) but **no** second tier step. A task that starts at `low` escalates to `medium` and stops there; it does **not** chain `low → medium → high`. If the escalated executor also fails its gates, that is the terminal state for this task → **CRITICAL EXCEPTION** — not another sniper round, not another same-tier re-dispatch, not a second tier step.
- **Top of the ladder:** when the failing executor is already `executor-high` (the highest OC tier — there is no `executor-max`; you normalize a `max` value to `high` at dispatch yourself, per § How to pick tier), there is no step left to spend → **CRITICAL EXCEPTION** directly.
- **CRITICAL EXCEPTION is the outlet only after the step is spent (or does not exist)** — never surface a capacity failure to the operator while an unspent tier step remains. A stronger tier that was never tried is engineering left undone, and engineering is never delegated to the human.
- **NO working-tree reset before the escalated dispatch — OC has no per-task commit anchor.** The Claude Code side discards the failed attempt with a stash because its HEAD is that task's own commit. **In OC that is destructive and forbidden:** the working tree carries every prior task of this run plus the frozen test, all uncommitted until `shipper` (§ Phase 2), so `git stash` / any discard would delete them irreversibly. Instead, brief the escalated executor explicitly: the uncommitted diff inside its `scope_paths` is a **failed attempt by a weaker tier** — it may rewrite or delete that diff freely and must not treat it as pre-existing code to preserve. Everything outside `scope_paths` — the frozen `locked_tests` included — stays untouched.

**Hand CONFIG_ERROR → critical exception (NOT a K=1 escalation):** when a hand dispatch fails precondition / never ran (e.g. missing fidelity_pass stamp, missing/invalid setup, CONFIG_ERROR from spawn), do NOT retry same tier and do NOT bump tier. Route to CRITICAL EXCEPTION: INTERACTIVE surface to operator in pt-br product language; HEADLESS record as open PR risk item.

A fix bigger than surgical scope (re-architecture) is **not** a sniper job → re-dispatch `executor-<tier>` or split the task. This is a **scope** judgment, not a capacity failure: it re-dispatches the **same** tier and does **not** spend the task's Axis-2 tier step — but it is available **at most once per task**, and only when the failure is a plan defect (the task as written cannot be implemented within its `scope_paths`), never when the implementation is merely wrong. A second red gate on the same task after a same-tier re-dispatch is by definition Axis 2: spend the tier step. **Any split/re-plan that re-runs `planner` → `planner-recovery` persists the revised plan for you, the same as the first dispatch (§ Phase 1): the plugin's hook fires on every `planner`/`planner-fallback` Task call, not only the session's first, and rejects a re-dispatch that returns the plan unchanged. Never hand-write `execution-plan.json` yourself, in `edit` or in bash — `planner` is the only role whose dispatch may bind it.** Re-run `validate-plan` before resuming executors.

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

**Ship rail (FULL — privileged):** after the final dual-review join completes (every dispatched eye verdict collected, feature-wide gates green), call the native `mark` tool with `action: final-review`. This stamps sealed `final_review_done: true` on gate-state. **FULL `git push` / `gh pr` is denied without it** (`denied_class=final-review-missing`). Bash and `mark-gate` CLI cannot stamp this — host-issued native mark only.

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
- **FULL ship preconditions (bash-decide):** ceremony + regate + capture + **final-review** + **demo when interactive**. (`dual`/`plan_verdict` is NOT one of these as of #483 — the dual gate is record-only; discipline around it is yours, not the bash gate's.) Missing final/demo → deny with explicit `denied_class`.

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
- No product code or test file was written by `build` itself, via the edit tool or bash — those only ever come from a dispatched executor/sniper/test-author. (`build`'s own orchestration artifacts — spec, plan cache, shared context, decision ledger — are written directly with the edit tool; see `## File writes` above.)
