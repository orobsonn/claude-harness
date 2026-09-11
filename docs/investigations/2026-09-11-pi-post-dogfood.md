# Ajustes Pi após dogfood #275

Baseline: origin/main `407b97287644dfc02c7ad7a350f4c05ad990865b`, v2.6.15.
Implementação isolada em `codex/pi-post-dogfood`; alterações alheias da raiz preservadas.

## Evidência disponível

O briefing fornecido pelo operador é a fonte dos números da #275: 3h42m56s,
79.179.021 tokens, US$ 66,6475, 83 dispatches, 11 task launches, quatro tasks.
O operador confirmou a exclusão do worktree da run. Os cinco IDs de sessão não
foram encontrados no caminho indicado, na lixeira do worktree, no perfil Pi ou
no diretório principal do Victor. A pedido do operador, a busca foi encerrada.
As reproduções usam os campos canônicos do estado atual; não são extratos dos
logs desaparecidos e não comprovam qual prompt original causou a ordem de merge.

O host não expõe uma operação para selecionar o modelo desta sessão nem metadados
verificáveis do identificador efetivo. Não foi alegada troca para Astra/high.

## Verificação

Fases A (#944) e B (#946) mergeadas; fase C em validação.
Orientação posterior do operador: três PRs sequenciais,
um por fase, e uma única release via Release Please depois dos três merges.
Os primeiros testes no worktree
sem dependências falharam por módulos ausentes; não são evidência de defeito do
harness. Dependências instaladas com `npm ci --ignore-scripts`.
Fixtures que usam subprocessos Git também exigiram execução fora do sandbox
(`spawnSync git EPERM`); essa falha de ambiente não é uma regressão do produto.

Scorer: por orientação posterior do operador, o Pi importa diretamente
`analyzeSource` do Claude Code. Pesos, caps, remoção de comentários/strings,
faixas e `should_split` são idênticos. Só o transporte e a sugestão sem quota de
tasks são adaptados. A versão simplificada do shared não é utilizada.

Preservar sem reimplementação: supersessão negativa, fidelidade histórica,
duas recuperações test-only, commit/capture/reviews, testes lean e olhos seletivos.

### Fase A — evidência parcial

- Baseline Pi sem sandbox: 1.095 testes passaram, zero falhas (278,2s).
- Dispatch nativo materializado: complexidade omitida herdada antes do rail,
  rota low/medium Terra/high e high/max Sol/high; registro persiste complexidade.
- Pressure real Sol/high, `/tmp/pi-pressure-max-3jlfSt/result.json`: 90,3s;
  scorer Claude retornou score 66, x-high, should_split=true; planner decompôs
  responsabilidades independentes em três tasks medium, com ownership sequencial.
- Pressure real Sol/high, `/tmp/pi-pressure-atomic-high-Vx5uax/result.json`:
  108,7s; scorer retornou score 34/high; uma task high, com justificativa explícita
  da transação compartilhada. Sem exigir quantidade predeterminada de tasks.
- MV/MP ausentes nos dois pressure tests não impediram a escrita do plano.
- Probe MCP real carregou o adapter instalado e chamou somente recall/code de
  leitura. MV respondeu `auth_required`; MP atingiu o timeout e abortou. Isso
  comprova continuidade fail-open, NÃO retrieval bem-sucedido do serviço remoto.
  Não copiamos credenciais nem abrimos OAuth. A disponibilidade externa permanece
  limitação de integração, a ser reavaliada na dogfood final se autenticada.
- Bootstrap no loop nativo aborta modelo desconhecido antes de qualquer payload
  ao provider; mapa nativo modelThinkingLevels também rejeita effort inválido.
  Trust e override usam SettingsManager nativo; Orca efetivo será medido na dogfood.
- A primeira tentativa pressure max não tinha parentSession no header e recebeu
  negação correta da tool; foi corrigida no probe, sem alteração no rail. Não é
  contabilizada como prova de uso do scorer. Probes MCP iniciais revelaram que
  resolução ESM e bindExtensions eram necessários; resultados anteriores não são
  evidência de disponibilidade.
- Suíte final local: 3.686/3.686, zero falhas (451,4s); Pi 1.104/1.104
  (323,5s), mais a regressão focal de shutdown sob inicialização pendente.
- Primeiro CI do PR #944: 14 testes de grep nativo falharam por ausência de `rg`
  e falha do download automático do SDK. O CI agora instala explicitamente
  ripgrep; a política e as assertions de secrets não foram relaxadas.

### Fase B — falsos bloqueios e coordenação

Base atualizada: `f55dc55861717ce1794cf8347295748ca2cbc291`, PR #944 da fase A
mergeado com CI verde. Release Please permanece reservado para depois das três fases.

- 5.1: reprodução atual RED com dependente já integrado: depois de corrigir o
  upstream, seu resume lançava o filho ainda com `a=1`, não `a=2`. A transição
  ignorava dependentes integrados ao marcar reconciliação. A correção só admite
  a dependência stale quando esse dependente é explicitamente retomado e usa
  o reconciliador existente, sem modificar seu algoritmo. GREEN: HEAD atualizado
  antes do launch, uma prova host-owned, um lançamento; tasks não solicitadas
  mantêm recibos. Não é prova da causa histórica dos prompts perdidos da #275.
- 5.2: herdado junto à rota canônica na fase A; ausência, igualdade, mismatch e
  plano inválido continuam cobertos. Sem reimplementação na fase B.
- 5.3: baseline rejeitava `npm run typecheck`, `pnpm typecheck`, `tsc --noEmit`
  e `npx --no-install tsc --noEmit`. As formas seguras agora passam; metacaracteres
  e executáveis arbitrários permanecem negados pelo mesmo parser. Scripts do repo
  não são sandbox. Equivalentes consultados nas docs oficiais de
  [npm exec](https://docs.npmjs.com/cli/npm-exec/) e
  [bunx](https://bun.sh/docs/pm/bunx).
- Prova real TypeScript 5.9.3 em `/tmp/pi-typecheck-proof-i52F8S`: npm run e
  npx --no-install passam com XOR correto; mutante permissivo falha TS2578 por
  perder a obrigação aprovada; restauração volta a GREEN.
- 5.4: baseline task/final approve → negative → missing passou. Runtime sem diff;
  teste estendido confirma leitura do negativo em processo novo.
- Suíte focal inicial: 218 testes verdes (31,8s). Adversary/compliance independentes
  aprovaram; separador `--` de npm exec corrigido após adversary e revalidado.
- Pi completo + validator: 1.136 testes verdes (290,9s). CI completo verde em
  [34605907835](https://github.com/orobsonn/claude-harness/actions/runs/34605907835).
  [PR #946](https://github.com/orobsonn/claude-harness/pull/946) mergeado em
  `ad7c403c27afa12f4d61e1eeb0686ef046d2537e`.

### Fase C — convergência e finalização

Base: merge da fase B acima. Regressões de baseline: 143 testes de memória,
review e acesso passaram; quatro testes de captura histórica/test-only passaram;
11 testes de harvest passaram, incluindo a permissão antiga de full replacement.
Novos testes RED comprovaram rejeição de follow_ups e aceitação de replacement;
o teste do brief também mostrou a ordem incondicional de chamar implementação.

- 5.10: campo opcional `follow_ups` usa os seis campos já existentes dos achados,
  preservado no mesmo receipt. Só `issues` determina accepted/findings/missing.
  Parser, persistência e retomada task/final cobrem follow-up isolado e misto.
  Prosa local/global orienta incluí-lo no relatório, sem outra revisão de formato.
- 5.11: brief de reconciliação agora declara incorporação host-owned concluída e
  pede comparar HEAD/capture/produtor antes da mão. Proveniência pós-merge real
  continua obrigatória, sem considerar um launch prova. Executor/sniper distinguem
  produto pronto com fallout de teste/evidência (`DONE_WITH_CONCERNS`) de produto
  incompleto. Recuperação test-only existente foi preservada sem diff.
- 5.12: `content` rejeitado sempre, inclusive em recibos antigos no apply/final-ready.
  Só append ou patch literal único {old_text,new_text}, ligado ao hash atual;
  patch não pode cobrir o documento todo. Limites: 8 KiB por delta, 24 KiB total.
  Nenhuma inferência de truncamento para autorizar escrita. Parent fornece recorte
  relevante/hashes; no-op válido é reutilizado sem segundo harvest. Falha exige
  diagnóstico e input materialmente corrigido, não redispatch do mesmo brief.
- 5.13/5.14: política de leitura e invalidação seletiva preservadas sem alteração.
  Regressões nativas de grep/glob, ENOENT versus negação, secrets e symlink passaram;
  duas recuperações test-only e revisão negativa/ancestral também passaram.
- Focal C: 235/235 testes passaram (80,1s). Adversary e compliance independentes
  aprovaram após corrigir dois asserts de fixtures, não o runtime.

Pressure real Terra/high com evidência host injetada, não dogfood de produto:

| Cenário | Prompt efetivo | Tempo | Dispatch observado |
| --- | --- | ---: | --- |
| Evidência corrigida, captura válida | task-runtime | 5,075s | nenhum writer |
| Defeito real de ownership | task-runtime | 8,233s | um sniper Terra/medium |
| Follow-up não bloqueante | runtime global | 4,576s | nenhum reviewer |
| Harvest atual com changes vazio | runtime global | 3,509s | nenhum harvester |

Artefatos em `/tmp/pi-convergence-evidence-3aWC4m`, `product-9SQss3`,
`follow-up-t7MTC7`, `harvest-Sw1JzZ` (os três últimos com o mesmo prefixo
`/tmp/pi-convergence-`), cada um com `result.json`.
Os probes anteriores foram descartados: prompt global no lugar do local e tools
customizadas não ativadas. O script corrigido verifica `subagent` ativa antes da
chamada. A tool registra a decisão, não lança um child real. Suítes completas,
artefato distribuído e critérios externos de release/vendor/dogfood seguem pendentes.

Dry-run adicional do vendor oficial em `/tmp/pi-phase-c-vendor-t0RE1r`: 160 arquivos,
runtime materializado com tools de planejamento, follow_ups nos três olhos, harvester
sem replacement e default Terra/high. Nenhuma credencial copiada. Scan de secrets,
checks de sintaxe dos módulos novos e `git diff --check` verdes. O package não declara
scripts separados de lint/typecheck; as extensões TS são exercitadas pelo bootstrap
e pelos testes nativos. Nada foi vendorado na raiz do repositório-fonte.
