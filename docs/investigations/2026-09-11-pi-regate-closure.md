# Pi: fechamento de re-gate na dogfood #317

Baseline: `origin/main` v2.6.17 (`e4baf1b`). Complemento ao briefing pós-dogfood,
sem substituir seus critérios de conclusão.

## Evidência e causa

Na task-1 da issue Victor #317, a filha corrigiu o limite Graph, executou 55
testes e typecheck verdes, comitou/capturou
`1c93da3b1701d3a7a7c3e9063da558b8529c763f` e recebeu compliance/adversary
`issues: []` às 16:39:30 UTC. `harness_reviews` local retornou `missing: []`,
mas restava `regate_pending`, sem `regate_passed`.

A filha retornou pronta sem registrar o marcador. O host recusou a integração;
o diário ainda descrevia o defeito anterior. O pai repetiu três resumes
improdutivos e encerrou às 16:41:51. Não houve writers/reviewers adicionais nessas
retomadas. Após diagnóstico do monitor, a mesma sessão consultou os reviews e
chamou `mark {action: "regate-passed", task_id: "task-1"}` às 16:53:09.
O host integrou às 16:53:21, sem novo produto/review. Recuperação assistida não
prova convergência autônoma. A task-3 repetiu a omissão; o pai, já orientado,
resolveu-a com uma retomada focal às 17:19:07, sem intervenção adicional.

A inspeção não mudou de v2.6.15 a v2.6.17. O prompt global mencionava o marcador,
mas o local era impreciso. Não há evidência de regressão introduzida pela release.

## Correção mínima

- Prosa local explicita o marcador existente, seu resultado e atualização do diário.
- Prosa global distingue diagnóstico corrente de diário desatualizado.
- Motivo de inspeção usa a validação de reviews já calculada: aceitos pedem
  fechamento; negativos/missing pedem correção focal. Gates não são alterados.
- Nenhuma aprovação automática, policy engine ou recibo adicional.

A task-2 também consultou `git merge-base` em um comando composto. O rail
confundia seu prefixo com `git merge`. A exceção permite somente consulta literal
isolada com argumentos simples; comandos compostos continuam negados. Não houve
tentativa real de integração pelo filho nesse evento.

## Validação

Baseline focal anterior: 119/119. Quatro REDs recuperados comprovam diagnóstico
genérico, orientação local ausente e falso bloqueio de merge-base isolado.
O teste do marcador nativo preserva HEAD, eventos de dispatch e recibos de olhos.
Negativos continuam pendentes. Chains, quotes, pipes, redirects e substituições
permanecem bloqueados. O adversary encontrou bypass de chains na primeira versão;
a exceção anchored corrigida foi reavaliada e aprovada, assim como o compliance.

Pressure real Terra/high anterior: 4,477s, somente `mark regate-passed`, zero
writer/reviewer. A evidência é injetada; pré-condições são cobertas pelo teste
nativo. Não se exige quota de consultas a evidência já fornecida.

O operador confirmou a remoção do worktree temporário durante a suíte completa:
o run terminou com `ENOENT uv_cwd` e não vale como validação. O patch de produção
foi recuperado dos artefatos materializados e os testes reconstruídos. Suíte Pi
anterior: 1112/1112; suítes finais, materialização e reavaliação do patch recuperado
devem ser confirmadas no PR antes do merge. O vendor da dogfood permanece intacto.
