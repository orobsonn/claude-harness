# Validação FULL em projeto real

Status: primeiro ciclo das três integrações, agregado e harvest concluído. A revisão
final reabriu T3 pelo limite de leitura do stream; a correção recebeu os três pareceres
sem achados. A reintegração aguarda corrigir a comparação indevida de SHAs no reader.
Este registro não declara aprovação antes do término.

- Projeto: `orobsonn/proj-lainny`, [issue #47](https://github.com/orobsonn/proj-lainny/issues/47), já implementada no PR #56.
- Base anterior à implementação: `84b946d5e12b516952c9cdb8696fbab6382ef813`.
- Worktree Orca: `/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`.
- Sessão global: `228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`.
- Feature: `escritor-publico-lead-tui`, FULL com `task_pipeline_version: 1`.
- Commit funcional validado: `c3311f1b28ec58249a48d3112fb7e8346b438bfb`.
- Bootstrap: `41f63723b50338d20015356a2275e25abcedcf9b`.
- Runtime fixado: `8db003b17cd55d1b3d15353b850743a65e2dd92e722787eb99dc13eb5c870a87`;
  mudanças posteriores do source não foram injetadas no processo vivo.
- Execução global original: terminal `term_3628621d-98c2-48e0-a06a-824e36a93a85`
  e job `/tmp/pi-full-lainny-47-orca-tui-run-2`; terminou por timeout exato às
  `06:39:11.289Z`.
- Retomada global supervisionada: mesma sessão, worktree e runtime, terminal
  `term_09ed2314-68a4-4ed6-b761-7a5296b8c757`, job
  `/tmp/pi-full-lainny-47-orca-tui-timeout-resume-054e69e6-32b8-4f6a-8769-3500c332027e`
  e worker `1300290`/start ticks `49397430`, ativo desde `06:39:38.700Z`.
- Baseline do produto: 699 testes em 80 arquivos, typecheck, audit sem achados e docs-check de três PRDs.
- Validação local desse commit funcional: 3523 testes, todos aprovados, sem skips, com
  `--test-concurrency=2`; o [CI 34195602331](https://github.com/orobsonn/claude-harness/actions/runs/34195602331)
  terminou com sucesso às `06:44:09Z`, incluindo testes, secrets e gate. A FULL real
  continua em andamento. As mudanças posteriores de runtime, prompts, testes e docs
  ainda precisam de commit e CI próprios.

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
aprovação host-owned exata. Como o runtime vivo `8db` antecede esses guards, T1 e T2
foram revalidadas separadamente pelo reader de `c3311f1` e passaram. Após integrar T3,
o reader aceitou todas as três no HEAD `8daffe75...`; o resumo está em
`/tmp/pi-task-pipeline-all3-c331-integration-control.json`. Todos os receipts finais ainda
serão revalidados pelo source final depois da FULL. A instalação fria também verifica
a presença da skill `harness-task-pipeline`.

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
push e publicação do produto permanecem fora da prova. O agregado passou 785 testes
em 88 arquivos, tipagem, audit sem vulnerabilidades e diff-check com Node 22.23.1.
O docs-check conferiu as oito seções em todos os três PRDs por comandos grep
autorizados; o wrapper Bash inicial foi recusado e não executou. A demonstração local
passou nos sete testes do spec público. O harvest foi aplicado em `MEMORY.md` e
commitado em `8034e3ddf5b1676a89ab210e52d0973d2624c96c`.
A revisão final desse HEAD encontrou um achado no limite da leitura via DefaultReader.
T3 foi retomada na mesma tentativa; seu recibo anterior fica suspenso durante a
correção. Ainda faltam reintegração, revalidação e aprovação FULL. O estado e as
evidências detalhadas ficam no [relatório de implementação](implementation-report.md).
