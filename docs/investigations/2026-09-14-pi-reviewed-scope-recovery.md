# Correção de escopo na mesma run Pi

A run `issue-22` de proj-lainny ficou bloqueada após integrar cinco tarefas:
a correção de auditoria precisava de `src/db/registrar-decisao.ts`, omitido do
escopo da tarefa inbound. O prompt Pi orientava abrir outra entrega e os grants
v1 rejeitavam qualquer mudança no hash global do plano.

## Referência portada

`core/claude-code/hooks/plan-write-gate.mjs` permite deliberadamente incluir o
arquivo no plano antes de escrever. `orchestrating-delivery/SKILL.md` encaminha
findings finais ao sniper e repete os gates afetados. Seu `references/fix-mode.md`
orienta replanejar a tarefa quando falta escopo, preservando a mesma branch.

O Pi usa seus papéis e ações existentes: planner corrige o escopo, plan-reviewer
aprova e `harness_tasks resume` retoma a mesma tarefa/tentativa/sessão. Não há nova
ferramenta, proposta, plano suplementar ou pedido de autorização ao operador.

## Adaptação necessária ao runtime Pi

Antes do planner, o host preserva no registry o plano e a aprovação usados na
admissão. Grants e claims originais continuam imutáveis. A aprovação nativa atual
permite acrescentar `scope_paths`/`allowed_writes` às tarefas existentes, mantendo
spec, demais campos, dependências e contratos congelados. Apenas as tarefas cujo
contrato mudou precisam de uma nova inspeção; recibos das demais seguem válidos.

O processo retomado em um consumidor usa o harness atualizado instalado no pai.
Cada lançamento conserva sua identidade de runtime para validar o histórico.
Os testes usam projetos temporários fora do repositório fonte.

## Validação

- 189 testes focais passaram antes das últimas regressões adicionais.
- Eventos nativos preservam o plano original antes do dispatch do planner.
- Escrita do planner sem APPROVE não autoriza a retomada.
- A tarefa corrigida carrega o novo escopo na mesma tentativa, sem mudar grant/claim.
- Recibos integrados não afetados continuam válidos; recibo afetado exige revalidação.
- Histórico de processos aceita troca de runtime e rejeita troca de identidade forjada.
- Vendor real em fixture retoma a tarefa com o launcher atualizado do pai.

A suíte completa final passou: 3.769/3.769, sem skips, em 572 s. O CI do
commit `aa9777e` também passou. O teste na run original segue em andamento.

## Teste na run original

- `c7f941c`: instalado no pai; launcher `--verify` passou. Hashes do registry,
  gate-state, plano, spec, grants e claims permaneceram iguais após o vendor.
- Às 11:56 UTC, o pai tentou chamar o planner, mas o hook anterior de
  `harness-tasks` ainda negava planner/plan-reviewer depois da admissão.
- `aa9777e`: retirou essa proibição antiga; spec/classificação continuam
  preservadas. A regressão agora executa os hooks de tasks e entry na ordem real
  com uma tarefa admitida. Os 81 testes desse ajuste passaram.
- Às 11:59 UTC, a mesma sessão despachou o planner com sucesso e o host capturou
  `plan_snapshot` no registry. Nenhuma tarefa, tentativa ou sessão foi substituída.

- Às 12:05 UTC, o planner concluiu. Comparação estrutural confirmou que somente
  `scope_paths` mudou: `src/db/superficie-camada.spec.ts` para task-1;
  `src/db/registrar-decisao.ts` e `src/db/registrar-decisao.spec.ts` para task-3.
  O pai despachou o plan-reviewer na própria sessão.

- Às 12:07 UTC, o plan-reviewer aprovou e o pai retomou a task-3 na mesma
  tentativa `9e071284-0b30-4b7a-be2f-1233a154ad88` e sessão filha
  `965e1b00-8b0a-4078-a8e1-0b0a35fbd381`. O sniper conseguiu alterar o arquivo
  anteriormente bloqueado e preservou os testes congelados.
- Às 12:15 UTC, a correção `8c2f83f9f3be0b276de44b1d34982b6ab4003bd4`
  foi integrada em `e6658546a394aad1b95595e42606afbb9c541c63`, com recibo
  `host-task-integration` e hash do contrato de escopo corrigido na inspeção.
  Os dois lançamentos antigos mantiveram o runtime original; o terceiro usou o
  runtime atualizado do pai. O bloqueio de escopo foi resolvido de ponta a ponta.
- O pai seguiu autonomamente para a correção do finding de armazenamento da
  task-4-durable-runtime. Os findings finais da entrega continuam em validação.

## Coerência de `allowed_writes`

A checagem adicional encontrou outra divergência do mesmo contrato: o dispatch
canônico já autorizava `allowed_writes`, mas o coordenador e a inspeção de tarefas
consideravam somente `scope_paths` e testes congelados. Duas regressões reproduziram
concorrência com ownership sobreposto e rejeição da integração de um arquivo
explicitamente autorizado. A correção inclui a lista nas três verificações de
escopo; as regressões e a retomada combinando os dois campos passaram (3/3).
