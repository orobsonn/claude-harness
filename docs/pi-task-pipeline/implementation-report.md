# Relatório de implementação e evolução da pipeline Pi

Estado: implementação em validação. O PR funcional ainda está em draft e a release
desta mudança ainda não foi cortada.

## Comportamento implementado

Toda task de uma nova run LIGHT/FULL é despachada para uma sessão pai local. O pai
global conserva a aprovação do plano, a ordem das dependências, a integração dos
SHAs verificados e as validações finais. Cada task executa TDD, fidelidade,
congelamento dos testes, implementação, captura e revisão/correção nativos. Tasks
independentes usam worktrees e processos separados; dependentes aguardam integração.

Dentro do Orca, a worktree filha parte do SHA exato da worktree global e aparece sob
ela no ADE. Um terminal próprio executa o worker do harness e a extensão oficial do
Orca publica o estado do Pi. O registry conserva os handles. O harness não cria um
segundo DAG usando os objetos Run/Task/Dispatch do Orca. A visibilidade é verificada
pelo campo `surface` retornado pelo terminal, não inferida da presença de um PID.

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

## Validação real escolhida

Projeto: **Syntifai-AI/victor-frontend**. Issue:
[#5 — fundação APP, registro de ações e trava de clique duplo](https://github.com/Syntifai-AI/victor-frontend/issues/5).
A issue estava aberta e a implementação não existia na base selecionada
`b91265e54d7446fd026f523848ffec06922e7b56`.

O protótipo anterior reutilizou um plano histórico. Esta validação usa a issue aberta
e exige trabalho real: migrações APP reaplicáveis, auditoria com redação, idempotência
concorrente, reconciliação da allowlist no Worker e retenção por scheduled handler.
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
o handle, tab e pane exatos no layout, conectados e ativos. O processo recebeu a
identidade Orca correta e o diretório da extensão oficial; a publicação do status
pelo hook ainda não foi observada diretamente.

## Evidências e fechamento pendente

- [PR funcional #903](https://github.com/orobsonn/claude-harness/pull/903), ainda draft
  com [CI aprovado em `38ac8e0`](https://github.com/orobsonn/claude-harness/actions/runs/34165435156).
  A correção posterior que fixa a identidade do host exige seu próprio CI.
- Testes focais de contexto, coordenação, revisão e adapter Orca: **73/73**.
- Suíte completa após a recuperação: **3478/3478**, sem falhas; a correção posterior
  de identidade do host passou em **6/6** testes focais e está no CI atual.
- O CLI host agora usa o payload AppImage extraído e o launcher estável oficial. A
  correção preserva os dois wrappers anteriores e tem rollback registrado em
  `/tmp/pi-orca-cli-repair-evidence.json`; não reiniciou o app nem o servidor.
- Ainda pendentes: confirmação do status Pi da nova sessão, conclusão e aprovação da issue
  FULL real, CI do PR funcional, merge e release esperada **2.6.0** pelo
  release-please. Nenhuma versão, changelog ou tag foi alterada manualmente.

Contrato oficial consultado: [worktrees](https://www.onorca.dev/docs/model/worktrees),
[CLI](https://www.onorca.dev/docs/cli/reference) e
[código da versão v1.4.177](https://github.com/stablyai/orca/tree/v1.4.177).
