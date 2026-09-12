# Pi: diagnóstico de bloqueio e manutenção de fixture

Base: `c699aad4f216ce5d1aa4836a019bd91da25d633e` (v2.6.21).

## Reprodução na retomada da Victor #274

A implementação de resolução de owner tornou incompleta uma fixture existente de
`publish-publicacao.spec.ts`. O plano da retomada não admitia esse path. O autor
reportou `PLAN_CONTRADICTION`, mas a inspeção do host retornou apenas `current child
hand record is not capture-eligible`: a leitura do contexto estava depois desse
retorno antecipado. A sessão `a2d15aac-7147-458d-95f5-d630076e07f2` terminou com
quatro launches da task, incluindo retomadas sem autorização para o reparo.

Na sessão nova `0fce8c6f-74fc-476d-b2a6-f65d914152bc`, a fixture foi corrigida pelo
test-author antes de existir implementação nativa capturada nessa task. Foi então
convocado um executor sem delta para estabelecer a proveniência. Isso é desperdício
real, não uma recuperação test-only legítima de uma implementação já capturada.

## Mudança mínima

- Ler e validar o contexto depois de conferir binding, escopo, HEAD e sessão dos
  eventos, mas antes dos retornos de implementação/captura incompleta. Transportar
  esse diagnóstico pelo campo transitório que o coordinator já possui. Continuar
  retornando falha, sem recibo pronto ou relaxamento dos gates.
- Explicitar o caminho canônico existente `no_tests:true`, `locked_tests:[]` para
  uma nova task de manutenção de fixture sem nova obrigação de produto. O executor
  recebe o delta real no scope, preserva assertions/produto e roda os testes existentes.
  Não criar RED fictício, pré-aplicar toda a mudança pelo autor ou chamar executor
  somente para recibo. `no_tests` no brief não muda autoridade.
- Preservar a recuperação test-only de uma implementação capturada na mesma task,
  o fluxo de testes travados e a ausência de herança de recibos entre sessões.

Sem novo estado, schema, gate, reconciliador ou mecanismo de classificação automática
de fixtures. O plano/reviewer decide se existe uma obrigação comportamental nova.

## Verificação

As duas regressões novas foram RED antes da alteração. A suíte focal no host passou
201/201, incluindo no_tests canônico, captura obrigatória e recusa de autorização
apenas no prompt. Contexto com sessão, task, HEAD ou hash incorreto continua negado.
Adversary e compliance independentes aprovaram o patch fora da pipeline do harness.

Probes opt-in com modelos reais (não equivalem a uma cerimônia nativa completa):

- Planner Sol/high: arquivo real passado ao scorer, plano fixture-only no_tests e
  sem RED artificial, em 49,173 s; schema validado com a estratégia Pi.
- Coordenador Terra/high: exatamente um despacho executor para delta real, em 7,386 s.
- Executor Terra/medium com asset materializado pelo vendor/launcher oficial:
  leu a fixture, mudou somente `owner: null` para um owner ativo e executou o teste.
  Assertions preservadas byte a byte, produto intacto, teste 1/1 verde. Captura e
  reviews não foram simulados como se estivessem concluídos nesse exercício isolado.

Vendor em diretório descartável: 160 arquivos. Package dry-run: 643 arquivos,
sem state, sessions, worktrees ou node_modules no pacote. A primeira execução das
suítes completas encontrou somente uma assertion da frase histórica de RED/freeze;
a frase foi preservada, agora qualificada às tasks com testes travados. Reexecução
final: Pi 1128/1128 em 382,98 s; repositório 3711/3711 em 521,98 s.
`git diff --check` verde; bootstrap vendorizado confirmou Pi 0.84.4,
subagents 21.2.0 e 11 roles. Não há script separado de lint/typecheck neste pacote.
O CI remoto deve acompanhar o PR.

## Desfecho da dogfood e limites

Victor PR #336 foi mergeada em 12/09/2026 às 11:30:01 UTC, squash
`5c72c8c814ea2298a8754f91806ae93a18881759`, CI `34669106964` verde.
HEAD final revisado `03005961980240e9f3e0327ef822f4159bb8a75b`: 275 arquivos,
2817 testes e typecheck verdes. A finalização nativa ocorreu às 11:31:00.

O último adversary bloqueou por uma race de `abandoned_compose`. Comparação com a
base, spec original e writers demonstrou código preexistente, explicitamente fora
do contrato alterado e sem caminho novo de troca da chave terminal. Uma reavaliação
focal independente confirmou follow-up; o recibo negativo não foi editado ou
ignorado. Somente adversary repetiu; compliance/security permaneceram aceitos.
Após aprovação final, harvest retornou no-op e shipper concluiu o merge.

Essa run foi assistida, herdou trabalho antigo e executou v2.6.21: não prova que o
patch aqui descrito já foi usado numa entrega completa. Seu executor sem delta e
as retomadas inúteis continuam contabilizados como falhas observadas, não apagados
retroativamente. A entrega #211, integral v2.6.21, custou US$ 12,27192768 e terminou
em 1h46m30, com 28 dispatches e duas tasks; não exercitou esta recuperação.
