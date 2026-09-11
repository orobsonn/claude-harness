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

Em andamento: fases A (planejamento/rotas), B (falsos bloqueios/coordenação) e C
(convergência/finalização). Orientação posterior do operador: três PRs sequenciais,
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
