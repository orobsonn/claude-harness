# Relatório de implementação da pipeline Pi

Estado: implementação concluída no código fonte e prova FULL local concluída. As
três tasks foram integradas e revalidadas; agregado, harvest, olhos finais, demo,
shipment e memória finalizaram no HEAD limpo
`6d69656f6abe2944ede38feee8f5d9c8eaaed7b9`. Este registro fecha a prova local em
8 de setembro de 2026; a publicação do harness é rastreada pelo
[PR #903](https://github.com/orobsonn/claude-harness/pull/903) e pelo release-please.

## Comportamento final

Uma run LIGHT/FULL com `task_pipeline_version: 1` mantém spec, plano e aprovação na
sessão global. Depois da aprovação nativa do plano, `harness_tasks` cria uma sessão pai
local para cada task pronta. Cada sessão recebe somente o contrato focal, executa a
sequência TDD nativa e devolve um resultado verificável. O pai global conserva o DAG,
integra SHAs aprovados e executa testes agregados, harvest, olhos finais e entrega.

O grant da task é ligado à sessão, feature, hashes atuais de spec/plano, branch, base e
dependências integradas. Recibos de dependências são revalidados contra o registry do
pai; uma task já admitida pode reconhecer o recibo histórico correto após uma correção
ancestral, mas uma admissão nova exige a integração corrente. Retomadas preservam a
mesma tentativa e recusam identidade estrangeira, artefato alterado ou processo vivo
incompatível.

Dentro da task, test-author, executor e sniper permanecem sequenciais. O freeze commit
é linear, limpo e restrito a testes/fixtures autorizados; fidelity referencia esse
commit real. Captura e hand-record continuam fatos distintos. Os olhos de implementação
revisam um HEAD imutável: adversary usa `HARNESS_TASK_CONTEXT`; compliance e security
usam `HARNESS_TASK_REVIEW` antes do contexto para adquirir leases paralelas. O revisor
exclusivo de fidelidade continua serial. Os modelos, esforço e complexidade vêm das rotas Pi do
próprio grant, sem consultar o routing do Codex.

Os relatórios de plan-reviewer e dos olhos usam o JSON canônico validado pelo host.
Prosa, tokens `APPROVE`, PIDs encerrados ou estado alegado pelo modelo não criam
evidência. A integração registra intenção antes do merge e só aceita retorno atual,
árvore limpa, escopo autorizado, receipts saudáveis e parentage esperado. Correções
invalidam os gates agregados que dependem do HEAD anterior.

O `shared_context` usa o memory-cycle existente. O pai pode admitir até 2 KiB de brief
curado por task; esse conteúdo é referência não confiável e não transfere autoridade,
reviews ou diário de siblings. A task mantém seu diário local e pode devolver um
`context_return` ligado à sessão, task e HEAD. O pai revalida e cura explicitamente o
que deve entrar em sua memória.

No Orca, a worktree filha parte do SHA global e registra parent, repo, host, projeto e
setup. O registry guarda worktree, terminal, tab e presentation. Tasks novas executam a
TUI nativa do Pi no PTY do Orca; o mesmo processo grava eventos estruturados por uma
extensão do harness. O worker supervisiona timeout e término sem substituir a TUI por
um renderer textual.

O Orca pode criar também seu primeiro terminal padrão ao criar uma worktree, mesmo
sem `--activate`. Esse terminal pode executar configuração do projeto; o harness
preserva essas abas e identifica a execução Pi pelo handle registrado no job. Uma
limpeza operacional exige confirmar no Orca que o terminal exato é um shell sem uso.

Inventário e `surface` não equivalem a confirmação no cliente remoto. A CLI pública do
Orca 1.4.177 navega `terminal focus` somente no host. A pipeline conserva handles e
reporta `visible` ou `background`; a confirmação de que um cliente do usuário exibiu a
aba continua sendo uma observação separada.

## Correções incorporadas

- Locks e retomadas distinguem owner vivo, PID reutilizado e abandono comprovado. Um
  crash antes do provider não deixa uma admissão falsa que impeça retry.
- A identidade e os recursos da task são instalados também nos filhos nativos. Gates
  bloqueiam cerimônia global, outras tasks, entrega e mutação fora do contrato local.
- Criação Orca com resposta perdida é reconciliada pelo marcador único da tentativa;
  ela não autoriza criar outra worktree ou terminal.
- A recuperação global aceita uma spec draft legítima e o checkpoint selado anterior
  ao plano sem promover gates. Plano presente continua sujeito à validação completa;
  progresso real impede tratar um plano removido como ausência inicial.
- O planejamento Pi verifica se o RED é coletável na base da task. Test-author não cria
  scaffold de produção para satisfazer import; componentes novos podem ser reunidos na
  task que os torna testáveis por uma entrada existente.
- O plan-reviewer agora pede o mesmo JSON `{verdict, findings}` exigido pelo parser. Os
  demais revisores também documentam as chaves exatas aceitas pelo schema.
- O grant inclui `dispatch_routes` das roles locais, derivados da mesma função que
  o gate usa. Isso remove a dedução incorreta por tiers ou por cópias vendorizadas do
  routing Codex.
- Fidelity de task passa a referenciar o freeze commit real, posterior à mão do
  test-author. O prompt explicita a ordem, exige SHA completo observado e checagem de
  tipagem/sintaxe antes do freeze.
- O pai local usa `harness-test-reviewer` exclusivo e conserva o ledger de fidelidade: matriz
  completa na primeira revisão, pacote consolidado para o autor e revalidação de
  falhas/evidências afetadas pelo diff. O brief inclui saída observada e exit status,
  sem substituir isso por uma alegação de sucesso. Ledger factual não concede
  aprovação nem entra nos olhos de implementação como veredicto anterior.
- A correção de um teste congelado preserva o delta de produção por paths exatos.
  RED, tipagem e fidelity voltam a ocorrer antes do novo freeze; o produto restaurado
  exige executor e captura atuais antes do commit e das revisões.
- A inspeção do resultado soma `scope_paths`, testes travados e fixtures. Sintaxe de
  glob que os rails literais não representam é recusada antes da admissão; nomes
  literais como `[slug]` continuam válidos. O consumer integrado volta a conferir os
  bytes atuais de plano/spec, o selo da spec e a aprovação host-owned que originou o
  grant, mesmo quando os IDs das tasks não mudaram.
- O prompt task-local distingue olhos de implementação do revisor exclusivo de fidelidade. O
  runtime paralelo já estava correto; prompts context-first faziam compliance/security
  parecer dispatches exclusivos e colidir com adversary.
- O transporte `tui` preserva stdin/stdout no PTY, duplica stderr para o arquivo de
  diagnóstico e fornece ao recorder somente o descritor efetivo. O arquivo de eventos
  é privado, confinado ao diretório do job e criado sem seguir symlink. Jobs antigos
  continuam no modo JSON.
- A verificação do pacote frio exige também a skill `harness-task-pipeline`; ausência
  desse arquivo agora falha antes de iniciar o Pi.

## Prova FULL corrente

O projeto escolhido é **orobsonn/proj-lainny**, issue
[#47 — escritor-publico-lead](https://github.com/orobsonn/proj-lainny/issues/47), já
implementada no PR #56. Os critérios vêm da issue e dos artefatos normativos históricos.
A prova parte da base anterior `84b946d5e12b516952c9cdb8696fbab6382ef813` e não copia
código, receipts ou aprovações do PR antigo. Cloudflare, deploy, push e publicação do
produto ficam fora desta execução.

Nessa base, a baseline do produto passou 699 testes em 80 arquivos, typecheck, audit
sem achados e docs-check de três PRDs.

A run corrente usa:

- worktree `/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`;
- sessão global `228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`;
- feature `escritor-publico-lead-tui`, modo FULL e `task_pipeline_version: 1`;
- source funcional validado `0293fce2f4f47dcd50c79f1a3399dd7428980c82`;
- bootstrap da worktree `41f63723b50338d20015356a2275e25abcedcf9b`;
- tasks T1–T3 preservadas no runtime imutável
  `8db003b17cd55d1b3d15353b850743a65e2dd92e722787eb99dc13eb5c870a87`;
- pai global migrado, somente depois do encerramento do processo antigo, para o runtime
  `04c30b9541a6113f6b86c82817add82d7315dfb7be093e553c91487c79c00845`, com
  checkpoint Git `bb67bf5450accc511c6c4c340485dfc4c3487658`;
- execução global original no terminal `term_3628621d-98c2-48e0-a06a-824e36a93a85`,
  título `RUN REAL · Pi TUI FULL · Lainny #47`, e job
  `/tmp/pi-full-lainny-47-orca-tui-run-2`;
- retomada global supervisionada anterior no terminal
  `term_09ed2314-68a4-4ed6-b761-7a5296b8c757`, job
  `/tmp/pi-full-lainny-47-orca-tui-timeout-resume-054e69e6-32b8-4f6a-8769-3500c332027e`;
- retomada final, na mesma sessão e worktree, no terminal
  `term_cfe31d28-c422-411a-9e13-8f634d6bfd04`, job
  `/tmp/pi-full-lainny-47-orca-tui-migrated-runtime-resume-9707f08f-d21d-4fcd-b67d-646a75260d35`
  e esforço `medium`; terminou às `13:11:06.272Z` com exit 0, sem sinal nem timeout.

A spec foi selada no SHA
`79c8aed74db53fbfab0bfab1160b9ff1400e3a12035e52dcafbd3ddfc58b6d0e`. O plano
`df6797ba244bc7c351317fb22df41b1937f14c0b2956e45959a52e65bf8dced3` recebeu
`APPROVE` canônico do plan-reviewer. Ele contém três tasks e 44 contratos: T1 e T2 são
raízes independentes e T3 depende da integração de ambas. T1 e T2 foram despachadas em
paralelo; seus workers começaram às `04:05:29.588Z` e `04:05:48.224Z`.

A T2 `task-2-public-input-allowlist` concluiu a sequência task-local e foi integrada.
O commit de freeze `e24be92ec26ffa28428a70f3dc396e08fe2f5933` precedeu o marker de
fidelity; o executor ficou ligado a esse freeze e produziu o child HEAD
`595b30fd9f3d12f647d0dc437329d8fbeb5d9bd3`. Adversary, compliance e security
revisaram esse HEAD com o mesmo digest e sobreposição real: as três sessões começaram
em uma janela de 47 ms, todas antes do primeiro término, e retornaram `issues: []`. O
worker terminou com código zero, sem sinal ou timeout. A integração é o merge commit
`d00b869698d114e6d7715cec74c27457c0d3b46a`, com
`result_sha256` `29a410f52e638fb80f7def08ebfad682cebd481a7a0161fca859656187716e09`.
Somente `src/db/colunas-entrada-publica.spec.ts` e
`src/db/colunas-gravaveis.ts` mudaram nessa task.

As tasks foram executadas no runtime `8db`, anterior aos guards finais de escopo,
autoridade e linhagem do source atual. Depois da migração controlada do pai, o runtime
novo integrou T3 em `89c9d25295370d52dfaa0955ce7e7c8dacbfcc85`, com child HEAD
`7b63e94c3b7862b0b31215b269e968b964a3a478`. O reader do source `0293fce`
revalidou T1, T2 e T3 no HEAD corrente; as três passaram. A evidência está em
`/tmp/pi-task-pipeline-all3-0293-final-control.json`, no HEAD final `6d69656...`.
A ausência atual das
worktrees de T1 e T2 não invalida os receipts host-owned nem exigiu recriá-las.

Os grants de T1 e T2 receberam, respectivamente, 630 e 636 bytes de contexto curado.
A T2 devolveu 1403 bytes de `task-context-return`, ligados à sessão, task e HEAD; isso
ainda não equivale a harvest global.

A T1 `task-1-data-idempotency-ceiling` também concluiu e foi integrada. O freeze final
é `f6ed2f017acb0b14c3782ddb790e0a988bc10709`, o child HEAD é
`9508426cbf311a5aee0a917d4f403e27494d0ae8` e a integração é
`3f0618853e6858349cf21a20b8b4e50bb29ad000`. Os três olhos nativos finais, IDs
`4bb751e5`, `b1a7dafe` e `097291c4`, retornaram `issues: []`; o re-gate foi marcado
com sucesso.

A T3 `task-3-public-worker-route` foi despachada depois das duas integrações, na base
`3f0618853e6858349cf21a20b8b4e50bb29ad000`. A tentativa
`5fa56648-c91e-42bf-8fcd-b3ab23ecb7d2` usa a sessão local
`9c19e24c-3f1b-4a46-862a-5917d723862c`, `presentation: tui` e o mesmo runtime
imutável. O grant recebeu 1168 bytes de contexto curado.
A fidelidade nativa `71647ad7-35cc-490` aprovou o ledger inicial sem achados. O freeze
`ed69ed0d2af3f436f60e20846c68c870a4c3e880` contém somente os cinco specs previstos e
é filho direto da base integrada. O executor encontrou três defeitos nas fixtures:
escapes de regex literal, receiver de um proxy SQLite e identidade de telefone na
preparação do teto. O pai local voltou ao autor de testes. A tentativa original
atingiu o timeout às `09:37:05.676Z`; o orquestrador retomou nativamente a mesma
tentativa e sessão às `09:38:23.028Z`, no terminal
`term_5cd4961e-f679-48f2-b2af-d359f091eca7`.

Após a correção das fixtures, o pai preservou somente os três paths de produção em
stash, repetiu o RED real e obteve PASS de fidelity em `94fa5c8f-b322-4d6`. O novo
freeze `a2c8dcdcb4598f154e30c4b93baf9eeaf63ca10d` altera apenas os três specs
afetados. Os markers nativos foram aceitos antes da restauração do produto. O executor
fresco `70e02c8b-24c0-41c` verificou 26 testes focais, 72 de regressão, typecheck e
diff-check, todos aprovados, sem precisar introduzir outra alteração. A captura atual
precedeu o commit de produção `368164d74a505e904ff44a2d332432ee3897ed9d`.
Os três olhos revisaram esse HEAD em paralelo. Compliance encontrou uma normalização
excessiva do telefone: remover qualquer caractere não numérico tornava válido um
valor como `abc83999999999`. O sniper `bf90709a-72fd-409` limitou a remoção a
separadores cosméticos, demonstrou a diferença antes/depois e passou as verificações.
A captura atual precedeu a correção `39da33d22716555ceb78e38952db3d5e7d82a8a9`;
uma nova rodada dos três olhos não encontrou defeitos de implementação.

A revisão também havia pedido cobertura persistente. O autor `2bdc6ab6-133d-437`
acrescentou dois telefones com letras à matriz existente, exigindo 400 sanitizado e
snapshot completo inalterado. A fidelity `b05a2022-c7a2-4c7` aprovou essa extensão
focal. Como a correção já estava commitada, o relatório separou o GREEN corrente da
reprodução histórica do erro, sem alegar um RED atual. O freeze final corrente é
`43dc5239a4ae25fffdf1f77c12ee212d078339d9`, filho da correção, e altera somente o
spec autorizado. O executor fresco `08212d30-e95a-4d8` confirmou 26/26 testes focais,
72/72 de regressão, typecheck, diff-check e árvore limpa; sua captura foi aceita.
Os três olhos finais desse HEAD — adversary `924c347b`, compliance `fc25863a` e
security `6717f1af` — retornaram `issues: []`, com o mesmo digest
`bc02040191281bc5586f00072bcf5424a5aa0f28979cd2ceeaa683ed22e89e81`.
O harness aceitou os três recibos e o re-gate. O worker retomado terminou às
`10:19:29.825Z`, com exit 0, sem sinal nem timeout. A integração nativa é
`8daffe75c3582310fca64d45a69978ddd29c7521`, com pais `3f061885...` e `43dc5239...`,
e `result_sha256` `a54741e049677a6a441815a12ad4bbc3fd8546e4471735677b89b76e62ae1bec`.
O retorno de contexto tem 1307 bytes e hash
`65a97918f5691f37d98592f5165ec6a1f3199bac1fd0168cb3d9befa6a261559`.
O Orca confirmou a TUI nativa no handle retomado; a navegação foi solicitada para a aba
existente, sem ACK remoto. Depois das integrações, a navegação voltou à TUI global.

No primeiro agregado, o pai usou Node `22.23.1`; typecheck passou e `npm test` aprovou
**785 testes em 88 arquivos**. `npm run audit` encontrou zero vulnerabilidades, e o
diff-check passou. O wrapper Bash do docs-check foi recusado antes de executar;
o pai conferiu as mesmas oito seções da CI com comandos `grep -lF` autorizados,
cada qual retornando os três PRDs esperados. O comando
`npm test -- src/worker-pre-checkout-publico.spec.ts` aprovou os sete testes que
demonstram criação 201, repetição 200 com a mesma referência, snapshots e auditoria.

O harvester nativo `c85ba287-464c-450` propôs os aprendizados reutilizáveis, e o pai
aplicou e commitou somente `MEMORY.md` em
`8034e3ddf5b1676a89ab210e52d0973d2624c96c`. A árvore está limpa; a revisão final
global desse HEAD encontrou um achado: o DefaultReader entrega um chunk inteiro
antes da comparação, enquanto a spec exige parar no byte 65.537. O código já impede
acumulação, parse e acesso ao banco para o chunk excessivo; a lacuna é a leitura
limitada no byte stream. O pai global retomou a mesma tentativa de T3 durante a
correção. Depois da revisão, do encerramento do runtime antigo e da migração
controlada, T3 foi reintegrada em
`89c9d25295370d52dfaa0955ce7e7c8dacbfcc85`. Nesse HEAD, `npm test` passou
**785/785 testes em 88 arquivos** em 74,63 s; typecheck, audit sem vulnerabilidades e
diff-check terminaram com exit 0. A demonstração pública passou 7/7 testes. O harvester
nativo `4da10f1c-9b89-460` concluiu em 22,9 s e propôs um delta de `MEMORY.md` sobre o
acumulador BYOB. O pai aplicou esse delta no commit
`6d69656f6abe2944ede38feee8f5d9c8eaaed7b9`, mantendo a árvore limpa. Compliance
`9adbc003`, security `9d760882` e adversary `1970f201` revisaram esse mesmo HEAD e o
digest `a53b135e708c0ef3e4d07bebd03befb59dfb9d806d0589c3b0a199fe93b6a816`; os três
retornaram `issues: []` e `accepted: true`. Os markers `final-review` e `demo-done`
foram aceitos. O shipper `d98621b0-db85-45a` verificou entrega `LOCAL-ONLY`, sem efeito
externo, e terminou `DONE`.

A primeira execução de T1 atingiu seu timeout de duas horas às `06:05:29.827Z`. O pai
global retomou nativamente a mesma tentativa às `06:07:58.310Z`, preservando sessão,
worktree, runtime e evidência válida. Separadamente, o próprio job global chegou ao
timeout às `06:39:11.289Z`; a supervisão retomou uma única vez a mesma sessão TUI. A
primeira chamada `harness_tasks status` encontrou T1 `running` e T2 `integrated`, sem
reiniciar nenhuma filha.

O ciclo completo da T1 durou 3h27m17s e teve 71 chamadas nativas: 27 tentativas de
test-author, 19 revisões de fidelity, um executor, seis snipers e seis lotes dos três
olhos. Uma tentativa inicial de autoria foi recusada antes de executar. A soma dos
`durationMs` reportados foi 2h42m12s e conta simultaneamente os olhos sobrepostos; ela
não deve ser lida como tempo de parede. A T2 concluiu em 11m18s e ficou
inteiramente sobreposta à execução da T1. Os dados mostram a concentração de trabalho
nos ciclos de correção/fidelity da T1; não medem isoladamente a latência do Orca ou do
harness. O resumo está em `/tmp/pi-task-pipeline-t1-t2-final-metrics.json`; ele ainda
não representa a conclusão da FULL.

A própria TUI consumiu mensagens de steering sem reinício: elas esclareceram o
contrato de `adversarial.enabled` na sessão global e levaram à T1 evidências sobre o
limite `maximo` e asserções inválidas na inspeção de tipos. O smoke no host
Orca confirmou Pi nativo em PTY, eventos estruturados e término
com código zero. A execução corrente tem snapshot legível e navegação despachada para
o mesmo handle. Não há ACK confirmado do cliente remoto; esses fatos comprovam
processo e transporte, sem declarar visibilidade remota nem aprovação FULL.

O source `0293fce2f4f47dcd50c79f1a3399dd7428980c82` foi enviado e
vendorizado de `core/pi` para `.pi`. A suíte local com concorrência 2 terminou com
**3540/3540 testes aprovados** e `node_returncode: 0`; a evidência é
`/tmp/pi-task-pipeline-final-lineage-full-20260908-result.json`. O
[CI 34228715081](https://github.com/orobsonn/claude-harness/actions/runs/34228715081)
terminou com sucesso às `12:58:11Z`. Esses resultados validam o source. A instalação
do runtime novo e a preservação da sessão são demonstradas separadamente pelo digest,
pelo checkpoint e pelos hashes before/after, sem antecipar a aprovação da FULL real.

## Diagnóstico preservado

A sessão anterior `b2681197-8aa4-4ebb-856e-a35898d5c4bb` chegou a despachar T1 e T2 e
revelou os conflitos de fidelity/freeze, rotas e prefixos descritos acima. Nenhuma das
duas tasks foi integrada. Ambas foram removidas pela operação oficial do Orca, com as
branches preservadas:

- `orobsonn/harness-task-task-1-data-idempotency-ceiling-ba901361-aa36-428b-af98-6cbf7ca32a58`
  em `391c7d6934084c1fafd8078c2e1d0b42ad0a0c4a`;
- `orobsonn/harness-task-task-2-public-input-allowlist-3812d701-d5ef-45f6-bfd2-9b407e00f852`
  em `4f7d5092d589ee050aa7d62a561567704ce63dd4`.

Os patches, estados e o bundle Git estão em
`/tmp/pi-full-lainny-47-old-diagnostics`, incluindo
`old-local-branches.bundle`. Esse material é diagnóstico e não pode autorizar ou
completar a sessão nova. A tentativa anterior no Victor também foi removida e arquivada;
ela não conta como prova desta pipeline.

## Custo e revisão de testes

A prova identificou consumo excessivo nos pais, polling por modelo e ciclos longos
de autoria/fidelidade. O diagnóstico, os valores separados por pai e filhos e as
limitações da medição estão em [Custo e convergência](cost-analysis.md). A espera
nativa e o prefixo estável de memória foram implementados no source. A auditoria
inicial cobriu 43 chamadas; o revisor exclusivo solicitado já está ligado ao
runtime. Sua [avaliação comportamental](test-reviewer-evaluation.md) concluiu cinco
casos com o resultado esperado e deixou um caso inconclusivo por timeout. Não há aprovação de
eficiência nem conclusão FULL por esses números.

## Captura depois de uma correção

No segundo ciclo de T3, o freeze dos testes foi `0793a0e2f58892b8dbab4eb25abc4644d88ffceb`.
O último sniper produziu uma captura vinculada ao HEAD de produção ancestral
`5e1ac1c...`; o código final `7b63e94c3b7862b0b31215b269e968b964a3a478`
recebeu os três pareceres sem achados e o re-gate. O reader recusou a integração
porque exigia igualdade literal entre esses dois SHAs de funções distintas.
O host nativo registra o HEAD da mão em `freezeCommitSha`; esse campo é uma
referência da captura, mesmo quando já houve commits de produção depois do freeze.

A retomada posterior de T3 não era necessária para corrigir o produto. A sessão
foi orientada a preservar código, testes e aprovações, e encerrou às `12:42:43.557Z`
com código zero. A correção do reader verifica ordem dos eventos e a cadeia
freeze → captura → HEAD, mantendo a identidade do produtor e os blobs congelados.
Nenhuma mão artificial ou reescrita de registros deve substituir essa correção.

Os 31 testes focais do reader passaram. A inspeção somente leitura dos registros
reais de T3 também passou às `12:49:26.379Z`, sem alterar estado, código ou aprovações;
o resumo está em `/tmp/pi-t3-receipt-lineage-source-verification-20260908.json`.
O consumidor integrado confere a mesma ancestralidade. A instalação global foi
atualizada somente após o processo anterior encerrar. A prova before/after e os
hashes de plans, state e sessions estão em
`/tmp/pi-global-runtime-migration-0293fce-20260908`; o checkpoint é
`bb67bf5450accc511c6c4c340485dfc4c3487658`. Os assets e as identidades das tasks
permaneceram no runtime original `8db`.

## Fechamento da prova local

O arquivo `memory-finalized.json` registra sessão
`228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`, a feature corrente, HEAD `6d69656...` e
`finalized_at: 2026-09-08T13:10:53.888Z`. Shared context, harvest, shipment e memória
foram finalizados pelo fluxo nativo. A prova permaneceu local e não fez push, PR,
deploy, merge ou outra publicação externa.

A publicação usa o [PR funcional #903](https://github.com/orobsonn/claude-harness/pull/903),
exige CI do último commit e deixa o release-please produzir changelog, versão e tag.

O diagnóstico adicional da [run Victor](victor-planner-diagnosis.md) motivou uma
orientação de prosa sobre fixtures imutáveis e uma mensagem precisa sobre plano fixo
após admissão. Esse delta posterior à FULL passou nos 33 testes existentes de prompts
e contratos; não foi injetado nas sessões de produto.

Contrato oficial consultado: [worktrees](https://www.onorca.dev/docs/model/worktrees),
[CLI](https://www.onorca.dev/docs/cli/reference) e
[código Orca v1.4.177](https://github.com/stablyai/orca/tree/v1.4.177).

A auditoria por parecer e motivo está em
[test-fidelity-review-audit.md](test-fidelity-review-audit.md). O novo
[`harness-test-reviewer`](../../core/pi/runtime/agents/harness-test-reviewer.md)
usa Terra/high e contexto novo, somente leitura. Novos runtimes usam esse papel na
fidelidade; recibos históricos continuam vinculados ao papel presente no runtime
imutável da tentativa. As tasks preservam o runtime original; somente o pai global
encerrado foi retomado com o runtime novo.

O snapshot local que introduziu o resumo de planner e revisores passou em
**3533/3533 testes**, sem falhas ou skips, com `node_returncode: 0` e concorrência 2
(`/tmp/pi-task-pipeline-final-ui-full-20260908.log`). A validação final do source
`0293fce` ampliou esse total para **3540/3540**, também com `node_returncode: 0`.
A execução anterior detectou uma exigência indevida no teste de timeout de 100 ms:
ele exigia output do programa antes de encerrar. O teste foi corrigido preservando
as provas de timeout, término do PTY e limpeza do grupo; a herança TTY continua
coberta no cenário interativo. Os 20 testes focais desse módulo também passaram.
A TUI Pi agora resume cards concluídos de todos os agentes do harness sem alterar a saída
nativa expandida. Quando o planner fornece uma contagem verificável, o card mostra o
número de tasks; pareceres canônicos mostram aprovação ou revisão e o primeiro motivo
material. O `harness-test-reviewer` usa seu veredito final e a primeira finding. Saída
ambígua, contraditória ou sem um único parecer válido aparece como
`PARECER: INDISPONÍVEL`, com o resultado completo ainda acessível ao expandir. Estados
parciais, papéis externos e cards já expandidos continuam no renderer nativo. Executor,
test-author, sniper e shipper mostram o status declarado e uma linha do resultado;
harvester mostra a quantidade de deltas propostos. Esse complemento passou em 23
testes focais. Nenhum resumo exige outra chamada ao modelo. Essa
mudança pertence ao source e ao runtime novo do pai. Os runtimes imutáveis das tasks
da prova viva não receberam hotpatch.

Esse resultado valida o source e a prova FULL local. As três tasks e seus receipts,
o agregado, o harvest, os olhos finais, a demo, o shipment e a finalização da memória
concluíram sem publicação externa. PR, CI documental e release permanecem separados.
