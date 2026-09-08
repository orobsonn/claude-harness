# Custo e convergência da prova FULL

A prova revelou uma falha de eficiência: separar a implementação em tasks não
reduziu o contexto dos pais, que continuaram chamando o modelo com históricos
grandes. A revisão de testes também exigiu muitas correções. A aprovação funcional
não basta para considerar esse comportamento resolvido.

## Fotografia de 8 de setembro de 2026, 11:18:53 UTC

A coleta soma uma vez cada uma de 151 sessões Pi distintas, usando somente os
campos estruturados `usage` e `usage.cost` das respostas. Totais textuais retornados
pela ferramenta de subagentes não são somados novamente. A revisão de T3 ainda
estava em andamento; estes valores não são o custo final da entrega.

| Sessão | Pai direto | Filhos | Total estimado registrado |
| --- | ---: | ---: | ---: |
| Global | US$ 550,70 | US$ 10,00 | US$ 560,70 |
| T1 | US$ 134,17 | US$ 18,33 | US$ 152,51 |
| T2 | US$ 3,27 | US$ 0,58 | US$ 3,86 |
| T3 | US$ 119,41 | US$ 16,59 | US$ 136,00 |
| Total | US$ 807,56 | US$ 45,50 | US$ 853,06 |

O pai global produziu 782 respostas, chamou `harness_tasks status` 622 vezes e
passou por 13 compactações. Foram 108,36 milhões de tokens de entrada sem cache,
cerca de 139 mil por resposta. Os quatro pais representam 94,67% do custo
estimado registrado; trocar apenas o esforço de raciocínio não resolve essa causa.
O custo posterior de reler resultados de filhos pertence ao pai, mesmo que o
coletor não duplique a contabilidade dos filhos.

As respostas que despacharam `status` somaram US$ 454,11 e 89,68 milhões de tokens
de entrada sem cache. Isso é o custo das respostas que continham a consulta, não
uma atribuição causal isolada à ferramenta. O problema verificável é enviar o
histórico ao modelo repetidamente apenas para observar espera.

A fração de entrada atendida por cache era aproximadamente 10,45% no global,
9,49% no pai de T1 e 11,57% no pai de T3; os filhos correspondentes ficaram entre
80% e 83%. Retomadas e compactações, sozinhas, não explicam essa diferença. O
`prompt_cache_key` do provider permanecia ligado à sessão; a memória reposicionada
a cada chamada era uma diferença concreta na construção da entrada dos pais.

Nos filhos de T3, 24 sessões de autoria de testes somaram US$ 7,02 e 22 sessões de
compliance somaram US$ 4,50. Compliance inclui fidelidade e olhos de implementação.
As três sessões de executor somaram US$ 1,65. Esses números mostram que o retrabalho
em testes e revisão custou mais que a implementação. T2 teve um ciclo curto, mas é
uma tarefa de complexidade diferente: não serve como comparação controlada.

## Atualização intermediária de 12:50:26 UTC

Após as correções de produção e a retomada desnecessária causada pelo defeito de
ancestralidade no reader, a coleta registrou os valores abaixo. Global e T3 foram
recalculadas dos JSONLs disponíveis. As worktrees de T1/T2 já não estavam no disco;
seus valores terminais vêm dos snapshots preservados de 11:18 e 11:42, sem alegar
nova leitura dos logs originais. Esse corte antecedeu a retomada final do global.

| Sessão | Pai direto | Filhos | Total estimado registrado |
| --- | ---: | ---: | ---: |
| Global | US$ 551,72 | US$ 10,00 | US$ 561,71 |
| T1 | US$ 134,17 | US$ 18,33 | US$ 152,51 |
| T2 | US$ 3,27 | US$ 0,58 | US$ 3,86 |
| T3 | US$ 171,66 | US$ 22,81 | US$ 194,47 |
| Total | US$ 860,83 | US$ 51,73 | US$ 912,55 |

O total combina 174 sessões, 2.469 respostas e 241.420.057 tokens reportados; os
campos de tokens incluem categorias de entrada, cache e saída, sem equivalência
automática entre cada categoria e preço. O global chegou a 623 chamadas de status.
O artefato `/tmp/pi-full-cost-current-20260908T125026Z.json` mantém a proveniência
de cada parcela. Ainda são custos do runtime anterior às correções de espera/cache;
não constituem medição de economia do runtime atualizado.

## Fechamento terminal de 13:11:06 UTC

A execução FULL encerrou às `13:11:06.272Z`, com código zero no job global. A
coleta terminal registrou 179 sessões, 2.541 respostas e 247.768.953 tokens
reportados. Os valores de T1 e T2 continuam sendo as métricas terminais preservadas
no artefato anterior, pois suas worktrees haviam sido removidas; global e T3 foram
recalculadas dos JSONLs estruturados ainda disponíveis.

| Sessão | Pai direto | Filhos | Total estimado registrado |
| --- | ---: | ---: | ---: |
| Global | US$ 556,49 | US$ 12,40 | US$ 568,89 |
| T1 | US$ 134,17 | US$ 18,33 | US$ 152,51 |
| T2 | US$ 3,27 | US$ 0,58 | US$ 3,86 |
| T3 | US$ 171,66 | US$ 22,81 | US$ 194,47 |
| Total | US$ 865,60 | US$ 54,12 | US$ 919,73 |

O artefato `/tmp/pi-full-cost-current-20260908T131525Z.json` registra essa
proveniência por lane. A cifra exclui o uso do Codex raiz e eventuais ajustes de
faturamento do provider. A coleta de custo não é, por si só, evidência de aprovação
funcional.

## Significado da cifra

O valor do rodapé mostrado no Orca é calculado pela TUI do Pi. O provider
`openai-codex` identifica uso por assinatura e o rodapé mostra `(sub)`. `usage.cost`
é uma estimativa equivalente a preços de API, não uma fatura de cobrança adicional.
O Pi instalado usava para Sol US$ 5/0,50/30 por milhão de tokens de entrada,
entrada em cache e saída. A documentação consultada informava US$ 4/0,40/20;
portanto a tabela local também superestima o equivalente atual. Mesmo corrigida
essa diferença, o volume desperdiçado permanece. Não alteramos preços registrados
nem alegamos acesso ao faturamento da conta.

Referência: [preços oficiais de GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

## Correções e evidência disponível

O pai global encerrou seu turno em 11:17:03 UTC para interromper o polling por
modelo. O wrapper encerrou esse processo com código zero; T3 continuou executando.
Esse encerramento não representa aprovação FULL. A retomada da mesma sessão usa
`medium`. T3 mudou nativamente para `medium` no evento `thinking_level_change` de
11:25:25.647 UTC; os filhos mantêm as rotas canônicas de suas funções.

`harness_tasks wait` agora espera dentro do host. No Orca usa `terminal wait --for
exit`, em janelas renovadas dentro da mesma chamada, sem solicitar nova resposta ao
modelo a cada timeout. Fora do Orca, a espera consulta o processo dentro do host.
Ao despertar, sempre revalida processo e recibos. Um teste com terminal temporário
no Orca 1.4.177 observou o timeout nativo e depois saída zero; o terminal de teste
foi fechado. Isso verifica o transporte, não aprovação de uma tarefa.

Também foi corrigida a posição da memória temporária na entrada do provider.
Antes, a mensagem era removida e reinserida no fim de cada requisição: o próximo
histórico mudava antes de alcançar a posição antiga da memória. Agora ela ocupa
um prefixo estável, continua marcada como conteúdo não confiável e não é persistida
no JSONL. O teste usa a conversão real de mensagens do Pi e quatro requisições:
conteúdo inalterado preserva o prefixo; uma atualização muda a memória; a requisição
seguinte volta a preservar o prefixo. A amostra real posterior abaixo mede o cache
reportado pelo provider; ela não isola uma economia percentual causada pela correção.

A auditoria inicial de 43 chamadas de fidelidade está em
[test-fidelity-review-audit.md](test-fidelity-review-audit.md). A mudança de prosa
separa `harness-test-reviewer` de compliance, define aprovação por evidência suficiente,
consolida falhas e restringe a revalidação ao delta e às obrigações afetadas. O
`harness-test-author` também recebe o limite explícito: sugestão de revisor não cria
uma obrigação nova. O pai local resolve esse loop. Não há aprovação por orçamento,
contador de rodadas ou escalonamento rotineiro ao pai global.

O PR [#887](https://github.com/orobsonn/claude-harness/pull/887) já havia introduzido
ledger e revisão incremental. O prompt local de task não tinha incorporado toda essa
orientação; agora ambos os prompts a contêm. Isso não explica tudo: T3 recebeu a
orientação durante a prova e ainda expandiu seu verificador de código. A separação
do papel e a condição explícita de suficiência tratam essa segunda causa.

A [avaliação comportamental](test-reviewer-evaluation.md) produziu cinco respostas
com o resultado esperado; o caso forward-only permaneceu inconclusivo em duas
chamadas sem resposta final. A execução FULL e a coleta terminal foram concluídas,
mas esse resultado inconclusivo permanece como limite da avaliação. Não há
demonstração de redução ponta a ponta; validar o mecanismo e medir a economia são
evidências diferentes.

## Janela terminal do runtime atualizado

A mesma sessão global foi retomada às `12:58:32.079Z` com runtime `04c30b...` e
esforço `medium`, depois de um checkpoint de instalação com todos os processos
anteriores encerrados. A janela terminal vai até `13:11:06.272Z`. No pai, 48
respostas somaram 455.210 tokens de entrada sem cache e 4.640.128 de entrada em
cache: **91,066%** da entrada foi atendida por cache, contra **10,447%** na
fotografia anterior, uma diferença de 80,619 pontos percentuais. O custo registrado
do pai nessa janela foi US$ 4,773804.

Cinco filhos iniciados na mesma janela produziram 24 respostas, com **60,646%** de
cache e custo de US$ 2,399674. Pai e filhos somaram 72 respostas, 6.348.896 tokens
reportados, **85,148%** de cache e US$ 7,173478. A fotografia provisória de
`13:02:05Z` foi, portanto, substituída por esse fechamento.

O arquivo
`/tmp/pi-global-post-migration-usage-terminal-20260908T131525Z.json` contém os
campos estruturados por resposta e a janela exata. A comparação continua
observacional e não controlada: fase, contexto, compactação, conjunto de filhos e
chamadas de modelo diferem. Ela não demonstra economia ponta a ponta nem atribui
toda a diferença a uma única mudança.
