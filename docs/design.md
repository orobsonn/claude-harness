# Desenho — dois modos e as decisões

## A pipeline e seus dois modos

A pipeline é a mesma; o que muda é **quem ocupa os pontos de decisão humana**.

| Ponto | Modo LOCAL (operador no loop) | Modo HEADLESS (routine) |
|---|---|---|
| Entrada | `triaging-requests` + veto do operador (1 frase) | classifica sozinho, sem veto |
| Brainstorm / spec | operador explora junto (`superpowers:brainstorming`) | **workflow/subagentes simulam** a exploração + adversary ataca a spec |
| Aprovar spec | HARD-GATE humano | validação multi-agente, segue |
| Aprovar plano | HARD-GATE humano | `plan-reviewer` + validação, segue |
| Demo | operador testa o output | auto-gera e auto-valida contra os ACs |
| Critical exception | pergunta ao operador (produto) | registra no PR como risco aberto; não bloqueia |
| Entrega | merge com OK do operador | **abre PR draft, nunca faz merge** |

### Regras de ouro do modo headless
1. **Nunca** usar `AskUserQuestion` nem plan-mode (comportamento indefinido na nuvem).
2. Gates humanos viram **validação por agentes** — nunca "auto-aprovar cegamente".
3. O **gate humano real** é a revisão do PR (assíncrono, no GitHub).
4. Ativado pela **instrução no prompt da routine** ("rode em modo autônomo"), reforçado pela entry-policy.
5. Memória durável é commitada no PR (`.claude/memory/`) — senão evapora a cada run.

## Decisões arquiteturais

### Memória repo-relative
`~/.claude/projects/<slug>/memory/` → `.claude/memory/` (`MEMORY.md` + arquivos). Escrita em runtime, **commitada de volta** pelo shipper. O planner lê de lá. Local pode manter a memória nativa; a nuvem usa a repo-relative.

### locked_tests executáveis (TDD)
O planner emite o `locked_test` como prosa (Given/When/Then). O **executor autora o arquivo de teste primeiro** (red), implementa até passar (green); depois disso o teste é congelado. O gate determinístico passa a ter o que rodar.

### Sanitização (framework genérico)
Ao popular `core/` a partir do `~/.claude`, remover: perfil pessoal, `@RTK.md`, MCP pessoais (Mind Vault/Palace), nome real em fixtures, flags de autoridade do `settings.json`. A entry-policy é reescrita do zero, genérica.

### Distribuição
Pasta-fonte (este repo) → `vendor` pro `.claude/` do projeto pela skill de init. Discovery exige agents/rules no topo do `.claude/`. Evolução futura: empacotar como plugin/marketplace (fonte única nativa) — sem retrabalho, a estrutura já nasce pronta.

## Roadmap de execução

- **A** — corrigir 9 defeitos de consistência (✅ feito no `~/.claude`).
- **A.2** — corrigir os 40 furos: memória repo-relative, locked_tests TDD, `Skill` tool, paths, contratos internos, refs pessoais.
- **A.3** — implementar o **modo headless** (orchestrating-delivery, triaging, entry-policy).
- **B** — popular `core/` sanitizado a partir do `~/.claude` corrigido.
- **C** — reescrever `initializing-projects` puxando da pasta-fonte.
- **D** — aplicar num projeto de teste + rodar a routine (valida a premissa de ponta a ponta).
