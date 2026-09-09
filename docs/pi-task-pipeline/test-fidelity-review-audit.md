# Auditoria de revisão de fidelidade de testes — FULL Lainny #47

Data da auditoria: 2026-09-08 UTC. Esta análise somente leitura cobre 43 chamadas de
`harness-compliance` classificadas como `test-fidelity` na
prova corrente: 19 de T1, um de T2 e 23 de T3. A classificação manual encontrou
**28 REVISE, 14 PASS e uma chamada sem resultado recuperável**. Olhos de
implementação e de revisão final foram excluídos.

A auditoria não leu `thinking`, credenciais, diário de sessão nem a implementação
histórica da PR 56. `PASS` aqui registra apenas a prontidão dos testes naquela
rodada; não aprova implementação, integração ou entrega.

## Fontes, cobertura e método

A autoridade foi a spec selada (`79c8aed74db53fbfab0bfab1160b9ff1400e3a12035e52dcafbd3ddfc58b6d0e`),
o plano aprovado (`df6797ba244bc7c351317fb22df41b1937f14c0b2956e45959a52e65bf8dced3`)
e os relatórios públicos associados às sessões T1, T2 e T3. A extração
estruturada cobriu nove fontes úteis: as três sessões canônicas de tarefa, a sessão
global corrente e cinco capturas de launches arquivados. As capturas arquivadas
foram consultadas em regime best effort; onde não preservavam o envelope público
necessário, nenhum veredito foi reconstruído. Esta cobertura não afirma busca
exaustiva no VPS nem autoridade sobre execuções fora desta FULL.

A primeira classificação automática confundiu a palavra `PASS` dentro de matrizes
com o veredito final. As contagens acima e as 43 linhas abaixo foram revistas pelo
relatório público inteiro. A chamada sem resultado permanece indeterminada.

As tabelas usam as mesmas categorias, que podem coexistir:

- **Defeito/lacuna material (V):** oracle, fixture ou evidência não representa uma
  obrigação aprovada, aceita comportamento incompatível ou impede comportamento
  conforme.
- **Extrapolação (E):** exigência adicional sem apoio na spec, no plano ou na
  dependência necessária.
- **Evidência ausente (P):** o brief não permite decidir; isso não implica editar
  os testes.
- **Causado pela correção (C):** defeito introduzido ou exposto ao satisfazer uma
  rodada anterior.
- **Aprovação (A):** evidência suficiente para a fidelity naquela rodada.
- **Indeterminado (I):** resultado público ausente ou ambíguo.
- **Oscilação:** aprovação prematura, reabertura sem delta material ou achado antigo
  descoberto apenas numa rodada posterior.

Uma exigência pode conter parte válida e parte excessiva. A versão intermediária
nem sempre foi congelada; nesses casos a avaliação se limita à evidência citada no
relatório e não afirma ter reexecutado aquele estado.

## Resultado agregado

| Tarefa | Chamadas | REVISE | PASS | Sem resultado | Leitura factual |
| --- | ---: | ---: | ---: | ---: | --- |
| T1 | 19 | 10 | 9 | 0 | Não há REVISE seguramente inventado por inteiro; houve serialização de achados, reabertura e defeitos causados pelas correções. |
| T2 | 1 | 0 | 1 | 0 | Um limite pequeno, observável direto e RED discriminante foram aprovados na primeira rodada. |
| T3 | 23 | 18 | 4 | 1 | Findings materiais coexistiram com expansão de um source guard até um verificador geral; o guard foi reduzido e então aprovado. |
| **Total** | **43** | **28** | **14** | **1** | A nova função deve preservar os bloqueios materiais e encerrar quando a evidência aprovada é suficiente. |

Em T1 e T2, nenhum dos dez REVISE é seguramente uma exigência inventada por si
só: cada um contém ao menos um defeito ou uma lacuna ligada ao contrato. Em T3,
algumas rodadas misturaram defeitos reais com exigências adicionais. O padrão mais
caro foi fazer o source guard crescer para provar reader, escopo, decode e cleanup,
depois descobrir que o próprio verificador recusava implementações conformes,
reduzi-lo ao vínculo aprovado e finalmente obter PASS.

## T1 — 19 relatórios, em ordem

| # | Agent ID público | Veredito | Motivos e correspondência ao contrato | Classificação | Evidência e confiança |
|---:|---|---|---|---|---|
| 1 | `d29cb6cb-ef1e-41e` | REVISE | Faltavam transições nullable completas; cutoff/newer/future e candidato/recovery; prova do relógio nos dois caminhos; bordas do teto; matriz de opções; forma exata/no-any das sobrecargas; fallback e evidência mista de constraints. | evidência ausente | Todos mapeiam diretamente aos locked tests e à spec §§68–119. **Alta**; relatório cita linhas e RED coletado 39/15 falhas. |
| 2 | `1c69df20-d2fb-479` | REVISE | O teste Compiler API inspecionava `Promise` como retorno resolvido, tornando o GREEN correto impossível. Continuavam ausentes evento/nome/UTM na chave, forma null↔valor, releitura canônica completa, guard/batch/rollback UTM, retorno legado completo e opções independentes. | defeito real teste/fixture; evidência ausente; correction-caused | O defeito de `Promise` surgiu na prova criada após #1. As demais lacunas estão em spec 87–101 e locked tests. **Alta**; o autor posterior confirmou `awaited` e acrescentou os cenários. |
| 3 | `a81b1509-0823-4ca` | REVISE | Faltavam direct→UTM, `null`/não objeto e borda 86400, e associação semântica entre os dois slots NOT NULL e seus guards. | evidência ausente | Spec 89, 95 e 101 é literal. **Alta**; 46 testes coletados/19 RED e correção posterior restrita a esses pontos. |
| 4 | `562cf4ce-2611-401` | REVISE | Oracle estrutural aceitava guards trocados ou NULL alheio; recovery não provava consulta pós-conflito nem sucesso canônico; retry por e-mail/telefone não provava ausência de mutação; bordas aceitavam `duplicado:false` sem provar persistência. | defeito real teste/fixture; evidência ausente; correction-caused; contradição/oscilação do revisor | O guard defeituoso veio do reforço de #3. Recovery/snapshot/bordas já eram obrigações e haviam sido marcados amplamente PASS em #3 sem mudança relevante nesses trechos. **Alta**; o autor acrescentou negativos, ordem pós-batch e persistência real. |
| 5 | `760875a8-0bfd-470` | REVISE | Guard estrutural ainda não associava placeholders a valores exatos; faltava UNIQUE aninhado em cause/AggregateError; prova Compiler API não excluía index signatures. | evidência ausente; correction-caused; contradição/oscilação do revisor | Binds são correção causada por #4. UNIQUE aninhado e shape selado já constavam do contrato e foram omitidos na revisão anterior. **Alta** para binds/UNIQUE; **média-alta** para zero index signature, inferido de “exact/sealed/no exposed any”. |
| 6 | `c6404efb-0e6b-428` | REVISE | Faltava vedar index signature adicional no retorno de três argumentos. | evidência ausente; correction-caused | A lacuna estava no helper Compiler API expandido por #5. O contrato exige retorno exato `PreCheckout & { readonly duplicado:false }`. **Média-alta**; correção foi uma asserção focal e preservou RED/typecheck. |
| 7 | `4716b52a-b0e2-4cf` | REVISE | A prova selecionava overloads por aridade, mas não preservava tipos semânticos, requiredness, rest/initializer e `minArgumentCount` dos três parâmetros legados. | evidência ausente; contradição/oscilação do revisor | Compatibilidade exata de 3 args é obrigação literal. O ponto não foi afetado pela correção mínima de #6 e foi descoberto tardiamente. **Média-alta**; fixture virtual posterior provou a forma alcançável. |
| 8 | `15df7eb8-f5f0-4d8` | PASS (`issues: []`) | Considerou a matriz pronta. | contradição/oscilação do revisor retrospectiva | Entre este PASS e #9 houve apenas remoção de whitespace. #9 encontrou conflito semântico real já presente. **Alta**: é a aprovação prematura mais clara. |
| 9 | `93ed205a-8daa-4ec` | REVISE | O teste “ceiling-only” exigia guard de idempotência de 60 s, contradizendo “omitted idempotency disables collapse”; faltavam positivos explícitos de composição independente. | defeito real teste/fixture; correction-caused; contradição/oscilação do revisor | Spec 89 é explícita. O teste foi moldado durante a cascata de guards e já existia no PASS #8; só whitespace mudou. **Alta**. |
| 10 | `cbe0fa10-1454-4d5` | PASS | Confirmou opções independentes, fixture Compiler API conformante, guards, recovery, snapshots e RED discriminante. | — | Evidência coerente com spec/plano e correções #1–#9. **Alta**. |
| 11 | `c73069f1-4901-456` | PASS (`issues: []`) | Segunda aprovação sobre evidência semanticamente igual. | repetição sem ganho material | Não é não aprovação nem erro de conteúdo; mostra custo de uma segunda revisão completa após PASS sem delta relevante. **Alta**. |
| 12 | `bf1f712f-64d1-4e3` | PASS | Re-gate de oracle congelado: corrigiu offsets relativos ao fragmento SQL e removeu bind fictício de `pessoa_id`; fixture positiva passou e RED foi reproduzido no baseline isolado. | defeito real teste/fixture corrigido; correction-caused | O executor provou que o helper estrutural aprovado era defeituoso: 52/53, além de a fixture estática positiva falhar. A cascata #3–#7 criou esse oracle. **Alta**. |
| 13 | `d6364fde-673d-423` | REVISE | Nova regressão D1 cobria `_SOMBRA`, mas não `: SQLITE_CONSTRAINT` válido seguido de resíduo; não provava que a decoração aceita era estritamente terminal. | evidência ausente | A obrigação nova veio de achado operacional D1 aplicável e da regra aprovada de token exato/veto de ambiguidade. **Alta**; não exige parser específico, só positivo/negativo observável. |
| 14 | `ad1deed1-c974-409` | REVISE | Nos vetoes decorados, checava código/ausência do detalhe público, mas não preservação do detalhe raw legado. | evidência ausente; correction-caused; contradição/oscilação do revisor | Compatibilidade de fallback é literal em spec 113. A correção de #13 adicionou caso sem fechar essa asserção; #13 já examinara fallback e não a apontou. **Alta**. |
| 15 | `53b1bc11-20fd-426` | PASS | Positivos D1 exatos, repetição da mesma chave, limites/sufixos e fallback raw estavam cobertos com RED comportamental. | — | **Alta**; 63 coletados, três falhas exclusivamente no comportamento ausente. |
| 16 | `86afb5be-22a6-465` | PASS | Regressões de resíduo `;`/`|` depois de decoração, preservando positivos e Compiler fixture. | — | **Alta**; novo achado veio de revisão de implementação, e este teste o representa diretamente sem ampliar contrato. |
| 17 | `1f28e75d-3b42-403` | PASS | Regressões de segmentos vazios leading/trailing/dobrado para `;`/`|`, mantendo positivos e fallbacks. | — | **Alta**; seis REDs comportamentais correspondem ao bug concreto `.filter(Boolean)`. |
| 18 | `7767700b-3949-434` | PASS | Aprovou somente quatro casos de constraint mapeada misturada a marcador de infraestrutura dentro do grafo limitado, preservando ordem legada e prefixos `retry:`/`wrapper,`. | correction-caused/contexto; extrapolação removida antes do parecer | Antes deste parecer, o test-author removeu casos de profundidade além do limite e ciclo que olhos de implementação/security haviam inventado. O parecer atual não perpetuou essa extrapolação. **Alta** para o conteúdo aprovado; **média** sobre necessidade dos quatro casos, sustentada pela regra “all constraint evidence” e fallback compatível. |
| 19 | `22d3e7bc-629d-44e` | PASS | Regressão força erro cru na SELECT de recovery após conflito e exige mapper de leitura/sanitização, preservando o caso miss→conflito original. | — | **Alta**; spec 47/64 exige superfície sanitizada, fixture usa caminho real e o RED foi exatamente o raw Error escapando. |

### Leitura causal de T1

1. **A primeira revisão não consolidou tudo.** Depois de #1, cada correção disparou uma nova varredura que encontrou obrigações antigas não afetadas: recovery/snapshots em #4, UNIQUE/index shape em #5, parâmetros legados em #7. Isso viola o propósito de um ledger completo, mesmo quando cada finding isolado é válido.
2. **A prova estrutural virou produto paralelo.** A cadeia #3–#12 fez o oracle SQL/Compiler API crescer até conter um `Promise` mal interpretado, semântica de opções contraditória e cálculo de bind impossível. O executor acabou diagnosticando o teste em vez de implementar produto.
3. **Houve aprovação prematura objetiva.** #8 retornou vazio; #9, após alteração apenas cosmética, encontrou uma contradição literal com a spec. Isso não pode ser explicado por nova evidência material.
4. **Novas regressões pós-implementação foram melhor comportadas.** #13–#19 trabalharam em deltas pequenos. Duas precisaram de uma correção adicional; quatro foram aprovadas de primeira. A separação do delta reduziu, mas não eliminou, o padrão de “mais uma condição”.
5. **Olhos de implementação ampliaram escopo fora da fidelity.** Um compliance de implementação quis rejeitar prefixos `retry:`/`wrapper,` já aceitos; security quis transformar profundidade limitada em metadata/ciclo/breadth. O pai/test-author removeram isso antes do parecer #18. O novo agente deve recusar herdar esse tipo de requisito sem vínculo explícito ao contrato aprovado.

## T2 — 1 relatório

| # | Agent ID público | Veredito | Motivos e correspondência ao contrato | Classificação | Evidência e confiança |
|---:|---|---|---|---|---|
| 1 | `16d23989-91a3-4ce` | PASS | Namespace import + `Reflect.get` produz RED por `undefined`, narrowing evita TypeError, igualdade/tamanho/lista provam as dez chaves, negativos cobrem server/prototype/casing e allowlists internas permanecem exatas. | — | Correspondência direta aos três locked tests de T2; RED coletado, typecheck/diff-check verdes, único path autorizado. **Alta**. |

T2 mostra a forma desejável: um limite público pequeno, representação observável direta, fixture sem scaffold, falha discriminante e conclusão na primeira rodada. Não houve necessidade de inferir formato interno nem pedir uma segunda forma de prova.

## T3 — rota pública: 23 chamadas recuperadas

| Revisor | Decisão | Motivos completos agrupados | Avaliação retrospectiva |
| --- | --- | --- | --- |
| `3d90279a-f4e8-4b0` | REVISE | Persistência/projeção e UUID incompletos; campos controlados/auditoria/retry/correções/opcionais não exercitados; gates host/media/Content-Length sem prova de inércia; stream sem release/limite observado e rollback incompleto; tabela de erros parcial; UTM/truncamento incompletos; relógio/teto/ordenação sem fixtures suficientes; constante fonte poderia ser declaração morta. | **V** predominante: primeiro pacote detectou lacunas concretas de observáveis expressos. O cap precisava de vínculo ao uso real, mas esse requisito não autorizava provar toda a futura implementação estaticamente. |
| `1e7dd8aa-2660-4a1` | REVISE | Valores hostis e referências distintas insuficientes; opcionais não verificados por linha; telefone/quantidade inválidos ausentes; CORS só em OPTIONS; UTM null/blank direto ausente; fixture com 198 recentes + 1 futuro esperava rejeição embora contasse apenas 199. | **V/C**: a contagem do teto é um erro objetivo que faria implementação correta falhar. Os demais pedidos descrevem lacunas vinculadas ao contrato; deveriam ser consolidados com as anteriores sempre que já existiam. |
| `c328a625-b1eb-4f8` | REVISE | Normalização da configuração HOST_PUBLICO não coberta; bytes UTF-8 inválidos já eram JSON inválido e não distinguiam decoder fatal; empate de timestamp não provava `id DESC`. | **V**: contraexemplos concretos mostram falsos positivos. Um teste deve isolar a precondição que pretende verificar. |
| `a35d53b9-3374-4e9` | REVISE | UTM sem caso misto query/body por chave; “adicionar e-mail” partia de fixture que já tinha e-mail; contador do teste fonte não vinculado ao comparado; identidade de auditoria não verificada na própria requisição hostil. | **V/C**, com cautela sobre a solução estática: vínculo contador/constante é exigido; uma cadeia geral reader/cancel/decode não é. |
| chamada “Seal test fidelity”, 08:27:34 | Sem resultado | Envelope de despacho existe, mas não há conclusão pública correspondente. | **I**: não contar como reprovação nem aprovação. |
| `773ea148-05ad-4c8` | REVISE | Correções/retry provavam status, mas não referências/persistência/snapshot; Content-Length malformado só usava corpo pequeno; regex poderia selecionar stream fictício em vez do body real. | **V** quanto aos observáveis; a correção do teste fonte deve permanecer proporcional ao vínculo aprovado. |
| `bb5485a1-f829-4b1` | REVISE | Dicas Content-Length inválidas ainda não exercitavam overflow/DB inerte; CORS/OPTIONS incompleto em rotas preservadas; leitura e `.byteLength` sem vínculo; import de `DbError` fora da fronteira literal autorizada. | **V** sob as fronteiras expressas do plano. A matriz de dicas deve representar as classes exigidas, sem virar busca ilimitada por novos exemplos. |
| `a32df2b1-b4d0-474` | REVISE | Quatro specs importavam tipo de módulo de produção fora do conjunto de imports expressamente permitido. | **V** de escopo literal, embora sem efeito de execução do import de tipo. Não generalizar isso em proibição de imports de tipos para todas as tasks. |
| `e514af7e-51f3-458` | REVISE | Faltavam zeros à esquerda e sintaxe exponencial de Content-Length; erro NOT NULL não relacionado ao guard era confundido com o caso do teto. | **V** para discriminar classes previstas. A sugestão “idealmente wrapped/comma” não deve virar bloqueio sem o correspondente requisito. |
| `fb21e5c2-547a-43d` | REVISE | Casos nome null/número também omitiam telefone/quantidade, permitindo 400 por motivo diferente. | **V**: fixture mascarava exatamente a validação pretendida. |
| `271257e8-1a01-4ce` | REVISE/BLOCKED parcial | UTM só com espaços ausente; brief não continha saída real e exit status da coleta/RED/typecheck. | **V + P**: primeiro exige completar caso previsto; segundo exige fornecer evidência existente, sem reescrever testes nem repetir uma suíte ainda válida. |
| `a74940fd-f539-430` | REVISE | Ausência de fallback UTM herdado versus chave própria; falta de erro FK não relacionado para impedir remapeamento amplo. | **V** quanto aos observáveis. A próxima rodada mostrou que o mock proposto para FK não demonstrava rollback: o revisor deve especificar o resultado necessário, sem prescrever fixture inadequada. |
| `226ed4b7-8ec7-45a` | REVISE | Mock de batch rejeitava antes de SQL; snapshot inalterado não provava rollback após escritas para FK não relacionado. | **V/C**: distinguir inércia antes da operação de rollback real. A solução pode ser fixture existente/proxy pontual; não requer seam em produção. |
| `71647ad7-35cc-490` | PASS | FK real corrigida; ledger atual, 26 coletados, 25 RED comportamentais e um PASS; tipagem correta. | **A**: nenhuma nova exigência, encerrou a avaliação. |
| `94fa5c8f-b322-4d6` | PASS | Revalidou escapes de regex, receiver do proxy SQLite e fixture de pessoa normalizada; preservou 23 obrigações não afetadas. | **A**: bom exemplo de revisão do delta, sem varrer tudo novamente. Esses defeitos tinham aparecido ao executar a implementação e mostram o limite do RED que termina antes da fixture tardia. |
| `b05a2022-c7a2-4c7` | PASS | Regressão para telefones com letras após correção já commitada; GREEN atual, contexto concreto da falha anterior e 25 obrigações preservadas. | **A**: não exigiu falsificar RED atual nem desfazer implementação saudável. |
| `83394c61-3288-4df` | REVISE | Fallback genérico observava slice/subarray, mas não cópia/decode/agregação; modo default e read sem tamanho não estavam medidos. | **V/E mistos**: limitar consumo da aplicação é pertinente ao cap, porém detalhes de forma de leitura devem ser justificados pela fronteira byte/generic aprovada, não impostos universalmente. O parecer corretamente excluiu alocação do produtor. |
| `195ad8d1-a495-4dd` | REVISE | Faltava guard de agregação do chunk oversized; pediu que o teste fonte provasse separadamente todo o caminho de fallback, cancel/release e ordem antes de cópia/decode. | **V** para a observação comportamental de consumo; **E** na ampliação estática além da comparação acumulada/constante. |
| `e6fa26fc-6791-42b` | REVISE | Regex comparava identificador do acumulador ao do chunk, tornando o oracle insatisfatível; bounded read poderia ser um read descartado diferente do contabilizado. | **C** real no matcher; solução solicitada continuou expandindo a prova de fluxo. Corrigir/remover restrição extra pode resolver sem construir analisador mais geral. |
| `a6c51da7-cae6-4a7` | FAIL | Exigiu suportar read-result seguido de destructuring e rejeitar reads decoy em qualquer escopo/fluxo; pediu vínculo completo a cleanup/cópia/decode. | **E + C**: identificou restrições reais do matcher que vinha sendo criado, mas ampliou novamente o objetivo. O contrato fonte não exige verificar toda implementação equivalente. |
| `88573592-4628-405` | REVISE | Exigiu resolução de símbolos/escopos TypeScript e cadeia completa até buffer decodificado, porque o AST por nomes admitia shadows/decoys. | **E**: a fixture comportamental já cobria stream e limpeza; o requisito fonte limitava-se ao consumo da constante no compare acumulado. Este pedido levou a TypeChecker desnecessário para o contrato. |
| `66ad1b94-9bfb-4e1` | REVISE | Após reconciliação do requisito, apontou que o próprio analisador rejeitava implementações conformes por exigir reader inline, `+=`, if/finally, push/set e decode específicos. | **V/C**, causado pela expansão anterior. Correção correta foi remover exigências de fluxo geral, preservando vínculo acumulador/constante/413 e a fixture comportamental. Demonstra a oscilação “exigir analisador” → “reprovar pelo analisador”. |
| `440fa7dc-bbb5-422` | PASS | Oracle limitado ao vínculo aprovado; quatro testes fonte GREEN; fixture BYOB com RED comportamental único; tipagem correta. | **A**: prontidão explícita, sem reabrir 25 obrigações já cobertas. Após isso o executor passou 26 focais/72 regressões com pequena alteração em worker.ts. |

### O que poderia ter sido aprovado antes

Não seria correto aprovar as versões com fixture de teto errada, nome mascarado,
UTF-8 que não discriminava decoder fatal, rollback apenas simulado ou oráculo
insatisfatível. Esses bloqueios eram materiais. A oportunidade de aprovação mais
cedo está no recorte: assim que comportamento BYOB/fallback estava coberto e o uso
real da constante era verificado, a ausência de um verificador geral de
reader/escopos/decode não deveria bloquear. Algumas versões intermediárias já
continham restrições extras ou bugs introduzidos para satisfazer pareceres; nesse
estado, a solução não era aprovar cegamente, mas remover a exigência excedente em
uma correção consolidada.

A sequência `195ad8d1 → e6fa26fc → a6c51da7 → 88573592 → 66ad1b94 → 440fa7dc`
é o principal caso de aprendizado: diferenciar defeito no observável aprovado de
limitação em maquinaria de teste que o próprio ciclo acrescentou.

## Aprendizados refletidos na função exclusiva

A função [`harness-test-reviewer`](../../core/pi/runtime/agents/harness-test-reviewer.md)
é exclusiva de fidelidade de testes e mantém revisão de implementação/final fora
deste julgamento. Sua prosa já estabelece suficiência, consolidação, revisão do
delta, RED comportamental e recusa de exigências hipotéticas. Os ajustes de prosa
derivados desta auditoria preservam os seguintes comportamentos:

- aprovar quando o observable, a fixture e a evidência executável aplicável são
  suficientes, sem continuar procurando uma segunda representação;
- aceitar baseline PASS quando o RED pertence somente ao comportamento ausente que
  guia a implementação;
- aceitar regressão forward-only em GREEN quando há falha anterior concreta, sem
  rollback de produção saudável nem mutation proof adicional;
- consolidar blockers na primeira passagem e, nas correções, revalidar o delta e os
  PASS afetados;
- tratar output/status de comando ausente como evidência bloqueada, sem inferir um
  defeito nem prescrever reescrita;
- limitar source inspection à relação expressamente aprovada; se um guard adicional
  rejeita uma forma conforme, reduzi-lo ou removê-lo em vez de criar um analisador
  geral;
- separar melhoria opcional de blocker e devolver conflito ao pai local.

Essas regras não usam contador de rodadas, escalada automática, JSON de aprovação
novo ou mutation testing obrigatório. O objetivo é tornar a condição de suficiência
explícita sem enfraquecer fixtures, REDs discriminantes ou obrigações travadas.

## Limites

- A análise avalia saídas públicas e as evidências que elas citam, não raciocínio
  privado dos revisores.
- Exigências de Compiler API em T1 têm confiança média-alta porque o plano daquela
  tarefa trava uma prova Compiler API; não são regra geral para outras tarefas.
- A necessidade dos quatro casos de mixed-infrastructure em T1 #18 é menos textual
  que as demais, embora preserve a classificação legada e não amplie o grafo.
- Em T3, não seria correto aprovar estados com teto contado errado, validação
  mascarada, UTF-8 não discriminante, rollback simulado ou oracle insatisfatível.
  O excesso ocorreu na forma geral de provar o cap, não na existência desses
  defeitos materiais.
- A chamada T3 “Seal test fidelity” não possui conclusão pública recuperável e não
  conta como PASS nem REVISE.

## Descoberta adicional fora das três tarefas correntes

Uma busca adicional, encerrada em 2026-09-08 UTC, enumerou somente diretórios
`.pi/harness/sessions` e JSONLs de sessão sob `/home/orca/dev` e
`/home/orca/orca/workspaces`, além de `/home/orca/.pi/agent/sessions`. A travessia
excluiu `node_modules`, caches, autenticação, credenciais e secrets. Não consultou
blobs de produto histórico.

No instante da leitura havia dez JSONLs de sessão pai acessíveis: seis nas
worktrees e quatro no diretório global do Pi. Também havia 172 JSONLs filhos sob
os diretórios `tasks`; eles foram considerados apenas para detectar eventual
despacho estruturado aninhado. A busca deduplicou por sessão e `toolCallId` e só
aceitou como fidelity uma chamada de `harness-compliance` com fase explícita no
metadata estruturado. `HARNESS_FINAL_REVIEW` foi sempre excluído; um
`HARNESS_TASK_REVIEW` em lote com adversary/security foi classificado como olho de
implementação. Marca ou descrição ambígua não recebeu fase inferida.

Além das 43 chamadas desta FULL, nenhuma chamada pública inequívoca de fidelity
foi encontrada. A sessão interrompida anterior e uma sessão de outra worktree
estavam acessíveis, assim como quatro sessões globais antigas, mas não continham
um novo par estruturado de despacho/resultado que pudesse ser acrescentado com
segurança. Portanto, a cardinalidade auditada permanece 43. Esse resultado
descreve o alcance observável nesses caminhos e nesse instante; não prova que
nenhuma outra sessão tenha existido ou sido removida do VPS.
