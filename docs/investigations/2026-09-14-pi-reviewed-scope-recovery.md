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

## Conflito entre tarefas após correção

Às 12:48 UTC a task-4-durable-runtime terminou em
`f28f3c5a54015bb0e27d417df285a8bc77a3e09d`, mas a integração no pai
`e6658546a394aad1b95595e42606afbb9c541c63` falhou com conflito em
`src/disparo-global.ts` e `src/worker.ts`. O runtime anterior retomou a task
sem incorporar o pai e retornou o mesmo HEAD. Isso reproduz outra limitação
do coordenador Pi, independente do bloqueio de escopo já resolvido.

A recuperação usa o `resume` existente. O host inicia o merge na worktree da
mesma tarefa; o sniper resolve os conflitos e o pai local commita, captura e
revalida. O journal existente preserva os pais e a árvore do preview Git;
somente os paths conflitantes podem mudar no commit de resolução. A inspeção
exige produtor e captura após o merge. A base de admissão permanece imutável e
o conteúdo importado do pai não é atribuído à mão local. Resoluções parciais
permanecem disponíveis após restart. Nenhuma role, ação ou aprovação foi criada.

Essa é uma adaptação do fluxo Claude de correção por sniper e gates afetados ao
coordenador de worktrees do Pi; não é alegação de identidade entre os runtimes.
Os 161 testes focais passaram, incluindo conflito real Git, sessão/grant
preservados, retomada parcial, rejeição de alteração fora dos conflitos e
rejeição de produtor/captura anteriores à resolução. A validação na run real está registrada abaixo.

- A suíte completa do commit `4e86cec` passou: 3.774 testes, 52 suites, zero
  falhas e zero skips (`/tmp/pi-conflict-full.log`, 581 s). O CI do mesmo commit
  também passou: run `34845747485`, job `103981147733`.
- O vendor `3.0.3-pi-scope-port.4e86cec` foi instalado no pai original e commitado
  em `f8a9c1b`, sem mudar registry, gate-state, plano, spec, grants ou claims.
- Às 12:52 UTC, o pai retomou task-4-durable-runtime na mesma tentativa
  `0ffcee20-9b14-42de-bf52-52ab18f830ea` e sessão
  `19b39b03-e634-4bd7-9cbf-0117fb442183`. O host iniciou o merge, o sniper
  resolveu os dois conflitos e o pai local criou `245ed3d`.
- Os testes detectaram quatro regressões inbound. A tarefa marcou o re-gate
  pendente e despachou outro sniper. Às 13:04 UTC, os cinco arquivos de teste
  inbound/outbound passaram (25/25), sem alteração dos testes congelados.
  Em seguida, a tarefa capturou o resultado e revalidou os olhos afetados.

- Às 13:11 UTC, a retomada da mesma tarefa resolveu a obrigação de compliance
  pendente sem outro escritor de produto. O host aceitou `dafaee3` e integrou
  em `e5650ed`, mantendo o merge `245ed3d` e a resolução posterior em sua
  ancestralidade. O recibo de inspeção inclui `scope_base_sha=f8a9c1b...` e o
  digest da reconciliação `cd9cd799...`.
- O pai seguiu sozinho para task-1. Às 13:29 UTC sua correção de paginação D1
  já estava integrada e o pai retomou task-4 para a paginação da API. Isso é
  continuação da entrega na mesma run, não a declaração de entrega concluída.

## Auditoria de conclusão da recuperação

Em 2026-09-14 13:30 UTC, a auditoria leu novamente os arquivos e objetos Git
originais. A evidência resumida está em
`2026-09-14-pi-reviewed-scope-recovery-evidence.json`.

| Requisito | Evidência verificada |
| --- | --- |
| Complemento de escopo revisado | Aprovação nativa do plan-reviewer para o hash atual; snapshot e aprovação originais preservados; somente task-1/task-3 afetadas. |
| Preservar identidade e trabalho | Mesmo pai `528d7635...`; mesmas tentativas e sessões das tasks 3/4; hashes de plano/spec/grants/claims preservados após o vendor. |
| Usar o harness atualizado | Runtime instalado `3.0.3-pi-scope-port.4e86cec`; digest atual igual ao usado nas retomadas. |
| Resolver o bloqueio de escopo real | Task-3 corrigida e integrada; hash do contrato corrigido confere com o plano aprovado. |
| Resolver o conflito que impedia continuidade | Task-4 resolvida por sniper, testada, capturada e integrada; prova confere pais, árvore Git, escopo e digest da reconciliação. |
| Não substituir evidências válidas | Recibos históricos e testes congelados conferem por hash; integrações continuam ancestrais do pai atual. |
| Continuar a própria run | Pai avançou autonomamente para paginação D1 e depois API, com as mesmas tarefas. |
| Validar a fonte | 161 testes focais, 3.774 testes completos e CI verdes no código `4e86cec`. |

Essa auditoria comprovou os casos de escopo e conflito exercitados. Os requisitos
restantes do produto seguem na run original. Não se declara aqui conclusão da
entrega inteira nem paridade irrestrita entre Pi e Claude Code: adicionar tarefas
ou mudar dependências depois da admissão continua fora da correção implementada.

## Regressão: runtime antigo depois do merge de dependências

Às 13:39 UTC a task-5-crm-queue-ui ficou bloqueada com
`task runtime assets: managed assets changed since task admission`. O host já
havia incorporado as correções das dependências em `1d55a9a`; esse merge trouxe
também o harness atualizado para a worktree da UI. A primeira retomada após a
atualização ainda tentava validar a cópia antiga do filho pelo hash da admissão,
antes de selecionar o runtime instalado no pai. A auditoria anterior não cobria
essa combinação e não demonstrava ausência de novos bloqueios.

A retomada de consumidor agora captura e seleciona o runtime que vai executar
no pai. Não valida a cópia histórica substituída pelo merge. Cada lançamento
anterior mantém seu recibo; checkouts de desenvolvimento da fonte continuam
fixados e verificados. Mesmo com hashes iguais, a retomada seleciona o caminho
do pai, evitando continuar presa à cópia que um merge posterior pode atualizar.

Duas regressões com vendor e Git reais falharam antes da correção: caminho antigo
com hash igual e rejeição depois do merge que atualizou o runtime. Ambas passaram
após o ajuste; também verificam preservação de grant/claim e lançamentos antigos
e rejeição de symlink no runtime atual antes de lançar processo.
