# Pi issue #17: revisões repetidas depois do PR draft

## Evidência da sessão

Inspeção somente leitura em 2026-09-05. A sessão no Orca corresponde à worktree
`/home/orca/orca/workspaces/proj-lainny/pi-issue-17-resume-vps`, sessão pai
`e429dbbe-2fd4-406e-9935-d35862d8fd40`. Horários abaixo em UTC. O histórico bruto
não é versionado; este relatório contém apenas os fatos relevantes ao defeito.

- 04/09 08:05–08:08: compliance e adversário finais revisaram a implementação ainda
  não commitada, com HEAD `bdb8d8e`. O host gravou esse HEAD nos recibos.
- 04/09 08:08: o shipper preparou o commit `98b74c0` e abriu o PR draft #89.
- 05/09 01:23: o operador autorizou merge e release.
- 05/09 01:24: primeiro shipper de merge recusou: recibos em `bdb8d8e`, HEAD em
  `98b74c0`. Não executou ready ou merge.
- 05/09 01:25–01:27: compliance e adversário revisaram novamente. Ambos passaram.
- 05/09 01:28: shipper marcou #89 ready e fez squash merge em `2818f51`.
- 05/09 01:28–01:32: outro shipper preparou a release `0.7.0` e abriu o PR #90,
  commit `9e2108d`, sem publicar tag ou GitHub Release.

Portanto, os dois shippers depois das revisões tinham escopos diferentes: merge
funcional e preparação da release. A tentativa anterior bloqueada e as duas
revisões repetidas decorreram da ordem commit/revisão. Não há evidência de dois
merges nem de duas publicações da mesma release.

## Causa

O prompt exigia revisões finais antes do shipper, enquanto o shipper era orientado
a criar o commit. Os recibos finais se vinculam ao HEAD observado, não ao diff sujo
que os olhos inspecionam. O commit de entrega tornava esses recibos antigos por
construção. O bloqueio posterior era consistente com o contrato; a ordem do fluxo
era incompatível com ele.

Não aceitar um SHA antigo por alegação de conteúdo equivalente: isso permitiria
reutilizar revisão depois de uma mudança real. A correção deve estabilizar o commit
antes das revisões e preservar a verificação de HEAD e limpeza da árvore.

## Base de controle: Claude Code

`core/claude-code/skills/orchestrating-delivery/SKILL.md` define freeze-commit,
impl-commit e fix-commit por tarefa antes da revisão final. O
`core/claude-code/agents/shipper.md` recebe uma série já commitada e explicitamente
não cria um commit único de feature. A allowlist atual do Pi já permite ao pai
`git add` e `git commit`; a proibição no prompt e na mensagem de erro ficou stale.

A correção restaura esse contrato. Não cria fase PREPARE, snapshot de árvore nem
um gate de publicação ausente da base de controle. Os recibos e gates existentes
do Pi continuam sendo respeitados, incluindo o vínculo da revisão final ao HEAD.

## Plano de correção e verificação

1. Regressão: contrato do prompt entregue e do shipper deve exigir commits por
   tarefa antes da revisão final e proibir criar um commit único de feature na
   entrega. Confirmar RED antes de corrigir as instruções.
2. Provar por teste executável que a política atual permite ao pai os comandos
   seletivos de stage e commit e continua bloqueando escrita direta de produto.
3. Corrigir prompt, mandato do shipper e mensagem de erro contraditória. Preservar
   captura, fidelidade, revisão e re-gates; o commit não substitui nenhum deles.
4. Rever árvore e HEAD antes dos olhos finais. Na retomada para merge/release,
   reaproveitar recibos ainda válidos; se HEAD, escopo ou evidência mudou, reconciliar
   o estado e obter as revisões necessárias. Não fabricar SHA ou aprovação.
5. Rodar testes afetados e revisão adversarial independente do diff. Entregar a
   correção no core; não modificar uma sessão remota em andamento nem publicar
   a release do proj-lainny por conta desta investigação.

Risco: instruções e hooks são rails best-effort, não isolamento nem uma garantia
contra mutação concorrente por outro processo do mesmo usuário. A correção prova
consistência do contrato e permissões; o comportamento de uma nova sessão de modelo
continua sendo uma validação operacional separada. Rollback: reverter este patch.
Sem migrações ou mudança de credenciais.

## Verificação executada

- RED: política 21/22; contrato de prompt 11/13, antes de corrigir as instruções.
- GREEN: 136/136 em `policy` (lib e extensão), `harness-runtime`,
  `marker-authority` e `entry-gate` (lib e extensão).
- Git real: hooks permitem stage seletivo e commits de teste/implementação pelo
  pai; hand-record continua válido por ancestralidade depois de freeze-commit,
  fidelity/capture e impl-commit.
- `git diff --check`: sem erro.
- A tentativa ampliada incluindo integração foi interrompida enquanto preparava
  runtime em cache temporário; não é evidência de suíte completa verde. Nenhuma
  nova sessão de modelo foi usada para alegar reprodução end-to-end corrigida.

## Revisão adversarial

A revisão independente confirmou a base de commits por tarefa e pediu a migração
explícita das exclusões de staging e da checagem de freeze órfão do shipper Claude
Code. A ordem de harvest/publicação também foi reconciliada com essa base.

Duas hipóteses iniciais foram refutadas antes de fechar o patch: o Pi já bloqueia
`git add -- .env` e `git add -- .dev.vars` na política posterior à allowlist;
e seu harvester é somente leitura, portanto o relatório não altera HEAD por si.
As exclusões adicionais continuam como instrução de defesa em profundidade, sem
alegação de novo isolamento. Escrita de memória autorizada separadamente que
produza commit exige reconciliar as revisões antes da publicação.
