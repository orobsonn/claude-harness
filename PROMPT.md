# Prompt de continuação — Claude Harness

> Cole este arquivo (ou aponte para ele) ao iniciar uma nova sessão de Claude Code **dentro de `~/Desktop/dev/claude-harness/`**. Ele retoma o trabalho com todo o contexto. Leia primeiro os 3 docs em `docs/` — eles são a fonte da verdade do estudo.

## O que estamos construindo

Um **framework de uso do Claude Code para usuários não-desenvolvedores** (PMs, founders, operadores). O humano decide **produto**; o sistema resolve **engenharia** num loop de agentes. O framework tem **dois modos**: **local** (operador no loop, interativo) e **headless** (cloud routine autônoma, entrega via PR). Detalhes em `docs/design.md`.

Este repo é a **fonte da verdade**: o núcleo distribuível vive em `core/` e é copiado (vendored) para o `.claude/` de cada projeto pela skill de init. Motivo: cloud routines não enxergam o `~/.claude` do operador — só o `.claude/` commitado no repo (`docs/cloud-routines.md`).

## Estado atual (o que já foi feito)

- **Fase A ✅** — 9 defeitos de consistência corrigidos **no `~/.claude`** (origem). Ver `docs/audit.md` tabela "Fase A". Inclui criação de `~/.claude/CLAUDE-HARNESS-MEMORY-MODEL.md`.
- **Baseline ✅** — este repo criado e commitado (`docs/`, README, estrutura). `core/` e `modules/` ainda vazios.
- **Estudo ✅** — `docs/cloud-routines.md` (constraints da nuvem, confirmados na doc oficial), `docs/audit.md` (9 + 40 furos → 8 temas), `docs/design.md` (2 modos + decisões + roadmap). Varredura bruta em `docs/raw/hole-hunt-2026-06-09.json` (gitignored).

## Decisões travadas (não reabrir)

1. **2 modos**: headless é variante autônoma, não substitui o local.
2. **Distribuição**: vendor de `core/` → `.claude/` do projeto via skill de init. (Evolução futura: plugin/marketplace; não agora.)
3. **Memória repo-relative**: `~/.claude/projects/<slug>/memory/` → `.claude/memory/` (commitada pelo shipper). Planner lê de lá.
4. **locked_tests via TDD**: executor autora o arquivo de teste primeiro (red→green), depois congela. O gate passa a ter o que rodar.
5. **Framework genérico, zero PII**: remover só dado pessoal (nome, clientes, paths home, flags de autoridade). O "operador não-dev" é o público-alvo, fica.
6. **RTK e MV = integrações opcionais** (opt-in, documentadas), nunca dependência obrigatória. RTK funciona na nuvem via setup script (`cargo install rtk`) + hook `PreToolUse`. MV via connector/`.mcp.json`.
7. **Headless rules**: nunca `AskUserQuestion`/plan-mode na routine; gates humanos → validação multi-agente; gate humano real = revisão do PR; possivelmente forçar pipeline via `SessionStart` hook (hooks rodam na nuvem — a validar).
8. **Lows cosméticos** (nome do agente "security", tamanho de script de referência) → kaizen, não bloqueiam.

## Roadmap restante

### Fase B — popular `core/` sanitizado (a partir do `~/.claude` já corrigido)
Copiar e sanitizar para `core/`:
- `core/agents/` ← os 9: `adversary, compliance, executor, harvester, plan-reviewer, planner, security, shipper, sniper`.
- `core/skills/` ← core skills: `triaging-requests, orchestrating-delivery, creating-plans (+ references/), recording-findings, distilling-learnings, proposing-improvements, surveying-codebase, committing-changes, releasing-versions, canonical-critical-classes, authoring-rules`. (`initializing-projects` será **reescrita** na Fase C — não copiar a versão velha.)
- `core/rules/` ← universais: `code-quality, git, security, observability, releases, testing-unit, testing-e2e`.
- `core/CLAUDE-HARNESS-MEMORY-MODEL.md` ← copiar de `~/.claude/`.
- `core/CLAUDE.md` ← **reescrever do zero**: entry-policy + convenções genéricas (extrair de `~/.claude/CLAUDE.md` a parte de política/convenção; **sem** `@RTK.md`, sem perfil pessoal, sem manutenção de `~/.claude`). Documentar os 2 modos e o gatilho da pipeline.
- `core/settings.json` ← **criar do zero**: allowlist mínima de permissões. **Sem** `skipDangerousModePermissionPrompt`/`skipAutoPermissionPrompt`, sem hooks com path de home, sem `env`/`mcpServers` pessoais.
- `core/memory/MEMORY.md` ← stub vazio (template da memória repo-relative).
- Sanitizar varreduras de PII: `grep -ri` por nome próprio, clientes, `/Users/`, `Oráculo`, `RTK` hardcoded em agentes.

### Fase A.2 — corrigir os 40 furos NO `core/` (não no `~/.claude`)
Trabalhar pelos 8 temas de `docs/audit.md` + detalhe/fix de cada furo em `docs/raw/hole-hunt-2026-06-09.json`:
- ② memória repo-relative (`.claude/memory/`) — reapontar distilling-learnings, harvester, surveying-codebase, planner, orchestrating-delivery Phase 0; shipper inclui `.claude/memory/` no commit.
- ③ locked_tests TDD — reescrever executor (autora teste), compliance (verifica teste existe+green+fiel), creating-plans (locked_test carrega path do arquivo + validador exige), orchestrating Phase 2 (passo de materializar teste antes do gate).
- ④ Skill tool — adicionar `Skill` ao `tools` de planner/executor/harvester (e MCP onde usado, ou remover a instrução).
- ⑤ refs pessoais — limpar (já tratado em grande parte na Fase B).
- ⑥ paths skill-relativos — `node references/validate-plan.mjs` → path resolvido.
- ⑦ contratos internos — findings.md produtor único; remover quota 3-5 do adversary; campo severity em compliance/gate findings; reescrever plan.mode no override; plan-reviewer no model_strategy; complexity opcional vs mandatório; ordering em security.md; etc.

### Fase A.3 — implementar o modo headless
Adicionar a variante autônoma em `orchestrating-delivery`, `triaging-requests`, e na entry-policy `core/CLAUDE.md`. Tabela de comportamento em `docs/design.md`. Gates → validação multi-agente; entrega → PR draft.

### Fase C — reescrever `initializing-projects`
Nova versão puxa de `core/` (deste repo) → `.claude/` do projeto. Grava `.claude/.harness-version`. Merge idempotente do `CLAUDE.md` por marcador. Escreve `settings.json` mínimo. Corrige os refs stale (`@reviewer`/`@docs`/`init-project`).

### Fase D — teste de ponta a ponta
Aplicar o framework num projeto de teste, commitar o `.claude/`, criar uma routine na nuvem (prompt em modo autônomo) e validar: a pipeline dispara? memória persiste no PR? hooks/RTK funcionam? Ajustar conforme o real.

## Como começar a próxima sessão
1. `cd ~/Desktop/dev/claude-harness`
2. Ler `docs/design.md`, `docs/cloud-routines.md`, `docs/audit.md`.
3. Executar a **Fase B**. Fonte dos artefatos: `~/.claude/agents`, `~/.claude/skills`, `~/.claude/rules` (já com as 9 correções da Fase A).
4. Commitar por fase (Conventional Commits, sem `Co-Authored-By`). Branch + commit; main deste repo ainda sem remote.
