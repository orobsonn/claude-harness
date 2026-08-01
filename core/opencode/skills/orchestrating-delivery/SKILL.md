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
| 4 | On a useful optional-eye result, carry its findings in the current orchestration turn and route them through normal remediation (plan-review finding → planner; adversary finding → sniper). The primary report remains authoritative; optional-eye findings are advisory, create no persisted gate, and are never retried or natively adjudicated. |

Never invent a second eye when routing does not configure one. With no configured second eye, advance from the primary verdict without blocking, secondary retry, or warning.

Every evaluator brief, primary or explicitly opted-in second eye, MUST require two separate passes: (1) internal consistency of the spec/plan/diff as a delivery contract, then (2) confrontation against every real file in `scope_paths` and its relevant callers/callees. Validate findings before accepting a report: adversary `evidence` must be repo-relative `file:anchor`; plan-reviewer `problem` must begin `Evidence: file:anchor — ` to preserve its exact-key schema. Use a function/exported symbol for code, or a real `<section>`, `<key>`, or `<operation>` for a non-executable surface. Any line-only, bare-file, missing, prose-only, or invented anchor makes the report unusable.

---

## Native tools (run directly, not via Task)

- `complexity-scorer` — scores a file path on a 0–60+ scale (0–10 low · 11–30 medium · 31–45 high · 46–60 max→`executor-high` · 61+ split). One call per path.
- `validate-plan` — deterministic structural gate for `execution-plan.json`: per-task presence of `criterion_refs` + `locked_tests`, acyclic + topologically-ordered `depends_on`, scalar `resolved_judgments`, valid tiers (no Claude slugs), `adversarial.focus` when enabled, `demo` shape. Does NOT check spec-AC semantic coverage — that is the plan-reviewer's job.
- `verify` — resolves a registered targeted-test snapshot to a concrete test path (feature/task ids in, `locked_tests[].path` out). Optional: the active hand can run the targeted test directly via bash just as well; `verify` stays available for the resolver's snapshot lookup when that is more convenient.
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

   **Acceptance is defined, and "clean" is not the only way out.** No unresolved medium/high finding → the pass is accepted: stamp the marker and go to the plan. A material finding → revise `spec.md` so it is answered (a criterion that pins the behaviour, or an explicit locked decision that accepts it), then re-attack. The orchestrator decides whether another pass will add product value; if not, stop and escalate to the operator in product language (accept these risks, or change the spec). Headless records unresolved risks in `spec.md` under "Open risks", proceeds only by explicit orchestrator judgment, and includes them in the PR body for the human gate.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does AND surface **each locked decision in plain product terms**. **Do not show code or schema.**  
**HEADLESS:** no wait — adversary clean is the gate; record the spec summary in the PR body.

**Ordered official transition (all modes):** after spec approval/validation, call native `mark({ action: "brainstormed" })`; after the required primary spec-adversary result is accepted, call native `mark({ action: "adversary_fired" })`. Persist both before attempting planner dispatch. The first transition fingerprints the canonical `spec.md`; the second binds the runtime-captured primary adversary Task result. These are ordered and idempotent; never substitute Bash markers or prose claims.

---

## Phase 1 — Plan

0. **Planner preflight / resume (R10):** planner remains denied until `brainstormed` and `adversary_fired` are both factual marks for the classified feature. Missing `brainstormed` → execute `oc-brainstorming`, then let the host mark `brainstormed`. Missing `adversary_fired` → dispatch the primary `adversary`, then let the host mark `adversary_fired`. Resume only the missing phase; never infer a mark from prose, an old marker, or an unsigned boolean.

1. Dispatch `planner` via Task with the approved spec. The planner returns one `execution-plan.json` (schema in `planner.md`; the planner self-validates structure first).

   **Provider recovery:** `planner-recovery` atomically claims each Task using OpenCode's `callID` plus a persisted attempt token. **You do NOT write the plan.** On a usable planner result the plugin itself persists the returned plan at the canonical path (atomic temp+rename) and binds it in the same hook — the plan never passes through your output tokens, so it cannot be paraphrased, truncated, or dropped. `plan-gate` still verifies one coherent locked snapshot against the current attempt's session/feature, exact `plan.feature_id`, semantic hash, prior-file fingerprint, final file hash/mtime/size, and structural validity before persisting `usable`. A response carrying two or more distinct full plans is `plan_invalid` (fail-closed on ambiguity — never "the first one wins"), as is a plan whose `feature_id` does not match the session; in both cases the existing canonical file is left untouched. Missing/legacy planner state fails closed. Never reuse an old plan.

   Real Task rejection is observed through OpenCode's `message.part.updated` / `ToolStateError` event (not only `tool.execute.after`). Authentication, credit, timeout, provider failures, and malformed output leave the planner artifact unusable; report the product impact and retry only when the operator/orchestrator chooses to continue. The planner lifecycle binds a result to its session, feature, and call identity; it does not keep attempt or review budgets. Until gate-state says `usable`, do not dispatch plan reviewers, test-author, executors, or snipers.

2. **CANONICAL PATH — written for you by `planner-recovery` at:**
   ```
   .opencode/plans/<sessionID>-<feature_id>/execution-plan.json
   ```
   Do **not** re-emit the plan through `cat >` / heredoc: hand-transcribing an 8 KB JSON is exactly how a run stranded itself at `plan_pending_write` with every downstream dispatch gated. The plugin overwrites any classify stub in place. `validate-plan` and `plan-reviewer` read from this exact path. If the Task metadata says the plan was refused, fix it **with the planner** — never write the file yourself.

3. Run the **`validate-plan` tool** on that file — a deterministic **structural** gate. On FAIL, hand its error list to `planner` and re-plan. If a product decision is needed to resolve the issue, ask the operator; no OpenCode runtime counter decides that checkpoint.

4. Dispatch `plan-reviewer` (read-only) for **engineering soundness**, then attempt `plan-reviewer-family-2` only when `roles.plan-reviewer.secondEyeModel` is set → `APPROVE | REVISE`. Every brief MUST require evidence anchors. On REVISE: hand findings to `planner`, re-plan, re-run `validate-plan`, and re-review. Do not dispatch a writing hand while a material REVISE remains; this is orchestrator discipline, not a persisted OpenCode gate. Escalate to the operator only for an explicit product decision, never because a hidden runtime count was spent.

5. **DETERMINISTIC sensitive-path override:** compare the plan's `scope_paths` against the allowlist:
   `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding/upgrading deps).
   **ANY match FORCES FULL**, overriding triage. Determinism on the plan; judgment on entry.

**HARD-GATE 2 — approve plan (pt-br, product-language):** present the **plan-reviewer's product summary** — what gets built, task count, product-relevant risks. **Never expose the JSON.**  
**HEADLESS:** plan-reviewer **APPROVE** is the quality checkpoint (single evaluator by default). On REVISE, re-dispatch `planner` with the findings, then re-dispatch `plan-reviewer` exactly as in Phase 1 — and the optional second eye only when routing declares one. A single-evaluator APPROVE satisfies this checkpoint when no second eye is configured.

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

### Adversary re-dispatch (post-sniper re-gate)

After a material fix, use a fresh adversary pass when the changed surface needs independent review. A clean review (only low findings or none) may stamp `regate-passed`; a red-to-green frozen test may justify the same stamp for a localized fix. A material finding that remains open is recorded with its product impact and escalated to the operator. In headless runs, the orchestrator explicitly judges whether continuation is appropriate and records the risk for the PR body. OpenCode does not maintain numeric convergence tracking, a retry tally, or a persisted terminal outcome for this decision.

Never hand-edit or delete `gate-state.json` to unblock a rail. An accepted risk is recorded before the native `regate-passed` marker is used for that task; a rejected or unresolved risk leaves the rail armed.

### Before the first task

Initialize `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** (`cat >` / heredoc) — a **real file on disk** (not in-context memory): the task-to-task knowledge ledger. On-disk so it survives context compaction and keeps task-to-task traceability auditable. (The feature-branch guarantee is already handled above, at the top of Phase 2 — it runs before this ledger init too, since LIGHT's upfront sniper pass can precede it.)

### Per-task steps (topological order via `depends_on`)

| # | Step | Who / How |
|---|---|---|
| a | Pick executor tier | `executor-<tiers[task.complexity ?? task.severity]>` (low/medium/high; `max`→high). If `complexity` absent, fall back to `severity`. Re-score a path via `complexity-scorer` tool if needed (one call/path). |
| a′ | Locked test + fidelity (when rail applies) | Dispatch `test-author` first (fidelity-**exempt** — it produces the locked test). Then dispatch `compliance` in **fidelity mode** (pre-freeze: full-observable fidelity only, no green required). On fidelity **FAIL** (`partial` counts as FAIL), re-dispatch the same `test-author` with the feedback — **at most 2 `test-author` dispatches per `test_path`** in this pre-freeze gate (initial + exactly one re-dispatch; this is a fidelity-only rule, never a general retry authority). A provider/transient Task failure is reported to the orchestrator, which explicitly decides whether to continue. On fidelity **PASS** — stamp disk marker **before** any executor spawn (see Fidelity-rail stamp below). Freeze the locked test, then proceed to implement. A further fidelity failure escalates the transcription to a stronger hand (see "Test-author fidelity escalation" right after this table). |
| b | Implement | Dispatch `executor-<tier>` via Task / `run-hand` with curated L0–L4 context. **Precondition:** `fidelity_pass` stamped for this feature/task (executor spawn returns `CONFIG_ERROR` if missing). Reads back `DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`. `NEEDS_CONTEXT` → supply the missing `resolved_judgment` or escalate. (route to critical exception — do not retry) |
| c | Compliance | Dispatch `compliance` (read-only, bash allow) with **diff + ACs + locked_tests only** — NOT shared_context, NOT adversary findings. Reads back `pass \| partial \| fail`. |
| d | Adversary (if `task.adversarial.enabled`) | Dispatch `adversary` **VIRGIN**, then attempt `adversary-family-2` only when `roles.adversary.secondEyeModel` is set — no prior verdicts, no compliance output, no shared_context — with task spec + `adversarial.focus` + diff. Every brief MUST require both passes and repo-relative `evidence: "file:anchor"`, using a function/exported symbol for code or a real `<section>`, `<key>`, or `<operation>` for a non-executable surface. Require each agent's exact JSON schema; never ask for verdict/sweep/mechanism fields. Zero findings is a **VALID result — never re-dispatch to hit a count**. A missing, malformed, or unanchored primary report is **NOT a pass — halt and escalate**. |
| e | Security (conditional) | Dispatch `security` when the task touches auth/secrets/external-input/new-deps/SQL/service-entrypoint. Returns `SECURE \| UNSAFE` + issues. |
| f | Gates (deterministic, no LLM) | For a targeted Vitest file, run it directly via bash against the exact named path (or use `verify` for the resolver lookup). Run other prescribed gates through their existing channel. Failure → issue list. |
| g | Fix | Map issues from compliance, adversary, security, and gates to `sniper-<tiers[issue.severity]>`. Sniper is the only fixer (`edit` allow, `bash` deny, no new files). After the fix, re-run affected gates. A `sniper-medium` or `sniper-high` DONE arms `regate_pending` for the owning `task_id`; use a fresh adversary review when the changed surface is material. A review with no blocking findings, or a localized frozen test that demonstrably changes from red to green because of the fix, may call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. An open material finding is recorded with product impact and taken to explicit orchestrator/operator judgment; headless records it as a PR risk. Never use a numeric retry/convergence rule to clear the rail. |
| h | Record | Rewrite `.opencode/plans/<sessionID>-<feature_id>/shared_context.md` **via bash** with the budget-capped knowledge ledger so far; adversary never reads it. The rewrite is read-modify-write: retain durable product decisions and open risks, then append this task's raw finding blocks (compliance/adversary/security/sniper) to the run `findings.md` buffer at the project root **via bash** — it is the producer the harvester/`oc-recording-findings` consumes; if never written, the run's learnings are lost. |
| i | Escalate | See escalation ladder below. |

### Test-author fidelity escalation (compliance fidelity gate)

When the **compliance fidelity gate** (step a′) does not reach PASS within the **2** permitted `test-author` dispatches for a `test_path`, escalate transcription to a stronger hand. This limit is scoped solely to locked-test fidelity, not a general OpenCode retry policy.

- **Escalate to `sniper-high`, don't retry to death.** After the 2nd `test-author` fidelity FAIL, dispatch **`sniper-high`** against the already-written test file (with `[HARNESS_TASK_CONTEXT]`), handing it the compliance fidelity feedback as `fix_hint` plus the full pinned-assertion list. Map compliance prose ("Problemas encontrados" + `NÃO` rows) into per-assertion instructions. Frame the brief so restoring named assertions inside the existing file **is** the defect (sniper refuses ambiguous scope). Tier is fixed at high by design. After DONE, re-dispatch `compliance` in fidelity mode — only `pass` is PASS; `partial`/`fail` are FAIL. No file on disk → no escalation; go straight to CRITICAL EXCEPTION.
- **CLOSE THE RE-GATE RAIL.** Host `obs-hand` auto-arms `regate_pending` on any `sniper-high`/`sniper-medium` DONE. The moment `compliance` returns fidelity **PASS**, call native `mark` with `action: regate-passed` + `task_id` + `sha` = HEAD. The independent compliance fidelity PASS is the re-gate of record for this rail.
- **On PASS, resume the normal rail.** Stamp `fidelity_pass` via native `mark`, freeze the locked test, dispatch the executor.
- **One extra attempt.** If the repaired transcription also fails fidelity — or `sniper-high` returns `BLOCKED`/`NEEDS_CONTEXT` — **stop immediately** as CRITICAL EXCEPTION. Do not re-dispatch.
- **The fidelity limit applies only to fidelity verdicts** inside the pre-freeze gate. Provider/transient Task failure is reported for explicit orchestrator judgment. Post-freeze maintenance edits are a different dispatch shape.

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
   - **The dispatch itself broke — provider/transient Task failure:** report the product impact and continue only after explicit orchestrator judgment; no OpenCode retry tracker decides this.
   - **`DONE_WITH_CONCERNS`:** neither branch — do **not** re-dispatch and do **not** route to critical exception on the unstampable record alone. The concern is judged by compliance/gates, then the escalation ladder's tier step when a compliance `fail`/`partial` or red gate confirms it. Carry the missing stamp as open risk / operator raise.
   - **Reading the cause:** a refusal is a verdict with a read-back. Absence of read-back is transient **only when the dispatch reached the provider**. A pre-dispatch gate deny (`[entry-gate] Blocked:…`) leaves no record — `mark` answers *"hand-record missing or unreadable"* — that is CONFIG_ERROR, CRITICAL EXCEPTION, no retry. Never infer either cause from the record's state alone.
3. Never use Bash or `mark-gate` CLI for privileged markers.
4. **Ship on the parent `build` session only.** `shipper` may draft PR text; conductor runs push/PR bash on the parent after capture is present.

**Fidelity-rail stamp (after compliance fidelity PASS → before executor):** Call the native `mark` tool with `action: fidelity` and the locked test's `task_id`. The tool derives session and feature identity from the runtime envelope and gate-state. This stamp **MUST** precede executor dispatch; Bash and direct module imports are not privileged marker surfaces.

An executor hand spawn is **DENIED** (`CONFIG_ERROR`) unless `fidelity_pass` contains this feature/task (optional `@sha`). `test-author` is exempt — it creates the test that enables fidelity. Freeze-commit alone is not enough; the stamp is the on-disk signal `run-hand` and the entry-gate consume. (route to critical exception — do not retry)

Advance to the next task only when its gates are green.

### Escalation ladder (engineering — never handed to the human)

Two distinct concerns, never mixed: **transient failure** (the dispatch itself broke — explicit orchestrator judgment) and **implementation failure** (the executor ran and its work does not hold — **one tier up, once**). The `test-author` fidelity gate is neither — it has its own rule.

**`test-author` fidelity gate (step a′) only:** a `test-author` FAIL at the compliance fidelity gate follows its own **2 dispatches per `test_path`** limit, then escalates transcription to `sniper-high` (§ Test-author fidelity escalation). Provider/transient failures remain an explicit orchestrator decision.

**Task failures:** report provider or transient failures with their product impact. Continue only under the orchestrator's explicit judgment; OpenCode stores no generic retry tally or terminal retry outcome.

- **Is a non-DONE capture record inside this trigger? Only when the cause is transient.** A `mark` `ok:false` for a record that never reached DONE (§ Post-hand capture path, step 2) is **inside** `on provider/transient Task failure` when *that* is why it never reached DONE. It is **outside** when the hand ran and refused (`BLOCKED` / `NEEDS_CONTEXT`) or was denied before it ran (`CONFIG_ERROR`): outlet is **CRITICAL EXCEPTION with no retry**. A `DONE_WITH_CONCERNS` record is outside too — nothing failed; the concern is the tier-escalation path's to judge when compliance/gates confirm it. The trigger is the **cause**, never the record's state.

**Executor tier escalation (implementation failure — one tier up, once per task):** when the executor **ran** and the work does not hold — the task's `locked_tests` / gates are still red after the sniper pass of step g, or the executor returned `DONE_WITH_CONCERNS` and the concern is confirmed by a compliance `fail`/`partial` or a red gate — re-dispatch the **EXECUTOR one tier up** for that same task: `executor-low` → `executor-medium`, `executor-medium` → `executor-high`. Never escalate the **sniper**. Matches the Claude Code form: one tier above, once.

- **The step is spent once per task.** No second tier step. If the escalated executor also fails its gates → **CRITICAL EXCEPTION**.
- **Top of the ladder:** failing executor already `executor-high` → **CRITICAL EXCEPTION** directly.
- **CRITICAL EXCEPTION is the outlet only after the step is spent (or does not exist)** — never surface a capacity failure to the operator while an unspent tier step remains.
- **NO working-tree reset before the escalated dispatch — OC has no per-task commit anchor.** Brief the escalated executor: the uncommitted diff inside its `scope_paths` is a **failed attempt by a weaker tier** — it may rewrite or delete that diff. Everything outside `scope_paths` — frozen `locked_tests` included — stays untouched.

**Hand CONFIG_ERROR → critical exception (NOT a tier escalation):** when a hand dispatch fails precondition / never ran (e.g. missing fidelity_pass stamp, CONFIG_ERROR), do NOT retry same tier and do NOT bump tier. Route to CRITICAL EXCEPTION: INTERACTIVE surface to operator in pt-br product language; HEADLESS record as open PR risk item.

A fix bigger than surgical scope (re-architecture) is **not** a sniper job → re-dispatch `executor-<tier>` or split the task. Available **at most once per task**, and only when the failure is a plan defect. **Any split/re-plan that re-runs `planner` → `planner-recovery` persists the revised plan** (§ Phase 1). Never hand-write `execution-plan.json`. Re-run `validate-plan` before resuming executors.

For a transient dispatch failure, report product impact and make the continuation decision explicitly; never let a numeric OpenCode retry rule declare the terminal outcome.

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
