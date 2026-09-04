# Avaliação da run Pi — issue 17

Data: 2026-09-04. Projeto: `orobsonn/proj-lainny`.
Sessão: `e429dbbe-2fd4-406e-9935-d35862d8fd40`.
Entrega: [PR draft 89](https://github.com/orobsonn/proj-lainny/pull/89), commit
`98b74c0572c177330aca51a74af14258ade05e7c`.

## Veredito

Entrega verificada, mas não evidência de uma run inteiramente autônoma e conforme.
Não encerrar a paridade com Claude Code com base apenas no PR e no CI verde.
O runtime usado na VPS foi identificado como `wip-pi-parent-resume`; alterações no
worktree do harness ainda precisam ser consolidadas e publicadas.

## Evidência observada

- Transcript começa em 2026-09-03 19:00:38 UTC e termina em 2026-09-04 08:17:20 UTC:
  aproximadamente 13h16 de tempo decorrido, incluindo duas retomadas.
- Plano com seis tarefas. Cinco revisões adversariais da spec; plano passou por
  REVISE, REVISE e APPROVE antes de sua primeira execução.
- 315 registros de conclusão de subagentes: test-author 82, compliance 118,
  adversary 29, security 24, executor 15, sniper 36, planner 5,
  plan-reviewer 4, shipper 1 e harvester 1. `completed` indica retorno da chamada,
  não aprovação: muitos relatórios retornaram FAIL/BLOCK e geraram correções.
- Foco final 119 testes; suíte 1.106 testes em 135 arquivos; typecheck e build
  aprovados no transcript. Os checks `docs-check` e `test` do PR terminaram SUCCESS.
- Adversário, segurança e compliance detectaram defeitos materiais, como JSON
  ambíguo, reembolso parcial e colisão de boundary MIME. Houve regressões, correções
  e novas revisões. A entrega excluiu `.pi/`, binários, build e metadados de cópia.

## Por que houve tanto retrabalho nos testes

1. **Mistura de fases:** o compliance “Approve fulfillment reds” reprovou a ausência
   de implementação mesmo reconhecendo RED comportamental válido. O agente Pi tinha
   apenas instruções genéricas; o equivalente Claude possui contrato explícito de
   fidelidade antes de congelar e verificação GREEN depois da implementação.
2. **Fixtures e dependências insuficientemente verificadas:** bindings ausentes,
   fixture de payment sobrescrita, caminhos fora do plano e simulação incorreta
   de batch/rollback obrigaram novas passagens.
3. **Contradições não resolvidas antes do próximo autor:** baseline exigiu uma
   escrita e depois precisou acomodar a escrita de auditoria existente. Revisões de
   parcelamento alternaram exigências sobre fatos financeiros e desempate.
4. **Descobertas tardias legítimas:** isolamento de conta, corrida, grafo persistido,
   reembolso e MIME exigiram cobertura adicional. Esses ciclos não devem ser
   removidos por um limite de rodadas ou aprovação automática.
5. **Evidência incompleta no brief:** revisores sem shell pediram resultados
   atuais que não haviam recebido. Um resumo da mão não substitui saída observada.

Correção em prosa no código-fonte: fase declarada pelo pai, leitura prévia da
closure/fixtures pelo autor, matriz completa por tarefa, relatório consolidado,
evidência de execução observada pelo pai e resolução de contradições antes de novo
despacho. Preservar descobertas materiais tardias e todos os gates. Não foram
adicionados selos, aprovação por contagem ou estado para gerenciar rodadas.
A redução do número de ciclos ainda precisa ser medida numa nova execução; testes
de carregamento dos prompts não demonstram essa redução por si mesmos.

Verificação do código-fonte após as correções de retomada e seleção de runtimes:
`node --test 'core/**/*.test.mjs' 'modules/**/*.test.mjs' 'scripts/**/*.test.mjs'`
terminou com 3.044 testes aprovados, zero falhas/cancelamentos/skips.
Isso inclui regressões reais do Pi fixado, mas não comprova instalação limpa
cross-host, redução dos loops do modelo nem conclusão da paridade. A prosa do
registro de plano também foi alinhada para não pedir confirmação humana adicional
quando a implementação autônoma já estiver autorizada dentro do escopo.

## Desvios e pendências para finalizar o harness

- Três dispatches iniciais de test-author falharam por identidade/complexidade.
- Task 6 declarava execução apenas pelo pai, mas o runtime exigiu uma mão. Foi
  usado test-author sem edição. Compliance reprovou a violação e a revisão final a
  aceitou como registro administrativo. É incompatibilidade entre plano e runtime,
  não cumprimento estrito da tarefa. Resolver esse contrato sem despachos fictícios.
- Migração Mac → VPS precisou de intervenção: dependências ausentes, caminho da
  sessão, AppleDouble e binário `rg` do Mac executado no Linux. Isso não comprova
  transferência automática nem instalação completa das dependências pelo updater.
- A revisão independente do código de retomada identificou lock apenas no caminho
  especial de resume, aprovação do plano não comprovada, progresso inferido de
  `hand_finished` e `--session-dir` capaz de desviar a sessão validada.
  O código-fonte agora rejeita seleção concorrente de sessão/diretório no resume,
  abre o arquivo exato e usa um guard da versão Pi fixada para rejeitar ausência,
  identidade trocada, symlink e arquivo inválido sem substituir a conversa.
  Testes com o SessionManager real cobrem preservação do histórico, append com e
  sem newline final e criação normal de filhos. A aplicação do overlay foi
  verificada no tarball original do Pi 0.84.4, além da repetição idempotente.
  O envelope não declara mais tarefas concluídas a partir de `hand_finished`
  nem aprovação do plano: fornece evidências e exige reconciliação pelo pai.
  Isso não prova que o modelo fará a reconciliação corretamente numa run real.
  Exclusividade em todos os modos de abertura e validação live da retomada
  continuam pendentes; as correções ainda não foram publicadas.
- A última descrição do PR contém risco residual obsoleto: afirma que erro de DB
  antes do refund não vira reconciliação manual. O commit entregue captura essa
  falha antes do HTTP e retorna `reconciliacao_manual`. Os olhos finais deveriam ter
  confrontado a descrição com o código. Não confundir esse erro de relato com um
  bypass demonstrado da proteção de refund.

## Riscos reais do produto

Refund permanece sem gatilho em produção, conforme spec e teste de superfície.
Consulta de recibos filtra conta e cobrança antes do limite de 100 resultados;
avisos alheios não expulsam o alvo. A consulta JSON sem índice específico pode,
porém, examinar muitas linhas fisicamente. Testes locais/CI não medem desempenho
em D1 real nem equivalem a validação de produção.

## Atualização dos quatro harnesses

O comportamento solicitado é instalar/atualizar Claude Code, Codex, OpenCode e Pi
por padrão e respeitar seleção explícita, inclusive `pi`. Verificação deve incluir
instalação nova, repetição convergente e isolamento de cada seleção individual.
Vendorizar os arquivos do harness não equivale a instalar os clientes externos,
suas dependências ou autenticar o usuário. A dependência de runtime do Pi continua
uma pendência de instalação observada nesta avaliação.
O resolver anterior podia escolher dependências do projeto/npx ou globais e
aplicar o overlay nesse local. O código-fonte agora provisiona um cache por
usuário/host antes de vendorizar e o launcher apenas verifica/consome essa geração.
Hashes detectam corrupção, não isolam outro processo da mesma UID.

## Aceitação do pacote e cache (ainda não é a run live final)

Um snapshot npm-pack do código em desenvolvimento, ainda com a versão de pacote
2.2.1, foi instalado com cache vazio em dois diretórios temporários independentes.
Não é uma nova release publicada. SHA-1 do tarball:
`6247a8cca5ebd2e8866f7ae1bafb573234de1b3f`.

- Mac: Node 22.22.2; `/tmp/pi-packed-acceptance.D1sod7`; instalação padrão dos
  quatro provedores terminou em 26,3s, exit 0.
- VPS: Node 22.23.1, usuário `orca`; `/tmp/pi-packed-acceptance.WBPcFk`;
  instalação padrão terminou em 28,6s, exit 0. Apenas o tarball do harness foi
  transferido; o cache de dependências foi instalado no Linux, não copiado do Mac.
- Nos dois hosts, launcher vendorizado `--verify` retornou `ok:true`, runtime
  0.84.4, subagents 21.2.0 e dez roles.
- O loader real do Pi registrou `subagent`, `mark`, `classify`, `harness_plan`,
  `harness_spec_write` e `seal_spec_review`, sem erros. Os quatro marcadores
  estavam presentes; não havia package.json nem node_modules no projeto fixture.
- `ensurePiRuntime({npmPath:'/nonexistent/npm'})` retornou sucesso nos dois hosts:
  cache hit não precisou instalar. Integridade permaneceu válida após carregar
  extensões. HOME de carregamento e caminho de autenticação foram isolados;
  nenhum modelo foi chamado nem credencial de operador foi lida pelo teste.
- Suíte vendor-core: 112/112 aprovados, sem skips. Inclui falha de provisionamento
  antes de qualquer escrita dos quatro runtimes e carga real do consumidor.

Esse snapshot precede as últimas correções de recuperação de cache corrompido e
lock sem owner, além da mudança solicitada de plan-reviewer para Astra high.
Revalidar o pacote final após consolidá-las. Estes resultados não comprovam a
instalação nativa `pi install`, uma run TUI/headless de modelo, a retomada live de
plano aprovado nem o `update-harness` autônomo solicitado para fechamento.

### Evidência posterior do harness

O snapshot acima é histórico. A instalação final Mac/VPS, a correção do catálogo
Astra para filhas reais e o update autônomo inline dos quatro provedores estão
registrados em [Pi discovery e modo local](plans/2026-09-04-pi-discovery-and-local-mode.md).
A avaliação da qualidade funcional da issue 17 permanece separada deste fechamento
do harness; não foi reaberta para aprovar a release.
