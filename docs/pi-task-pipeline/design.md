# Pi: despacho por tarefa como pipeline padrão

Autorização: implementar o comportamento discutido, validar uma issue FULL real até aprovação e cortar release pelo release-please. A implementação não deve criar outra pipeline TDD. Quando o pai roda dentro do Orca, o Orca fornece worktrees e terminais visíveis; fora dele, o backend local continua suportado.

## Contrato de comportamento

1. Sessões novas LIGHT/FULL usam `task_pipeline_version: 1`. O pai global planeja/aprova, despacha, observa, integra, valida o conjunto, faz harvest/revisão final/shipping. Não despacha test-author/executor/sniper diretamente; cada implementação é um pai local de tarefa.
2. `harness_tasks` oferece `dispatch(task_ids[], task_contexts?)`, `status`, `integrate(task_id, attempt_id, expected_head)` e `resume(task_id, attempt_id, instruction?)`. Nenhuma fase TDD é executada pela ferramenta: a task usa mãos/olhos/markers nativos. A superfície completa Pi (skills, gates, hooks, docs e instalação) deve refletir esse padrão.
3. Dispatch exige spec selada e recibo host-owned de plan-reviewer APPROVE no hash atual. Dependências devem estar integradas e seus commits ancestrais à base atual. Scopes ativos sobrepostos são serializados. Tarefas independentes rodam em processos/worktrees distintos, com limite finito de concorrência. Dentro do Orca, não há fallback silencioso: worktree e terminal devem pertencer ao pai Orca registrado. As revisões de implementação/finais usam o PR #902 incorporado (head final `a3aa52f`, merge `0cecaac`), com até três olhos em paralelo; mãos, fidelidade e revisão de spec seguem a exclusividade definida por esse PR.
4. A concessão registra pai real, feature/task/tentativa, base, branch/cwd, hashes e recibos das dependências. Pode carregar um `context_handoff` curado e imutável, sem autoridade. Não copia aprovação TDD/captura/revisão, state nem diário para a filha. Os prompts global e de tarefa passam a ter fontes estáveis, sem recortar sentinelas textuais.
5. O resultado exige lifecycle encerrado, mesma identidade, árvore limpa, escopo cumulativo, produtor nativo, captura do record ATUAL, freeze observado/preservado e re-gate. Relatório de término sozinho não vale. A evidência de revisão continua identificada pela sessão que executou a tarefa. Um `context_return` opcional fica ligado pelo host à sessão, tarefa e HEAD exatos e não é promovido automaticamente à memória global.
6. Integração usa merge do SHA exato e grava recibo global, preservando linhagem. Consumers finais aceitam esse recibo validado ou a evidência local antiga, sem reescrever sessionId. HEAD integrado ainda exige testes/harvest/olhos finais existentes.
7. Retomada reutiliza o pai local/tentativa e estado válido, após provar que o processo anterior terminou. Feedback global volta à task dona; seu recibo integrado é suspenso enquanto correção/retomada está ativa. A correção segue a pipeline nativa; nova integração não é inferida por branch tip.
8. Timeout/erro/retorno incompleto preservam a worktree e permitem retomada. Nenhuma repetição automática inicia implementação pronta sem causa. Reinício do pai reabre handles existentes, sem duplicar processos.

## Formato de coordenação entre módulos

Registry: `.pi/harness/state/<parent_session_id>/task-runs/index.json`.

```json
{"version":1,"parent_session_id":"...","feature_id":"...","plan_sha256":"...","spec_sha256":"...","tasks":{"task-id":{"task_id":"task-id","attempt_id":"...","parent_session_id":"...","parent_root":"...","feature_id":"...","plan_sha256":"...","spec_sha256":"...","base_sha":"...","worktree":"...","branch":"...","grant_path":"...","job_dir":"...","status":"running|blocked|ready|integrated","launches":[{"run_id":"...","pid":123,"events_path":"...","process_path":"...","result_path":"..."}],"result":null,"integration":null}}}
```

A concessão mantém os campos conhecidos do protótipo (`version:1, kind:task-run, parent_session_id, attempt_id, feature_id, task_id, cwd, branch, base_sha, plan_sha256, spec_sha256`) e acrescenta `parent_root`, `origin.kind:parent-approved-plan`, `origin.plan_review_call_id`, e `dependencies:[{task_id,child_head,integrated_head,receipt_sha256,receipt}]`. Seu path continua `<task cwd>/.pi/harness/state/task-admission/<attempt_id>.json`; claim e estado da sessão são criados pelo launcher. O pai deriva a sessão real da claim, nunca a inventa depois.

`dispatch.task_contexts` aceita no máximo uma entrada `{task_id,content}` por task pedida,
com limite de 2 KiB UTF-8. O host captura
`{version:1,kind:"curated-task-context",parent_session_id,task_id,source_shared_context_sha256,content_sha256,content}`
antes dos efeitos do dispatch e grava o snapshot em `grant.context_handoff`. O conteúdo
é um brief curado e não precisa ser substring do `shared_context`; o hash de origem só
identifica a revisão consultada. Nenhum dos dois hashes concede autoridade. A task recebe
somente esse recorte focal, não state, recibos, reviews ou diários de siblings, e não o
repassa aos olhos.

A task pode usar `harness_memory read/update` no próprio diário de 8 KiB; `apply` e
`finalize` permanecem exclusivos do pai global. Ao inspecionar resultado, o host pode
capturar `{version:1,kind:"task-context-return",session_id,task_id,head_sha,content,sha256}`
do diário da sessão task. Identidade, HEAD, limite e hash do conteúdo são revalidados no
resultado e no consumer integrado. O pai global decide explicitamente se algum fato
verificado merece um novo `harness_memory update`; não existe merge automático de memória.

Quando `ORCA_WORKTREE_ID` está presente, o registry fixa `orca_parent`. `dispatch` e
`resume`, as ações que criam execução, exigem o mesmo pai Orca. `status` continua
disponível sem inicializar runtime para permitir recuperação, e `integrate` depende de
Git e recibos já verificados, não da disponibilidade do Orca. O backend cria a worktree task no `base_sha` global com
`parent_worktree_id` explícito, confirma repo/path/instance e inicia o worker em terminal
próprio. Novas tentativas Orca usam `presentation:"tui"`, prompt posicional e `--no-approve`:
o worker herda o PTY e o Pi mantém sua interface nativa. Uma extensão no mesmo processo grava
o header real e eventos de ferramentas em `events.jsonl`; `agent_end` solicita o shutdown
nativo, consumido em `agent_settled`. O receipt continua exigindo eventos atuais e saída
limpa do processo. A apresentação da primeira launch é preservada em resumes; ausência
do campo significa JSON legado, compatível com o runtime já fixado. Não há attach de uma
segunda sessão ao arquivo vivo. O summary expõe `orca.worktree_id` e
`launches[].orca.{terminal_handle,surface}`. `surface:"visible"` prova adoção pelo
notifier/renderer do host, não ACK de navegação de cliente remoto; em `background`, a sessão
continua listável e reanexável pelo mesmo handle. A revelação explícita de uma task escolhida
num cliente conectado usa `worktree.activate` e `session.tabs.activate` com
`navigation:"clients"` nas identidades existentes, sem criar outro terminal nem disputar foco
em cada task paralela. Orca é responsável
por placement e superfície. O harness continua responsável por DAG, TDD, reviews,
process lifecycle, recibos e integração. Sem `ORCA_WORKTREE_ID`, usa-se o backend local
de Git/worktree/processo.

O módulo de recibos valida retorno e integração mantendo os registros originais. Deve expor `inspectTaskRun(entry)` e `readIntegratedTaskEvidence({projectRoot,sessionId,featureId,taskId,headSha})`; o shape do recibo final será registrado aqui pelo seu autor antes de integrar o coordenador. A tool é a única escritora do registry de integração. Os módulos de task-mode/receipts não devem se importar circularmente.

## Implementação e provas

- Entrada/task-mode/prompts/recibo do plano: partir do protótipo, remover restrição histórica e roots-only, preservar guards, testar grants/identidade/retomada e default novo.
- Recibos e consumers finais: testar captura ausente, produtor alheio, freeze alterado, retorno sujo, HEAD trocado, dependência não integrada e resultado após retomada; preservar fixtures antigas sem mudar suas identidades.
- Coordenador/tool/worker: testar exclusividade, conflito de scopes ativos, dispatch idempotente, mesma sessão na retomada, supervisão de processo real, merge exato e falhas preservadas.
- Runtime/vendorização: registrar extensões em ambas entradas e testar launcher/package vendorizados; documentar uso normal.
- Run FULL real: replay de orobsonn/proj-lainny#47 na base anterior à implementação, `84b946d5e12b516952c9cdb8696fbab6382ef813`, com T1/T2 independentes e T3 dependente (44 contratos). Usar somente issue/spec/plano e configuração da base como mapa; produzir testes, implementação e aprovações nativas novos. Validação local de SQL/Worker, sem publicação ou operação do painel Cloudflare. A tentativa anterior no Victor fica arquivada como diagnóstico.
- Fechamento: suíte aplicável e CI, revisão independente, run FULL e seus critérios aprovados, PR funcional mergeado e release-please com CI verde. Não editar versão/changelog/tag manualmente.

O payload de integração é `{version:1,written_by:"host-task-integration",parent_session_id,feature_id,task_id,attempt_id,parent_root,worktree,session_id,plan_sha256,spec_sha256,base_sha,child_head,integrated_head,result_sha256}`. `hashTaskReceipt` usa JSON canônico estável (`stableTaskJson`), exportados em `task-contract.mjs`; a dependency transporta esse payload e o hash, e revalida contra o registry pai atual. `result_sha256` vincula o resultado verificado no mesmo registry.


## Recuperação, correções e versão do runtime

- Uma integração reserva antes do merge os SHAs pai/filha, árvore resultante e hash do resultado. Após reinício, somente o merge com parentage e árvore exatos encerra o journal. Falha de hook conserva a intenção; uma árvore de merge sem alterações adicionais pode ser abortada pelo próprio coordenador antes da repetição.
- Corrigir uma task que já tem dependentes exige que todos os descendentes admitidos estejam integrados. `correction_barrier` congela novos despachos e outras integrações; o recibo e resultado anteriores ficam em `integration_history`/`result_history`. O reset de aprovação agregada é idempotente inclusive após falha. Depois do novo merge, testes, harvest e revisores finais avaliam o conjunto atual. Dependentes conservam sua proveniência histórica; grants novos usam sempre a dependência corrente.
- A task usa launcher local da worktree quando o harness faz parte da base Git. Instalação Pi como pacote externo conserva caminho canônico e digest dos assets estáticos; drift bloqueia nova execução. O worker confere o digest antes de iniciar o launcher. Estado, sessões, auth e runtime mutável ficam fora desse digest.
- A observação nativa permite esperar até 30 segundos (`wait_seconds`, padrão20). Abortar a observação não cancela a implementação. Não há novo scheduler de fases ou cópia de evidências entre sessões.

## Referências do backend Orca

- [Modelo oficial de worktrees do Orca](https://www.onorca.dev/docs/model/worktrees)
- [Referência oficial do CLI Orca](https://www.onorca.dev/docs/cli/reference)
- [Release Orca v1.4.177 usada como baseline de compatibilidade](https://github.com/stablyai/orca/releases/tag/v1.4.177)
