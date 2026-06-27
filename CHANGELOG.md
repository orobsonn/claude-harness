# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.14.1] - 2026-06-27

### Fixed

- **entry-gate: falso "zero commits ahead of base" bloqueava delivery legítimo**: `defaultGitState()` resolvia a base do cálculo de "commits à frente" como o upstream do próprio feature branch (`@{u}`). Após `git push`, o upstream aponta para o mesmo commit que `HEAD`, zerando `@{u}..HEAD` e produzindo um deny falso que travava `git push` / `gh pr create` mesmo com commits reais à frente da main. A base passa a ser sempre o default branch do origin (`origin/HEAD` → `origin/main` → `origin/master`), contada via `rev-list --count <base>..HEAD`; nunca mais `@{u}`. Contrato fail-open preservado (base não-resolvível → `commitsAhead` null → nunca barra). Lógica de resolução extraída para `computeGitState(git)` puro/exportado e coberta por locked tests (AC-CORE: `upstream==HEAD` mas ahead-of-default > 0 → permite).

### Removed

## [0.14.0] - 2026-06-27

### Added

- **CI por projeto + gate de CI verde antes do release**: geração de `.github/workflows/ci.yml` com detecção de stack (node-test/vitest/jest); helper de branch protection (GET-then-merge, `enforce_admins=false`, sem review, required check = nome do job gerado) aplicado de forma operator-gated (`--apply`) para exigir o job de CI como check obrigatório; gate no fluxo de release que recusa tag enquanto CI estiver vermelho ou pendente (`gh pr checks --json state`). Modelo de 2 jobs fork-safe (job obrigatório sem secret + job de secret que pula em fork/Dependabot). Regra global aditiva (mandatory para projetos novos, advisory para existentes). Dogfooded no próprio harness com workflow real (CI verde no PR).

### Changed

### Fixed

### Removed

## [0.13.0] - 2026-06-26

### Added

- **Trilho de fidelidade (fidelity rail)**: o executor (mão barata) só é despachado depois que existe um teste escrito pela mão-de-teste e validado pelo compliance — congelado. Vale no modo local (spawn-hand) e na nuvem (headless). Fecha o furo em que a mão barata escrevia o próprio gate.
- **brief-serializer**: o briefing do executor passa a ser montado deterministicamente a partir da fatia do plano (spec, decisões, escopo, critérios, asserções) + fatos validados de tarefas anteriores — sem o orquestrador escrever código ou teste à mão.
- **descriptor-emitter**: a "ordem de serviço" da mão barata e o SHA do freeze são emitidos automaticamente no freeze-commit, eliminando a tentativa-e-erro de montar o descriptor na mão.
- **Marcador `fidelity-pass`**: sinal em disco que o gate consome para liberar o executor após o teste congelado passar pela validação de fidelidade.

### Changed

- **Princípio de relay no orquestrador**: a regra "o orquestrador não gera nada" foi substituída pela regra real e estreita — ele não autora código nem teste, apenas repassa a fatia do plano já validada por olhos/mãos mais fortes. O teste congelado é o oráculo concreto.

### Fixed

### Removed

## [0.12.0] - 2026-06-26

### Added

### Changed

- **hand_tiers com modelos Ollama reais**: a escada de exemplo da `creating-plans` passa a `qwen3-coder-next` (low) / `glm-5.2` (medium) / `kimi-k2.7-code` (high) — modelos que existem no endpoint Ollama. A skill agora exige que os ids do `hand_tiers` existam no endpoint (como listar) e avisa pra evitar `gpt-oss:*` (tool-use quebra em loop agêntico).

### Fixed

- **plano no formato legacy (Claude tiers) passava silenciosamente e quebrava no dispatch (404)**: a validação que rejeita o `model_strategy.tiers` legacy não era determinística (dependia do planner rodar `validate-plan`). Agora há cancela em duas camadas: (1) guard no `spawn-hand` — um model que é alias Claude (haiku/sonnet/opus) indo pro Ollama falha com razão clara em vez de 404 críptico; (2) o `plan-write-gate` valida o `model_strategy` no Write do plano e rejeita o shape legacy/sem `hand_tiers` antes de virar arquivo.
- **mão barata acusada de scope violation por arquivos untracked pré-existentes**: o `capture-hand` atribuía ao hand lixo de build pré-existente (dist/, coverage/, *.tsbuildinfo gitignored) que o clean-check (`git status --porcelain`) não enxerga mas o sweep `ls-files --others` enxerga. Agora um snapshot pré-spawn (path+hash) desconta os untracked pré-existentes **inalterados**; um arquivo novo ou um pré-existente **editado** (tamper) segue sinalizado — o controle de segurança fica intacto.
- **planner.md instruía salvar o plano como `plan.json`**, nome que o orquestrador/gate/reinject não leem (todos usam `execution-plan.json`). Reconciliado.

### Removed

## [0.11.0] - 2026-06-26

### Added

### Changed

- **cheap hands é LOCAL-only / HEADLESS roda hands em Claude**: em modo headless (`$CLAUDE_CODE_REMOTE` setado) o orquestrador não invoca o `spawn-hand.mjs`; despacha executor/sniper/test-author como `Agent` Claude normal, e o entry-gate passa a permitir Agent de role HAND nesse modo. Token Ollama ausente no cloud deixa de ser `hand-config-error` (vira não-evento). SKILL.md atualizado.
- **cheap hands (resolução de token)**: a fonte de token local passa a ser a env var `OLLAMA_HAND_TOKEN` (`export` no shell rc). Leituras de env sobrevivem ao command-sandbox; um token só no `.dev.vars` **não** é lido (o sandbox nega leitura de `.dev.vars`). O nome é inerte à auth do próprio Claude Code — `ANTHROPIC_AUTH_TOKEN` sequestraria a sessão-pai. `resolveAuthToken` aceita `OLLAMA_HAND_TOKEN` (preferencial) e `ANTHROPIC_AUTH_TOKEN` (compat/headless); `.dev.vars` segue como fallback; o childEnv mapeia pra `ANTHROPIC_AUTH_TOKEN`. SKILL.md atualizado.
- **entry-gate**: a mensagem de bloqueio de role HAND agora instrui o orquestrador a rodar `spawn-hand.mjs --descriptor` pra obter a `reason` exata do config-error (exit 2) e proíbe explicitamente inventar causa — em especial concluir que "spawn-hand.mjs não existe" (o script é vendored; o que falta quase sempre é o token). Aponta o fix (`export OLLAMA_HAND_TOKEN`).

### Fixed

- **mão barata nunca rodava sob o command-sandbox**: o `spawn-hand` despachado pelo orquestrador roda sob o sandbox, cujo `denyRead: ["**/.dev.vars"]` bloqueava o `resolveAuthToken` de ler o token → exit 2 "no ANTHROPIC_AUTH_TOKEN resolved" → caía em implementação inline silenciosa com mensagem enganosa, mesmo com o token presente no disco. Resolvido movendo a fonte do token pra env (`OLLAMA_HAND_TOKEN`), que o sandbox não bloqueia. Validado end-to-end (sob sandbox: `.dev.vars` falha, env passa).

### Removed

## [0.10.0] - 2026-06-26

### Added

- `triaging-requests`: QUICK ganha a porta `craft` — via rápida para artefatos visuais auto-contidos (página/quiz/landing/componente) roteados ao skill artesanal, pulando o pipeline pesado (executor→compliance→adversary→sniper). Mantém os trilhos determinísticos: glob da lista sensível nos arquivos tocados (substitui o override de `scope_paths`, ausente sem planner) + gates `tsc`/lint/build antes do commit. Override é **só-escala** ("caprichada/revisada" sobe pra LIGHT; "rápido" nunca rebaixa pedido sensível). Captura de lead no padrão do skill é pré-vetada; endpoint/integração nova escala pra LIGHT.

### Changed

### Fixed

### Removed

## [0.9.2] - 2026-06-17

### Added

### Changed

- Resolução de auth da mão barata é responsabilidade exclusiva do `spawn-hand.mjs` (env → projeto `.dev.vars` → global `~/.claude/.dev.vars`). O orquestrador não pré-checa nem inspeciona `.dev.vars`, e o token Ollama passa a ser tratado como precondição de setup (global no local, env secret no HEADLESS) — não algo a descobrir por task.
- Qualquer `exit 2` do `spawn-hand.mjs` vira exceção crítica citando o `reason` verbatim; o orquestrador não classifica a causa.

### Fixed

- `planner.md` dizia que o executor escreve o arquivo de teste (desatualizado no v2). Agora reflete que o `test-author` transcreve o teste e o executor o recebe read-only — eliminando a confusão de dispatch que levava o modelo a tentar `Agent` para criar testes.
- Falha de gate (captura via `capture-hand.mjs`) nunca é dispensada como "ambiental/sandbox" pela mensagem de erro — sempre escala. Fecha o falso-negativo em que uma falha real seria silenciada por um stack-trace que mencionasse `.dev.vars`.

### Removed

## [0.9.1] - 2026-06-15

### Added
- **Nova rule `architecture`** (carrega quando há código em `src/`, `app/` ou `worker/`): guia de fronteira de domínio que o harness não cobria — handler fino, tradução na borda (Anticorruption Layer, ex. integrações Stays/Meta), isolamento de shape (tipo de domínio ≠ linha de banco ≠ payload de terceiro), value object no lugar de obsessão primitiva, e lógica-junto-do-dado (sem modelo anêmico). Modelagem rica é condicional — o default é flat. Auto-carrega nativamente até na mão Ollama barata (`claude -p`).

### Changed
- **`plan-reviewer` audita fronteira de domínio e modelagem no tempo de plano** (keyed por severidade): a tradução de formato externo está isolada num task de borda ou vaza shape de terceiro pro core? Um task de alta severidade com invariante multi-passo está modelado rico ou espalhado num service anêmico? Numa feature flat, há camada especulativa sem core que a justifique?
- **Doc do `executor` corrigida:** descrevia o modo `--bare` aposentado. A mão barata roda como `claude -p` no cwd do projeto, então `CLAUDE.md` e rules do projeto **auto-carregam** nativamente — só skills (sem tool `Skill`) e o config global `~/.claude` (`CLAUDE_CONFIG_DIR` efêmero) não chegam.

## [0.9.0] - 2026-06-14

### Added
- **A mão Ollama barata agora dispara de verdade (wiring do live spawn — Part A).** Novo `runLiveDispatch(descriptor, {…})` em `spawn-hand.mjs` é a costura que faltava entre o andaime e o dispatch real: valida o descriptor, fail-close se o token vazar no descriptor/brief, reconcilia os dois universos git (árvore limpa + HEAD ancorado ao freeze, pra captura unscoped atribuir só o trabalho da mão), sobe `claude -p` ao vivo contra `https://ollama.com` (token só no env, `CLAUDE_CONFIG_DIR` efêmero), roda a captura INDEPENDENTE e grava um run-record sem token keyed por `feature_id/task_id`. Um CLI rodável (`node spawn-hand.mjs --descriptor <descriptor.json>`) + o comando exato e a receita do descriptor no `SKILL.md` (passos 1d/5) substituem o roteamento só-em-prosa que era a causa do bug never-fire (sessão `7fcc1009` do victor: 0 `claude -p`, 15 `escalation-fallback`). **Provado ao vivo:** a mão (`qwen3-coder-next`) autorou o diff in-scope e o teste congelado ficou verde na captura independente (`outcome DONE`).
- **Marker `hand-config-error`** (`mark.mjs` + `stamp-triage.mjs`, com `--reason` opcional) pro orchestrator carimbar um erro de config pré-spawn na rota de exceção crítica. Nunca autoriza uma mão Claude.

### Changed
- **O escape da mão barata agora se apoia em evidência on-disk não-forjável (Part B).** O branch de hand-routing do entry-gate antes liberava um `Agent(executor|sniper|test-author)` Claude no main-loop sempre que QUALQUER ticket `escalation_fallback` não-vazio existisse (forjável por echo). Agora libera o fallback Claude SÓ quando um ticket mapeia para um run-record on-disk (escrito pela captura independente do `runLiveDispatch`) cujo `outcome` é uma run genuína não-DONE (`FAILED` ou `NOT_DONE`), ancorado ao `freeze_commit_sha` e cruzado com o `HEAD` corrente — um record estale não autoriza uma escalação posterior que não falhou.
- **Escape de config-error explícito (contrato de exit-code).** `runLiveDispatch` RETORNA só em run genuína (record gravado) e LANÇA caso contrário, então o CLI classifica: `0` = DONE, `1` = `FAILED`/`NOT_DONE` genuíno (escalação K=1, autorizada pelo record on-disk), `2` = erro de config pré-spawn / exceção crítica (emite `{configError:true}`). O orchestrator roteia exit `2` pra exceção crítica — nunca um fallback Claude calado, nunca trava. Impede que token ausente trave a entrega.

### Fixed
- **Crash latente em `capture-hand.mjs`:** o CLI usava `readFileSync` sem importá-lo de `node:fs` — teria lançado `ReferenceError` no instante em que a captura ao vivo rodasse pelo CLI.

## [0.8.0] - 2026-06-14

### Added

### Changed
- **BREAKING: `hand_tiers` is now the only valid `model_strategy` shape.** The planner emits `hand_tiers` exclusively (cravado ladder `glm-5.1` → `deepseek-v4-pro` → `kimi-k2.7-code`), and `validate-plan` requires it. Previously the legacy Claude-only `tiers` shape was still accepted (validate-plan only warned), which let the executor/sniper silently resolve to expensive Claude and defeated the cheap-hands default — the root cause of plans that never routed hands to Ollama. A Claude hand is still reachable for a sensitive task by putting a Claude alias directly in a `hand_tiers` tier (values are free-form model ids; eyes still must be Claude aliases).

### Fixed
- **`settings.test.mjs` hook-count assertion was stale.** It expected exactly 5 wired hooks, but the `Write|Edit → plan-write-gate.mjs` PreToolUse hook added in the deterministic-rails work (#21) made the real count 6. The test now asserts 6 (it had been failing since #21).

### Removed
- **Legacy Claude-only `tiers` `model_strategy` shape.** `validate-plan` now hard-rejects a plan carrying `tiers` (clear error pointing to `hand_tiers`); `tiers` is dropped from `ALLOWED_MS_KEYS` and the back-compat prose is removed from `creating-plans`/`planner`/memory. Old archived plans authored with `tiers` no longer validate — they are historical artifacts and are not re-validated.

## [0.7.1] - 2026-06-14

### Added
- **Branch/commit delivery rail.** The push-gate (`entry-gate` `decideBash`) now denies a delivery command (`git push` / `gh pr create` / `gh pr merge`) when `HEAD` is on `main`/`master`, or (when a base ref resolves) when there are zero commits ahead of base — forcing the per-task commit series onto a feature branch, off protected `main`. The git probe is injected at the `processInput` (production) layer with a `decide()`-level no-op default, so it's live in the CLI but inert for unit callers; fail-open on any git error or unresolvable base. Closes the "uncommitted work / everything on main, yet still trying to deliver" gap — the rest of the per-task discipline (the freeze/impl split) is already load-bearing via the capture rail.

## [0.7.0] - 2026-06-14

### Added
- **Deterministic delivery rails — pipeline steps that were prose are now state-machine checks.** Four points where the orchestrator could silently skip a pipeline step ("the orchestrator must remember to…") became deterministic gates over `gate-state.json`, the same pattern already used for triage/planner/shipper:
  - **Plan-authorship rail** (`hooks/plan-write-gate.mjs`, new `PreToolUse(Write|Edit)` hook): only the dispatched `planner` subagent may write/edit a feature's `execution-plan.json`; the main-loop orchestrator is denied. Also blocks any tool write to `.claude/plans/.state/*.json` (gate-state/triage are hook-owned).
  - **Ollama hands as default**: `validate-plan` now warns (never rejects) on legacy Claude-only `tiers`, and `creating-plans`/`planner` emit the split `hand_tiers` ladder by default (`glm-5.1` → `deepseek-v4-pro` → `kimi-2.7`).
  - **Hand-routing rail** (`entry-gate.mjs`): a main-loop `Agent(executor|sniper|test-author)` is denied unless an `escalation_fallback` ticket exists — hands must route through `spawn-hand` (Ollama); the Claude `Agent` path is only the K=1 escalation/transcription fallback. New `mark.mjs escalation-fallback` marker stamps the ticket.
  - **Independent-capture rail** (`entry-gate.mjs` delivery-bash-gate): a delivery command is denied while any `hand_finished` task lacks a matching `capture_verified`. New `mark.mjs hand-finished`/`capture-verified` markers, routed through `stamp-triage` so Claude Code supplies the one authoritative `session_id` to producer and consumer.

### Changed
- **`test-author` reconciled as the third Ollama hand** (alongside `executor`/`sniper`): the agent doc and the "Hands vs Eyes" taxonomy now describe a spawn-hand (Ollama) hand resolving from `hand_tiers`, and the hand-routing rail gates it like the other hands.

### Fixed
- `resetGateState` now preserves `hand_finished`/`capture_verified` across a re-triage — the capture rail is a session-level delivery obligation like the re-gate rail, so a mid-session reclassify can no longer launder an un-captured hand.
- `plan-write-gate` path matching is case-insensitive (the operator's darwin FS is case-insensitive), closing an `Execution-Plan.json` / `.Claude/` bypass.

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
