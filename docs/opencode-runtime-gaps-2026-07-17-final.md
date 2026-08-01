# OpenCode harness — relatório FINAL de gaps (com evidência de run)

> **HISTÓRICO (2026-07-17).** Vários P0 daqui foram fechados em #400–#411; smoke headless #72  
> aceitou com draft PR #81 (LIGHT + capture). **Backlog vivo:**  
> `docs/opencode-closure-roadmap.md`. Use este arquivo só para caçar edges (REVISE/dual,  
> validate-plan, regate) — não como lista de implementação do zero.
>
> **PR4.2 (2026-07-31):** as referências abaixo a `ceremony-transition.mjs`, receipts, hashes ou
> recovery de cerimônia também estão superadas. R10 vigente usa apenas booleans host-owned em
> ordem e feature match; nenhum sidecar participa do gate.

**Data:** 2026-07-17  
**Repo:** `/root/dev/claude-harness`  
**Branch:** `fix/opencode-heredoc-payload-scan` (diff local NÃO commitado)  
**Core version:** `0.45.0`  
**Sucessor de:** `docs/opencode-runtime-gaps-2026-07-17.md`  
**Escopo:** runtime OpenCode apenas. Claude Code só como contraste.  
**Status:** mapa histórico; implementação ativa = closure-roadmap pós-#411.

---

## 0. TL;DR acionável

A pipeline OC **não fecha LIGHT/FULL de ponta a ponta** no path nativo Task. Os blockers que matam runs reais hoje:

| Prioridade | O que trava | Evidência principal |
|---|---|---|
| **P0-A** | Prompt/skill ainda induz SHIP/BLOCK → family-1 **malformed** em loop sem cap | Victor `ses_097a…` (7× F1 malformed, dual pending) |
| **P0-B** | Task nativo **não grava hand-record** → `capture-verified` impossível → push morto | 0 hand-records sob `.opencode/**`; 8 hands “finished” sem record |
| **P0-C** | `dual_status` global + REVISE não bloqueia executor | money-preflight: primary REVISE r2 + dual=both + executors |
| **P0-D** | Schema de plan triplo + tool `validate-plan` ausente + example inválido | 28 erros no example-plan; tools/ só classify+complexity-scorer |
| **P1** | regate quase nunca armado; final/demo/harvest fora do push; harvest-guard morto; scope-terminal unbound | 1/90 regate; 38 fail-closed scope events |

Hotfixes locais (heredoc, adversary agents, recovery prompt, `subagent_depth=5`) **mitigam H1–H4** mas **não bastam**: skill residual ainda tem `mark-gate … --verdict SHIP` (linhas 231–232); recovery ainda sem `description` (P1-8); hand-record/capture/dual/schema intactos.

---

## 1. Inventário do que foi vasculhado

### 1.1 OpenCode DBs

| Path | Uso |
|---|---|
| `/root/.local/share/opencode/opencode.db` | **Primário** — 7852 sessions, 38075 messages, 186964 parts |
| `/root/.claude/harness-state/preserved/issue-313/oc-data/opencode/opencode.db` | Preservado issue-313 (não produto vivo) |

### 1.2 Projetos no DB (project + directories)

| Project worktree | Dirs associados | Sessions (total) | Parent sessions |
|---|---|---:|---:|
| `/root/dev/claude-harness` | harness + worktrees 282/291/320 + harness-361/ch-362/ch-work | 7476 | 32 |
| `/root/dev/victor-bot` | próprio | 350 | **163** |
| `/root/dev/victor-pipeline-dados-bot` | próprio | 17 | **4** |
| worktree 275 /tmp probes | — | 7 | 8 |

**Sem `.opencode/plans` (só dir `.opencode` ou vazio):** harness-361, ch-362, ch-work, victor-pipeline-dados-mcp, victor-mcp.

### 1.3 Artefatos `.opencode/plans`

| Projeto | gate-states | execution-plans | hand-records `.opencode` | hand-records `.claude` (contraste) |
|---|---:|---:|---:|---:|
| victor-bot | **81** | ~80+ | **0** | 15 (legado CC) |
| victor-pipeline-dados-bot | **4** | 4 | **0** | sim (outras features) |
| worktree-282 | 3 | 3 | 0 | — |
| worktree-291 | 1 | 1 | 0 | — |
| worktree-320 | 1 | 1 | 0 | — |
| **TOTAL** | **90** | **95** (77 stub) | **0** | **15** |

### 1.4 Logs / scope / worktrees

- Log: `/root/.local/share/opencode/log/opencode.log` (~68 MB) — denials melhores via DB `part` (log text search frágil).
- Scope terminal: `/root/dev/victor-pipeline-dados-bot/.opencode/plans/.state/scope-terminal-events.jsonl` — **38** eventos fail-closed.
- Worktrees: `/root/harness-worktrees/{282,291,320,victor-pipeline-dados-mcp-159}` + `/root/dev/harness-worktrees`, `~/.claude/harness-worktrees`.

### 1.5 Sessões-chave (produto + auditoria)

| Session | Projeto | Papel |
|---|---|---|
| `ses_097a4e95affefVZ3n39TmDmlpm` | victor-pipeline-dados-bot | **Incidente real** bot-price-without-hold |
| `ses_098b4c7bdffeImcbfOJfMIDphm` | idem | bot-price anterior (identity mismatch) |
| `ses_098b77106ffeWOZdQdujlbx4oU` | idem | harness-sync cancelado |
| `ses_097c3eb44ffe33qaN4tYSycmXA` | idem | updating-harness falhou mark |
| `oc-money-preflight-47` | victor-bot | REVISE + dual both + hands (smoking gun P0-8) |
| `oc-agente-1783948812` | victor-bot | “sucesso” hand_finished sem hand-record/capture |
| `ses_0a25e387bffeuY1hw24DwLslMJ` | victor-bot | dual `primary_only_error` terminal |
| `ses_0a64959e8ffeQgGuj3zxc6N5m8` | worktree-291 | teste capture-verified parou na triagem |
| `ses_098af6fe0ffe67u6y4aMTNmTKS` | claude-harness | investigação OpenAI |
| `ses_09566454affezDRRyIOMSmN7Jq` / `…533…` | claude-harness | auditorias planning/hands (código) |

---

## 2. Falhas reais por fase (contagens + exemplos)

### 2.1 Distribuição de gate-states (90)

| Bucket | n | % | Leitura |
|---|---:|---:|---|
| FULL triaged only (parou na entrada) | 31 | 34% | Classificou e não avançou dual/hand |
| no-ceremony | 21 | 23% | Bypass |
| QUICK | 10 | 11% | |
| FULL ceremony_done_no_dual | 8 | 9% | brainstormed sem dual útil |
| **hand_finished (melhor caso OC)** | **8** | **9%** | Sem hand-record, sem capture-verified |
| empty/minimal | 4 | 4% | |
| stuck planning/malformed/primary_error | 5 | 6% | pipeline + obs |
| LIGHT | 2 | 2% | |
| dual both sem hand | 1 | 1% | stub plan |

| Marker / campo | n/90 |
|---|---:|
| `dual_status` presente | 11 |
| `dual_status=both` | 9 |
| `hand_finished` | 8 |
| `capture_verified` / `capture-verified` | **0** |
| `plan_verdict` | **0** |
| `active_dispatch` | **0** |
| `regate_*` | **1** |
| `CEREMONY_PROOF*` no state | **0** (só em deny runtime) |

### 2.2 Denials em parts (DB) — projetos produto

**victor-pipeline-dados-bot** (201 parts filtrados):

| Pattern | hits |
|---|---:|
| malformed | 95 |
| SHIP/BLOCK | 39 |
| CEREMONY_PROOF_REQUIRED | 6 |
| identity mismatch / review reservation | 6+6 |
| canonical spec-adversary | 5 |
| denied_class=interpreter | 2 |
| denied_class=package_launcher | 1 |

**victor-bot** (parts sample): malformed 240, locked_tests 192, capture-verified 101 (maioria prosa/docs), validate-plan 100, delivery-blocked 6, CEREMONY 6.

### 2.3 Tabela por fase do pipeline

| Fase | O que quebra em run | Exemplo | Contagem |
|---|---|---|---|
| **Entry/triage** | Muitas sessões FULL param após classify | 31/90 triaged_only | 31 |
| **Spec write** | Heredoc falso-positivo (H1) — **mitigado local** | bash-decide | hotfix |
| **Spec adversary** | Prompt pede SHIP/BLOCK → malformed; sem cap | `ses_097a` 7× F1 | 9 malformed no state |
| **mark adversary_fired** | `canonical spec-adversary result is missing` | `ses_097a` 01:06–01:08 | 5+ parts |
| **Planner** | `CEREMONY_PROOF_REQUIRED` | `ses_097a` | 6 parts |
| **Plan schema** | docs/skill ≠ validator; example inválido | example-plan 28 erros | código + skill |
| **Plan review** | REVISE não bloqueia; dual global | money-preflight | 1 smoking gun + código |
| **Executor Task** | Sem hand-record writer | 0 files OC | 8 hands “ok” sem record |
| **Capture** | Nunca materializa | 0/90 | 0 |
| **Regate** | Quase nunca armado | 1/90 (money-preflight) | 1 |
| **Scope binding** | fail-closed SDK/binding | scope-terminal 38 | 38 |
| **Push/ship** | capture + dual rails; final/demo/harvest fora | bash-decide | código |
| **Harvest** | tool `harvest` inexistente; return object | harvest-guard.ts | código |
| **Installer** | `denied_class=interpreter` em vendor-core | `ses_098b4c` | 2 parts |

---

## 3. Incidente canônico: bot-price-without-hold

**Session:** `ses_097a4e95affefVZ3n39TmDmlpm`  
**Projeto:** `/root/dev/victor-pipeline-dados-bot` (harness v0.45.0 vendored 2026-07-16)  
**Feature:** `bot-price-without-hold`

### Timeline resumida

1. FULL classify → brainstorm → spec via bash heredoc.  
2. **7 dispatches family-1**, todos malformed (prompt pedia SHIP/BLOCK/mechanism/sweep).  
3. Family-2: 4 useful (com issues abertas) + 2 malformed (1 empty).  
4. `mark(brainstormed)` ok; dual seal payload `"pending"`.  
5. `mark(adversary_fired)` → **canonical spec-adversary result is missing**.  
6. Planner Task → **CEREMONY_PROOF_REQUIRED**.  
7. ceremony-next recovery re-dispatched F1 **ainda com SHIP/BLOCK** → 7º malformed.  
8. Terminal: entrega bloqueada na cerimônia. Plan continua **stub**.

### Gate-state final (campos)

```
adversary_fired: false
dual_status: pending
dual_secondary_status: useful
review_failure_counts.malformed: 9
primary_review_failure_count/streak: 7/7
planner_status: not_started
delivery_status: planning
```

### Correlação path:linha (core)

| Comportamento | Path |
|---|---|
| Schema só `{issues}` | `core/shared/lib/review-report-schema.mjs:120–127` |
| Classify malformed | `core/opencode/plugin/lib/loop-decide.mjs:216–223` |
| Failure sem cap útil | `loop-decide.mjs:264–278` (só useful incrementa contador de loop) |
| Dual pending sem primary | `loop-decide.mjs:287–290` |
| CEREMONY_PROOF planner | `plugin/lib/entry-decide.mjs:103–107` |
| mark missing artifact | `plugin/lib/ceremony-transition.mjs:96–115` |
| Skill residual SHIP | `skills/orchestrating-delivery/SKILL.md:231–232` |

**Host falhou fechado corretamente.** Bug de indução de formato (skill/build/recovery) + ausência de cap de malformed.

---

## 4. P0/P1/P2 — veredito com evidência

Legenda: **CONF** confirmado · **REF** refutado · **REFN** refinado · **A** necessário OC · **B** legado CC · **C** ausente/quebrado nativo

### P0

| ID | Furo | Veredito | A/B/C | Sev | Prova run | Prova código |
|---|---|---|---|---|---|---|
| **P0-1** | Três schemas `locked_tests` | **CONF** | C | blocker | parts victor-bot citam locked_tests; planos stub dominam | planner.md string; creating-plans `{test_path,assertion}`; validate-plan.mjs `{id,path}` |
| **P0-2** | example-plan inválido | **CONF** | C | blocker | — | `validatePlan(example)` → 28 erros id/path |
| **P0-3** | tool `validate-plan` ausente | **CONF** | C | blocker | skill/build mandam chamar; tools/ só 2 | `tools/`: classify + complexity-scorer |
| **P0-4** | `complexity: max` doc vs reject | **CONF** | C | high | — | planner.md max; validate-plan só low\|medium\|high |
| **P0-5** | Task sem hand-record | **CONF** | C (+B run-hand) | blocker | **0** files `.opencode/**/hand-records/**`; 8 hand_finished | só `hands/run-hand.mjs` escreve; obs-hand só claim |
| **P0-6** | capture-verified exige DONE record | **CONF** | A+C | blocker | **0/90** capture no state | marker-authority.ts:110–125 |
| **P0-7** | skill manda hand-finished, não capture | **CONF** | C | blocker | 0 capture materializado | SKILL.md step hand-finished; 0 capture-verified na skill |
| **P0-8** | REVISE útil grava dual e libera executor | **CONF** | C | blocker | money-preflight: primary r1+r2 **REVISE**, dual=both, executor-t1/t2 rodaram | loop-decide useful sem verdict; dual-enforcement só dual_status |
| **P0-9** | dual_status global | **CONF** | C | high | string top-level em 11 states; sem per-phase | gate-state-shape + loop-decide single field |

### P1

| ID | Furo | Veredito | A/B/C | Sev | Prova |
|---|---|---|---|---|---|
| **P1-1** | regate não armado pela skill | **CONF** | C | high | 1/90 gate-states; skill step g só prosa |
| **P1-2** | final/demo/harvest fora do push | **CONF** | C | high | bash-decide: ceremony+dual+regate+capture only |
| **P1-3** | harvest-guard morto | **CONF** | C | med | harvest-guard.ts tool `"harvest"` inexistente; return object |
| **P1-4** | harvester path sem sessionID | **CONF** | C | med | harvester.md `<feature_id>` vs canônico session-feature |
| **P1-5** | merge dual (driveDualEye) desconectado | **CONF** | C | high | dual-runtime na skill; loop-guard só applyReviewOutcome |
| **P1-6** | malformed sem cap | **CONF** | C | high | ses_097a streak 7; só useful consome cap |
| **P1-7** | PLAN_WRITE_LEASE 60s | **CONF código / fraco run** | A/C | med | planner-state.mjs:4; gate-state não grava lease expiry |
| **P1-8** | recovery Task sem `description` | **CONF** | C | med | ceremony-runtime step só subagent_type (+prompt hotfix); falta description |

### P2

| ID | Veredito | A/B/C | Nota |
|---|---|---|---|
| P2-1 command/task_id oficiais reusados | CONF | C | hook-identity / extractSubagentType |
| P2-2 skill Task ≈ run-hand | CONF | B | path normal OC = Task |
| P2-3 model_strategy Claude | CONF | B | example-plan + skill |
| P2-4 isTaskTool inconsistente | CONF | C | loop-guard exact `"task"` vs dual-enforcement patterns |
| P2-5 composition shadow | CONF | A/C | scope-runtime-composition shadow se plugin faltar |
| P2-6 build edit:deny + bash allow | CONF | A/C | isolamento nominal |
| P2-7 validator frouxo | CONF | C | scope/criterion vazios, depends_on fantasma ok |

### Hotfixes locais (working tree)

| ID | Status | Residual |
|---|---|---|
| H1 heredoc | Corrigido local | precisa commit + vendor |
| H2 adversary schema/prompt | **Parcial** | agents/build ok; **SKILL.md:231–232 ainda ensina SHIP** |
| H3 recovery prompt canônico | Parcial | falta `description` (P1-8) |
| H4 subagent_depth=5 | Corrigido local | reinício OC obrigatório |

---

## 5. Blockers NOVOS (só visíveis em run)

| ID | Achado | Evidência | Sev | A/B/C |
|---|---|---|---|---|
| **N1** | `hand-scope-terminal-unbound` fail-closed (SDK unavailable / binding_pending) | scope-terminal-events.jsonl 38× | high | C |
| **N2** | Epidemia de execution-plan **stub** (77/95) | plans em victor-bot | high | C (síntoma de ceremony/plan nunca fechar) |
| **N3** | dual `primary_only_error` terminal sem recovery | ses_0a25e… observabilidade | med | C |
| **N4** | `plan_verdict` / `active_dispatch` nunca no gate-state | 0/90 | high | C |
| **N5** | CEREMONY_PROOF não grava no state (só deny efêmero) | 0 keys; 6 denials parts | med | C observability |
| **N6** | Session reopen não limpa failure streak | ses_097a session_reopened_at + streak 7 | med | C |
| **N7** | loop-guard **identity mismatch** mata dual | ses_098b4c bot-price | high | C |
| **N8** | `denied_class=interpreter` bloqueia updating-harness/vendor | ses_098b4c parts | med | C policy |
| **N9** | F2 useful + material_unresolved **nunca** completa dual sem primary useful | ses_097a dual_secondary useful + dual pending | high | A/C |
| **N10** | Skill residual mark-gate `--verdict SHIP` contradiz H2 | SKILL.md:231–232 | high | C |
| **N11** | hand_finished parcial vs fidelity (task-3 fidelity sem hand_finished) | oc-identidade | low | C |
| **N12** | Build trata narrativa SHIP como sucesso e tenta mark/planner | ses_097a timeline | med | C (skill/build habit) |

---

## 6. Classificação A / B / C (atualizada)

### A — manter / necessário no OpenCode

- Entry: triaging, classify, entry-gate  
- Ceremony seals HMAC + mark authority  
- Dual como **enum com semântica de fase** (hoje quebrado → ver C)  
- Fidelity rail, active_dispatch scope, plan-write-gate  
- Delivery bash rails (push/PR)  
- Loop-guard de reviews **useful** + (falta) cap de failure  
- Routing: agent frontmatter + harness.routing.json  
- Dispatch: `task({ description, prompt, subagent_type })` + HARNESS_TASK_CONTEXT  

### B — legado CC / não path normal OC

- `hands/run-hand.mjs` + `opencode run` + `*-spawn` (só headless CLI explícito)  
- mark-gate.mjs como “estado” (obs-only)  
- `model_strategy` opus/sonnet/haiku no plan  
- Prosa skill que equipara Task e run-hand  
- Portar limitações Claude Code / process spawn barato  

### C — implementar nativo (faltando ou quebrado)

1. Schema único plan + tool OC `validate-plan` + example válido + complexity max resolvido  
2. Hand-record writer no after de Task writing-hand  
3. Skill: capture-verified + oracle host-side  
4. dual **por fase** + REVISE **nunca** libera hand + merge wired no host  
5. Cap de malformed/failure streak (hard stop)  
6. regate auto-arm pós sniper-high  
7. Ship preconditions: final (+demo se interactive); harvest só se gate real  
8. harvest-guard rewrite ou remove; harvester paths com sessionID  
9. Identity: não mapear command/task_id oficiais → role/task harness  
10. Ceremony recovery Task com `description` completo  
11. Scope binding child Task (N1) — binding verificado sem SDK ghost  
12. Limpar residual SHIP no skill mark-gate examples  
13. Policy installer (interpreter deny) se updating-harness for path suportado  
14. Observability: persistir plan_verdict, denial class no gate-state  

---

## 7. Arquitetura-alvo (inalterada, com ênfase do que a run provou)

1. **Um path de hand:** só `task(subagent_type)`.  
2. **Schema único** locked_tests = `{ id, path, assertion, fixture_paths? }`; complexity `low|medium|high` (mapear max→high se scorer emitir max).  
3. **Hand-record no after Task** no mesmo path que `handRecordPath`.  
4. **Dual por post:** `dual_status.plan_review` e `dual_status.adversary`; executor só se plan APPROVE + dual recorded; REVISE nunca desbloqueia.  
5. **Wire merge dual no host.**  
6. **Regate determinístico** após sniper-high.  
7. **Ship preconditions completas** em bash-decide.  
8. **Cap failure streak** em loop-decide (ex.: 3 malformed → halt).  
9. **Tools:** classify, mark, validate-plan, complexity-scorer, ceremony-next, verify.  
10. **Identity hygiene** + recovery `{ description, prompt, subagent_type }`.  

---

## 8. Plano de correção ordenado (próxima sessão: CODAR)

### Sprint 0 — fechar residual do hotfix (1–2 arquivos, já no tree)

1. SKILL.md remover exemplos `mark-gate … --verdict SHIP` (linhas 231–232) e qualquer SHIP residual.  
2. ceremony-runtime: incluir `description` no Task de recovery.  
3. Commit branch + reiniciar OC + re-vendor nos projetos de teste.

### Sprint 1 — P0 schema plan (desbloqueia planner)

1. Unificar locked_tests em docs + validate-plan + example-plan.  
2. Registrar tool OC `validate-plan` (wrapper do módulo shared).  
3. complexity: aceitar `max` **ou** mapear scorer max→high e remover da doc.  
4. Testes: example-plan passa; skill shapes rejeitados com mensagem única.

### Sprint 2 — P0 hand-record + capture (desbloqueia ship path Task)

1. Writer after-Task em obs-hand (ou plugin dedicado) → hand-record DONE|…  
2. Skill: após hand-finished, `capture-verified` com SHA.  
3. Teste integração: Task executor → record existe → mark capture ok.

### Sprint 3 — P0 dual/REVISE (desbloqueia qualidade do gate)

1. `plan_verdict` persistido; dual-enforcement exige APPROVE para executor.  
2. dual_status namespaced (plan_review / adversary).  
3. Cap malformed/failure streak.  
4. Wire merge dual no loop-guard/obs-eye.

### Sprint 4 — P1 ship/regate/harvest/scope

1. regate auto-arm na skill + host após sniper-high.  
2. bash-decide: final review (+ demo se interactive).  
3. harvest-guard: remove ou reescreve; harvester paths com sessionID.  
4. Investigar N1 scope binding (SDK unavailable) com repro mínimo.

### Sprint 5 — P2 hygiene

1. Identity: parar de ler `command`/`task_id` oficiais como role/task de plano.  
2. isTaskTool unificado.  
3. Validator: depends_on fantasma, scope/criterion vazios.  
4. Deprecar prosa run-hand no path interativo.

### Critério de “harness pronto para run de feature”

- [ ] FULL em projeto real: ceremony → plan válido → dual APPROVE → Task hands com hand-record → capture-verified → regate se sniper → push sem deny falso  
- [ ] Malformed streak ≥3 aborta com mensagem acionável (não loop 7×)  
- [ ] 0 residual SHIP/BLOCK em prompts de adversary  
- [ ] example-plan + tool validate-plan verdes  

---

## 9. O que está OK — não reabrir

| Item | Por quê |
|---|---|
| Fail-closed de ceremony sem artifact canônico | ses_097a: host correto; bug é indução de formato |
| Schema adversary strict `{issues}` | Correto; não afrouxar para aceitar SHIP |
| Entry-gate + classify + mode FULL/LIGHT/QUICK | Funcionam; triagem em si ok |
| Marker authority (mark tool) | Design A; falta armadores e writers |
| Fidelity rail / plan-write-gate (conceito) | Necessários; leases podem afinar depois com evidência |
| Routing via agent frontmatter | Path OC-native correto |
| Não portar limitações Claude Code | Mantido |
| H1 heredoc strip | Correto no working tree |
| subagent_depth 5 | Necessário para investigação e nesting Task |

---

## 10. Estado do repo (fim desta sessão de varredura)

**Branch:** `fix/opencode-heredoc-payload-scan`  
**Não commitado (já listado no dossiê anterior):**

- bash-decide heredoc + tests  
- adversary*.md + build.md + review-catalog tests  
- ceremony-coordinator + ceremony-runtime + tests  
- orchestrating-delivery SKILL (parcial)  
- opencode.json subagent_depth 5  

**Docs novas:**

- `docs/opencode-runtime-gaps-2026-07-17.md` (handoff)  
- `docs/opencode-continue-prompt.md`  
- `docs/opencode-runtime-gaps-2026-07-17-final.md` (**este arquivo**)  

**Não implementado nesta sessão:** correções grandes (missão era fechar o mapa).

---

## 11. Prompt mínimo para a sessão de implementação

```text
Implementar correções OpenCode na ordem do docs/opencode-runtime-gaps-2026-07-17-final.md §8.
Branch: fix/opencode-heredoc-payload-scan (já tem H1–H4 parciais).
NÃO portar limitações Claude Code. Path normal = Task nativo.
Começar Sprint 0 (residual SHIP + description recovery) depois Sprint 1–3.
Validar com testes unitários existentes + smoke mínimo de validate-plan e dual REVISE.
Não declarar pronto sem hand-record no after Task e dual que bloqueie REVISE.
```

---

## 12. Índice de arquivos-chave

| Área | Paths |
|---|---|
| Validate plan | `core/shared/lib/validate-plan.mjs` |
| Planner contracts | `core/opencode/agents/planner.md`, `skills/creating-plans/**` |
| Orchestration | `skills/orchestrating-delivery/SKILL.md` |
| Ceremony | `ceremony-runtime.mjs`, `plugin/ceremony-coordinator.ts`, `plugin/lib/ceremony-transition.mjs` |
| Dual / loop | `plugin/lib/loop-decide.mjs`, `dual-enforcement.mjs`, `loop-guard.ts` |
| Hand claim | `plugin/obs-hand.ts`, `plugin/lib/dispatch-scope.mjs` |
| Hand record | `hands/run-hand.mjs` (só CLI), `plugin/lib/hand-records.mjs` (read) |
| Capture | `plugin/marker-authority.ts` |
| Push rails | `plugin/lib/bash-decide.mjs` |
| Harvest | `plugin/harvest-guard.ts`, `agents/harvester.md` |
| Schema review | `core/shared/lib/review-report-schema.mjs` |
| Config | `opencode.json`, `core/opencode/opencode.json.example` |
| Routing | `core/opencode/harness.routing.json` |

---

**Done criteria desta varredura:**  
1. Runs OC da VPS inventariadas (DB + 90 gate-states + plans + scope + worktrees).  
2. Cada P0/P1 confirmado/refinado com run e/ou código.  
3. Relatório acionável gravado — **este arquivo**.
