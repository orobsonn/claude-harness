# Validação FULL em projeto real

Status: prova FULL local concluída. As três tasks foram integradas e revalidadas;
agregado, harvest, olhos finais, demo, shipment e memória finalizaram no HEAD limpo
`6d69656f6abe2944ede38feee8f5d9c8eaaed7b9`. Este registro fecha a prova local em
8 de setembro de 2026; a publicação do harness é rastreada pelo
[PR #903](https://github.com/orobsonn/claude-harness/pull/903) e pelo release-please.

- Projeto: `orobsonn/proj-lainny`, [issue #47](https://github.com/orobsonn/proj-lainny/issues/47), já implementada no PR #56.
- Base anterior à implementação: `84b946d5e12b516952c9cdb8696fbab6382ef813`.
- Worktree Orca: `/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`.
- Sessão global: `228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`.
- Feature: `escritor-publico-lead-tui`, FULL com `task_pipeline_version: 1`.
- Source funcional validado: `0293fce2f4f47dcd50c79f1a3399dd7428980c82`.
- Bootstrap: `41f63723b50338d20015356a2275e25abcedcf9b`.
- Runtime das tasks: `8db003b17cd55d1b3d15353b850743a65e2dd92e722787eb99dc13eb5c870a87`.
- Runtime corrente do pai global: `04c30b9541a6113f6b86c82817add82d7315dfb7be093e553c91487c79c00845`,
  migrado somente após o encerramento do processo antigo, no checkpoint
  `bb67bf5450accc511c6c4c340485dfc4c3487658`.
- Execução global original: terminal `term_3628621d-98c2-48e0-a06a-824e36a93a85`
  e job `/tmp/pi-full-lainny-47-orca-tui-run-2`; terminou por timeout exato às
  `06:39:11.289Z`.
- Retomada global final: mesma sessão e worktree, terminal
  `term_cfe31d28-c422-411a-9e13-8f634d6bfd04`, job
  `/tmp/pi-full-lainny-47-orca-tui-migrated-runtime-resume-9707f08f-d21d-4fcd-b67d-646a75260d35`
  e esforço `medium`; terminou às `13:11:06.272Z` com exit 0, sem sinal nem timeout.
- Baseline do produto: 699 testes em 80 arquivos, typecheck, audit sem achados e docs-check de três PRDs.
- Validação do source atual: **3540/3540 testes aprovados**, `node_returncode: 0`, em
  `/tmp/pi-task-pipeline-final-lineage-full-20260908-result.json`; o
  [CI 34228715081](https://github.com/orobsonn/claude-harness/actions/runs/34228715081)
  terminou com sucesso às `12:58:11Z`. A FULL local encerrou às `13:11:06.272Z`.

A spec `79c8aed74db53fbfab0bfab1160b9ff1400e3a12035e52dcafbd3ddfc58b6d0e` foi
selada e o plano `df6797ba244bc7c351317fb22df41b1937f14c0b2956e45959a52e65bf8dced3`
recebeu aprovação canônica. São três tasks e 44 contratos: T1 e T2 são raízes
independentes; T3 depende das duas integrações. T1 e T2 começaram em paralelo.

A T2 `task-2-public-input-allowlist` concluiu com exit 0 e foi integrada no merge
`d00b869698d114e6d7715cec74c27457c0d3b46a`. Seu freeze real é
`e24be92ec26ffa28428a70f3dc396e08fe2f5933` e o child HEAD aprovado é
`595b30fd9f3d12f647d0dc437329d8fbeb5d9bd3`. Adversary, compliance e security
revisaram esse mesmo HEAD com sobreposição real e retornaram sem achados. T1 e T3
também foram integradas, conforme abaixo.

A T1 `task-1-data-idempotency-ceiling` também concluiu e foi integrada. Seu freeze é
`f6ed2f017acb0b14c3782ddb790e0a988bc10709`, o child HEAD é
`9508426cbf311a5aee0a917d4f403e27494d0ae8` e a integração é
`3f0618853e6858349cf21a20b8b4e50bb29ad000`. Os três olhos nativos finais, IDs
`4bb751e5`, `b1a7dafe` e `097291c4`, retornaram `issues: []`, e o re-gate passou. T3
foi despachada sobre essa integração e concluiu posteriormente.

A T3 usa a tentativa `5fa56648-c91e-42bf-8fcd-b3ab23ecb7d2`, sessão local
`9c19e24c-3f1b-4a46-862a-5917d723862c` e terminal Orca retomado
`term_5cd4961e-f679-48f2-b2af-d359f091eca7`. O host confirmou Pi nativo,
`presentation: tui`, binding à terceira task e runtime imutável `8db`. Ela recebeu
1168 bytes de contexto curado. A fidelidade `71647ad7-35cc-490` passou sem achados e o
freeze `ed69ed0d2af3f436f60e20846c68c870a4c3e880` inclui somente os cinco specs.
O executor revelou três bugs de fixture; o pai reabriu autoria e fidelity. Após o
timeout às `09:37:05.676Z`, o orquestrador retomou a mesma tentativa e sessão às
`09:38:23.028Z`. A produção foi preservada por paths exatos durante o novo RED;
fidelity `94fa5c8f-b322-4d6` passou e o freeze corrigido é
`a2c8dcdcb4598f154e30c4b93baf9eeaf63ca10d`. O executor fresco `70e02c8b-24c0-41c`
verificou 26 testes focais e 72 de regressão, typecheck e diff-check, todos aprovados.
A captura atual precedeu o commit `368164d74a505e904ff44a2d332432ee3897ed9d`.
Compliance encontrou normalização excessiva de telefone; o sniper corrigiu apenas
o helper público em `39da33d22716555ceb78e38952db3d5e7d82a8a9`. Após os três olhos
sem achados de implementação, um autor fresco acrescentou a regressão persistente
para dois telefones com letras. Fidelity `b05a2022-c7a2-4c7` passou e o freeze corrente
é `43dc5239a4ae25fffdf1f77c12ee212d078339d9`. O executor `08212d30-e95a-4d8`
verificou novamente 26/72 testes, tipagem, diff e árvore limpa, com captura aceita.
Os olhos finais `924c347b`, `fc25863a` e `6717f1af` retornaram sem achados, o harness
aceitou seus recibos e o re-gate, e o worker terminou com exit 0 às `10:19:29.825Z`.
A integração nativa é `8daffe75c3582310fca64d45a69978ddd29c7521`, com
`result_sha256` `a54741e049677a6a441815a12ad4bbc3fd8546e4471735677b89b76e62ae1bec`.
Houve solicitação de navegação para o terminal retomado e, depois da integração,
para a TUI global existente, sem ACK de cliente remoto.

O source final passou a somar testes/fixtures ao escopo do receipt, recusar globs que
os rails literais não suportam, conferir plano/spec atuais e ligar a integração à
aprovação host-owned exata. As tasks mantiveram o runtime `8db`; depois da migração do
pai, T3 foi integrada em `89c9d25295370d52dfaa0955ce7e7c8dacbfcc85`, com child HEAD
`7b63e94c3b7862b0b31215b269e968b964a3a478`. O reader do source `0293fce`
revalidou as três tasks e passou; o resumo está em
`/tmp/pi-task-pipeline-all3-0293-final-control.json`, no HEAD final `6d69656...`.
As worktrees de T1 e T2
não foram recriadas. A instalação fria também verifica a skill
`harness-task-pipeline`.

T1 atingiu o timeout às `06:05:29.827Z`; o pai global retomou nativamente a mesma
tentativa às `06:07:58.310Z`, preservando sessão, worktree e runtime. Essa retomada
task-local é distinta da retomada supervisionada do job global. Depois do timeout
global, o primeiro `harness_tasks status` encontrou T1 `running` e T2 `integrated`,
sem reiniciar nenhuma filha.

A T1 terminou em 3h27m17s, com 71 chamadas nativas: 27 tentativas de test-author,
19 revisões de fidelity, um executor, seis snipers e seis lotes dos três olhos.
Uma tentativa inicial de autoria foi recusada antes de executar. A soma de
`durationMs` foi 2h42m12s e conta simultaneamente olhos sobrepostos. A T2 concluiu em
11m18s, inteiramente
sobreposta à T1. A atividade medida se concentrou nos ciclos de correção/fidelity
da T1; essas métricas não isolam a latência do Orca ou do harness. O artefato
`/tmp/pi-task-pipeline-t1-t2-final-metrics.json` mantém a FULL como incompleta.

Os grants levaram 630 bytes de contexto para T1 e 636 para T2. T1 e T2 devolveram
1292 e 1403 bytes, ligados às identidades e HEADs exatos; esses retornos ainda não
são harvest global. A TUI
nativa também consumiu steering factual nas sessões global e T1 sem reinício ou nova
orquestração.

O smoke no host Orca confirmou a TUI nativa, o PTY e a gravação dos eventos usados pelo
harness. Na run corrente houve snapshot do terminal e navegação despachada para o mesmo
handle, mas ainda não existe ACK confirmado do cliente remoto. Isso não altera a
autoridade dos gates.

A sessão anterior e suas T1/T2 foram encerradas sem integração. As duas worktrees foram
removidas oficialmente; branches, patches e bundle ficaram preservados em
`/tmp/pi-full-lainny-47-old-diagnostics` apenas para diagnóstico. Nenhum receipt, código
ou aprovação antiga será reutilizado.

Os critérios vêm da issue e dos artefatos normativos históricos. Cloudflare, deploy,
push e publicação do produto permanecem fora da prova. O primeiro agregado passou 785
testes em 88 arquivos, tipagem, audit sem vulnerabilidades e diff-check com Node 22.23.1.
O docs-check conferiu as oito seções em todos os três PRDs por comandos grep
autorizados; o wrapper Bash inicial foi recusado e não executou. A demonstração local
passou nos sete testes do spec público. O harvest foi aplicado em `MEMORY.md` e
commitado em `8034e3ddf5b1676a89ab210e52d0973d2624c96c`.
A revisão final desse HEAD encontrou um achado no limite da leitura via DefaultReader.
T3 foi retomada na mesma tentativa, reintegrada e revalidada junto com T1 e T2. A
migração preservou os hashes de plans, state e sessions; a prova está em
`/tmp/pi-global-runtime-migration-0293fce-20260908`. No HEAD reintegrado
`89c9d25295370d52dfaa0955ce7e7c8dacbfcc85`, `npm test` passou 785/785 testes em
88 arquivos em 74,63 s; typecheck, audit sem vulnerabilidades e diff-check terminaram
com exit 0, e a demonstração pública passou 7/7 testes. O harvester
`4da10f1c-9b89-460` concluiu em 22,9 s e o delta foi aplicado no commit limpo
`6d69656f6abe2944ede38feee8f5d9c8eaaed7b9`. Compliance `9adbc003`, security
`9d760882` e adversary `1970f201` revisaram esse HEAD com o mesmo digest
`a53b135e708c0ef3e4d07bebd03befb59dfb9d806d0589c3b0a199fe93b6a816`; todos
retornaram `issues: []` e `accepted: true`. `final-review` e `demo-done` foram aceitos.
O shipper `d98621b0-db85-45a` verificou entrega `LOCAL-ONLY`, sem efeitos externos, e
terminou `DONE`. `memory-finalized.json` registra o mesmo HEAD e
`finalized_at: 2026-09-08T13:10:53.888Z`. O estado e as evidências detalhadas ficam no
[relatório de implementação](implementation-report.md).
