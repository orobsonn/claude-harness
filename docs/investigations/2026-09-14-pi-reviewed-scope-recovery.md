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

A suíte completa e o teste na run original ainda estão em andamento.
