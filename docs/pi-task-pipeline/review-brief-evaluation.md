# Evidência no primeiro brief de revisão

Em 2026-09-08, o primeiro compliance de fidelidade da Task 2 da issue 222 de Victor
bloqueou por falta de baseline/diffs. Outro despacho aprovou os mesmos testes após
receber essa informação. Não houve edição entre os dois pareceres. A proposta e os
custos observados estão registrados em `kaizen.md`.

## Mudança

O pai global, o pai local da task e `harness-delivery` agora especificam a evidência
do primeiro brief conforme a fase: caminhos canônicos, cwd/base/HEAD, index/worktree/
untracked, comparação focal, prova dos arquivos preservados e saída executável com
exit status. Testes novos untracked são lidos integralmente; um diff tracked vazio
não os cobre. Antes do freeze, a comparação usa a base da tarefa/test-author; depois,
usa freeze→HEAD para testes e base de implementação→HEAD para produto.

`harness-test-reviewer` e `harness-compliance` consultam artefatos legíveis nomeados
quando a evidência não veio inline. A ausência de prova necessária continua bloqueando;
um resumo do pai não aprova os testes. Spec/planning não recebem exigências de
evidência de implementação que ainda não existe.

## Run de teste focal

Run Pi nativa em TUI, iniciada pelo Orca no terminal
`term_7cb34181-6488-4c79-a89b-bc683f6c5cd2`, título `TESTE · review brief · Pi`.
O projeto de teste é um repositório descartável em
`/tmp/pi-review-brief-live/fixture`; nenhum projeto de cliente foi alterado.

- Pi 0.84.4 e pi-subagents 21.2.0, runtime verificado pelo resolvedor do harness.
- Pai: `openai-codex/gpt-5.6-sol`, medium; olhos: `openai-codex/gpt-5.6-terra`, high.
- Sessão pai: `01a081a5-9775-7f55-b3ab-143d7845db78`.
- As cláusulas de preparação dos prompts/contrato foram carregadas literalmente
  do patch; as duas roles foram copiadas integralmente. Os seis hashes de fonte
  registrados em `/tmp/pi-review-brief-live/source-manifest.json` conferem com o patch.
- O pai recebeu somente o contrato, a localização da baseline e a tarefa de preparar
  a revisão; compôs o primeiro brief a partir das leituras/comandos observados.
- Os olhos são filhos nativos frescos, sem contexto herdado, com ferramentas
  `read/grep/find/ls`. Seus vereditos vieram do modelo, sem respostas simuladas.

| Caso | Evidência | Resultado nativo |
| --- | --- | --- |
| Fidelidade antes do freeze | Teste novo untracked exige ausência de COEP e preservação de COOP; baseline intacta; alteração só de comentário; 3 testes coletados, 2 PASS e RED comportamental esperado, sintaxe válida | `7a914def-3023-4df`: `APPROVE`, primeiro despacho, 7 leituras, 26,3 s |
| Compliance após implementação | Freeze seletivo; produção commitada; 3/3 GREEN; comparação freeze→HEAD dos testes vazia. Brief aponta arquivo de evidência, sem colar seus diffs/resultados inline | `9b93aa35-477c-490`: `{"issues":[]}`, primeiro despacho, 8 leituras, 10,0 s |
| Controle negativo | Remoção deliberada da asserção de ausência de COEP em teste congelado, mantendo 3/3 GREEN; evidência atual em arquivo nomeado | `db8f6222-b20b-40b`: um finding `high/locked-decision` identifica exatamente a asserção removida e pede restaurar o freeze; 8 leituras, 15,0 s |

Baseline `cb4b375d36aa5fa74697eef22ba00dd18b7980a5`; freeze
`8d66f1afeed3290c3e656c02e3a8272e6ebe9d63`; implementação
`eb73e6d22f8865db520cf4a6eb5f3aaf0b1629a3`.
Os logs nativos ficam em `/tmp/pi-review-brief-live/sessions/`; os comandos e saídas
exatos do segundo caso ficam em `/tmp/pi-review-brief-live/phase2-observations.md`.
O controle negativo está em uma branch isolada no SHA
`acfc0dac0c8a803fdd72369869a0e422ca26bb42`, com sua própria evidência em
`/tmp/pi-review-brief-live/control-observations.md`.

Os três despachos terminaram saudáveis, com três sessões filhas distintas, sem
retry/resume. A auditoria independente confirmou os pareceres e a leitura efetiva
dos artefatos, com zero chamadas de shell pelos olhos. A conferência reproduzível
dos logs e hashes está em `/tmp/pi-review-brief-live/summarize.py`, com resultado em
`verified-results.json`. Os registros de uso somam US$ 0,3912642: US$ 0,322025 do pai
e US$ 0,0692392 dos três olhos. Esses valores incluem o controle negativo.

Após o experimento, `npm test` concluiu com 3.554/3.554 testes aprovados, zero falhas
e zero skips. `git diff --check` e o scanner de segredos também passaram.

## Alcance

A prova cobre a preparação do brief pelo pai e a decisão dos revisores no Pi real.
A montagem da fixture, o freeze e a alteração de produção foram feitos pelo driver
do experimento. A cerimônia completa, os recibos e `harness_tasks` não foram exercitados
nessa run focal; os gates existentes permanecem cobertos pela suíte automatizada.
O experimento usou o plugin nativo, sem os rails de delivery; o pai chegou a agrupar
comandos de shell, algo que a allowlist da cerimônia recusa. Isso não é prova de
admissão desses comandos na pipeline completa.

A mudança é orientação de prosa, sem novo envelope automático ou alteração de recibos.
O resultado deste caso pequeno não estima a economia de uma tarefa real nem o custo
de uma sessão longa. Runs já abertas preservam a versão de prompt carregada no início.
