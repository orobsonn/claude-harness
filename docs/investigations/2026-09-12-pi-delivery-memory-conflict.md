# Reconciliação global após harvest paralelo

Baseline: `origin/main` v2.6.23 (`d911eb8`). As runs abaixo começaram em
v2.6.22; não se atribui a elas o comportamento de uma correção ainda não lançada.

## Reprodução observada, distinta da evidência perdida da #275

Em 12/09/2026, #212 foi entregue pelo PR338; PR339 atualizou o vendor. A base
do Victor passou a `e865b8e097f89f0b07bb1e68ac0e03ebdc904420`.
Os PRs #340 (#210), #341 (#206) e #342 (#208) então ficaram `CONFLICTING`.
`git merge-tree --write-tree HEAD origin/main` em cada pai mostrou conflito
exclusivamente em `MEMORY.md`. A base também incorporava produto/testes e assets:
conflito somente em memória **não** significa delta pós-merge somente de memória.

Evento mínimo sanitizado da #208, 13:48:03 UTC:

```json
{
  "phase": "shipping",
  "task_status_before": "integrated",
  "final_reviews": "accepted",
  "harvest": "applied and committed",
  "shipment": {"status": "BLOCKED", "mergeable": "CONFLICTING"},
  "parent_call": {"tool": "harness_tasks", "action": "resume", "task_id": "task-1"},
  "instruction_excerpt": "Reconcilie somente a tarefa existente e seus paths aprovados contra essa base via fluxo nativo do host",
  "child_result": "task run cannot deliver or integrate globally"
}
```

O pai restringiu a memória como se fosse escopo novo de produto. O filho tentou
rebase e, depois da recusa correta, chamou sniper sem delta: 38,868s,
US$0,1113708, hand record `BLOCKED`, `touchedPaths: []`. A nova tentativa terminou
com `current child hand record is not capture-eligible`. A #210 também relançou
a task sem delta; o monitor corrigiu o diagnóstico antes de outro writer.
Isso não prova a causa histórica da #275, cujos logs originais não estão disponíveis.

## Baseline e mudança mínima

`core/orca/review-prompt.md`, STEP 3.5, já atribui ao integrador externo a união
de notas de runs paralelas. O Claude não pede ao executor de produto para integrar
`main`. No Pi faltava a operação global correspondente: `harness_tasks resume`
reconcilia dependências do DAG, não a base remota de um PR.

A ação `harness_memory reconcile` pertence exclusivamente ao pai global. Usa os
SHAs completos observados, preview Git sem alterar árvore/index e patches literais
limitados ao hash do conteúdo conflitado dos três documentos duráveis existentes.
A proposta decide a prosa; o host valida/aplica/commita. Não exige revisão humana.
Conflito de produto é recusado antes da escrita; nenhum `ours/theirs` descarta notas.
O Git continua sendo o integrador, sem registry, reconciliador de dependências ou
máquina de aprovação paralelos. Após sucesso, os recibos permanecem byte a byte
intactos e a mudança real de input exige olhos finais atuais, depois harvest/shipper.

Falha operacional após iniciar o merge não é sucesso: o índice e o diário Git são
preservados para inspeção, sem reset destrutivo nem repetição cega.

## Recuperar a retomada operacional já aberta

A prevenção acima não desfaz a retomada incorreta das #208/#210. `resume` arquivou
a integração original e abriu a barreira de correção. Na #208, o sniper `BLOCKED`
também substituiu o hand corrente. Na #210, reintegrar o mesmo commit ancestral
apenas retorna "Already up to date", sem concluir a correção pendente.

`harness_tasks abandon-resume` registra a decisão explícita do pai de que nenhuma
obrigação de correção de produto permanece. Exige task/attempt/HEAD exatos, motivo,
processos terminados, árvore limpa, integração histórica verificável, input e olhos
originais intactos. Não aprova a mão bloqueada: restaura a integração anterior e
vincula o intervalo abandonado aos hashes dos eventos, launches e hand. Parecer
negativo posterior impede a operação. Nenhum evento, launch ou custo é removido,
e os olhos finais invalidados não são restaurados.

Essa operação vem **antes** da incorporação da base. Uma mudança real de teste ou
produto continua exigindo recuperação normal. Na #208, o upstream #212 altera a
fixture de orçamento no path congelado: a retomada posterior precisa de delta
test-only real, não writer sem delta nem relaxamento do hash congelado. A inspeção
do host reconhece apenas os intervalos de writers abandonados com prova íntegra;
o runtime pinado do filho e todas as revisões permanecem inalterados.

## Evidências e limites

- Dois testes inicialmente RED na baseline por ausência da operação global.
- Fixture Git com dois acréscimos em memória e produto upstream: preserva ambos os
  aprendizados e os recibos; bloqueia harvest/shipping até novos olhos, então libera
  a continuação normal. Merge limpo também é coberto, sem patch inventado.
- Casos focais: pai de task, HEAD/hash stale, árvore suja, substituição integral,
  conflito misto de produto, secret/runtime e tipo symlink/executável. Adição e
  remoção limpas de notas upstream são aceitas; patch conflitado exige arquivo
  regular presente nos dois lados.
- Extensão nativa expõe a ação e recusa pai local/delegados; rail de task também
  a proíbe. A exclusão mútua existente dos olhos continua envolvendo a ferramenta.
- Pressure test opt-in `node scripts/pi-convergence-pressure.mjs delivery-conflict`:
  Terra/high escolheu somente a operação global com SHAs corretos (9,256s).
  Ferramentas do probe registram decisões; isso não é uma dogfood de produto.
- Pressure test `abandoned-delivery-resume`: Terra/high escolheu a ação explícita
  de abandono antes de mudar a base, com identidade, HEAD e motivo corretos
  (6,292s), sem writer/reviewer. Também usa ferramentas injetadas, não altera runs.
- Adversary/compliance, pacote, materialização, suítes completas e retomadas reais
  precisam de verificação do HEAD final antes de declarar a correção entregue.
- Recuperação: 122 testes focais verdes, incluindo abandono → autoria test-only
  real → nova captura, adulteração de prova e parecer negativo posterior. Probes
  read-only dos estados reais #208/#210 passaram; não equivalem a retomada real.
- A atualização não migra o runtime pinado da #207; nova sessão continua pendente
  de autorização do operador. Não atribuir às runs antigas a prevenção nova.
