# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed
- **Tratamento especial de PRs que tocam o próprio motor do harness (gate-machinery carve-out + 2ª revisão).** Antes, um PR cujo diff mexia na maquinaria de controle do harness (`core/vps/`, `core/skills/`, `.github/`, etc.) nunca era auto-mergeado — esperava merge manual do operador — e ainda passava por uma segunda revisão independente. Isso empilhava PRs de infra parados indefinidamente e dobrava o consumo de token nessas revisões. Agora mudança no motor é tratada **igual a qualquer PR**: uma revisão limpa (fresh CLEAN + cross-family) → auto-merge. A elegibilidade cross-family e o fail-closed de diff vazio permanecem intactos. Removidos `review-gate-hardening.mjs` (+ testes) e a lógica de 2nd pass do `cron-review`.

## [0.29.0] - 2026-07-07

### Added
- Auto-update do motor na VPS (blue/green): quando a `main` avança após um merge autônomo, um clone da nova versão é preparado numa pasta isolada e o motor troca para ela via symlink atômico — sem lock, sem instante meio-atualizado, com fallback seguro que nunca mexe num motor que não é gerenciado. Mecanismo entregue; a ativação automática no onboarding é o próximo passo.
- Recuperação automática de PR travado por branch desatualizada: em vez de mandar direto para a fila de merge manual, o harness sincroniza a branch com a base (operação nativa do GitHub, sem force) e a esteira de revisão reprocessa o PR do zero antes de tentar mergear de novo — com teto de tentativas para dois PRs que se invalidam mutuamente não entrarem em loop.

### Changed
- Auto-merge deixa de ficar refém da segunda família (Codex): quando o Codex não está disponível, a elegibilidade do merge passa a depender só do veredito do Claude (risco aceito e documentado). Um veredito do Codex que de fato rodou continua governando incondicionalmente — um `BLOCKED` sempre bloqueia. Quando o Codex voltar a rodar, a trava mais forte volta sozinha.

## [0.28.10] - 2026-07-07

### Added

- **Cron dedicado só-drenar (feed quase ao vivo)** — novo `run-drain.mjs` que roda APENAS o drain do
  outbox (sem dispatch, sem review), pra agendar num intervalo curto (default 3 min) e deixar o feed
  do Telegram quase ao vivo sem disparar os efeitos pesados dos outros crons. O `install-crons` passa
  a gerar essa 3ª linha (`intervalMinutesDrain`, default 3). O bloco de drain+lock virou um helper
  compartilhado (`drain-lock.mjs`) usado pelo cron de drain e pelo de review (mesmo `drain.lock`, sem
  double-send).

## [0.28.9] - 2026-07-07

### Fixed

- **"1 tarefas" no feed** — o checkpoint de plano criado dizia "1 tarefas" (plural com singular); agora
  concorda: "1 tarefa" / "N tarefas".

## [0.28.8] - 2026-07-07

### Fixed

- **Feed do Telegram só atualizava 1x/hora (P7)** — só o Cron A (de hora em hora) drenava o outbox de
  observabilidade; um run que começava e terminava entre dois ticks não mostrava nada no tópico até a
  próxima hora. Agora o cron de review (a cada 15 min) também drena — compartilhando o mesmo
  `drain.lock` do Cron A (sem double-send) e com stale-reclaim de 15 min. O feed passa a atualizar a
  cada 15 min.

## [0.28.7] - 2026-07-07

### Fixed

- **Resume-mode ressuscitava branch órfã de run morto (abria PR falso sem rodar o pipeline)** — o
  dispatch reusava QUALQUER branch `harness/<issue>` já existente, mesmo uma órfã deixada por uma
  tentativa que morreu antes de abrir PR. Um re-dispatch pegava os commits velhos e abria um PR em
  segundos, pulando spec/plano/build/review (com `regate-pending` sem resolver). Agora o resume só
  acontece quando a branch tem **PR aberto** (entrega real a preservar); uma branch órfã sem PR é
  **deletada e reconstruída do zero** (`-b`). O probe de PR é fail-safe: em qualquer erro do `gh` ele
  resume (nunca deleta), pra um `gh` inacessível jamais destruir uma entrega real.

## [0.28.6] - 2026-07-07

### Changed

- **Grupo global do Telegram só recebe ação/erro, não a tagarelice de PR** — o cron de review deixou
  de mandar `review-started` e `pr-merged` (eventos não-acionáveis) pro tópico global compartilhado,
  que com N projetos viraria spam. Continuam subindo: `pr-awaiting-merge` (o "mergeia isso" — sua
  ação) e todos os eventos de erro/bloqueio. (Rotear o ciclo completo pro tópico do próprio run exige
  refactor de lifecycle do tópico — rastreado em issue à parte.)

## [0.28.5] - 2026-07-07

### Added

- **Gate de entrega reproduz o suite de CI inteiro, não só o config default** — o Phase 3 (revisão
  final) agora enumera e roda TODO comando de teste que o CI declara (`package.json` scripts +
  cada `--config`/workflow do `.github/workflows/`) via `ci-test-commands.mjs`, e só declara a
  entrega verde quando todos passam. Fecha a classe de furo onde um projeto com mais de um config
  de teste passava local rodando só o default, enquanto um config inteiro do CI nunca era exercitado.
- **Hook `agent-idle-nudge` (PostToolUse[Agent])** — nudge automático quando um agente despachado
  encerra sem entregar o relatório estrutural final: injeta uma diretiva única de re-prompt (um só
  `SendMessage`) e, se ainda assim não vier relatório, marca a tarefa como não resolvida sem re-loop
  nem re-despacho. (#90)

### Changed

- **Nome do projeto no tópico do Telegram (multi-projeto)** — com N projetos compartilhando um grupo,
  o tópico de cada run agora se chama `[<projeto>] #<issue> · <título>`, então você lê o dono no
  título sem abrir. Dentro do tópico o feed segue sem a tag (o título já identifica). Os pings de
  erro/extraordinário que sobem pro grupo global levam `[<projeto>]` na frente. O nome do projeto vem
  do campo `project` no config do cron de cada projeto.

### Fixed

- **`vendor-core` não espelhava `vps/` em updates a partir de uma cópia velha (stale-jump)** — um
  projeto cujo `vendor-core` vendorizado era anterior à etapa de espelhamento de `vps/` atualizava os
  hooks pro import novo `../vps/…` **sem** criar `.claude/vps/`, deixando 3 hooks quebrando na carga
  (`ERR_MODULE_NOT_FOUND`) de forma invisível (o único sintoma era o entry-gate bloqueando todo
  subagente de entrega). Agora o `vendor-core` termina com um **portão de integridade** que **falha
  alto (exit 1)** se algum hook importa um `../vps/<mod>` ausente de `.claude/vps/`, e a skill
  `updating-harness` roda o vendor **duas vezes** (a 2ª sempre usa a cópia já atualizada) — auto-cura
  o stale-jump em vez de shippar hook quebrado em silêncio.

### Removed

## [0.28.4] - 2026-07-07

### Changed

- **Feed do Telegram em uma linha só** — cada checkpoint agora é `<emoji> <label> — <info>` numa
  única linha (`🚀 Classificação — modo LIGHT`), ou só o label quando não há info (`📝 Spec criada`).
  Antes eram duas linhas (título em negrito + corpo em itálico). Escape de HTML e truncação preservados.
- **Cron A espaça e limita os envios do Telegram** — o drain agora espaça os sends (~1,1 s entre cada,
  críticos e cosméticos) e o teto passou de 30 → 20 msg/min (o limite real por grupo do Telegram),
  para nunca disparar em rajada.

### Fixed

- **`spec-adversary` sem emoji** — o marco de adversarial da spec caía no emoji fallback `🔔`; agora
  usa `🛡️`.
- **Revisões do plano numeradas** — várias "Revisão do plano" apareciam sem distinção; agora cada
  round é numerado (`revisão 1 — requer revisão`, `revisão 2 — aprovado`), contado deterministicamente
  pelo produtor no retorno de cada `plan-reviewer`.
- **Repetição no feed** — sob o rate-limit do Telegram, o último send de uma rajada estourava o timeout
  de 5 s **depois** da mensagem já ter sido entregue → o cursor não avançava → reenvio no tick seguinte
  (duplicata). O espaçamento dos sends mata a causa (sem rajada, sem timeout-após-entrega); o timeout
  global do módulo não foi tocado.
- **`drain.lock` órfão silenciava o feed pra sempre** — um kill/OOM no meio do drain deixava o lock sem
  dono e todo tick futuro pulava o drain. Agora um lock com mtime além do TTL (15 min) é reivindicado;
  um lock fresco (drain concorrente real) é respeitado.

## [0.28.3] - 2026-07-07

### Fixed

- **Feed mostra só UMA linha de classificação por run** — subagentes dispatchados que rodam o próprio
  triaging classificavam a sub-tarefa com modos variados (LIGHT/QUICK/no-ceremony) no outbox
  compartilhado; o dedupe por `(tipo, modo)` deixava os 4+ passarem. Agora o `pipeline-type` dedupa
  por **tipo** — a sessão top-level classifica a issue uma vez (antes de dispatchar qualquer
  subagente), então só a classificação real sobrevive; as dos subagentes são suprimidas.

### Removed

## [0.28.2] - 2026-07-07

### Fixed

- **Marcos `spec pronta` / `plano criado` aparecem na ordem certa no feed** — antes eram derivados
  pelo drain (varredura de arquivo, com atraso de um tick), então caíam FORA DE ORDEM em relação aos
  eventos imediatos do run (podia mostrar "spec atacada" antes de "spec pronta"). Um hook novo
  `obs-plan-write` (PostToolUse Write) emite `spec-created`/`plan-created` **no momento em que o
  planner escreve o arquivo**, pondo o feed em ordem real de pipeline (classificação → spec →
  adversarial da spec → plano → revisão do plano → …). A varredura do drain permanece como fallback
  (dedupe append-if-absent, nunca duplica).

### Removed

## [0.28.1] - 2026-07-07

### Fixed

- **Runs autônomos do cron voltam a subir (aspas simples no gatilho quebravam o comando de sessão)** —
  o `TRIGGER_PROMPT` continha `'Closes #<issue>'`; ao ser embutido cru dentro de aspas simples no
  comando do tmux, a aspa fechava a string no meio e o `#` transformava o resto (incluindo
  `| claude -p`) em comentário de shell — **todo run do cron morria no arranque**, antes de rodar o
  pipeline. Agora o gatilho passa pelo `shellQuoteSingle`, blindando contra qualquer aspa. (P10)
- **Feed de observação para de mostrar spec/plano de outra feature** — o `cp -a .claude` para o
  worktree de cada run arrastava o `plans/` histórico (efêmero); o drain detectava um plano antigo e
  emitia `spec-created`/`plan-created` falsos, além de fazer o `spec-adversary` sumir. O
  `cron-a-dispatch` agora descarta `.claude/plans/` no worktree após copiar o harness, como um
  checkout de projeto normal já faz. (P11)

### Removed

## [0.28.0] - 2026-07-07

### Added

- **Feed curado de notificações no Telegram por run** — o tópico de cada run passa a mostrar só os
  marcos que o operador quer (sessão iniciada, classificação, spec, adversarial da spec, plano,
  revisão/aprovação do plano, loop das tasks + modelos, revisão final, PR), com rótulos em pt-br e
  emoji. O ruído interno (eye cru, `regate-pending`) e o spam de eventos duplicados por subagente
  ficam só no trilho de auditoria (JSONL), suprimidos do feed. `spec-adversary` e `plan-reviewed`
  (com verdict) passam a ser emitidos deterministicamente pelos hooks, sem depender de o orquestrador
  lembrar de marcar. A trava de entrega (gate-state) segue intacta — a supressão é só no feed.

### Changed

### Fixed

### Removed

## [0.27.1] - 2026-07-07

### Added

### Changed

### Fixed

- **Rastro de auditoria da captura fecha no despacho, não por lembrete do orquestrador** — o
  `spawn-hand.mjs` agora carimba `capturedVerifiedAt` no run-record que ele já grava, no mesmo passo
  do despacho e apenas quando a captura interna fica verde (`DONE`). Como o gate de entrega já bloqueia
  qualquer run-record `DONE` sem esse campo, o HEAD não avança mais para a próxima tarefa com a
  verificação em aberto — fechando o buraco em que os marcadores eram pulados silenciosamente e só
  apareciam no gate final, depois do HEAD já ter passado do ponto de captura. Green-only por
  construção: run que falha ou estoura tempo nunca recebe o carimbo.
- **Hooks vendorizados voltam a carregar (`vendor-core` espelha as deps vps)** — os hooks
  `stamp-triage` e `obs-eye-append` importam `../vps/obs-outbox.mjs`, mas o `vendor-core` não copiava
  `vps/` para o `.claude/` vendorizado. Resultado: `ERR_MODULE_NOT_FOUND` ao carregar o hook →
  `triage.json` nunca gravava → o entry-gate bloqueava todo subagent do pipeline (todo `.claude`
  vendorizado da 0.27.0 nascia com os hooks quebrados). O `vendor-core` agora espelha só os módulos
  que os hooks de produção realmente importam (fecho transitivo, `*.test.mjs` e cron runtime
  excluídos).

### Removed

## [0.27.0] - 2026-07-06

### Added

- **Observabilidade por run em tópico de fórum Telegram para runs autônomos na VPS** — cada run
  autônomo ganha um tópico de fórum dedicado que transmite checkpoints determinísticos do pipeline
  (tipo do pipeline, spec, plano, plan-reviewer, executor+modelo+eyes por task, revisão final, PR) via
  uma outbox drenada pelo cron, com prioridade crítica (bloqueado/falhou) sinalizada, fallback pro
  tópico compartilhado quando a criação falha, e fechamento do tópico pelo lado do cron ao terminar.

### Changed

- **Escada de modelos baratos (`hand_tiers`) trocada para gemma4/glm-5.2/kimi-k2.7-code** —
  deepseek-v4-pro saiu da escada por custo desproporcional ao ganho de qualidade nas mãos baratas.

## [0.26.1] - 2026-07-06

### Fixed

- Cheap-hand dispatches (`spawn-hand.mjs`) não travam/falham mais por causa do dialogo de confianca do workspace efemero nunca ter sido aceito — o hand agora roda o loop real de teste (red/green) em vez de ser bloqueado no primeiro `Bash` e estourar o timeout (fecha #91).

## [0.26.0] - 2026-07-06

### Added

- **Atalho de escalação em rate-limit de conta (429) do Ollama** — quando duas dispatches
  consecutivas da mão barata batem no limite de cota da conta Ollama (dois 429 seguidos para a mesma
  task, ancorados ao mesmo freeze), o orquestrador agora **pula o 3º tier Ollama** — que 429aria de
  novo por construção, já que todos os tiers dividem a mesma conta — e vai direto para o reforço
  Claude (K=1), poupando turnos e wall-clock. O `spawn-hand.mjs` atribui `rateLimited` sobre o stream
  do child (predicado estrito, não um `429` solto), mantém um contador consecutivo freeze-ancorado e
  expõe `rateLimitExhausted` no run-record; a §escalation do `SKILL.md` consome esse sinal. Route C: o
  `spawn-hand` nunca pula um spawn internamente (o record da 2ª tier é um run genuíno), então o
  cinturão de evidência não-forjável do entry-gate fica intacto (sem tocar `entry-gate.mjs`). Pinado
  por 11 locked tests em `spawn-hand.test.mjs`.

### Fixed

- **Sessão headless em branch tipada (`feat/`/`fix/`/`docs/`) agora fecha a issue certo** — o cron de
  saída só reconhecia PR pela convenção antiga `harness/<N>`; uma sessão que entregava em branch
  tipada (padrão `git.md`) tinha o PR invisível e a issue voltava pra fila em vez de fechar. Agora o
  cron também acha o PR pelo vínculo `Closes/Fixes/Refs #N` no corpo. O aviso Telegram de "pegou a
  issue #N" passa a incluir título + resumo, não só o número.
- **`cross-family.mjs` não roda mais um passe degenerado e silencioso** — sem `--task`/`--claude` o
  CLI antes deixava o Codex vasculhar o repo sem escopo e sem contraponto do Claude; agora exige os
  dois argumentos e falha rápido (usage + código de saída não-zero) quando faltam.

## [0.25.0] - 2026-07-06

### Added

- **Auto-merge autônomo que fecha de verdade + trava de segurança da própria máquina** — três
  correções que destravam o auto-merge de PRs verdes e impedem retrabalho: (1) o review cron agora
  **tira o PR do rascunho** (`gh pr ready`) nas duas rotas limpas antes de mergear — sem isso o
  `gh pr merge` nunca fechava um PR headless (que nasce draft), então nada auto-merjava mesmo verde;
  (2) **carve-out de gate-machinery**: um PR que toca a própria máquina de controle do harness — no
  repo do harness (`core/{vps,skills,agents,rules,hooks,github,__tests__}/`, `modules/codex-adversary/`)
  **e, crucialmente, o harness vendorizado em qualquer projeto downstream** (`.claude/{skills,agents,rules,hooks,modules}/`,
  `settings.json`/`CLAUDE.md`) — **nunca** auto-merjar, vai pra merge manual; num projeto normal nada
  disso é tocado, então tudo verde auto-merjar hands-free (matcher corrigido pra casar por segmento
  de path, não `startsWith` cru; saídas do harvester `.claude/memory/`/`kaizen.md` ficam de fora pra
  não travar todo PR); (3) **estados de label mutuamente exclusivos** via a fonte única `STATE_LABELS`
  — todo relabel strippa o conjunto completo de estados, então uma issue nunca carrega `harness:ready`
  junto de um estado posterior (o bug que fez uma issue já entregue ser re-despachada), e o seletor
  passa a excluir `awaiting-merge`/`queued`/`done`. Diff vazio/malformado **fail-closed** pra merge
  manual. Refs #86.
- **Timeout wall-clock na mão barata do spawn-hand** — um `claude -p` que trava numa chamada de
  rede sem fim (observado 28+ min a CPU quase zero) agora se autotermina no prazo (default 9 min,
  configurável por tier via `dispatch.timeout_ms`) e degrada sozinho para o caminho de reforço
  (Claude, K=1) — sem exigir `kill -9` manual e sem travar a entrega autônoma, especialmente em
  headless sem ninguém observando. O contrato de saída normal (0/1/2) fica inalterado.
- **`test-author` autoverifica formato e evita a armadilha do terminador de block-comment** — o
  agente agora tem uma auto-checagem de conformidade de formato (passo 5, sem depender de um
  formatter externo) e uma regra explícita contra escrever qualquer `/* */`/`/** */` cujo texto
  contenha a sequência que fecha o comentário (ex.: um cron `0 */6` dentro de um JSDoc), que hoje
  derruba a coleta de testes silenciosamente. Pinado por
  `core/__tests__/test-author-format-safety.test.mjs`.
- **Cadência dos crons configurável na instalação** — `install-crons` aceita `--interval-hours-a` e
  `--interval-hours-review` (inteiros 1..24; default 4h/6h). Intervalos menores fazem um roadmap
  encadeado avançar mais rápido sem tocar na garantia de ordem. Injection-safe por construção (só
  inteiro entra na linha do crontab).
- **Validação end-to-end do agendamento real** — novo teste opt-in (`HARNESS_CRON_E2E=1`) instala
  uma linha de crontab de verdade, espera o **cron daemon do SO disparar** e observa o efeito, então
  restaura o crontab original — prova que o scheduler agendado roda a linha instalada, algo que os
  testes herméticos (fakes em memória) nunca cobriram. Fica de fora do `npm test` normal (skip).
- **Skill `creating-issues`** — procedimento ativo pra criar a issue (o insumo de maior alavancagem
  da pipeline: último ponto de controle humano antes da máquina rodar plano→build→review→merge
  sozinha). Aplica a regra de sizing (unidade de entrega pequena e revertível), **treina critério de
  aceite verificável** (os `locked_tests` saem dele — AC vago mira a pipeline inteira errado), amarra
  `harness-deps` pra ordem do roadmap, cria tudo `harness:ready` e roda o `chain-validate`. Fonte
  única: lê a rule `creating-issues`, não a duplica; o advisory de `gh issue create` aponta pra ela.
- **Encadeamento de roadmap por dependência (parte 1: motor de liberação)** — uma issue de roadmap
  pode declarar de quais issues ela depende num bloco fechado no corpo (` ```harness-deps ` com
  `#12`, `#13`…), e nasce com a label `harness:queued` — invisível pro seletor, que só pega
  `harness:ready`. A cada ciclo de revisão, o motor libera automaticamente `harness:queued →
  harness:ready` **assim que TODAS as dependências têm PR merjado na main** (verdade-fundamento = PR
  merjado, nunca o label, que pode atrasar). Uma dependência diamante só libera quando a última
  merjа. Se qualquer dependência morre (`harness:blocked`), a dependente é encalhada
  (`harness:queued → harness:blocked`) e o operador é **notificado** — a corrente abaixo de um nó
  morto nunca fica parada em silêncio. A liberação roda no `reconcile()` do review cron, agnóstica
  ao modo de merge (auto **ou** merge manual do operador). A ordem é garantida por dois mecanismos
  combinados: o gate (dependente espera as deps merjarem) + a serialização do run-lock por-projeto
  (uma issue por vez) — sem dispatch automático nem race de implementação paralela.
- **Encadeamento de roadmap (parte 2: gate na seleção + lint de DAG)** — o seletor do Cron A agora
  **adia** qualquer issue `harness:ready` cujas dependências ainda não têm PR merjado
  (`harness:ready → harness:queued`), então o operador cria TODAS as issues do roadmap como
  `harness:ready` e o motor se auto-organiza — uma issue nunca é implementada sobre uma main que
  ainda não tem o código da dependência, mesmo que tenha sido criada `ready` por engano. O form de
  issue ganhou o campo **Dependências** (bloco ` ```harness-deps `). Novo lint pré-flight
  `node core/vps/chain-validate.mjs` detecta **ciclos** e **dependências inexistentes** de roadmap —
  os dois erros de autoria que o runtime não consegue auto-curar (ficariam encalhados em silêncio).
- **Fase independente de revisão de PR agora funciona de verdade** — o `spawnReviewSession` deixou
  de ser um stub que sempre falhava: a sessão de revisão roda de fato sobre o diff do PR (só olhos —
  adversary/compliance/security, nunca um hand com escrita) e o veredito CLEAN/BLOCKED que decide
  auto-merge é calculado pelo motor a partir dos vereditos brutos, nunca por autorrelato da sessão.
  Reforços anti-spoofing: artefatos de uma tentativa anterior (travada/expirada) são sempre apagados
  antes de rodar uma nova sessão e também em qualquer falha, para nunca herdar um veredito CLEAN
  velho.
- **Segunda família de modelo (Codex/GPT) agora roda de verdade na revisão de PR** — antes a
  checagem cross-family estava sempre desligada por um bug de fiação; agora ela chama o Codex de
  fato, sobre o diff real do PR, ao lado dos olhos Claude. A autenticação passou a reconhecer o
  login por assinatura do ChatGPT (sem precisar de chave de API). Uma trava explícita
  `autoMergeEnabled` (desligada por padrão) garante que nenhum PR mescla sozinho até o operador
  decidir ligar o auto-merge cross-family de propósito.

### Fixed

- **Marcador de `mark.mjs` encadeado com outro comando deixava de ser gravado em silêncio** —
  `stamp-triage.mjs` agora exige exatamente um objeto JSON com o marcador esperado antes de gravar
  (dois ou mais, ex.: `mark.mjs` encadeado com outro comando na mesma chamada, disparam um aviso
  alto em vez de gravação ambígua) e confere, por leitura de volta, que toda gravação tentada
  realmente persistiu — uma falha de gravação agora dispara aviso alto em vez de sucesso silencioso,
  e uma nova tentativa se auto-corrige.
- **A notificação "revisão iniciada" volta a chegar** — antes o aviso de que a análise de um PR
  começou era disparado logo antes de um `spawn` bloqueante de vários minutos; o tempo-limite de 5s
  do envio estourava durante o bloqueio e a notificação nunca chegava, o operador só via o resultado.
  Agora o envio de "revisão iniciada" é aguardado até concluir enquanto o loop está livre, antes do
  spawn — o ping chega de fato.

### Changed

- **PR já revisado no mesmo commit deixa de ser revisado de novo em todo ciclo** (fecha parte do
  risco de custo apontado no release anterior) — um PR aguardando merge ou barrado na segunda
  passagem de revisão agora é marcado como já revisado por SHA.

### Fixed

- **Bug do disjuntor (breaker) da revisão de PR corrigido** — o contador de sessões de revisão por
  janela de tempo travava (matemática quebrada) e nunca se recuperava depois de bater o teto; agora
  conta, corta no limite e se recupera normalmente após a janela.
- **Falha ao buscar o diff do PR deixou de ser indistinguível de "PR sem mudanças"** — antes uma
  falha transitória de rede/API ao buscar o diff caía silenciosamente no mesmo caminho de "diff
  vazio", podendo pular sem aviso uma checagem extra de segurança em PRs que tocam a própria
  infraestrutura de revisão. Agora a falha é sinalizada de forma distinta e o PR é reenfileirado em
  vez de seguir como se nada tivesse mudado.
- **Mão barata (cheap hand) deixa de ser falsamente reprovada por um cache interno do próprio
  harness** — a sessão filha que executa a mão carrega o hook de version-check do projeto, que
  grava um cache interno periódico e gitignorado (`.claude/.harness-version-check-cache`); a
  varredura de escopo passava a marcar esse arquivo benigno como violação e reprovava uma entrega
  correta, exigindo um re-disparo inteiro. Esse cache agora é reconhecido e ignorado pela checagem
  de escopo (correspondência exata, nunca por prefixo — fecha também um possível escape por nome de
  arquivo parecido).

### Removed

**Riscos abertos registrados (não bloqueiam esta entrega — o auto-merge cross-family segue
desligado por padrão, mas devem ser fechados antes de ligar `autoMergeEnabled` em produção):** um
veredito manipulado via injeção de prompt segue barrado hoje só por revisão humana do PR; e uma
falha transitória da segunda família de modelo (timeout, indisponibilidade) ainda é tratada como um
veredito definitivo de "bloqueado" em vez de "tentar de novo depois" — inofensivo hoje porque nada
mescla automaticamente sem essa trava, mas pode prender sem necessidade um PR bom até o próximo
push.

## [0.24.0] - 2026-07-05

### Added

- **Três regras de checklist no `creating-plans`** (fecha #93, #94, #98) — o planner agora sabe: (a) incluir todos os arquivos que tornam uma env/secret var usável em `scope_paths`, não só os 1-2 que o teste importa direto; (b) nunca adicionar um parâmetro posicional obrigatório a uma função cuja assinatura já foi pinada por um `locked_test` de tarefa anterior (preferir default opcional ou DI); (c) exigir que um `locked_test` cubra TODOS os branches de um invariante multi-estado, não só o happy-path. Documentação apenas — nenhum comportamento de código muda.
- **Fase independente de revisão de PR** (`cron-review.mjs` + `run-cron-review.mjs`) — o auto-merge deixa de confiar no corpo editável do PR como veredito e passa a ler um artefato de veredito fresco e fora de banda, só mesclando na conjunção completa de checks (origem-máquina + veredito CLEAN + acordo cross-family quando disponível). Rótulos novos no fluxo: `harness:in-review` → `harness:awaiting-merge` → `harness:done`/`harness:blocked`. **Nota:** a fase está montada e com testes verdes, mas ainda **inerte em produção** até um follow-up implementar o `spawnReviewSession` (o disparo real da sessão de revisão) — falha alto e claro (throw), nunca silenciosamente.

### Changed

### Fixed

- **Bug do rótulo `done` prematuro no `cron-a-exit`** — ao existir um PR aberto, a issue agora vai para `harness:in-review` em vez de pular direto para `harness:done`, alinhando o rótulo ao estado real (aguardando revisão, não entregue).

### Removed

## [0.23.2] - 2026-07-04

### Changed

- **`setup-vps` agora infere tudo do contexto — digitação mínima.** Não pergunta mais o caminho do harness: o motor (`core/vps`) é resolvido automaticamente do local do próprio script (clone real) ou, se rodar via `npx` (que não empacota `core/vps`), é **clonado uma vez** num path estável (`~/.claude/harness-core`) — nunca do cache efêmero do npx. O projeto vem da pasta atual (`cwd`), owner/repo do `git remote origin`, e os paths têm defaults sensatos. O operador só digita o que não dá pra adivinhar: o **token** e o **chat_id** do Telegram (Enter aceita cada default inferido).

## [0.23.1] - 2026-07-04

### Fixed

- **Pacote npx quebrado na 0.23.0** — o `files` do pacote não incluía o `setup-vps.mjs`, mas o `cli.mjs` o importa no topo → `ERR_MODULE_NOT_FOUND` ao rodar QUALQUER comando via npx (`setup-local`/`init` inclusive). Corrigido adicionando `setup-vps.mjs` ao `files`.
- **`setup-vps` apontava o crontab pro cache efêmero do npx** — o wizard agora pergunta o path do clone ESTÁVEL do harness na VPS (onde vive `core/vps/`), valida que existe, e roda o `install-crons` **de lá** — assim o crontab (que aponta pra `<clone>/core/vps/run-cron-a.mjs`) continua válido depois que o cache do npx é apagado. Sem clone válido, o wizard para com instrução clara de `git clone`.

## [0.23.0] - 2026-07-04

### Added

- **Wizard interativo `npx claude-harness setup-vps`** — liga o motor autônomo + as notificações Telegram na VPS por um assistente guiado, pensado pra operador não-dev. Pergunta projeto/owner/repo/paths e o Telegram (token, chat_id, thread_id, heartbeat), e é **auto-explicativo**: mostra na hora como conseguir cada valor do Telegram (criar bot no @BotFather, ler o chat_id via `getUpdates`/@RawDataBot, achar o message_thread_id do tópico). Grava o bot token **só** em `~/.claude/.dev.vars` (0600, fora do git, nunca exibido/logado — auditoria SECURE) e registra os crons + config de notify via `install-crons`. Substitui o one-liner `node install-crons.mjs install --flags`.

### Changed

- **`npx claude-harness init` → `setup-local`** — o comando de vendoring do harness na máquina de dev agora se chama `setup-local` (deixa claro o par com o `setup-vps`); `init` segue funcionando como alias retrocompatível.
- **Heartbeat do Telegram agora é ON por padrão** — o aviso periódico de "nada a fazer" (evento `idle`) passa a ser opt-**out** (`heartbeat: false` desliga), não mais opt-in. Configurar notify sem especificar heartbeat liga o ping. O `install-crons install --chat-id ...` pergunta interativamente (default sim) quando `--heartbeat` não é passado.

## [0.22.0] - 2026-07-04

### Added

- **Notificação Telegram one-way para o motor autônomo por VPS (`core/vps/notify-telegram.mjs`)** — o operador passa a receber os eventos-chave do ciclo cron num tópico de grupo compartilhado, sem SSH: issue escolhida, dispatch falhou/re-enfileirada, sessão concluída → PR aberto, issue bloqueada (precisa de atenção humana) ou com retentativas esgotadas, PR revisado CLEAN→merged ou BLOCKED, e ações do reaper (watchdog kill / recuperação de crash / worktree órfão limpo). Cada mensagem é prefixada `[<project>]` (multi-projeto: um destino compartilhado serve vários projetos). O módulo é **puro/injetável e zero-dep** (Node builtins): `formatEvent` puro (HTML-escape, links `<a href>`, truncagem), `sendNotification` best-effort com `AbortSignal.timeout` (~5s) e feature-detect de runtime, sem retry (429 engolido). A lógica pura de cada cron retorna resultado estruturado; os composition roots (`run-cron-a`/`run-cron-b`/`run-reaper`/`cron-a-exit`) traduzem em evento e notificam best-effort com `drain` antes do exit. **100% opcional e fail-open**: sem `notify` configurado ou com o Telegram fora do ar, o motor roda idêntico a hoje — uma falha de notificação nunca derruba nem atrasa um cron. **Higiene de segredo (auditoria SECURE):** o `TELEGRAM_BOT_TOKEN` vive só em `~/.claude/.dev.vars`, lido do disco no envio; nunca no config, crontab, argv, log ou na URL logada — falha loga só `{op,type,project,status}`. Config `notify:{chatId,threadId}` opcional via `install-crons` (flags `--chat-id`/`--thread-id`/`--heartbeat`); `chatId`/`threadId` não são secret. 42 testes novos com `fetch` injetado (zero chamada real ao Telegram), suíte inteira 846/846. Entregue pela pipeline FULL do harness (spec-adversary + plano + plan-review + TDD congelado + dual-review compliance/adversary/security).

## [0.21.0] - 2026-07-04

### Added

- **Instalador de crontab por projeto (`core/vps/install-crons.mjs`)** — fecha o follow-up do motor autônomo por VPS (v0.19.0): gera e valida o config por-projeto que os composition roots (`run-cron-a`/`run-cron-b`) consomem e o config compartilhado do reaper, e registra/desregistra as linhas de crontab de forma idempotente. Cadências fixas — Cron A a cada 4h (`0 */4`), Cron B a cada 6h (`0 */6`), reaper diário às 03:00 (`0 3`). Cada projeto vive num bloco cercado por marcador (`# >>> harness:<project> >>>`), então reexecução nunca duplica; `--uninstall <project>` remove só aquele bloco e o reaper compartilhado só sai quando o último projeto é removido (o config do fleet é apagado, não deixado obsoleto). Nenhum secret toca o crontab, config ou log — o token é lido do disco em runtime pelo caminho já existente (`scoped-env-fromdisk`). Determinístico, Node builtins puros, zero deps, 65 testes (zero mutação de crontab real no teste). Endurecido por dual-review cross-family (Claude + Codex): leitura de crontab que nunca apaga crons de outros tenants num erro de leitura, validação estrita de coordenadas + guarda no render contra injeção de linha cron, invariante single-repo por fleet, trava de install e escritas atômicas.

## [0.20.0] - 2026-07-04

### Changed

- **Revisão proporcional dos "eyes" (process-eye-routing)** — duas mudanças de custo/latência no próprio pipeline, sem enfraquecer as classes graves:
  - **Roteamento do adversary por blast radius.** O adversary per-task deixa de rodar Opus em todo checkpoint: agora flexiona o tier via o helper puro determinístico `references/eye-tier.mjs` (`resolveEyeTier`) — **Opus** quando a task é grave (`severity` HIGH **ou** sensitive-path), **Sonnet** caso contrário (com **piso Sonnet** — nunca Haiku, nunca Ollama). Os dois gates de fronteira (spec-adversary upfront + dual-review final), o `plan-reviewer` e o `security` per-task **continuam Opus sempre**. A economia no trivial vem de **pular** o eye (`adversarial.enabled=false`), nunca de um eye sub-Sonnet. Nota "raise effort before raising tier" preservada; instrumentar `usage` **por eye** para comprovar a economia.
  - **Re-gate condicional do sniper.** O re-gate obrigatório após fix HIGH deixa de ser sempre um adversário Opus fresh-virgin: continua **Opus completo para fixes graves** (`isGrave(fix)` = qualquer classe canônica-crítica — incluindo as irreversíveis 1/2 — **ou** sensitive-path **ou** re-arquitetura **ou** >1 função/seam; default duro de viés-pra-grave na dúvida). Para um fix HIGH **cirúrgico não-grave**, um **caminho leve**: um `locked_test` congelado que vai **red→green** por causa do fix (um "stays green" é explicitamente insuficiente) **ou** um spot-check de adversary Sonnet virgem com zero findings — cada um deixando um **artefato em disco** sob `run/` que o self-check exige. O trilho `regate-pending`→`regate-passed` permanece **inalterado e delivery-blocking**; os hooks seguem mechanism-agnostic (nenhuma mudança de lógica de hook).

## [0.19.0] - 2026-07-04

### Added

- **Entrega autônoma por VPS (cron-driven)** — substitui as Cloud Routines por um motor self-hosted: dois crons por projeto + um reaper compartilhado que rodam o pipeline do harness sem operador. O Cron A pega a issue `harness:ready` mais antiga, marca `in-progress`, roda a sessão autônoma (`claude -p --permission-mode auto`, headless-local, mãos baratas Ollama ativas) num git worktree isolado e abre um PR rascunho; o Cron B revisa o PR e faz **merge automático** quando o veredito do dual-review é CLEAN (gate de autor fail-closed + merge preso ao SHA revisado), senão comenta o bloqueio; o reaper mata sessões penduradas (watchdog de tempo), recupera runs que crasharam e limpa worktrees órfãos. Inclui trava de concorrência atômica (single-winner via `mkdir`+`rename`, com defesa em 3 camadas), isolamento de secret por projeto (env-scoping), máquina de estados da issue (`done`/`blocked`/re-fila com teto de retentativas) e persistência do veredito CLEAN/BLOCKED no corpo do PR — o único toque aditivo no pipeline existente. Código em `core/vps/` (15 módulos, 66 testes), runnable via `run-cron-a`/`run-cron-b`/`run-reaper`. O instalador que registra o crontab por projeto é follow-up.

## [0.18.7] - 2026-07-02

### Added

### Changed

- Organização da pasta de plano: os buffers de run por feature (`shared_context.md`, `test-manifest-*`, `brief-*`, `descriptor-*`, `task-slice-*`, `plan-review-*`, `spec-adversary-*`, `task.json`) agora vivem em `.claude/plans/<feature_id>/run/`; só `spec.md` e `execution-plan.json` ficam na raiz da feature. Mudança de convenção na prosa do pipeline (emitters recebem paths por arg — sem mudança de código).

### Fixed

- Bug de ordenação `scaffold`-após-`freeze` na mão barata: quando o teste congelado importa um módulo de produção ainda inexistente, o `spawn-hand` recusava com "gate vazio"; commitar o stub depois do freeze movia o HEAD e disparava "HEAD diverged" → tempestade de retries. Agora o SKILL instrui o stub a entrar DENTRO do freeze commit (exportando exatamente os símbolos que o teste importa), e a mensagem de erro do `spawn-hand` nomeia o recovery correto.
- Loop de plan-review sem freio determinístico: o `entry-gate` agora conta cada dispatch de `plan-reviewer` por sessão (`plan_review_count`) — reetiquetar a rodada como "verificação focada" na prosa não dribla mais o contador. Passado o cap documentado de 2 revisões, injeta um aviso visível com o número da rodada e o custo; um backstop de runaway bloqueia além da rodada 10 (só interativo — headless permanece warn-only pra não travar cloud run sem operador). O contador sobrevive a re-triage (preservado no `resetGateState`).
- Precondição de Auto Mode pra cheap-hands documentada: o egress da mão barata pro modelo Ollama externo pode ser hard-blocked pelo classificador de data-exfiltration do Auto Mode se o endpoint não estiver declarado em `autoMode.environment`. O SKILL agora instrui checar isso UPFRONT (antes de plano/freeze), tratar o bloqueio como controle real de plataforma (não fabricação/erro de config), e nunca auto-declarar destino confiável (decisão de dado do operador). Fail-open.

### Removed

## [0.18.6] - 2026-07-01

### Fixed

- Gate de entrega (`capture-verified`) agora cruza com o registro real da mão barata, gravado automaticamente em disco a cada dispatch — não só com o carimbo manual `hand-finished`/`capture-verified`. Detecta um dispatch sem verificação independente mesmo quando o carimbo foi esquecido (incidente real onde 4 de 5 dispatches numa run ficaram sem carimbo). Violação de escopo/manifesto congelado agora bloqueia a entrega mesmo que o carimbo tenha sido feito.
- Corrigido path traversal em `feature_id`/`task_id` nos registros de mão barata (`.claude/plans/.state/hand-records/`), achado na revisão adversarial desta mudança.

## [0.18.5] - 2026-07-01

### Fixed

- Mão executora (executor/sniper) não tenta mais redisparar o pipeline de triagem do harness quando lê o CLAUDE.md do projeto — evita travar esperando confirmação que nunca chega em modo não-interativo.

## [0.18.4] - 2026-07-01

### Fixed
- `adversary`/`security` não devolvem mais `suggested_sniper_tier` com nomes de modelo Anthropic (`haiku`/`sonnet`/`opus`) — campo morto de uma migração anterior incompleta; o dispatch da mão barata já é resolvido via `hand_tiers[severity]`, nunca lê esse campo. Corrigido nos dois lados (agents nativos + espelho cross-family Codex).

## [0.18.3] - 2026-07-01

### Fixed
- O sweep de recuperação de writes gitignorados (`lsFilesAllOthers`) não trata mais `node_modules/` como possível violação de escopo — cache que o próprio test runner escreve ao rodar o teste travado (vitest, coverage tooling) derrubava hands corretos como `FAILED` por falso positivo.

## [0.18.2] - 2026-07-01

### Fixed
- Adapter `vitest` do test-runner não travava mais em falso-negativo em projetos Cloudflare Workers: o parser da contagem de testes ignorava os logs que o `@cloudflare/vitest-pool-workers` intercala com a linha JSON do reporter, tratando qualquer run como "sem contagem" e travando a mão barata.

## [0.18.1] - 2026-07-01

### Fixed
- `stamp-triage.mjs` agora injeta o motivo real de uma falha pré-spawn da mão barata (lido do JSON estruturado que `spawn-hand.mjs` já emite no exit 2), em vez de deixar o orquestrador compor sua própria explicação — fecha um caso real onde um agente inventou uma causa fictícia pra um erro banal (token ausente).

## [0.18.0] - 2026-06-30

### Added

- **Nudge determinístico do segundo olho (Codex) — deixa de depender da memória do orquestrador**: um hook `PostToolUse[Agent]` (`core/hooks/codex-eye-nudge.mjs`, registrado no `settings.json`) injeta automaticamente, no instante em que o orquestrador despacha um eye elegível (adversary/security/plan-reviewer) com o cross-family ligado, um lembrete pra rodar a segunda família e mergear. Resolve o caso real (observado em sessão FULL) em que o orquestrador Sonnet pulava silenciosamente o `cross-family.mjs` — a instrução vivia em prosa na skill, lida no começo da sessão e esquecida no momento do dispatch. **Advisory e fail-open total**: nunca bloqueia (sem `permissionDecision`); switch off, módulo ausente ou headless → Claude-only exatamente como hoje. Cobertura por `subagent_type` em todos os checkpoints (spec, per-task, plan-review, final), não só os finais. Catraca/gate determinístico foi deliberadamente rejeitado (forjável + deadlock fail-closed) — não se adiciona gate onde nada está quebrado.
- **Rota verdict-shaped pro `plan-reviewer` no `cross-family.mjs`**: `cross-family.mjs --role plan-reviewer` agora roteia pelo fluxo de veredito (`runCodexRole` + `merge-verdicts`, either-REVISE-wins) em vez do fluxo de findings, alcançável end-to-end pelo CLI. O verdict path respeita o toggle de opt-in/force-off e faz fail-open pro veredito do Claude quando o Codex está indisponível ou retorna saída sem veredito (nunca um REVISE espúrio).

### Changed

### Fixed

### Removed

## [0.17.1] - 2026-06-30

### Added

### Changed

### Fixed

- **`test_runner` configurável por projeto (`references/runner-adapters.mjs`) — Vitest deixa de ser falso-FAILED na mão barata**: o dry-run pré-spawn, o gate ao vivo do Stop-hook e a captura independente pós-spawn rodavam `node --test` cravado em três lugares distintos — um projeto Vitest (ex: `victor-pipeline-dados-bot`, com `vitest-pool-workers`) sempre reportava `lockedTestExitCode: 1` mesmo com código correto, exigindo validação manual fora do harness. Agora um adaptador único (`{ command, parseCount }` por runner, sempre array pra `execFileSync`, nunca string interpolada) é a fonte de verdade nos três pontos; `node-test` continua default — zero config pra todo projeto já vendorizado. Seleção por `.claude/hand-config/test-runner.json` (`{ "adapter": "vitest" }`).
- **CLI runnável pro `descriptor-emitter.mjs` e `brief-serializer.mjs`** — a skill já prometia "descriptor nunca digitado à mão", mas os dois helpers só existiam como função JS exportada, sem entrypoint. O orquestrador, sem runtime JS interativo, acabava digitando `descriptor.json` na mão via heredoc — exatamente o que a skill proíbe — e batendo, em sequência, erro de quoting, `fidelity-pass` faltando e `freeze_commit_sha` faltando (observado ao vivo no `victor-pipeline-dados-bot`). Agora `node references/descriptor-emitter.mjs --feature-id ... --out descriptor.json` e `node references/brief-serializer.mjs --task-slice ... --out brief.txt` espelham a UX já estabelecida em `spawn-hand.mjs`/`mark.mjs`. Sem flag `--head-sha`: `freeze_commit_sha` sempre vem do `git rev-parse HEAD` real, nunca de argv — fechar a fricção não reabre a porta de forjar o anchor do fidelity-rail.

### Removed

## [0.17.0] - 2026-06-30

### Added

- **`security` vira olho cross-family (módulo `codex-adversary`) — o terceiro olho de outra família, com gate Claude-authoritative**: o auditor de segurança passa a rodar em **duas famílias** (Claude + Codex/GPT) nos checkpoints per-task (step 3b) e no final dual-review, merge **policy B** (achado de uma só família sobrevive a menos que a outra refute). Por ser um **gate** binário (`SECURE|UNSAFE`), o verdict é **Claude-authoritative**: um achado codex-only só escala o gate após o seu refute-pass do Claude — um `pendingClaudeRefutation` não-resolvido vira **precondição bloqueante no gate-state** (igual `regate-pending`). Assim um defeito real que só o Codex pegou ainda bloqueia (depois do Claude confirmar), mas um falso-high do Codex nunca vira UNSAFE espúrio por trás do orquestrador, e um refute-pass esquecido **bloqueia** em vez de passar silencioso. Dedup e `severity` **por-shape** (security não tem `category`; `Critical`/desconhecido→high conservador). Reverte a nota da v0.16.0 "security stays Claude-only" — `compliance` segue Claude-only (checa ACs do spec, não failure-modes gerais que uma 2ª família diversificaria).
- **`vendor-core` vendoriza o módulo `codex-adversary` (gated) — fecha o gap "não auto-vendorizado" da v0.16.0**: copia `modules/` → `.claude/modules/` quando `--with-codex` OU o módulo já está presente no target (um update **refresca** o opt-in em vez de deixá-lo stale). Default sem flag = nenhum módulo (safe default = sem codex). `*.test.mjs` excluído (o repo-fonte é a casa dos testes).
- **UX do `npx @orobsonn/claude-harness init` — pergunta o cross-check, sem nunca tocar no auth**: em TTY pergunta se quer o segundo olho (Codex/GPT); SIM vendoriza o módulo + liga o toggle `HARNESS_CODEX_ADVERSARY=1` em **`.claude/settings.local.json`** (per-machine, não-versionado, write atômico, fail-soft) + imprime o setup do Codex. Não-TTY (CI/headless) usa a flag explícita `--with-codex`; sem flag = init padrão. O `init` **nunca roda `codex login`** — o login na OpenAI é do operador.
- **Doc do setup do Codex (operador)**: README do módulo + `config.toml.example` com os fatos verificados na doc oficial do Codex CLI — install `@openai/codex` (Node 22+; nunca o `codex` cru), gotcha do `OPENAI_API_KEY` que **não** sobrescreve um login ChatGPT ativo (use `codex login --with-api-key`), config **por-projeto** `.codex/` (trusted, closest-wins) análoga ao `.claude/`, e skills em `.codex/skills/`.

### Changed

- **Portabilidade do módulo `codex-adversary` — resolve as fontes canônicas nos dois layouts**: `resolveCanonicalPath` tenta `REPO_ROOT/core/<rel>` (repo-fonte) e cai pra `REPO_ROOT/<rel>` (vendored, `.claude/agents/...` sem `core/`). Sem isso o módulo vendorizado quebrava ao resolver os role files. Validado ponta-a-ponta num projeto-teste (os 3 roles resolvem de `.claude/agents/`). O driver `driveCrossFamily` vira genérico por `role` (default `adversary`; também `security`) e é **embrulhado em fail-open real** — um defeito de path/compose degrada Claude-only em vez de throw fail-CLOSED. Paths de comando nas SKILL/CLAUDE/README reconciliados pro contexto vendored (`.claude/modules/...`).

### Fixed

### Removed

## [0.16.0] - 2026-06-30

### Added

- **Olhos cross-family (módulo opt-in `codex-adversary`) — um segundo olho de outra família de modelo (GPT via Codex CLI) nos checkpoints de julgamento**: o `adversary` (spec attack / per-task / final dual-review) e o `plan-reviewer` podem rodar em **duas famílias** — Claude + Codex/GPT — em paralelo, com merge dos achados (**policy B**: um achado de uma só família sobrevive a menos que a outra o refute; nunca voto majoritário) e, no plan-reviewer, **either-REVISE-wins**. Como as famílias falham diferente, a união cobre pontos cegos que nenhuma pega sozinha. **Opt-in e fail-open total**: OFF por default — o operador liga via `HARNESS_CODEX_ADVERSARY` (ou `adversarial.cross_family` por task); sem o módulo, switch off, headless sem `OPENAI_API_KEY`, ou `codex` indisponível → roda **Claude-only exatamente como hoje**, nunca bloqueia. O segundo olho é sempre read-only (`--sandbox read-only`) e Claude-tier (um olho, nunca uma mão barata). Compõe com o fan-out-join: o checkpoint `adversary` se alarga para 2 famílias *dentro* do mesmo membro do fan-out, com o merge resolvido no join. **Nota:** o módulo ainda não é auto-vendorizado para projetos (`vendor-core` copia só `core/`); por ora fica disponível no repo-fonte / operator-installed.
- **Revisão paralela dos olhos (fan-out-join) — entrega mais rápida sem tocar no trilho de segurança**: os olhos read-only que revisam o código (compliance + adversary + security), antes despachados em fila, passam a rodar **concorrentemente numa só leva de Agent calls (fan-out)**, com todos os verdicts coletados (**join**) antes do sniper — tanto na revisão per-task (Phase 2) quanto no final dual-review (Phase 3). O gargalo real de wall-clock é o `adversary` (Opus, lento); rodá-lo concorrente com compliance/security corta esse tempo. Seguro por construção: os olhos são read-only, não escrevem no working tree nem carimbam markers no gate-state, e são mutuamente independentes (adversary virgin, compliance lean) — o paralelismo não toca o trilho de segurança. Mantém a proibição de **background-and-poll** (verdict stale); o que se habilita é o **fan-out-join** (bloqueia até todos os verdicts finais chegarem). Mãos (executor/sniper/test-author) seguem seriais de propósito.

### Changed

### Fixed

- **Deadlock do `test-author` no fidelity-rail (LOCAL) — destravado**: o `test-author` (quem autora o teste travado RED, o oráculo do pipeline) é a *pré-condição* do `fidelity-pass`, mas era gateado pelo MESMO fidelity-rail que serve — bloqueado por todos os caminhos (spawn-hand exige um teste congelado que ele ainda nem criou; main-loop `Agent` exigia um ticket de escalação com run-record `FAILED` inexistente). Sem saída, o orquestrador escrevia testes e código na mão e auto-carimbava o `fidelity-pass` (violando "strong eyes, cheap hands" de ponta a ponta — observado ao vivo no `victor-pipeline-dados-bot`). **Conserto:** o `test-author` passa a rodar como **main-loop Claude Agent (sonnet)** em LOCAL e HEADLESS — espelhando o que o headless já fazia — com early-return no `entry-gate.mjs` antes do hand-routing rail (escopado a `role === "test-author"`; executor/sniper seguem gateados, sem enfraquecimento). Seus controles de segurança são o olho `compliance` (step 1b) + o content-hash do freeze (step 1c). O `fidelity-pass` segue intocado (veredito do compliance).

### Removed

## [0.15.0] - 2026-06-28

### Added

- **Hook de version-check (SessionStart/startup) — tira do operador o fardo de lembrar de atualizar o harness vendored**: novo `core/hooks/version-check.mjs`, wired em `core/settings.json` **apenas no matcher `startup`** (nunca `compact` — sem re-nag no meio de uma entrega). No início da sessão compara a versão vendored (`.claude/.harness-version`) com a última GitHub Release; se estiver atrás, emite um `systemMessage` (operator-facing, top-level) em pt-br oferecendo rodar `/updating-harness` e reiniciar. **Fail-open total**: sem rede / `gh` ausente / 404 / parse → exit 0, zero ruído. **No-op em headless** (`$CLAUDE_CODE_REMOTE` setado — a versão no cloud é pinada de propósito), checado antes de qualquer disco/rede. **Anti-falso-positivo**: normalização semver numérica que trata `vX.Y.Z`, git-describe `vX.Y.Z-N-gSHA` e SHA puro — "igual ou à frente da última tag" é em-dia (alarme falso treina o operador a ignorar o único sinal). Rede com `AbortSignal`/`--max-time 2` e cache `{tag}` gitignored com TTL de 6h (≤1 hit no GitHub por janela, protege o limite de 60 req/h). **Chicken-and-egg conhecido**: projetos vendorados ANTES deste hook só recebem o check após um `updating-harness` manual.
- **`npx @orobsonn/claude-harness init` — primeira adoção num projeto novo em UM comando**: novo pacote npm scoped `@orobsonn/claude-harness` (público, zero-dep, node builtins only) cujo `init` ENVOLVE (não reimplementa) o `vendor-core.mjs` — resolve a última release tag (gh→curl) e vendora o harness no `.claude/` do diretório atual, idempotente e non-clobber (memory/kaizen/settings preservados), estampando `.harness-version`. O guard do bin resolve symlink (`realpathSync`) porque o bin npm é symlinkado — sem isso o `init` rodaria como no-op.

### Changed

- **`vendor-core` ignora o cache do version-check nos consumidores**: o `.claude/.gitignore` gerado passa a incluir `.harness-version-check-cache`, então o arquivo de cache do hook nunca é commitado em projetos vendorados.
- **`detect-stack` reconhece node-test mesmo com `package.json` presente**: antes, qualquer `package.json` sem `vitest`/`jest` caía em `skip`; agora um `scripts.test` que invoca `node --test` é detectado como runner `node-test`. Necessário porque o próprio repo passou a ter `package.json` (pelo bin do npm) sem deixar de ser um projeto `node:test`.

## [0.14.4] - 2026-06-27

### Added

- **Disciplina de conserto na raiz (bug fix audita todos os chamadores)**: ao planejar uma correção de bug, o planner passa a confirmar que `scope_paths` cobre **todos os chamadores** da função compartilhada — dimensiona o conserto na raiz, não no call site nomeado pelo ticket. O adversary ganha um alvo explícito: o **ponto cego de chamador irmão** (fix que arruma um caminho e deixa outro chamador da mesma função quebrado). Fecha o gap onde nenhuma rule/agente cobria o diagnóstico sintoma × raiz para bug fix — só roles Opus (planner + adversary), mãos baratas intocadas.
- **Alvos de detecção de over-engineering no `code-quality.md`**: novo gotcha nomeando as formas clássicas de excesso para o compliance pegar — stdlib reimplementada à mão, dep que duplica feature nativa da plataforma (`Intl`/`URL`/`crypto`/`fetch`), flag/config morto. Fecha os degraus stdlib/nativo que a regra não tornava explícitos; fraseado como alvo de **detecção**, nunca ordem de corte por cota. Origem: análise multi-modelo do repo `ponytail` (2 de 8 candidatos sobreviveram à crítica adversarial).

## [0.14.3] - 2026-06-27

### Fixed

- **entry-gate: piso de branch protegida agora cobre o default branch real do origin, não só main/master**: ao entregar (`git push`/`gh pr create`/`gh pr merge`) direto do branch default do repo, o gate só barrava quando o default era `main` ou `master`. Em repo cujo default é `develop`/`trunk`, a entrega direta escapava do piso e reaparecia como o falso "zero commits ahead" (após push, `origin/<default>==HEAD`). `computeGitState` passa a derivar e retornar `defaultBranch` (nome bare de `origin/HEAD`, com fallback `origin/main`→`origin/master`), e o piso barra `main`, `master` ou o default real resolvido. Match exato (não substring), `typeof` guard para back-compat, fail-open preservado (default não-resolvível → piso volta a só main/master). Limitação conhecida documentada no JSDoc: quando `origin/HEAD` não está setado e o default real difere de main/master, o fallback por existência pode mis-derivar — resolução via `git ls-remote --symref` deixada como follow-up (evita rede num gate quente).

### Removed

## [0.14.2] - 2026-06-27

### Added

- **Convenção de issue form sempre carregada + advisory determinístico**: nova rule universal `core/rules/creating-issues.md` (carrega toda sessão, sem `paths:`) instrui a criar issues pelo form do repo (`.github/ISSUE_TEMPLATE/harness-task.yml`) — título `[harness] <slug>`, label `harness:ready`, campos `#uj`/`#ac`/scope/sensitive/priority/size que viram spec/locked_tests/scope_paths — em vez de `gh issue create` com corpo manual (o `gh` CLI ignora issue forms silenciosamente). Reforço determinístico dobrado no `entry-gate.mjs`: ao detectar `gh issue create` bare num repo que vendora o form, emite um aviso não-bloqueante (`additionalContext`, sem `permissionDecision` — nunca barra, nunca auto-aprova) apontando pro form. O advisory anexa só no caminho de allow não-delivery, então um comando composto com `git push` continua caindo nos trilhos de delivery. Propaga automático no re-vendor (rules/ e hooks/ são framework-owned), sem mudança em `settings.json`.

## [0.14.1] - 2026-06-27

### Fixed

- **entry-gate: falso "zero commits ahead of base" bloqueava delivery legítimo**: `defaultGitState()` resolvia a base do cálculo de "commits à frente" como o upstream do próprio feature branch (`@{u}`). Após `git push`, o upstream aponta para o mesmo commit que `HEAD`, zerando `@{u}..HEAD` e produzindo um deny falso que travava `git push` / `gh pr create` mesmo com commits reais à frente da main. A base passa a ser sempre o default branch do origin (`origin/HEAD` → `origin/main` → `origin/master`), contada via `rev-list --count <base>..HEAD`; nunca mais `@{u}`. Contrato fail-open preservado (base não-resolvível → `commitsAhead` null → nunca barra). Lógica de resolução extraída para `computeGitState(git)` puro/exportado e coberta por locked tests (AC-CORE: `upstream==HEAD` mas ahead-of-default > 0 → permite).

### Removed

## [0.14.0] - 2026-06-27

### Added

- **CI por projeto + gate de CI verde antes do release**: geração de `.github/workflows/ci.yml` com detecção de stack (node-test/vitest/jest); helper de branch protection (GET-then-merge, `enforce_admins=false`, sem review, required check = nome do job gerado) aplicado de forma operator-gated (`--apply`) para exigir o job de CI como check obrigatório; gate no fluxo de release que recusa tag enquanto CI estiver vermelho ou pendente (`gh pr checks --json state`). Modelo de 2 jobs fork-safe (job obrigatório sem secret + job de secret que pula em fork/Dependabot). Regra global aditiva (mandatory para projetos novos, advisory para existentes). Dogfooded no próprio harness com workflow real (CI verde no PR).

### Changed

### Fixed

### Removed

## [0.13.0] - 2026-06-26

### Added

- **Trilho de fidelidade (fidelity rail)**: o executor (mão barata) só é despachado depois que existe um teste escrito pela mão-de-teste e validado pelo compliance — congelado. Vale no modo local (spawn-hand) e na nuvem (headless). Fecha o furo em que a mão barata escrevia o próprio gate.
- **brief-serializer**: o briefing do executor passa a ser montado deterministicamente a partir da fatia do plano (spec, decisões, escopo, critérios, asserções) + fatos validados de tarefas anteriores — sem o orquestrador escrever código ou teste à mão.
- **descriptor-emitter**: a "ordem de serviço" da mão barata e o SHA do freeze são emitidos automaticamente no freeze-commit, eliminando a tentativa-e-erro de montar o descriptor na mão.
- **Marcador `fidelity-pass`**: sinal em disco que o gate consome para liberar o executor após o teste congelado passar pela validação de fidelidade.

### Changed

- **Princípio de relay no orquestrador**: a regra "o orquestrador não gera nada" foi substituída pela regra real e estreita — ele não autora código nem teste, apenas repassa a fatia do plano já validada por olhos/mãos mais fortes. O teste congelado é o oráculo concreto.

### Fixed

### Removed

## [0.12.0] - 2026-06-26

### Added

### Changed

- **hand_tiers com modelos Ollama reais**: a escada de exemplo da `creating-plans` passa a `qwen3-coder-next` (low) / `glm-5.2` (medium) / `kimi-k2.7-code` (high) — modelos que existem no endpoint Ollama. A skill agora exige que os ids do `hand_tiers` existam no endpoint (como listar) e avisa pra evitar `gpt-oss:*` (tool-use quebra em loop agêntico).

### Fixed

- **plano no formato legacy (Claude tiers) passava silenciosamente e quebrava no dispatch (404)**: a validação que rejeita o `model_strategy.tiers` legacy não era determinística (dependia do planner rodar `validate-plan`). Agora há cancela em duas camadas: (1) guard no `spawn-hand` — um model que é alias Claude (haiku/sonnet/opus) indo pro Ollama falha com razão clara em vez de 404 críptico; (2) o `plan-write-gate` valida o `model_strategy` no Write do plano e rejeita o shape legacy/sem `hand_tiers` antes de virar arquivo.
- **mão barata acusada de scope violation por arquivos untracked pré-existentes**: o `capture-hand` atribuía ao hand lixo de build pré-existente (dist/, coverage/, *.tsbuildinfo gitignored) que o clean-check (`git status --porcelain`) não enxerga mas o sweep `ls-files --others` enxerga. Agora um snapshot pré-spawn (path+hash) desconta os untracked pré-existentes **inalterados**; um arquivo novo ou um pré-existente **editado** (tamper) segue sinalizado — o controle de segurança fica intacto.
- **planner.md instruía salvar o plano como `plan.json`**, nome que o orquestrador/gate/reinject não leem (todos usam `execution-plan.json`). Reconciliado.

### Removed

## [0.11.0] - 2026-06-26

### Added

### Changed

- **cheap hands é LOCAL-only / HEADLESS roda hands em Claude**: em modo headless (`$CLAUDE_CODE_REMOTE` setado) o orquestrador não invoca o `spawn-hand.mjs`; despacha executor/sniper/test-author como `Agent` Claude normal, e o entry-gate passa a permitir Agent de role HAND nesse modo. Token Ollama ausente no cloud deixa de ser `hand-config-error` (vira não-evento). SKILL.md atualizado.
- **cheap hands (resolução de token)**: a fonte de token local passa a ser a env var `OLLAMA_HAND_TOKEN` (`export` no shell rc). Leituras de env sobrevivem ao command-sandbox; um token só no `.dev.vars` **não** é lido (o sandbox nega leitura de `.dev.vars`). O nome é inerte à auth do próprio Claude Code — `ANTHROPIC_AUTH_TOKEN` sequestraria a sessão-pai. `resolveAuthToken` aceita `OLLAMA_HAND_TOKEN` (preferencial) e `ANTHROPIC_AUTH_TOKEN` (compat/headless); `.dev.vars` segue como fallback; o childEnv mapeia pra `ANTHROPIC_AUTH_TOKEN`. SKILL.md atualizado.
- **entry-gate**: a mensagem de bloqueio de role HAND agora instrui o orquestrador a rodar `spawn-hand.mjs --descriptor` pra obter a `reason` exata do config-error (exit 2) e proíbe explicitamente inventar causa — em especial concluir que "spawn-hand.mjs não existe" (o script é vendored; o que falta quase sempre é o token). Aponta o fix (`export OLLAMA_HAND_TOKEN`).

### Fixed

- **mão barata nunca rodava sob o command-sandbox**: o `spawn-hand` despachado pelo orquestrador roda sob o sandbox, cujo `denyRead: ["**/.dev.vars"]` bloqueava o `resolveAuthToken` de ler o token → exit 2 "no ANTHROPIC_AUTH_TOKEN resolved" → caía em implementação inline silenciosa com mensagem enganosa, mesmo com o token presente no disco. Resolvido movendo a fonte do token pra env (`OLLAMA_HAND_TOKEN`), que o sandbox não bloqueia. Validado end-to-end (sob sandbox: `.dev.vars` falha, env passa).

### Removed

## [0.10.0] - 2026-06-26

### Added

- `triaging-requests`: QUICK ganha a porta `craft` — via rápida para artefatos visuais auto-contidos (página/quiz/landing/componente) roteados ao skill artesanal, pulando o pipeline pesado (executor→compliance→adversary→sniper). Mantém os trilhos determinísticos: glob da lista sensível nos arquivos tocados (substitui o override de `scope_paths`, ausente sem planner) + gates `tsc`/lint/build antes do commit. Override é **só-escala** ("caprichada/revisada" sobe pra LIGHT; "rápido" nunca rebaixa pedido sensível). Captura de lead no padrão do skill é pré-vetada; endpoint/integração nova escala pra LIGHT.

### Changed

### Fixed

### Removed

## [0.9.2] - 2026-06-17

### Added

### Changed

- Resolução de auth da mão barata é responsabilidade exclusiva do `spawn-hand.mjs` (env → projeto `.dev.vars` → global `~/.claude/.dev.vars`). O orquestrador não pré-checa nem inspeciona `.dev.vars`, e o token Ollama passa a ser tratado como precondição de setup (global no local, env secret no HEADLESS) — não algo a descobrir por task.
- Qualquer `exit 2` do `spawn-hand.mjs` vira exceção crítica citando o `reason` verbatim; o orquestrador não classifica a causa.

### Fixed

- `planner.md` dizia que o executor escreve o arquivo de teste (desatualizado no v2). Agora reflete que o `test-author` transcreve o teste e o executor o recebe read-only — eliminando a confusão de dispatch que levava o modelo a tentar `Agent` para criar testes.
- Falha de gate (captura via `capture-hand.mjs`) nunca é dispensada como "ambiental/sandbox" pela mensagem de erro — sempre escala. Fecha o falso-negativo em que uma falha real seria silenciada por um stack-trace que mencionasse `.dev.vars`.

### Removed

## [0.9.1] - 2026-06-15

### Added
- **Nova rule `architecture`** (carrega quando há código em `src/`, `app/` ou `worker/`): guia de fronteira de domínio que o harness não cobria — handler fino, tradução na borda (Anticorruption Layer, ex. integrações Stays/Meta), isolamento de shape (tipo de domínio ≠ linha de banco ≠ payload de terceiro), value object no lugar de obsessão primitiva, e lógica-junto-do-dado (sem modelo anêmico). Modelagem rica é condicional — o default é flat. Auto-carrega nativamente até na mão Ollama barata (`claude -p`).

### Changed
- **`plan-reviewer` audita fronteira de domínio e modelagem no tempo de plano** (keyed por severidade): a tradução de formato externo está isolada num task de borda ou vaza shape de terceiro pro core? Um task de alta severidade com invariante multi-passo está modelado rico ou espalhado num service anêmico? Numa feature flat, há camada especulativa sem core que a justifique?
- **Doc do `executor` corrigida:** descrevia o modo `--bare` aposentado. A mão barata roda como `claude -p` no cwd do projeto, então `CLAUDE.md` e rules do projeto **auto-carregam** nativamente — só skills (sem tool `Skill`) e o config global `~/.claude` (`CLAUDE_CONFIG_DIR` efêmero) não chegam.

## [0.9.0] - 2026-06-14

### Added
- **A mão Ollama barata agora dispara de verdade (wiring do live spawn — Part A).** Novo `runLiveDispatch(descriptor, {…})` em `spawn-hand.mjs` é a costura que faltava entre o andaime e o dispatch real: valida o descriptor, fail-close se o token vazar no descriptor/brief, reconcilia os dois universos git (árvore limpa + HEAD ancorado ao freeze, pra captura unscoped atribuir só o trabalho da mão), sobe `claude -p` ao vivo contra `https://ollama.com` (token só no env, `CLAUDE_CONFIG_DIR` efêmero), roda a captura INDEPENDENTE e grava um run-record sem token keyed por `feature_id/task_id`. Um CLI rodável (`node spawn-hand.mjs --descriptor <descriptor.json>`) + o comando exato e a receita do descriptor no `SKILL.md` (passos 1d/5) substituem o roteamento só-em-prosa que era a causa do bug never-fire (sessão `7fcc1009` do victor: 0 `claude -p`, 15 `escalation-fallback`). **Provado ao vivo:** a mão (`qwen3-coder-next`) autorou o diff in-scope e o teste congelado ficou verde na captura independente (`outcome DONE`).
- **Marker `hand-config-error`** (`mark.mjs` + `stamp-triage.mjs`, com `--reason` opcional) pro orchestrator carimbar um erro de config pré-spawn na rota de exceção crítica. Nunca autoriza uma mão Claude.

### Changed
- **O escape da mão barata agora se apoia em evidência on-disk não-forjável (Part B).** O branch de hand-routing do entry-gate antes liberava um `Agent(executor|sniper|test-author)` Claude no main-loop sempre que QUALQUER ticket `escalation_fallback` não-vazio existisse (forjável por echo). Agora libera o fallback Claude SÓ quando um ticket mapeia para um run-record on-disk (escrito pela captura independente do `runLiveDispatch`) cujo `outcome` é uma run genuína não-DONE (`FAILED` ou `NOT_DONE`), ancorado ao `freeze_commit_sha` e cruzado com o `HEAD` corrente — um record estale não autoriza uma escalação posterior que não falhou.
- **Escape de config-error explícito (contrato de exit-code).** `runLiveDispatch` RETORNA só em run genuína (record gravado) e LANÇA caso contrário, então o CLI classifica: `0` = DONE, `1` = `FAILED`/`NOT_DONE` genuíno (escalação K=1, autorizada pelo record on-disk), `2` = erro de config pré-spawn / exceção crítica (emite `{configError:true}`). O orchestrator roteia exit `2` pra exceção crítica — nunca um fallback Claude calado, nunca trava. Impede que token ausente trave a entrega.

### Fixed
- **Crash latente em `capture-hand.mjs`:** o CLI usava `readFileSync` sem importá-lo de `node:fs` — teria lançado `ReferenceError` no instante em que a captura ao vivo rodasse pelo CLI.

## [0.8.0] - 2026-06-14

### Added

### Changed
- **BREAKING: `hand_tiers` is now the only valid `model_strategy` shape.** The planner emits `hand_tiers` exclusively (cravado ladder `glm-5.1` → `deepseek-v4-pro` → `kimi-k2.7-code`), and `validate-plan` requires it. Previously the legacy Claude-only `tiers` shape was still accepted (validate-plan only warned), which let the executor/sniper silently resolve to expensive Claude and defeated the cheap-hands default — the root cause of plans that never routed hands to Ollama. A Claude hand is still reachable for a sensitive task by putting a Claude alias directly in a `hand_tiers` tier (values are free-form model ids; eyes still must be Claude aliases).

### Fixed
- **`settings.test.mjs` hook-count assertion was stale.** It expected exactly 5 wired hooks, but the `Write|Edit → plan-write-gate.mjs` PreToolUse hook added in the deterministic-rails work (#21) made the real count 6. The test now asserts 6 (it had been failing since #21).

### Removed
- **Legacy Claude-only `tiers` `model_strategy` shape.** `validate-plan` now hard-rejects a plan carrying `tiers` (clear error pointing to `hand_tiers`); `tiers` is dropped from `ALLOWED_MS_KEYS` and the back-compat prose is removed from `creating-plans`/`planner`/memory. Old archived plans authored with `tiers` no longer validate — they are historical artifacts and are not re-validated.

## [0.7.1] - 2026-06-14

### Added
- **Branch/commit delivery rail.** The push-gate (`entry-gate` `decideBash`) now denies a delivery command (`git push` / `gh pr create` / `gh pr merge`) when `HEAD` is on `main`/`master`, or (when a base ref resolves) when there are zero commits ahead of base — forcing the per-task commit series onto a feature branch, off protected `main`. The git probe is injected at the `processInput` (production) layer with a `decide()`-level no-op default, so it's live in the CLI but inert for unit callers; fail-open on any git error or unresolvable base. Closes the "uncommitted work / everything on main, yet still trying to deliver" gap — the rest of the per-task discipline (the freeze/impl split) is already load-bearing via the capture rail.

## [0.7.0] - 2026-06-14

### Added
- **Deterministic delivery rails — pipeline steps that were prose are now state-machine checks.** Four points where the orchestrator could silently skip a pipeline step ("the orchestrator must remember to…") became deterministic gates over `gate-state.json`, the same pattern already used for triage/planner/shipper:
  - **Plan-authorship rail** (`hooks/plan-write-gate.mjs`, new `PreToolUse(Write|Edit)` hook): only the dispatched `planner` subagent may write/edit a feature's `execution-plan.json`; the main-loop orchestrator is denied. Also blocks any tool write to `.claude/plans/.state/*.json` (gate-state/triage are hook-owned).
  - **Ollama hands as default**: `validate-plan` now warns (never rejects) on legacy Claude-only `tiers`, and `creating-plans`/`planner` emit the split `hand_tiers` ladder by default (`glm-5.1` → `deepseek-v4-pro` → `kimi-2.7`).
  - **Hand-routing rail** (`entry-gate.mjs`): a main-loop `Agent(executor|sniper|test-author)` is denied unless an `escalation_fallback` ticket exists — hands must route through `spawn-hand` (Ollama); the Claude `Agent` path is only the K=1 escalation/transcription fallback. New `mark.mjs escalation-fallback` marker stamps the ticket.
  - **Independent-capture rail** (`entry-gate.mjs` delivery-bash-gate): a delivery command is denied while any `hand_finished` task lacks a matching `capture_verified`. New `mark.mjs hand-finished`/`capture-verified` markers, routed through `stamp-triage` so Claude Code supplies the one authoritative `session_id` to producer and consumer.

### Changed
- **`test-author` reconciled as the third Ollama hand** (alongside `executor`/`sniper`): the agent doc and the "Hands vs Eyes" taxonomy now describe a spawn-hand (Ollama) hand resolving from `hand_tiers`, and the hand-routing rail gates it like the other hands.

### Fixed
- `resetGateState` now preserves `hand_finished`/`capture_verified` across a re-triage — the capture rail is a session-level delivery obligation like the re-gate rail, so a mid-session reclassify can no longer launder an un-captured hand.
- `plan-write-gate` path matching is case-insensitive (the operator's darwin FS is case-insensitive), closing an `Execution-Plan.json` / `.Claude/` bypass.

### Removed

## [0.6.2] - 2026-06-13

### Fixed
- **Path-coverage convention unified on git-pathspec (`isPathCovered`).** The pre-spawn baseline guard scopes via `git status --porcelain -- <entry>` (git pathspec = directory prefix by path component), but `isPathCovered`/`checkScope` treated an entry WITHOUT a trailing slash as an **exact file match**. For a no-slash directory entry (e.g. `core/x`) the two diverged — the guard covered files under it by prefix while the capture scope check demanded an exact match — yielding a dispatch that **always** failed in capture (fail-closed, but a confusing latent trap). `isPathCovered` now normalizes every entry to git-pathspec component semantics (`path === base || path.startsWith(base + "/")`), so a directory entry covers identically **with or without** the trailing slash — one source of truth shared by the guard, `checkScope`, `checkAllowedWrites`, and `checkFrozen`. The path-component boundary keeps `core/x` from bleeding into a sibling `core/xyz`, matching git. Out-of-contract pathspec MAGIC (`.`, glob `*`, empty entry) is explicitly **not** honored and fails closed in the violation checks. Adds `locked_test #7` proving consistent coverage of a no-slash directory entry and the fail-closed empty-entry behavior. (#17)

## [0.6.1] - 2026-06-13

### Added
- **Global Ollama token resolution.** A new `resolveAuthToken` resolves the cheap-hand auth token across `env.ANTHROPIC_AUTH_TOKEN` → `<cwd>/.dev.vars` → `~/.claude/.dev.vars` (global), so the operator sets the token **once** in `~/.claude/.dev.vars` and every project's cheap hand finds it — without exporting `ANTHROPIC_AUTH_TOKEN` into the shell (which would hijack Claude Code's own subscription auth). The token is still read-only from disk and injected only into the child process env. Aligns all three readers (dispatch/spawn/capture) on the same resolver.

### Changed

### Fixed

### Removed

## [0.6.0] - 2026-06-13

### Added
- **"Strong eyes, cheap hands" v2 — live Ollama dispatch (the plug is now wired).** v1 shipped the brain + rails; v2 launches the cheap hand for real and proves it end-to-end against ollama.com. Ships:
  - `spawn-hand.mjs` — the live spawn: `claude -p` (NOT `--bare`) against `ANTHROPIC_BASE_URL=https://ollama.com` with the auth token in the **child env only** (never argv/brief/settings), an **isolated ephemeral `CLAUDE_CONFIG_DIR`** seeded from the Stop-hook template, and the brief delivered to the hand via **stdin** (the user prompt). Fail-closed before spawn: refuses without an armed gate (locked_test must exist, be a file, and a dry-run must collect ≥1 test), without a resolved token, or onto a scope-dirty baseline.
  - `capture-hand.mjs` — the **independent capture (gate of record)**: the harness — never the model's prose — builds the child result from `git diff --name-only <freeze_sha>` ∪ `git ls-files --others` (+ a no-exclude sweep so a gitignored write can't escape scope/frozen/allowed-write), an **independent** `node --test` run with a vacuous-green guard (last anchored `# tests N`; 0/missing → FAILED), a `HEAD == freeze_sha` precondition, a required token (redaction is never a silent no-op), and live-tee + on-disk redaction. Feeds the v1 fail-closed `evaluateRun`.
  - `hand-config/` — the Stop-hook `CLAUDE_CONFIG_DIR` template + a pure `resolveHookCommand` (absolute `node --test <path>`, never `${CLAUDE_PROJECT_DIR}`); reaches consumers via vendor-core's recursive `skills/` copy (pinned by an exported `isFrameworkCopyIncluded` predicate).
  - `derisk-metrics.mjs` — pure cost-NDJSON parser (`toolCallErrorCount`, `gpuTimeMs`, `contextTokens`) — the data-driven signal to retire a net-negative cheap tier.
  - `dispatch-hand.mjs` hardened: a benign Ollama `count_tokens` 404 is forgiven across the stdout/json channels while a co-occurring real upstream error (5xx/401/403/429) is never swallowed; captured stdout/stderr are truncated (redact before truncate).
  - **Live-proven (AC v2.1):** a `qwen3-coder-next` hand implemented a real task, landed a correct diff that passed its frozen test with scope respected, and the independent capture stamped `captured:true` → DONE.

### Changed
- `orchestrating-delivery` Phase 2 wiring: **all hand roles route to the live Ollama spawn** — executor (low/medium/**high**) and sniper (all severities) — with only eye roles staying on Claude; Claude is reachable by a hand only via the K=1 escalation fallback. Executor-high resolves to `hand_tiers.high`, with the AC v2.7 de-risk metering as the data-driven revert trigger (supersedes the deferred v3 model A/B by operator decision). The sniper-HIGH mandatory strong-eye re-gate + `regate-pending`/`regate-passed` rails are unchanged. The spec's `--bare` is corrected to `claude -p` + isolated config everywhere (`--bare` skips hooks, which would kill the Stop-hook gate).
- **Model routing:** Fable 5 retired — the two boundary gates (plan-reviewer, final-gate adversary) fall back to opus; `fable` removed from the validator's `CLAUDE_ALIASES`.

### Fixed

### Removed

## [0.5.0] - 2026-06-12

### Added
- **"Strong eyes, cheap hands" v1 — scaffold, rails, gates, and docs.** Code-writing roles (executor, sniper, new `test-author` agent) can be routed to cheap Ollama-cloud models via `claude --bare -p` external dispatch, while judging/review roles stay on Claude. Ships:
  - `model_strategy` split: validator gains `hand_tiers` (Ollama model ids keyed to low/medium/high) vs eye roles (always Claude); back-compat with legacy single-`tiers` plans; unknown keys rejected; eye→Ollama enforced + table-driven test covering all 7 eye roles.
  - `dispatch-hand.mjs` — external-process runner (pure functions + CLI): token redaction, per-dispatch allowed-write set, scope-check (truth = git diff + `captured:true` flag, never model prose), fail-closed on missing capture, frozen-manifest violation = automatic gate failure, upstream errors truncated to 500 chars after redaction.
  - Deterministic test rail: planner pins concrete-observable assertion → `test-author` (cheap hand, tools exactly `[Read, Write]`) transcribes ONE assertion into ONE test file → compliance (Claude eye) validates fidelity pre-freeze → content-hash manifest frozen → executor implements against read-only frozen test → Stop hook gates on green (documented v2 artifact; v1 ships the contract and rail).
  - Sniper → cheap Ollama hand + mandatory strong-eye (Claude) re-gate rail: `mark.mjs` markers → `stamp-triage` persists `regate_pending` → entry-gate blocks both the shipper Agent dispatch and direct Bash delivery while a re-gate is outstanding; survives compaction.
  - Executor escalation: re-dispatches the executor (never sniper), stash-discard the failed attempt; per-task commit series (freeze-commit → impl-commit) makes reset trivially safe.
  - `core/dev.vars.example` placeholder added; `vendor-core` REPO_FILES distributes `.dev.vars.example` to consumer projects; `.dev.vars` gitignored at repo root and ensured-ignored in consumer projects via `ensureDevVarsIgnored`.
  - Migration/SQL rule in `creating-plans/SKILL.md`: locked_test on a cheap hand must spin an ephemeral DB and assert post-migration state — not a text-match.
  - Design decisions (no git worktree in v1; working-tree + per-dispatch allowlist as the containment boundary) documented in `core/CLAUDE.md` compact instructions.
  - **v2 next step:** live `claude --bare -p` spawn integration and the Stop-hook binary are the documented v2 deliverables; v1 ships the contract, rails, scaffold, gates, and docs.

### Changed

### Fixed

### Removed

## [0.4.1] - 2026-06-11

### Added
- **Skill `updating-harness`** — atalho de uma chamada para instalar/atualizar o harness no projeto atual, com a URL do repo-fonte embutida (sem copiar/colar URL). Detecta install-vs-update, fixa na última release do GitHub (`--ref <tag>`), reporta o que mudou e re-vendora via `vendor-core` sem clobberar memória/kaizen/settings.

## [0.4.0] - 2026-06-11

### Added
- **Medidor de custo na entrega** — skill `measuring-cost` (invocada pelo harvester) reporta o custo equivalente-API da sessão com breakdown por modelo + a tendência semanal de consumo do Claude Code (todos os projetos), via `ccusage` sobre o transcript JSONL local. Fail-soft quando ccusage não está acessível (offline / cloud headless). Não persiste números em arquivos commitados — é telemetria de run, não conhecimento durável; o medidor semanal é proxy relativo de consumo real, nunca % da subscription (opaca).

## [0.3.0] - 2026-06-11

### Changed
- **Estado efêmero de sessão movido para `.claude/plans/.state/<session_id>/`** — `gate-state.json` e `triage.json` saem da raiz de `plans/` para uma subpasta pontilhada, deixando a listagem de `.claude/plans/` com apenas as pastas legíveis por feature (`<feature_id>/`). O plano durável continua keyed por `feature_id` na raiz, preservando a resiliência (artefato insubstituível atrás de chave re-derivável, não do `session_id` opaco). O GC do `reinject-state` passa a escanear só `.state/`.
- **Orquestrador Sonnet cravado como default** — removida a marcação "under validation" da tabela de model routing; documentado em `docs/usage.md`. A economia do harness vem do orquestrador barato no alto volume; premium (Opus/Fable) só nos sub-agentes de fronteira, sustentado por trilhos determinísticos.

### Fixed
- **Orquestrador atalhava `creating-plans` em vez de dispatchar o `planner`** — com Sonnet no main loop, a skill interna do agente planner (sempre Opus) era invocada direto, gerando o plano no orquestrador e perdendo o isolamento de contexto e o routing de modelo. Guard `<PLANNER-ONLY>` no topo do `SKILL.md` + `description` marcada INTERNAL forçam o dispatch do agente `planner`.

## [0.2.1] - 2026-06-11

### Fixed
- **Gate silenciosamente inerte em path com espaço/symlink** — o guard de CLI dos hooks comparava `import.meta.url` (URL-encoded, símlinks resolvidos) com `file://${argv[1]}` (cru); num projeto cujo caminho tem espaço (`/Users/x/My Project`) ou está atrás de symlink, `main()` não rodava e o hook liberava tudo (falsa sensação de proteção). Agora usa `fileURLToPath` + `realpathSync`. Coberto por teste de integração que executa o hook como CLI real.
- `triage.json` passa a usar tmp-path com sufixo de pid na escrita atômica (consistência com o `gate-lib`, evita colisão concorrente).

## [0.2.0] - 2026-06-11

### Added
- **Trava determinística de entrada (entry-gate)** — interlock de runtime via hooks do Claude Code que força a cerimônia do harness (triagem → brainstorm → spec-adversary → plano) mesmo com um orquestrador Sonnet mais fraco no comando. Componentes em `core/hooks/`:
  - `entry-gate.mjs` (PreToolUse `Agent`): bloqueia dispatch de papéis de entrega sem `triage.json`; bloqueia o `planner` sem `brainstormed` + `adversary_fired`. Fail-open em erro de infra; só age no main-loop (ignora chamadas com `agent_id`).
  - `stamp-triage.mjs` (PostToolUse `Bash`): carimba `triage.json` com `session_id` autoritativo do payload e registra `brainstormed`; reconhece os marcadores `classify.mjs`/`mark.mjs` (desembrulha `tool_output.stdout`).
  - `classify.mjs` / `mark.mjs`: CLIs de marcador que o modelo roda ao fim da triagem / do brainstorm.
  - `reinject-state.mjs` (SessionStart `compact`/`startup`): re-injeta o estado do plano após compactação (recuperabilidade pro Sonnet) e faz GC conservador de dirs de estado obsoletos.
  - `lib/gate-lib.mjs`: validadores compartilhados (`isSafeFeatureId`, `isSafeSessionId`, `isDeliveryRole`, `bareRole`) + I/O atômico de `gate-state.json` (read-merge-write temp→rename).
- Seção `# Compact instructions` em `core/CLAUDE.md` (compactação harness-aware).
- Hooks vendorados pra projetos adotantes (`vendor-core.mjs` passa a copiar `core/hooks/`, excluindo `*.test.mjs`).
- Baseline de release: `CHANGELOG.md`.

### Changed
- `complexity-scorer.mjs`: recalibrado com a lógica otimizada do harness OpenCode (await-only, sem else/case, dirs ancorados, caps de import/serviço, `LINES_PER_POINT` 50), preservando o contrato de 4 bandas (low/medium/high/x-high) do Claude Code.
- `orchestrating-delivery/SKILL.md`: spec-adversary agora é **obrigatório em ambos LIGHT e FULL** (antes o FULL adiava pro per-task); Phase 0 termina com o marcador `brainstorm-done`.
- `triaging-requests/SKILL.md`: passo final roda `classify.mjs` (carimba o `triage.json`) antes do dispatch de entrega.

## [0.1.0] - 2026-06-10

### Added
- Marco inicial do Claude Harness (entry policy, agents, skills, rules, modelo de memória, model routing barbell).

[Unreleased]: https://github.com/orobsonn/claude-harness/compare/v0.26.0...HEAD
[0.26.0]: https://github.com/orobsonn/claude-harness/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/orobsonn/claude-harness/compare/v0.24.0...v0.25.0
[0.2.0]: https://github.com/orobsonn/claude-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/orobsonn/claude-harness/releases/tag/v0.1.0
