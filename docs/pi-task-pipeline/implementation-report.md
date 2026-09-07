# Relatório de implementação e evolução da pipeline Pi

Estado: implementação em validação. O PR funcional ainda está em draft e a release
desta mudança ainda não foi cortada.

## Comportamento implementado

Toda task de uma nova run LIGHT/FULL é despachada para uma sessão pai local. O pai
global conserva a aprovação do plano, a ordem das dependências, a integração dos
SHAs verificados e as validações finais. Cada task executa TDD, fidelidade,
congelamento dos testes, implementação, captura e revisão/correção nativos. Tasks
independentes usam worktrees e processos separados; dependentes aguardam integração.

Dentro do Orca, a worktree filha parte do SHA exato da worktree global e registra
essa relação de parentesco. Um terminal próprio executa o worker do harness e a
extensão oficial do Orca publica o estado do Pi. O registry conserva os handles.
O harness mantém seu próprio fluxo, usando worktrees e terminais do Orca.

A presença no inventário do servidor e em `visualLayouts` não comprova que o cliente
remoto exibiu a execução. No runtime headless, o CLI `terminal focus` navega somente
o host; a abertura no cliente exige os RPCs nativos `worktree.activate` e
`session.tabs.activate` com `navigation: clients`. A entrega desses eventos não
inclui confirmação de renderização pelo cliente. Essa confirmação continua pendente
depois de o operador informar que não via a run.

Na verificação das 22:52 UTC, o servidor não tinha conexão remota estabelecida para
receber a navegação. Os eventos de abertura não são reaplicados automaticamente a um
cliente que se reconecta depois. A worktree global pertence ao setup original do
Victor e aparece diretamente na lista do projeto, sem `parentWorktreeId`.

O PR [#902](https://github.com/orobsonn/claude-harness/pull/902), que paraleliza olhos,
está incorporado. Adversary permanece obrigatório por task; compliance e security de
implementação são escolhidos quando aplicáveis e, depois de despachados, precisam
produzir revisão atual e saudável. Revisões finais conservam suas exigências.

O `shared_context` tem passagem seletiva: até 2 KiB por task na admissão, vinculado à
identidade e à revisão de origem. A task mantém seu diário próprio e devolve um
`context_return` vinculado ao resultado e HEAD verificados. O pai global decide quais
descobertas revalidar e incorporar. Diários completos não são herdados pelos olhos.

## Correções encontradas durante a evolução

- Um lock parcialmente escrito podia ser interpretado como abandonado; a retomada
  agora conserva o owner vivo e recupera apenas o caso comprovado de abandono.
- As mãos nativas também precisam carregar o contrato da task. A ponte verifica os
  recursos e a identidade da filha antes de permitir sua execução.
- O retorno da task precisa comprovar evidência atual e árvore limpa. Texto de
  conclusão, PID encerrado ou aprovação antiga não liberam a integração.
- A integração registra sua intenção antes do merge e reconcilia somente o commit
  com parentage e árvore esperados. Correções conservam proveniência histórica e
  invalidam os gates agregados.
- Uma resposta perdida na criação de worktree Orca não autoriza uma segunda criação.
  A recuperação procura a tentativa reservada e preserva o estado incerto.
- O launcher desativa extensões automáticas. O status oficial do Pi no Orca precisa
  ser carregado explicitamente nesse caminho, com a identidade do terminal da task.
- A instalação local do harness também precisa ser regenerada pelo instalador; mudar
  somente o código fonte deixaria o projeto usando a pipeline anterior.
- A interrupção da FULL revelou que a retomada exigia uma spec selada e um plano já
  escrito. O preflight agora permite reabrir o rascunho ou o checkpoint anterior ao
  plano, preservando identidade, hashes e gates pendentes. Recibos e arquivos de
  progresso impedem tratar um plano perdido como planejamento ainda não iniciado.
  A correção reutiliza a validação nativa do recibo adversarial; observar o status e
  criar diretórios vazios não passa a bloquear a retomada.

## Validação real escolhida

Projeto: **Syntifai-AI/victor-frontend**. Issue:
[#5 — fundação APP, registro de ações e trava de clique duplo](https://github.com/Syntifai-AI/victor-frontend/issues/5).
A issue estava aberta e a implementação não existia na base selecionada
`b91265e54d7446fd026f523848ffec06922e7b56`.

O protótipo anterior reutilizou um plano histórico. Esta validação usa a issue aberta
e exige trabalho real: migrações APP reaplicáveis, auditoria com redação, idempotência
concorrente, reconciliação da allowlist no Worker e retenção de 18 meses.
Não há publicação ou deploy do Victor neste teste.

A tentativa da sessão `e4a00af2-21cd-44f0-a6cb-b3a668a48a3d` foi interrompida e não
serve como prova da pipeline. A nova FULL usa a worktree Orca
`victor-frontend/pi-harness-full-victor-5`. A sessão global
`68877ea4-a3da-4bc5-b39a-cfe8b000f6c1` começou em 2026-09-07 às 22:09 UTC,
com `task_pipeline_version: 1` desde a classificação. O terminal Orca é
`term_16c3c4e5-7eec-426d-934f-ab38593dec3d`.

Na base real, o instalador copiou **151 arquivos** do harness, a suíte baseline passou
**79/79** e o typecheck está verde. O smoke do Orca confirmou processo, lineage e os
layouts visuais. Em runtime headless, `surface: background` descreve a superfície do
terminal e não significa ausência da worktree no ADE. A sessão global real confirmou
o handle, tab e pane exatos no layout do servidor. O processo recebeu a identidade
Orca correta, e `terminal.agentStatus` confirmou `isRunningAgent: true` e
`status: working`. Isso comprova processo/status, mas não a tela do operador.

Às 22:55 UTC, somente o worker dessa FULL foi interrompido, após conferência do PID,
início do processo e descriptor. A spec ainda estava em draft e nenhuma task de
implementação havia sido despachada. O motivo é uma contradição de requisitos: AC1.7
exige registrar a mudança na primeira requisição, enquanto as recusas de autenticação
devem acessar zero bindings. A spec atribuiu ao operador uma interpretação que ele
não forneceu. O APPROVE produzido sobre essa premissa não é aceito como prova. A
decisão foi solicitada ao operador; a mesma sessão e seus registros estão preservados
para retomar com a especificação corrigida e uma nova revisão.

A correção de recuperação foi exercitada contra essa mesma sessão: o preflight
retornou `stage: draft`, sem mudar um byte do gate-state, e o gate nativo continuou
negando o planner. **160/160 testes focais** de retomada, markers, launcher, dispatch
e task mode passaram. A revisão independente da correção foi aprovada sem findings
restantes. O instalador oficial regenerou o vendor local e o da worktree real; o
preflight instalado também preservou os registros e manteve o planner bloqueado.
Nenhum provider foi reiniciado para essa verificação.

Alternativa identificada, ainda sem despacho: `orobsonn/proj-lainny` #47,
`escritor-publico-lead`, já implementada no PR #56. Seu plano histórico FULL tem
cinco tasks, duas raízes independentes, base anterior
`84b946d5e12b516952c9cdb8696fbab6382ef813` e evidência histórica de 766 testes.
A operação de painel Cloudflare permanece fora do replay local, como na entrega
original. Essa alternativa atende ao pedido inicial de usar uma issue já implementada.

## Evidências e fechamento pendente

- [PR funcional #903](https://github.com/orobsonn/claude-harness/pull/903), ainda draft
  com [CI aprovado em `36fb7e7`](https://github.com/orobsonn/claude-harness/actions/runs/34165975643),
  incluindo a correção que fixa a identidade do host.
- Testes focais de contexto, coordenação, revisão e adapter Orca: **73/73**.
- Suíte completa após a recuperação: **3478/3478**, sem falhas; a correção posterior
  de identidade do host passou em **6/6** testes focais e está no CI atual.
- O CLI host agora usa o payload AppImage extraído e o launcher estável oficial. A
  correção preserva os dois wrappers anteriores e tem rollback registrado em
  `/tmp/pi-orca-cli-repair-evidence.json`; não reiniciou o app nem o servidor.
- A versão Orca 1.4.177 também apresentou `tab_not_found` ao tentar fechar a aba
  vazia, por divergência no owner da sessão. A correção oficial
  [#18073](https://github.com/stablyai/orca/pull/18073) está na
  [v1.4.197](https://github.com/stablyai/orca/releases/tag/v1.4.197).
  O artefato oficial e o rollback foram preparados, sem instalar: reiniciar o serviço
  atual encerra todas as runs no seu cgroup. Essa falha é distinta da falta de cliente
  remoto conectado e não foi tratada como prova da causa da invisibilidade.
- Ainda pendentes: confirmação visual no cliente Orca, conclusão e aprovação da issue
  FULL real, CI do fechamento do PR funcional, merge e release esperada **2.6.0** pelo
  release-please. Nenhuma versão, changelog ou tag foi alterada manualmente.

Contrato oficial consultado: [worktrees](https://www.onorca.dev/docs/model/worktrees),
[CLI](https://www.onorca.dev/docs/cli/reference) e
[código da versão v1.4.177](https://github.com/stablyai/orca/tree/v1.4.177).
