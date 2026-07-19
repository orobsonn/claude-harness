# OpenCode smoke #72 — findings

> **HISTÓRICO + ponte.** O incidente original (QUICK launder) e a cadeia causal abaixo  
> descrevem o #72 **antes** de #400–#411.  
> **Backlog vivo:** `docs/opencode-closure-roadmap.md` (atualizado 2026-07-19).  
> **Aceite verde:** segundo dispatch headless → draft PR  
> https://github.com/Syntifai-AI/victor-bot-atendimento/pull/81 · issue `harness:in-review`.

---

## Aceite 2026-07-19 (pós-#411) — resumo

| | |
|---|---|
| Mode | LIGHT (sem mid-run QUICK) |
| Planner | usable · plan APPROVE · auto-bind |
| Hands | task-1 DONE + capture |
| Deny `redirects with $` | **0** |
| Ship | draft PR #81 |
| Harness | main com #400–#411 vendored no worktree |

**Conclusão:** path headless LIGHT fecha. Residual = forense provider, validate-plan, multitask capture, edges REVISE/dual, custo de 1–2 denys `npm`/`node` — ver roadmap § A1–A8.

---

## Incidente original (pré-fix) — preservado para contexto

**Data forense inicial:** 2026-07-19  
**Projeto:** victor-bot issue #72  
**Runtime:** OpenCode headless (`xai-ollama-dual`)  
**Status original:** diagnóstico fechado; P0 em implementação → **implementado**

### Cadeia causal (primária) — resolução

```
LIGHT ok → ceremony + adversary useful
  → plan-reviewer/adversary family-1 Task error ×3
  → primary_failure_cap_reached
  → classify(QUICK) permitido (stub vazio; wipe ceremony)   ← FECHADO #403
  → implement via bash / PR sob QUICK                        ← FECHADO #403
```

Outros matadores da run de debug intermediária:

| Sintoma | Fix |
|---|---|
| `$` em heredoc/spec → entry-gate deny em loop | #410 #411 |
| `plan_pending_write` eterno → plan-gate | #410 auto-bind |
| Capture/ship CC-shaped | #409 |
| Double-load plugins | #402 |

### Inventário antigo → estado

#### Escape / laundering

| ID | Buraco | Estado |
|---|---|---|
| E1 | classify downgrade + wipe | DONE #403 |
| E2 | classify não limpa review/cap | DONE / parcial — ver A4 se regredir |
| E3 | QUICK ship pula ceremony | DONE #403 |
| E4 | QUICK ship 0 hand-records | DONE #403 #409 |
| E5 | cap não bloqueia push/hands | DONE #403 |
| E6 | plan-gate só Task; bash ignora | mitigado; product bash wall = residual P1 antigo |
| E7 | build bash escreve product | residual polish (A2/coordinator wall) |

#### Review / provider

| ID | Buraco | Estado |
|---|---|---|
| R1 | erro bruto descartado | **ABERTO A1** |
| R2 | 402/429 = provider_error | **ABERTO A1** |
| R3 | review_inflight sem lease | backlog baixo |
| R4 | reopen epoch pré-plano | backlog baixo |

#### Binding / hands

| ID | Buraco | Estado |
|---|---|---|
| H1 | unbound spam eyes | mitigado; revalidar sob barulho |
| H2 | binding_pending só background | mitigado #409 path |
| H3 | hand-record autoatestado | DONE host capture #409 |
| H4 | double-load | DONE #402 |

---

## Evidência (runs)

| Run | Resultado |
|---|---|
| #72 pré-fix | QUICK · 0 hands · PR sujo #78 |
| #72 pós-#411 | LIGHT · capture · draft **#81** |
| Worktree aceite | `/root/.claude/harness-worktrees/harness-victor-bot-72` (efêmero) |
| Obs | `/root/dev/victor-bot/.claude/state/obs-72.*` |
