# Pi: parecer consistente e aplicabilidade de security

Base: `0b93a2755bb03a596cd9729634a515c017a8b09c` (v2.6.22).

## Reprodução real

Na Victor #207, o test-reviewer `861a9fd8-b58a-496` produziu o mesmo
`Verdict: APPROVE` no início e no fim do relatório. O parser exigia exatamente
uma declaração, recusando a fidelidade apesar da conclusão inequívoca. A task
`3aa905fa-6ca4-428e-b11e-6d70fe0059a2` bloqueou antes do executor; uma retomada
de marker não resolveu. O freeze e a evidência original foram preservados.

Replay read-only do corpo original (SHA-256
`3a630a2a847e11314590f370d654438a5a2bf0d649592308855fffd3bb8f9f25`)
reproduziu a recusa antiga e a aceitação pelo parser corrigido. Nenhum log,
recibo, HEAD ou parecer foi reescrito. Este replay não equivale à conclusão da
run após atualização oficial.

Na Victor #210, a task alterou a comparação de chaves nos middlewares de
autenticação, mas despachou somente compliance/adversary. O status nativo mostra
o mínimo de papéis ativados, não calcula toda a aplicabilidade. O plano exige
security final, o que não substitui a revisão de task aplicável no fluxo FULL.
Um probe com Terra/high, prompt anterior e status nativo equivalente reproduziu
a omissão. A baseline Claude exige security conforme o delta, não em toda task.

## Ajustes mínimos

- Aceitar uma declaração canônica na fronteira do relatório ou duas declarações
  idênticas nas duas fronteiras. Conflitos, declarações intermediárias, formatos
  não canônicos e citações continuam recusados. REVISE/BLOCKED repetidos não
  viram aprovação. Binding, sequência, hashes e supersessão não mudam.
- Explicitar no coordenador os gatilhos de security já usados pelo Claude, a
  diferença entre mínimo do status e aplicabilidade, e a independência da etapa
  final. Preservar LIGHT, rerun afetado e dispensa quando não há gatilho.
- Distinguir o brief de fidelidade (Verdict único inicial) do brief dos olhos de
  implementação (JSON issues/follow_ups). O probe revelou que a antiga instrução
  genérica de Verdict contaminava também o brief dos olhos de implementação.
- Alinhar a frase-resumo da skill à ordem já implementada: testes, olhos finais,
  harvest e shipping. A frase ainda listava harvest antes dos olhos; uma regressão
  focal foi RED antes dessa correção de prosa. Não há mudança do fluxo de memória.

Sem novo gate, schema, roteamento, motor de paths ou obrigação de três olhos.
Esses ajustes tratam falsos bloqueios e paridade de prosa do briefing pós-#275;
não reimplementam a supersessão de parecer negativo nem a fidelidade histórica.

## Verificação focal e limites

- Baseline v2.6.22 em worktree separado intacto: 75/75 testes de task-run e
  task-receipts. As novas regressões foram RED antes do ajuste.
- Parser e fronteiras de task: 81/81 GREEN, incluindo releitura da mesma evidência
  persistida e freeze ancestral. Assets e runtime: 43/43 GREEN.
- Probes reais Terra/high: auth e schema despacharam os três papéis; mudança
  interna despachou somente compliance/adversary. Após distinguir os formatos,
  novo probe auth despachou três papéis com briefs JSON corretos (18,214 s).
  Dispatches dos olhos são stubs neste exercício: ele comprova decisão e brief,
  não uma cerimônia completa nem a revisão do produto por esses agentes.
- Adversary e compliance independentes aprovaram os deltas fora da pipeline do
  harness. Suítes completas, distribuição, CI e recuperação real devem ser
  reportados com seus resultados, sem transformar probes em prova de dogfood.

A omissão original de security na task #210 permanece um defeito observado;
uma revisão final posterior não deve apagá-la da comparação quantitativa.
