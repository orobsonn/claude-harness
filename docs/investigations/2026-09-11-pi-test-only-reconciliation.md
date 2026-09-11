# Pi: recuperação test-only após reconciliação sem delta de produto

Baseline `origin/main` v2.6.19 (`a26c848`). Complemento ao briefing 5.1/5.11 e
preservação de captura histórica, recovery consecutivo e rerun seletivo.

## Reprodução real

Na dogfood Victor #317, a retomada das19:36 UTC passou pela barreira corrigida
na v2.6.19. O host reconciliou a task4 com o agregado `3775cb1`, gerando
`15537aba`. O delta em relação ao filho `0e0fb1a8` continha somente
`test/integration/publish-ad-concurrency.test.ts` e `MEMORY.md`.

A task4 corrigiu seu mock global em `61175f0`: passou o par de suites20/20,
focal12/12, typecheck, test-reviewer e compliance afetado. Fidelity/capture e
regate-passed foram aceitos nativamente. Não houve executor/sniper adicional.

Às19:41:55, a inspeção host recusou:
`test-only recovery requires a prior captured implementation after dependency reconciliation`.
Uma retomada de diagnóstico não resolveu; pai encerrou às19:43:12 sem entregar.
Essa regra exige que o executor ancestral seja posterior à reconciliação mesmo
quando nenhum código de produto mudou. Chamá-lo somente para novo recibo seria
o no-op writer que o briefing proíbe.

## Ajuste focal

- Revalidar o par histórico imediato usando o prefixo de reconciliações que
  existia naquele launch. O digest histórico ainda precisa corresponder; não
  remover provas da inspeção atual nem reviver recibo anterior inválido.
- Verificar separadamente os segmentos do delta: mudanças feitas pelo filho
  permanecem restritas aos próprios testes congelados. Somente merges exatos
  já comprovados por `taskScopeBase` podem transportar testes/fixtures canônicos
  do plano e os documentos duráveis já definidos pelo subsistema de memória.
- Qualquer outro delta importado, incluindo produto ou configuração, continua
  impedindo recovery test-only. Captura e autor atuais continuam posteriores à
  reconciliação. Nenhuma escrita manual de estado, nova operação ou reconciliador.
- Aplicar a mesma verificação na inspeção e leitura da integração persistida.

## Verificação

Baseline task-receipts51/51. Nova fixture pequena combina reconciliação real
Git com o fluxo existente de captura histórica: reproduziu exatamente a mensagem
acima. Correção passa, inclusive com memória importada e segunda recuperação.
Delta de produto, escrita de memória pelo filho, árvore de merge forjada e digest
histórico incorreto continuam recusados.

Probe sobre os recibos reais da task4: baseline recusa; código ajustado aceita
o HEAD61175f0 com origem executor0e0fb1a8, autor atual e dois olhos satisfeitos.
Registry permaneceu byte a byte inalterado. O probe não integra nem aprova a run;
Git apenas recalcula a árvore de merge, sem mudar refs/worktree.

Adversary independente aprovou e reexecutou54/54; compliance aprovou com cinco
regressões focais. Pi1117/1117 (370,42s), repositório3700/3700 (540,14s), zero
falhas/skips. Vendor oficial temporário160arquivos: inspeção materializada aceita
a mesma prova real sem alterar registry; agentes de planejamento preservados.
Launcher verify Pi0.84.4/subagents21.2.0/11roles. Package dry-run643arquivos, sem
sessões/worktrees/node_modules ou artefatos gerados na raiz. Syntax/diff-check verdes.

CI, release, distribuição ao consumidor e retomada real ainda pendentes.
Não confundir aceitação read-only da prova com entrega da issue.
