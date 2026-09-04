# Pi Harness

Este pacote porta o harness para o Pi. O Orca continua dono da issue, da worktree e do terminal; o Pi executa o fluxo dentro daquela worktree.

## Pré-flight

Na worktree onde o harness foi instalado, rode:

```sh
node .pi/harness/pi-harness.mjs --verify
```

O resultado precisa incluir `"ok":true`, `"runtimeVersion":"0.84.4"` e `"subagentsVersion":"21.2.0"`. Ele não chama modelo, lê credenciais, instala ou corrige dependências. Cache ausente ou alterado é um erro: execute o init/update do harness nesse host antes de iniciar a run.

O init/update que inclui Pi prepara primeiro o runtime fixado em um cache do usuário (`~/.cache/claude-harness/pi-runtime`, ou sob `XDG_CACHE_HOME` absoluto). Worktrees no mesmo host reutilizam a mesma geração; plataformas e versões incompatíveis usam gerações distintas. O launcher não usa nem modifica o Pi global ou `node_modules` do produto. Uma falha de provisionamento impede a atualização dos arquivos do harness. O pacote nativo Pi mantém suas dependências próprias para preservar `pi install`; isso pode duplicar downloads no instalador npx, mas não muda o runtime isolado usado pelo launcher.

## Uso no Orca

Crie ou selecione a worktree da issue no Orca. Depois abra um terminal nela:

```sh
node .pi/harness/pi-harness.mjs "Implemente a issue #<numero> de forma autônoma, seguindo a pipeline padrão de entrega até abrir um PR draft."
```

O comando acima abre o TUI; para headless, acrescente `--mode json -p` antes do pedido. A issue é a entrada de produto, não um atalho que dispensa spec e revisão adversarial.

Cada execução operacional iniciada pelo launcher recebe uma sessão nova e mantém um lock único da worktree até o Pi terminar. Assim, outro pai — fresh ou retomado — não sobrepõe a mesma implementação. Se o launcher for morto à força, o lock fica fechado para inspeção manual: o processo Pi pode ter sobrevivido, então PID morto ou tempo decorrido não autorizam apagar o owner. Para reabrir exatamente uma sessão existente, use `node .pi/harness/pi-harness.mjs --harness-resume <session-id> "Continue o plano."`; se o arquivo exato ou o preflight não conferir, nenhuma sessão substituta é criada.

Os seletores nativos de sessão (`--continue`, `-c`, `--resume`, `-r`, `--session`, `--session-id`, `--session-dir`, `--fork` e `--no-session`) são recusados pelo launcher. Texto após `--` continua sendo prompt. Help, versão, export e comandos administrativos não abrem sessão nem disputam o lock. Essas garantias pertencem ao launcher vendorizado; executar o binário `pi` diretamente não passa por esse controle.

O login segue a mesma regra do OpenCode: é **um por ambiente**, nunca por worktree. O launcher preserva roles, settings, extensões e sessões do harness na worktree, mas usa somente a credencial Pi do perfil do usuário do host (`~/.pi/agent/auth.json`).

Para um motor headless/VPS, execute uma vez como o usuário de serviço, abra o Pi e use `/login` → ChatGPT Plus/Pro → **Device code login**. O código é aprovado no seu navegador e a credencial fica apenas no perfil persistente daquele host; todas as worktrees futuras a reutilizam. Em CI sem perfil persistente, use o secret manager para injetar uma credencial de API — não um `auth.json` no repositório.

## Grill e Lavish (descoberta local)

Numa sessão local/interativa fora da cerimônia, peça "faz o grill desta ideia" ou use a skill `harness-grill`. Ela produz o PRD em `docs/prd/` e usa o Lavish somente quando você pede um mockup. Lavish é uma referência privada da entrevista, não outra skill nem uma publicação externa. O olho `harness-discussion-adversary` revisa a proposta sem iniciar delivery ou gerar aprovação da pipeline. Os dez papéis de entrega permanecem separados desse olho de discussão.

Grill não entrevista em headless, não implementa produto e não transforma hipóteses em respostas suas. A referência está em `skills/harness-grill/references/lavish-usage.md` no harness vendorizado; `share` e `setup hooks` continuam proibidos.

## Progresso do plano

Em uma run FULL, depois da aprovação do plan-reviewer e dentro do escopo autorizado, o Pi registra as tarefas em `harness_plan`. Um pedido explícito de implementação autônoma/headless não exige confirmação humana adicional para esse registro. O TUI mostra `Plano 2/5 · atual: Implementar`; tarefas que declaram validação própria adicionam uma segunda linha, por exemplo `Validação 1/2 · atual: Teste de regressão`. O mesmo snapshot aparece no resultado da ferramenta em JSON/headless. O estado acompanha a ramificação atual da sessão; é informativo, não é aprovação, scheduler nem prova de conclusão do código.

## Rails

O launcher carrega as extensões numa ordem fixa (`core/pi/bin/pi-harness.mjs`). Hooks `tool_call` do Pi rodam na ordem de carga e o **primeiro `block` vence**, por isso `harness-policy` vem primeiro e a UI vem por último. Cada linha abaixo é uma negação real, com a mensagem idêntica à da lane OpenCode:

| Extensão | O que nega |
| --- | --- |
| `harness-policy` | Leitura ou comando sobre caminho com segredo (`.env*`, `.dev.vars`, `~/.ssh`, `~/.aws`), comando destrutivo e mutação direta de caminho do harness (`.pi`, `.codex`, `.agents`). Em LIGHT/FULL, o pai só pode observar/verificar/despachar; escrita, edição e commit ficam com a mão designada. Grava recibo de auditoria de bash/write/subagent. |
| `harness-dispatch` | Delegação para role não canônica, role sombreada por `.pi/agents/` do projeto, `run_in_background`, ou acima do limite de turnos. |
| `harness-entry-gate` | Rails de bash de entrega (branch errada, zero commits, re-gate pendente, captura não verificada, `gh pr merge` sem evidência de CI, `harness:ready` sem pipeline fechado) e rails de despacho (cerimônia, fidelidade, re-gate). Reivindica o dispatch-record exato da mão que escreve e liga a sessão filha ao papel despachado. |
| `harness-plan-gate` | Despacho de plan-reviewer/test-author/executor/sniper sem plano estável válido, e args de dispatch que divergem do marcador `HARNESS_TASK_CONTEXT` do brief. |
| `harness-plan-write-gate` | Escrita de `gate-state.json`/`triage.json`, de qualquer JSON sob `.pi/harness/state/`, dos scripts marcadores e do tooling congelado; escrita do plano canônico por quem não é `harness-planner` em despacho; escrita fora do `scope_paths` da tarefa; e mutação literal do estado/plano por Bash. |
| `harness-marker` | Carimbo de marcador sem autorização, clonado, com replay ou com identidade divergente do dispatch-record. O `final-review` exige captura válida para cada tarefa do plano canônico atual. |
| `harness-classify` | `classify` chamado de dentro de uma sessão filha. |
| `harness-lavish-gate` | `lavish-axi share` (publica o mockup num host de terceiros) e `lavish-axi setup hooks` (instala hook que compete com o do harness). |

`run_hand` está propositalmente desabilitado: ele iniciava outro processo sem a identidade in-process que liga uma filha ao dispatch atual. A cerimônia usa somente o `subagent` nativo, cuja identidade é capturada no evento de criação da sessão filha.

Nunca bloqueiam, só observam ou injetam contexto: `harness-obs`, `harness-idle-nudge`, `harness-reinject-state`, `harness-version-check`, `harness-context-files` (reintroduz `AGENTS.md`/`CLAUDE.md` do projeto, já que o launcher desliga a descoberta nativa) e `harness-plan-tracker` (UI).

Autoridade do plano canônico: no OpenCode ela vem do SDK (`session.agent === 'planner'`). O `SessionHeader` do Pi não carrega o nome do agente, então a lane grava a identidade da filha em `.pi/harness/state/<pai>/child-identity/` no evento `subagents:child:session-created` do pi-subagents, e o gate lê dali. Com mais de um despacho em voo a ligação seria ambígua e nada é gravado — o rail fica desarmado em vez de chutar.

## Limites

`harness-*` preserva os papéis do harness. O gate permite somente uma delegação foreground por vez e não aceita role do projeto com o mesmo nome. Isso é controle de workflow; a worktree Orca é a separação de trabalho. Pi roda com as permissões do usuário que o iniciou: **não é sandbox de sistema**, não isola processo, rede nem credenciais, e não substitui a política de acesso do Orca. Os rails são determinísticos e best-effort sobre nome de ferramenta e caminho: comando ofuscado e caminho construído em runtime estão fora do alcance deles.

## Modelo

O launcher não injeta provedor nem `--model`. O default vem de `core/pi/runtime/settings.json`, materializado em `.pi/harness/runtime/settings.json` na primeira execução, e aponta para `openai-codex/*` (assinatura Codex do operador). As mãos são restritas pelo rail de dispatch à rota canônica `openai-codex/*`.

## Rota de modelos

O orquestrador usa Sol como padrão. O rail de dispatch exige: planner Sol/high; plan-reviewer Astra/high; adversary Sol/medium; security Sol padrão; compliance e test-author Terra/high; shipper/harvester Luna/high. Executor e sniper são escolhidos pela complexidade da tarefa canônica: low Luna/high, medium Terra/medium, high Terra/xhigh. Modelo, esforço ou `complexity` divergentes são negados antes do subagente iniciar. O transporte usa limite de inatividade de 15 minutos por chamada de modelo; é finito para ainda expor conexão morta.
