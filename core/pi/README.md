# Pi Harness

Este pacote porta o harness para o Pi. O Orca continua dono da issue, da worktree e do terminal; o Pi executa o fluxo dentro daquela worktree.

## Pré-flight

Na worktree onde o harness foi instalado, rode:

```sh
pi-harness --verify
```

O resultado precisa incluir `"ok":true`, `"runtimeVersion":"0.84.4"` e `"subagentsVersion":"21.2.0"`. Ele não chama modelo nem lê a configuração Pi normal do operador.

## Uso no Orca

Crie ou selecione a worktree da issue no Orca. Depois abra um terminal nela:

```sh
orca terminal create --worktree issue:<numero> --title pi-harness --command "pi-harness --mode json -p 'Execute a issue #<numero> como uma run FULL do harness. A issue é a spec.'"
```

Na primeira execução, autentique o Pi no diretório de runtime do harness com `/login`, ou disponibilize o provedor por variável de ambiente. O launcher não reutiliza a configuração global para evitar que extensões, skills e agentes pessoais alterem a run.

## Progresso do plano

Em uma run FULL, depois da aprovação explícita do plano pelo operador, o Pi registra as tarefas em `harness_plan`. O TUI mostra `Plano 2/5 · atual: Implementar`; tarefas que declaram validação própria adicionam uma segunda linha, por exemplo `Validação 1/2 · atual: Teste de regressão`. O mesmo snapshot aparece no resultado da ferramenta em JSON/headless. O estado acompanha a ramificação atual da sessão; é informativo, não é aprovação, scheduler nem prova de conclusão do código.

## Rails

O launcher carrega as extensões numa ordem fixa (`core/pi/bin/pi-harness.mjs`). Hooks `tool_call` do Pi rodam na ordem de carga e o **primeiro `block` vence**, por isso `harness-policy` vem primeiro e a UI vem por último. Cada linha abaixo é uma negação real, com a mensagem idêntica à da lane OpenCode:

| Extensão | O que nega |
| --- | --- |
| `harness-policy` | Leitura ou comando sobre caminho com segredo (`.env*`, `.dev.vars`, `~/.ssh`, `~/.aws`), comando destrutivo e mutação direta de caminho do harness (`.pi`, `.codex`, `.agents`). Grava recibo de auditoria de bash/write/subagent. |
| `harness-dispatch` | Delegação para role não canônica, role sombreada por `.pi/agents/` do projeto, `run_in_background`, ou acima do limite de turnos. |
| `harness-entry-gate` | Rails de bash de entrega (branch errada, zero commits, re-gate pendente, captura não verificada, `gh pr merge` sem evidência de CI, `harness:ready` sem pipeline fechado) e rails de despacho (cerimônia, fidelidade, re-gate). Reivindica o dispatch-record exato da mão que escreve e liga a sessão filha ao papel despachado. |
| `harness-plan-gate` | Despacho de plan-reviewer/test-author/executor/sniper sem plano estável válido, e args de dispatch que divergem do marcador `HARNESS_TASK_CONTEXT` do brief. |
| `harness-plan-write-gate` | Escrita de `gate-state.json`/`triage.json`, de qualquer JSON sob `.pi/harness/state/`, dos scripts marcadores e do tooling congelado; escrita do plano canônico por quem não é `harness-planner` em despacho; escrita fora do `scope_paths` da tarefa; e mutação literal do estado/plano por Bash. |
| `harness-marker` | Carimbo de marcador sem autorização, clonado, com replay ou com identidade divergente do dispatch-record. |
| `harness-classify` | `classify` chamado de dentro de uma sessão filha. |
| `harness-lavish-gate` | `lavish-axi share` (publica o mockup num host de terceiros) e `lavish-axi setup hooks` (instala hook que compete com o do harness). |
| `harness-run-hand` | `run_hand` sem gate-state satisfeito, e rota de modelo fora de `openai-codex/*`. |

Nunca bloqueiam, só observam ou injetam contexto: `harness-obs`, `harness-idle-nudge`, `harness-reinject-state`, `harness-version-check`, `harness-context-files` (reintroduz `AGENTS.md`/`CLAUDE.md` do projeto, já que o launcher desliga a descoberta nativa) e `harness-plan-tracker` (UI).

Autoridade do plano canônico: no OpenCode ela vem do SDK (`session.agent === 'planner'`). O `SessionHeader` do Pi não carrega o nome do agente, então a lane grava a identidade da filha em `.pi/harness/state/<pai>/child-identity/` no evento `subagents:child:session-created` do pi-subagents, e o gate lê dali. Com mais de um despacho em voo a ligação seria ambígua e nada é gravado — o rail fica desarmado em vez de chutar.

## Limites

`harness-*` preserva os papéis do harness. O gate permite somente uma delegação foreground por vez e não aceita role do projeto com o mesmo nome. Isso é controle de workflow; a worktree Orca é a separação de trabalho. Pi roda com as permissões do usuário que o iniciou: **não é sandbox de sistema**, não isola processo, rede nem credenciais, e não substitui a política de acesso do Orca. Os rails são determinísticos e best-effort sobre nome de ferramenta e caminho: comando ofuscado e caminho construído em runtime estão fora do alcance deles.

## Modelo

O launcher não injeta provedor nem `--model`. O default vem de `core/pi/runtime/settings.json`, materializado em `.pi/harness/runtime/settings.json` na primeira execução, e aponta para `openai-codex/*` (assinatura Codex do operador). As mãos despachadas por `run_hand` também são restritas a `openai-codex/*`.
