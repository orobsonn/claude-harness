# OpenCode harness — dossiê de gaps e continuidade

**Data:** 2026-07-17  
**Repo:** `/root/dev/claude-harness`  
**Branch de trabalho:** `fix/opencode-heredoc-payload-scan`  
**Objetivo:** mapa do que ainda trava a pipeline OpenCode + handoff para a próxima sessão  
**Escopo desta sessão:** runtime OpenCode (`core/opencode` + `core/shared` usado pelo OC). Claude Code só como contraste (não portar limitações CC).

---

## 1. Como ler este documento

1. **Seção 2** — estado do repo e o que já foi corrigido localmente (sem commit).
2. **Seção 3** — o que a sessão OpenAI anterior fez e onde morreu.
3. **Seção 4** — blockers validados no código (com prova).
4. **Seção 5** — classificação A/B/C (necessário / legado / faltando nativo).
5. **Seção 6** — arquitetura-alvo OpenCode-native.
6. **Seção 7** — o que ainda falta investigar (runs reais em toda a VPS).
7. **Seção 8** — prompt de continuação (copiar na próxima sessão).

**Regra de evidência da próxima sessão:** código sozinho não basta. É obrigatório cruzar com **todas as runs OpenCode** da VPS (sessões no DB, gate-states, hand-records, logs, worktrees).

---

## 2. Estado do repositório (fim desta sessão)

### 2.1 Branch e arquivos modificados (não commitados)

Branch: `fix/opencode-heredoc-payload-scan`

| Arquivo | Mudança |
|---|---|
| `core/opencode/plugin/lib/bash-decide.mjs` | Strip de bodies de heredoc quoted → para de falso-positivo em Markdown/`source` dentro de spec |
| `core/opencode/plugin/lib/bash-decide.test.mjs` | Regressão heredoc |
| `core/opencode/agents/adversary*.md` (4) | Schema JSON estrito; remove `emit BLOCKED` |
| `core/opencode/agents/build.md` | Proíbe inventar campos de review no Task prompt |
| `core/opencode/agents/review-catalog.test.mjs` | Contrato dos adversários |
| `core/opencode/plugin/ceremony-coordinator.ts` | Passa `sessionId` + `featureId` pro recovery |
| `core/opencode/plugin/ceremony-coordinator.test.mjs` | Assert prompt canônico |
| `core/opencode/skills/orchestrating-delivery/SKILL.md` | Prompt de adversary sem SHIP/BLOCK/verdict/mechanism |
| `core/opencode/skills/orchestrating-delivery/ceremony-runtime.mjs` | Prompt canônico de recovery + validação de ids |
| `opencode.json` | `subagent_depth: 5` + permissões task em explore/general |
| `core/opencode/opencode.json.example` | Mesmo que acima (template vendored) |

### 2.2 Hotfixes já prontos (ainda insuficientes para run fluida)

1. Spec via bash heredoc deixa de ser bloqueada por pontuação/Markdown.
2. Adversário primário deixa de ser induzido a `SHIP/BLOCK` / `mechanism` / `sweep`.
3. Recovery de cerimônia monta prompt canônico com path `.opencode/plans/<session>-<feature>/spec.md`.
4. Config OC permite nesting de subagentes (depth 5) e Task em explore/general.

**Reinício obrigatório do OpenCode** após mudar `opencode.json` (config não hot-reload).

### 2.3 Sessões OpenCode relevantes (DB local)

DB: `/root/.local/share/opencode/opencode.db`

| Session ID | Título / papel | Status |
|---|---|---|
| `ses_098af6fe0ffe67u6y4aMTNmTKS` | Erro de identidade / varredura (sessão OpenAI principal) | Completa com auditorias parciais |
| `ses_0950b67cbffe1AXGHi9xHwayye` | Varredura final do harness do OC (esta continuidade) | Continuada aqui |
| `ses_0953c18c7ffeoBSTaJnF2oZZ4V` | Completar auditoria OpenCode | **Interrompida** — recursou e não entregou relatório final |
| `ses_09566454affezDRRyIOMSmN7Jq` | Auditar planejamento reviews | Completa (achados críticos) |
| `ses_095664533ffemT058hU51x2NBE` | Auditar execução hands | Completa (achados críticos) |
| `ses_09566457cffeYvJ2Hps80P12g7` | Auditar cerimônia inicial | Morreu cedo |
| `ses_097a4e95affefVZ3n39TmDmlpm` | Run real (victor) com adversary malformed | Evidência do incidente SHIP/BLOCK |

Projeto consumidor citado no incidente: `/root/dev/victor-pipeline-dados-bot` (feature `bot-price-without-hold`).

---

## 3. História da investigação (resumo factual)

### 3.1 Incidente real que motivou o trabalho

Na run OpenCode do projeto Victor:

- Família 2 (adversário) produziu respostas úteis.
- Família 1 teve **7 dispatches** classificados `malformed`.
- Causa: o `build` pediu no prompt campos proibidos (`mechanism`, `SHIP/BLOCK verdict`); o schema canônico aceita só `{ "issues": [...] }`.
- O parser recusou corretamente; o harness induziu o formato errado.
- Resultado: `CEREMONY_PROOF_REQUIRED` / `canonical spec-adversary result is missing` mesmo com “aprovação” narrativa.

### 3.2 Agente interrompido (último da sessão OpenAI)

**Nome:** Completar auditoria OpenCode (`ses_0953c18c7ffeoBSTaJnF2oZZ4V`)

**Missão original:**

- Completar o que as auditorias parciais não fecharam.
- Classificar cada mecanismo **A** (necessário OC) / **B** (legado CC) / **C** (faltando nativo).
- Achar blockers novos.
- Entregar arquitetura-alvo OpenCode-native.
- **Não** portar limitações do Claude Code.

**O que aconteceu:** o agente só lançou sub-explores recursivos e a sessão morreu sem relatório final. Parte da causa operacional: `subagent_depth` default = 1 (subagente não aninha). Corrigido para 5 nesta sessão.

### 3.3 O que as duas auditorias que terminaram já provaram

- **Planning/reviews:** schema de plano triplo; REVISE libera executor; merge dual desconectado; validate-plan tool ausente; lease 60s; malformed sem cap.
- **Hands/capture/ship:** Task nativa não grava hand-record; capture-verified impossível no path Task; regate não armado; harvest path/guard mortos; final/demo/harvest fora do push gate.

---

## 4. Blockers validados (código) — prioridade

### P0 — trava run real LIGHT/FULL

| ID | Furo | Prova | Impacto |
|---|---|---|---|
| P0-1 | **Três schemas de `locked_tests`** | `planner.md` string; `creating-plans` `{test_path,assertion}`; `validate-plan.mjs` exige `{id,path}` | Planner que segue docs gera plano inválido |
| P0-2 | **`example-plan.json` falha no validator** | 28 erros `id/path required` ao rodar `validatePlan` | Exemplo oficial é inválido |
| P0-3 | **Tool `validate-plan` inexistente** | `core/opencode/tools/` só tem `classify` e `complexity-scorer`; módulo shared sem CLI | Skill/build mandam chamar tool que não existe |
| P0-4 | **`complexity: max` documentado, validator rejeita** | `planner.md` vs `validate-plan.mjs` | Plano com max morre no gate |
| P0-5 | **Task nativa não grava hand-record** | Só `hands/run-hand.mjs` escreve; `obs-hand.ts` só claim | Path OC-native não fecha capture |
| P0-6 | **`capture-verified` exige hand-record DONE** | `marker-authority.ts` | Push LIGHT/FULL impossível só com Task |
| P0-7 | **Skill manda `hand-finished`, não manda `capture-verified`** | `orchestrating-delivery/SKILL.md` | Push bloqueia mesmo com hand “ok” |
| P0-8 | **`REVISE` útil grava dual e libera executor** | `loop-decide.mjs` + `dual-enforcement.mjs` | Plano reprovado pode implementar |
| P0-9 | **`dual_status` global (não por fase)** | Um campo serve plan-review e adversary | Review de plano “satisfaz” dual de adversary |

### P1 — gates mortos / falsa segurança

| ID | Furo | Prova |
|---|---|---|
| P1-1 | **regate-pending nunca armado pela skill** | mark existe; skill step g só re-dispatch adversary em prosa |
| P1-2 | **final/demo/harvest não bloqueiam push** | `bash-decide` só ceremony+dual+regate+capture |
| P1-3 | **harvest-guard morto** | observa tool `harvest` inexistente; return object em vez de throw |
| P1-4 | **harvester path sem `sessionID`** | `.opencode/plans/<feature_id>/…` vs canônico `<sessionID>-<feature_id>` |
| P1-5 | **merge dual (driveDualEye) não plugado no runtime** | módulo/skill; loop-guard só grava hashes/status |
| P1-6 | **malformed não consome cap útil** | só useful incrementa `plan_review_count` → loops tipo 7 adversaries |
| P1-7 | **PLAN_WRITE_LEASE = 60s** | `planner-state.mjs` — write lento vira delivery-blocked |
| P1-8 | **Recovery Task sem `description`** | `ceremony-runtime` emite só `subagent_type` + `prompt` |

### P2 — identidade / legado / coerência

| ID | Furo | Prova |
|---|---|---|
| P2-1 | **`command` e `task_id` oficiais do Task reinterpretados** | `hook-identity.mjs` / `extractSubagentType` — conflito com resume oficial e role |
| P2-2 | **Skill equipara Task e run-hand** | no OC routing normal é Task; run-hand é legado CLI |
| P2-3 | **`model_strategy` com opus/sonnet/haiku** | legado CC; runtime OC usa frontmatter + `harness.routing.json` |
| P2-4 | **`isTaskTool` inconsistente** | gates sem `agent`; loop-guard só `"task"` |
| P2-5 | **Composition shadow** | se faltar plugin de scope, bash no hand deixa de ser hard-deny |
| P2-6 | **build `edit:deny` + bash allow** | isolamento de autoria nominal (pode escrever via bash fora de active_dispatch) |
| P2-7 | **validator aceita planos estruturalmente inúteis** | scope/criterion vazios, depends_on fantasma, sem final_review, etc. |

### Hotfix local (P0 operacional já mitigado no working tree)

| ID | Furo | Status |
|---|---|---|
| H1 | Heredoc spec falso-positivo | Corrigido local |
| H2 | Prompt adversary com SHIP/BLOCK/mechanism | Corrigido local |
| H3 | Recovery sem prompt canônico | Corrigido local (ainda falta `description`) |
| H4 | `subagent_depth` = 1 bloqueava nesting | Corrigido → 5 |

---

## 5. Classificação A / B / C

### A — necessário no OpenCode

- Entry: `triaging-requests`, tool `classify`, `entry-gate`
- Ceremony: tools `mark`, `ceremony-next`, seals HMAC
- Plan: planner Task, planner-recovery, plan binding, plan-gate
- Dual status **como enum** (não boolean)
- Fidelity rail, active_dispatch scope, plan-write-gate
- Delivery bash rails em `git push` / `gh pr create|merge`
- Loop-guard de useful reviews
- Routing: agent frontmatter + `harness.routing.json`
- Dispatch: `task({ description, prompt, subagent_type })` + marker `[HARNESS_TASK_CONTEXT]`

### B — legado Claude Code / desnecessário no path OC normal

- `hands/run-hand.mjs` + `opencode run` + agents `*-spawn` (só se CLI headless for requisito explícito)
- `mark-gate.mjs` como “mark de estado” (é obs-only)
- `model_strategy` com aliases Claude no plan
- Prosa de skill que manda spawn/run-hand como path default
- Portar `claude -p` / process spawn para modelo barato (OC resolve model no agent file)

### C — ausente ou quebrado (implementar nativo no OC)

- Schema único de plan + tool `validate-plan` + example-plan válido
- Hand-record writer no after de Task (path nativo)
- Capture-verified no fluxo skill + oracle host-side
- dual por fase + REVISE não libera hand + merge wired
- regate auto-arm
- Ship preconditions: final review (+ demo se interactive) + harvest se for gate real
- harvest-guard reescrito ou removido; harvester paths com sessionID
- Cap de malformed/failure streak
- Identity hygiene (não mapear `command`/`task_id` oficiais para role/task de plano)
- Ceremony recovery Task com `description`
- Ajuste PLAN_WRITE_LEASE se evidência de runs reais mostrar timeout

---

## 6. Arquitetura-alvo OpenCode-native (pragmática)

1. **Um path de hand:** só `task(subagent_type)` + model no frontmatter/routing. Deprecar run-hand do loop interativo.
2. **Schema único de plan** em `shared/validate-plan` + tool OC `validate-plan`: locked_tests = `{ id, path, assertion, fixture_paths? }`; complexity `low|medium|high`; sem model_strategy Claude.
3. **Hand-record no after de Task writing-hand** (obs-hand ou plugin dedicado): outcome DONE|…, touched paths, freeze SHA; mesmo path que `handRecordPath`.
4. **Dual por post:** `dual_status.plan_review` e `dual_status.adversary` (ou equivalente namespaced); executor só se plan_verdict === APPROVE e dual recorded; REVISE nunca desbloqueia hands.
5. **Wire merge dual no host** (loop-guard/obs-eye), não só skill.
6. **Regate armado deterministicamente** após sniper-high (e medium irreversível).
7. **Ship preconditions completas** em `bash-decide` (capture + regate + final; demo se interactive).
8. **Tools mínimas:** classify, mark, validate-plan, complexity-scorer, ceremony-next, verify.
9. **Identity:** runtime envelope + HARNESS_TASK_CONTEXT; não reutilizar campos oficiais Task para domínio harness.
10. **Recovery ceremony:** `{ description, prompt, subagent_type }` completo.

---

## 7. O que a próxima sessão DEVE fazer (ainda não feito)

### 7.1 Obrigatório: varredura de runs reais em toda a VPS

Não confiar só em leitura de código. Coletar e correlacionar:

1. **OpenCode DB(s)**  
   - Primário: `/root/.local/share/opencode/opencode.db`  
   - Qualquer outra cópia sob `/root`, home de usuários, worktrees, containers, se existirem.

2. **Sessões**  
   - Todas com `directory` em projetos da VPS (não só claude-harness).  
   - Filtrar agent=build e subagents; extrair denials `[entry-gate]`, `[plan-gate]`, `[obs-hand]`, `[plan-write-gate]`, `malformed`, `delivery-blocked`, `CEREMONY_PROOF_REQUIRED`, identity conflict.

3. **Gate-states e plans**  
   - `**/.opencode/plans/.state/**/gate-state.json`  
   - `**/.opencode/plans/**/execution-plan.json`  
   - `**/.opencode/plans/**/spec.md`  
   - hand-records: `**/.opencode/plans/.state/hand-records/**`

4. **Logs**  
   - `/root/.local/share/opencode/log/**`  
   - logs de projetos (victor, outros)

5. **Worktrees / sandboxes**  
   - `/root/harness-worktrees/**`  
   - qualquer `oc-data-*` / state dirs de headless

6. **Cruzamento**  
   - Cada denial de log/sessão → arquivo:linha do harness que o produz.  
   - Classificar: bug de harness vs uso errado vs legado CC na skill.  
   - Contar frequência por tipo de furo (quantas runs morreram em cada fase).

### 7.2 Entregável final da próxima sessão

Um **relatório completo e acionável** (atualizar este arquivo ou criar successor versionado) com:

1. Inventário de runs analisadas (paths + session ids + projetos).  
2. Tabela de falhas reais por fase (contagem + exemplos).  
3. Lista priorizada do que **ainda** precisa ser ajustado no harness OC (P0/P1/P2), com path:linha.  
4. Separação A/B/C atualizada com evidência de run (não só código).  
5. Plano de correção ordenado (sem implementar CC; sem portar limitações CC).  
6. O que já está ok e não reabrir.

### 7.3 Config OC para a investigação

Já no repo:

```json
"subagent_depth": 5,
"agent": {
  "explore": { "permission": { "task": "allow", ... } },
  "general": { "permission": { "task": "allow", ... } }
}
```

Reiniciar OpenCode antes de confiar em nesting.

Cada agente de investigação **pode e deve** chamar outros agentes quando aumentar cobertura (sem recursão infinita: depth máx 5; preferir 1–2 níveis com missões fechadas).

---

## 8. Prompt de continuação (colar na próxima sessão)

```text
Continua a varredura FINAL do harness OpenCode do claude-harness. NÃO recomece do zero.

## Contexto obrigatório (ler primeiro)
1. Abra e leia por completo:
   /root/dev/claude-harness/docs/opencode-runtime-gaps-2026-07-17.md
2. Branch de trabalho (diff local NÃO commitado):
   fix/opencode-heredoc-payload-scan
3. Sessões OpenCode anteriores no DB:
   /root/.local/share/opencode/opencode.db
   - ses_098af6fe0ffe67u6y4aMTNmTKS (investigação OpenAI)
   - ses_0950b67cbffe1AXGHi9xHwayye (continuidade)
   - ses_0953c18c7ffeoBSTaJnF2oZZ4V (agente "Completar auditoria" interrompido)
   - ses_09566454affezDRRyIOMSmN7Jq / ses_095664533ffemT058hU51x2NBE (auditorias que terminaram)
   - ses_097a4e95affefVZ3n39TmDmlpm (run real Victor / adversary malformed)
4. Hotfixes locais já no working tree: heredoc, contrato adversary, recovery prompt, subagent_depth=5.
   Config não hot-reload: se acabou de reiniciar, ok; se não, reinicie antes de confiar em nesting.

## Missão (incansável até fechar)
Fazer busca EXAUSTIVA do que ainda trava a pipeline OpenCode e gerar relatório completo do que ainda precisa ser ajustado no harness OC.

### Regra de ouro
Código sozinho NÃO basta. Você DEVE analisar runs reais de OpenCode em TODA esta VPS:
- todos os opencode.db / storage / log sob /root e homes relevantes
- todos os projetos com .opencode/plans e .opencode/plans/.state
- hand-records, gate-states, execution-plan.json, specs
- worktrees (/root/harness-worktrees e afins)
- correlacionar denials de sessão/log com path:linha do harness

### Arquitetura (não negociar)
- Foco EXCLUSIVO OpenCode.
- NÃO propor portar limitações do Claude Code.
- No OC, Task nativa resolve subagent_type → agent frontmatter/model/routing.
- run-hand / opencode run / *-spawn NÃO são path normal de routing (legado CLI).
- Classificar cada mecanismo: A necessário | B legado CC desnecessário | C ausente/quebrado nativo.

### Já conhecidos (do dossiê — validar com runs, não “redescobrir” sem evidência)
P0: locked_tests triplo; example-plan inválido; validate-plan tool ausente; complexity max; Task sem hand-record; capture-verified impossível no path Task; skill sem capture-verified; REVISE libera executor; dual_status global.
P1: regate não armado; final/demo/harvest fora do push; harvest-guard morto; harvester path sem sessionID; merge dual desconectado; malformed sem cap; PLAN_WRITE_LEASE 60s; recovery sem description.
P2: command/task_id oficiais confundidos; skill Task≈run-hand; model_strategy Claude; isTaskTool inconsistente; composition shadow; build bash write; validator frouxo.

### Como trabalhar
1. Use agentes (explore/general e papéis canônicos quando couber). CADA agente PODE chamar outros agentes (subagent_depth=5). Parallelize por fase/projeto. Evite recursão inútil: missões fechadas, 1–2 níveis de nesting, retorno com evidências.
2. Para cada furo: (a) path:linha, (b) reprodução mínima, (c) se aparece em run real (session id + projeto), (d) A/B/C, (e) severidade.
3. Procure blockers NOVOS além da lista, especialmente só visíveis em runs (timeouts, identity conflict, stale lease, dual reusado, capture vazio, etc.).
4. NÃO implemente correções grandes ainda — primeiro fechar o mapa com evidência de run. Se achar bug trivial 1–2 arquivos com prova, pode corrigir; senão só documentar.
5. Atualize o dossiê (ou crie docs/opencode-runtime-gaps-<data>.md successor) com:
   - inventário de runs/projetos vasculhados
   - tabela de falhas reais por fase (contagens + exemplos)
   - lista priorizada do que ainda falta ajustar no harness OC
   - A/B/C atualizado
   - plano de correção ordenado (P0→P1→P2)
   - o que está ok e não reabrir

### Critério de done
Só termine quando:
1. Tiver vasculhado sistematicamente as runs OC da VPS (não só claude-harness).
2. Cada P0/P1 do dossiê estiver confirmado, refutado ou refinado com evidência de run OU de código inequívoca.
3. O relatório final estiver gravado em docs/ e for acionável para começar a codar na sessão seguinte.

Comece lendo o dossiê e listando todos os opencode.db / .opencode/plans da VPS. Depois dispare agentes em paralelo por cluster de projetos/fases.
```

---

## 9. Notas rápidas para o operador

- Diff local **não commitado** — não perde se não der reset hard; não misturar com release sem revisar.
- Hotfixes atuais **não** bastam para declarar harness pronto.
- Próximo passo de produto após o relatório: implementar na ordem P0 (schema plan + hand-record Task + REVISE/dual) antes de nova run de teste de feature.

---

## 10. Índice rápido de arquivos-chave

| Área | Paths |
|---|---|
| Validate plan | `core/shared/lib/validate-plan.mjs` |
| Planner contracts | `core/opencode/agents/planner.md`, `skills/creating-plans/**` |
| Orchestration skill | `core/opencode/skills/orchestrating-delivery/SKILL.md` |
| Ceremony recovery | `skills/orchestrating-delivery/ceremony-runtime.mjs`, `plugin/ceremony-coordinator.ts` |
| Dual / loop | `plugin/lib/loop-decide.mjs`, `plugin/lib/dual-enforcement.mjs`, `plugin/loop-guard.ts` |
| Hand claim | `plugin/obs-hand.ts`, `plugin/lib/dispatch-scope.mjs` |
| Hand record (só run-hand) | `hands/run-hand.mjs`, `plugin/lib/hand-records.mjs` |
| Capture mark | `plugin/marker-authority.ts` |
| Push rails | `plugin/lib/bash-decide.mjs`, `plugin/entry-gate.ts` |
| Harvest | `plugin/harvest-guard.ts`, `agents/harvester.md` |
| Config OC | `opencode.json`, `core/opencode/opencode.json.example` |
| Routing | `core/opencode/harness.routing.json` |
