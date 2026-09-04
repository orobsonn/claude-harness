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
Se o launcher morrer à força, o lock órfão fica fail-closed para inspeção
manual: o Pi filho pode continuar vivo, então PID morto ou timeout não provam
que é seguro iniciar outro pai. Inspecione
`.pi/harness/state/parent-orchestrator.lock` e só o remova depois de confirmar
que nenhum Pi daquela worktree continua ativo.
Para retomar, informe somente a sessão exata:

```sh
node .pi/harness/pi-harness.mjs --harness-resume <session-id> "Continue o plano."
```

Se o arquivo ou o preflight não conferirem, o launcher não cria substituta.
Os seletores nativos de sessão do Pi são recusados pelo launcher; texto depois
de `--` é apenas prompt. Executar `pi` diretamente não recebe esse contrato.

## Papéis e modelo

O fluxo separa os dez papéis de entrega (`planner`, revisão de plano,
adversarial, segurança, compliance, harvester, autor de testes, executor,
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
