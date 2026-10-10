# Prompt: port da execução paralela em worktrees filhas (Pi → Claude Code)

Você vai implementar, no harness do Claude Code deste repositório (`core/claude-code/`), a execução paralela de
tasks em worktrees git filhas que o harness Pi já tem (`core/pi/`). Você roda numa VPS, sem operador olhando em
tempo real. Trabalhe de forma autônoma, em fases, provando cada fase com testes antes de seguir.

## 0. Regras inegociáveis

1. Leia e obedeça `AGENTS.md`. Em especial:
   - **nunca** inicialize, vendorize ou atualize o harness na raiz deste repositório;
   - **nunca** crie nem commite `/.claude/`, `/.codex/`, `/.opencode/` ou `/.pi/` na raiz;
   - para validar vendor e execução real, use diretórios temporários **fora** do repo (`mktemp -d`) ou os fixtures dos testes;
   - altere sempre a fonte em `core/` junto com os testes correspondentes.
2. **Git:**
   - trabalhe no branch `feat/claude-parallel-tasks`, criado a partir de `origin/main` atualizado;
   - use conventional commits em inglês (`feat(claude-code): …`, `test(claude-code): …`, `refactor(shared): …`), um ou mais commits por fase;
   - **nunca** faça push para `main`, merge, tag, release ou `npm publish`;
   - abra **um PR draft** contra `main` assim que a fase 1 estiver verde e vá atualizando o mesmo PR.
3. **Não quebre o Pi nem o OpenCode.** Se extrair código do Pi para `core/shared/lib/`, o Pi passa a importar dali
   sem nenhuma mudança de comportamento. A suíte inteira (`npm test`) precisa continuar verde.
4. **Host é a autoridade.** Nenhum texto do modelo aprova nada. Status, recibos e integração são derivados
   pelo host a partir de Git, arquivos de job e ledgers gravados por hooks. Em dúvida, falhe fechado com
   mensagem acionável.
5. Comunicação final com o operador: curta, em pt-BR, orientada a resultado.
6. Não invente capacidade do Claude Code. Tudo que depende do comportamento real do `claude` CLI precisa ser
   provado no spike da fase 0 e registrado com o comando e a saída observada.

## 1. Leitura obrigatória antes de codar

1. `docs/pi-parallel-worktrees-port-map-2026-10-10.md`, inteiro. É a especificação.
   - As seções 1 a 12 descrevem o Pi.
   - A 13 descreve o gap no Claude Code.
   - A 14 traz o plano de port.
   - A 15 traz o delta da v3.7.5.
   - Os números de linha do mapa são aproximados: localize sempre pelo nome da função.
2. Pi, lendo a fonte de verdade e não só o mapa:
   - `core/pi/lib/task-coordinator.mjs`, `task-process.mjs`, `task-contract.mjs`, `task-context.mjs`,
     `task-receipts.mjs`, `task-reconciliation.mjs`, `task-run.mjs`, `task-orca.mjs`, `task-runtime-assets.mjs`;
   - `core/pi/bin/pi-task-worker.mjs`, `core/pi/extensions/harness-tasks.ts`, `harness-task-run.ts`;
   - `core/pi/prompts/harness-task-runtime.md`, `core/pi/skills/harness-task-pipeline/SKILL.md`;
   - os `*.test.mjs` correspondentes, que são o catálogo de invariantes a portar.
3. Claude Code:
   - `core/claude-code/skills/orchestrating-delivery/SKILL.md` e `references/`, especialmente `spawn-hand.mjs`,
     `capture-hand.mjs`, `descriptor-emitter.mjs` e `hand-config/`;
   - `core/claude-code/hooks/` (`entry-gate.mjs`, `mark.mjs`, `stamp-triage.mjs`, `plan-write-gate.mjs`,
     `reinject-state.mjs`, `lib/gate-lib.mjs`);
   - `core/claude-code/settings.json`, `core/claude-code/agents/*.md`;
   - `core/claude-code/skills/creating-plans/` (formato do plano e `validate-plan.mjs`);
   - `core/claude-code/skills/initializing-projects/references/vendor-core.mjs` (`vendorClaude`,
     `FRESH_NATIVE_PATHS`, `scanVendoredImports`).
4. `core/shared/lib/validate-plan.mjs`, para a checagem de overlap de escopo e frozen paths.

Registre um log de progresso fora do repo, em `~/claude-parallel-port-progress.md`, contendo:
- fase atual;
- decisões tomadas e o motivo de cada uma;
- comandos de verificação e os resultados;
- pendências.

Atualize o log ao fim de cada fase. Se a sessão for compactada ou reiniciada, releia esse arquivo e o PR antes de
continuar.

## 2. Arquitetura alvo

```
PAI GLOBAL: sessão Claude Code normal na worktree principal, com plano aprovado
  node .claude/hooks/tasks.mjs dispatch|status|wait|integrate|resume|abandon-resume --json '<params>'
     (CLI host chamado via Bash; stdout JSON; identidade = session_id/cwd do host, nunca dos params)
     dispatch → grant imutável + git worktree add -b harness/task-<id>-<attempt> <wt> <base_sha>
              → semeia na worktree: plano/spec, gate-state com task_run, node_modules (cópia) e runtime verificado
              → worker detached → launcher da lane
  LANE ("pai local"): `claude -p` TOP-LEVEL com cwd = worktree, sessão nova (--session-id <uuid>),
     --append-system-prompt <task-runtime.md + [HARNESS_TASK_RUN]{contract}>,
     --output-format stream-json --verbose (stdout → events.jsonl, gravado pelo worker),
     env CLAUDE_HARNESS_TASK_RUN={cwd,sessionId}
     hooks da lane (PreToolUse) aplicam a policy da task a cada tool call, revalidando o binding
     ledger host-owned (Pre/PostToolUse, SubagentStop): agentes despachados, Bash com HEAD antes e depois, status
  wait → bloqueia no host (sem chamar o modelo) até alguma task mudar ou estourar a janela (< timeout do Bash)
  status → inspeção host-owned (Git + events + ledger + gate-state da lane) → ready | blocked
  integrate → re-inspeciona, merge-tree, frozen blobs, journal, git merge --no-ff, recibo
```

Decisões já tomadas (só mude com evidência do spike, registrando o motivo no log e no PR):

- **Superfície do pai global.** CLI `tasks.mjs` invocado via Bash, no mesmo padrão de `mark.mjs`/`stamp-triage`.
  Não usar MCP.
- **Natureza da lane.** A lane é sessão top-level (`claude -p`), **não** subagente. Motivo: `entry-gate.mjs` libera
  qualquer chamada com `agent_id`, e os gates só valem no main loop.
- **Estado.** O estado do pai fica em `.claude/plans/.state/<parentSession>/task-runs/` (gitignored). As worktrees
  ficam em `.../task-runs/worktrees/task-<N>-<slug>/`, com o nome gerado por `taskWorktreeName` do Pi. O branch é
  `harness/task-<id>-<attempt>`.
- **Limites.** `MAX_PARALLEL_TASKS = 3`; um env do host pode reduzir esse valor, nunca aumentar. Timeout de job
  configurável no host, padrão 2h e máximo 24h. Lote de dispatch atômico. Sem scheduler automático.
- **Integração.** Sempre `git merge --no-ff` feito pelo host, com journal `integration_intent`. Nunca fast-forward
  e nunca cherry-pick. Nenhuma limpeza automática de worktrees, branches ou jobs.
- **Papéis na lane.** Mapeie os papéis do Pi para os agentes do Claude Code:

  | Pi | Claude Code |
  |---|---|
  | test-author | `test-author` |
  | test-reviewer (fidelidade) | `compliance` em modo fidelidade, como na SKILL atual (passo 1b) |
  | executor | `executor` ou `executor-high` |
  | sniper | `sniper` ou `sniper-high` |
  | olhos | `compliance`, `adversary`, `security` |

  A rota de modelo vem do contrato e é validada pelo hook contra o parâmetro `model` do `Agent`.
- **Restrições da lane, aplicadas por código.** A lane não pode:
  - classificar, escrever spec ou plano, nem chamar `tasks.mjs`;
  - fazer push, pull, merge, rebase ou tag (exceção única: `git merge-base` literal isolado);
  - usar `git commit --amend` ou `gh pr/release/issue create|merge|edit|close`;
  - fazer deploy;
  - fazer harvest, revisão final ou shipper;
  - usar `Agent` com `run_in_background`;
  - despachar agente fora dos papéis da task ou sem o marcador `[HARNESS_TASK_CONTEXT]{"task_id":"<a dela>"}`.

## 3. Fases

Em cada fase, escreva os testes primeiro e confira que falham pelo motivo certo. Depois implemente, rode a suíte
inteira e faça o commit. Não avance com teste vermelho, `skip` injustificado ou `todo`.

### Fase 0: spike empírico do `claude` CLI (sem tocar em `core/`)

Num diretório temporário fora do repo (`mktemp -d`), com um repo git de brinquedo, prove e registre em
`docs/claude-parallel-tasks-spike-<data>.md` (commitado nesta branch):

1. `claude -p --output-format stream-json --verbose`:
   - o formato real dos eventos: `system/init` com `session_id`, `assistant` com blocos `tool_use`, `user` com
     `tool_result`, e `result`;
   - se o `tool_use` de `Agent`/Task traz `subagent_type`, `prompt`, `model` e `run_in_background`;
   - se o resultado do subagente aparece com status.
2. `--session-id <uuid>` cria sessão com esse id, e `--resume <uuid>` retoma na **mesma** worktree.
3. Hooks do projeto (`.claude/settings.json` da worktree):
   - disparam em `claude -p` com cwd = worktree;
   - `CLAUDE_PROJECT_DIR` aponta para a worktree;
   - o payload de PreToolUse/PostToolUse traz `session_id`, `tool_name`, `tool_input` e, dentro de subagentes,
     `agent_id`/`agent_type`;
   - `SubagentStop` e `Stop` existem e aceitam `decision:"block"`.
4. Uma env var definida pelo worker (`CLAUDE_HARNESS_TASK_RUN`) chega ao processo dos hooks.
5. Permissões headless: qual combinação de `--permission-mode`/`--allowedTools`/`--settings` deixa a lane
   trabalhar sem prompt interativo e sem abrir mão dos hooks. Use como precedente `spawn-hand.mjs` e o problema
   de trust dialog em worktree descrito em `core/claude-code/kaizen.md`.
6. Processo:
   - o `claude -p` sai sozinho ao terminar;
   - exit code em sucesso e em erro;
   - comportamento sob SIGTERM;
   - três instâncias simultâneas na VPS: meça RAM e CPU com `/usr/bin/time -v` ou `ps`.

Se algum item inviabilizar a arquitetura (por exemplo, o stream-json não expõe subagentes), **pare**. Registre a
evidência no spike, proponha a alternativa (como um ledger só por hooks) no PR e encerre com um relatório ao
operador. Não improvise uma arquitetura diferente sem registrar a decisão.

### Fase 1: núcleo compartilhado (refactor sem mudança de comportamento)

- Mova ou extraia para `core/shared/lib/` o que é Node puro e independente de host:
  - de `task-contract` (`stableTaskJson`, `hashTaskReceipt`, globs, paths);
  - de `task-context` (`capture`/`validate` do handoff de 2 KiB e `context_return`);
  - `scopeOf` e `taskScopesOverlap`;
  - `taskWorktreeName`;
  - de `task-process` (identidade de processo, `readTaskProcess`, `startTaskProcess`, `writeTaskJson`);
  - o worker (`pi-task-worker.mjs` virando um worker genérico, com o comando real parametrizado no `job.json`);
  - o lock do registry.
- O Pi passa a importar do shared, e os testes do Pi continuam passando **sem edição de asserções**. Mover
  arquivo de teste é permitido.
- Testes novos no shared cobrem a mesma matriz para o uso genérico.
- Os imports precisam sobreviver ao vendor: rode `scanVendoredImports` via teste de vendor (fase 6) ou o teste já
  existente.

### Fase 2: plano e admissão no Claude Code

- `creating-plans`: passe a usar `core/shared/lib/validate-plan.mjs` (ou a mesma regra) para rejeitar overlap de
  `scope_paths`/`locked_tests`/fixtures entre tasks que podem rodar juntas e para rejeitar globs.
- Mantenha os planos existentes válidos. Se a regra for nova, aplique só quando o plano pedir execução paralela
  ou quando a feature flag estiver ligada. Documente.
- Defina como o Claude Code registra a aprovação do plano de forma host-owned, equivalente ao
  `plan_review_evidence` do Pi: hashes de plano e spec mais o veredito do plan-reviewer carimbado por hook.
  Reaproveite `mark.mjs plan-reviewed` se ele já carregar isso; se não carregar, estenda.

### Fase 3: lane (launcher, prompt, hooks da lane, ledger)

- **Launcher** `core/claude-code/hooks/lib/task-launcher.mjs`, ou outro local coerente com o vendor:
  - faz preflight read-only do grant: tudo o que `inspectTaskAdmission` faz;
  - cria o claim `wx` via fd, com rollback por dev/ino;
  - cria o gate-state da lane com `task_run` e **sem evidência pré-fabricada**;
  - monta o prompt (`task-runtime.md` mais o envelope `[HARNESS_TASK_RUN]`);
  - executa o `claude -p` decidido no spike;
  - em falha de spawn, faz rollback apenas do estado pristino.
- **Prompt da lane** `core/claude-code/skills/orchestrating-delivery/references/task-runtime.md`:
  - é o port de `core/pi/prompts/harness-task-runtime.md`, com os nomes de agentes do Claude Code;
  - mantém a ordem TDD, o caminho `no_tests`, o commit seletivo, o `capture-verified`, a regra de rodar os olhos
    em lote foreground, a proibição de amend e a regra de rodar `locked_tests[].command` sem pipes nem filtros;
  - define o formato de retorno.
- **Hook da lane** (PreToolUse, registrado em `core/claude-code/settings.json`):
  - inerte sem `CLAUDE_HARNESS_TASK_RUN`;
  - com ele, revalida o binding a cada chamada (grant, claim, gate-state, hashes do plano e da spec do pai) e
    aplica `decideTaskRunTool` portado;
  - JSON de env malformado nega tudo.
- **Ajustes nos gates existentes para rodarem por worktree:**
  - `active_dispatch`, hand-records, `capture-hand`, `fidelity_pass`, `regate` e `capture_verified` passam a ser
    resolvidos pela raiz da worktree e pelo `session_id` da lane;
  - o pai global, com tasks admitidas, **não** pode despachar executor ou sniper direto (equivalente a
    `entry-gate.mjs:808-814` do Pi);
  - spec e classify ficam travados após a admissão.
- **Ledger host-owned** (PostToolUse/SubagentStop):
  - um registro por chamada de `Agent`, com `tool_use_id`, papel, `task_id` do marcador, hash do prompt, status e
    `agent_id`;
  - um registro por `Bash`, com o comando, o status, o exit code, `head_before` e `head_after`;
  - o commit de freeze é identificado por esse HEAD antes/depois, nunca pelo stdout.

### Fase 4: coordenador e CLI `tasks.mjs`

- Port de `task-coordinator.mjs`:
  - ações `dispatch`, `status` (+`compact`), `wait` (+`compact`, janela máxima de 540 s, devolve
    `settled|changed|timeout|aborted`), `integrate` e `resume` (sem `reconcile_head` nesta fase);
  - campos estritos por ação, limites e mensagens de erro equivalentes;
  - lock do registry e escrita atômica;
  - `requireClean` ignorando os voláteis do harness;
  - `base_sha` comum ao lote;
  - deps exigem integração com evidência revalidada;
  - overlap contra todas as tasks não integradas;
  - `task_contexts` imutável;
  - `convergence_attention`;
  - `diagnostics` não persistidos;
  - `context_return` só em `ready`/`integrated`.
- **Inspeção** (port de `inspectTaskRun`), lendo `events.jsonl`, ledger e gate-state da lane. Precisa cobrir:
  - launches terminais, com o último em exit 0;
  - claim e binding;
  - sessão única nos eventos;
  - worktree limpa;
  - diff dentro do escopo;
  - produtor real (executor ou sniper);
  - hand-record com `capturedVerifiedAt` e freeze ancestral;
  - fidelidade reconstruída;
  - markers;
  - reviews atuais (FULL: compliance, adversary se `adversarial.enabled`, security por trigger; LIGHT: nenhum por
    task);
  - regate absolvido;
  - recibo `host-task-inspection`.
- **`integrate`:**
  - exige `attempt_id` e `expected_head` exatos;
  - re-inspeciona a task;
  - roda `merge-tree` e trata o caso `already_ancestral`;
  - aplica `requireFrozen` com a regra `frozen_parent`;
  - grava o journal e faz o merge `--no-ff`;
  - roda `reconcileMerge` e grava o recibo `host-task-integration`;
  - recupera de crash e de hook `pre-merge-commit` falho.
- **Skill.** Nova seção "Phase 2 paralela" em `orchestrating-delivery/SKILL.md`, equivalente a
  `harness-task-pipeline`:
  - quando usar;
  - como despachar, esperar com `wait` (proibido polling por `status`), integrar e retomar;
  - o pai nunca lê transcripts dos filhos;
  - revisão final e suíte global no HEAD agregado.
- **Gates de entrega.** O shipper e os comandos `git push`/`gh pr create` exigem recibos de integração válidos de
  todas as tasks no HEAD atual.

### Fase 5: correções e reconciliação

- `resume` de task integrada:
  - `correction_barrier` com pilha;
  - `integration_history` e `result_history`;
  - invalidar `final_review`/`demo` no pai;
  - dependentes pendentes recebem `reconciliation_required`.
- Merge de reconciliação feito pelo host na worktree do dependente; em conflito, deixa o merge aberto e o prompt
  manda resolver via sniper.
- `resume` com `reconcile_head` (aggregate refresh).
- `abandon-resume`.

### Fase 6: vendor, docs e e2e

- `vendor-core.mjs`:
  - copia os novos arquivos para `.claude/` (shared, hooks, references);
  - registra os hooks no `settings.json` mesclado;
  - atualiza `FRESH_NATIVE_PATHS.claude` se o componente for crítico;
  - o `.gitignore` do consumidor cobre `task-runs/`.
- Docs: `core/claude-code/docs/OPERATOR-GUIDE.md` (como usar, limites, recuperação, VPS) e o README, se ele citar
  a pipeline.
- Orca fica **fora** deste PR. Deixe apenas um ponto de extensão (backend de worktree e lançamento injetável) e uma
  nota no PR.

## 4. Matriz de testes obrigatória

Use `node --test`, no estilo dos testes existentes. Use repos git reais em `mktemp -d`, sem mocks de git.

**Unidade (shared e coordenador):**
- hash canônico estável independente da ordem das chaves;
- globs rejeitados (`*`, `?`, `{a,b}`, `{1..3}`) e literais aceitos (`[slug]`, `{version}`);
- `..`, path absoluto e `\` rejeitados;
- overlap por componente: `src/a` × `src/ab` não conflita; `src/a/` × `src/a/x` conflita; `"."` conflita com tudo;
  `locked_tests`, fixtures e `allowed_writes` contam;
- `task_contexts`: no máximo 2048 bytes UTF-8 (com teste de multibyte na borda), chaves exatas, task fora do lote,
  duplicata, imutável no retry;
- `taskWorktreeName`: acentos, título vazio, id `task-3-foo`, limite de 36 chars, colisão.

**Coordenador** (repos temporários reais; o worker real lança um **`claude` falso**, ver abaixo):
- lote atômico: `[a, c]` com `c` dependente de `a` falha sem nenhum efeito (sem registry, worktree, branch ou job);
- dispatch idempotente: redispatch não relança;
- limite de 3 por lote e por tasks `running`/`preparing` persistidas;
- pai sujo recusa, mas voláteis do harness não contam;
- dependência só depois de integrada;
- `status`:
  - nunca lança trabalho;
  - `diagnostics` frescos e não persistidos;
  - `context_return` só em `ready`/`integrated`;
  - `compact` omite `context_return`;
- `wait`:
  - retorna `changed` quando a task termina;
  - `settled` sem nada rodando;
  - respeita a janela máxima;
  - abort/SIGINT do CLI **não** mata a task;
- `integrate`:
  - recusa `attempt_id` errado, `expected_head` errado e HEAD da branch diferente do inspecionado;
  - gera merge de 2 pais com a mensagem esperada;
  - conflito detectado antes de tocar o pai;
  - frozen test alterado bloqueia;
  - `frozen_parent` aceita só os bytes do pai;
  - `already_ancestral` emite recibo sem merge;
  - journal: crash entre merge e recibo é concluído na próxima ação; hook `pre-merge-commit` falho aborta só o
    merge exato;
- `resume`:
  - exige processos terminais;
  - mantém `attempt_id`, grant, claim e worktree;
  - incrementa launches e zera `result`;
  - sem claim relança a admissão;
  - recusa campos proibidos;
- lock: lock recente não é roubado; lock com pid morto e mais de 30 s é recuperado;
- correções (fase 5): barreira bloqueia dispatch; dependente pendente é reconciliado pelo host; conflito
  preservado entre resumes; aggregate refresh recusa mudança fora do escopo; `abandon-resume` exige a declaração e
  o HEAD exato.

**Processo:**
- worker detached sobrevive ao processo que o criou;
- `process.json`/`result.json` com identidade (pid + start ticks);
- SIGHUP/SIGTERM no supervisor mata o grupo inteiro, sem órfãos (verifique com `ps`);
- timeout gera `timedOut` e falha terminal;
- netos vivos mantêm `running`;
- reuso de PID não engana (simule com identidade divergente);
- runtime alterado é recusado antes do filho;
- env saneado: `CLAUDE_HARNESS_TASK_RUN` herdado, `ORCA_*` e variáveis de dispatch removidas; só as envs da
  allowlist atravessam.

**Lane** (hook da lane alimentado com payloads JSON reais de PreToolUse no stdin, no formato capturado no spike):
- inerte sem env;
- env malformado nega;
- binding inválido (grant, claim, plano ou spec do pai alterados) nega;
- nega `tasks.mjs`, classify, escrita de plano/spec, push/pull/merge/rebase/tag, `--amend`, `gh pr …`, deploy;
- aceita `git merge-base A B` isolado e nega `git merge-base A B && git merge X`;
- `Agent` fora dos papéis, sem marcador, com marcador de outra task, com `[HARNESS_FINAL_REVIEW]`, com
  `run_in_background` ou com `model` diferente da rota: tudo nega;
- `mark` só com as ações e o `task_id` da lane;
- repair (test-author, `git restore|checkout|reset|clean|stash`) com delta de produto não commitado nega;
- admissão: preflight sem claim permite retry; rollback só do pristino; não fabrica evidência; prompt global
  ausente e envelope com `"resumed": false`.

**Inspeção e recibos** (cenários montados com repo real, ledger e events gerados pelo `claude` falso):
- caminho feliz FULL e LIGHT;
- `no_tests`;
- executor antes da fidelidade: bloqueia;
- test-author depois da fidelidade: bloqueia;
- freeze tocando produto: bloqueia;
- captura de produtor estrangeiro: bloqueia;
- mudança fora do escopo: bloqueia;
- worktree suja: bloqueia;
- último launch com exit diferente de 0: bloqueia;
- review positivo anterior ao executor não vale;
- review negativo stale bloqueia;
- dispatch recusado pelo gate não revoga recibo;
- recibo de dependência forjado ou hash recomputado com ancestralidade falsa: rejeitado;
- `context_return` forjado: rejeitado.

**`claude` falso para e2e herméticos:** crie `core/claude-code/.../__fixtures__/fake-claude.mjs`.
- Aceita as mesmas flags decididas no spike.
- Lê um roteiro JSON (via env) e emite stream-json no formato real capturado no spike.
- Executa os passos de verdade na worktree: escreve teste, commit de freeze, chama os hooks reais via `node` com o
  payload correspondente, escreve produto, commit e `mark`.
- Sai com o exit code do roteiro.
- Com ele, rode o **cenário e2e completo**:
  1. plano com 3 tasks: `a` e `b` independentes, `c` dependente de `a`;
  2. dispatch `[a,b]` em paralelo;
  3. `wait`;
  4. `status`: `a` e `b` em `ready`;
  5. integrate `a`;
  6. dispatch `c`;
  7. integrate `b` e `c`;
  8. `resume` de `a` com correção, que abre a barreira e leva `c` a reconciliar;
  9. reintegrar;
  10. gate de entrega libera só com todos os recibos válidos no HEAD final.

**Ao vivo** (opcional; roda só se `claude` estiver disponível **e** `CLAUDE_HARNESS_LIVE_TASKS=1`, com o
`skip` reason explícito no estilo de `core/orca/smoke-orca-cli.test.mjs`):
- uma task trivial num repo temporário com o harness vendorizado pelo próprio `vendor-core` (fora do repo);
- `claude -p` real executa a lane e o host chega a `ready`;
- integra.
- Rode isso na VPS ao menos uma vez e cole no PR o resultado: tempo, tokens se disponíveis, RAM das 3 lanes
  simultâneas.

**Vendor:** em `vendor-core.test.mjs`, os novos arquivos são vendorizados, os imports são resolvidos, os hooks
ficam registrados e nada vaza para a raiz do repo.

**Regressão:** `npm test` inteiro verde. Nenhum teste existente foi enfraquecido. Se um teste antigo precisar
mudar, justifique no commit e no PR.

## 5. Checks antes de cada commit de fase

```
npm test                                                                   # suíte inteira verde (= node --test do CI)
node core/skills/initializing-projects/references/scan-secrets-in-tree.mjs # scan de segredos do CI
git status --short                                                         # sem lixo, sem /.claude /.pi /.codex /.opencode na raiz
git diff --stat origin/main...HEAD                                         # escopo coerente com a fase
```

- Rode também os demais passos de `.github/workflows/ci.yml` (os grep-gates); o CI precisa passar igual.
- Faça um vendor de verdade num `mktemp -d` e rode lá os testes de hook relevantes.
- Releia o diff procurando estas coisas, e corrija o que achar:
  - caminhos relativos a `process.cwd()` que deveriam vir da worktree ou da sessão;
  - leitura de params como identidade;
  - escrita não atômica de estado;
  - `catch` que engole erro e libera;
  - regex de bash fácil de contornar (`;`, `&&`, `|`, `$( )`, quebra de linha, `git -C`).

## 6. Revisão antes de marcar o PR como pronto

Despache revisores read-only em paralelo sobre o diff final:
- `compliance`: aderência a este prompt e ao mapa;
- `adversary`: tentar burlar gates, forjar recibo, escapar do escopo, deixar órfão, corromper o registry
  concorrente;
- `security`: env e segredos atravessando para a lane, injeção no comando do worker, symlinks, permissões dos
  arquivos de estado.

Corrija todo achado HIGH ou MEDIUM com teste que reproduza o problema. Rode a revisão de novo só nos papéis
afetados.

## 7. Definição de pronto

- [ ] Spike registrado, com comandos e saídas reais.
- [ ] Fases 1 a 6 implementadas, com testes da matriz da §4 passando.
- [ ] Testes do Pi intactos e verdes.
- [ ] E2E hermético dos 3 tasks verde.
- [ ] Ao vivo executado na VPS, com resultado no PR (ou motivo concreto de não ter rodado).
- [ ] Docs de operador atualizadas.
- [ ] PR draft com:
  - resumo;
  - decisões e desvios do mapa, com motivo;
  - limitações conhecidas (Orca fora);
  - como testar;
  - riscos.
- [ ] Nada mergeado, nenhum release, nenhum push em `main`.

## 8. Quando parar e perguntar

Pare, registre no log e no PR e encerre com um relatório curto ao operador se:
- o spike contradiz a arquitetura;
- uma mudança exige alterar o comportamento do Pi;
- um teste existente precisa ser enfraquecido;
- algo exige credencial, segredo ou acesso que você não tem;
- a mesma falha persiste depois de 3 tentativas diferentes.

Não contorne gate do próprio harness e não desligue hook para "fazer passar".

## 9. Relatório final ao operador (pt-BR, curto)

1. Link do PR.
2. O que funciona, com as evidências: testes e e2e.
3. O que ficou de fora e por quê.
4. Decisões que divergem do mapa.
5. Próximo passo recomendado.
