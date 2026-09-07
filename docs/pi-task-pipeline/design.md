# Pi: despacho por tarefa como pipeline padrão

Autorização: implementar o comportamento discutido, validar uma issue FULL real até aprovação e cortar release pelo release-please. A implementação não deve criar outra pipeline TDD nem depender de Orca sem necessidade.

## Contrato de comportamento

1. Sessões novas LIGHT/FULL usam `task_pipeline_version: 1`. O pai global planeja/aprova, despacha, observa, integra, valida o conjunto, faz harvest/revisão final/shipping. Não despacha test-author/executor/sniper diretamente; cada implementação é um pai local de tarefa.
2. `harness_tasks` oferece `dispatch(task_ids[])`, `status`, `integrate(task_id, attempt_id, expected_head)` e `resume(task_id, attempt_id, instruction?)`. Nenhuma fase TDD é executada pela ferramenta: a task usa mãos/olhos/markers nativos. A superfície completa Pi (skills, gates, hooks, docs e instalação) deve refletir esse padrão.
3. Dispatch exige spec selada e recibo host-owned de plan-reviewer APPROVE no hash atual. Dependências devem estar integradas e seus commits ancestrais à base atual. Scopes ativos sobrepostos são serializados. Tarefas independentes rodam em processos/worktrees distintos, com limite finito de concorrência; As revisões de implementação/finais usam o PR #902 incorporado (head final `a3aa52f`, merge `0cecaac`), com até três olhos em paralelo; mãos, fidelidade e revisão de spec seguem a exclusividade definida por esse PR.
4. A concessão registra pai real, feature/task/tentativa, base, branch/cwd, hashes e recibos das dependências. Não copia aprovação TDD/captura/revisão para a filha. Os prompts global e de tarefa passam a ter fontes estáveis, sem recortar sentinelas textuais.
5. O resultado exige lifecycle encerrado, mesma identidade, árvore limpa, escopo cumulativo, produtor nativo, captura do record ATUAL, freeze observado/preservado e re-gate. Relatório de término sozinho não vale. A evidência de revisão continua identificada pela sessão que executou a tarefa.
6. Integração usa merge do SHA exato e grava recibo global, preservando linhagem. Consumers finais aceitam esse recibo validado ou a evidência local antiga, sem reescrever sessionId. HEAD integrado ainda exige testes/harvest/olhos finais existentes.
7. Retomada reutiliza o pai local/tentativa e estado válido, após provar que o processo anterior terminou. Feedback global volta à task dona; seu recibo integrado é suspenso enquanto correção/retomada está ativa. A correção segue a pipeline nativa; nova integração não é inferida por branch tip.
8. Timeout/erro/retorno incompleto preservam a worktree e permitem retomada. Nenhuma repetição automática inicia implementação pronta sem causa. Reinício do pai reabre handles existentes, sem duplicar processos.

## Formato de coordenação entre módulos

Registry: `.pi/harness/state/<parent_session_id>/task-runs/index.json`.

```json
{"version":1,"parent_session_id":"...","feature_id":"...","plan_sha256":"...","spec_sha256":"...","tasks":{"task-id":{"task_id":"task-id","attempt_id":"...","parent_session_id":"...","parent_root":"...","feature_id":"...","plan_sha256":"...","spec_sha256":"...","base_sha":"...","worktree":"...","branch":"...","grant_path":"...","job_dir":"...","status":"running|blocked|ready|integrated","launches":[{"run_id":"...","pid":123,"events_path":"...","process_path":"...","result_path":"..."}],"result":null,"integration":null}}}
```

A concessão mantém os campos conhecidos do protótipo (`version:1, kind:task-run, parent_session_id, attempt_id, feature_id, task_id, cwd, branch, base_sha, plan_sha256, spec_sha256`) e acrescenta `parent_root`, `origin.kind:parent-approved-plan`, `origin.plan_review_call_id`, e `dependencies:[{task_id,child_head,integrated_head,receipt_sha256,receipt}]`. Seu path continua `<task cwd>/.pi/harness/state/task-admission/<attempt_id>.json`; claim e estado da sessão são criados pelo launcher. O pai deriva a sessão real da claim, nunca a inventa depois.

O módulo de recibos valida retorno e integração mantendo os registros originais. Deve expor `inspectTaskRun(entry)` e `readIntegratedTaskEvidence({projectRoot,sessionId,featureId,taskId,headSha})`; o shape do recibo final será registrado aqui pelo seu autor antes de integrar o coordenador. A tool é a única escritora do registry de integração. Os módulos de task-mode/receipts não devem se importar circularmente.

## Implementação e provas

- Entrada/task-mode/prompts/recibo do plano: partir do protótipo, remover restrição histórica e roots-only, preservar guards, testar grants/identidade/retomada e default novo.
- Recibos e consumers finais: testar captura ausente, produtor alheio, freeze alterado, retorno sujo, HEAD trocado, dependência não integrada e resultado após retomada; preservar fixtures antigas sem mudar suas identidades.
- Coordenador/tool/worker: testar exclusividade, conflito de scopes ativos, dispatch idempotente, mesma sessão na retomada, supervisão de processo real, merge exato e falhas preservadas.
- Runtime/vendorização: registrar extensões em ambas entradas e testar launcher/package vendorizados; documentar uso normal.
- Run FULL real: Syntifai-AI/victor-frontend#5, na base remota atual, cobrindo migração APP, auditoria/redação/retenção18meses, idempotência e hook real de mudanças de allowlist. Testes workerd/D1/R2 locais, sem deploy necessário.
- Fechamento: suíte aplicável e CI, revisão independente, run FULL e seus critérios aprovados, PR funcional mergeado e release-please com CI verde. Não editar versão/changelog/tag manualmente.

O payload de integração é `{version:1,written_by:"host-task-integration",parent_session_id,feature_id,task_id,attempt_id,parent_root,worktree,session_id,plan_sha256,spec_sha256,base_sha,child_head,integrated_head,result_sha256}`. `hashTaskReceipt` usa JSON canônico estável (`stableTaskJson`), exportados em `task-contract.mjs`; a dependency transporta esse payload e o hash, e revalida contra o registry pai atual. `result_sha256` vincula o resultado verificado no mesmo registry.


## Recuperação, correções e versão do runtime

- Uma integração reserva antes do merge os SHAs pai/filha, árvore resultante e hash do resultado. Após reinício, somente o merge com parentage e árvore exatos encerra o journal. Falha de hook conserva a intenção; uma árvore de merge sem alterações adicionais pode ser abortada pelo próprio coordenador antes da repetição.
- Corrigir uma task que já tem dependentes exige que todos os descendentes admitidos estejam integrados. `correction_barrier` congela novos despachos e outras integrações; o recibo e resultado anteriores ficam em `integration_history`/`result_history`. O reset de aprovação agregada é idempotente inclusive após falha. Depois do novo merge, testes, harvest e revisores finais avaliam o conjunto atual. Dependentes conservam sua proveniência histórica; grants novos usam sempre a dependência corrente.
- A task usa launcher local da worktree quando o harness faz parte da base Git. Instalação Pi como pacote externo conserva caminho canônico e digest dos assets estáticos; drift bloqueia nova execução. O worker confere o digest antes de iniciar o launcher. Estado, sessões, auth e runtime mutável ficam fora desse digest.
- A observação nativa permite esperar até 30 segundos (`wait_seconds`, padrão20). Abortar a observação não cancela a implementação. Não há novo scheduler de fases ou cópia de evidências entre sessões.
