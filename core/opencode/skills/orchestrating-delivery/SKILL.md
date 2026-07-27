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
   - **Cold-start check:** if this is a non-trivial existing codebase and the index is cold (no entries in MEMORY.md, root router unfilled), dispatch the `oc-surveying-codebase` skill **first** to seed durable knowledge from the code, then read the now-populated index before shaping the spec.
2. **Load and follow the `oc-brainstorming` skill** (INTERACTIVE or HEADLESS branch). Spec must include `#uj-N`, `#ac-N.M`, constraints, and locked decisions (operator-owned in interactive; trigger-derived + explicit open risks in headless).
3. Write the spec file **via bash** (`cat >`) — `edit` is denied.
   - The canonical runtime copy is `.opencode/plans/<sessionID>-<feature_id>/spec.md`. This session+feature-bound artifact is the durable brainstorming completion evidence source; a docs copy alone is not restart evidence.
4. **Upfront spec-adversary (mandatory LIGHT/FULL):** dispatch `adversary-family-1` (+ optional `adversary-family-2`). The Task prompt MUST say to follow the agent's exact JSON schema and MUST NOT request `SHIP`/`BLOCK`, `verdict`, `mechanism`, `sweep`, `blockers`, or any extra field. Family 1 returns only `{ "issues": [...] }`.

   **Acceptance is defined, and "clean" is not the only way out.** No unresolved medium/high finding → the pass is accepted: stamp the marker and go to the plan. A material finding with rounds to spare → revise `spec.md` so it is answered (a criterion that pins the behaviour, or an explicit locked decision that accepts it), then re-attack. **Nothing refuses another round** — the adversary loop has no deterministic cap, on purpose — so *you* decide when it stops: when the rounds stop producing progress, **stop and escalate to the operator** in product language (list the residual findings as a product decision: accept these risks, or change the spec) and wait. Headless has no human in the turn: record them in `spec.md` under an explicit "Open risks" heading, stamp, proceed, and put them in the PR body for the human gate there. The `adversary_nudge` on each round's return tells you which of the three you are in — follow it. Grinding out rounds hoping for an empty array is the failure mode: an adversary asked to find failure modes always finds one, and every spec rewrite opens fresh surface.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does AND surface **each locked decision in plain product terms**. **Do not show code or schema.**  
**HEADLESS:** no wait — adversary clean is the gate; record the spec summary in the PR body.

**Ordered official transition (all modes):** after spec approval/validation, call native `mark({ action: "brainstormed" })`; after the required primary spec-adversary result is accepted, call native `mark({ action: "adversary_fired" })`. Persist both before attempting planner dispatch. The first transition fingerprints the canonical `spec.md`; the second binds the runtime-captured primary adversary Task result. These are ordered and idempotent; never substitute Bash markers or prose claims.

---

## Phase 1 — Plan

0. **Planner preflight / resume:** attempt planner only after the two official ceremony transitions above. A denial is stable structured JSON with `code`, `missing_proof`, and `next_transition`. Pass that exact object to native `ceremony-next({ denial })`; execute only `descriptor.coordinator_step`, and after successful completion/acceptance call `descriptor.completion_transition`. The consumer is the authority for the closed mapping (`oc-brainstorming` skill or `adversary-family-1` Task); if it rejects, stop. Never derive role/tool names from denial strings, and never dispatch `explore`, `general`, or a diagnostic subagent. Preflight may restore a marker after process restart only from session+feature+phase-bound evidence that verifies against the canonical spec/result; an old/unsigned marker is not evidence. If proof is absent or invalid, resume the exact named phase or stop and report `missing_proof` without inventing a terminal state.

1. Dispatch `planner` via Task with the approved spec. The planner returns one `execution-plan.json` (schema in `planner.md`; the planner self-validates structure first).

   **Provider recovery:** `planner-recovery` atomically claims each Task using OpenCode's `callID` plus a persisted attempt token. **You do NOT write the plan.** On a usable planner result the plugin itself persists the returned plan at the canonical path (atomic temp+rename) and binds it in the same hook — the plan never passes through your output tokens, so it cannot be paraphrased, truncated, or dropped. `plan-gate` still verifies one coherent locked snapshot against the current attempt's session/feature, exact `plan.feature_id`, semantic hash, prior-file fingerprint, final file hash/mtime/size, and structural validity before persisting `usable`. A response carrying two or more distinct full plans is `plan_invalid` (fail-closed on ambiguity — never "the first one wins"), as is a plan whose `feature_id` does not match the session; in both cases the existing canonical file is left untouched. Missing/legacy planner state fails closed. Never reuse an old plan.

   Real Task rejection is observed through OpenCode's `message.part.updated` / `ToolStateError` event (not only `tool.execute.after`). Authentication, credit, timeout, and provider failures set `planner_status: "planner_unavailable"` plus a bounded `planner_retry_outcome`. If `roles.planner.fallback` is configured and its agent model matches, dispatch `planner-fallback` exactly once; otherwise report `delivery-blocked` in pt-br and stop. A malformed, empty, stub, or prose-only output is `plan_invalid` even when its prose says `429`/provider; it never activates fallback. Active claims have a bounded lease: an expired primary converges to the configured fallback policy, while an expired/failed fallback converges to `delivery-blocked`. Until gate-state says `usable`, do not dispatch plan reviewers, test-author, executors, or snipers.
   Planner is **primary-only**: on REVISE or `plan_invalid` / `planning_revision`, re-dispatch **`planner`** (same model). Do **not** dispatch `planner-fallback`. The **K=3 budget is per review round, not per session**: each plan-review round that persists a REVISE credits a fresh set of 3 attempts, so a revision loop can run the full `plan_review_count` budget. What K=3 still bounds is *failure* inside one round (unparseable plan, refused envelope, provider blip) — after 3 of those in the same round, stop and comment (`delivery-blocked` / product error), never `git push` / `gh pr`, never implement inline. A separate session-lifetime ceiling stops a pathological run; when its deny fires it says so explicitly and no reset clears it — escalate to the operator and stop. Both denies now arrive as an instruction in product language; follow it instead of ending the turn silently.

2. **CANONICAL PATH — written for you by `planner-recovery` at:**
   ```
   .opencode/plans/<sessionID>-<feature_id>/execution-plan.json
   ```
   Do **not** re-emit the plan through `cat >` / heredoc: hand-transcribing an 8 KB JSON is exactly how a run stranded itself at `plan_pending_write` with every downstream dispatch gated. The plugin overwrites any classify stub in place. `validate-plan` and `plan-reviewer` read from this exact path. If the Task metadata says the plan was refused, fix it **with the planner** — never write the file yourself.

3. Run the **`validate-plan` tool** on that file — a deterministic **structural** gate. On FAIL, hand its error list to `planner` and re-plan. **Cap 2 loops**, then escalate to the operator in product-language.

4. Dispatch `plan-reviewer-family-1` (read-only) for **engineering soundness**, then attempt `plan-reviewer-family-2` → `APPROVE | REVISE`. On REVISE: hand findings to `planner`, re-plan, re-run `validate-plan`, re-review. **Keep looping until APPROVE** — YOU must not dispatch a writing hand (executor/sniper/test-author) while REVISE stands; this is orchestration discipline, not a runtime gate (nothing refuses the dispatch for you — #483), so stopping mid-loop and dispatching one anyway silently strands the run's quality bar, not the run itself. The budget is enforced by the gate (`plan_review_count`, 5 useful rounds), not by your judgment: the `revise_nudge` on the review's return tells you the round and what remains. Escalate to the operator **only** when that nudge says the budget is exhausted.

5. **DETERMINISTIC sensitive-path override:** compare the plan's `scope_paths` against the allowlist:
   `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding/upgrading deps).
   **ANY match FORCES FULL**, overriding triage. Determinism on the plan; judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, product-relevant risks. **Never expose the JSON.**  
**HEADLESS:** plan-reviewer dual **APPROVE** is the gate; on REVISE past cap, stop and comment — do not ship.

**Primary failure cap (`primary_failure_cap_reached`):** after consecutive family-1 provider/empty/malformed failures hit the streak cap, **stop delivery**. Do **not** reclassify to QUICK, do **not** `git push` / `gh pr` — host rails still deny delivery (`bash-decide.mjs`) until a canonical ceremony restart (new generation + bound plan). **Writing hands (executor/sniper/test-author) are NOT blocked by this status anymore** (#482: `decideReviewCapBeforeWriting` was removed) — but their work cannot ship until the restart clears delivery, so re-dispatching them without a restart plan just burns cost. Comment the issue/PR in pt-br with the blocked reason (and any `last_provider_diagnostic` on gate-state).

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

**LIGHT** runs `executor + gates` per task, plus ONE upfront `adversary` pass on the spec before the loop, and a final dual review (Phase 3).
**FULL** runs the full loop below per task.

### LIGHT: upfront spec-adversary

In LIGHT mode, before the first task, dispatch `adversary-family-1` **VIRGIN** against the spec + a read of the existing codebase to surface tech-debt risks. Consume its findings before the first task: route every actionable finding — severity ≥ medium, or any finding with a `fix_hint` — to `sniper-<tiers[finding.severity]>`. Each sniper pass re-runs the affected gates. Zero findings (or all ≤ low with no `fix_hint`) is a valid outcome. Upfront findings not dispatched to a sniper must be explicitly recorded as accepted-risk in `shared_context.md` before the per-task loop begins.

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
| b | Implement | Dispatch `executor-<tier>` via Task / `run-hand` with curated L0–L4 context. **Precondition:** `fidelity_pass` stamped for this feature/task (executor spawn returns `CONFIG_ERROR` if missing). Reads back `DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`. `NEEDS_CONTEXT` → supply the missing `resolved_judgment` or escalate. (route to critical exception — do not retry) |
| c | Compliance | Dispatch `compliance` (read-only, bash allow) with **diff + ACs + locked_tests only** — NOT shared_context, NOT adversary findings. Reads back `pass \| partial \| fail`. |
| d | Adversary (if `task.adversarial.enabled`) | Dispatch `adversary-family-1` **VIRGIN**, then attempt `adversary-family-2` — no prior verdicts, no compliance output, no shared_context — with task spec + `adversarial.focus` + diff. Require each agent's exact JSON schema; never ask for verdict/sweep/mechanism fields. Returns issues ranked by irreversibility (`category` + `severity` + `fix_hint`). Zero findings is a **VALID result** — never re-dispatch to hit a count. A missing or malformed primary report is **NOT a pass** — halt and escalate. |
| e | Security (conditional) | Dispatch `security` when the task touches auth/secrets/external-input/new-deps/SQL/service-entrypoint. Returns `SECURE \| UNSAFE` + issues. |
| f | Gates (deterministic, no LLM) | For a targeted Vitest file, run it directly via bash against the exact named path (or use `verify` for the resolver lookup). Run other prescribed gates through their existing channel. Failure → issue list. |
| g | Fix | Map ALL issues (compliance + adversary + security + gates) to `sniper-<tiers[issue.severity]>`. Sniper is the ONLY fixer (`edit` allow, `bash` deny, no new files). **HIGH fix — or a `medium` in an irreversible class (orphan-state/race/idempotency):** after the sniper returns DONE, call native `mark` with `action: regate-pending` + that task's `task_id` (host `obs-hand` also auto-arms sealed `regate_pending` — belt + suspenders). Then re-dispatch `adversary-family-1` fresh-virgin against the NEW surface the fix created. On zero blocking findings, call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. Unmatched `regate_pending` is **delivery-blocking** (bash-decide denies `git push` / `gh pr`). Re-run the affected gate after every sniper pass. |
| h | Record | Rewrite `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** with the budget-capped knowledge ledger so far; adversary never reads it. Append this task's raw finding blocks (compliance/adversary/security/sniper) to the run `findings.md` buffer at the project root **via bash** — it is the producer the harvester/`oc-recording-findings` consumes; if never written, the run's learnings are lost. |
| i | Escalate | See escalation ladder below. |

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
2. Still call native `mark` `hand-finished` / `capture-verified` if the host did not stamp (belt) — if mark returns `ok:false` because record is not DONE, treat as hand failure and re-dispatch the hand (within K=3), do not ship.
3. Never use Bash or `mark-gate` CLI for privileged markers.
4. **Ship on the parent `build` session only.** Do **not** rely on `shipper` Task child for `git push` / `gh pr` (child sessions are not writing-hand-bound). `shipper` may draft PR title/body text; conductor runs push/PR bash on the parent after capture is present.

**Fidelity-rail stamp (after compliance fidelity PASS → before executor):** Call the native `mark` tool with `action: fidelity` and the locked test's `task_id`. The tool derives session and feature identity from the runtime envelope and gate-state. This stamp **MUST** precede executor dispatch; Bash and direct module imports are not privileged marker surfaces.

An executor hand spawn is **DENIED** (`CONFIG_ERROR`) unless `fidelity_pass` contains this feature/task (optional `@sha`). `test-author` is exempt — it creates the test that enables fidelity. Freeze-commit alone is not enough; the stamp is the on-disk signal `run-hand` and the entry-gate consume. (route to critical exception — do not retry)

Advance to the next task only when its gates are green.

### Escalation ladder (engineering — never handed to the human)

**Same-agent retry K=3 (all Task roles — planner, eyes, hands):** on provider/transient Task failure, re-dispatch the **same** `subagent_type` (same model) up to **3** times. After 3 failures → **product error / CRITICAL EXCEPTION** (stop + comment) — never swap models, never ladder. **The host does NOT block the 4th dispatch anymore** (#482: the in-session brake was removed and is not replaced — cron-a-exit.mjs is the real per-issue ceiling, outside this session). You must count failures and stop at 3 yourself; success resets the counter for that role(/task).

retry same tier within K=3 → still failing after 3 → **CRITICAL EXCEPTION**: translate to product impact, surface to operator in pt-br ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa?"), never as a technical problem.

**Hand CONFIG_ERROR → critical exception (NOT a K=1 escalation):** when a hand dispatch fails precondition / never ran (e.g. missing fidelity_pass stamp, missing/invalid setup, CONFIG_ERROR from spawn), do NOT retry same tier and do NOT bump tier. Route to CRITICAL EXCEPTION: INTERACTIVE surface to operator in pt-br product language; HEADLESS record as open PR risk item.

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
- No file was written via the edit tool — all writes went through bash (`cat >` / heredoc).
