# Reconciliação tardia da issue 222

Em 2026-09-08, a run Pi legada de `victor-pipeline-dados-mcp`, sessão
`1158ce78-e11c-42ad-ad8a-4e022c0841e2`, voltou ao planner após concluir duas tasks.
O retorno aconteceu durante a validação agregada, antes de harvest/reviews finais/shipping.

## Causa observada

No HEAD `ffa021fe5c0083913e840d6ca920af11d7c52096`, a suíte completa coletou 2.397
testes: 2.396 passaram e `test/unit/sandbox/orientacao-upload-ui.test.ts:319` falhou.
A assertion ainda esperava `return uploadVideo(i)`, enquanto a implementação aprovada
preservava o arquivo selecionado por `return uploadVideo(i, selectedFile).finally(...)`.
Esse teste não tinha dono no plano original. Era necessária uma correção de escopo
antes de editá-lo; os gates preservaram a escrita delimitada e as evidências de T1/T2.

O planner adicionou `task-3-correct-video-routing-assertion`. Uma rodada extra confundiu
`adversarial.enabled` com a revisão obrigatória; a distinção já existe nos prompts
publicados antes deste patch, mas a sessão estava carregada com v2.5.0. O tracker
também começou em 0/3 ao substituir seu plano informativo; o pai restaurou o progresso
de T1/T2 sem repetir implementação. Não houve invalidação espúria de receipts.

## Recuperação observada

A orientação enviada pela interface nativa do Orca preservou o trabalho concluído e
limitou a correção à nova task. O test-author `22aed3cc-2498-4ff` alterou somente a
assertion e seu comentário. Comprovou a falha antiga, sensibilidade numa cópia em memória
e 45/45 testes focais GREEN, sem mutação de produção. Commit da correção:
`7e79114` (`test: corrige roteamento explícito do vídeo`).

O compliance inicialmente exigiu terminar a chamada com ponto e vírgula, proibindo o
`.finally(...)` preexistente que limpa o guard de reentrância. O pai refutou essa
interpretação com o contrato e o produto aprovados; novo compliance `4abec66d-5b27-4c3`
retornou `issues:[]` sobre o mesmo conteúdo. Adversary/security já estavam aprovados.
`hand_finished` havia sido emitido pelo host a partir da escrita real do test-author;
um marker manual redundante não justificava criar executor/sniper sem trabalho real.
O re-gate foi registrado às 16:22:52 UTC, preservando os recibos atuais.

Às 16:23:16 UTC, as três tasks estavam concluídas e a run voltou a `npm test` com
timeout de 1.200 s. A execução completa anterior levou 834 s; uma tentativa anterior
com limite de 600 s havia terminado por timeout. Esse checkpoint comprova a saída do
planejamento; o resultado agregado e a publicação do projeto continuam sendo etapas
próprias da run, não aprovações inferidas desse contador.

## Prevenção mínima

O novo patch adiciona somente orientação a planner e plan-reviewer. Ao mudar uma
assinatura, chamada ou literal emitido, o planner procura seus usos em código/testes,
inspeciona a dependência e inclui a atualização mínima na task dona antes do freeze.
O reviewer confere esse vínculo ou a compatibilidade que dispensa edição. A verificação
fica no delta relevante, sem uma auditoria geral em cada revisão.

Essa regra reduz a chance de descobrir uma assertion incompatível apenas na suíte final.
Ela não garante que um modelo encontrará todas as dependências nem elimina a necessidade
da validação agregada.

## Validação do ajuste

Execuções reais do Pi 0.84.4, com os prompts completos das roles alteradas, em fixture
descartável `/tmp/pi-plan-impact-eval/fixture`. O planner usou Sol/high e os dois
plan-reviewers frescos usaram Astra/high; não houve veredito simulado nem contexto de
review anterior fornecido aos olhos.

| Caso | Resultado |
| --- | --- |
| Plano inicial para mudar a chamada emitida | Três greps focais; uma task com produto, teste novo e `tests/orientation.test.mjs` existente, antes de escrever produto/testes; 76,6 s |
| Review do plano com ownership completo | `{"verdict":"APPROVE","findings":[]}`, primeiro despacho; 37,1 s |
| Controle: retirar somente ownership/obrigação do teste existente | `REVISE`, um finding `high/scope` identifica o path omitido e exige somente sua inclusão na task existente; 101,4 s |

Os dois planos são válidos no schema com a projeção de rotas Pi: a diferença é de
impacto semântico/ownership, não um erro estrutural que o gate já detectaria.
Os logs, hashes dos prompts e uso ficam em `/tmp/pi-plan-impact-eval/runs/` e
`verified-results.json`; custo total registrado dos três casos: US$ 0,405695.
Os 50 testes focais existentes de roles, bootstrap, plan-gate e runtime passaram;
`git diff --check` e a revisão independente também passaram.

Limites: a spec da fixture já pede preservar a cobertura existente, portanto o positivo
confirma aderência à instrução, sem atribuir causalmente a descoberta a este patch. O
controle negativo fez buscas extras por um contrato não nomeado no prompt de avaliação;
seu tempo não estima o custo de uma revisão focal bem instruída. A prova cobre as roles
de planejamento; a recuperação da run legada acima é uma observação separada.
