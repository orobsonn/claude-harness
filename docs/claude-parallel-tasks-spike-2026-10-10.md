# Spike: `claude -p` como lane de task paralela (fase 0)

Data: 2026-10-10. Máquina: VPS Linux 6.8, 4 vCPU, 15 GiB RAM, Node v22.23.1, **Claude Code 2.1.296**, auth
OAuth (assinatura; `apiKeySource: "none"`). Modelo das provas: `haiku` (`claude-haiku-5-5`).

Ambiente: repo git de brinquedo em `mktemp -d` (fora deste repo), worktree `git worktree add -b
harness/task-a-1 <tmp>/wt-a HEAD`, `.claude/settings.json` do projeto registrando um hook `log.mjs` em
`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionStart` e `UserPromptSubmit`. O hook
grava payload + `cwd` + `CLAUDE_PROJECT_DIR` + `CLAUDE_HARNESS_TASK_RUN`. Um agente de projeto `echoer`
(`tools: Bash, Read`, `model: haiku`). Todas as rodadas removem do env as variáveis herdadas da sessão Claude
Code que lançou o spike (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`), como o worker fará.

Veredito: **a arquitetura do prompt se sustenta**, com quatro ajustes obrigatórios (§8).

## 1. Comando base da lane

```
env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 CLAUDE_HARNESS_TASK_RUN='{"cwd":…,"sessionId":…}' \
  claude -p --session-id <uuid> \
    --output-format stream-json --verbose \
    --model <model> --permission-mode acceptEdits \
    --allowedTools Bash,Read,Write,Edit,Agent,Glob,Grep \
    --tools Bash,Read,Write,Edit,Glob,Grep,Agent \
    --setting-sources project,local --strict-mcp-config \
    --append-system-prompt <task-runtime + envelope> \
    "<prompt>"   < /dev/null          # cwd = worktree
```

Rodada 2 (`stream2.jsonl`): exit 0 em 9 s, `system/init` com
`"tools":["Task","Bash","Edit","Glob","Grep","Read","Write"]`, `"mcp_servers":[]`, `"permissionMode":"acceptEdits"`.

## 2. Formato do stream-json (item 1)

Uma linha JSON por evento. Todas carregam `session_id`. Tipos observados:

| `type`/`subtype` | Campos relevantes |
|---|---|
| `system/hook_started`, `system/hook_response` | `hook_event`, `hook_name`, `exit_code`, `outcome` (os hooks aparecem no stream) |
| `system/init` | `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`, `agents`, `apiKeySource`, `claude_code_version` |
| `assistant` | `message.content[]` com `{type:"tool_use", id, name, input}`; `parent_tool_use_id` = id do `Agent` quando o evento é do subagente, `null` no main loop |
| `user` | `message.content[]` com `{type:"tool_result", tool_use_id, is_error, content}` + `tool_use_result` (objeto estruturado da tool); mensagens de subagente trazem `agent_id`, `subagent_type`, `parent_tool_use_id` |
| `system/task_started` | `task_id` (= `agent_id`), `tool_use_id`, `subagent_type`, `is_backgrounded`, `prompt` |
| `system/task_notification` | `task_id`, `tool_use_id`, `status` (`completed`), `usage{total_tokens,tool_uses,duration_ms}` |
| `result` | `subtype` (`success`/erro), `is_error`, `num_turns`, `usage`, `total_cost_usd`, `modelUsage`, `permission_denials`, `subagent_stats`, `result` |

`tool_use` do `Agent` no main loop (rodada 2):
```json
{"type":"tool_use","name":"Agent","id":"toolu_…","input":{"description":"Get git HEAD hash","prompt":"Run: git rev-parse HEAD","subagent_type":"echoer","model":"haiku"}}
```
`tool_use_result` correspondente (foreground):
```json
{"status":"completed","prompt":"Run: git rev-parse HEAD","agentId":"ac1afc2ab7637c1e7","agentType":"echoer",
 "content":[{"type":"text","text":"87d7d9bb…"}],"resolvedModel":"claude-haiku-5-5","totalDurationMs":2519,"totalTokens":4301,"totalToolUseCount":1,…}
```
O `tool_use` do Bash **dentro** do subagente aparece no stream com `parent_tool_use_id` = id do `Agent`. Ou seja,
o stream expõe o trabalho do subagente.

**Achado 1 (crítico): `Agent` é assíncrono por padrão nesta versão.** Rodada 1, sem `run_in_background` no input:
`task_started.is_backgrounded: true`, e o `tool_result` volta na hora com
`{"isAsync":true,"status":"async_launched","agentId":…}`. O resultado chega depois, via `task_notification`, e
o main loop ganha um **segundo turno** (segundo `system/init` e segundo `result` no mesmo processo). O processo
só sai depois que o agente async termina. Com `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (rodada 2):
`is_backgrounded: false`, o `tool_result` carrega o relatório final com `status:"completed"` e há um único turno. Na
rodada 3, pedi `run_in_background true` explicitamente e o modelo respondeu "the Agent tool has no such
parameter": o campo some do schema. **Decisão:** o worker exporta `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, e o
hook da lane continua negando `run_in_background` como defesa em profundidade.

## 3. Sessão (item 2)

- `--session-id <uuid>` é honrado: o `session_id` de todos os eventos é igual ao uuid passado (rodada 1).
- `--resume <uuid>` com cwd = worktree retoma a mesma sessão com memória (rodada 3: "Last time I reported
  `87d7…`"). O stream do resume tem um único `session_id`, igual ao original.
- `--session-id` de uma sessão existente: `Error: Session ID … is already in use.`, exit 1 (rodada 5b).
- **Achado 2:** `--resume <uuid>` com cwd = **outra** pasta (repo principal) também funciona (exit 0, mesmo
  `session_id`), e a sessão retomada passa a rodar naquela cwd. **Decisão:** o launcher sempre fixa
  `cwd = realpath(worktree)`, e a inspeção exige `system/init.cwd === worktree` em todo launch.

## 4. Hooks na worktree (item 3)

Hooks de `<worktree>/.claude/settings.json` disparam em `claude -p` com cwd = worktree, inclusive com
`--setting-sources project,local`. Em todos os eventos, `CLAUDE_PROJECT_DIR` = worktree e `process.cwd()` = worktree.

Payloads (chaves observadas):
- `PreToolUse`: `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name,
  tool_input, tool_use_id`; dentro de subagente, **também** `agent_id, agent_type`.
- `PostToolUse`: o acima + `tool_response, duration_ms`. Bash: `tool_response = {stdout, stderr, interrupted,
  isImage, noOutputExpected}` (**sem exit code**). Agent: `tool_response` = o mesmo objeto do `tool_use_result`
  acima (`status, agentId, agentType, content, resolvedModel…`).
- `SubagentStart`: `session_id, agent_id, agent_type`.
- `SubagentStop`: `session_id, agent_id, agent_type, stop_hook_active, agent_transcript_path,
  last_assistant_message, background_tasks`.
- `Stop`: `session_id, stop_hook_active, last_assistant_message, background_tasks`.

`decision:"block"` (rodada 4):
- `SubagentStop` com `{"decision":"block","reason":"… run: echo sub-continued"}` faz o subagente continuar e
  rodar `echo sub-continued`. O segundo `SubagentStop` vem com `stop_hook_active:true`.
- `Stop` com `{"decision":"block","reason":"… run … echo continued-after-stop-block"}` faz o main loop rodar o
  comando. O segundo `Stop` vem com `stop_hook_active:true`. `num_turns` passou de 2 para 4.
- `PreToolUse` com `hookSpecificOutput.permissionDecision:"deny"` (rodada 1, `echo DENYME`) gera um
  `tool_result` `is_error:true` com o texto `PreToolUse:Bash hook error: spike deny`, e o modelo não reexecuta.

**Achado 3:** o `PostToolUse` de Bash não traz exit code, porque só dispara em sucesso. Um Bash com exit ≠ 0
(rodada 11, `ls /definitely-missing-dir; exit 3`) dispara **`PostToolUseFailure`**, com
`error: "Exit code 3\nls: cannot access …"`, `is_interrupt` e `duration_ms`. Também gera um `tool_result`
`is_error:true` com o mesmo texto no stream. **Decisão:** o ledger grava `head_before` no PreToolUse e
`head_after` + `status` no PostToolUse (`ok`, exit 0) e no PostToolUseFailure (`error`, exit extraído do prefixo
`Exit code N` que o Claude Code gera; `null` se ausente). O commit de freeze é identificado só por
`head_before`/`head_after`, nunca pelo stdout.

## 5. Env do worker (item 4)

`CLAUDE_HARNESS_TASK_RUN='{"cwd":"x","sessionId":"y"}'` definido no processo `claude -p` chegou intacto a todos os
hooks, inclusive aos disparados dentro do subagente (campo `TR` de `hooks1.log`/`hooks2.log`).

## 6. Permissões headless (item 5)

- `--permission-mode acceptEdits --allowedTools Bash,Read,Write,Edit,Agent,Glob,Grep` roda sem prompt. Bash,
  Write e Agent foram executados sem pedir aprovação.
- **Não houve trust dialog** em `-p` numa worktree nunca aberta antes, usando o `CLAUDE_CONFIG_DIR` padrão
  (`~/.claude`). `~/.claude.json` não ganhou entrada de projeto. O problema do `kaizen.md` é específico do
  `CLAUDE_CONFIG_DIR` efêmero do `spawn-hand`. A lane usa a config padrão do operador, porque precisa do OAuth
  dele, e por isso não cai nesse caso.
- `--setting-sources project,local` desliga os settings do usuário (`defaultMode: auto` e os hooks do Orca do
  `~/.claude/settings.json` não rodaram na lane), mas **mantém** o OAuth. `--strict-mcp-config` zera os MCP do
  claude.ai, que na rodada 1 vazavam para a lane (ClickUp, Drive, Zoom…). `--tools` reduz as tools built-in (na
  rodada 1 a lane tinha `CronCreate`, `ScheduleWakeup`, `Workflow`, `EnterWorktree`, `RemoteTrigger`…).
- **Decisão:** usar a combinação do §1. Os hooks da lane continuam sendo a política (o allowlist só evita o prompt).

## 7. Processo (item 6)

| Caso | Observado |
|---|---|
| sucesso | sai sozinho, exit 0 (todas as rodadas) |
| modelo inválido | exit 1, `result` com `stop_reason:"stop_sequence"`, stderr `[claude-code:unrecognized_model]` |
| session id em uso | exit 1, `Error: Session ID … is already in use.` |
| sem prompt e stdin vazio | exit 1, `Error: Input must be provided…` |
| stdin herdado sem dados | `Warning: no stdin data received in 3s` e segue. **Decisão:** stdin = `ignore` |
| SIGTERM no pid do `claude` | exit **143** (`code=143, signal=null`) em ~1–5 s. O `sleep 77` do Bash tool foi encerrado pelo próprio claude. Nenhum órfão |
| SIGTERM no grupo (`kill -PGID`) | igual: exit 143, nenhum órfão |
| **SIGKILL** no pid | `signal=SIGKILL`, e o `sleep 77` **sobreviveu** como órfão |

**Achado 4 (processo):** o Bash tool roda em **sessão e process group próprios**. Exemplo:
`sleep 77` com `pgid=sid=1538232` e pai `1538225`, enquanto o `claude` tinha `pgid=1538070`. Por isso, matar o
grupo do `claude` não alcança os filhos das tools, e um SIGKILL deixa órfão. **Decisão:** o supervisor (1) manda
SIGTERM ao grupo do filho e espera um grace (o `claude` limpa as próprias tools); (2) enquanto o filho vive,
rastreia **descendentes** por varredura de `/proc/*/stat` (cadeia de ppid), registrando pid + start ticks; (3) após
o grace, envia SIGKILL ao grupo e a cada descendente rastreado cuja identidade (pid + start ticks) ainda confira;
(4) considera o job vivo enquanto qualquer descendente rastreado viver, o equivalente ao "netos mantêm
`running`" do Pi.

Três lanes simultâneas (rodada 6, cada uma com um subagente rodando `sleep 25`):
- parede total de 34 s;
- `/usr/bin/time -v` por lane: Maximum RSS de **269 652 / 268 300 / 265 624 KB**, 10% de CPU, ~32 s;
- pico da soma de RSS dos três `claude -p` amostrado com `ps`: **800 944 KB (~0,8 GB)**;
- custo: US$ 0,0011, 0,0026 e 0,0026 (haiku).

Com 15 GiB de RAM, 3 lanes não pesam. O gargalo real é o rate limit da conta: o stream traz `rate_limit_event`
com `rateLimitType:"five_hour"`.

## 8. Ajustes à arquitetura do prompt

1. **Foreground forçado por env.** O worker define `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` na lane. Sem isso o
   `Agent` é async e a ordem TDD fica não determinística. O hook da lane nega `run_in_background` e também nega
   qualquer `tool_response` com `isAsync:true`, registrando no ledger como `async_rejected`.
2. **Isolamento da lane.** `--setting-sources project,local --strict-mcp-config --tools …` mais o allowlist do §1.
   O env da lane recebe só a allowlist (PATH, HOME, LANG, TERM, TMPDIR, USER, SHELL, `CLAUDE_CONFIG_DIR` se
   definido, as próprias vars do harness).
3. **cwd verificado.** A inspeção exige `system/init.cwd === realpath(worktree)` e um único `session_id` em todos
   os launches.
4. **Kill e liveness por descendentes**, como no §7.

Nenhum item inviabiliza a arquitetura: o stream expõe `tool_use` de subagente com `subagent_type`, `prompt` e
`model`, e o resultado vem com status.

## 9. Artefatos

Os streams e logs brutos ficaram fora do repo, em `~/claude-parallel-port-spike/` (`stream{1..4}.jsonl`,
`hooks{1..4}.log`, `sp{1,2,3}.jsonl`, `timep{1,2,3}.txt`, `sigterm.mjs`). Os fixtures dos testes da lane e do
`claude` falso usam esses formatos com caminhos sanitizados.
