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
  ativos conflitantes e aplicar o limite de concorrência.
- Use `status` para observar jobs duráveis. Abortar a observação ou encerrar o pai global não
  cancela uma task já registrada. Depois de retomar o pai, consulte os mesmos handles; não crie
  outra tentativa para substituir um job que ainda possa estar vivo.
- Integre apenas um resultado `ready` com `task_id`, `attempt_id` e `expected_head` exatos. O recibo
  host-owned, não o tip da branch nem o relatório textual, é a evidência para dependentes e gates
  finais.
- Envie feedback com `resume` para a tentativa e sessão locais existentes. A tarefa refaz as fases
  nativas que a correção invalidar; acompanhe-a como `in_progress` no tracker e revalide sua lane.
- Após integrar todas as tarefas, execute no HEAD agregado os testes, harvest, revisores finais
  aplicáveis e shipping normais. Revisões de implementação e finais podem usar até três olhos em
  paralelo; autoria, mãos, fidelidade e revisão da spec continuam exclusivas.

`harness_plan` apenas mostra progresso. Não o trate como scheduler, recibo de aprovação ou prova
de conclusão. A pipeline não depende de Orca; uma worktree de produto instalada com o Pi Harness é
suficiente.
