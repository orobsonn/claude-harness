# Pi: conflito de contrato e diagnóstico de task bloqueada

## Evidência

Run Lainny `issue-22`, sessão pai `528d7635-1763-49c5-a9e4-35eace30e43b`,
task `task-4-inbound-runtime`, tentativa `b1d3a8cf-41e3-4032-85b7-30140336b623`,
sessão filha `f487e995-4935-4023-b6c8-9beafb368dcf`, HEAD `19ba2d39fd5f611f14ad5250f82497e82b5d976e`.

A primeira execução terminou por timeout de duas horas, com SIGTERM. A retomada
terminou com exit 0 mas devolveu BLOCKED: um fix_hint de segurança exigia impedir
reatribuição em toda recuperação D1-only, enquanto a fixture exigia reatribuição
após crash sem semear a reserva local obrigatória anterior ao batch D1. A última
mão declarou DONE_WITH_CONCERNS e o coordenador reverteu seu delta. Seu registro
ficou sem capturedVerifiedAt, corretamente impedindo integração.

A inspeção devolvia apenas `current child hand capture is invalid`. O log TUI
arquivava ferramentas, mas não o relatório final do pai local. Os achados atuais
só eram calculados após a validação de captura, portanto também ficavam ocultos.
A task acumulou 33 dispatches, incluindo sete rodadas de cada olho de implementação.

## Correção

- Preservar texto público do assistant em message_end do log nativo TUI, sem
  conteúdo de thinking. A inspeção usa somente o relatório final da última execução;
  nova ferramenta ou nova execução invalida um relatório intermediário/histórico.
- Expor relatório do produtor atual observado nativamente e achados ainda válidos
  mesmo quando a captura não permite aprovação. Conteúdo é diagnóstico limitado,
  não autoridade de aprovação; nenhum recibo é emitido por esse caminho.
- Transportar timeout/signal/exit/status temporal ao pai, sem mascarar o gate.
- Resolver fix_hint contra contrato e precondições antes de nova mão. Fixture
  comprovadamente incorreta é corrigida primeiro pelo test-author; a asserção
  aprovada de recuperação continua válida. Evitar alternar ordens incompatíveis.

## Validação

- Suíte completa: 3762 testes passaram fora do sandbox (processos Git exigem esse ambiente).
- Regressões: captura ausente com relato de conflito e finding atual; evidência
  estrangeira/obsoleta recusada; relatório intermediário invalidado; timeout;
  transporte sem persistência/replay; texto TUI sem thinking.
- Probe real `node scripts/pi-convergence-pressure.mjs conflicting-fix`, Terra/high:
  primeira versão do prompt ainda escolheu sniper contra a fixture sabidamente
  incorreta. Com a ordem explícita, escolheu um único test-author e preservou no
  brief tanto recovery com reserva quanto duplicata concluída. O probe injeta
  evidência e registra despachos; não executa mãos reais nem prova convergência de
  toda uma feature.
- Solução focal do produto verificada em worktree isolada: 23 testes, typecheck e
  build passaram. As novas regressões falham na baseline em replay após alarm e
  backfill global não limitado. A suíte ampla tinha cinco falhas anteriores em
  quatro arquivos; reproduzidas no HEAD original, independentes desta correção.

A fixture de crash precisa incluir a reserva e o marcador de intents presentes,
ambos gravados antes do D1. Simulações de settlement devem atualizar o índice por
pessoa como o writer real. D1-only sem reserva preserva a atribuição, sem criar
lifecycle a partir de milissegundos não comprováveis. O backfill usa um cursor
compartilhado e processa no máximo 20 recibos mais uma sondagem por evento.
