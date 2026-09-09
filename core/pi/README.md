# Pi Harness

Este pacote porta o harness para o Pi. No Orca, cada implementação usa uma worktree filha e um terminal próprio no ADE. O harness continua responsável pelo plano, TDD, revisões e integração. Também é possível executar a pipeline localmente fora do Orca.

## Pré-flight

Na worktree onde o harness foi instalado, rode:

```sh
node .pi/harness/pi-harness.mjs --verify
```

O resultado precisa incluir `"ok":true`, `"runtimeVersion":"0.84.4"` e `"subagentsVersion":"21.2.0"`. Ele não chama modelo, lê credenciais, instala ou corrige dependências. Cache ausente ou alterado é um erro: execute o init/update do harness nesse host antes de iniciar a run.

O init/update que inclui Pi prepara primeiro o runtime fixado em um cache do usuário (`~/.cache/claude-harness/pi-runtime`, ou sob `XDG_CACHE_HOME` absoluto). Worktrees no mesmo host reutilizam a mesma geração; plataformas e versões incompatíveis usam gerações distintas. O launcher não usa nem modifica o Pi global ou `node_modules` do produto. Uma falha de provisionamento impede a atualização dos arquivos do harness. O pacote nativo Pi mantém suas dependências próprias para preservar `pi install`; isso pode duplicar downloads no instalador npx, mas não muda o runtime isolado usado pelo launcher.

## Uso normal

Abra um terminal na worktree da issue, com o Pi Harness instalado:

```sh
node .pi/harness/pi-harness.mjs "Implemente a issue #<numero> de forma autônoma, seguindo a pipeline padrão de entrega até abrir um PR draft."
```

O comando acima abre o TUI; para headless, acrescente `--mode json -p` antes do pedido. A issue é a entrada de produto, não um atalho que dispensa spec e revisão adversarial.

Cada execução operacional iniciada pelo launcher recebe uma sessão nova e mantém um lock único da worktree até o Pi terminar. Assim, outro pai fresh ou retomado não sobrepõe a mesma implementação. Para reabrir exatamente uma sessão existente, use `node .pi/harness/pi-harness.mjs --harness-resume <session-id> "Continue o plano."`; se o arquivo exato ou o preflight não conferir, nenhuma sessão substituta é criada. Depois de uma interrupção, a retomada reconcilia o owner e os processos registrados antes de liberar o lock; não apague o lock nem inicie um segundo pai manualmente.

A mesma sessão também pode retomar uma spec em rascunho ou uma spec revisada antes da criação do plano. O preflight verifica os artefatos existentes e preserva os gates pendentes: reabrir a conversa não aprova a spec, o plano ou a implementação. Um plano ausente depois de haver evidência de progresso continua sendo erro, assim como arquivos inválidos ou divergentes.

Os seletores nativos de sessão (`--continue`, `-c`, `--resume`, `-r`, `--session`, `--session-id`, `--session-dir`, `--fork` e `--no-session`) são recusados pelo launcher. Texto após `--` continua sendo prompt. Help, versão, export e comandos administrativos não abrem sessão nem disputam o lock. Essas garantias pertencem ao launcher vendorizado; executar o binário `pi` diretamente não passa por esse controle.

O login segue a mesma regra do OpenCode: é **um por ambiente**, nunca por worktree. O launcher preserva roles, settings, extensões e sessões do harness na worktree, mas usa somente a credencial Pi do perfil do usuário do host (`~/.pi/agent/auth.json`).

Para um motor headless/VPS, execute uma vez como o usuário de serviço, abra o Pi e use `/login` → ChatGPT Plus/Pro → **Device code login**. O código é aprovado no seu navegador e a credencial fica apenas no perfil persistente daquele host; todas as worktrees futuras a reutilizam. Em CI sem perfil persistente, use o secret manager para injetar uma credencial de API — não um `auth.json` no repositório.

## Grill e Lavish (descoberta local)

Numa sessão local/interativa fora da cerimônia, peça "faz o grill desta ideia" ou use a skill `harness-grill`. Ela produz o PRD em `docs/prd/` e usa o Lavish somente quando você pede um mockup. Lavish é uma referência privada da entrevista, não outra skill nem uma publicação externa. O olho `harness-discussion-adversary` revisa a proposta sem iniciar delivery ou gerar aprovação da pipeline. Os dez papéis de entrega permanecem separados desse olho de discussão.

Grill não entrevista em headless, não implementa produto e não transforma hipóteses em respostas suas. A referência está em `skills/harness-grill/references/lavish-usage.md` no harness vendorizado; `share` e `setup hooks` continuam proibidos.

## Progresso do plano

Em uma run FULL, depois da aprovação do plan-reviewer e dentro do escopo autorizado, o Pi registra as tarefas em `harness_plan`. Um pedido explícito de implementação autônoma/headless não exige confirmação humana adicional para esse registro. O TUI mostra `Plano 2/5 · atual: Implementar`; tarefas que declaram validação própria adicionam uma segunda linha, por exemplo `Validação 1/2 · atual: Teste de regressão`. O mesmo snapshot aparece no resultado da ferramenta em JSON/headless. O estado acompanha a ramificação atual da sessão; é informativo, não é aprovação, scheduler nem prova de conclusão do código.

Tarefas independentes podem aparecer juntas, por exemplo `Plano 1/5 · em andamento (2): API, UI`. Atualizar uma delas não devolve a outra para pendente. Quando uma tarefa concluída é retomada para correção, ela volta a `in_progress` e sua validação volta a `pending`. `harness_tasks` e seus recibos continuam sendo a autoridade de execução e integração.

## Pipeline de implementação por tarefa

Sessões novas LIGHT/FULL usam a pipeline por tarefa. Depois de a spec estar selada e o plan-reviewer aprovar os hashes atuais, o pai global usa uma única ferramenta:

- `harness_tasks dispatch` inicia as tarefas prontas. Tarefas independentes ocupam worktrees e processos separados; uma dependente só inicia depois de suas dependências estarem integradas. Scopes sobrepostos são serializados e a concorrência tem limite finito.
- `harness_tasks status` reconcilia os jobs registrados e mostra os resultados verificáveis. Os jobs são duráveis e destacados: abortar uma chamada de observação ou encerrar o pai global não cancela uma implementação que já começou.
- `harness_tasks wait` aguarda o término no host, sem chamar o modelo repetidamente. No Orca, usa a espera nativa do terminal e revalida processo e recibos ao despertar. Use quando há tasks rodando e nenhum trabalho independente pronto.
- `harness_tasks integrate` recebe `task_id`, `attempt_id` e `expected_head`, faz merge daquele SHA exato e grava o recibo global. O tip posterior da branch nunca substitui esse argumento.
- `harness_tasks resume` reabre a mesma tentativa e sessão pai local após comprovar que o processo anterior terminou. Feedback volta para a task que produziu a mudança; resultado e validação antigos deixam de liberar integração enquanto a correção está ativa. Para corrigir uma dependência compartilhada, os descendentes já admitidos precisam estar integrados; uma barreira pausa novos dispatches e outras integrações até o novo recibo da dependência.

Após a primeira admissão, plano e spec ficam fixos nessa sessão, inclusive quando todas as tasks terminarem. `resume` permite corrigir implementação dentro do contrato aprovado. Alterar o próprio plano exige nova sessão e aprovação, preservando worktrees e evidências; encerrar tasks não libera a substituição do plano antigo.

Cada pai local executa a pipeline nativa completa da sua task: autoria de testes, fidelidade, freeze, executor, captura, revisões aplicáveis, sniper e re-gate. Ele não repete triagem, brainstorming, spec ou plano globais. Compliance, adversary e security de implementação podem rodar em paralelo, até o limite de três olhos incorporado pelo PR #902; mãos, fidelidade e revisão da spec mantêm exclusividade. O pai global integra os recibos e só então executa testes do conjunto, harvest, olhos finais no HEAD agregado e shipping. Uma correção integrada depois de seus consumers exige repetir esses gates agregados no novo HEAD.

Ao iniciar o pai num terminal Orca, `ORCA_WORKTREE_ID` vincula o despacho àquela workspace. O harness usa `orca worktree create` com o SHA exato da base e `--parent-worktree`, seguido de `orca terminal create` para executar o worker do harness. A relação visual entre worktrees e a base Git são explícitas e independentes. O registry conserva as identidades de workspace, tentativa e terminal; retomadas não criam outra tentativa. Uma falha do Orca é reportada, sem migrar silenciosamente para execução invisível. O resultado `launches[].orca.surface: "visible"` comprova que o notifier/renderer do host adotou o terminal, não que um cliente remoto confirmou a navegação; `background` conserva o handle e a sessão continua listável e reanexável. Para revelar uma task escolhida num cliente conectado, use `worktree.activate` e `session.tabs.activate` com `navigation: "clients"` sobre a mesma worktree, tab e handle: isso não cria outro terminal. Essa navegação deve ser explícita, em vez de disputar o foco a cada despacho de tasks paralelas. Esses comportamentos usam as [primitivas oficiais de worktrees](https://www.onorca.dev/docs/model/worktrees) e [terminais](https://www.onorca.dev/docs/cli/reference).

O launcher carrega explicitamente a extensão oficial `orca-agent-status.ts` instalada pelo Orca para publicar o estado do pai Pi no terminal correspondente. Novas tasks usam a TUI nativa do Pi nesse terminal, com a implementação como prompt inicial. A extensão `harness-task-events` registra o header real da sessão e os eventos nativos de ferramentas no job; ao fim da execução, solicita o encerramento normal do Pi para o pai verificar o resultado. Os filhos nativos continuam usando os recursos do harness. Retomadas conservam a apresentação original da tentativa, inclusive JSON em runtimes antigos. Não abra outra sessão Pi sobre o arquivo de uma task em andamento.

O comando CLI segue `ORCA_CLI_COMMAND` ou `orca`; `PI_HARNESS_ORCA_CLI` permite selecionar um executável alternativo do host. Esse valor é um caminho/comando executável, sem argumentos de shell e sem credenciais.

O despacho aceita `task_contexts: [{task_id, content}]` opcional: até 2 KiB UTF-8 de contexto curado por task. O snapshot pertence àquela tarefa e permanece imutável após a admissão; não herda o diário completo nem concede aprovação. Ao terminar, `context_return` devolve o diário da sessão local vinculado ao HEAD e ao resultado verificado. O pai global lê, revalida o que importa e incorpora explicitamente ao próprio `shared_context` usando `harness_memory update`. Não há concatenação automática de diários entre tasks.

## Rails

O launcher carrega as extensões numa ordem fixa (`core/pi/bin/pi-harness.mjs`). Hooks `tool_call` do Pi rodam na ordem de carga e o **primeiro `block` vence**, por isso `harness-policy` vem primeiro e a UI vem por último. Cada linha abaixo é uma negação real, com a mensagem idêntica à da lane OpenCode:

| Extensão | O que nega |
| --- | --- |
| `harness-policy` | Leitura ou comando sobre caminho com segredo (`.env*`, `.dev.vars`, `~/.ssh`, `~/.aws`), comando destrutivo e mutação direta de caminho do harness (`.pi`, `.codex`, `.agents`). Em LIGHT/FULL, a mão designada escreve e edita dentro do escopo; o pai local verifica e cria os commits seletivos da task, enquanto o pai global apenas observa, despacha e integra o SHA validado. Grava recibo de auditoria de bash/write/subagent. |
| `harness-dispatch` | Delegação para role não canônica, role sombreada por `.pi/agents/` do projeto, `run_in_background`, ou acima do limite de turnos. |
| `harness-memory` | Herança automática de diário para filhos, atualização de contexto fora da sessão, revisão final sem harvest concluído e persistido, e limpeza antes de revisões atuais/árvore limpa. O pai recebe memória durável e o próprio `shared_context.md` em uma mensagem temporária limitada e substituível; só a ferramenta grava o diário. |
| `harness-entry-gate` | Rails de bash de entrega (branch errada, zero commits, re-gate pendente, captura não verificada, `gh pr merge` sem evidência de CI, `harness:ready` sem pipeline fechado) e rails de despacho (cerimônia, fidelidade, re-gate). Reivindica o dispatch-record exato da mão que escreve e liga a sessão filha ao papel despachado. |
| `harness-plan-gate` | Despacho de plan-reviewer/test-author/executor/sniper sem plano estável válido, e args de dispatch que divergem do marcador `HARNESS_TASK_CONTEXT` do brief. |
| `harness-plan-write-gate` | Escrita de `gate-state.json`/`triage.json`, de qualquer JSON sob `.pi/harness/state/`, dos scripts marcadores e do tooling congelado; escrita do plano canônico por quem não é `harness-planner` em despacho; escrita fora do `scope_paths` da tarefa; e mutação literal do estado/plano por Bash. |
| `harness-marker` | Carimbo de marcador sem autorização, clonado, com replay ou com identidade divergente do dispatch-record. O `final-review` exige captura válida para cada tarefa do plano canônico atual. |
| `harness-task-run` | Em um pai local, chamada de cerimônia global, sibling task, harvest, shipping ou integração; mantém toda mão e todo marcador presos à task concedida. |
| `harness-classify` | `classify` chamado de dentro de uma sessão filha. |
| `harness-lavish-gate` | `lavish-axi share` (publica o mockup num host de terceiros) e `lavish-axi setup hooks` (instala hook que compete com o do harness). |

`run_hand` está propositalmente desabilitado: ele iniciava outro processo sem a identidade in-process que liga uma filha ao dispatch atual. A cerimônia usa somente o `subagent` nativo, cuja identidade é capturada no evento de criação da sessão filha.

Nunca bloqueiam, só observam ou injetam contexto: `harness-obs`, `harness-idle-nudge`, `harness-reinject-state`, `harness-version-check`, `harness-context-files` (reintroduz `AGENTS.md`/`CLAUDE.md` do projeto, já que o launcher desliga a descoberta nativa) e `harness-plan-tracker` (UI).

Autoridade do plano canônico: no OpenCode ela vem do SDK (`session.agent === 'planner'`). O `SessionHeader` do Pi não carrega o nome do agente, então a lane grava a identidade da filha em `.pi/harness/state/<pai>/child-identity/` no evento `subagents:child:session-created` do pi-subagents, e o gate lê dali. O wrapper vincula cada chamada à filha exata antes de ligar suas extensões. Um binding ausente ou divergente interrompe a criação; três filhos podem terminar fora de ordem sem trocar papéis ou recibos.

## Revisão de testes

`harness-test-reviewer` avalia somente se os testes representam a tarefa aprovada,
as fixtures estabelecem as precondições e a evidência executável exigida é suficiente.
Retorna matriz e achados consolidados em prosa, com `Verdict: APPROVE|REVISE|BLOCKED`.
O pai local corrige o necessário, revalida as linhas afetadas e encerra ao aprovar.
Compliance continua responsável pela implementação e pela entrega final.

## Revisores em paralelo

Olhos de implementação e finais exigem produto commitado antes do despacho.
`harness_reviews` informa `preparation` com os paths staged, unstaged ou untracked
pendentes; a revisão de testes continua antes do freeze. Se uma dependente for
bloqueada por captura do último executor/sniper, valide seu record e use
`mark(action="capture-verified", task_id="…")`: o host aceita o SHA ancestral do
produtor mesmo após um commit posterior. Isso preserva olhos ainda válidos e evita
repetir fidelidade para resolver somente a captura. Alterações posteriores em HEAD,
index, arquivos, plano ou spec continuam invalidando seus recibos de revisão.

O harness inicia com até três revisores em paralelo. Para consultar ou alterar o
limite, use `.pi/harness/runtime/harness.json` antes de iniciar a run:

```json
{ "maxParallelEyes": 3 }
```

O padrão é `3` revisores em paralelo; os valores válidos são `1`, `2` e `3`. Use `1` para ativar o fallback serial.
Configuração inválida bloqueia a inicialização. O limite é do harness e não substitui
`maxConcurrent` do plugin, que governa trabalhos em background.
Na instalação nativa com `pi install`, o mesmo arquivo fica no diretório de dados
selecionado pelo Pi (`getAgentDir()`), junto de `agents/`. A ponte prepara o cache
fixado na primeira carga quando necessário; não usa dependências do projeto como fallback.

Somente `harness-adversary`, `harness-compliance` e `harness-security`, em revisão de
implementação por tarefa ou final, podem rodar juntos. Os filhos têm sessões e contextos
separados, mas compartilham a worktree, o processo, RAM e quota do provider. O pai aguarda
todos os despachados antes de corrigir, testar, fazer staging/commit ou atualizar gates.
Escrita, autoria de testes, test-fidelity, planejamento, revisão de spec e entrega
continuam seriais. As dependências e evidências da própria tarefa continuam obrigatórias.
Antes do primeiro prompt de cada filho, a ponte confere o carregamento dos bloqueios
de ferramentas, de entrada e de escrita, além das skills do harness. Falha de carga
interrompe aquele filho. Os revisores só podem usar `read`, `grep`, `find` e `ls`.
Extensões e skills adicionais configuradas pelo operador são preservadas. A atualização
substitui somente caminhos registrados como gerenciados pelo harness; esses extras
continuam sendo código confiado pelo operador no mesmo processo.

Cada revisão é vinculada a HEAD, index, arquivos da worktree e plano/spec canônicos.
Uma resposta interrompida, malformada, com pergunta pendente ou com achados não aprova um
gate. O host preserva recibos saudáveis de irmãos. `harness_reviews` consulta a sessão
atual. Na fase task, lista `required`, `available`, `accepted` e `missing`: adversary é
obrigatório; compliance e security de implementação são opcionais até serem despachados.
Depois de qualquer despacho desses olhos, inclusive interrompido ou REVISE, a task exige
um recibo atual e saudável daquele papel antes de integrar. `available` não torna todos
os papéis obrigatórios. Na fase final, a consulta lista `accepted` e `missing`.
Após retomada, despache os olhos aplicáveis pendentes. Mudar o conteúdo invalida a evidência anterior. O plano torna security final
obrigatória com `final_review.security: true`; adversary e compliance são sempre exigidos.

A fila é simples e vive na sessão; os recibos existentes são a autoridade de retomada.
Cancelar o pai fecha a fila, aborta os filhos e aguarda sua execução efetiva terminar.
Uma morte forçada continua sujeita ao lock e à recuperação do launcher descritos acima.
A captura inicial não suporta submódulos: ela bloqueia explicitamente para não aprovar
conteúdo interno que não foi capturado. Repositórios Git aninhados não rastreados também
precisam ser ignorados no Git ou movidos para fora da árvore revisada; o erro identifica
o caminho. Mudança externa que é restaurada entre capturas
não é detectável por esse mecanismo; ele não é isolamento de sistema operacional.

Concorrência pode reduzir espera do provider, mas aumenta RAM ativa e disputa CPU/quota.
Se houver contenção entre os olhos, reduza para `2` ou ative o fallback `1`. A
concorrência de implementações é separada: cada task usa outro processo e worktree,
enquanto cada processo mantém seu próprio limite de revisores.

## Limites

`harness-*` preserva os papéis do harness. Dentro de cada pai local, mãos e fases globais continuam exclusivas; somente os três revisores de implementação e revisão final podem compartilhar o limite configurado. O gate não aceita role do projeto com o mesmo nome. Isso é controle de workflow. Pi roda com as permissões do usuário que o iniciou: **não é sandbox de sistema** e não isola processo, rede nem credenciais. Os rails são determinísticos e best-effort sobre nome de ferramenta e caminho: comando ofuscado e caminho construído em runtime estão fora do alcance deles.

## Modelo

O launcher não injeta provedor nem `--model`. O default vem de `core/pi/runtime/settings.json`, materializado em `.pi/harness/runtime/settings.json` na primeira execução, e aponta para `openai-codex/*` (assinatura Codex do operador). As mãos são restritas pelo rail de dispatch à rota canônica `openai-codex/*`.

## Rota de modelos

O orquestrador usa Sol como padrão. O rail de dispatch exige: planner Sol/high; plan-reviewer Astra/high; adversary Sol/medium; security Sol padrão; compliance e test-author Terra/high; test-reviewer Luna/xhigh; shipper/harvester Luna/high. Executor e sniper são escolhidos pela complexidade da tarefa canônica: low Luna/high, medium Terra/medium, high Terra/xhigh. Modelo, esforço ou `complexity` divergentes são negados antes do subagente iniciar. O transporte usa limite de inatividade de 15 minutos por chamada de modelo; é finito para ainda expor conexão morta.
