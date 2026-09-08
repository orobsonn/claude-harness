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

Na tentativa anterior com o Victor, a verificação das 22:52 UTC não encontrou uma
conexão remota estabelecida para receber a navegação. Antes da remoção, o
`worktree.show` oficial registrava a worktree global como filha explícita da main
original. Um snapshot persistido que mostrava `parentWorktreeId: null` não refletia
essa relação e não é usado como autoridade para a linhagem.

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
- A divisão de tasks também precisa preservar um RED que realmente execute na base.
  O planejamento Pi agora orienta testar novos componentes por uma entrada existente
  e reunir seus escopos quando necessário. O test-author não cria scaffolds de
  produção para resolver imports; um novo dado exportado por módulo existente
  continua sendo um contrato válido para testar.

## Validação real escolhida

Projeto: **orobsonn/proj-lainny**. Issue:
[#47 — escritor-publico-lead](https://github.com/orobsonn/proj-lainny/issues/47),
já implementada no PR #56. O replay parte do pai exato dessa implementação,
`84b946d5e12b516952c9cdb8696fbab6382ef813`, e permanece local: a operação de
painel Cloudflare e qualquer publicação continuam fora da prova.

A FULL nova usa a worktree Orca
`/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`, criada no
mesmo projeto, setup e host da main registrada. O código do harness estava em
`a9f33865ffa4eeb77631613823a52f8dd17baab6`; o bootstrap instalado foi fixado em
`8397a9e9c80ee766693a58ac3cfce1364018b394`. O provider foi lançado em
2026-09-07 às 23:46:31 UTC na sessão global
`b2681197-8aa4-4ebb-856e-a35898d5c4bb`. O primeiro terminal foi
`term_4c012bf1-9bec-44be-ae61-e2b47e40edb4`; a retomada usa
`term_664750f1-4d26-4f54-a311-bf750f141909`, com o mesmo título
`RUN REAL · Pi Harness FULL · Lainny #47`. O inventário confirmou um único
terminal, e o estado oficial do agente retornou `working`. O gate registra a feature `escritor-publico-lead-orca` e
`task_pipeline_version: 1` desde a classificação. Os registros desta execução ficam
em `/tmp/pi-full-lainny-47-orca-run` e `/tmp/pi-full-lainny-47-orca-resume-1`.
Antes da retomada, o instalador incorporou as orientações de visibilidade de
`e053d7b` no commit local `4b0c42f`; esse delta não altera o código do executor.

Na base real, a baseline passou **699 testes em 80 arquivos**, além do typecheck,
audit com zero achados e docs-check em **3 arquivos PRD**. Os dois smokes Orca
executados localmente também passaram. A navegação do cliente foi despachada e o RPC
ativo foi confirmado, mas a renderização na tela do operador ainda aguarda
confirmação. Isso comprova o processo e o caminho de navegação, não a exibição visual.

A primeira draft foi escrita e enviada ao adversary. Uma checagem independente
identificou que ela atribuía scaffolds de produção ao test-author. A correção de
decomposição preserva duas raízes paralelas e reúne rota e componentes novos numa
task testada pela entrada HTTP já existente. O worker anterior foi encerrado após
conferência de identidade, e o launcher retomou a mesma sessão com esse feedback.
O pai escreveu a nova draft `978e8148` pela ferramenta nativa e recebeu seis achados
do adversary. Após corrigi-los, a spec `407ec453` recebeu `APPROVE` sem achados
aplicáveis; o harness registrou o selo e `brainstormed`, e o planner foi despachado.
Nenhum gate foi alterado manualmente. Ainda não há task filha despachada nem
aprovação FULL nesta atualização.
A execução precisa percorrer planejamento, tasks, integração e olhos finais antes
de servir como prova completa.

A tentativa anterior no Victor foi encerrada e removida pela operação oficial do
Orca. Sua branch foi preservada em `2eb4033`, com evidência arquivada em
`/tmp/pi-full-victor-5-archived-proof`; ela não conta como prova da pipeline. O
preflight de recuperação exercitado naquela sessão preservou os gates em draft e
motivou a cobertura que agora permite retomar specs e checkpoints anteriores ao
plano sem inventar aprovação.

## Evidências e fechamento pendente

- [PR funcional #903](https://github.com/orobsonn/claude-harness/pull/903), ainda draft.
  O [CI em `72278d9`](https://github.com/orobsonn/claude-harness/actions/runs/34172093965)
  registrou **3488 testes: 3486 passaram, nenhum falhou e 2 foram ignorados**. Os dois
  smokes Orca executados localmente passaram (**2/2**).
- Testes focais de contexto, coordenação, revisão e adapter Orca: **73/73**.
- A correção de identidade do host passou em **6/6** testes focais e está no CI atual.
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
