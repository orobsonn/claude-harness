# Scorer Pi por arquivo — correção após dogfood v2.6.16

Base: release v2.6.16 (`a2898e5`). Este follow-up foi solicitado pelo operador
depois das três fases entregues nos PRs #944, #946 e #947 e da release #945.

## Contraprova real

Na issue Victor #317, sessão `8fa20a25-1894-414c-91e1-2fde8ee4183a`, o planner
chamou `harness_complexity` três vezes às 15:07:53 UTC com pseudocódigo inline
de uma linha. A lógica original do Claude executou, mas mediu esse resumo, não
os arquivos: scores 3, 6 e 3. Isso não comprova a complexidade dos arquivos reais.
O operador esclareceu o contrato: receber o arquivo/path e retornar sua complexidade.

A dogfood foi interrompida controladamente antes de lançar tasks. Checkout limpo,
spec/plano/logs preservados. O último evento persistido é de 15:15:27 UTC, após
início às 14:51:26; isso é intervalo de eventos, não duração exata do processo.
Contagem parcial deduplicada: 6.434.227 tokens, US$ 6,8756164, sete dispatches
(quatro adversaries de spec, dois planners — um interrompido — e um plan-reviewer),
zero task launches. Não é uma dogfood concluída nem resultado comparável à #275.

## Correção mínima

- Schema da tool exige `path` e não aceita `source`/`whole_file` do modelo.
- Host lê o arquivo sob a política de leitura existente, incluindo secrets/symlinks.
- Mesma função do scorer Claude, sem mudança de pesos, faixas ou `should_split`.
- Path normalizado relativo ao cwd como no CLI Claude, para aliases não alterarem o score.
- Prosa distingue complexidade do arquivo de julgamento da mudança/task; não criar
  arquivo sintético para obter score, nem quota de tasks ou gate por número.
- Arquivo novo/inacessível ou falha do scorer permite continuar com julgamento.

## Verificação

Baseline focal: cinco testes verdes. Nova regressão RED: schema não exigia path.
Regressão adicional RED: aliases retornavam path/score divergente. Correção: seis
testes focais verdes, ambos os papéis, paridade com bytes reais, path relativo e
absoluto, rejeição de inline source, arquivo ausente e symlink para secret.
Suíte de bootstrap/prompts/focais: 74 testes verdes (57,95s).

Pressure real Sol/high, com arquivo existente:

- `/tmp/pi-pressure-max-1Zx1VG/result.json`: 131,53s; arquivo score 66/x-high,
  `should_split=true`; plano com três outcomes medium/medium/low.
- `/tmp/pi-pressure-atomic-high-kjs9LP/result.json`: 85,229s; arquivo score 34/high;
  uma task high com justificativa explícita de transação/invariante atômica.

Esses probes exercitaram paths absolutos antes do ajuste de normalização; os bytes,
scores e decisões permanecem os mesmos para esses paths sem diretórios ponderados.
A paridade relativa/absoluta final está coberta pela regressão nativa dos dois papéis.
Suítes completas e distribuição ainda em validação no momento deste registro.
Adversary e compliance independentes aprovaram a correção focal; o finding de aliases
do adversary foi corrigido e sua revisão repetida aprovou.

## MV: diagnóstico distinto

O planner tentou `mv_recall` e `mp_retrieve`. MP respondeu busca vazia; MV falhou
aberto. O adapter nativo confirmou `auth_required`, e a API pública de status OAuth
confirmou credencial ausente tanto no host quanto no terminal Orca. O operador
autorizou o login oficial `/mcp-auth mv`; a URL localhost de callback foi entregue
ao Pi remoto. Após isso, OAuth presente e recall real retornou a nota de idempotência.
Nenhum token foi copiado para projeto ou alterado manualmente; sem patch de autenticação.

A run deve ser retomada apenas após distribuir a correção pela operação oficial,
preservando a mesma issue e sessão. A v2.6.16 não é considerada validada por essa
dogfood parcial; os demais critérios do briefing continuam pendentes de execução real.
