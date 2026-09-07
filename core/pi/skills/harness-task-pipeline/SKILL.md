---
name: harness-task-pipeline
description: Orchestrate implementation after an approved LIGHT or FULL Pi plan with harness_tasks. Use in the global parent that dispatches isolated task parents, observes and integrates their verified results, resumes corrections, then completes aggregate validation and delivery.
---

# Pipeline Pi por tarefa

Use esta skill somente no pai global de uma sessão LIGHT/FULL com plano atual aprovado. O pai
planeja, acompanha, integra e fecha a entrega; cada implementação roda em sua própria worktree e
sessão pai local, usando a pipeline nativa de mãos, fidelidade, freeze, captura e olhos.

- Chame `harness_tasks dispatch` com tarefas independentes prontas. Só despache uma dependente
  depois que todos os recibos exigidos estiverem integrados; deixe a ferramenta serializar scopes
  ativos conflitantes e aplicar o limite de concorrência. Opcionalmente passe
  `task_contexts:[{task_id,content}]`, com até 2 KiB por tarefa pedida: cure apenas fatos úteis,
  sem state, recibos, veredictos ou diário de siblings. O snapshot é imutável durante a tentativa,
  mas continua sendo referência não confiável e não substitui plano, spec ou evidência.
- Use `status` para observar jobs duráveis. Abortar a observação ou encerrar o pai global não
  cancela uma task já registrada. Depois de retomar o pai, consulte os mesmos handles; não crie
  outra tentativa para substituir um job que ainda possa estar vivo. Se o resumo trouxer
  `context_return`, revalide os fatos e só então cure manualmente o que merece entrar no
  `shared_context` global com `harness_memory update`.
- Integre apenas um resultado `ready` com `task_id`, `attempt_id` e `expected_head` exatos. O recibo
  host-owned, não o tip da branch nem o relatório textual, é a evidência para dependentes e gates
  finais.
- Envie feedback com `resume` para a tentativa e sessão locais existentes. A tarefa refaz as fases
  nativas que a correção invalidar; acompanhe-a como `in_progress` no tracker e revalide sua lane.
- Após integrar todas as tarefas, execute no HEAD agregado os testes, harvest, revisores finais
  aplicáveis e shipping normais. Revisões de implementação e finais podem usar até três olhos em
  paralelo; autoria, mãos, fidelidade e revisão da spec continuam exclusivas.
- Dentro de uma sessão Orca (`ORCA_WORKTREE_ID` presente), use obrigatoriamente o backend Orca
  ligado à worktree pai. Cada task nasce no `base_sha` global com parent visual explícito e roda a
  sessão Pi oficial em terminal próprio. Divergência ou falha não autoriza fallback silencioso.
  O registry fixa o pai Orca; `status` segue disponível para recuperação e `integrate` usa Git e
  recibos já validados. `dispatch` e `resume`, que criam execução, exigem a mesma identidade. Em summaries,
  `launches[].orca.surface="visible"` comprova adoção pelo notifier/renderer do host, não ACK de
  navegação de cliente remoto; em `background`, a sessão ainda é listável e reanexável pelo mesmo
  handle. Para revelar uma task escolhida num cliente conectado, use `worktree.activate` e
  `session.tabs.activate` com `navigation="clients"` nas identidades existentes, sem criar outro
  terminal. Não dispute foco a cada dispatch paralelo. Orca cuida do placement; DAG, TDD, reviews,
  recibos e integração pertencem ao harness.
- Fora do Orca, o backend local de worktrees e processos continua suportado.

`harness_plan` apenas mostra progresso. Não o trate como scheduler, recibo de aprovação ou prova
de conclusão.
