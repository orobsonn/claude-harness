# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

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
