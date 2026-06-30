---
name: orchestrating-delivery
description: "Conducts the LIGHT and FULL delivery loop of the Claude Harness — runs spec, plan, the per-task executor/compliance/adversary/sniper/gates cycle, final dual review, demo, and harvest. Dispatches a fresh subagent per role and curates layered ICM context for each; never writes code itself. Invoked by triaging-requests for LIGHT/FULL (QUICK runs inline and never reaches this skill)."
---

# Orchestrating-Delivery — The maestro of the development loop

**This skill is the conductor, not a worker.** It dispatches a fresh subagent per role/task, reads each structured output, and decides the next step. It does **not** implement, validate, or attack — those are the agents (`executor`, `compliance`, `adversary`, `sniper`, `security`, `shipper`, `harvester`). It owns the human HARD-GATES and the curation of layered context. The orchestrator authors no implementation code and no test code; it relays the plan task slice + curated validated facts (`shared_context`), and the frozen `locked_test` is the concrete oracle.

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

Model per role. **This table is authoritative** — when a role's model is named elsewhere in this skill, it must match here. Every eye role resolves to its agent frontmatter model; the two boundary gates run **opus** (the strongest available tier), the same as their frontmatter default, so no per-dispatch override is needed.

| Role / step | Model | Why |
|---|---|---|
| orchestrator (this skill / main loop) | **sonnet** (standing default) | highest token volume → the cheapest lever and the harness's core economy. Critical decisions are pinned by deterministic rails (see note), not left to the orchestrator's judgment. |
| planner | opus | architecture-grade reasoning |
| **plan-reviewer (initial gate)** | **opus** | strongest available tier audits the opus planner's output — the highest-leverage boundary check before execution. In HEADLESS this APPROVE *is* the gate (no human). |
| executor | `hand_tiers[complexity ?? severity]` · ALL tiers (low/medium/high) → Ollama via `dispatch-hand.mjs` + `spawn-hand.mjs` (`claude -p` + isolated ephemeral CLAUDE_CONFIG_DIR) · executor-high → `hand_tiers.high` (strong Ollama coder) | HAND role — all tiers on live spawn path (v2); executor-high→Ollama reverts to executor-high→Claude if AC v2.7 de-risk metering shows net-negative (`executor_high_revert_trigger: ac_v2.7_derisk_metering`) |
| compliance | sonnet | spec-vs-impl check |
| adversary (per-task) | opus | already strong; raise `effort` before raising tier |
| security | opus | conditional auditor |
| test-author | sonnet | authors the red locked test (transcribes the planner-pinned assertions); fidelity validated by compliance (step 1b). Main-loop Claude Agent in local + headless — dispatched as Agent(test-author), NOT via spawn-hand. |
| sniper | `hand_tiers[issue.severity]` · ALL severities via `dispatch-hand.mjs` + `spawn-hand.mjs` (live spawn path; `claude -p` + isolated config) · HIGH gets MANDATORY strong-eye re-gate after fix | cheap hand on live spawn path for all severities including high; grave fix guaranteed by mandatory re-gate (fresh virgin strong Claude eye) after fix — not a Claude sniper |
| **adversary (final dual review = final gate)** | **opus** | strongest available tier hunts bugs across the whole feature — the last boundary before delivery. In HEADLESS the PR ships on this verdict. |
| compliance (final dual review) | sonnet | |
| security (final dual review) | opus | |
| harvester | sonnet | |
| shipper | sonnet | |

**Cost note:** Fable 5 (the former premium tier) has been **retired** — opus is now the ceiling. The two boundary gates run **opus**, the strongest available tier, which is also their frontmatter default (no override needed). The net economy of this routing comes from the **sonnet orchestrator default** (high-volume); instrument `usage` per role to verify it holds. No eye role ever falls below sonnet, and never to a non-Claude tier.

**Hands vs Eyes (v2 wiring):** executor and sniper are **HAND** roles — code/test-writing workers that run on an Ollama model resolved from `hand_tiers` via `dispatch-hand.mjs` + `spawn-hand.mjs` (the **spawn-hand path**: `claude -p` + isolated ephemeral CLAUDE_CONFIG_DIR), **NOT** via `Agent`. The **test-author** authors test code (conceptually a hand), but it runs as a **main-loop Claude Agent (sonnet) in BOTH local and headless** — it is **NOT** dispatched via spawn-hand or Ollama. Reason: at author time no frozen test yet exists, so `runLiveDispatch` has nothing to run; the spawn-hand path is therefore unavailable. The test-author's safety controls are the compliance eye (step 1b, which validates fidelity before freeze) + the freeze content-hash (step 1c) — not the executor's run-record rail. Only executor and sniper go through the spawn-hand path. All other roles (orchestrator, planner, plan-reviewer, compliance, adversary, security, harvester, shipper) are **EYE** roles — they judge and decide, and they **always stay on Claude**. No eye role ever resolves to an Ollama model — this is a hard constraint. In v2 ALL executor tiers (low/medium/high) route to the live spawn path; executor-high resolves to `hand_tiers.high` (a strong Ollama coder). The sniper is wired to the live spawn path (`hand_tiers[issue.severity]`) for ALL severities including high. Claude is reachable by an Ollama hand only via the K=1 escalation fallback. **HEADLESS exception (LOCAL-only capability):** the spawn-hand path is LOCAL-only. In **HEADLESS** (cloud routine, `$CLAUDE_CODE_REMOTE` set) there is no Ollama hand — executor and sniper are dispatched as ordinary Claude `Agent`s on the standard cloud model, and the entry-gate allows a main-loop hand-role Agent (no spawn-hand, no ticket/run-record needed). Do NOT invoke `spawn-hand.mjs` in headless. The test-author is unaffected by this headless exception — it always runs as a Claude Agent.

**Orchestrator = sonnet (committed default):** the orchestrator is the highest-volume token consumer, so a cheap model here is the harness's real economy — this is the whole point of the design. The residual risk is curation quality: context curation is judgment, and weak curation poisons every downstream agent. The harness mitigates this by **moving the critical decisions off the orchestrator's judgment onto deterministic rails** — planner dispatch is enforced by the entry-gate hook + the `<PLANNER-ONLY>` guard (the orchestrator *cannot* generate the plan inline and must dispatch the opus `planner`), the sensitive-path override is a glob check, and per-role model routing is this fixed table. The cheaper the orchestrator, the more these rails carry the judgment. Residual curation risk stays instrumented — watch `usage` per role and whether downstream agents got the right scope. The operator may still override the model via `/model` for a given session.

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

**External hand dispatch — headless parity:** The external hand (`dispatch-hand.mjs`) operates in **HEADLESS (cloud routine) mode** exactly as it does locally — the harness makes no distinction. The brief-serialization contract is **identical to local**: the orchestrator serializes the budget-capped curated `shared_context` into the hand's brief file with the same structure and scrubbing rules (no secrets, no PII). Context parity at the boundary is the same in both modes — no headless-specific brief format, no stripped fields. This applies to both the executor and sniper hand-dispatch paths.

The gates below are written for INTERACTIVE; each carries its HEADLESS substitution inline.

---

## Phase 0 — Brainstorm and spec

1. Explore intent, user journeys (`#uj-N`), and acceptance criteria (`#ac-N.M`). **INTERACTIVE:** use `superpowers:brainstorming` **if available** (it is a marketplace plugin, not vendored — may be absent); else brainstorm inline with the operator.
   **HEADLESS:** there is no human to brainstorm with, so **simulate the exploration by dispatching read-only subagents**: fan out a small set of exploration agents over the trigger (issue/PR/prompt) + the codebase, each with a **distinct lens** (e.g. user-journeys, edge-cases/failure-modes, constraints/non-functionals), then **synthesize** their outputs into the spec (UJs `#uj-N` + ACs `#ac-N.M`). Subagent dispatch is the **reliable mechanism** — **cloud routines do not have the `Workflow` tool** (confirmed: workflows are unavailable in cloud sessions and require interactive per-run approval). **Prefer a `Workflow`** only when the tool is actually available (e.g. headless-local via `claude -p`), for deterministic/reproducible orchestration. A thin one-line trigger may use inline derivation. Either way the synthesized spec then goes through the spec-validation gate (adversary attacks it). Never run an interactive brainstorm in headless, and never hard-depend on the `superpowers:brainstorming` plugin (it does not load in cloud routines).
2. **Explicitly `Read`** the project's durable index — `.claude/memory/MEMORY.md` (the repo-committed project-pattern index; do not rely on native auto-load) and the root `CLAUDE.md` router table ("folder → what lives there") — to inform the spec. **Cold-start check:** if this is a non-trivial existing codebase and that index is cold (`.claude/memory/MEMORY.md` has no entries and the root `CLAUDE.md` router is unfilled), dispatch the `surveying-codebase` skill **first** to seed durable knowledge from the code itself, then read the now-populated index before shaping the spec. This is the orchestrator's macro view forming. There is no `learnings.md`.
3. Produce a spec with UJs, ACs, constraints, and resolved product decisions.
4. **Upfront spec-adversary (MANDATORY in both LIGHT and FULL):** Dispatch the **adversary** (opus, virgin) against the spec + the existing codebase (if any). The adversary surfaces tech-debt risks, threats to ACs, and contradictions before the plan is written. **INTERACTIVE:** the adversary's findings inform the operator's approval decision. **HEADLESS:** if the adversary surfaces blocking issues that cannot self-resolve, stop and report it in the PR — do not proceed on a guess.

**HARD-GATE 1 — approve spec (pt-br, product-language):** present what the feature does and ask the operator to confirm. Do not show code or schema.
**HEADLESS:** no operator to confirm. The upfront adversary attack has already run; if it surfaced no blocking issue, proceed and write the spec into the PR body. If a blocking issue cannot self-resolve, stop and report it in the PR — do not proceed on a guess.

5. **Mark brainstorm complete** (final Phase 0 action before dispatch to plan): run the brainstorm-done marker to set the gate's `brainstormed` flag.
   **INTERACTIVE:** execute `node .claude/hooks/mark.mjs brainstorm-done --feature-id <feature-id>` where `<feature-id>` matches the kebab-case identifier chosen in triaging-requests. The hook stamps `brainstormed=true` into `.claude/plans/.state/<session_id>/gate-state.json` (PostToolUse recognition).
   **HEADLESS:** execute the same marker command. The exploration subagents (step 1) are the brainstorm; the marker is what records completion so the gate (planner dispatch) can proceed.

---

## Phase 1 — Plan

1. Dispatch the **planner** (opus) running the `creating-plans` skill. Hand it the approved spec.
2. The planner returns an `execution-plan.json` that passes **structural** validation (`validate-plan.mjs` — schema, enums, AC↔locked_test traceability, dependency cycles). Structure only — not engineering soundness.
3. **plan-reviewer** (**opus** — initial gate; virgin, read-only) — audits the plan's **engineering soundness**: decomposition/SRP, whether `resolved_judgments` are correct, whether `locked_tests` truly pin the ACs, `scope_paths` vs. codebase reality, `severity`/`complexity` routing, and risks introduced by the decomposition itself. Consults curated mental models via the optional MV add-on (best-effort recall; never blocks if MV is absent). Returns `APPROVE | REVISE` + findings + a **product-language summary**.
   - **REVISE** → re-dispatch the planner in **revision mode**, handing it `{existing plan path, findings[] with each finding's `planner_instruction` and target `task_id`}`. The planner applies each instruction to its `task_id`, keeps every other task byte-stable, and re-runs its self-review + structural validation; then re-run plan-reviewer. **Cap at 2 revision loops**; if still REVISE, escalate the blocking finding to the operator in product language.
   - This is the engineering judgment the operator **cannot apply himself** — the validator checks shape, the plan-reviewer checks substance. It is the analog, at the plan layer, of the adversarial pass on the spec.
4. **Deterministic sensitive-path override:** compare the plan's `scope_paths` against the sensitive-path allowlist (`**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (when adding or upgrading deps)). Any match **forces FULL**, overriding the triage mode. When it fires, **rewrite `plan.mode` to `"full"` in the persisted plan and re-validate**, and record `effective_mode: "full"` in `shared_context.md` — so a later context-compaction re-read cannot silently revert to a stale `mode: "light"`. Key the LIGHT/FULL branch off the effective mode. Determinism on the plan, judgment on entry.

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
- **executor** (and **sniper**) receive the curated `shared_context` — the **learnings worth carrying forward**: key decisions, gotchas, and insights surfaced during the spec review, the upfront adversarial pass, prior task runs, and adversarial/compliance findings. It is a knowledge ledger, not a task log — save only what helps a later step. Budget-capped. The brief and `shared_context` MUST NEVER contain the `ANTHROPIC_AUTH_TOKEN` or any secret/credential/PII — the orchestrator scrubs before serializing; the token lives only in the child process env (consistent with `dispatch-hand.mjs` token hygiene). `shared_context` inherits the same no-secrets prohibition as memory/kaizen.
- **compliance** enters lean: gets the **diff + ACs**, NOT the `shared_context` and NOT the adversary's findings.
- **adversary** enters **virgin** — no prior verdicts, no "compliance said X is ok", no conclusions from earlier tasks. The attack's value depends on having no anchor. This guardrail is non-negotiable.
- `shared_context` has a **ceiling** — prioritize the relevant; do not append everything, or every task gets more expensive.

---

## Phase 2 — The per-task loop (FULL, the core)

Before the first task, **initialize** `.claude/plans/<feature_id>/shared_context.md` with the learnings worth keeping from the spec review (and, in LIGHT, the upfront adversarial pass on the spec). It grows as the loop runs.

**Before the first per-task commit — ensure a feature branch (NOT main/master):** the per-task series (freeze-commit + impl-commit) is the first commit in the run, so nothing else creates a branch. Before step 1c-commit, run `git branch --show-current`; if it returns `main` or `master`, create a feature branch with `git switch -c <type>/<feature-id>` (kebab-case `<type>` per git.md — `feat`/`fix`/`refactor`/`chore`/`docs`) before any commit. The freeze-commit and impl-commit series MUST NEVER land on protected main.

For each task in **topological order** (`depends_on`), compose layered ICM context and run:

**1a. test-author** (Claude Agent — sonnet, dispatched as `Agent(test-author)` in both local and headless — **NOT via spawn-hand**) — dispatch **ONCE per distinct `test_path`** (group the task's `locked_tests` by `test_path` first). Each dispatch transcribes **ALL** the planner-pinned assertions for that `test_path` — the brief enumerates the full list — into a single real test file at that path (one `test()` per assertion). Dispatching per-isolated-assertion would CLOBBER the file via the Write-only contract, capturing only the last assertion and silently weakening the gate; group by path so every assertion lands in the file. Also creates all support/fixture files the tests require. Does NOT write production code; writes only the target `test_path` and its fixtures. **Why not spawn-hand:** at author time no frozen test yet exists for `runLiveDispatch` to run against; the safety net is the compliance fidelity gate (step 1b) + the freeze content-hash (step 1c).

**1b. compliance** (sonnet — Claude eye, **fidelity gate — before freeze, NOT by the planner in-run**) — validates the transcribed test's FIDELITY to **ALL** the planner-pinned assertions for that `test_path`: does the file faithfully encode every Given/When/Then observable pinned for it (not just one)? Returns PASS or FAIL + feedback. **Fidelity must be validated against the full assertion list before freeze.** On FAIL: re-dispatch test-author with the feedback. **Iteration cap: 2** — after 2 FAIL cycles, **escalate transcription to a stronger hand** (skip the cheap test-author; use the compliance-tier model to author the test directly). Fidelity is always validated by compliance; the planner does not validate in-run.

**1c. freeze (content-hash MANIFEST = the frozen test's DEPENDENCY CLOSURE)** — once fidelity is PASS, compute a **content-hash MANIFEST** defined by the frozen test's **full dependency closure**, NOT by provenance. Resolve every **non-production** file the `test_path` imports/requires/reads — **transitively** (fixtures, data files, snapshots, helpers, and anything those in turn pull in) — and add **ALL** of them, plus the `test_path` itself, to the manifest. This holds **regardless of who created the file**: a pre-existing fixture/helper/data file the test depends on is in the closure and therefore in the manifest, exactly like a file the test-author just created. (Provenance — "the test-author created it" — is NOT the criterion; dependency is.) Write it to `.claude/plans/<feature_id>/test-manifest-<task_id>.json`, with the frozen dependency closure stored under the field name `frozen_paths` (single-sourced: the descriptor-emitter reads this same `frozen_paths` field — one write, one read). The manifest is frozen from this point.

**Executor allowed-write set** = `scope_paths` MINUS the **entire frozen dependency closure** (every manifest file, regardless of who created it) MINUS the **test-runner config exclusion set**. The runner-config exclusion set is explicit (all excluded from the executor allowed-write set):
- the test-runner config files: `jest.config.*`, `vitest.config.*`, `mocha` config (`.mocharc.*`);
- the framework config **KEYS inside `package.json`** that inject setup/mapping: `jest`/`vitest`/`mocha` blocks — `setupFiles`, `setupFilesAfterEach`/`setupFilesAfterEnv`, `moduleNameMapper`, `globalSetup`/`globalTeardown`;
- `tsconfig.json` `paths`/`compilerOptions` (path-mapping + compiler injection);
- `.npmrc`, `babel.config.*` / `.babelrc*`;
- loader/preload vectors: `--import` / `--require` / `--loader` flags and `NODE_OPTIONS`.

These are setup-injection vectors: editing any of them lets the executor make the frozen test pass vacuously without touching a manifest file. Any executor diff touching a manifest file (the dependency closure) OR any file/key in the runner-config exclusion set is an **automatic gate failure**. (The gate still invokes the frozen test **directly by path** — step 4 — which neutralizes npm-script tampering independently.)

**1c-commit. freeze-commit** — once the freeze manifest is written (step 1c) and the allowed-write set is defined, the orchestrator COMMITS the frozen test, its fixtures, and the test manifest using selective stage: `test(<scope>): freeze locked tests for <task-id>`. No Co-Authored-By trailer per repo rules. This tracked commit makes the frozen artifacts DURABLE — HEAD now points to this task's freeze-commit. **Record the freeze-commit SHA** — capture `git rev-parse HEAD` and persist it into the task's run state (`.claude/plans/<feature_id>/test-manifest-<task_id>.json`, e.g. a `freeze_commit` field) so the step 7 escalation reset can verify HEAD before discarding. The step 7 escalation stash-reset then safely discards only the executor's uncommitted work without touching the frozen test or any prior task's committed work. The spawn-hand descriptor and `freeze_commit_sha` are emitted automatically by the **descriptor-emitter** helper (`references/descriptor-emitter.mjs`), never hand-typed — the descriptor-emitter reads `frozen_paths` from the manifest written in step 1c to build the `locked_test` + `allowed_writes` fields.

**Fidelity-rail stamp (1c-commit → 1d gate):** Right after the freeze-commit is recorded (step 1c-commit), the orchestrator stamps the fidelity-pass marker — confirming compliance returned fidelity PASS (step 1b) on the freeze-committed test. Mirror the `regate-pending`/`capture-verified` stamp pattern; this stamp MUST precede the executor dispatch:

`node .claude/hooks/mark.mjs fidelity-pass --feature-id <feature-id> --task-id <task-id>`

An executor dispatch is DENIED unless a compliance-fidelity-PASS frozen test exists for the task; the `fidelity-pass` marker is the on-disk signal the gate consumes (local spawn-hand path + headless Agent path). The entry-gate **fidelity rail**: no `fidelity-pass` marker for a task → executor dispatch refused; the freeze-commit alone is not enough.

**1d. executor** — model = `hand_tiers[task.complexity ?? task.severity]`. **v2 dispatch: ALL tiers (low/medium/high) → external hand via `dispatch-hand.mjs` + `spawn-hand.mjs`** (live spawn path: `claude -p` + isolated ephemeral CLAUDE_CONFIG_DIR; Ollama); executor-high resolves to `hand_tiers.high` (strong Ollama coder). The executor brief is produced by the **brief-serializer** helper (`references/brief-serializer.mjs`), not free-written — it serializes the budget-capped curated `shared_context` into the hand's system-prompt/brief file (context parity at the boundary). **The brief and `shared_context` MUST NEVER contain the `ANTHROPIC_AUTH_TOKEN` or any secret/credential/PII — the orchestrator scrubs before serializing; the token lives only in the child process env (consistent with `dispatch-hand.mjs` token hygiene). `shared_context` inherits the same no-secrets prohibition as memory/kaizen.** The external hand runs in the **working tree under the harness command-sandbox + a per-dispatch allowed-write set** (defined in step 1c). Receives L0–L3 + curated `shared_context`. Receives the frozen `locked_tests` **READ-ONLY** — does not author, edit, or relax the test file; implements production code until the frozen test goes green. Writes JSDoc. Reads back: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. **Precondition:** step 1a (**test-author**) completing the frozen test file and step 1b (compliance fidelity-PASS) stamping the `fidelity-pass` marker are both hard **precondition**s of this executor dispatch — the executor must not be invoked unless the `fidelity-pass` stamp is present on disk for this task.

**Capture rail (Trilho 4 — producer/consumer key-identity):** every executor (and sniper, step 5) hand-dispatch **descriptor carries `feature_id` and `task_id`**. (NOTE: `session_id` is supplied by Claude Code on the **PostToolUse hook payload**, **NOT the descriptor** — that split is exactly what guarantees producer/consumer key-identity, so the capture marker the orchestrator writes and the gate marker the hook reads resolve to the same key.) **Right AFTER the cheap hand returns**, the orchestrator runs `node .claude/hooks/mark.mjs hand-finished --feature-id <feature-id> --task-id <task-id>`. (This `hand-finished` marker is implemented by a later task; this is the prose that instructs its use.)

**Live hand dispatch — the RUNNABLE command (executor + sniper).** The spawn path is fired by ONE command — `spawn-hand.mjs`'s `runLiveDispatch` validates the descriptor, fail-closes on a token leaked into it, reconciles the git universes (full tree clean + HEAD anchored to the freeze baseline), spawns the hand live (`claude -p` against `https://ollama.com`, token env-only, ephemeral CLAUDE_CONFIG_DIR), runs the INDEPENDENT capture, and writes a token-free run-record keyed by `feature_id/task_id`:

```bash
node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor <descriptor.json>
```

The orchestrator writes `descriptor.json` (the **descriptor schema** — these exact keys):

```json
{
  "feature_id":       "<feature-id>",
  "task_id":          "<task-id>",
  "model":            "<resolved from hand_tiers[complexity ?? severity] (executor) or hand_tiers[issue.severity] (sniper)>",
  "brief_file":       "<absolute path to the scrubbed brief; the budget-capped curated shared_context is already folded in>",
  "scope_paths":      ["<in-scope path>", "..."],
  "locked_test":      "<path to the frozen locked test (the gate of record); frozen_paths is derived from it>",
  "allowed_writes":   ["<per-dispatch allowed-write path>", "..."],
  "freeze_commit_sha":"<git rev-parse HEAD at the freeze-commit (step 1c-commit)>"
}
```

- **Token hygiene (load-bearing):** the Ollama token lives ONLY in env / `.dev.vars` (`ANTHROPIC_AUTH_TOKEN`) — NEVER in the descriptor, argv, brief, or any log. `runLiveDispatch` fail-closes if the token literal appears in the descriptor bytes.
- **Auth resolution — the orchestrator NEVER pre-checks the token (load-bearing):** `spawn-hand.mjs` resolves the token itself, in order **env (`OLLAMA_HAND_TOKEN`, then `ANTHROPIC_AUTH_TOKEN`) → project `.dev.vars` → global `~/.claude/.dev.vars`**. LOCALLY the operator sets `export OLLAMA_HAND_TOKEN=…` in the shell rc: env reads survive the command-sandbox while a token placed only in `.dev.vars` does **NOT** (the sandbox denies reading `.dev.vars`), and `OLLAMA_HAND_TOKEN` is inert to Claude Code's own auth (exporting `ANTHROPIC_AUTH_TOKEN` would hijack the parent session). A project **does NOT need its own `.dev.vars`**. The orchestrator MUST NOT inspect, `cat`/`grep`/`echo`, or otherwise read `.dev.vars` (project or global) to "verify the token is there", and MUST NOT raise a "token missing" exception on its own judgment — that is the resolver's job. Reading the file directly is also self-defeating: a command whose text names `.dev.vars` is denied (`Read(.dev.vars)` baseline) while `spawn-hand.mjs` resolves correctly because the read is internal. The token counts as missing ONLY when `spawn-hand.mjs` itself exits `2` with a token `reason` (below). **This does NOT relax the git-universe reconciliation pre-step — that is separate from the token and stays mandatory.**
- **Git-universe reconciliation (mandatory pre-spawn):** before invoking the command, the orchestrator MUST commit or stash its OWN out-of-scope files (`shared_context.md`, `findings.md`, `.claude/memory/*`) so the FULL tree is clean relative to `freeze_commit_sha`. `runLiveDispatch` REFUSES to spawn onto a dirty tree (the unscoped capture diff would otherwise misattribute orchestrator writes to the hand). The freeze-commit (step 1c-commit) already commits the frozen test/fixtures, so this is normally just stashing the run buffers.
- **Exit-code contract (the config-error escape — Trilho 5):**
  - `0` → genuine run, outcome `DONE`. Proceed (step 6 commit).
  - `1` → genuine run, outcome `FAILED`/`NOT_DONE` (a real spawn that ran and failed its locked test/exit). This is a K=1 escalation (step 7); the run-record written on disk is what authorizes the Claude hand fallback at the entry-gate.
  - `2` → **PRE-SPAWN config error or post-spawn critical exception** (no token, dirty baseline, gate not armed, missing/invalid test, diverged HEAD) — NOT a genuine run failure (`runLiveDispatch` RETURNS only on a genuine run and THROWS otherwise; the CLI emits `{ "configError": true, "reason": … }`). **Route ANY exit 2 to the critical-exception path (step 7 below):** the orchestrator does NOT classify the cause and does NOT string-parse the `reason` — it stamps `node .claude/hooks/mark.mjs hand-config-error --feature-id <feature-id> --task-id <task-id> --reason "<the CLI's reason, verbatim, translated to product-language>"` and SURFACES it — **NEVER a silent Claude fallback, NEVER a lock.** Without this the pipeline would deadlock the first time the token is absent.
- The run-record it writes is the on-disk evidence (`captured: true`, real `exitCode` + `lockedTestExitCode` from the independent capture) — never the model's prose. **The entry-gate authorizes a main-loop Claude `Agent(executor|sniper)` fallback ONLY when a stamped `escalation_fallback` ticket maps to an on-disk run-record whose `outcome` is `FAILED`** (a genuine run-and-fail). A config error writes no such record → the Claude escape is denied → the orchestrator MUST surface the critical exception, never fall back silently. (The test-author is not governed by this rail — it always runs as a Claude Agent and requires no ticket.)

**Read-only eye fan-out (steps 2–3b → step 5):** The review eyes in this phase — **compliance (step 2)**, **adversary (step 3, FULL only when `task.adversarial.enabled`)**, and **security (step 3b, when the sensitive-path/HTTP/entrypoint trigger fires)** — are read-only, mutually independent, and return a verdict without writing to the working tree or stamping markers in gate-state. (The adversary enters virgin with no prior verdicts; compliance enters lean without shared_context — so there is no ordering constraint among them.) Dispatch **all applicable eyes concurrently in a single fan-out (one message with N Agent calls)** and **collect all verdicts (join) before proceeding to step 5 (sniper)**. The orchestrator blocks during the join — it does not continue working while waiting. When a condition is not met — `task.adversarial.enabled` is false, or the security trigger is absent — that eye simply does not enter the fan-out. All existing conditionalities are preserved; the sniper then applies the union of findings from all collected verdicts.

**2. compliance** (sonnet, read-only) — receives the **diff + ACs/locked_tests**, NOT the `shared_context`. Validates impl vs spec/AC. Reads back: `pass | partial | fail` + issues. Issues → step 5.

**3. adversary** (opus, read-only, **VIRGIN**) — only if `task.adversarial.enabled`. Receives task spec + `adversarial.focus` + the diff, **no prior verdicts**. Attests the canonical failure classes (each with a `file:fn` citation) and reports every real failure mode at honest severity with `fix_hint`. **Zero findings is a valid attested result — never fabricate to hit a count.** Issues → step 5.

**3b. security** (opus, read-only) — conditional: dispatch when the task's `scope_paths` hit the sensitive-path allowlist OR the task touches an external HTTP client, service entrypoint, webhook handler, or new/modified log statement (security.md's trigger surfaces). Returns `SECURE | UNSAFE` + issues → step 5.

**4. gates** (deterministic, **no LLM**) — the gate is a **Stop hook** that runs the frozen test **directly by path** (e.g., `node --test <test_path>`, from the pinned manifest) and **blocks the hand until the frozen test is green** (the proven mechanism: the hand implements blind, cannot stop until the hook's test passes, and never touches the test). Never via a mutable npm script (e.g., `npm test`). **A capture failure (`lockedTestExitCode != 0` / `captured` not green) is a REAL gate failure and is NEVER dismissed as "environmental"/"sandbox"/"config" on the strength of an error message** (e.g. a stack-trace that happens to name `.dev.vars`) — it ALWAYS escalates (step 7). The ONLY non-code failure that does not escalate is the **pre-spawn `exit 2` raised by `spawn-hand.mjs` itself** (config-error path, above). If a project's tests need a runtime secret to execute, that is a setup precondition surfaced via the `exit 2` path, never a per-run judgment the orchestrator makes from the gate output. **The gate of record is the independent capture via `capture-hand.mjs`** — after the hand finishes, the orchestrator invokes `capture-hand.mjs` to independently re-run the frozen test and verify `captured: true`; the Stop hook is the in-run self-correction convenience, but the post-hoc independent capture is what feeds `evaluateRun` in `dispatch-hand.mjs`. **Capture-verified marker (Trilho 4):** **ONLY after** `capture-hand` reports `captured: true`, the orchestrator runs `node .claude/hooks/mark.mjs capture-verified --feature-id <feature-id> --task-id <task-id>` — never before the capture confirms `captured: true`, so the marker can never assert a capture that did not happen. (This `capture-verified` marker is implemented by a later task; this is the prose that instructs its use.) Any executor diff touching a manifest file OR any file/key in the runner-config exclusion set is an **automatic gate failure**. After the hand finishes, the orchestrator **re-verifies every manifest hash** from `.claude/plans/<feature_id>/test-manifest-<task_id>.json` and **reverts any out-of-scope working-tree write using the same stash mechanism adopted in step 7** — `git restore -- <path>` for a tracked modification, and `git stash push --include-untracked -- <path>` followed by `git stash drop` for an untracked file (the working tree is git-tracked → revertible; out-of-tree writes remain the operator-accepted sandbox residual). **Do NOT use the force-clean command** — it is denied by the settings baseline and a bare clean is a no-op; the stash mechanism (allowed: `Bash(git stash:*)`) genuinely discards untracked writes without weakening the permission baseline. Also run `tsc --noEmit` + lint. The test-author materialized the `locked_tests` in step 1a; the executor implements against them read-only, not rewriting them. Failure → step 5. This is the formal interface against orphan state (§2.3) — non-optional.

**5. sniper** — the **only fixer**. Applies **all** mapped issues from compliance + adversary + security + gates. Model = `hand_tiers[issue.severity]`; dispatched via the SAME runnable live-dispatch command as the executor (`node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor <descriptor.json>`, descriptor schema above — `model` resolves from `hand_tiers[issue.severity]`) — live spawn path: `claude -p` + isolated ephemeral CLAUDE_CONFIG_DIR; Ollama cheap hand for ALL severities. The sniper hand-dispatch **descriptor carries `feature_id` and `task_id`** (capture rail, step 1d; `session_id` arrives on the PostToolUse payload, not the descriptor), and the orchestrator runs `node .claude/hooks/mark.mjs hand-finished --feature-id <feature-id> --task-id <task-id>` right after the sniper hand returns. **Severity resolution (total over all four sources):** use the finding's explicit `severity` when present; a gate failure or a compliance VIOLATED-locked-decision is auto-**high**; otherwise fall back to the owning `task.severity`; never below hand_tiers.medium for a fail-class finding.

- **fail-class finding (the floor trigger, defined):** a fail-class finding = any finding in one of the 8 canonical-critical-classes, any gate failure, any compliance fail / VIOLATED-locked-decision, or any security UNSAFE. Any such finding floors the dispatch at `hand_tiers.medium` (never below), mechanically.
- **Mixed-severity batch (the dispatch resolves over the APPLIED SET, not one issue):** the sniper applies the **batch** of mapped issues, so the dispatch model AND the re-gate trigger resolve from the **MAX resolved severity across the applied set** — never off whichever issue happens to be first or lowest. Concretely: dispatch on `hand_tiers[max(resolved_severity over applied set)]`, and **the re-gate fires whenever ANY finding in the applied set resolves to HIGH** (auto-high included), not "the issue's severity". A batch of one HIGH + several LOW dispatches at `hand_tiers.high` and triggers the re-gate.
- LOW → sniper `hand_tiers.low` · MEDIUM → sniper `hand_tiers.medium` · **HIGH → sniper `hand_tiers.high` (cheap Ollama hand) + MANDATORY re-gate: fresh virgin adversary (strong Claude eye) AFTER the fix.**
- **Deterministic re-gate rail (survives compaction — do NOT leave it in prose only):** BEFORE dispatching the sniper on any finding that resolves to HIGH, stamp `regate-pending` via `node .claude/hooks/mark.mjs regate-pending --feature-id <feature-id> --task-id <task-id>`. Stamp `regate-passed` (`node .claude/hooks/mark.mjs regate-passed --feature-id <feature-id> --task-id <task-id>`) **ONLY after** the fresh-virgin strong-Claude-eye adversary re-gate returns **ZERO blocking findings**. A `regate-pending` without a matching `regate-passed` (same feature-id + task-id) is a **delivery-blocking precondition**: the self-check (Phase 3) and delivery MUST refuse to proceed while any `regate-pending` lacks its `regate-passed`.
- A grave fix is guaranteed by the mandatory strong-eye re-gate on high — not by a Claude sniper. If a fix is bigger than surgical scope (re-architecture, not a fix), it is **not** a sniper job → escalation (re-dispatch executor or split the task).
- **Re-gate→sniper iteration cap:** after **2** re-gate→sniper cycles still failing on a HIGH finding, escalate: re-dispatch the executor or a Claude hand for that fix (spec §4.3 final fallback) — do not loop the cheap sniper indefinitely on a grave finding.
- After sniper, re-run the relevant gate to confirm green.

> **Reconciles spec §8 'no-Ollama-for-grave-findings' wording:** the sniper is a cheap Ollama hand (`hand_tiers[issue.severity]`) for ALL severities, including high. The prior wording ("a task with no complexity and severity high never resolves to an Ollama eye/sniper for a grave finding") is superseded: the sniper IS an Ollama hand even on high. The guarantee for a grave fix is the MANDATORY strong-eye re-gate (fresh virgin adversary, Claude eye) that runs AFTER the fix — not a Claude sniper.

**6. record + curate** — persist to disk after each step (never keep only in context — compaction would lose it):
- append this task's raw findings (decisions, gotchas, bugs found/fixed) to a running `findings.md` at the project root.
- rewrite `.claude/plans/<feature_id>/shared_context.md` with the **learnings worth carrying forward** so far — from the spec review, the upfront adversarial, this run, and adversarial/compliance findings worth keeping. Budget-capped; the adversary never reads this file (stays virgin).
These two files are the on-disk hand-off between steps and survive context compaction.

**6-commit. impl-commit** — after the task's gates are GREEN (all compliance/adversary/security findings resolved and re-gated), the orchestrator COMMITS the production diff: `feat(<scope>): <task summary>` (Conventional Commit; no Co-Authored-By trailer per repo rules). Stage only the production files — `scope_paths` MINUS the frozen manifest closure (those were already committed in the freeze-commit). HEAD advances per task. The PR is a multi-commit series: one `test(<scope>): freeze locked tests for <task-id>` freeze-commit + one `feat(<scope>): <task summary>` impl-commit per task — clean, reviewable history.

**7. escalation** — engineering, resolved inside the system, never handed to the human.

**Executor escalation (K=1 failure of frozen locked_tests or gates):** On K=1 failure, escalation re-dispatches the **EXECUTOR** one tier up within `hand_tiers`. The escalation NEVER re-dispatches the sniper — the sniper rescues surgical findings, not a structurally wrong implementation; only a stronger executor hand can fix the latter.

**Before re-dispatch — freeze-commit-anchored reset (verify-then-stash):** Per-task commits (step 1c-commit and step 6-commit) mean HEAD always points to the current task's freeze-commit. The working tree's uncommitted content is therefore ONLY the current failed executor attempt — including any **untracked** files the hand created. **First verify the anchor:** check `git rev-parse HEAD` equals the freeze-commit SHA recorded in step 1c-commit. If they DIFFER, do **not** reset blind — **ABORT escalation to a critical exception** (the anchor assumption is broken; a blind discard could destroy committed work). On a match, discard the failed attempt — tracked changes AND untracked files — with `git stash push --include-untracked` followed by `git stash drop`. This moves the entire failed attempt off the working tree (tracked + new untracked production files), leaving HEAD = the task's freeze-commit, then discards the stash. This is SAFE: HEAD is the task's freeze-commit, so the frozen test/fixtures and every prior task's committed work are fully preserved — only the uncommitted/untracked failed attempt is discarded. The destructive hard-reset and force-clean commands are intentionally NOT used here — both are denied by the settings baseline, AND a hard-reset alone would leave untracked files behind (a failed hand's new untracked production files would survive and pollute the retry). The stash mechanism (allowed: `Bash(git stash:*)`) genuinely discards tracked + untracked and keeps the security baseline intact — the denied destructive commands stay denied; the baseline is not weakened.

**Tier mapping for executor escalation (v2 flip applied):** In v1, LOW and MEDIUM executors ran on Ollama; HIGH resolved to Claude — a medium-tier failure escalated directly to the **Claude hand fallback** (hand_tiers.high became the escalation target only after the v2 flip, when the high executor moved to Ollama). **In v2 (the v2 flip is now active):** ALL executor tiers (low/medium/high) run on Ollama via the live spawn path (`dispatch-hand.mjs` + `spawn-hand.mjs`). Escalation steps: LOW → MEDIUM (Ollama, `hand_tiers.medium`). MEDIUM → HIGH (Ollama, `hand_tiers.high`). HIGH-tier failure escalates to the **Claude hand fallback** (the final escalation target; Claude is reachable by a hand only via this K=1 escalation fallback — `claude_only_via_escalation_fallback: true`). Note: executor-high→Ollama is the v2 decision (`executor_high_revert_trigger: ac_v2.7_derisk_metering` — if AC v2.7 de-risk metering shows it net-negative, executor-high reverts to executor-high→Claude, skipping the prior v3 A/B gate by operator decision).

**Escalation-fallback ticket (Trilho 3 — deterministic precondition, survives compaction):** the Claude hand fallback is the **ONLY** legit main-loop `Agent(executor|sniper)` dispatch in v2 for Ollama hands — the entry-gate hand-routing branch otherwise **DENIES** a main-loop `Agent(executor|sniper)` (in v2 those roles route through the spawn-hand path, not `Agent`). So **IMMEDIATELY BEFORE** dispatching the K=1 Claude `Agent(executor|sniper)` fallback, the orchestrator MUST stamp the ticket: run `node .claude/hooks/mark.mjs escalation-fallback --feature-id <feature-id> --task-id <task-id>`. **Without this ticket the entry-gate hand-routing branch DENIES the fallback** — the `Agent(executor|sniper)` dispatch is refused as an illegitimate inline-hand attempt. The ticket is the explicit precondition that authorizes the one legit escalation `Agent` fallback; stamp it, then dispatch. **Note on test-author:** the test-author is NOT governed by this ticket/run-record rail — it always runs as a Claude Agent (dispatched directly, no ticket needed, no spawn-hand path). If the compliance fidelity gate (step 1b) fails after 2 cycles, the escalation is to a stronger Claude eye for the transcription, not an `escalation_fallback` ticket dispatch.

**The ticket alone is NOT enough (Trilho 5 — on-disk evidence belt):** the entry-gate now allows the Claude `Agent(executor|sniper)` fallback ONLY when the `escalation_fallback` ticket maps to an **on-disk run-record whose `outcome` is a genuine non-DONE run — `FAILED` (wrong work) OR `NOT_DONE` (empty diff)** — the non-forgeable evidence written by `runLiveDispatch`'s independent capture (real `exitCode` + `lockedTestExitCode`, never the model's prose). The record is **anchored to its `freeze_commit_sha`**: the gate cross-checks it against the current `HEAD`, so a STALE record from a prior run/freeze can never authorize a later, unfailed escalation (a positive freeze≠HEAD mismatch denies; an unreadable HEAD fails open). A stamped-but-recordless ticket (echo-forged, or a pre-spawn config error that produced no run) does NOT unlock the fallback. So a genuine cheap-hand run-and-fail (CLI exit `1` — `FAILED` or `NOT_DONE`) is the ONLY thing that authorizes the Claude escape; a config error (CLI exit `2`) routes to the critical exception instead. (The test-author is not governed by this evidence belt — it always runs as a Claude Agent, no ticket or run-record needed.)

**Bounded escalation — no unbounded loop:** Bounded escalation at max 1 step per task (K=1 triggers the tier bump once; no further escalation loop). If the escalated executor also fails its gates: **critical exception** — not another escalation. Cost is instrumented via **ccusage** so a net-negative escalation rate (cheap-hand savings < escalation overhead) can retire the `hand_tiers` experiment with data.

**Critical exception** (both modes): if escalation is exhausted and gates remain failing — **INTERACTIVE:** pause and ask the operator in **product-language** ("o login pode falhar se o usuário fizer X — (a) aceita (b) repensa"), never as a technical problem ("conserta esse race condition"). **HEADLESS:** do **not** pause — **record the risk as an open item in the PR** (product-language description) and continue; the human accepts or refuses it asynchronously at PR review.

**Hand config-error → critical exception (NOT a K=1 escalation):** when a cheap-hand dispatch exits `2` (pre-spawn config error: no Ollama token, dirty baseline relative to the freeze-commit, gate not armed, missing/invalid frozen test, diverged HEAD), the hand never ran — there is no genuine failure to escalate. Stamp `node .claude/hooks/mark.mjs hand-config-error --feature-id <feature-id> --task-id <task-id> --reason "<product-language reason>"` and route it to THIS critical-exception path (INTERACTIVE: surface to the operator; HEADLESS: open-PR risk item). **Never** retry into a silent Claude fallback (the entry-gate denies it — no on-disk `FAILED` record exists) and **never** silently lock the pipeline. This is the deterministic escape that keeps a missing token from deadlocking delivery. **The Ollama token is a LOCAL setup precondition, not something to discover per task:** the operator sets `export OLLAMA_HAND_TOKEN=…` in the shell rc (env survives the command-sandbox, which denies reading `.dev.vars`; the name is inert to Claude Code's own auth). Cheap hands is a **LOCAL-only** capability — the cloud uses the standard Claude models. In **HEADLESS** the orchestrator does NOT invoke `spawn-hand.mjs` at all; it dispatches the hand roles as ordinary Claude `Agent`s, and the entry-gate allows a main-loop hand-role Agent when `$CLAUDE_CODE_REMOTE` is set (see "Hands vs Eyes — HEADLESS exception"). So a missing Ollama token in the cloud is a non-event, not a `hand-config-error`.

> **Escalation vs. sniper re-gate — distinct protocols:** the **executor escalation** (above) handles K=1 total implementation failure — re-runs the whole task with a stronger hand. The **sniper re-gate** (step 5) handles surgical fixes to specific compliance/adversary/security/gate findings. A sniper is never escalated to re-implement a task.

**GPU-time guard (Ollama non-zero / timeout exit):** A non-zero or timeout exit from the external hand (e.g., Ollama GPU-time cap hit mid-task) is treated as an **ESCALATION** — identical in protocol to a K=1 implementation failure. Before re-dispatch: discard the partial attempt using the per-task-commit stash mechanism (`git stash push --include-untracked` + `git stash drop`). Do **NOT** update `shared_context` for the incomplete task — the hand did not finish, so no learnings are carried forward for an incomplete task. A timeout is an **escalation, NOT a code-quality failure** — it does **not** burn the fix/tier budget the way a real test failure (failed locked_test) does. The escalation tier step-up applies (same K=1 → next-tier logic); if the next-tier hand also times out, it counts as a second escalation failure and triggers the same critical-exception path.

Move to the next task only when its gates are green.

---

## LIGHT vs FULL

| | LIGHT | FULL |
|---|---|---|
| Plan | light plan (`mode: "light"`) | full plan |
| Spec-adversary (upfront) | **MANDATORY** — single virgin **adversary** dispatch against the spec before plan dispatch | **MANDATORY** — single virgin **adversary** dispatch against the spec before plan dispatch |
| Spec analysis | spec-vs-codebase (map existing debt) + upfront adversarial pass (map new risks) | spec-vs-codebase + upfront adversarial pass (map new risks) |
| Per-task review | **none** — executor with tiering only, no compliance/adversary between tasks | full loop (steps 2–5 per task) |
| Final review | **dual review only** (compliance + adversary, whole feature) | dual review + per-task loop |

The **spec-adversary is unconditional and upfront in both modes** — it validates the spec surface before code is written. LIGHT trades per-task review for a final dual review; **per-task adversary (Phase 2, step 3) only runs in FULL**. **Tiering of the executor applies in both modes** — a small feature can still generate debt if a high-severity task is run on a weak model.

---

## Phase 3 — Final dual review (both modes)

Scope = the **whole feature**, not one task. Roles, feature-wide scope:
- **compliance** (sonnet) — entire implementation vs spec.
- **adversary** (**opus** — final gate; virgin) — hunts bugs across the full implementation. The **per-task** adversary (Phase 2, step 3) is also opus; the final-gate adversary differs by **scope** (the whole feature, not one task) and a raised `effort`, not by model.
- **security** (opus, virgin) — **dispatched in both LIGHT and FULL when `final_review.security` is true** (the planner sets it when the feature's aggregate `scope_paths`/tasks hit a security trigger). This is the only security pass LIGHT gets, so it is load-bearing: a LIGHT feature that wires an outbound HTTP call or a new entrypoint still gets audited here.

**Dispatch these concurrently (fan-out-join).** They **gate the PR** — dispatch all applicable eyes **in a single fan-out (one message with N Agent calls)** and **join (collect all verdicts) before gating the PR/delivery**. Two patterns — one forbidden, one required: ❌ **background-and-poll** (forbidden): the orchestrator dispatches, continues doing other work, and polls for verdicts — a polled result can arrive stale or out-of-band (returning an earlier spec-review verdict instead of the final gate verdict), so the gate would proceed on incomplete findings; ✅ **fan-out-join** (required): all applicable eyes are dispatched together in one message and the orchestrator **blocks until every verdict arrives** — the guarantee "capture every verdict before proceeding" is maintained in full. The wall-clock gain: the opus adversary (slow) runs concurrently with compliance and security instead of in sequence. These eyes are read-only — they do not write to the working tree, do not stamp markers in gate-state, and are mutually independent (adversary enters virgin with no prior verdicts; compliance enters lean without shared_context) — so there is no ordering constraint among them; the parallelism does not touch the security rail.

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

Delivery (push and PR via **shipper** — per-task commits already exist on the branch). **INTERACTIVE:** happens only on explicit operator authorization — merge/deploy is an irreversible, outward-facing action (human checkpoint). **HEADLESS:** the shipper opens a **draft PR and never merges** — the PR review is the real human gate. Either way the shipper commits any uncommitted `.claude/memory/` and `.claude/kaizen.md` residue so durable knowledge persists.

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
- Final dual review passed; sniper fixes re-gated. **DELIVERY-BLOCKING:** every `regate-pending` in the gate-state has a matching `regate-passed` (same feature-id + task-id) — refuse to proceed to delivery while any HIGH sniper fix is still `regate-pending` without its `regate-passed`.
- `demo-script.md` derived from UJs/ACs (not implementation), tested by the operator.
- Harvester ran; durable learnings routed (repo memory `.claude/memory/` / nested CLAUDE.md / `.claude/kaizen.md`); `findings.md` and `shared_context.md` deleted.
- Adversary entered virgin on every dispatch; no prior verdict leaked into it.
- Every operator message was product-language pt-br.
- **HEADLESS:** no gate paused the run; gates 1–3 became multi-agent validation; spec, plan summary, demo result, and any open risk are in the draft PR (product-language); the shipper opened a **draft** PR and did not merge; `.claude/memory/` and `.claude/kaizen.md` were committed.
