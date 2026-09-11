# Pi: reconciliação bloqueada pela própria barreira

Baseline `origin/main` v2.6.18 (`097f9b9`). Finding real da dogfood Victor #317,
complementar ao briefing pós-#275, especialmente 5.1 e preservações 5.4/5.14.

## Reprodução

A task-2 foi corrigida somente em teste e reintegrada pelo host em
`3775cb1d3fdea777b7fdde715f3e99a6ad8d1408`, child
`8d818033efb2f18e6c0e0022fa67cbd041a04873`. A suíte completa terminou às
18:31:31 UTC (1015,49s): 2694 testes passaram, dois falharam em um teste da task-4.

O pai retomou a task-4 integrada. A transição identificou corretamente o upstream
novo, preservou o recibo histórico e criou `correction_barrier` para task-4. Em
seguida, `reconcileDependent` chamou `readIntegratedTaskEvidence` para validar
task-2. Esse leitor recusa qualquer barreira global ativa: a reconciliação recusou
o upstream válido com `current integrated task registry entry required`.
Reintegrar task-2 também era corretamente proibido enquanto task-4 estava em
correção. Três resumes não produziram launch; o pai encerrou às18:33:02,
preservando arquivos e estado, sem tentativa de merge pelo filho.

O teste anterior dessa transição injetava `readIntegrated: () => ({ok:true})`.
A regressão de fronteira agora usa o leitor real e recibos completos: passou
na validação do upstream antes da barreira e reproduziu exatamente a falha no
resume. Baseline dos dois módulos:78/78; dois novos testes RED antes do patch.
Isso prova a lacuna atual, não a causa dos logs apagados da #275.

## Correção mínima

O reconciliador passa ao leitor sua identidade interna de task/attempt.
Só o dependente bloqueado dono da barreira pode, nesse contexto, consultar seu
upstream declarado e integrado. O leitor executa as mesmas validações completas
de plano/spec, recibo, capture, ancestralidade e hashes que já existiam.

Não há operação nova para o modelo, limpeza da barreira, alteração do algoritmo
de merge, integração em filho nem aprovação automática. Leitores ordinários de
admission/final continuam negados durante a correção. A integração legítima do
dependente continua sendo necessária para fechar a barreira.

## Evidência adicional

- Novos testes GREEN; leitura comum continua negada e não altera registry.
- Contexto de outra task/attempt, dependent em execução, plano divergente,
  upstream ausente/stale/bloqueado e hash de recibo forjado continuam negados.
- Suíte focal ampliada:182/182, zero falhas,37,43s. Preserva duas recuperações
  test-only, captura histórica e bloqueios de finalização.
- Probe somente de leitura sobre o registry preservado da própria #317:
  leitor v2.6.18 nega; leitor corrigido valida task-2 para reconciliação task-4;
  leitor corrigido sem contexto continua negando; bytes do registry inalterados.
- Adversary e compliance independentes aprovaram; adversary reexecutou80/80
  dos dois módulos. Suíte Pi1114/1114 (349,09s), repo3697/3697 (515,60s),
  sem falhas/skips. Syntax e diff-check verdes.
- Vendor oficial temporário160arquivos, agentes materializados com tools de
  planejamento preservadas e nenhuma autenticação copiada. Leitor materializado
  também verificou o upstream real só no contexto de reconciliação. Launcher
  `--verify`: Pi0.84.4, subagents21.2.0,11roles. Package dry-run sem sessões,
  worktrees ou pastas geradas na raiz do repositório-fonte.
- CI, release/vendor consumidor e retomada real ainda precisam ser concluídos;
  prova somente de leitura não substitui conclusão operacional da dogfood.

A dogfood está parada por defeito do harness, não por bloqueio de produto. Os
dois failures da suíte Victor ainda precisam de diagnóstico/correção focal;
este patch não os oculta nem os dispensa.
