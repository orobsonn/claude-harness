# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.6.2] - 2026-06-13

### Fixed
- **Path-coverage convention unified on git-pathspec (`isPathCovered`).** The pre-spawn baseline guard scopes via `git status --porcelain -- <entry>` (git pathspec = directory prefix by path component), but `isPathCovered`/`checkScope` treated an entry WITHOUT a trailing slash as an **exact file match**. For a no-slash directory entry (e.g. `core/x`) the two diverged — the guard covered files under it by prefix while the capture scope check demanded an exact match — yielding a dispatch that **always** failed in capture (fail-closed, but a confusing latent trap). `isPathCovered` now normalizes every entry to git-pathspec component semantics (`path === base || path.startsWith(base + "/")`), so a directory entry covers identically **with or without** the trailing slash — one source of truth shared by the guard, `checkScope`, `checkAllowedWrites`, and `checkFrozen`. The path-component boundary keeps `core/x` from bleeding into a sibling `core/xyz`, matching git. Out-of-contract pathspec MAGIC (`.`, glob `*`, empty entry) is explicitly **not** honored and fails closed in the violation checks. Adds `locked_test #7` proving consistent coverage of a no-slash directory entry and the fail-closed empty-entry behavior. (#17)

## [0.6.1] - 2026-06-13

### Added
- **Global Ollama token resolution.** A new `resolveAuthToken` resolves the cheap-hand auth token across `env.ANTHROPIC_AUTH_TOKEN` → `<cwd>/.dev.vars` → `~/.claude/.dev.vars` (global), so the operator sets the token **once** in `~/.claude/.dev.vars` and every project's cheap hand finds it — without exporting `ANTHROPIC_AUTH_TOKEN` into the shell (which would hijack Claude Code's own subscription auth). The token is still read-only from disk and injected only into the child process env. Aligns all three readers (dispatch/spawn/capture) on the same resolver.

### Changed

### Fixed

### Removed

## [0.6.0] - 2026-06-13

### Added
- **"Strong eyes, cheap hands" v2 — live Ollama dispatch (the plug is now wired).** v1 shipped the brain + rails; v2 launches the cheap hand for real and proves it end-to-end against ollama.com. Ships:
  - `spawn-hand.mjs` — the live spawn: `claude -p` (NOT `--bare`) against `ANTHROPIC_BASE_URL=https://ollama.com` with the auth token in the **child env only** (never argv/brief/settings), an **isolated ephemeral `CLAUDE_CONFIG_DIR`** seeded from the Stop-hook template, and the brief delivered to the hand via **stdin** (the user prompt). Fail-closed before spawn: refuses without an armed gate (locked_test must exist, be a file, and a dry-run must collect ≥1 test), without a resolved token, or onto a scope-dirty baseline.
  - `capture-hand.mjs` — the **independent capture (gate of record)**: the harness — never the model's prose — builds the child result from `git diff --name-only <freeze_sha>` ∪ `git ls-files --others` (+ a no-exclude sweep so a gitignored write can't escape scope/frozen/allowed-write), an **independent** `node --test` run with a vacuous-green guard (last anchored `# tests N`; 0/missing → FAILED), a `HEAD == freeze_sha` precondition, a required token (redaction is never a silent no-op), and live-tee + on-disk redaction. Feeds the v1 fail-closed `evaluateRun`.
  - `hand-config/` — the Stop-hook `CLAUDE_CONFIG_DIR` template + a pure `resolveHookCommand` (absolute `node --test <path>`, never `${CLAUDE_PROJECT_DIR}`); reaches consumers via vendor-core's recursive `skills/` copy (pinned by an exported `isFrameworkCopyIncluded` predicate).
  - `derisk-metrics.mjs` — pure cost-NDJSON parser (`toolCallErrorCount`, `gpuTimeMs`, `contextTokens`) — the data-driven signal to retire a net-negative cheap tier.
  - `dispatch-hand.mjs` hardened: a benign Ollama `count_tokens` 404 is forgiven across the stdout/json channels while a co-occurring real upstream error (5xx/401/403/429) is never swallowed; captured stdout/stderr are truncated (redact before truncate).
  - **Live-proven (AC v2.1):** a `qwen3-coder-next` hand implemented a real task, landed a correct diff that passed its frozen test with scope respected, and the independent capture stamped `captured:true` → DONE.

### Changed
- `orchestrating-delivery` Phase 2 wiring: **all hand roles route to the live Ollama spawn** — executor (low/medium/**high**) and sniper (all severities) — with only eye roles staying on Claude; Claude is reachable by a hand only via the K=1 escalation fallback. Executor-high resolves to `hand_tiers.high`, with the AC v2.7 de-risk metering as the data-driven revert trigger (supersedes the deferred v3 model A/B by operator decision). The sniper-HIGH mandatory strong-eye re-gate + `regate-pending`/`regate-passed` rails are unchanged. The spec's `--bare` is corrected to `claude -p` + isolated config everywhere (`--bare` skips hooks, which would kill the Stop-hook gate).
- **Model routing:** Fable 5 retired — the two boundary gates (plan-reviewer, final-gate adversary) fall back to opus; `fable` removed from the validator's `CLAUDE_ALIASES`.

### Fixed

### Removed

## [0.5.0] - 2026-06-12

### Added
- **"Strong eyes, cheap hands" v1 — scaffold, rails, gates, and docs.** Code-writing roles (executor, sniper, new `test-author` agent) can be routed to cheap Ollama-cloud models via `claude --bare -p` external dispatch, while judging/review roles stay on Claude. Ships:
  - `model_strategy` split: validator gains `hand_tiers` (Ollama model ids keyed to low/medium/high) vs eye roles (always Claude); back-compat with legacy single-`tiers` plans; unknown keys rejected; eye→Ollama enforced + table-driven test covering all 7 eye roles.
  - `dispatch-hand.mjs` — external-process runner (pure functions + CLI): token redaction, per-dispatch allowed-write set, scope-check (truth = git diff + `captured:true` flag, never model prose), fail-closed on missing capture, frozen-manifest violation = automatic gate failure, upstream errors truncated to 500 chars after redaction.
  - Deterministic test rail: planner pins concrete-observable assertion → `test-author` (cheap hand, tools exactly `[Read, Write]`) transcribes ONE assertion into ONE test file → compliance (Claude eye) validates fidelity pre-freeze → content-hash manifest frozen → executor implements against read-only frozen test → Stop hook gates on green (documented v2 artifact; v1 ships the contract and rail).
  - Sniper → cheap Ollama hand + mandatory strong-eye (Claude) re-gate rail: `mark.mjs` markers → `stamp-triage` persists `regate_pending` → entry-gate blocks both the shipper Agent dispatch and direct Bash delivery while a re-gate is outstanding; survives compaction.
  - Executor escalation: re-dispatches the executor (never sniper), stash-discard the failed attempt; per-task commit series (freeze-commit → impl-commit) makes reset trivially safe.
  - `core/dev.vars.example` placeholder added; `vendor-core` REPO_FILES distributes `.dev.vars.example` to consumer projects; `.dev.vars` gitignored at repo root and ensured-ignored in consumer projects via `ensureDevVarsIgnored`.
  - Migration/SQL rule in `creating-plans/SKILL.md`: locked_test on a cheap hand must spin an ephemeral DB and assert post-migration state — not a text-match.
  - Design decisions (no git worktree in v1; working-tree + per-dispatch allowlist as the containment boundary) documented in `core/CLAUDE.md` compact instructions.
  - **v2 next step:** live `claude --bare -p` spawn integration and the Stop-hook binary are the documented v2 deliverables; v1 ships the contract, rails, scaffold, gates, and docs.

### Changed

### Fixed

### Removed

## [0.4.1] - 2026-06-11

### Added
- **Skill `updating-harness`** — atalho de uma chamada para instalar/atualizar o harness no projeto atual, com a URL do repo-fonte embutida (sem copiar/colar URL). Detecta install-vs-update, fixa na última release do GitHub (`--ref <tag>`), reporta o que mudou e re-vendora via `vendor-core` sem clobberar memória/kaizen/settings.

## [0.4.0] - 2026-06-11

### Added
- **Medidor de custo na entrega** — skill `measuring-cost` (invocada pelo harvester) reporta o custo equivalente-API da sessão com breakdown por modelo + a tendência semanal de consumo do Claude Code (todos os projetos), via `ccusage` sobre o transcript JSONL local. Fail-soft quando ccusage não está acessível (offline / cloud headless). Não persiste números em arquivos commitados — é telemetria de run, não conhecimento durável; o medidor semanal é proxy relativo de consumo real, nunca % da subscription (opaca).

## [0.3.0] - 2026-06-11

### Changed
- **Estado efêmero de sessão movido para `.claude/plans/.state/<session_id>/`** — `gate-state.json` e `triage.json` saem da raiz de `plans/` para uma subpasta pontilhada, deixando a listagem de `.claude/plans/` com apenas as pastas legíveis por feature (`<feature_id>/`). O plano durável continua keyed por `feature_id` na raiz, preservando a resiliência (artefato insubstituível atrás de chave re-derivável, não do `session_id` opaco). O GC do `reinject-state` passa a escanear só `.state/`.
- **Orquestrador Sonnet cravado como default** — removida a marcação "under validation" da tabela de model routing; documentado em `docs/usage.md`. A economia do harness vem do orquestrador barato no alto volume; premium (Opus/Fable) só nos sub-agentes de fronteira, sustentado por trilhos determinísticos.

### Fixed
- **Orquestrador atalhava `creating-plans` em vez de dispatchar o `planner`** — com Sonnet no main loop, a skill interna do agente planner (sempre Opus) era invocada direto, gerando o plano no orquestrador e perdendo o isolamento de contexto e o routing de modelo. Guard `<PLANNER-ONLY>` no topo do `SKILL.md` + `description` marcada INTERNAL forçam o dispatch do agente `planner`.

## [0.2.1] - 2026-06-11

### Fixed
- **Gate silenciosamente inerte em path com espaço/symlink** — o guard de CLI dos hooks comparava `import.meta.url` (URL-encoded, símlinks resolvidos) com `file://${argv[1]}` (cru); num projeto cujo caminho tem espaço (`/Users/x/My Project`) ou está atrás de symlink, `main()` não rodava e o hook liberava tudo (falsa sensação de proteção). Agora usa `fileURLToPath` + `realpathSync`. Coberto por teste de integração que executa o hook como CLI real.
- `triage.json` passa a usar tmp-path com sufixo de pid na escrita atômica (consistência com o `gate-lib`, evita colisão concorrente).

## [0.2.0] - 2026-06-11

### Added
- **Trava determinística de entrada (entry-gate)** — interlock de runtime via hooks do Claude Code que força a cerimônia do harness (triagem → brainstorm → spec-adversary → plano) mesmo com um orquestrador Sonnet mais fraco no comando. Componentes em `core/hooks/`:
  - `entry-gate.mjs` (PreToolUse `Agent`): bloqueia dispatch de papéis de entrega sem `triage.json`; bloqueia o `planner` sem `brainstormed` + `adversary_fired`. Fail-open em erro de infra; só age no main-loop (ignora chamadas com `agent_id`).
  - `stamp-triage.mjs` (PostToolUse `Bash`): carimba `triage.json` com `session_id` autoritativo do payload e registra `brainstormed`; reconhece os marcadores `classify.mjs`/`mark.mjs` (desembrulha `tool_output.stdout`).
  - `classify.mjs` / `mark.mjs`: CLIs de marcador que o modelo roda ao fim da triagem / do brainstorm.
  - `reinject-state.mjs` (SessionStart `compact`/`startup`): re-injeta o estado do plano após compactação (recuperabilidade pro Sonnet) e faz GC conservador de dirs de estado obsoletos.
  - `lib/gate-lib.mjs`: validadores compartilhados (`isSafeFeatureId`, `isSafeSessionId`, `isDeliveryRole`, `bareRole`) + I/O atômico de `gate-state.json` (read-merge-write temp→rename).
- Seção `# Compact instructions` em `core/CLAUDE.md` (compactação harness-aware).
- Hooks vendorados pra projetos adotantes (`vendor-core.mjs` passa a copiar `core/hooks/`, excluindo `*.test.mjs`).
- Baseline de release: `CHANGELOG.md`.

### Changed
- `complexity-scorer.mjs`: recalibrado com a lógica otimizada do harness OpenCode (await-only, sem else/case, dirs ancorados, caps de import/serviço, `LINES_PER_POINT` 50), preservando o contrato de 4 bandas (low/medium/high/x-high) do Claude Code.
- `orchestrating-delivery/SKILL.md`: spec-adversary agora é **obrigatório em ambos LIGHT e FULL** (antes o FULL adiava pro per-task); Phase 0 termina com o marcador `brainstorm-done`.
- `triaging-requests/SKILL.md`: passo final roda `classify.mjs` (carimba o `triage.json`) antes do dispatch de entrega.

## [0.1.0] - 2026-06-10

### Added
- Marco inicial do Claude Harness (entry policy, agents, skills, rules, modelo de memória, model routing barbell).

[Unreleased]: https://github.com/orobsonn/claude-harness/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/orobsonn/claude-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/orobsonn/claude-harness/releases/tag/v0.1.0
