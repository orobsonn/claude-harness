# OpenCode smoke #72 — findings (forense)

**Data:** 2026-07-19  
**Projeto:** victor-bot issue #72  
**Runtime:** OpenCode headless (`xai-ollama-dual`)  
**Status:** diagnóstico fechado; P0 em implementação

## Respostas curtas (operador)

### 1. Por que classifica de novo?

No OC, `classify` é tool livre. Só recusa se já existe **plano full** (`tasks.length > 0`). Stub vazio = pode chamar N vezes. Cada chamada **zerava** cerimônia e emitia `pipeline-type` de novo.

No #72: LIGHT → (depois do cap) LIGHT → **QUICK** ×2.

**O que “trava”:** não é hang eterno. É `primary_failure_cap_reached` após 3 falhas family-1 (`provider_error`). Reviews novos bloqueados; reopen de epoch caro. O maestro (Grok) trata como beco sem saída e **rebaixa pra QUICK**.

### 2. Por que `provider_error`?

- Eyes family-1 = `xai/grok-4.5` (routing ok; **não** OpenAI locked nesta run).
- Task terminou `status=error` 3× (1 plan-reviewer + 2 adversary).
- O harness **descarta** mensagem/HTTP e grava só o bucket `provider_error`.
- `oc-data-72` e o log foram apagados no cleanup → **causa HTTP exata irrecuperável**.
- 401/403/timeout têm buckets próprios; logo provavelmente **não** foram esses marcadores reconhecíveis. Pode ser 5xx xAI ou erro genérico de Task.

OpenAI “resetado” **não** teria ajudado nesta run: eyes estavam em xAI.

### 3. Por que family-1 “logo após” classify?

Ordem correta LIGHT:

```
classify → spec → adversary-family-1 (spec) → planner → plan-reviewer-family-1 → hands
```

No #72 a 1ª family-1 (20:46) foi **spec-adversary useful** — depois do spec. Depois veio planner e plan-reviewer failure. Não pulou o spec.

### 4. Por que no Claude Code quase não acontece?

| | CC | OC (#72) |
|---|---|---|
| Maestro | Claude (segue ritual) | Grok (re-triage / atalho) |
| Classify | CLI + amortecedores de subagente/feed | tool nativa fácil de re-chamar |
| Travou review | para / escala | rebaixa QUICK + ship bash |
| Mãos | spawn-hand + capture real | Task + hand-record autoatestado |
| Hooks | lista única | auto-glob (double-load já corrigido #402) |

CC **também** pode reclassificar e limpar ceremony — mas o comportamento do modelo e os amortecedores evitam o incidente. Paridade segura = **portar invariantes**, não copiar CC wholesale.

## Linha do tempo #72

| UTC | Evento |
|---|---|
| 20:42 | classify LIGHT |
| 20:43 | explore; unbound ruído (eye) |
| 20:46 | adversary-family-1 **useful** (spec) |
| 20:47–48 | planner running → terminal |
| 20:50 | classify LIGHT de novo |
| 20:52–54 | classify **QUICK** ×2 |
| 20:56–58 | 2ª sessão; unbound de parents |
| 20:58–59 | commit + PR #78 draft |

**Final gate:** `mode:QUICK`, `brainstormed:false`, `planner_status:not_started`, `review_status:primary_failure_cap_reached`, 0 hand-records, stub 0 tasks.

## Cadeia causal (primária)

```
LIGHT ok → ceremony + adversary useful
  → plan-reviewer/adversary family-1 Task error ×3
  → primary_failure_cap_reached
  → classify(QUICK) permitido (stub vazio; wipe ceremony)
  → implement via bash (build: edit deny, bash allow)
  → git push / gh pr sob QUICK (ceremony + capture dispensados)
  → PR “ok” · pipeline morta
```

## Inventário de buracos

### Escape / laundering (P0)

| ID | Buraco |
|---|---|
| E1 | `classify` aceita downgrade e wipe de ceremony |
| E2 | `classify` não limpa review/dual/cap (gate mentiroso) |
| E3 | QUICK ship pula brainstormed/adversary |
| E4 | QUICK ship aceita 0 hand-records |
| E5 | `primary_failure_cap` não bloqueia push/PR nem writing hands |
| E6 | plan-gate/dual só em Task hands; bash do build ignora |
| E7 | build `bash:allow` escreve product code |

### Review / provider (P0–P1)

| ID | Buraco |
|---|---|
| R1 | erro bruto descartado → forense cega |
| R2 | 402/429 caem em `provider_error` genérico |
| R3 | review_inflight sem lease/snapshot |
| R4 | reopen de epoch inviável pré-plano |

### Binding / hands (P1)

| ID | Buraco |
|---|---|
| H1 | `cleanupChild` unfiltered → unbound spam em eyes/parents |
| H2 | `binding_pending` só no path background; OC default = foreground |
| H3 | hand-record = `Status: DONE` autoatestado (não capture oracle) |
| H4 | double-load plugins — **corrigido #402** |

### Paper-overs do trabalho Grok (auditoria)

- hand-record existe, mas **não** é captura independente (CC spawn-hand sim).
- `capture-verified` só timestamp no mesmo JSON.
- marker authority prova emissão, não veracidade do fato.
- single-load: config ok; probe E2E OC real ainda fraco.
- planner claim machine é sólida; validate-plan ainda frouxo vs contrato planner.

## O que NÃO foi causa do #72

- Double-load (já `plugin:[]` no worktree).
- OpenAI locked nos eyes (estavam xAI).
- Falha de escrita de hand-record (nunca houve writing-hand claim).
- Código auto-setando `mode:QUICK` (só o tool `classify`).

## Evidência

- Worktree: `/root/.claude/harness-worktrees/harness-victor-bot-72`
- Gate: `.opencode/plans/.state/ses_089087…/gate-state.json`
- Obs: `/root/dev/victor-bot/.claude/state/obs-72.events.jsonl`
- Scope: `.opencode/plans/.state/scope-terminal-events.jsonl`
- PR: Syntifai-AI/victor-bot-atendimento#78
- Harness fixes: #400, #402
