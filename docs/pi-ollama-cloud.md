# Pi + Ollama Cloud: piloto operacional

Implementação sobre o harness 3.2.x e Pi 0.86.1. O provider distribuído usa
`https://ollama.com/v1`, transporte `openai-completions` e os IDs diretos
`deepseek-v4.1-flash` e `glm-5.3`. `models.json` contém somente a referência
`$OLLAMA_API_KEY`; a chave deve existir no ambiente que inicia Orca/Pi.

## Perfis

- `baseline`: rotas Codex anteriores e rollback explícito sem chave Ollama.
- `trial-hands-deepseek`: executor, sniper e test-author usam DeepSeek em
  low/medium e GLM em high/max. Test-reviewer permanece Luna.
- `trial-hands-glm`: as mesmas mãos usam GLM em todos os tiers, sem fallback.
- `trial-orchestration-deepseek`: acrescenta DeepSeek nos pais global e local;
  é o default para sessões novas.

Inspeção sem rede ou tokens:

```bash
pi-harness --harness-profile-inspect --harness-profile trial-hands-deepseek
pi-harness --verify
```

Sessão nova no default:

```bash
pi-harness
```

Para testar somente um pai, combine o perfil de mãos com
`--harness-global-parent deepseek --harness-local-parent baseline` ou o inverso.
O launcher grava `.pi/harness/state/model-profiles/<session-id>.json`; filhos e
worktrees recebem o mesmo path/hash host-owned. Prompt, plano e argumentos de
subagente não podem alterar provider, endpoint ou rota.

Os pais open-source recebem também um bootstrap explícito para iniciar pela
triagem/classificação e cumprir spec, plano, revisões e pipeline por task. O
bootstrap não é injetado nos prompts de hands. No TUI, thinking fica oculto por
padrão via configuração nativa do Pi; `Ctrl+T` alterna a apresentação sem alterar
transcript, retomada ou tokens enviados ao modelo.

## Comparação inicial

A primeira candidata é `orobsonn/oraculo-app#425`: escopo focal e offline, sem
deploy, credenciais de produto ou dados reais. Execute dois runs a partir do mesmo
SHA, spec e critérios, em worktrees isoladas: primeiro `baseline`, depois
`trial-hands-deepseek` (ou alterne a ordem numa repetição). Não compartilhe solução
entre as tentativas. Registre aprovação inicial/final, revisões, correções,
intervenções, duração e uso por papel/provider; tentativas falhas entram no total.

Antes dela, o smoke de transporte pode usar a issue #437 ou uma fixture equivalente
para provar tool call estruturada, resultado, segunda chamada, streaming,
cancelamento e erro de ferramenta. Mocks não aprovam compatibilidade da conta.

## Orçamento e rollback

`--harness-budget-usd` é metadado opcional de auditoria; não impõe teto local, compra
créditos nem substitui o limite externo. Por decisão posterior do operador, o default
é admitido sem teto monetário local. Assinatura fixa, consumo estimado e consumo
confirmado são números separados, e uso ausente nunca vale zero.

Para rollback, pare novas admissões experimentais e use `baseline` em sessões novas.
Não apague locks, snapshots, sessões ou worktrees. Retome uma sessão antiga sem flags
de perfil; indisponibilidade do modelo bloqueia a sessão em vez de trocar para outro
provider silenciosamente.

## Limites ainda dependentes do provider real

Os testes offline comprovam configuração, identidade, gates e materialização. Acesso
da conta aos IDs, tool calling multi-turn, replay, cancelamento, streaming e qualidade
comparativa só ficam comprovados depois do smoke explicitamente acionado.

Os dois modelos do piloto anunciam janela de contexto de 1 milhão de tokens nas
páginas oficiais do Ollama: [DeepSeek V4.1 Flash](https://ollama.com/library/deepseek-v4.1-flash)
e [GLM-5.3](https://ollama.com/library/glm-5.3). O runtime distribuído usa esse valor;
`maxTokens` continua em 32.768. Snapshots antigos não são reescritos durante resume.

## Evidência offline de implementação (2026-09-20)

- Fonte validada inicialmente: harness `3.1.7`, Pi `0.84.4`, pi-subagents `21.2.0`.
- A suíte ampla registrou 3.856 testes aprovados e uma falha ambiental no caso que
  exige popular um cache Pi frio sem rede; portanto não é alegada como zero falhas.
- A seleção final de roteamento, launcher, policy, dispatch, coordenador e processo,
  executada offline e serialmente, aprovou 152/152 testes.
- `npm pack --dry-run --json`: pacote gerado com 657 entradas, incluindo
  `core/pi/runtime/models.json` e a árvore Pi atualizada.
- Vendor externo: 167 arquivos instalados em cada fixture consumidora; `--verify`
  aprovou as duas cópias sem inicializar o harness no repositório-fonte.
- O carregador real e fixado do Pi abriu `models.json` offline e resolveu exatamente
  `ollama-cloud/deepseek-v4.1-flash` e `ollama-cloud/glm-5.3`. A fixture usou uma
  credencial sentinela em memória; nenhum valor foi persistido.
- AC-01, AC-03–08 e AC-13–16 têm cobertura determinística direta ou pela suíte de
  regressão existente. Por decisão posterior do operador, AC-02 foi ajustado para
  também mover `test-author`; `test-reviewer` permanece Luna.
- Concorrência/stream/retry do serviço (AC-09–12) não são alegados como comprovados
  offline pelo roteamento. O piloto começa com uma entrega ativa e transforma falha
  de transporte em resultado do experimento, sem fallback silencioso.

## Contrato congelado do primeiro par

Issue: `orobsonn/oraculo-app#425`, commit inicial
`3f549169210650c7411711fb84d43d76407bf2d6`.

Estado vermelho medido antes dos agentes:

- `npm test` em `mcp/`: 32 arquivos e 282 testes passam, mas duas Promise rejections
  de secret vazio ficam sem tratamento e o processo encerra com falha;
- `npm run typecheck`: exit 0;
- `npm run lint`: exit 1 porque a configuração referencia uma regra ESLint ausente.

Os braços usam worktrees independentes em `/tmp`, o mesmo pedido e os quatro critérios
da issue. O controle mantém todas as rotas Codex. O candidato usa DeepSeek low/medium e
GLM high/max para executor, sniper e test-author; pais e olhos permanecem Codex, com
test-reviewer Luna. Não há deploy, publicação, compra de créditos ou reaproveitamento
da solução entre braços.

No desenho inicial desse par, a proposta era US$ 1, uma entrega ativa por vez e
interrupção diante de incompatibilidade de tools/stream. Depois da avaliação, o
operador removeu o teto local; o launcher mantém o orçamento apenas como metadado
opcional e continua registrando duração, tentativas, revisões, intervenção, uso
disponível por papel/provider e parcelas de custo desconhecidas.

## Registro do primeiro smoke real

Tentativa de 2026-09-20 na fixture descartável `eb6f409`:

- provider/modelo retornado: `ollama-cloud/deepseek-v4.1-flash`;
- streaming, tool calls, resultados de tools e chamadas subsequentes funcionaram;
- 39 respostas Ollama antes da interrupção, com 60.531 tokens de entrada, 9.331 de
  saída e 1.430.422 de cache read reportados pelo runtime;
- custo estimado pelo runtime: US$ 0,018969516; consumo confirmado no painel não foi
  consultado;
- a tentativa foi reprovada e interrompida antes de editar produto: o modelo chamou a
  tool `read` para `/proc/self/environ`, e o resultado foi persistido no JSONL;
- o único JSONL afetado foi removido da fixture, e as credenciais de teste devem ser
  rotacionadas. Nenhum valor foi copiado para código, documentação ou worktree da issue.

Correção aplicada antes da repetição: a policy Pi passou a tratar toda a árvore `/proc`
como secret-bearing tanto nas tools nativas de leitura quanto em comandos shell. Testes
determinísticos cobrem `environ`, `cmdline`, `fd` e alias via `self/root`; o vendor da
fixture e das duas worktrees foi atualizado e `--verify` voltou a aprovar. A repetição do
smoke deve usar uma chave rotacionada e remover `ORCA_WORKTREE_ID` do processo quando a
fixture temporária não pertence ao workspace Orca, preservando o backend local legítimo.

A repetição com chave rotacionada concluiu um circuito real: pai DeepSeek, tool calls
estruturadas, segunda chamada, pai local Codex independente, TDD, commit e integração.
O custo Ollama estimado pelo runtime foi US$ 0,043156326. Nenhum efeito remoto foi
autorizado ou produzido.

## Resultado comparativo da issue #425

Todos os braços partiram de `e1c67ec734ca72d418e7a37f8ba6030638e83b71`,
em worktrees isoladas, sem publicação. Valores Codex abaixo são equivalentes internos
reportados pelo Pi, não cobrança incremental da assinatura.

| Braço | Resultado | Duração | Ollama | Codex equivalente | Observações |
| --- | --- | ---: | ---: | ---: | --- |
| baseline, só Codex | incompleto | 22,506 min | US$ 0 | US$ 3,518507 | lint/typecheck verdes; suíte ainda exit 1 com 2 unhandled; plano congelado não permitiu a correção adicional |
| pais Codex + hands DeepSeek | incompleto | 39,983 min | US$ 0,005957 | US$ 5,387035 | task low usou DeepSeek; nenhum high/max, portanto GLM não foi acionado; mesma lacuna de plano |
| pais + hands DeepSeek, olhos Codex | completo | 73,536 min | US$ 1,159324 | US$ 3,477524 | 282/282, typecheck e lint exit 0; gates, integração, harvest e shipper local concluídos |

No terceiro braço, o pai global e os dois pais locais foram efetivamente
`ollama-cloud/deepseek-v4.1-flash`; planner, plan-reviewer, compliance, adversary,
test-reviewer e shipper permaneceram nas rotas Codex fixas. O custo equivalente total
foi US$ 4,636848, mas a parcela tarifável fora da assinatura observada foi a do Ollama.
A primeira tentativa sem bootstrap, interrompida por não iniciar a pipeline, custou
US$ 0,073772 adicionais e não entra na linha bem-sucedida.

O terceiro braço precisou de duas intervenções ambientais: hardlinks do
`mcp/node_modules` já instalado para as worktrees das tasks e retomada sem
`ORCA_WORKTREE_ID`. A pane TUI pertencia ao repositório do harness, enquanto o projeto
executado vivia em `/tmp`; o backend Orca recusou corretamente essa identidade cruzada.
Não houve fallback silencioso: a mesma sessão, spec, plano, hashes e gates foram
retomados pelo backend local.

A sessão também preservava o snapshot antigo de 128k e compactou oito vezes. Isso
explica parte relevante da duração e do custo do pai open-source; a correção para 1M
vale apenas para novas admissões, preservando a imutabilidade de resume.

O resultado funcional final ficou em `5938884c`: dois commits de task, uma retomada
da task de configuração, integrações e harvest. Os olhos finais aprovaram e o shipper
não publicou. Há, porém, um achado de eficiência/escopo para o relatório: como o plano
declarou `npm test`, `npm run typecheck` e `npm run lint` sem cwd, o gate final os rodou
na raiz e o pai ampliou o scope para adicionar scripts delegadores no `package.json`.
Isso satisfez literalmente o plano, mas levou o delta funcional de dois para três
arquivos e conflita com a descrição da raiz como mero âncora de versão. O setup prova
capacidade de entrega; antes de adotá-lo como default, o plano deve representar cwd por
comando ou validar esse detalhe na admissão para evitar a mesma sobre-engenharia.

Leitura operacional: o perfil é viável. Por decisão do operador após o terceiro braço,
novas sessões usam pais DeepSeek e hands DeepSeek/GLM por padrão; `baseline` permanece o
rollback explícito. O bootstrap, o contexto de 1M e os rails de identidade/pipeline são
parte obrigatória dessa admissão.

## Validação final para release (2026-09-21)

- runtime atualizado para Pi `0.86.1`, `pi-ai` `0.86.1` e pi-subagents `21.7.4`;
- suíte Pi completa, serial e fora do sandbox dos fixtures: 1.283/1.283 testes;
- compatibilidade preservada: sessões e delegações anteriores a snapshots continuam
  no baseline Codex; snapshots existentes permanecem imutáveis;
- `npm pack --dry-run --json` gerou o pacote com os novos perfis, `models.json`,
  documentação e runtime, sem incluir credenciais.
