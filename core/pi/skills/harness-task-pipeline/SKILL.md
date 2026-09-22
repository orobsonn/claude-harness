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
- Use `status` para uma consulta pontual aos jobs duráveis. Se há tasks rodando e nenhum
  trabalho independente pronto, use `wait`, com `task_id` opcional. Ele aguarda no host
  sem novas chamadas ao modelo; no Orca usa o término do terminal como aviso e então
  revalida processo e recibos. Não faça polling por `status` nem leia transcripts dos
  filhos para esperar. Abortar a observação ou encerrar o pai global não
  cancela uma task já registrada. Depois de retomar o pai, consulte os mesmos handles; não crie
  outra tentativa para substituir um job que ainda possa estar vivo. Se o resumo trouxer
  `context_return`, revalide os fatos e só então cure manualmente o que merece entrar no
  `shared_context` global com `harness_memory update`.
  Depois de consumir um `context_return`, use `compact:true` nas consultas `status`/`wait`
  seguintes para preservar estado, handles, heads e diagnósticos sem repetir o corpo inteiro.
- Integre apenas um resultado `ready` com `task_id`, `attempt_id` e `expected_head` exatos. O recibo
  host-owned, não o tip da branch nem o relatório textual, é a evidência para dependentes e gates
  finais.
- Envie feedback com `resume` para a tentativa e sessão locais existentes. A tarefa refaz as fases
  nativas que a correção invalidar; acompanhe-a como `in_progress` no tracker e revalide sua lane.
- Após a primeira admissão, plano e spec ficam fixos para essa sessão, mesmo depois de todas as
  tasks terminarem. `resume` corrige implementação dentro desse contrato. Se o próprio plano
  precisar mudar, preserve worktrees e evidências e use uma nova sessão com nova aprovação;
  não apague o registry nem reutilize markers antigos para liberar o plano novo.
- A revisão de testes pertence ao `harness-test-reviewer`, somente leitura e exclusivo
  de fidelidade. Cada pai local resolve suas correções até haver evidência suficiente
  e aprovação; compliance fica nas revisões de implementação e final.
  Há um RED/freeze inicial por task. Findings de produto vão ao sniper e preservam
  fidelidade; reabra autoria somente por teste/fixture congelado incorreto, mudança
  do contrato aprovado ou observável aprovado concretamente sem cobertura. Após duas
  falhas de fidelidade, escale diagnóstico/autor/contrato; após dois ciclos HIGH de
  sniper/re-gate, escale executor/contrato. Limites nunca aprovam automaticamente.
  Invariância de sibling é uma constraint de escopo, não catálogo ou matriz automática
  de locked tests: escolha o menor RED fiel ao comportamento aprovado.
- Em recovery test-only de task já integrada, use o par host-owned de inspeção/integração
  imediatamente anterior, inclusive se ele já veio de outra recovery test-only. O host
  revalida esse par e exige delta apenas nos paths congelados; falha bloqueia, sem buscar
  recibo antigo. Antes da primeira integração, use o capture limpo da implementação
  anterior ao primeiro autor corretivo. Nunca altere produção artificialmente para
  preservar freeze, fabricar RED ou obter recibo.
- No pai local, após cada executor/sniper, verifique escopo, diff e testes, faça o
  commit seletivo e registre `capture-verified` com a árvore limpa antes dos olhos de
  implementação. Resolva `preparation` da consulta
  `harness_reviews` antes de despachar. Uma captura esquecida pode ser validada depois
  do commit pelo SHA ancestral do produtor atual; ela não exige repetir fidelidade,
  mãos ou revisões ainda aceitas.
- Em LIGHT, não rode olhos de implementação por task. Em FULL, rode compliance,
  adversary somente com `task.adversarial.enabled: true`, e security por trigger ou
  aplicabilidade existente. Após finding, revalide o olho que o produziu e somente
  outros olhos cuja obrigação ou trigger explícito foi afetado. Um positivo ancestral
  por task pode manter satisfeita a obrigação de um olho não afetado, mas não certifica
  o novo HEAD; a revisão final global é fresca e permanece dual
  (compliance/adversary), ou triad quando security se aplica, inclusive em LIGHT.
  Depois da primeira rodada, despache somente os papéis que `harness_reviews` listar em
  `missing`. Se a correção mudar materialmente a obrigação ou um trigger de um papel em
  `accepted`, passe apenas esse papel em `affected_roles` com um `affected_reason`
  concreto; HEAD novo por si só não reabre os olhos irmãos.
- Antes do primeiro lote FULL, avalie a mudança efetiva: `required` de `harness_reviews`
  mostra o mínimo já ativado, não uma classificação completa de aplicabilidade.
  A ausência de security nessa lista não o dispensa. Seguindo o Claude, despache
  security quando a task alterar autenticação/autorização, segredos/configuração
  sensível, clientes HTTP externos, entradas externas (schemas, parsers, webhooks),
  entrypoints de serviço, dependências novas ou statements de log. Julgue o delta,
  não apenas o nome do arquivo; mudança interna sem esses gatilhos não exige security.
  `final_review.security` agenda outra etapa: a revisão final não substitui security
  aplicável na task FULL. Não reabra olhos já satisfeitos nem force três olhos em toda task.
- Olhos de task recebem evidência focal e não podem exigir comandos de
  `final_review.parent_verification`. Após integrar todas as tarefas, o pai final
  executa no HEAD agregado os testes, revisores finais aplicáveis, harvest e shipping
  normais. A suite global precisa estar verde no HEAD final; timeout, falha ou HEAD
  novo exige rerun pelo pai final. Revisões de implementação e finais podem usar até
  três olhos em paralelo; autoria, mãos, fidelidade e revisão da spec continuam exclusivas.
- Dentro de uma sessão Orca (`ORCA_WORKTREE_ID` presente), use obrigatoriamente o backend Orca
  ligado à worktree pai. Cada task nasce no `base_sha` global com parent visual explícito e roda a
  TUI nativa do Pi em terminal próprio, com conclusão automática após o trabalho. O host registra
  os eventos nativos e verifica o retorno. Resumes preservam a apresentação original da tentativa;
  não abra outra sessão no JSONL de um job vivo. Divergência ou falha não autoriza fallback silencioso.
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
