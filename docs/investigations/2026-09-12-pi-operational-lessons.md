# Pi: aprendizados operacionais até 3.0.0

Consolidado em 12/09/2026. Memória do **repositório-fonte**, não template de
consumidor nem nova política. Claude Code é a referência: adaptar somente
fronteiras concretas do Pi. Julgamento na prosa, determinismo em segurança,
identidade, schema e proveniência. Sem quotas de tasks, rodadas ou contraprovas.

O [relatório quantitativo](2026-09-12-pi-v3-validation.md) registra custos,
sessões, regressões e limites. Este guia preserva procedimentos reutilizáveis que
também estavam nos relatórios temporários da VPS. Casos individuais são históricos:
onde dizem “release pendente”, consultar o fechamento posterior, não repetir a entrega.

## Diagnosticar antes de retomar

Registrar versão do pai e de cada filho, session ID, attempt, HEAD, captura,
último evento nativo e obrigação realmente pendente. Conferir processos e CI:
ausência de texto durante comando longo não prova travamento. Nunca editar
gate-state, receipt, plano congelado ou pin do filho para destravar.

| Sintoma | Menor ação correta | Evitar / preservar |
| --- | --- | --- |
| Upstream de task corrigido | Pai usa `harness_tasks resume`; dependência é reconciliada no host antes do filho. | Não pedir merge/rebase/cherry-pick ao filho nem exigir integração prévia do consumidor bloqueado. |
| PR conflita em MEMORY após outra run | Pai global usa `harness_memory reconcile`: SHAs completos atuais, preview e resolução pequena hash-bound. | Conflito só em memória não significa delta upstream só em memória. Produto upstream exige testes/olhos finais atuais. |
| Task integrada reaberta só por entrega | Inspecionar `harness_tasks abandon-resume` antes de incorporar outra base, apenas sem correção real pendente e com integração histórica válida. | Novo parecer negativo/identidade inválida devem recusar. Não apagar tentativa/custo ou restaurar olhos finais antigos. |
| LIGHT tem captura válida, nenhum olho obrigatório e marker pendente | Inspector v2.6.25 reconhece obrigação vazia satisfeita; consultar status/integrate nativos. | Não inventar reviewer/approval para limpar marker. FULL e reviews realmente despachados continuam obrigatórios. |
| Produto pronto, fixture/evidência quebrada | `DONE_WITH_CONCERNS`; correção test-only focal quando necessária, commit → capture → reviews afetados. | Não chamar writer por “atualidade”. Duas recuperações test-only consecutivas são legítimas; não esconder bug mudando assertion. |
| TUI aceita envio mas run não avança | Confirmar novo input/tool event no JSONL. Se precisar encerrar, parar somente aquele pai e reabrir com UUID exato via `--harness-resume`. | Nunca dois pais na mesma sessão/worktree. ACK de send/focus não prova execução ou foco visual. |

Fontes: [dependências](2026-09-11-pi-reconciliation-barrier.md),
[test-only](2026-09-11-pi-test-only-reconciliation.md),
[fixture](2026-09-12-pi-fixture-recovery.md),
[merge global/abandono](2026-09-12-pi-delivery-memory-conflict.md),
[LIGHT](2026-09-12-pi-light-regate.md),
[reconcile pré-review](2026-09-12-pi-pre-review-reconcile.md).

## Planejamento e revisão

- Scorer recebe **path de arquivo real**, com a mesma lógica `analyzeSource` do
  Claude. Score do arquivo inteiro é aproximação, não classificação automática do
  delta. Na #207, arquivo high e task medium de um predicado eram coerentes.
  `should_split` é advisory: decompor max novo; high pode manter invariante
  atômica justificada. Não criar gate numérico.
- Test-author herda complexidade canônica ausente; mismatch explícito continua
  inválido. Low/medium → Terra/high; high/max legado → Sol/high. Test-reviewer
  Luna/xhigh. Conferir pai Terra/high no evento nativo, inclusive sem project trust.
- Ferramenta listada não prova funcionamento: testar scorer com arquivo e MV
  com consulta real no contexto do agente. MV/MP read-only, opcionais, fail-open;
  reviewer consulta só INITIAL. Resultado vazio/irrelevante não prova aprendizado.
  OAuth ausente é integração, não motivo para inventar nota. Usar autenticação
  suportada; nunca salvar callback/token no repo ou memória. Callback localhost
  precisa alcançar o processo que iniciou login, não outro computador por suposição.
- Menor prova fiel exige ler rota/retorno/fixture real antes de fixar oráculo.
  Para estado/retry previstos na spec, distinguir positivo, negativo e recuperação
  sem matriz combinatória. Preservar PASS não afetado.
- Security depende de aplicabilidade e cerimônia canônicas, não de sempre chamar
  três olhos. Omissão em tasks sensíveis v2.6.22 foi corrigida posteriormente;
  security final não torna a omissão histórica correta. LIGHT #207 sem security
  aplicável não era o mesmo defeito.
- Negativo novo supersede positivo. `issues` bloqueia, `follow_ups` não: não mover
  defeito aplicável para follow-up só para aprovar. #207/#208 preservaram follow-up
  sem reviewer para reformatação. Repetir olhos afetados na task; final global
  precisa cobrir input atual.

Fontes: [scorer](2026-09-11-pi-file-scorer.md),
[fases A/B/C](2026-09-11-pi-post-dogfood.md),
[review](2026-09-12-pi-review-boundaries.md).

## Memória e finalização

Sequência Claude/Pi: testes e olhos finais → correção/revalidação necessária →
harvest → shipper. Harvester decide e aplica memória sem revisão humana, mas
somente patch/append pequeno hash-bound ou `changes: []`; repetir só com mudança
material. Nunca full replacement a partir de contexto parcial.

Preservação dos olhos após harvest cobre **somente o delta exato** autorizado.
Adversary encontrou bypasses intermediários por excluir documento não proposto e
confiar só no worktree com HEAD/index divergentes sob assume-unchanged. Correção:
validar paths, modos e blobs; no-op não exclui arquivo algum. União de notas
paralelas pertence ao host/integrador, não a executor de produto. Não resolver
conflito de produto com `ours/theirs` em massa.
[Evidência](2026-09-11-pi-post-review-harvest.md).

## VPS, retomada e atualização

- CLI Orca observado: `/home/orca/.local/bin/orca-ide`; wrapper `orca` não era
  funcionalmente equivalente. Revalidar se mudar. Na #207, terminal novo com mesma
  sessão e prompt inicial como argumento retomou; `navigated:false` não comprovou
  aba visível. Causa exata da TUI não estabelecida, nenhum patch no SDK.
- Usar launcher do harness com `--harness-resume UUID`, não `pi --session` para
  contornar preflight. Atualizar pai não migra runtime pinado do filho. Não copiar
  assets manualmente para repinar task antiga.
- Não remover worktree usada por processo/launcher vivo. Removê-la pode apagar
  `.pi/harness/sessions` e evidências não commitadas. Persistir cedo fixtures
  sanitizadas, decisões e commits. `/tmp` não é backup. ENOENT após remoção não é
  PASS: recuperar fonte e rerodar testes. Logs originais #275 indisponíveis são
  limitação, não licença para inventar a causa dos três briefs históricos.
- Não vendorizar na fonte. Gerar consumidor pelo lifecycle/vendor oficial em
  branch limpa; conferir manifesto/diff, bootstrap/testes, abrir PR, esperar CI e
  integrar. Uma chamada de lifecycle nesta série integrou antes do CI; resultado
  foi verificado depois e desvio registrado. Para controlar a ordem, geração
  oficial + PR normal, seguida de sincronização oficial. Não presumir que
  automerge espera checks sem conferir a configuração efetiva.
- Confirmar stamp completo após merge: mesma versão pode ter `vendored_at`
  diferente em invocações separadas. Não alinhar copiando arquivo manualmente.
- Release Please controla versão/changelog/tag. CI `action_required` pode exigir
  aprovação oficial da execução, não significa teste quebrado. Confirmar tag,
  Release/latest e package/lock/manifest. GitHub Release não prova npm publish.
- PR mergeado não garante issue fechada: “Fecha #206” não acionou closing keyword.
  Usar `Closes #N`; verificar tracker, CI e finalização nativa separadamente.

### Trava órfã: caso proj-lainny após a validação

Em 12/09, launcher v2.6.5 passou `--verify`, mas iniciar TUI retornou
`parent orchestrator already active for worktree`. A trava datava de 09/09;
`/proc` comprovou processo dono inexistente. A operação nativa com UUID exato
recuperou a trava e abriu a TUI com histórico preservado. Bootstrap sozinho não
detectava esse bloqueio de sessão. Não era necessário reinstalar dependências.

Comando operacional instalado para usuário `orca`: `pi-recuperar`, disponível
em `~/.local/bin`; `pi-recuperar --check` diagnostica sem iniciar. Retoma a sessão
da trava somente quando o dono terminou (ou PID foi reutilizado), com host e
identidade conferidos; launcher faz a arbitragem/preflight nativos. Recusa pai
vivo, identidade inválida e symlink. Não mata processos nem remove locks por fora,
não edita sessões e não atualiza vendor. Código local em
`~/.local/lib/pi-recover.mjs`; testes em `~/.local/lib/pi-recover.test.mjs`.
Não é funcionalidade distribuída na tag 3.0.0 nem cura universal de erro do Pi.

## Medição e conclusão

- Somar JSONL pai + filhos + dispatches uma única vez; incluir cache e tentativas
  falhas/retomadas. Declarar exclusão do desenvolvimento Codex do harness, como
  nesta série. Não apresentar só continuação barata como custo integral da issue.
- Sol não é sinônimo de pai: baseline #275 teve US$54,8937 em Sol entre papéis,
  US$24,9502 no pai. Cinco issues recentes: US$47,91241988 incluindo #207 antiga,
  com escopos diferentes da #275; não inferir redução causal percentual.
- #274/PR336: consolidação histórica registrou US$124,8919726, contra
  US$34,2225366 nas continuações recentes. Estes totais dos relatórios operacionais
  não substituem JSONL para futura reauditoria; a recuperação foi assistida/mista.
- Separar execução, CI e manutenção/release/vendor. Sem instante de primeiro
  freeze na baseline não há percentual factual dessa métrica. Tempo somado de
  dispatches sobrepostos não é wall clock do pai.
- Unit test, fixture Git, bootstrap, pressure com modelo e issue completa provam
  fronteiras diferentes. Inspecionar artefato materializado. Recuperação final
  #207 rodou v2.6.26; 3.0.0 tem mesmo core, não outra issue inteira sob stamp novo.
- VPS observada: 2 vCPU/~8 GiB RAM; suítes concorrentes elevam latência. Observar
  memória/swap/CPU/progresso sem inventar limite fixo de tasks.
- Conector local `victor-mcp` inacessível: API core entregue não prova conector
  atualizado nem campanha Meta real. Sem deploy/campanha/banco alterado. Race
  preexistente SELECT/UPDATE de cleanup permaneceu follow-up, não fix oculto.

## Fechamento remoto 3.0.0

- Fonte [PR968](https://github.com/orobsonn/claude-harness/pull/968),
  [Release Please969](https://github.com/orobsonn/claude-harness/pull/969),
  [Release v3.0.0](https://github.com/orobsonn/claude-harness/releases/tag/v3.0.0),
  SHA `3ad6a062e40d54adae8edb93f97ce81a1473b5d2`. Publicada em 12/09/2026;
  latest conferida nessa data, não promessa permanente.
- CI [34710547574](https://github.com/orobsonn/claude-harness/actions/runs/34710547574)
  e [34710901827](https://github.com/orobsonn/claude-harness/actions/runs/34710901827)
  verdes. Última validação funcional local: Pi1160/1160, repo3748/3748. CI3746
  PASS/2 smokes Orca SKIP, ambos passaram localmente.
- Victor [PR347](https://github.com/orobsonn/victor-pipeline-dados-mcp/pull/347),
  merge `19e1966baed7341169ebbc0befd0b7a01e6af315`, após
  [CI34711379935](https://github.com/orobsonn/victor-pipeline-dados-mcp/actions/runs/34711379935)
  verde, 275 arquivos/2831 testes. Stamp v3.0.0 em main confirmado por operação
  oficial; arquivos locais do operador preservados. Não houve npm publish.

Revalidar ao mudar launcher/Orca, schema de recibos, runtime pinado, reviews,
memória ou lifecycle. Funcionamento comprovado nesses fluxos não é garantia de
zero bugs ou paralelismo ilimitado.
