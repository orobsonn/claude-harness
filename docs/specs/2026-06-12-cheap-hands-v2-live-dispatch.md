# Spec — Cheap Hands v2: live Ollama dispatch (wire the spawn)

**Date:** 2026-06-12
**Status:** Approved by operator — ready to implement next session
**Builds on:** v0.5.0 ("strong eyes, cheap hands" v1 — scaffold, rails, gates, docs)
**Repo:** the Claude Harness OWN source (`claude-harness`), under `core/`

---

## ⟢ Next-session kickoff prompt (copy-paste)

> Implementar o **v2 do "strong eyes, cheap hands"**: ligar o spawn vivo do Ollama, conforme a spec em `docs/specs/2026-06-12-cheap-hands-v2-live-dispatch.md`. O v1 (v0.5.0) já entregou todo o andaime — contrato do validador, `dispatch-hand.mjs` (funções puras de avaliação), trilho de teste, re-gate determinístico, escalação, gates e docs. **Falta só plugar a tomada**: fazer o orquestrador realmente lançar `claude --bare -p` contra o Ollama para o executor low/medium, capturar o resultado de forma independente (git diff + rodar o teste congelado, nunca a prosa do modelo), e enviar o artefato `captured:true` pro `evaluateRun`. A PoC §5 já provou o mecanismo ao vivo isolado — é integração, não pesquisa.
>
> Este é o repo FONTE do harness (`core/`). É modificação do core de dispatch + caminho sensível (token Ollama, processo externo) → **FULL**. Rode `triaging-requests` → `orchestrating-delivery` FULL. As mãos desta implementação rodam no Claude (o harness se constrói com Claude); o entregável é o código que liga o Ollama.

---

## 1. Where v1 stopped (the gap this spec closes)

v0.5.0 shipped the **brain that judges a cheap hand** and the **rails that make it safe**, but NOT the **plug that launches the cheap hand**:

- `core/skills/orchestrating-delivery/references/dispatch-hand.mjs` — pure functions (`evaluateRun`, `checkScope`, `checkAllowedWrites`, `checkFrozen`, `redact`/`redactDeep`, `truncateUpstreamError`, `isBenignCountTokens404`, `readAuthToken`) + a thin CLI that reads an ALREADY-CAPTURED child result from a file. The **subprocess spawn of `claude --bare -p` is a documented stub** (header §"The spawn/capture layer MUST populate…", lines ~16-20, ~159-174) — the runner can JUDGE a hand's output but does not LAUNCH the hand.
- `orchestrating-delivery/SKILL.md` Phase 2 DOCUMENTS that the executor/sniper route to `hand_tiers` via `dispatch-hand.mjs`, but the orchestrator still dispatches them via the **native Agent tool (Claude subscription)** because the external-spawn path is unwired.
- The **Stop hook** that gates the cheap hand on the frozen test (the proven §5 mechanism) is documented but **not shipped as an artifact** (no `Stop` event in `core/settings.json`, no `CLAUDE_CONFIG_DIR` template for the hand).

Compliance flagged this precisely: **`#ac-1.1` was PARTIAL** ("infra present, live-path absent").

**v2 = wire the live spawn + independent capture + the Stop-hook artifact, and prove it routes a real low/medium executor task to Ollama on one feature (LOCAL).** This is the original spec's v1 GOAL (`docs/specs/2026-06-12-eyes-strong-hands-cheap.md` §7), now that the scaffold exists.

## 2. Proven foundation (PoC — already validated, do NOT re-research)

From `docs/specs/2026-06-12-eyes-strong-hands-cheap.md` §5 (proven 2026-06-12):
- `ANTHROPIC_BASE_URL=https://ollama.com` speaks native Anthropic `/v1/messages`; Claude Code authenticated with an Ollama token; tool-use works.
- Real code task: an Ollama model created a file in isolation, 7/7 behavior cases passed, scope respected.
- **`--bare` auth:** `--bare` + `ANTHROPIC_AUTH_TOKEN` authenticates against Ollama; `ANTHROPIC_API_KEY` 401s. **Use `AUTH_TOKEN`.**
- **Deterministic test-gate — PROVEN end-to-end:** frozen test + a `Stop` hook running it in headless `-p`. The Ollama executor (no Bash, no Read of the test) implemented blind, missed an edge case, tried to stop → hook ran the test → RED → blocked + fed back the failure → executor fixed → GREEN → allowed. Decision = hook exit code. Test-file hash unchanged. `Stop`-hook blocking enforces in `-p` mode.
- `count_tokens` 404 from Ollama is benign.

## 3. What to build (concrete integration points)

### 3.1 The spawn function (`dispatch-hand.mjs` or a sibling)
Add the live dispatch that v1 stubbed. A function/CLI mode that LAUNCHES the hand:
```
claude --bare -p "<brief>" \
  --append-system-prompt-file <system-prompt-file> \
  --allowedTools "<scoped: Read,Write,Edit — NO Bash for the hand; the Stop hook runs tests>" \
  --permission-mode acceptEdits \
  --model <hand_tiers[complexity ?? severity]> \
  --output-format json
# env: ANTHROPIC_BASE_URL=https://ollama.com  ANTHROPIC_AUTH_TOKEN=<from .dev.vars>
#      CLAUDE_CONFIG_DIR=<the isolated hand config with the Stop hook — §3.3>
# cwd: the project working tree (NO worktree, per the v1 operator decision)
```
- Runs in the working tree under the harness command-sandbox + the **per-dispatch allowed-write set** (already a concept in v1).
- The token is read from `.dev.vars`/env (`readAuthToken`), passed ONLY via the child env, NEVER in argv/brief/logs (reuse v1 redaction).
- The brief/system-prompt file is written by the orchestrator with the scrubbed `shared_context` (no secrets/PII — v1 guard).

### 3.2 Independent capture (the load-bearing trust boundary)
After the hand exits, the harness — NOT the model — builds the child result:
- `touchedPaths` ← `git diff --name-only` (+ untracked in scope) in the working tree.
- `lockedTestExitCode` ← an INDEPENDENT run of the frozen test by path (`node --test <test_path>` / the project's runner), NOT the model's claim.
- `captured: true` stamped by the harness.
- `upstreamErrorBody` / stderr piped through `redact()` at capture-write time.
Feed this to `evaluateRun` (already fail-CLOSED on `captured !== true`). The model's stdout/prose is NEVER parsed into these fields. (See dispatch-hand.mjs header §159-174.)

### 3.3 The Stop-hook artifact (the in-run gate)
Ship the hand's isolated `CLAUDE_CONFIG_DIR` template:
- A `settings.json` for the hand with a **`Stop` hook** that runs the frozen test by path and **blocks** (non-zero exit) until green — the proven §5 mechanism. The hand cannot "finish" until the frozen test passes, and it has no Bash/no Read of the test (model-proof).
- Decide skill exposure under `--bare`: default = domain guidance via the system-prompt file (v1 decision); mount only a minimal skill set if a task genuinely needs one.
- Place under `core/skills/orchestrating-delivery/references/hand-config/` (or similar) + reference it from `dispatch-hand.mjs` §3.1 and `SKILL.md` Phase 2.

### 3.4 Wire into the orchestrating-delivery loop
In `orchestrating-delivery/SKILL.md` Phase 2: for a **low/medium executor** task (v1 phasing — high + sniper + all eyes stay on Claude in this slice), the orchestrator calls the spawn path (§3.1) instead of the native Agent tool; everything else (compliance/adversary/gates/per-task commits/escalation/re-gate) is unchanged (already shipped). The model resolves from `hand_tiers[complexity ?? severity]` read from the plan.

### 3.5 De-risk + metering
- Per the original spec §3.2/§7: run **ONE live LIGHT task** counting tool-call errors before fully trusting the `medium` tier.
- Cost instrumented via the NDJSON cost stream / ccusage (best-effort metering). If the escalation rate makes Ollama net-negative, the tiers are killed with data.

## 4. Acceptance criteria

- `#ac-v2.1` — An execution-plan task with `complexity: low` or `medium` is implemented by an **actual Ollama hand** (`claude --bare -p` against ollama.com), landing a correct diff that passes its frozen locked_tests, scope respected — demonstrated on one real feature in LOCAL mode.
- `#ac-v2.2` — The child result fed to `evaluateRun` is built by **independent capture** (`git diff --name-only` + an independent frozen-test run), stamped `captured: true`; the model's prose is never parsed into `touchedPaths`/`lockedTestExitCode`. A hand whose prose claims success but produced an empty/failing diff is NOT DONE.
- `#ac-v2.3` — The **Stop-hook artifact** exists and gates the hand: the hand cannot finish until the frozen test is green; the test-file hash is unchanged after the run (model-proof).
- `#ac-v2.4` — The Ollama `ANTHROPIC_AUTH_TOKEN` is read from `.dev.vars`, passed only via child env, and never appears in any captured artifact/log/argv (v1 redaction holds end-to-end through the live path).
- `#ac-v2.5` — `count_tokens` 404 does not fail the task; a real upstream error is still surfaced (truncated + redacted).
- `#ac-v2.6` — Eyes/sniper/high stay on Claude (no live Ollama routing for them in this slice); the re-gate + escalation rails still fire as in v1.
- `#ac-v2.7` — One LIGHT de-risk task was run and its tool-call error count / cost is reported.

## 5. Scope boundaries
- **In:** live spawn + independent capture + Stop-hook artifact for the **low/medium executor**, LOCAL mode, proven on one feature.
- **Deferred (v3):** live `high` executor (after the `glm-5.1` vs `deepseek-v4-pro` A/B), live sniper-on-Ollama, headless/cloud-routine live dispatch, the GPU-time budget guard live. (All already documented in v0.5.0; v3 wires them.)

## 6. Open questions to resolve while implementing
- Skill isolation for the external hand: confirm the minimal `CLAUDE_CONFIG_DIR` vs system-prompt injection in practice (v1 chose injection by default).
- `count_tokens` 404 under the real `claude --bare -p` call pattern (confirm benign end-to-end, not just in `evaluateRun`).
- The exact `--allowedTools` scoping for the hand (no Bash; Read/Write/Edit only; the Stop hook runs tests).
- GPU-time cap behavior on a real medium/low task (monitor; the v0.5.0 guard treats a timeout/non-zero exit as escalation).

---

## 7. Amendments (2026-06-12, post-empirical-probe — operator-approved)

Before implementation, the live path was probed against ollama.com with a real token. The probe
overturned one spec assumption and confirmed the rest. **Decision: Option B (in-process Stop-hook
gate), with §3.1 corrected.** These amendments are authoritative over §3.1/§3.3 where they conflict.

### 7.1 §3.1 CORRECTED — `claude -p` + isolated CLAUDE_CONFIG_DIR (NOT `--bare`)
**Empirical fact (claude 2.1.175):** `--bare` help reads "Minimal mode: skip hooks … and CLAUDE.md
auto-discovery." Probe confirmed: under `--bare` a `Stop` hook **does NOT fire** → the §3.3 / AC v2.3
in-run gate is DEAD under `--bare`. The PoC §5 proved the Stop-hook loop under plain `-p`, and the
auth finding (`--bare` + AUTH_TOKEN) was separate; §3.1 wrongly fused them.
- **Probe results:** plain `claude -p` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://ollama.com`
  **authenticates to Ollama AND fires the Stop hook** (proven). `--bare` = ~3.8k input tokens but no
  hooks; plain `-p` = ~26–47k input tokens (full Claude Code system prompt + tool schemas) but hooks live.
- **Corrected launch:** `claude -p` (NO `--bare`), with an **isolated, ephemeral `CLAUDE_CONFIG_DIR`**
  (a `mkdtemp` dir holding ONLY the Stop-hook `settings.json` — no global `~/.claude` laws, no
  auto-memory), `ANTHROPIC_AUTH_TOKEN` from `.dev.vars` in the **child env only**, `--allowedTools
  "Read,Write,Edit"` (NO Bash — the Stop hook runs the test), `--permission-mode acceptEdits`,
  `--model <hand_tiers[...]>`, `--output-format json`, `--append-system-prompt-file <brief>`, cwd = the
  working tree. The isolated config dir drops the global-laws contamination while keeping hooks alive.
- **Rationale for Option B over an orchestrator re-dispatch loop:** in-process self-correction keeps
  the hand's working memory across the RED→fix cycle; a cold re-spawn loses it. Context-inheritance
  risk is ~zero (today's native subagents inherit CLAUDE.md yet never re-enter the pipeline — the tool
  allowlist bounds them; the hand has no Skill/Task tools).
- **AC v2.3 is RETAINED** (now achievable) — the Stop hook is preserved; only `--bare` was the bug.
- Available Ollama coder models confirmed live: `qwen3-coder-next`, `qwen3-coder:480b`,
  `devstral-small-2:24b`, `gpt-oss:20b`, `glm-4.7`.

### 7.2 Independent-capture hardening (folds in the surviving adversary findings)
- **[high] Untracked files:** `git diff --name-only` does NOT see new files — the common executor
  path. `touchedPaths` = UNION of `git diff --name-only <freeze_commit_sha>` (tracked) +
  `git ls-files --others --exclude-standard` (untracked-in-scope). Without this, a new-file task reads
  as empty-diff NOT_DONE, and a new out-of-scope file escapes checkScope/checkFrozen entirely.
- **[high] Live-channel token redaction:** v1 redaction is proven only on the synthetic
  `buildRunRecord`. Cover the live vectors: per-line `redact()` on ANY live tee of child stdout/stderr
  (before it reaches a console/log); the isolated `CLAUDE_CONFIG_DIR`, the brief/system-prompt file,
  and any cost NDJSON live under an ephemeral temp dir, torn down after capture; `redactDeep` the cost
  stream. Add an AC: `grep -r <token>` over every on-disk artifact returns nothing.
- **[medium] Vacuous green:** `node --test <bad-path>` exits 0 on ZERO collected tests → false DONE.
  Assert the frozen run executed >0 tests (parse the `# tests N` / TAP summary; N==0 → FAILED). Pin
  capture ORDER: snapshot the diff/ls-files baseline BEFORE running the frozen test (the test may write
  fixtures).
- **[medium] Baseline pinned to freeze SHA:** diff against the recorded `freeze_commit` SHA, and assert
  `git status --porcelain` clean (HEAD == freeze_commit) as a precondition before spawning; abort to a
  critical exception if dirty (mirrors SKILL.md step 7's verify-then-stash anchor check).
- **[medium] count_tokens 404 channel + truncation:** under `--output-format json` the benign 404 may
  arrive on stdout/JSON fields, not same-line stderr → `isBenignCountTokens404` must also scan
  stdout/parsed-json error fields, else a benign 404 is mismarked FAILED (inverts AC v2.5). Also
  `truncateUpstreamError` the captured stderr (not only `upstreamErrorBody`) so a large body can't pass
  through untruncated. Confirm the real channel empirically (open question §6).
- **[low] Stop-hook command path:** place hand-config under `skills/` (reaches consumers via
  vendor-core's recursive `skills/` copy — NOT REPO_FILES). The hook command must resolve an ABSOLUTE
  path from the isolated `CLAUDE_CONFIG_DIR`, never `${CLAUDE_PROJECT_DIR}`; add a smoke check it resolves.

### 7.3 Doc alignment
- Update `SKILL.md` Phase 2 (steps 1d, 4) and the `dispatch-hand.mjs` header — both still say
  `claude --bare -p`; correct to `claude -p` + isolated config per §7.1.

### 7.4 De-risk obligation (AC v2.7) — what is NOT yet re-proven this session
The probe confirmed the Stop hook FIRES under `-p`, but did NOT observe a full RED→re-prompt→GREEN
self-correction cycle (the hand passed on attempt 1). The live de-risk task MUST force an initial RED
(a frozen test the hand cannot trivially pass first-try) and confirm the hand iterates to green
in-process, while counting tool-call errors and watching GPU-time/context cost (§3.5, §6).

### 7.5 Engineering constraint (carried from v1)
Keep the process launch THIN and INJECTABLE — the spawn/capture logic is unit-tested with a FAKE spawn
(no real claude/ollama process in the test suite), exactly as v1 kept the pure functions testable. The
live call is exercised only by the operator-gated de-risk demo (§7.4), never by `node --test`.

### 7.6 Scope decision — ALL hands go live (operator override of AC v2.6, 2026-06-12)
The operator widened the slice: **every HAND role routes to the live Ollama spawn now** — there is no
Claude carve-out for any hand tier in this delivery. This **supersedes AC v2.6's** "eyes/sniper/high
stay on Claude" wording.
- **Executor — ALL tiers (low/medium/high)** → live Ollama via the spawn path. The v1 "HIGH → Claude
  (deferred to v3 after the model A/B)" gate is **skipped by operator decision**: executor-high resolves
  to `hand_tiers.high` (a strong Ollama coder, e.g. `qwen3-coder:480b` / `glm-5.1` / `deepseek-v3.1:671b`),
  not Claude.
- **Sniper — ALL severities** → live Ollama via the spawn path (was documented as `hand_tiers` but
  dispatched natively; now live-wired). The **mandatory strong-Claude-eye re-gate on a HIGH sniper fix
  stays** (the v1 rail).
- **Only EYE roles stay on Claude** (orchestrator, planner, plan-reviewer, compliance, adversary,
  security, harvester, shipper). Claude is reachable by a hand **only via the K=1 escalation fallback**.
- **Safety net for executor-high (no prior A/B):** the standard per-task review (compliance + virgin
  opus adversary + deterministic frozen-test gate) + K=1 escalation + the **AC v2.7 de-risk metering**
  (tool-call-error rate, GPU-time, escalation rate). The metering is the instrument that retires the
  cheap high tier WITH DATA if it proves net-negative — it stands in for the skipped A/B.
- **AC v2.6 reframed:** "Eyes stay on Claude; ALL hands (executor + sniper, every tier) route to live
  Ollama; the sniper-high re-gate + the escalation rails still fire as in v1."
- **Operator rationale + revert trigger:** the harness spoon-feeds the hand (a pinned frozen test,
  narrow `scope_paths`, `resolved_judgments` in the brief), so a high-complexity task arrives far more
  constrained than "high complexity" in the abstract — the operator judges the cheap hand can handle it.
  The explicit **revert condition** is data-driven, not a guess: if the AC v2.7 de-risk metering shows
  the cheap high tier is net-negative (escalation rate or tool-call-error rate makes it cost more than it
  saves), fall back to **executor-high → Claude** (the original recommendation). The metering is the
  trigger; "se não der certo, volta" is mechanized by it.
