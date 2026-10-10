# Pi: execução paralela em worktrees filhas — mapa completo e plano de port para Claude Code

Data: 2026-10-10. Fonte: leitura de `core/pi/` em `main@22cb5ca` (v3.3.2). Referências `arquivo:linha`
relativas a `core/pi/` salvo indicação. Nada foi alterado no código.

> **Atenção — base desatualizada.** Mapeado em `22cb5ca` (v3.3.2). `origin/main` está em `986dc5b`
> (v3.7.5), com ~1700 linhas alteradas na camada de tasks (`task-coordinator`, `task-receipts`, `task-run`,
> `task-orca`, `task-reconciliation`, `task-plan-recovery`, `harness-task-runtime.md`, `harness-task-pipeline`),
> incluindo "readable names for child task worktrees" (#1105). Os números de linha e alguns detalhes
> (ex.: naming de worktree/branch) podem ter mudado; revalidar contra `origin/main` antes de portar.

Siglas: **CO** `lib/task-coordinator.mjs` · **EXT** `extensions/harness-tasks.ts` · **TP** `lib/task-process.mjs`
· **W** `bin/pi-task-worker.mjs` · **L** `bin/pi-harness.mjs` · **TR** `lib/task-receipts.mjs` · **TRun**
`lib/task-run.mjs` · **CT** `lib/task-contract.mjs` · **TC** `lib/task-context.mjs` · **ORCA** `lib/task-orca.mjs`
· **RA** `lib/task-runtime-assets.mjs` · **MA** `lib/marker-authority.mjs` · **PRE** `lib/pi-review-evidence.mjs`.

---

## 1. Modelo mental (uma tela)

```
PAI GLOBAL (sessão Pi top-level na worktree principal, branch da feature)
  triage → spec → plano aprovado (plan_review_evidence host-owned)
  harness_tasks dispatch [a,b,c]  (≤3, escopos disjuntos, deps já integradas)
     │  para cada task: grant imutável + git worktree add -b harness/task-<t>-<attempt> <base_sha>
     │  copia plano/spec/node_modules/runtime → worktree; grava job.json
     │  spawn detached: pi-task-worker (supervisor) → --child shim → pi-harness --harness-task <grant>
     ▼
  PAI LOCAL (sessão Pi top-level NOVA, cwd = worktree filha, env PI_HARNESS_TASK_RUN)
     prompt de sistema = harness-task-runtime.md + envelope [HARNESS_TASK_RUN]{contract}
     pipeline nativa só da task: test-author → RED → test-reviewer → freeze commit → mark fidelity
       → executor → commit seletivo → mark capture-verified → olhos (FULL) → sniper/regate
     NÃO pode: classify/spec/plano, harness_tasks, push/merge/rebase/PR/deploy, harvest, final review
     termina → worker grava result.json
  harness_tasks wait   (host espera: Orca `terminal wait` ou poll 5s; zero chamadas ao modelo)
  harness_tasks status (host INSPECIONA a worktree + events.jsonl → recibo host-task-inspection → ready|blocked)
  harness_tasks integrate {task_id, attempt_id, expected_head}
     → re-inspeciona, merge-tree sem conflito, frozen blobs intactos, journal, git merge --no-ff
     → recibo host-task-integration → dependentes podem ser despachados
  harness_tasks resume {task_id, attempt_id, instruction}  (mesma worktree/sessão local)
  após todas integradas: revisão final dual/triad + suite no HEAD agregado → harvest → ship
```

Princípios que sustentam tudo:
1. **Host é a autoridade.** O filho não reporta "pronto"; o host *deriva* o resultado por inspeção de Git +
   stream nativo de eventos + estado gravado por hooks. Texto do modelo nunca aprova nada.
2. **Pai local é top-level, não subagente.** Tem gates próprios (mark, reviews), restringidos pelo binding de task.
3. **Sem scheduler automático.** O modelo do pai escolhe o lote; o coordenador só valida (deps, escopo, limite).
4. **Fail-closed + idempotente + durável.** Registry com lock e escrita atômica; jobs sobrevivem ao pai; journal de merge.
5. **Nunca há limpeza** de worktrees/branches/jobs (retidos para resume/auditoria).

---

## 2. Superfície da ferramenta `harness_tasks` (EXT:146-284, CO:679-1203)

`executionMode: "sequential"`. Identidade (`projectRoot`, `sessionId`, `isChild`, modelo, Orca) vem **sempre do
host**, nunca de parâmetro (EXT:234-245).

| Ação | Campos permitidos (lista estrita, CO:679-685) | Efeito |
|---|---|---|
| `dispatch` | `task_ids` (1-3), `task_contexts[{task_id,content≤2KiB}]` | cria grant/worktree/job e lança; idempotente para tasks já registradas |
| `status` | `task_id?` (+ `wait_seconds` 0-30, default 20, só no adaptador) | observa processos, inspeciona, grava `ready`/`blocked` |
| `wait` | `task_id?` | espera no host até alguma `running` mudar; `settled|changed|aborted` |
| `integrate` | `task_id, attempt_id, expected_head` | merge `--no-ff` verificado + recibo |
| `resume` | `task_id, attempt_id, instruction?(≤16000)` | relança mesma tentativa/sessão local |
| `abandon-resume` | `task_id, attempt_id, expected_head, no_product_obligation:true, reason(≤4000)` | desiste de uma correção pós-integração sem delta, restaurando o recibo |

Retorno: JSON em `content[0].text` + `details`; erro com `isError` e prefixo `[harness-tasks:<action>] [harness_tasks]`.
`summary(entry)` (CO:201-227): `{task_id, attempt_id, status, worktree, session_id, child_head, orca?,
context_return? (só ready/integrated), reason?, launches[{run_id,pid,events_path,orca?}], integration?, abandoned_resumes?}`.
`status` também devolve `diagnostics[task_id]` **não persistidos** (task_report, hand_report, review_findings,
launch_failure, worktree_changes; textos ≤6000).

Gates externos: filho nunca usa `harness_tasks` (TRun:448); com cerimônia suspensa só `status/wait`
(`policy.mjs:177`); `status/wait` sem lease, demais com lease exclusivo (`pi-review-concurrency.mjs:171-181`);
após admissão, `classify/harness_spec_write/seal_spec_review` bloqueados no pai (CO:1206-1240).

---

## 3. Estado durável

### 3.1 No pai global (`<root>/.pi/harness/state/<parentSession>/task-runs/`)

| Path | Conteúdo |
|---|---|
| `index.json` (+`.lock`) | registry |
| `worktrees/<attemptId>/` | worktree da task (backend local) |
| `jobs/<attemptId>/<runId>/{job.json,process.json,events.jsonl,stderr.log,result.json}` | um diretório por launch |
| `runtime/<baseSha>/` | checkout `--detach` do runtime (só no repo-fonte do harness) |
| `admitted-execution-plan.json` | projeção legível do plano admitido |

Tudo sob `.pi/harness/state` é gitignored → worktrees aninhadas não sujam o pai.

**Lock** (CO:706-712, `opencode/lib/gate-state.mjs:204-298`): `{token,pid,createdAt}` com `wx`, espera 5 ms
("task coordinator busy; observe or retry"), stale só se >30 s **e** pid morto; liberação compare-and-delete.
**Escrita atômica** `writeTaskJson` (TP:32-39): tmp `0600` + rename; `revision++` a cada persist.

**Registry** `{version:1, parent_session_id, feature_id, plan_sha256, spec_sha256, runtime_base_sha, revision,
orca_parent?, plan_snapshot?, integration_intent?, correction_barrier?, correction_barrier_stack?, tasks:{id:entry}}`.

**Entry** (CO:986-1005): `task_id, attempt_id(uuid), parent_session_id, parent_root, feature_id, plan_sha256,
spec_sha256, base_sha, runtime_base_sha, worktree, branch, grant_path, grant, job_dir, status
(preparing|running|ready|blocked|integrated), launches[], result, integration, reason?, runtime{launcher_path,sha256},
orca?, integration_history[], result_history{sha:result}, reconciliation_required?, reconciliation_intent?,
reconciliations[], abandoned_resumes[]`.

**Grant** imutável (CO:957-985), gravado em `<worktree>/.pi/harness/state/task-admission/<attemptId>.json`:
```
{version:1, kind:"task-run", parent_session_id, parent_root, attempt_id, feature_id, task_id,
 cwd:<worktree>, branch, base_sha, plan_sha256, spec_sha256,
 context_handoff?:{version:1, kind:"curated-task-context", parent_session_id, task_id,
                   source_shared_context_sha256|null, content_sha256, content},
 origin:{kind:"parent-approved-plan", plan_review_call_id},
 dependencies:[{task_id, child_head, integrated_head, receipt_sha256, receipt}]}
```
Claim `<grant>.claim = {session_id, grant_sha256}` criado com `wx` pelo filho na admissão.

### 3.2 Na worktree filha

`.pi/harness/state/task-admission/<attempt>.json(+.claim)` · `state/<childSession>/gate-state.json` (markers
da task) · `state/<childSession>/shared_context.md` (diário → `context_return`) · `state/<childSession>/evidence/`
· `state/hand-records/<feature>/<childSession>/<task>.json` · `state/<parentSess>/dispatch-records/<sha(callId)>.json`
· `state/model-profiles/<childSession>.json` · `sessions/*_<childSession>.jsonl` · `runtime/` · `plans/<feature>/{execution-plan.json,spec.md}` · `node_modules/` (cópia).

Gate-state inicial do filho (TRun:275-285) — **sem evidência pré-fabricada**:
```
{session_id, feature_id, mode, peak_mode, classified:true, triaged:true, task_pipeline_version:1,
 classification_source:"delegated-task",
 task_run:{grant_path, grant_sha256, parent_session_id, attempt_id, task_id}}
```
`gateState.task_run` presente é o discriminador universal lane × pai global.

---

## 4. Admissão, DAG e congelamento

**Quem pode coordenar** (CO:132-154): sessão não-filha, gate-state com `task_run` ausente,
`task_pipeline_version===1`. **Plano aprovado** (CO:155-200): spec aprovada + `plan_review_evidence`
`{written_by:"host-subagent-completion", role:"harness-plan-reviewer", verdict:"APPROVE", dispatch_call_id,
child_session_id, agent_id, plan_sha256, spec_sha256}` batendo com os hashes atuais; `validatePlan(expect:"full")`
(refs e ciclos de `depends_on`).

**Congelamento:** primeira ação fixa `plan_sha256/spec_sha256` no registry. Spec mudou → erro. Plano mudou → só
aceito via `readTaskPlanAuthority` (TPR:100-126): novo APPROVE + `plan_snapshot` + `validateTaskScopeRecovery`
(mesmas tasks; `scope_paths/allowed_writes/locked_tests` só crescem por append). Mudança real de plano = nova sessão.

**Fluxo `dispatch`** (CO:867-1022) — tudo validado antes de qualquer efeito (lote atômico):
1. 1..3 ids distintos e existentes; `task_contexts` validados (imutáveis se já admitidos).
2. Nenhuma nova → retorna summaries (idempotente).
3. `requireClean(pai)` ignorando `.pi/harness/{state,runtime,sessions,plans}/`, `node_modules/`.
4. `base_sha = HEAD` do pai (mesmo para todo o lote); `runtime_base_sha ??= base`.
5. **Limite:** `running|preparing` persistidos + novas ≤ `MAX_PARALLEL_TASKS=3` (CO:46, hardcoded; usa status
   persistido, não revalidado).
6. **Deps:** cada `depends_on` precisa `status==="integrated"`, `integrated_head` ancestral de `base` e
   `readIntegratedTaskEvidence` ok (TR:959-997).
7. **Escopo:** `scopeOf` (CO:92-119) = `scope_paths ∪ allowed_writes ∪ locked_tests.path ∪ fixture_paths`;
   sem globs (`*`,`?`,`{a,b}`,`{1..3}`), sem `..`; overlap = igual ou prefixo por componente; compara com
   **todas** não integradas (inclusive `ready`/`blocked`) e com o próprio lote.
8. Persiste entries, depois `prepareWorktree` + `launchTask` por task; falha aqui deixa só aquela `blocked`.

**Barreira de correção** (CO:850-866): enquanto uma task integrada está sendo corrigida, `dispatch` e ações em
outras tasks são recusadas (exceto resume de ancestral do dono e integrate idempotente).

---

## 5. Worktree e lançamento do filho

### 5.1 `prepareWorktree` (CO:494-577)
- Local: `git -C <root> worktree add -b harness/task-<t>-<attempt> <task-runs/worktrees/<attempt>> <base_sha>`;
  confere branch e ancestralidade sempre ("reserved task worktree changed identity").
- Copia `execution-plan.json` + `spec.md`, `node_modules` (`cpSync` com `verbatimSymlinks`, nunca symlink),
  `runtime/{settings,subagents,harness}.json` se ausentes; grava grant se ausente.
- **Runtime imutável** (RA:118-214): vendorizado → launcher da própria worktree; repo-fonte → checkout `--detach`
  em `runtime/<baseSha>` (mudança de produto não altera o runtime que executa a task); hash sha256 dos assets
  gravado em `entry.runtime` e reverificado em cada launch (falha → erro genérico, antes do filho).

### 5.2 `launchTask` (CO:578-662) + `startTaskProcess` (TP:383-480)
- `runId=uuid`; registro do launch persistido **antes** do spawn; status `running`, `result/integration=null`.
- `job.json` (0600): launch + `cwd, command=process.execPath, args, runtime, timeoutMs(2h), profile_environment?`
  (só `PI_HARNESS_MODEL_PROFILE{,_SHA256}` atravessam — nenhum segredo).
- Linha de comando:
  ```
  node <launcher> (--harness-task <grant> | --harness-resume <claim.session_id>)
       (--no-approve | --mode json -p) [--thinking L] [--provider P --model M] <prompt>
  ```
  `presentation`: `tui` com Orca, `json` local; herdada da primeira launch. Prompt padrão: "Execute the admitted
  task using the task pipeline… Return only after the task is ready for host integration."; no resume é a
  `instruction`; variantes fixas para conflito de merge e reconciliação.
- Spawn local: `spawn(node,[pi-task-worker.mjs, job.json],{detached:true,stdio:"ignore"}).unref()`.
- Falha de spawn: `start_failure{written_by:"host-task-launch"}`, `blocked`.

### 5.3 Árvore de processos (W)
```
supervisor (W, grava process.json, verifica runtime, timeout 2h, SIGTERM/INT/HUP → mata grupo)
  └─ shim `--child` (detached, process group próprio = process_group)
       └─ node pi-harness.mjs --harness-task …  (cwd = worktree)
            └─ spawnSync pi CLI  (a sessão do PAI LOCAL)
```
- `events.jsonl`: JSON mode = stdout do Pi; TUI = extensão `harness-task-events`.
- Fim: supervisor espera o grupo esvaziar (netos inclusos), grava `result.json
  {version, run_id, pid, exitCode, signal, timedOut, ended_at, error?, run_runtime_sha256}`.
- Env saneado (W:81-98): remove `HARNESS_DISPATCH_*`, `PI_SUBAGENT_*`, `PI_HARNESS_RESUME`, `PI_HARNESS_TASK_RUN`,
  `PI_HARNESS_TUI_JOB_FILE`, e `ORCA_*` fora do modo terminal.
- **Sem heartbeat.** Liveness = pid + start ticks (`/proc` ou `ps lstart`), membros do process group, varredura
  exata de argv do worker. Identidade ilegível = `unknown`, nunca "morto".
- **Não existe cancelamento** pelo pai: abort de `wait`/`status` e morte do pai não matam a task.

### 5.4 Launcher no filho (L:480-710)
1. Apaga `PI_HARNESS_TASK_RUN` herdado; lock por worktree `parent-orchestrator.lock`.
2. `inspectTaskAdmission` (TRun:236-260), read-only: grant canônico, `cwd===realpath(worktree)`, hashes de
   plano/spec iguais na worktree e no pai, plano válido, task existe sem globs, gate-state do pai bate, deps com
   recibos/ancestralidade, branch == grant (≠ main/master), HEAD==base_sha, árvore limpa, sem claim/state prévio.
3. Prompt: `harness-task-runtime.md` **substitui** o runtime global + envelope (§6) + prompt do perfil.
4. `admitTaskRun`: cria `.claim` (wx) e gate-state local (wx); se o prompt divergir do preview → rollback.
5. Reestabelece `PI_HARNESS_TASK_RUN={cwd,sessionId}`; spawn do Pi com extensões (policy, task-events, task-run,
   bootstrap, subagents…) e `--append-system-prompt`. Falha → `rollbackTaskAdmission` (só remove estado pristino).

### 5.5 Envelope `[HARNESS_TASK_RUN]` (TRun:513-539)
```
{"resumed": bool,
 "contract": {feature_id, task:<task canônica>, dependencies, plan_sha256, spec_sha256,
   plan_path, spec_path, binding:{grant_path, grant_sha256, parent_session_id, attempt_id, task_id},
   dispatch_routes:{<role>:{model, thinking?, complexity?}}   // 7 roles; complexity só p/ author/executor/sniper
   context_handoff?}}
```
Roles da lane (TRun:31-39): test-author, executor, sniper, test-reviewer, compliance, adversary, security.

---

## 6. Restrições do pai local

**Por prompt** (`prompts/harness-task-runtime.md`): só `contract.task`; não classifica/replaneja/coordena outra
task/harvest/final review/integração/push/PR/release/deploy; handoff é não confiável; orquestra, não escreve
produto; todo dispatch novo (sem `resume`, `run_in_background`, `max_turns`); marcadores obrigatórios; rotas
literais; bash em série; `harness_memory` só read/update; retorna SHAs, IDs, comandos, recibos.

**Por código** (`extensions/harness-task-run.ts` + `decideTaskRunTool`, TRun:441-476), revalidando o binding
(grant, claim, gate-state, hashes do pai) **a cada tool call**:
- Nega tools `classify, harness_spec_write, seal_spec_review, harness_plan, harness_tasks, run_hand`.
- `subagent`: role ∈ TASK_ROLES; exatamente um `[HARNESS_TASK_CONTEXT]{"task_id":"<a dele>"}`; proíbe
  `[HARNESS_FINAL_REVIEW]`; model/thinking iguais à rota.
- `mark`: só `fidelity, hand-finished, capture-verified, regate-pending, regate-passed` e só para o próprio task_id.
- `harness_memory`: nega `apply/reconcile/finalize`.
- bash: nega `git -<flag>` global, `git push|pull|merge|rebase|tag` (exceto `git merge-base …` isolado),
  `gh pr|release|issue create|merge|edit|close`, `npm|pnpm run deploy`, `wrangler deploy|publish`.
- `checkTaskRepairPreservation` (TRun:479-510): antes de test-author ou `git restore|checkout|reset|clean|stash`,
  o delta de produto no escopo precisa estar commitado.
- Subagentes do pai local só são aceitos com `child-identity` registrando `parent_session_id === owner`.

---

## 7. Pipeline dentro da lane e quem enforça

Ordem (prompt `:63-72`): test-author → RED executável → `harness-test-reviewer` APPROVE → freeze commit (só frozen
paths) → `mark fidelity` → executor → verificar + commit seletivo → `mark capture-verified` (árvore limpa) →
olhos (FULL: compliance; adversary se `adversarial.enabled`; security por trigger) → sniper/regate → `regate-passed`.
`no_tests:true` + `locked_tests:[]` no contrato canônico pula autoria/freeze.

| Etapa | Enforcement |
|---|---|
| fidelity | `validateTaskFidelityFreeze` (TRun:384-438): último test-author completo; reviewer posterior APPROVE antes de outro writer; `git commit` posterior linear, só frozen paths, blobs iguais em HEAD; 1º stamp exige HEAD==freeze. Payload `fidelity_pass += feat/task@freeze` |
| executor/sniper | `entry-gate.mjs:994-1025`: `fidelity_pass` exato (salvo `no_tests`), dispatch-record criado; `regate_pending` de outra task bloqueia |
| fim da mão | `recordPiHandFinished` (`entry-gate.mjs:1113-1300`): hand-record `{featureId, taskId, sessionId, producerCallId, producerClaimedAt, freezeCommitSha(=HEAD), outcome, touchedPaths, scopeViolations, frozenViolations, agent, …}`; violação força BLOCKED; FULL arma `regate_pending` |
| capture-verified | MA:477-539: exige `hand_finished`, record elegível, produtor exato (dispatch-record), SHA **do record** (ignora args), ancestral de HEAD; grava `capturedVerifiedAt`, `capture_origin{…, worktree_clean}` |
| olhos | `checkPiReviewPreparation` exige tudo commitado; recibo placeholder no dispatch, recibo final no `tool_execution_end` com `input_digest` (HEAD+index+worktree+plano+spec) estável e relatório JSON canônico |
| regate-passed | MA:466-476: ≥1 recibo aceito com `reviewed_head_sha===HEAD` e digest atual |

> Gap conhecido: "capture-verified antes do executor" (pós-freeze) só existe no prompt.

**Concorrência intra-lane** (`pi-review-concurrency.mjs`): escalonador FIFO; writers/autoria/fidelidade exclusivos;
olhos de implementação/final como readers até `maxParallelEyes` (1-3, default 3); **cada bash é lease exclusivo**
(bash serializado por lane); `run_in_background` proibido.

**`affected_roles`** (`harness-reviews.ts:43-167`): reabre só papéis aceitos cuja obrigação mudou, com delta
material desde a fronteira de HEADs aceitos; token one-shot por digest. HEAD novo sozinho não reabre olho irmão.

---

## 8. Espera, inspeção e recibos

**`wait`** (EXT:67-130), fora do lock, sem modelo: status → se nada `running`, `settled`; loop: corrida entre
`orca terminal wait --for exit --timeout-ms 300000` por handle e/ou `delay(5000)` local; handle stale é aposentado;
relê status; `changed` se status ou último `run_id` mudou. Sem timeout total. Exit do terminal é só "acorde".

**`status`** (CO:758-818): para cada não integrada → conflito/reconciliação pendente → `blocked`; sem launch →
`blocked`; launch não terminal (`readTaskProcess`, TP:195-380) → `running`; senão `inspectTaskRun` → `ready` (grava
`result`) ou `blocked`+diagnostics.

**`inspectTaskRun`** (TR:498-783) — o coração. Checa em ordem: raízes canônicas; launches terminais e o último
com exit 0/sem sinal/sem timeout; claim+binding; recibos de deps; HEAD descende de base; `events.jsonl` com
exatamente uma sessão == claim; worktree limpa; diff dentro do escopo; executor/sniper bem-sucedido observado nos
eventos; hand-record elegível com `capturedVerifiedAt` e freeze ancestral; produtor == chamada nativa real; fidelity
reconstruída dos eventos; markers `fidelity_pass`, `hand_finished`, `capture_verified@freeze`; reviews atuais;
regate absolvido.

**Recibo `host-task-inspection`** (TR:728-779): identidades, hashes plano/spec, `base_sha, scope_base_sha,
reconciliation_sha256, child_head, changed_paths, freeze_sha, frozen_blobs{path:sha256}, hand_capture{agent,
producer_call_id, producer_launch_index, freeze_sha, captured_verified_at, capture_marker}, review_input_digest,
review_receipts{role:{agent_id, dispatch_call_id, child_session_id, input_digest, report_digest,
reviewed_head_sha}}, context_return, regate, launches[…]`.

**Integridade:** sem assinatura; `sha256(stableJson)` com chaves ordenadas (CT:18-28), encadeado por hash e
**revalidado contra Git + eventos a cada leitura**. Ameaça de processo do mesmo usuário fora do escopo (MA:6-12).

**`context_return`** (TC:74-122): diário `shared_context.md` da sessão local lido com HEAD estável; exposto só em
`ready/integrated`; o pai cura manualmente para a própria memória.

---

## 9. Integração (CO:1150-1203)

1. `attempt_id` exato; `expected_head` 40-hex; já integrada com mesmo head → ok idempotente.
2. `verifyRuntime`, `taskScopeBase` (sem reconciliação pendente).
3. **Re-roda `inspectTaskRun`**; `result.child_head === expected_head` (tip de branch nunca substitui).
4. Pai limpo; `base_sha` ancestral do HEAD do pai.
5. `git merge-tree --write-tree --name-only -z` — conflito → erro orientando `resume` na mesma task; pai intocado.
6. `requireFrozen`: frozen blobs desta e de **todas** as já integradas intactos na árvore mergeada.
7. Journal `integration_intent{task_id, attempt_id, parent_head, child_head, tree, result_sha256}` → persist.
8. `git merge --no-ff --no-edit -m "Integrate harness task <id> (<attempt>)" <expected_head>` (sempre merge
   commit de 2 pais; nunca ff/cherry-pick).
9. `reconcileMerge`: confere pais e tree → recibo `host-task-integration{…, child_head, integrated_head,
   result_sha256}` → `status:"integrated"`. Crash: próxima ação conclui ou aborta merge exato.

---

## 10. Resume, correções e reconciliação

- `resume` exige **todos os launches terminais** ("task is still running; use status or wait"); não há anexar
  a filho vivo. Mesmo attempt/grant/worktree/sessão local; novo `runId`; `result/integration=null`.
  Sem claim (morreu antes da admissão) → relança `--harness-task` (admissão é retryable).
- **Correção de task já integrada:** abre `correction_barrier` (com pilha), arquiva `integration_history` /
  `result_history`, invalida `final_review_*`/`demo_done` no pai, marca dependentes pendentes com
  `reconciliation_required`. Dependentes já integrados são preservados.
- **Reconciliação de dependente** (CO:404-454): o **host** faz `git merge --no-ff <parentHead>` na worktree do
  dependente (após upstream reintegrado com recibo novo); conflito → `merge --no-commit` deixado aberto para o
  filho resolver via sniper. O prompt nunca manda o filho fazer merge.
- `abandon-resume`: prova que a correção não produziu delta e restaura o recibo; finais continuam invalidados.

---

## 11. Backend Orca

Ativado por `ORCA_WORKTREE_ID` no pai; **obrigatório** depois do primeiro uso (registry fixa `orca_parent`);
sem fallback silencioso. CLI `PI_HARNESS_ORCA_CLI||ORCA_CLI_COMMAND||"orca"`, sempre `--json`, timeout 120 s.
- `orca worktree create --repo id:<r> --name harness-task-<t>-<a> --base-branch <base_sha> --parent-worktree
  id:<pai> --setup skip --activate --comment "Harness task <t>; attempt <a>"`; `create_requested` persistido
  antes; recuperação por `comment` único; nunca segundo create.
- `orca terminal create --worktree id:<id> --title "<task> · implementação" --command "exec 'node' '<worker>' '<job.json>'"`
  (quoting literal, NUL rejeitado); foco opcional, nunca terminal substituto.
- Espera: `orca terminal wait --for exit`. TUI interativo + `harness-task-events` grava eventos e faz
  `ctx.shutdown()` no `agent_end` (ou mantém viva se houver continuação de entrega pendente).

**Continuação de entrega** (`delivery-continuation.mjs`): no `agent_end` do pai local, se ainda há etapa da task
pendente, injeta um follow-up **uma vez por chave** de progresso; 2ª vez diagnóstico; 3ª para.

---

## 12. Invariantes testadas que o port deve manter

Coordenador: lote atômico; dispatch idempotente; glob rejeitado antes de qualquer efeito; overlap inclui
locked tests/fixtures/allowed_writes e compara por componente; `task_contexts` imutável; lock recente não roubado;
diagnostics não persistidos; `context_return` só em ready/integrated; integrate recusa HEAD errado e gera merge de
2 pais; conflito detectado sem tocar o pai; resume exige processos terminais e mantém attempt; filho/plano alterado
não despacham; journal de merge recuperável; barreiras de correção aninhadas; reconciliação exige recibo novo.
Processo: worker sobrevive ao pai; SIGHUP mata o grupo inteiro; timeout = falha terminal; netos mantêm `running`;
reuso de PID não engana; resultado válido não torna terminal um worker vivo; runtime alterado recusado.
Lane: admissão não fabrica evidência; mudança de grant/plano/branch invalida; bloqueio de cerimônia/sibling/entrega;
só `merge-base` isolado; prompt global não aparece; preflight sem claim é retryable; rollback só do pristino.
Recibos: produtor deve ser a última implementação após fidelity; test-author após fidelity bloqueia; positivo
ancestral pré-executor não vale; negativo stale bloqueia; hashes recomputados não salvam ancestralidade forjada;
`context_return` forjado rejeitado. Markers: replay/clone/troca de sessão falham; `capture-verified` ignora
`args.sha`. Concorrência: até 3 readers, writer exclusivo FIFO, fidelidade/spec exclusivas.

---

## 13. Estado atual do Claude Code (gap)

- Phase 2 de `orchestrating-delivery` é **estritamente serial** num único branch/working tree (SKILL:218, 399);
  paralelismo só de olhos read-only em fan-out com join.
- Nenhuma worktree por task (`memory/dispatch-hand-contract.md:11`: "containment without a git worktree").
- Orca hoje = paralelismo por **issue** (`core/orca/select-and-dispatch.mjs`, `--no-parent`, integração via PR);
  Claude Code não lê `ORCA_WORKTREE_ID`.
- Plano já tem `tasks[].{id, scope_paths, locked_tests, depends_on, complexity, adversarial}` — suficiente para DAG;
  falta checagem determinística de overlap (o validator compartilhado `core/shared/lib/validate-plan.mjs:300-320`
  não é usado pelo Claude Code).
- Estado em `.claude/plans/` (gitignored) resolvido por `process.cwd()` → não existe numa worktree nova.
- `active_dispatch` único last-write-wins (`stamp-triage.mjs:836-848`) → não suporta mãos concorrentes na mesma sessão.
- `entry-gate.mjs:1025` dá ALLOW a qualquer chamada com `agent_id` → **subagente não pode ser o pai local**
  (sub-pipeline sem gates). O pai local precisa ser **sessão top-level** (`claude -p` na worktree).
- Pressupostos de HEAD linear: `descriptor-emitter.mjs:269-274`, `capture-hand.mjs:390-421`, reset por stash
  (SKILL:377), frozen re-gate global (SKILL:345).
- Background-and-poll proibido e `claude -p` não é reinvocado por job → o pai precisa de **wait bloqueante no host**.
- Não há Stop/SubagentStop no `settings.json` principal.

---

## 14. Proposta de port (Claude Code)

### 14.1 Mapeamento de peças

| Pi | Claude Code | Reuso |
|---|---|---|
| `task-contract.mjs`, `task-context.mjs`, overlap/scope, `stableJson` | `core/shared/lib/task-*.mjs` | mover/compartilhar quase literal |
| `task-process.mjs` + `pi-task-worker.mjs` | `core/shared/lib/task-process.mjs` + `core/claude-code/hooks/lib/task-worker.mjs` | quase literal (Node puro) |
| `task-orca.mjs` | compartilhado | literal; trocar comando lançado |
| `task-coordinator.mjs` | `core/claude-code/hooks/lib/task-coordinator.mjs` | lógica igual; adaptar paths `.claude/` e autoridade de plano |
| tool `harness_tasks` | **CLI host** `node .claude/hooks/tasks.mjs <action> --json '…'` chamado via Bash | Claude Code não tem tool custom sem MCP; CLI + allowlist no entry-gate (alternativa: MCP local) |
| `wait` sem modelo | o mesmo CLI bloqueia (`tasks.mjs wait`, até ~9 min < timeout Bash 10 min, devolve `changed/settled/timeout`) | sem polling do modelo |
| `pi-harness --harness-task` | launcher `claude-task.mjs`: admite grant e roda `claude -p --session-id <uuid> --append-system-prompt <task-runtime+envelope> --output-format stream-json --verbose --permission-mode … --settings <worktree>/.claude/settings.json` com cwd = worktree | novo |
| `--harness-resume` | `claude -p --resume <session_id>` (mesma worktree) | novo |
| extensão `harness-task-run.ts` (tool_call) | hook PreToolUse lendo `CLAUDE_HARNESS_TASK_RUN` + gate-state `task_run`, revalidando binding por chamada | novo, espelha `decideTaskRunTool` |
| `events.jsonl` nativo | stream-json do `claude -p` gravado pelo worker **+** ledger host-owned via hooks PreToolUse/PostToolUse/SubagentStop (callId, role, prompt hash, status) | novo; base da inspeção |
| child-identity | `agent_id`/`agent_type` dos payloads de hook do subagente | adaptar |
| `harness-task-events` shutdown / continuação | Stop hook com `decision:block` uma vez por chave | novo |
| `inspectTaskRun`, receipts | `core/claude-code/hooks/lib/task-receipts.mjs` | reescrever leitura de eventos; regras iguais |

### 14.2 Decisões a fechar antes de codar
1. **Superfície do pai global:** CLI via Bash (recomendado: zero infra, já há padrão `mark.mjs`/`stamp-triage`)
   vs MCP local. Recomendo CLI, com o stdout JSON carimbado por PostToolUse como o `mark.mjs` faz hoje.
2. **Prova de ordem na lane:** confiar no stream-json do `claude -p` (gravado pelo worker, fora do alcance do
   modelo) como equivalente ao `events.jsonl`. Precisa confirmar que inclui `tool_use` de subagentes com
   `input.prompt` e resultados com status.
3. **Estado na worktree:** copiar `.claude/plans/<feature>/{spec.md,execution-plan.json}` + `.claude/` vendorizado
   (já versionado? se gitignored, copiar) e semear `gate-state.json` com `task_run`; nunca reclassificar no filho.
4. **Rails existentes por cwd:** `active_dispatch`, hand-records, `capture-hand` passam a viver por worktree
   (sessão própria) → resolvem a concorrência sem mudar a semântica.
5. **Trust/permissões em `claude -p` na worktree:** precedente em `kaizen.md:450-455` (trust dialog);
   definir `--permission-mode`/`--allowedTools` e `CLAUDE_CONFIG_DIR` como já faz `spawn-hand.mjs`.
6. **Orca:** fase 2; fase 1 só backend local.

### 14.3 Fases sugeridas
1. **Compartilhar núcleo puro** (`core/shared/lib`): contract, context, scope/overlap, process, worker, orca —
   com os testes do Pi movidos/duplicados. Pi passa a importar do shared (sem mudança de comportamento).
2. **Plano:** usar `core/shared/lib/validate-plan.mjs` no Claude Code (overlap determinístico).
3. **Launcher da lane + hook PreToolUse da lane** + prompt `core/claude-code/skills/orchestrating-delivery/references/task-runtime.md`
   (port de `harness-task-runtime.md` para nomes de agentes do Claude Code).
4. **Coordenador + CLI `tasks.mjs`** (dispatch/status/wait/integrate/resume) + inspeção/recibos.
5. **Skill:** nova seção "Phase 2 paralela" em `orchestrating-delivery` (equivalente a `harness-task-pipeline`),
   gates de entrega exigindo recibos de integração; revisão final no HEAD agregado inalterada.
6. **Correções/reconciliação/abandon-resume** e **Orca** (`ORCA_WORKTREE_ID`, `--parent-worktree`).
7. Vendor: registrar hooks em `core/claude-code/settings.json`, âncoras em `FRESH_NATIVE_PATHS.claude`, testes
   em `vendor-core.test.mjs`.

### 14.4 Verificações empíricas pendentes (antes da fase 3)
- `claude -p --output-format stream-json --verbose`: formato de eventos de subagente e sessão; `--session-id` +
  `--resume` na mesma worktree; comportamento com hooks do projeto na worktree.
- Payload de hooks em subagentes (`agent_id`, `agent_type`) dentro de `claude -p`.
- Se `CLAUDE_PROJECT_DIR` aponta para a worktree filha.
- Limite prático de 3 `claude -p` simultâneos (RAM/rate limit).
