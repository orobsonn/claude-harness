# Pesquisa pós-evento: retrabalho além do planejamento

Estado: run pausada por ordem do operador, sem autorizar retomada automática.
Esta investigação não modifica produto, testes, plano ou receipts do consumidor.

## Método

Revisão independente read-only dos JSONLs da task 1, incluindo dispatches filhos,
entre 09:52 e 13:42 UTC de 15/09/2026. Não foram lidos blobs de reasoning.
Sessão: `caf8ac36-fc3b-40aa-ab62-ed1b7965340e`, tentativa
`3e14a49c-d7ac-4f8f-851f-e60ed891e4cb`. Eventos citados abaixo referem-se ao
JSONL `2026-09-14T21-34-09-103Z_caf8ac36-fc3b-40aa-ab62-ed1b7965340e.jsonl`.
Números de linha servem para localização, não substituem timestamp/identidade.

## Findings corroborados

### 1. Assertion intermediária não prova a obrigação final

Às 10:22:42, o author (`01a0a492-3abf-7868-9046-4093efb174c6`) escreveu um caso
que inseria destino com expiração arbitrária e apenas comparava o prazo da
ativação antes/depois da inserção. Não verificava a origem do deadline após
publicação. O executor posterior satisfez a assertion adiando a cópia do prazo
do destino para o CAS final; o prazo continuava controlável.

O reviewer aprovou às 13:19 (L1158); security reapontou o deadline às 13:38.
Isso não exige mais cenários por quota: exige observar a obrigação na fronteira
correta. Um RED pode falhar pelo motivo esperado e ainda provar uma propriedade
mais fraca que a especificação.

### 2. A correção seguinte mistura relógios

Author de 13:38 (`01a0a54a-5980-7972-928f-ab91b67d6673`, L41 às 13:41:54)
reforçou as assertions usando `ativacao.criado_em + 259200` e publicou com
`ativadaEm` igual a `criado_em`. Um caso anterior de corte vazio distinguia a
publicação por `AGORA + 120`.

A spec selada diz que o CAS final publica `ativada_em` e os deadlines; a task 4
também associa publicação e deadlines a um instante injetado. O wrapper existente
`src/db/ativar-pesquisa.ts` documenta ativação como gatilho do prazo de 72 horas.
Igualar criação do job e publicação na fixture pode esconder a distinção. Antes
de implementar esse novo RED, é preciso decidir a origem temporal pelo contrato
real; o fato de ser um teste recém-escrito não o torna autoridade.

### 3. Concern material da mão foi perdida no próximo brief

Às 13:26 (L1170), o executor comunicou dois problemas: fixture de lease e a
impossibilidade de uma barreira SQLite distinguir SQL bruto que alega
`ator='worker-final'` da operação do wrapper autorizado. A implementação barrava
o caso testado com `worker-legado`, não a alegação do ator autorizado.

Às 13:26:17 (L1173), o pai pediu apenas a correção da fixture de lease. Às 13:30
convocou os olhos; compliance às 13:38 reapontou exatamente `worker-final`.
O contrato de autorização precisa ser confrontado com a fronteira real de
confiança e com a spec de barrar writers antigos. Não é correto tentar resolver
uma impossibilidade de distinguir autoridade por uma string mais específica.

Melhoria candidata: o próximo brief preservar cada concern material ainda não
resolvida, ou explicitar por que ela não é aplicável. Reusar o envelope/recibos
existentes; não inventar outro lifecycle de issues ou engine de políticas.

### 4. SQL ternário deixou uma combinação parcial passar

O trigger usava `WHEN NOT (... AND NEW.lease_expira_em > unixepoch() ...)`.
Com dono presente e expiry NULL, o predicado pode produzir NULL e a rejeição não
dispara. O teste anterior misturava dono ausente e expiry ausente; outro termo
FALSE mascarava o caso parcial.

Reprodução local em banco SQLite em memória:

```sql
SELECT NOT (1 AND NULL > unixepoch()) AS rejects_null_expiry,
       COALESCE((1 AND NULL > unixepoch()), 0) = 0 AS explicit_rejection;
-- Resultado: NULL, 1
```

É um defeito específico de implementação/oráculo, não prova automática de plano
ruim. Verificar nullable nos predicados que sustentam uma obrigação aprovada é
uma checagem focal, não uma nova matriz combinatória obrigatória.

### 5. Outros eventos relevantes

- 09:52 L1078: subset e traversal exigiam resultados opostos para inserir `z`
  antes de `a`; reparo focal às 09:54–09:56.
- 10:05 L1104: implementação de REDs encontrou expectativas antigas incompatíveis
  sobre entrega pré-publicação e extensão de prazo.
- 13:11 L1147: fixture usava o mesmo `unixepoch()` na criação e claim enquanto o
  trigger exigia timestamp crescente; o erro podia falhar pelo motivo errado.
- 10:17 L1139: resumo do pedido de schema completo de delivery virou lease/fence/
  deadline; não foi encontrada resolução explícita de provider/retry nesse recorte.
  Isso é indício de perda de obrigação, não prova de que tudo deva ir à task 1.

## O que não foi demonstrado

- Não há prova neste recorte de rerun dos três olhos sem delta: houve mudanças
  reais de migration e fixture entre as revisões.
- Há truncamentos locais de grep sobre linhas longas, mas não prova de compaction
  ou perda integral de contexto. Não atribuir causalidade só por ver truncamento.
- Treze launches não equivalem a treze implementações do zero.
- O trabalho da task não foi todo executado por Terra. Eventos de modelo confirmam
  Sol em author/adversary/security, Terra em executor/compliance/pai e Luna em
  test-reviewer. Este documento não recalcula a fatura.

## Experimento da tool: protocolo antes da comparação

A ferramenta estrutural não resolve os findings 1–4. Testar sua utilidade
separadamente evita promovê-la como cura geral.

Primeiro estágio: quatro revisões reais do mesmo snapshot em ordem A/B/B/A,
duas por condição. A não dispõe da tool; B dispõe. Mesmo asset, spec, plano,
modelo/effort (Astra/high), scorer e ferramentas de leitura; MCP indisponível
nas duas condições. Código copiado para diretórios temporários, sem escrita de
produto. Timeout de 180 segundos por chamada, limite soft de custo reportado
de US$3 conferido entre chamadas. Custo do SDK pode usar preços herdados do
registro de compatibilidade: é estimativa, não faturamento verificado.

Critérios de avaliação, não gates do harness:

1. revisão completa ou timeout/erro, separados;
2. finding material com obrigação e evidência verificáveis;
3. instrução concreta que corrige a execução, não apenas "há acoplamento";
4. nenhum falso finding baseado só em número de arquivos/tasks ou arquivo futuro
   ausente;
5. contribuição atribuível ao mapa (relações usadas), não apenas maior quantidade
   de findings;
6. tempo, chamadas de ferramentas, tokens e custo estimado;
7. variação entre as repetições da mesma condição.

Quatro amostras retrospectivas não provam redução de retrabalho ou significância
estatística. Se não houver sinal útil, não ampliar automaticamente ao planner.
Se houver, próximo estágio deve avaliar planos corrigidos e um controle atômico
válido, ainda sem retomar a execução cara.

## Resultado exploratório A/B–B/A

Execução real: snapshot `0524478967a188971e5d63c92a656b0b250222284ac5989a28dce769df2f3c4e`,
353 arquivos copiados e cinco excluídos pelo limite/tipo. Os quatro pareceres
usaram `gpt-6-astra/high`, concluíram sem timeout e retornaram JSON `REVISE`.
As duas sessões B chamaram a tool com sucesso. Nenhuma run de produto foi iniciada.

| Caso | Tool | Segundos | Chamadas de tools | Tokens totais (inclui cache) | USD estimado SDK |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 | não | 118,060 | 44 | 590.845 | 1,067354 |
| B1 | sim | 105,199 | 35 | 466.438 | 0,670611 |
| B2 | sim | 98,671 | 33 | 364.065 | 0,584133 |
| A2 | não | 102,070 | 30 | 296.075 | 0,534005 |

Total das quatro revisões: USD 2,856103 estimado, não fatura verificada.
Astra é registrado pelo bootstrap nativo via compatibilidade; metadados de preço
podem ser herdados. Não inclui o trabalho desta sessão Codex/adversarial.

Médias: A 110,065s/37 chamadas; B 101,935s/34 chamadas. Não afirmar economia
causal: A2 foi a execução mais barata e com menos tokens mesmo sem a tool;
ordem/cache variaram, e duas repetições por condição são insuficientes para separar
efeito da ferramenta de variação do modelo.

Achados:

- Todos: quotas por invocação de authoring/clone não ficam resolvidas apenas por
  limitar cada chunk. O mapa não foi necessário para identificar esse ponto.
- A1 e B1: fixture de auditoria sem migrations necessárias fora do escopo da task 2.
  A1 também apontou a fixture de endurecimento de borda.
- B1: contrato CRM rejeita destination material mas exige remediação autorizada,
  sem explicitar a entrada alternativa. É análise semântica da spec/plano, não um
  fato calculado pelo mapa.
- B2: schema atual armazena destino em plaintext e proíbe UPDATE/DELETE, enquanto
  task 7 precisa de ciphertext destruível sem possuir migration. A instrução nomeou
  duas soluções concretas: reconciliar schema/prova antes do freeze ou atribuir uma
  migration aditiva e testes próprios ao dono do lifecycle. Inspeção local confirmou
  `destino_normalizado` e os triggers incondicionais no snapshot.

O snapshot veio do pai e não contém necessariamente todas as correções posteriores
do worktree da task 1. O finding de schema/purge é material **nesse snapshot**;
não foi classificado como novo defeito atual do filho pausado.

O último ponto é um sinal útil para investigar fronteiras de ownership, mas
apareceu em apenas uma amostra B e poderia ser encontrado com read/grep. Não
concluir que a tool causou a descoberta nem que teria prevenido a run cara.

**Decisão:** manter a tool como apoio opcional e não uma chamada obrigatória em
todo planejamento. Não ampliar automaticamente este experimento ao planner ou
retomar a run. Prioridade recomendada: resolver a perda de concerns e fidelidade
semântica do oráculo; depois avaliar uma revisão de plano em controle separado.
O código, testes e relatório permitem reproduzir o estudo sem produto em execução.
