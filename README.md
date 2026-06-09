# Claude Harness

Um framework de uso do **Claude Code** para usuários **não desenvolvedores** (product managers, founders, operadores) que querem entregar software com uma pipeline de qualidade — sem precisar julgar arquitetura, segurança ou tradeoffs de baixo nível.

A ideia central: o humano toma **decisões de produto** (o que construir, aceitar/recusar risco); o sistema resolve a **engenharia** (como construir, testar, revisar) dentro de um loop de agentes especializados.

## Dois modos de execução

| | **Local** (interativo) | **Headless** (routine na nuvem) |
|---|---|---|
| Quem está no loop | o operador, em tempo real | ninguém — roda sozinho |
| Decisões humanas | gates ao vivo (aprovar spec/plano/demo) | simuladas por agentes; o gate real é a **revisão do PR** |
| Entrega | merge com OK do operador | abre **PR draft** pra revisão assíncrona |
| Onde roda | máquina do operador (`~/.claude`) | Claude Code cloud routine, lendo o `.claude/` commitado no repo |

O modo headless **não substitui** o local — é uma variante autônoma da mesma pipeline, ativada pela instrução no prompt da routine.

## Por que este repo existe

O harness vivia só na máquina do operador (`~/.claude`). Cloud routines **não enxergam** `~/.claude` — só o `.claude/` commitado no repo-alvo. Este repo é a **fonte da verdade** do framework: o núcleo distribuível é versionado aqui e copiado (vendored) para o `.claude/` de cada projeto pela skill de inicialização. Preparado para evoluir para um plugin/marketplace quando fizer sentido.

## Estrutura

```
core/        # o núcleo distribuível → vai pro .claude/ do projeto
  agents/    # agentes de delivery (planner, executor, compliance, …)
  skills/    # skills core da pipeline
  rules/     # rules universais
  CLAUDE.md  # entry-policy genérica (zero dado pessoal)
  settings.json   # permissões mínimas, sem flags perigosas
  memory/    # memória repo-relative (substitui ~/.claude/projects/…)
modules/     # módulos por stack (worker, react-vite, …)
docs/        # o estudo: constraints da nuvem, auditoria, desenho
VERSION
```

## Como usar

Ver **`docs/usage.md`** — instalar/atualizar o harness num projeto (`vendor-core`), o padrão de issues (`harness-ready`), e como configurar a routine no Claude Code.

## Status

Em construção. Ver `docs/` para o estudo completo e `docs/audit.md` para o estado das correções.
