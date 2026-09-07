# Pi Harness

Este pacote porta o harness para o Pi. Ele roda diretamente em uma worktree Git do produto; Orca pode abrir essa worktree, mas não é dependência da pipeline.

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
- `harness_tasks integrate` recebe `task_id`, `attempt_id` e `expected_head`, faz merge daquele SHA exato e grava o recibo global. O tip posterior da branch nunca substitui esse argumento.
- `harness_tasks resume` reabre a mesma tentativa e sessão pai local após comprovar que o processo anterior terminou. Feedback volta para a task que produziu a mudança; resultado e validação antigos deixam de liberar integração enquanto a correção está ativa. Para corrigir uma dependência compartilhada, os descendentes já admitidos precisam estar integrados; uma barreira pausa novos dispatches e outras integrações até o novo recibo da dependência.

Cada pai local executa a pipeline nativa completa da sua task: autoria de testes, fidelidade, freeze, executor, captura, revisões aplicáveis, sniper e re-gate. Ele não repete triagem, brainstorming, spec ou plano globais. Compliance, adversary e security de implementação podem rodar em paralelo, até o limite de três olhos incorporado pelo PR #902; mãos, fidelidade e revisão da spec mantêm exclusividade. O pai global integra os recibos e só então executa testes do conjunto, harvest, olhos finais no HEAD agregado e shipping. Uma correção integrada depois de seus consumers exige repetir esses gates agregados no novo HEAD.

## Rails

O launcher carrega as extensões numa ordem fixa (`core/pi/bin/pi-harness.mjs`). Hooks `tool_call` do Pi rodam na ordem de carga e o **primeiro `block` vence**, por isso `harness-policy` vem primeiro e a UI vem por último. Cada linha abaixo é uma negação real, com a mensagem idêntica à da lane OpenCode:

| Extensão | O que nega |
| --- | --- |
| `harness-policy` | Leitura ou comando sobre caminho com segredo (`.env*`, `.dev.vars`, `~/.ssh`, `~/.aws`), comando destrutivo e mutação direta de caminho do harness (`.pi`, `.codex`, `.agents`). Em LIGHT/FULL, o pai só pode observar/verificar/despachar; escrita, edição e commit ficam com a mão designada. Grava recibo de auditoria de bash/write/subagent. |
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

## Revisores em paralelo

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
atual e lista `accepted` e `missing`; após retomada, despache apenas os olhos aplicáveis
pendentes. Mudar o conteúdo invalida a evidência anterior. O plano torna security final
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

O orquestrador usa Sol como padrão. O rail de dispatch exige: planner Sol/high; plan-reviewer Astra/high; adversary Sol/medium; security Sol padrão; compliance e test-author Terra/high; shipper/harvester Luna/high. Executor e sniper são escolhidos pela complexidade da tarefa canônica: low Luna/high, medium Terra/medium, high Terra/xhigh. Modelo, esforço ou `complexity` divergentes são negados antes do subagente iniciar. O transporte usa limite de inatividade de 15 minutos por chamada de modelo; é finito para ainda expor conexão morta.
