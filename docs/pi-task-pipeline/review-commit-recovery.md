# Revisão e commit: diagnóstico da run Victor

Em 2026-09-08, a run legada Pi v2.5.0 de `victor-pipeline-dados-mcp`, issue 222,
repetiu revisores na Task 1 e depois continuou bloqueando a Task 2. Foram dois
problemas distintos, identificados nos eventos nativos e no estado persistido.

## Sequência observada

- 14:18:59 UTC: sniper concluiu no HEAD `6d81569`, deixando alterações em
  `src/lib/sandbox/ui.ts` e `src/lib/sandbox/video-transcode.ts`.
- 14:22–14:24: security, adversary e compliance aprovaram esse conteúdo ainda
  não commitado. Compliance precisou de um complemento de evidência do diff.
- 14:25:07: o pai marcou re-gate aprovado.
- 14:26:01: commit `d4006b3570ce60d6a237bac07acddeedc56155cf`, filho de
  `6d81569d63777d59c744215e7fc1f666d004cf29`, registrou os mesmos dois arquivos.
  Não houve novos bytes de produto entre os olhos e o commit.
- O snapshot passou de HEAD antigo com alterações para HEAD novo com árvore
  limpa. Como o recibo identifica HEAD, index, arquivos, plano e spec, os olhos
  anteriores deixaram de ser atuais. O pai repetiu os três revisores.
- 14:33:41: olhos e re-gate já estavam aceitos no commit atual.
- 14:34:08: a Task 2 continuou negada. O record do último sniper não tinha
  `capturedVerifiedAt`, e faltava `capture_verified` para seu SHA `6d81569`.
  Os markers de capturas anteriores não validavam esse produtor.
- 14:35:11: o pai tentou `fidelity`, corretamente recusado porque o produtor
  corrente era sniper, não test-author.
- 14:49:02: após orientação pela TUI existente no Orca, a run executou
  `mark(action="capture-verified", task_id="task-1-direct-video-upload")`;
  o host validou a captura usando o SHA ancestral do record.
- 14:49:26: iniciou o test-author da Task 2, sem nova implementação ou revisão
  da Task 1. Isso comprova a recuperação da dependência, não a conclusão da run.

## Correção

A v2.6.0 já orientava captura → commit seletivo → olhos de implementação.
O patch acrescenta uma verificação antes do despacho caro: alterações de produto
staged, unstaged ou untracked impedem olhos de implementação e finais até a
preparação do commit. Test-fidelity, planejamento e revisão da spec preservam suas
fases. A consulta `harness_reviews` informa paths pendentes quando aplicável.

O gate de dependências distingue identidade/conclusão, violações/ancestralidade,
captura corrente e re-gate. Captura ausente informa o marker correto e não manda
repetir fidelidade ou olhos já aceitos. A prosa reforça a captura após cada mão e
o fornecimento de metadados dos commits aos revisores.

Recibos, hashes, evidências nativas e comparação exata do input permanecem
inalterados. O patch não transfere aprovação de um SHA para outro. A recuperação
da run viva usou o marker nativo do runtime existente; não alterou manualmente
gate-state, recibos, código do produto ou versão da sessão.

## Verificação

Regressões com Git real cobrem alteração staged/unstaged/untracked, remoção,
rename, modo executável e index diferente mesmo com diff agregado zero; também
garantem que um despacho único após commit gera recibo reutilizável, enquanto
mudança posterior de conteúdo continua invalidando a revisão. O diagnóstico da
dependência distingue captura faltante de re-gate pendente.

A flexibilização da estratégia de testes é trabalho posterior, registrado na
[issue 905](https://github.com/orobsonn/claude-harness/issues/905).
