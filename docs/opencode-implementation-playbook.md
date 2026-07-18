# OpenCode harness — playbook de implementação

**Data:** 2026-07-17  
**Repo:** `/root/dev/claude-harness`  
**Branch base sugerida:** `fix/opencode-heredoc-payload-scan` (já tem hotfixes H1–H4 locais)  
**Mapa de gaps:** `docs/opencode-runtime-gaps-2026-07-17-final.md`  
**Issues:** #372–#385 (`harness:ready`)

Este doc é o **contrato operacional** entre runs.  
Não reabre o dossiê de gaps. Só executa.

---

## 0. Regras de ouro (não negociar)

1. **Não usar FULL OpenCode para consertar o FULL OpenCode.**  
   Path: implementação direta no repo + testes do plugin + smoke mínimo.
2. **1 batch = 1 sessão** (ou 1 sessão = 1 batch). Não 14 issues na mesma sessão.
3. **Cap de adversary: 2 passes por batch.** No 3º → halt, redesenhar (não “mais um patch”).
4. **Batch vermelho → não abre o próximo.**
5. **Path normal OC = Task nativo.** Não portar limitações Claude Code; `run-hand` é legado CLI.
6. **Não afrouxar schema adversary** para aceitar SHIP/BLOCK — o host está certo; o prompt estava errado.
7. **Commit seletivo.** Nunca `git add -A` cego. Conventional Commits. Branch + PR. Sem force-push em main.
8. **Não declarar harness pronto** sem checklist §8 do final.md (smoke real, não só unit).

---

## 1. Como implementar (procedimento padrão por batch)

### 1.1 Antes de codar

1. Ler **este playbook** §2 (batch atual) + issue(s) do batch no GitHub.  
2. Ler trechos do **final.md** só das IDs P0/P1 do batch.  
3. `git status` / `git branch` — confirmar branch; **não** começar em main.  
4. Se o batch depende de outro: confirmar que o PR/dep **merjou** ou está na mesma branch já verde.  
5. Marcar no §3 (checklist) o batch como `in_progress` + data/sessão.

### 1.2 Durante o código

1. **Um agente implementador** (ou você direto) com escopo = arquivos do batch.  
2. Seguir ACs da issue (`#ac-N.M`) — cada AC vira teste ou assert observável.  
3. Mimicar estilo do harness (sem comentários novos a menos que peçam; JSDoc em `.ts` novos).  
4. Rodar testes **do módulo tocado** (ex.: `node --test` / suíte local do plugin).  
5. Se o batch exige **adversary seletivo** (§2):  
   - Disparar 1 agent “advogado do diabo” com o diff + ACs.  
   - Corrigir no máximo **2** ciclos.  
   - 3º fail → parar e documentar bloqueio no checklist.

### 1.3 Depois do código (definição de done do batch)

1. Todos os ACs do batch marcados no §3.  
2. Testes do batch verdes.  
3. Smoke do batch (comando/checklist na tabela §2) executado e anotado.  
4. Commit(s) no branch + PR se o marco fecha (preferir **1 PR por batch**).  
5. Se config OC mudou (`opencode.json`): lembrar **reinício OC**.  
6. Após merge em main e release: re-vendor nos projetos de teste (fora deste playbook, skill `updating-harness`).  
7. Atualizar §3: `done` + link PR + notas.

### 1.4 Quando usar adversary (e quando não)

| Usar adversary (1–2 passes) | Não usar adversary |
|---|---|
| Muda `loop-decide`, `dual-enforcement`, `marker-authority`, `bash-decide` | Prompt cleanup / docs |
| Write de hand-record / capture | example-plan shape + validatePlan verde |
| Ship rails / regate / scope fail-closed | harvest delete-or-fix “remover falsa segurança” |
| Qualquer coisa que **libere hand ou push** com precondição falsa | P2 validator strict se só dangling-ref |

### 1.5 Anti-padrões proibidos

- 14 agents na mesma sessão  
- Loop até “adversary feliz” sem contador  
- Merge #382 sem #374 (ou #385 sem capture path)  
- PR monstro misturando B2+B3+B4  
- Declarar pronto porque “14 issues closed” sem smoke §8  

---

## 2. Batches (ordem hard)

| Batch | Issues | O que entrega | Adversary? | Smoke / stop |
|---|---|---|---|---|
| **B0** baseline | commit H1–H4 locais + **#372** + **#376** | Para de induzir SHIP; recovery com `description`; cap malformed | #372 **não** · #376 **sim** (1 pass: 4º deny) | greps 0 SHIP residual no skill; testes ceremony/loop; cap no 4º dispatch |
| **B1** schema | **#373** (+ **#381** só se couber sem estourar) | Schema único + tool `validate-plan` + example verde | **não** full | `validatePlan(example) → ok:true` |
| **B2** hand path | **#374 → #382** (ordem rígida, mesma sessão ok) | Task grava hand-record; skill/host capture-verified | **sim** (mark sem record deve falhar) | arquivo em hand-records path; capture mark ok; sem run-hand |
| **B3** dual | **#375 → #383 → #384** | REVISE não libera executor; dual por fase; merge no host | **sim** | repro money-preflight em unit: REVISE → deny executor |
| **B4** ship rails | **#377 → #385** (#385 após #382) | regate auto-arm; final/demo no push | **sim** leve | matrix deny push sem final/regate |
| **B5** hygiene | **#378 #379 #380** (+#381 se faltou) | harvest real ou removido; scope binding; identity | só **#379** full | scope happy-path ≠ unbound; harvest sem falsa segurança |

**Cadeias hard (GitHub deps):**  
`#374 → #382 → #385` · `#375 → #383 → #384`

**Fora de escopo até evidência de run:** PLAN_WRITE_LEASE 60s (não abrir issue sem timeout real).

---

## 3. Checklist de implementação (track entre runs)

> Atualize **esta seção** ao fim de cada sessão.  
> Status: `todo` | `in_progress` | `blocked` | `done`  
> Preencha: data, sessão (id se OC), PR, notas curtas.

### Meta global

| Campo | Valor |
|---|---|
| Branch de trabalho | `fix/opencode-heredoc-payload-scan` |
| Última sessão | 2026-07-18 B2 code+tests+adversary pass1 |
| Próximo batch | **B3** (#375 → #383 → #384) após PR B2 |
| Bloqueio ativo | _(nenhum — residual prose-DONE documentado)_ |

### Hotfixes já no working tree (pré-B0)

| ID | Item | Status | Notas |
|---|---|---|---|
| H1 | Heredoc bash-decide | `done` (código) | stripQuotedHeredocBodies + testes; commit pendente |
| H2 | Adversary agents strict | `done` (código) | agents + build; residual SKILL fechado em #372 |
| H3 | Ceremony recovery prompt | `done` (código) | prompt canônico + `description` (#372) |
| H4 | `subagent_depth: 5` | `done` (código) | opencode.json + example; reinício OC após merge |

### B0 — baseline (#372 + #376 + commit H*)

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| Commit H1–H4 (sem misturar lixo) | `done` | #386 | 2026-07-18 | em main |
| #372 residual SHIP + recovery description | `done` | #386 | 2026-07-18 | SKILL mark-gate sem SHIP; recovery Task com description+prompt+subagent_type |
| #376 cap malformed (default 3) | `done` | #386 | 2026-07-18 | streak+inflight cap; status primary_failure_cap_reached + reopen path |
| Testes ceremony / loop-decide | `done` | #386 | 2026-07-18 | 171 pass |
| Smoke: 0 SHIP residual + cap no 4º | `done` | #386 | 2026-07-18 | |
| Adversary passes usados (0–2) | 2 | #386 | 2026-07-18 | |

### B1 — schema (#373 [+#381])

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| #373 schema + tool validate-plan | `done` | #389 | 2026-07-18 | locked_tests {id,path,assertion,fixture_paths?}; tool + CLI |
| example-plan ok:true | `done` | #389 | 2026-07-18 | validatePlan(example,{expect:full}) → ok:true |
| complexity max resolvido (aceitar ou map→high) | `done` | #389 | 2026-07-18 | max aceito; dispatch continua executor-high |
| #381 validator strict (opcional neste batch) | `todo` | | | adiado p/ B5 (schema estável; escopo separado) |
| Smoke validate-plan tool registrada | `done` | #389 | 2026-07-18 | tools/validate-plan.ts + CLI exit 0 |

### B2 — hand path (#374 → #382)

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| #374 hand-record after Task | `done` (código) | pendente | 2026-07-18 | writeHandRecord em hand-records; obs-hand after terminal |
| #382 capture-verified path skill+host | `done` (código) | pendente | 2026-07-18 | SKILL post-hand + tests; writtenBy allowlist |
| Teste: mark sem record → fail | `done` | | 2026-07-18 | marker-authority |
| Smoke: Task → record file → capture ok | `done` | | 2026-07-18 | unit/integration 48 pass |
| Adversary passes (0–2) | 1 | | 2026-07-18 | high prose-DONE residual aceito p/ escopo Task; medium writtenBy fixado |

### B3 — dual (#375 → #383 → #384)

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| #375 REVISE blocks executor + plan_verdict | `todo` | | | |
| #383 dual_status per-phase | `todo` | | | |
| #384 wire dual merge no host | `todo` | | | |
| Teste: REVISE + dual both → deny executor | `todo` | | | |
| Smoke money-preflight repro | `todo` | | | |
| Adversary passes (0–2) | — | | | |

### B4 — ship rails (#377 → #385)

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| #377 regate auto-arm | `todo` | | | |
| #385 ship preconditions final/demo | `todo` | | | |
| Matrix bash-decide deny | `todo` | | | |
| Adversary passes (0–2) | — | | | |

### B5 — hygiene (#378 #379 #380 #381)

| Item | Status | PR | Data | Notas |
|---|---|---|---|---|
| #378 harvest-guard paths | `todo` | | | |
| #379 scope child binding | `todo` | | | |
| #380 task identity hygiene | `todo` | | | |
| #381 se ainda todo | `todo` | | | |
| Smoke scope + harvest | `todo` | | | |

### Critério “harness pronto” (só depois B0–B4)

| Check | Status | Evidência |
|---|---|---|
| FULL mínimo: ceremony → plan válido → dual APPROVE → Task hands + hand-record → capture → regate se sniper → push sem deny falso | `todo` | |
| Malformed streak ≥3 aborta com mensagem acionável | `todo` | |
| 0 residual SHIP/BLOCK em prompts adversary | `todo` | |
| example-plan + tool validate-plan verdes | `todo` | |
| Re-vendor + reinício OC em projeto de teste | `todo` | |

---

## 4. Mapa issue → batch → paths principais

| Issue | Batch | Paths (orientação) |
|---|---|---|
| #372 oc-adversary-prompt-cleanup | B0 | `skills/orchestrating-delivery/SKILL.md`, `ceremony-runtime.mjs`, `ceremony-coordinator.ts` |
| #376 oc-malformed-review-cap | B0 | `plugin/lib/loop-decide.mjs`, `loop-guard.ts` |
| #373 oc-plan-schema-and-tool | B1 | `shared/lib/validate-plan.mjs`, `agents/planner.md`, `skills/creating-plans/**`, `tools/` |
| #381 oc-plan-validator-strict | B1/B5 | `shared/lib/validate-plan.mjs` |
| #374 oc-task-hand-record | B2 | `plugin/obs-hand.ts`, `plugin/lib/hand-records.mjs` |
| #382 oc-capture-verified-path | B2 | `SKILL.md`, `marker-authority.ts` |
| #375 oc-revise-blocks-executor | B3 | `loop-decide.mjs`, `dual-enforcement.mjs`, gate-state-shape |
| #383 oc-dual-status-per-phase | B3 | mesmo núcleo dual + shape |
| #384 oc-wire-dual-merge | B3 | `loop-guard.ts`, obs-eye, dual-runtime |
| #377 oc-regate-auto-arm | B4 | marker-authority, SKILL, obs-hand/sniper |
| #385 oc-ship-preconditions | B4 | `bash-decide.mjs` |
| #378 oc-harvest-guard-paths | B5 | `harvest-guard.ts`, `harvester.md` |
| #379 oc-scope-child-binding | B5 | `dispatch-scope.mjs`, obs-hand |
| #380 oc-task-identity-hygiene | B5 | `hook-identity.mjs`, dual-enforcement, loop-guard |

---

## 5. Prompt de orientação (colar no início de cada run)

Copie o bloco abaixo **inteiro** na próxima sessão. Ajuste só `BATCH` e `SESSION_NOTE`.

```text
Implementar o próximo batch do harness OpenCode — NÃO recomeçar a análise.

## Ler primeiro (obrigatório)
1. docs/opencode-implementation-playbook.md  ← este playbook (procedimento + checklist)
2. docs/opencode-runtime-gaps-2026-07-17-final.md  ← só as seções das issues do batch
3. Checklist §3 do playbook — marcar batch in_progress; não reabrir batches done

## Batch desta sessão
BATCH: <B0|B1|B2|B3|B4|B5>
ISSUES: <listar #N do batch>
SESSION_NOTE: <1 linha: o que a run anterior deixou / branch / PR aberto>

## Regras
- Foco EXCLUSIVO OpenCode. Path normal = Task nativo. Sem portar limitações Claude Code.
- 1 batch por sessão. Não implementar issues de outro batch.
- Respeitar deps: #374→#382→#385 e #375→#383→#384.
- Cap adversary: máx 2 passes; 3º = halt e documentar no checklist.
- Adversary só se o playbook §2 disser sim para este batch.
- Não afrouxar schema adversary (SHIP/BLOCK continua inválido).
- Código + testes do módulo; smoke do batch; atualizar checklist §3 no fim.
- Commit só se eu pedir explicitamente (ou se o playbook do batch pedir PR e eu autorizar).
- NÃO declarar harness pronto sem checklist “harness pronto” do playbook.

## Como trabalhar
1. git status + branch; ler ACs das issues do batch.
2. Implementar na ordem do batch (setas = ordem rígida).
3. Rodar testes tocados; smoke do §2.
4. Se adversary: 1 pass → fix → no máx 2º pass.
5. Atualizar docs/opencode-implementation-playbook.md §3 (status, PR, notas, próximo batch).
6. Resumo final para o operador: o que fechou, o que ficou blocked, próximo BATCH=.

## Critério de done desta sessão
- ACs do batch marcados ou blocked com motivo
- Checklist §3 atualizado no repo
- Smoke do batch executado (ou justificado se impossível)
- Zero trabalho fora do batch
```

### Atalhos por batch (substituir no prompt)

**B0**
```text
BATCH: B0
ISSUES: #372 #376 + commit hotfixes H1–H4 do working tree
```

**B1**
```text
BATCH: B1
ISSUES: #373 (opcional #381 se sobrar e schema estável)
```

**B2**
```text
BATCH: B2
ISSUES: #374 depois #382 (ordem rígida)
```

**B3**
```text
BATCH: B3
ISSUES: #375 depois #383 depois #384
```

**B4**
```text
BATCH: B4
ISSUES: #377 depois #385 (só se #382 done)
```

**B5**
```text
BATCH: B5
ISSUES: #378 #379 #380 (#381 se ainda todo)
```

---

## 6. Log de sessões (append-only)

| Data | Sessão / agente | Batch | Resultado | Próximo |
|---|---|---|---|---|
| 2026-07-17 | varredura + issues + playbook | — | mapa + #372–#385 + este doc | **B0** |
| 2026-07-18 | opencode B0 implement | **B0** | #372+#376+H* código/testes verdes; adversary 2/2 SHIP; commit/PR pendente | **B1** após PR B0 |
| 2026-07-18 | opencode B1 implement | **B1** | #373 schema+tool+example verdes; max aceito; #381 adiado B5; merged #389 | **B2** |
| 2026-07-18 | opencode B2 implement | **B2** | #374+#382 código/testes 48 pass; adversary 1/2 (writtenBy fix; prose-DONE residual); commit/PR pendente | **B3** após PR B2 |

---

## 7. Links rápidos

| Recurso | Path / URL |
|---|---|
| Gaps finais | `docs/opencode-runtime-gaps-2026-07-17-final.md` |
| Dossiê anterior | `docs/opencode-runtime-gaps-2026-07-17.md` |
| Issues | https://github.com/orobsonn/claude-harness/issues/372 … /385 |
| Submit issues (não recriar) | `core/opencode/skills/creating-issues/` |
| Core OC | `core/opencode/` |
| Shared validate | `core/shared/lib/validate-plan.mjs` |
