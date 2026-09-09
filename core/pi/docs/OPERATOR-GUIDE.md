# Guia do operador — Pi Harness

## Instalação e atualização

No projeto, instale ou atualize o harness pelo lifecycle; não copie arquivos de
`core/` manualmente. Sem `--target`, init/update instala os quatro runtimes:
Claude Code, OpenCode, Codex e Pi. Use um `--target` explícito somente quando
quiser limitar a operação àquele runtime. Para Pi, a fonte versionada é
`core/pi`, e o launcher também carrega as skills compartilhadas em
`core/codex/skills`. Depois do vendor, o runtime da worktree fica em
`.pi/harness/`.

O init/update materializa quatro defaults no runtime Pi: `agents/`,
`models-store.json`, `settings.json` e `subagents.json`. Antes de uma run,
confira a instalação:

```sh
node .pi/harness/pi-harness.mjs --verify
```

Esse preflight só lê e verifica. O runtime Pi fixado fica no cache do usuário
do host (`~/.cache/claude-harness/pi-runtime`, ou `XDG_CACHE_HOME` absoluto),
separado do Pi global e de `node_modules` do produto. Worktrees compatíveis no
mesmo host reutilizam a geração validada.

O login também é do usuário do host, não da worktree: o launcher usa
`~/.pi/agent/auth.json`. Em uma máquina nova, faça `/login` no Pi como aquele
usuário; não copie credenciais para o repositório.

## Iniciar uma entrega

No terminal da worktree:

```sh
node .pi/harness/pi-harness.mjs "Implemente a issue #<numero> seguindo a pipeline de entrega."
```

Esse é o modo TUI. Para uma execução autônoma/headless, use `--mode json -p`
antes do pedido. Somente no TUI local, fora de uma cerimônia ou após um pedido
explícito para suspendê-la, o operador pode trabalhar inline sem cerimônia. Uma
cerimônia suspensa volta a `active` ou `reconciling` pelo resume na mesma sessão;
isso não força uma conversa nova. Headless sempre opera com cerimônia e nunca
recebe permissão para suspendê-la — pode apenas retomar uma suspensão já criada
no TUI local. Spec, plano, revisão e gates continuam obrigatórios para delivery.

Cada execução operacional começa uma sessão nova e mantém o lock da worktree.
Para retomar, informe somente a sessão exata:

```sh
node .pi/harness/pi-harness.mjs --harness-resume <session-id> "Continue o plano."
```

Se o arquivo ou o preflight não conferirem, o launcher não cria substituta.
Após uma interrupção, esse preflight também reconcilia o owner e os processos
registrados antes de retomar. Não remova
`.pi/harness/state/parent-orchestrator.lock` nem abra um segundo pai para a mesma
worktree enquanto uma execução possa estar ativa.
Os seletores nativos de sessão do Pi são recusados pelo launcher; texto depois
de `--` é apenas prompt. Executar `pi` diretamente não recebe esse contrato.

## Implementações por tarefa

Em sessões novas LIGHT/FULL, o pai global continua responsável por spec, plano,
integração, validação agregada, harvest, revisão final e shipping. Depois de um
APPROVE host-owned do plan-reviewer para os hashes atuais, ele executa o plano
com `harness_tasks`:

1. `dispatch` recebe os IDs prontos. Tarefas independentes podem começar juntas;
   dependentes aguardam a integração de seus recibos, e scopes ativos conflitantes
   são serializados.
2. `status` observa os jobs duráveis. Cada implementação roda em processo destacado,
   worktree própria e sessão pai local. Abortar a observação ou encerrar o pai global
   não equivale a cancelar o job.
3. `integrate` exige `task_id`, `attempt_id` e `expected_head`. A ferramenta integra
   somente aquele SHA verificado e grava um recibo para dependências e consumers finais.
4. `resume` encaminha feedback para a mesma tentativa e sessão local, somente após
   comprovar que o processo anterior terminou. A tarefa volta a `in_progress` e sua
   validação volta a `pending` até o novo resultado ser integrado. Se ela for uma
   dependência compartilhada, os processos dos descendentes admitidos precisam ter
   terminado; worktrees pendentes devem estar limpas e na branch reservada. Uma
   barreira pausa novos dispatches e outras integrações durante a correção.
   A dependente bloqueada não precisa ser integrada com defeito: depois de corrigir
   e integrar a tarefa proprietária, use `resume` na dependente. O host incorpora o
   HEAD corrigido com um merge registrado, preserva commits, plano, IDs e grant
   original, e exige revisões no novo HEAD antes de aceitar sua integração.
   `status` não elimina essa pendência. Conflitos ou edições concorrentes preservam
   o trabalho e bloqueiam o lançamento; não altere receipts nem amplie o escopo
   para contorná-los. Uma tentativa ainda sem sessão local precisa concluir sua
   admissão inicial antes de iniciar a correção da ancestral.

Cada pai local usa as mesmas mãos, olhos e markers nativos: test-author, fidelity,
freeze, executor, captura atual, revisões, sniper e re-gate. Ele não inicia outra
triagem, spec ou planejamento e não faz shipping. As revisões de implementação
podem executar compliance, adversary e security em paralelo, com até três olhos;
autoria, mãos, fidelity e revisão da spec permanecem exclusivas. Quando todas as
tasks estiverem integradas, o pai global roda os testes do conjunto e a finalização
normal no HEAD agregado.
Uma correção de dependência feita depois de seus consumers preserva os recibos
históricos, mas invalida o fechamento agregado: testes e olhos finais rodam novamente
no novo HEAD antes do shipping.

No TUI, cards recolhidos dos agentes do harness concluídos mostram um resumo público.
O planner exibe a quantidade de tasks quando ela pode ser verificada na saída; os
revisores exibem o parecer e, quando há revisão ou bloqueio, o primeiro motivo
material. Um relatório ausente, ambíguo ou contraditório aparece como
`PARECER: INDISPONÍVEL`; expanda o card para consultar a saída original completa.
Executor, test-author, sniper e shipper exibem o status declarado e uma linha do
resultado; harvester exibe a quantidade de deltas propostos. Os demais papéis do
harness recebem um resumo neutro, sem inferir aprovação. Não há chamada extra ao modelo.
Cards parciais, papéis externos e cards expandidos continuam usando o renderer
nativo sem alteração. O comportamento entra após init/update do runtime Pi; ele não
modifica uma execução que já esteja presa a um runtime imutável.

`harness_plan` é apenas o painel desse fluxo. Várias tarefas podem permanecer
`in_progress` simultaneamente, sem uma atualização apagar o estado das irmãs. O
registry e os recibos de `harness_tasks` são a autoridade operacional. Essa pipeline
usa Git e o Pi Harness instalados na worktree atual; não exige um clone ou processo
do Orca.

## Memória e aprendizados

No início, o pai recebe como dados de referência temporários, com limites,
`MEMORY.md` (lições técnicas), `CONTEXT.md` (glossário de negócio), `kaizen.md`
(hipóteses de melhoria) e o `shared_context.md` da própria run. O conteúdo orienta a
execução, mas não supera o pedido atual, a spec, o plano ou a evidência do repositório.
A injeção automática usa o evento `context`, substitui a mensagem anterior e não grava
cópias no histórico nem eleva os documentos a instruções de sistema. A ação `read`
fica reservada a hashes, recibos de harvest ou diagnóstico explícito.

Durante a run, fatos úteis ficam em um `shared_context.md` de até 8 KiB, isolado
pela sessão. Em retomada, o pai recebe automaticamente o buffer da mesma sessão. Uma sessão nova
não varre buffers antigos. Os agentes recebem apenas os trechos pertinentes; o autor
de testes recebe também orientações relevantes de runner e fixtures.

Depois que as tarefas funcionais estão verificadas e commitadas, o harvester somente
leitura propõe até três deltas para os documentos duráveis. Sem delta, o fluxo segue
direto. Com delta, `harness_memory apply` aplica apenas os paths e hashes validados; o
pai confere o diff e faz o commit seletivo antes dos olhos finais. Harvest e shipping
não alteram o plano nem chamam planner. Assim, as revisões finais sempre observam o HEAD
que será entregue.

Na conclusão entregue, `harness_memory finalize` exige recibos finais e do shipper no
HEAD atual e git limpo antes de apagar o buffer e os payloads transitórios da própria
sessão. Uma continuação exclusiva de release tem prova específica de versão/changelog,
PR e CI para não repetir tarefas anteriores ao squash. Propostas duráveis pendentes
não podem ser descartadas por essa exceção. Abort, shutdown ou run
incompleta preserva o buffer para retomada. Runs futuras usam apenas aprendizado durável
que chegou à branch mergeada.

## Papéis e modelo

O fluxo separa os dez papéis de entrega (`planner`, revisão de plano,
adversarial, segurança, compliance, harvester, autor de testes, revisor exclusivo de testes, executor,
sniper e shipper) do olho opcional `harness-discussion-adversary`, usado só na
conversa de Grill. O rail fixa a rota de cada despacho. Em particular,
`harness-plan-reviewer` usa `openai-codex/gpt-6-astra` com esforço `high`.

## `pi install` nativo

`pi install <pacote>` continua suportado: o bootstrap nativo materializa os
papéis do harness no diretório de agente escolhido pelo Pi antes do
pi-subagents. Isso oferece o catálogo e o contexto de workflow, mas não ativa
o launcher, não troca login/settings globais e não é isolamento de segurança.
Pi continua com as permissões do usuário que o iniciou.

## Release do produto

| Skill | Quando | O que faz |
| --- | --- | --- |
| `harness-releasing-versions` | Release versionada do produto | Com **release-please**, Conventional Commits na `main` fazem a action abrir `chore(main): release X.Y.Z`; o merge cria a tag e a GitHub Release automaticamente. O fluxo manual é somente fallback sem release-please. |

## Limite importante

Os rails do harness orientam e bloqueiam partes do workflow, mas não são um
sandbox de sistema: não isolam processo, rede ou credenciais de outro processo
do mesmo usuário. Mantenha as permissões e a política do ambiente como a
fronteira de segurança.
