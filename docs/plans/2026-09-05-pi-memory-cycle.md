# Pi: memória de run, harvest e continuidade da entrega

Cerimônia FULL. Autorização: implementar e entregar o ciclo discutido com o operador;
contexto efêmero termina com a run, conhecimento entre runs fica em MEMORY.md,
CONTEXT.md e kaizen.md. Incluído durante a execução: corrigir o loop de release
do victor-pipeline-dados-mcp depois de squash merge.

## Contrato aprovado

- Contexto explicativo curto, curado pelo pai, exclusivo da sessão/worktree. Não é
  transcript, autorização ou gate-state. Retomada exata pode lê-lo; nova run não.
- Só o pai recebe memória durável automaticamente e seleciona fatos para as mãos.
  Dados entram via evento context, sem persistência automática nem autoridade de sistema.
  Adversários não recebem diário nem pareceres anteriores. Compliance pode usar
  o ledger corrente de fidelidade, sem herdar a conversa inteira.
- Harvest read-only: zero a três deltas com evidência e revalidação. Zero delta não
  gera tarefas. Delta real vira tarefa documental canônica nova, no_tests, com nova
  revisão de plano, capture, re-gate e commit antes dos olhos finais.
- Finalização explícita apaga somente payloads efêmeros da sessão após prova atual
  de harvest, persistência, árvore limpa, revisões finais e conclusão nativa do shipper
  no mesmo HEAD. Release estritamente de metadados usa prova específica pre/postmerge,
  preservando propostas duráveis ainda não aplicadas.
  Fechar TUI, abortar ou compactar não significa finalizar.
- Rails são controle de workflow no host, não isolamento de processos do mesmo usuário.

## Plano TDD e verificação

1. Revisores: dispatch-rail/frontmatters. RED: herança de transcript aceita e loader
   sem configuração. GREEN: negativa true/truthy e configuração efetiva travada;
   suites de dispatch/bootstrap.
2. Memória: memory-cycle.mjs/harness-memory.ts. RED: tool sem comportamento. GREEN:
   Git/filesystem reais, limites UTF-8, symlinks, retomada, concorrência, HEAD,
   dirty tree, isolamento e ausência de reinjeção automática do diário.
3. Harvest: eventos nativos, receipt da sessão, proposta limitada aos três arquivos.
   RED: revisão sem colheita/delta persistido. GREEN: hashes, zero delta, doc commit
   exato, recusa de mudança funcional posterior e retomada da proposta.
4. Pipeline: planner/harvester/executor/test-author/shipper/runtime. Task documental
   só após delta material, preserva tarefas anteriores, sem teste fictício ou
   reaproveitamento do hand-record funcional. Executor consome RED já congelado.
5. Release: prova host-side de alteração somente de versão/changelog. RED: re-gates
   pré-squash bloqueiam release limpa. GREEN: avanço sem repetir tarefas, preservando
   CI/PR e negativas de scripts/deps/código/base divergente/dirty tree. Pós-merge prova
   o PR MERGED associado exatamente ao HEAD de main/origin/main com CI verde antes de
   permitir tag, push da tag e GitHub Release com versão e target exatos.
6. Launcher/manifesto/pack/vendor: extensão e libs carregadas e instalação convergente.
   Suíte afetada, npm test, adversário independente e auditoria por requisito;
   PR, CI, release-please e vendor da release nas próximas runs da VPS.

Rotas nativas: planner/adversary/executor/test-author high via model-routing.mjs
(Sol/high). Olhos read-only; mãos com ownership explícito. Evidências nos comandos e CI.

## Risco e recuperação

Paths sensíveis: dispatch/entry gates, launcher, gravação/remoção de estado. Não
alterar credenciais nem processos VPS existentes. Rollback por revert e vendor
da release anterior, preservando memória durável. Não reaproveitar a última tarefa
para persistência: substitui seu hand-record. Git/PR resolvem concorrência entre
worktrees; cada run lê o conhecimento disponível na própria base.
