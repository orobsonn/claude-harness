# Design Spec — "Strong Eyes, Cheap Hands": Ollama executors in the Claude Harness

**Date:** 2026-06-12
**Status:** Design approved by operator, pending spec review → FULL plan
**Scope:** Modify the Claude Harness core so that code-*writing* roles run on cheap Ollama-cloud models while all *judging* roles stay on the Claude subscription.

---

## 1. Principle

**Strong eyes, cheap hands.** Split agents by ROLE, not by task attribute:

- **Hands (write code) → Ollama cloud.** `executor` + `sniper`.
- **Eyes (judge) → Claude.** orchestrator (Sonnet) + every reviewer: `compliance`, `adversary`, `security`, gates, `plan-reviewer`. Never leave Claude.

The `planner` does NOT change. It keeps emitting 3-level `complexity` with unchanged semantics. The provider decision is made AFTER planning, mechanically — the planner never knows or cares which provider executes.

## 2. Why this is consistent with the existing harness

Verified in source:
- `creating-plans/SKILL.md` — the **planner (Opus) pins each `locked_test.assertion`** (Given/When/Then over a concrete observable), frozen in the plan. A cheap `test-author` *transcribes* the assertion into a test file (§3.7); an eye validates fidelity before it freezes; the executor implements to green and cannot touch it. The skill already warns that "a cheap executor will write theatre to pass the gate" and defends against it (concrete-observable assertions + validator rejection). So the security-load-bearing JUDGMENT (the assertion) is authored by Opus, never by a cheap model; the cheap model only transcribes, under eye validation.
- The harness already runs cheap executors (haiku) on sensitive code, trusting the Opus review net ("Bias DOWN … a cheap executor suffices; the expensive reasoning belongs at the ends — plan and review — not the middle"). Swapping haiku→glm is a model upgrade, not a new risk class.

Therefore: cheap hands on sensitive code is the harness's *existing* stance. This design extends it from haiku to stronger open models, nothing more.

## 3. Locked decisions

1. **Roles split by hands/eyes** (§1).
2. **Hands routed by `complexity` among Ollama models** (from public-benchmark analysis 2026-06-12; primary / fallback):
   - `low → deepseek-v4-flash` (fb `gemini-3-flash-preview`) — 13B active, ~$0.14/M, 79% SWE-V; cheapest that still tool-calls reliably.
   - `medium → kimi-k2.6` (fb `minimax-m2.5`) — 80.2 SWE-V / 58.6 SWE-Pro / 66.7 TB2 + best published tool-use suite.
   - `high → deepseek-v4-pro` (fb `glm-5.1`) — wins the A/B: better agentic numbers AND cheaper ($0.435/$0.87 vs $1.40/$4.40) + 1M ctx.
   - Numbers are mostly vendor-scaffold; de-risk the medium pick with ONE live LIGHT task counting tool-call errors before wiring.
3. **Eyes always Claude** — orchestrator Sonnet; reviewers Opus/Fable per current `model_strategy` roles.
4. **Sensitive code (auth/payment/billing/sql/migrations): cheap hands too.** No executor-model exception. The eyes guarantee it (the sensitive-path allowlist already forces full review: security + adversary + gates).
5. **Planner unchanged** — 3-level complexity, residual-reasoning semantics, bias-down.
6. **Sniper is ALWAYS a cheap hand** (Ollama), routed by `sniper_tiers[issue.severity]` over the Ollama map (higher severity → stronger Ollama model), with mandatory re-gate after fix. No exception — operator decided sniper stays cheap-hands across the board, including security-HIGH; the re-gate (a strong eye) is what guarantees the fix.
7. **Tests: cheap hand writes, strong eye validates fidelity, then frozen.** "Execution is cheap" applies to tests too. The **planner (Opus)** pins the concrete `assertion` — the JUDGMENT (what to prove). A new **`test-author`** agent — cheap (Ollama), ATOMIC (scope = transcribe one concrete assertion into one test file, nothing else), specific instructions — writes the test file. An **eye (`compliance`)** then validates the test is FAITHFUL to the assertion (asserts the full observable, not a weakened version) **before the file is frozen (hash)**. Reading+validating a test is cheaper than writing it, so the saving is real. The executor receives the frozen test **read-only** and only writes production code until green. The cheap model's word never decides DONE — verification is deterministic and model-proof (§4.4).
   - **Order:** planner pins assertion → planner calls `test-author` (Ollama, via Bash) → planner validates the test's fidelity to the assertion in-run (re-calls with feedback if weak, capped by an iteration limit) → **freeze (hash)** → executor implements against the frozen test → orchestrator gate re-runs + verifies hash.
   - **Dispatch (PROVEN 2026-06-12):** a subagent CAN invoke another agent — both work from inside a subagent: (a) the native **Agent tool** works, but the child runs on the **subscription** (→ a Claude eye, NOT an Ollama hand); (b) **`claude -p` via Bash** works and runs on **Ollama** (→ cheap hand). **Chosen UX:** the `planner` calls the `test-author` on Ollama via Bash mid-run and, having authored the assertion, validates the test itself in-run — no orchestrator round-trip. The planner config must gain Bash-dispatch of the Ollama test-author. Trade-offs for the plan: planner gains a responsibility (plan + materialize/validate tests); needs an iteration cap.

## 4. Architecture changes

### 4.1 Split the tier maps (fixes a real shared-map bug)
Today `executor` and `sniper` both resolve from a single `tiers` map, and a task with no `complexity` falls back to `tiers[severity]`. Redefining that one map to Ollama would silently (a) make a grave-bug sniper run on a weak model and (b) drop sensitive no-complexity tasks onto Ollama.

**Change:** `model_strategy` gets explicit, separate maps:
- `hand_tiers` (executor + sniper) → Ollama models, keyed by complexity / severity.
- `eye_tiers` / role models (orchestrator + reviewers) → Claude, unchanged.
- The `complexity ?? severity` fallback must resolve within `hand_tiers` only — never cross into eye models. Update the dependency-free validator accordingly.

### 4.2 Dispatch mechanism — THE central engineering challenge
This is the hardest, least-proven part and the main thing the FULL plan must solve.

Today the orchestrator dispatches `executor`/`sniper` via the **native Agent/subagent tool**, which runs inside the session on the Claude subscription. **The Agent tool cannot point a subagent at Ollama** — it uses the session's auth.

So a hand-on-Ollama cannot be a native subagent. It must be an **external headless process**:
```
claude --bare -p "<task brief>" \
  --append-system-prompt-file <executor-system.md> \
  --allowedTools "<scoped>" --permission-mode acceptEdits \
  --model <ollama-model> --output-format json
# env: ANTHROPIC_BASE_URL=https://ollama.com  ANTHROPIC_AUTH_TOKEN=<ollama key>
#      CLAUDE_CONFIG_DIR=<isolated>            run inside a git worktree / container
```
Consequences the plan must address:
- **Context loss at the boundary.** Native subagents receive curated layered context (L0–L3 + `shared_context`). An external process gets only what we materialize into the brief/system-prompt file. The task is already "tied down" (resolved_judgments, locked_tests, scope_paths), so this is feasible — but the orchestrator must *write the brief* instead of passing context in-process.
- **Skill loss.** `--bare` strips skills; the executor today may invoke `cloudflare`/`wrangler`. Either mount a minimal `CLAUDE_CONFIG_DIR` with only the needed skills, or pass domain guidance in the system-prompt file. Decide in plan.
- **Result capture.** Truth = `git diff` (scope-checked) + locked-test exit code + the JSON status block. Never the model's prose. NDJSON cost stream is best-effort metering only.
- **Isolation.** Run each hand in a git worktree (or container) so an out-of-scope shell write can't touch the real tree; network allowlist must include `ollama.com`.

### 4.3 Escalation
A hand that fails its frozen locked_tests / gates: **K=1** → re-dispatch one tier up within Ollama, final fallback = re-dispatch on a Claude hand (rare). Escalation is a **re-dispatch of the executor**, never the sniper (sniper is edit-only and can't rescue a structurally wrong implementation). Instrument cost (ccusage); if the escalation rate makes Ollama net-negative, the tiers are killed with data.

## 5. Proven foundations (PoC, 2026-06-12)
- `ANTHROPIC_BASE_URL=https://ollama.com` speaks native Anthropic `/v1/messages`; Claude Code 2.1.175 authenticated with an Ollama token; tool-use (`Bash(ls)`) works.
- Real code task: glm-4.7 created `src/utils/slugify.ts` in an isolated worktree — 7/7 behavior cases pass, scope respected, conventions near-perfect (missed only the `@description` tag — exactly the fine deviation the review net catches).
- **`--bare` auth:** `--bare`+`ANTHROPIC_AUTH_TOKEN` authenticates against Ollama; `ANTHROPIC_API_KEY` 401s. Use AUTH_TOKEN.
- **Subagent→agent:** a subagent CAN invoke another agent — native Agent tool (runs on subscription) and `claude -p` via Bash (runs on Ollama) both work from inside a subagent.
- **Deterministic test-gate (the core rail) — PROVEN end-to-end:** frozen test + a `Stop` hook running it in headless `-p`. The Ollama executor (no Bash, no Read of the test) implemented blind, missed the `ZERO` edge case, tried to stop → hook ran the test → RED → blocked + fed back the failure → executor (which never saw the test) read the feedback, fixed it → GREEN → allowed. `hook.log`: `iter1 RED → iter2 GREEN`. Decision = hook exit code, never the model's word. Test-file hash unchanged (model-proof via deny + no-Bash + post-run hash). Confirms `Stop`-hook blocking enforces in `-p` mode.

## 6. Open questions for the FULL plan / empirical validation
1. **Exact model per hand tier** — A/B `glm-5.1` vs `deepseek-v4-pro` for `high` on a real task (cost + quality + retries).
2. **Skill isolation** for the external executor (`CLAUDE_CONFIG_DIR` mount vs system-prompt injection).
3. **`--bare` auth — RESOLVED (smoke-test 2026-06-12):** `--bare` + `ANTHROPIC_AUTH_TOKEN` authenticates against Ollama (`BARE_AUTH_OK`); `ANTHROPIC_API_KEY` does NOT (401 — Ollama needs the `Bearer` header, not `x-api-key`). Use `AUTH_TOKEN`.
4. **Security-HIGH sniper dial** — cheap hand + re-gate, or Claude hand for that one class.
5. **GPU-time caps** — deprioritized by operator. Ollama meters GPU-time with no prompt caching; long FULL runs may hit the cap. Not a gate — monitor in practice.
6. **`count_tokens` 404** — Ollama doesn't implement it; confirm it stays benign under the harness's call pattern.

## 7. Phasing (YAGNI — smallest testable first)
- **v1 — prove the dispatch mechanism.** Route ONLY the `low`/`medium` executor to Ollama via the external-process path, in LOCAL mode, on one real feature. Keep sniper + high + all eyes on Claude. Measure cost + escalation.
- **v2 — expand hands.** Add `high` (after A/B), move sniper to Ollama, wire escalation.
- **v3 — headless mode** parity (cloud routines) + the GPU-time budget guard.

## 8. Acceptance criteria (what "works" means)
- An execution-plan task with `complexity: low/medium` is implemented by an Ollama hand and lands a correct diff that passes its frozen locked_tests, with scope respected.
- All reviewers + orchestrator demonstrably stay on Claude (no eye ever resolves to an Ollama model; validator enforces).
- A task with no `complexity` and `severity: high` never resolves to an Ollama eye/sniper for a grave finding.
- Escalation re-dispatches the executor (not the sniper) on K=1 and is cost-instrumented.
- Sensitive-path tasks still trigger full review unchanged.

---

## 9. Acceptance criteria (numbered anchors)

Anchors derived strictly from §8 (the 5 prose bullets) plus the operator-resolved decisions (2026-06-12). No new product content — this section only assigns stable `#ac-N.M` ids to what is already decided, so plan tasks and downstream review can trace against real anchors.

### 9.1 Hands write, eyes judge (§8 bullets 1–2, decision #4)
- **#ac-1.1** — An execution-plan task with `complexity: low/medium` is implemented by an Ollama hand and lands a correct diff that passes its frozen locked_tests, with scope respected. (§8 bullet 1)
- **#ac-1.2** — `claude --bare -p` completes a real task despite the Ollama `count_tokens` 404 (the 404 is benign and never fails the task). (§6.6)
- **#ac-2.1** — All reviewers + the orchestrator stay on Claude: no eye ever resolves to an Ollama model; the validator enforces it. (§8 bullet 2)
- **#ac-2.2** — The executor/sniper `complexity ?? severity` fallback resolves WITHIN `hand_tiers` only — never crossing into an eye model. (decision #4 / §4.1)
- **#ac-2.3** — Backward-compat: a legacy single-`tiers` plan still validates (in-flight 1.0 plans survive mid-run re-validation); a plan presenting BOTH `hand_tiers` and legacy `tiers` is rejected with a clear error path. (decision #4)

### 9.2 Dispatch boundary + token hygiene (§4.2, decision #2)
- **#ac-3.1** — `ANTHROPIC_AUTH_TOKEN` is read from a gitignored `.dev.vars`/env (with a `.dev.vars.example` placeholder), never materialized into the brief / `shared_context.md` / any committed artifact, redacted from logs and captured JSON, and upstream error bodies are truncated to 500 chars.
- **#ac-3.2** — The hand runs as `claude --bare -p` under the existing command-sandbox + a git worktree (no container); a write outside the per-dispatch allowed-write set (even if inside `scope_paths`) fails the run.
- **#ac-3.3** — Context parity: the curated, budget-capped `shared_context` is serialized into the external hand's brief/system-prompt file.
- **#ac-3.4** — Result-capture truth = scope-checked `git diff` + locked-test exit code + JSON status block; never the model's prose.

### 9.3 Deterministic test rail (decision #3 / §3.7, manifest hardening)
- **#ac-4.1** — A new cheap `test-author` hand transcribes ONE pinned assertion into ONE test file — atomic scope, nothing else.
- **#ac-4.2** — `compliance` (a Claude eye) validates the test's fidelity to the assertion BEFORE the file is frozen — not the planner in-run.
- **#ac-4.3** — Transcription iteration cap = 2; on exhaustion the transcription escalates to a stronger hand.
- **#ac-4.4** — The executor receives the frozen test READ-ONLY and stops authoring tests.
- **#ac-4.5** — The freeze is a content-hash MANIFEST (the test file PLUS every support/fixture file the test-author created); the executor's allowed-write set = `scope_paths` minus the frozen manifest and the test-runner config; the gate invokes the frozen test by path (not via a mutable npm script) after verifying every manifest hash; any executor diff touching a manifest file or the runner config is an automatic gate failure.

### 9.4 Sniper + escalation (§8 bullets 3–4, decision #5)
- **#ac-5.1** — The sniper is ALWAYS a cheap Ollama hand, routed by `severity` over `hand_tiers`, with a MANDATORY re-gate by a strong Claude eye after the fix.
- **#ac-5.2** — A task with no `complexity` and `severity: high` never gets an Ollama eye for a grave finding; the mandatory strong-eye re-gate (not a Claude sniper) is what guarantees the grave fix. (§8 bullet 3, reconciled)
- **#ac-5.3** — Sensitive-path tasks still trigger full review unchanged. (§8 bullet 5)
- **#ac-6.1** — Escalation re-dispatches the EXECUTOR (not the sniper) one tier up within `hand_tiers` on K=1, resets the worktree to the task's base commit before re-dispatch, and is cost-instrumented (ccusage). (§8 bullet 4 / §4.3)

### 9.5 Migration rail + headless/GPU (decision #6, §6.5, v3)
- **#ac-7.1** — Any cheap-hand task whose `scope_paths` match `**/*.sql` or `**/migrations/**` MUST carry a locked_test that spins up an ephemeral DB, runs the migration, and asserts post-migration state (not a text-match on the migration file); captured as a planner RULE in creating-plans.
- **#ac-8.1** — Headless parity: the external hand-dispatch path operates in cloud-routine mode with the same brief-serialization contract as local.
- **#ac-8.2** — GPU-time guard: a non-zero or timeout exit from the hand is treated as an escalation — reset the worktree and do NOT update `shared_context` for the incomplete task.
