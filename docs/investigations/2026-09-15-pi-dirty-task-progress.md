# Pesquisa pós-evento: progresso antes do commit

## Reprodução

Run proj-lainny `pesquisa-pos-evento`, pai `3a881e88-bfbc-4ac4-bfb3-e9d95e75c651`, task `task-1-migration-rollout-barrier`, sessão `caf8ac36-fc3b-40aa-ab62-ed1b7965340e`.

Em 15/09, 10:17 UTC, a continuação consumiu a chave `7b77711d5228ac8393e04ad01b41d02b842044e653b47682134c63a03e9f3367`. O autor produziu 477 linhas de testes novos sem commit; a execução registrou 5 REDs novos e 44 testes anteriores passando. Às 10:24 o filho encerrou antes de fidelidade/freeze/implementação. O pai classificou a task como bloqueada por árvore suja. O arquivo pendente era trabalho da própria task, não sujeira externa.

O detector considerava HEAD, fidelidade, reviews e comandos verdes em árvore limpa; não considerava os bytes pendentes. Replay read-only retornou a mesma chave consumida. A versão 3.0.6 tem a mesma biblioteca de continuação da 3.0.4 carregada nesta run: os PRs de dependências e leitura do plano não resolvem essa lacuna.

## Correção focal

O detector inclui um digest do conteúdo pendente nos paths admitidos pelo binding da task, reutilizando o verificador de escopo existente. Não conta timestamps, staging, reescrita idêntica nem arquivos de runtime/fora de escopo. Não segue symlinks para ler conteúdo. O sinal serve somente para lembrar a etapa pendente, nunca para aprovar captura, fidelidade, review ou escopo.

Uma captura/regate antigos no mesmo HEAD não encerram a task enquanto houver delta autorizado pendente. O lembrete orienta consumir o RED já produzido com revisão/freeze, em vez de repetir autoria. A proteção de uma continuação por estado observado permanece, inclusive após reload e retorno a um delta já visto. Pausa, aborto e erro do provedor permanecem terminais para essa continuação.

## Evidência

- Regressões novas falharam na baseline: chave igual depois do RED e retorno de conclusão antiga mesmo com delta novo.
- Após a correção, replay read-only da mesma task: chave antiga já vista; chave corrigida `9ad009acc85880ba6fbd6f3803e6ab5e7e377bd5a640e926afe254d1bf927a56` ainda não vista, etapa `task-implementation`.
- Testes cobrem arquivos tracked/untracked/staged, alteração e exclusão, ruído externo/runtime, conteúdo repetido, restart, symlink e preservação de gate-state. O teste SDK nativo continua comprovando consumo de follow-up sem nova mensagem do operador.

## Limites e recuperação

Isso corrige a parada após progresso não commitado; não prova que todos os achados da migration sejam corretos nem elimina re-trabalho de produto. A task teve 13 lançamentos, incluindo correções úteis e retornos prematuros, não 13 implementações do zero.

A recuperação deve usar release e lifecycle oficiais, retomar a mesma sessão/tentativa e preservar o delta pendente e as tasks integradas. O aceite operacional é observar o RED existente avançar para fidelidade/freeze/implementação sem novo autor apenas para recriá-lo. Não apagar arquivos, editar recibos ou remover o gate de árvore limpa para simular fechamento.
