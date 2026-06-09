# Auditoria do harness

Duas passadas: uma auditoria de consistência (9 defeitos) e uma varredura adversarial multi-agente (40 furos confirmados de 43, em 7 dimensões). Resultado bruto da varredura em `raw/hole-hunt-2026-06-09.json`.

## Fase A — 9 defeitos de consistência (RESOLVIDOS no `~/.claude`)

| # | Defeito | Status |
|---|---|---|
| 1 | ordering shipper/harvester vs orchestrating | ✅ harvester → shipper operator-gated |
| 2 | `CLAUDE-HARNESS-MEMORY-MODEL.md` referenciado mas inexistente | ✅ doc canônico criado |
| 3 | `surveying-codebase` cold-start sem trigger | ✅ wired no Phase 0 |
| 4 | paths `harness/` inexistentes | ✅ → `~/.claude/...` |
| 5 | findings do `security` sem consolidação | ✅ bloco Security em recording-findings + harvester |
| 6 | `design-principles/skill.md` minúsculo | ✅ → `SKILL.md` |
| 7 | nome "deliver" obsoleto | ✅ → `orchestrating-delivery` |
| 8 | path do plano inconsistente | ✅ → `.claude/plans/<feature_id>/plan.json` |
| 9 | `canonical-critical-classes` foge da convenção | ✅ exceção "carrier" documentada |

## Varredura adversarial — 40 furos → 8 temas

11 high · 17 medium · 12 low. Agrupados por causa raiz:

| Tema | Furos | Causa raiz | Onde resolve |
|---|---|---|---|
| ① Pipeline toda human-gated | H3,H4,H5,H10,M1,M8,M9 | gates/brainstorm/demo pressupõem humano no loop → routine "auto-segue" cega | **modo headless** (A.3) |
| ② Memória nativa em HOME morre na nuvem | H1,H6,H9,M3 | `MEMORY.md` + patterns em `~/.claude/projects/…` invisível na nuvem | repo-relative `.claude/memory/` (A.2) |
| ③ `locked_tests` são prosa, sem teste executável | H2 | gate é o oráculo de "funciona" e está vazio | executor autora teste via TDD (A.2) |
| ④ Agentes sem a `Skill` tool | H11,L2 | planner/executor/harvester invocam skills/MCP fora do seu `tools` | adicionar tools (A.2) |
| ⑤ Vazamento de dado pessoal no vendor | H7,M7,M10,M11,L5,L6,L12 | CLAUDE.md/agents/settings com perfil, RTK, MV/MP, nome real, flags de autoridade | sanitizar ao popular (B) + refs (A.2) |
| ⑥ Paths skill-relativos não resolvem | M12,M15,L1,L8 | `node references/validate-plan.mjs` quebra fora do dir da skill | path resolvido (A.2) |
| ⑦ Contratos internos inconsistentes | M4,M5,M6,M13,M14,M16,L4,L7,L9,L10,L11 | findings.md com 2 produtores; quota do adversary; sniper lê severity ausente; plan.mode não reescrito; etc. | harmonizar (A.2) |
| ⑧ `initializing-projects` stale | M17,L3 | aponta pra `@reviewer`/`@docs` (inexistentes) e nome "init-project" | reescrita (C) |

### Decisões de produto tomadas
- **Modo headless** = variante autônoma da pipeline; gates humanos → validação multi-agente; entrega via **PR draft**. Não substitui o modo local.
- **Framework genérico**: zero PII. Linguagem "the operator / non-developer". Nada de RTK, Mind Vault/Palace, nome real, perfil pessoal.
- **Distribuição**: pasta-fonte (este repo) → vendor pro `.claude/` do projeto via skill de init.
- **Lows cosméticos** (nome "security", tamanho de script de referência): registrados, não bloqueiam o primeiro teste de routine.
