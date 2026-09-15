# Autonomia e suporte focal do Pi — investigação em andamento

## Escopo e estado

Goal ativo: recuperação de paradas, suporte read-only ao pai, preservação de
preocupações materiais e fidelidade de testes à obrigação final. A pesquisa está
abandonada por decisão do operador: nenhum teste abaixo a retoma. Trabalho local
sobre v3.0.7, depois do commit local 6996b5c (plan-analysis ainda não publicado).
Nenhuma release ou validação de produto é alegada neste documento. Em 15/09, após
os testes isolados, o operador autorizou uma nova run da pesquisa quando tudo
estiver validado. A tentativa antiga continua abandonada; não será retomada.

## Evidência obtida

- Baseline de continuação: 11/11 testes passam, mas o novo caso mostra que uma
  obrigação inalterada encerra sem solicitar diagnóstico (RED observado).
- Candidato: após o lembrete normal, uma solicitação distinta de diagnóstico por
  assinatura pendente; sua emissão é durável, não pode repetir indefinidamente e
  não produz aprovação. Pausa explícita, erro do provedor e aborto permanecem
  respeitados. Não é um supervisor de processos nem uma garantia de convergência.
- Continuação candidata: 12/12 passam, incluindo SDK nativo drenando follow-up.
- Suporte ausente: regressão do catálogo falhou antes da implementação. O novo
  harness-support é somente leitor, Terra/high, sem herança, sem aprovação, sem
  escrita e sem dispatch recursivo. Usa os slots existentes de leitores (até três),
  nunca é classificado como review. A prosa limita a investigação a até três
  objetivos distintos; não há obrigação de convocar três ou repetir investigações.
- Suíte focal combinada após mudanças: 108/108 passam. Cobertura inclui catálogo,
  dispatch, políticas, entrada, concorrência e continuação. Isso ainda não prova
  bootstrap end-to-end nem comportamento do novo agente com modelo real.

## Pressure tests com Terra/high

Probes usam evidência injetada e registram decisões; não lançam filhos de produto.
Não confundir com uma dogfood completa. Resultados locais:

1. `conflicting-fix`: /tmp/pi-convergence-conflicting-fix-dQpGHt/result.json,
   13,163s, preservou reserva pré-DB e recuperação, corrigindo a fixture em vez
   de aplicar a sugestão incompatível. Prompt anterior às novas mudanças.
2. `two-concerns`: /tmp/pi-convergence-two-concerns-yHgHYv/result.json,
   14,731s, escolheu reparo de fixture e distinguiu a preocupação de autorização.
   Prompt anterior às novas mudanças. Não reproduziu a omissão observada no log
   original: contexto focal ajudou neste caso, mas n=1 não prova causalidade.
3. `recoverable-task` baseline:
   /tmp/pi-convergence-recoverable-task-G4xGSy/result.json, 8,425s.
   Leu status e escolheu resume correto, mas inventou argumento `feedback` em vez
   de `instruction`; assertion falhou. O probe aceita argumentos extras e por isso
   não reproduz sozinho a rejeição do runtime; falta testar validação nativa.
4. Após explicitar o nome do campo no prompt:
   /tmp/pi-convergence-recoverable-task-dVe3J1/result.json, 7,676s,
   status → resume da mesma task com instruction correto, sem writer/reviewer.

## Pendências antes de conclusão

### Novas verificações (continuação)

- Teste de binding exato do suporte passou: identidade read-only é emitida e
  removida ao terminar; texto `APPROVE`/`issues: []` não altera gate-state.
- `scripts/pi-recovery-pressure.mjs` executa fixtures temporárias com assets
  materializados. As primeiras tentativas foram bloqueadas pelo sandbox no lock
  da autenticação antes de qualquer resposta; repetidas com permissão apropriada.
- Luna/xhigh rejeitou o oráculo intermediário (17,495s, USD 0,0021396 estimado SDK):
  /tmp/pi-recovery-weak-oracle-Ef14WM/result.json. O script executa uma implementação
  mais fraca: ela passa o teste intermediário, mas falha a obrigação final.
- Os dois primeiros controles supostamente completos tinham lacunas da própria
  fixture experimental, apontadas corretamente pelo reviewer: não observavam
  publicação antes/depois. Não são regressões nem prova de rigor excessivo do Pi.
  Custos estimados SDK: USD 0,0040092 e USD 0,00435672; 46,517s e 56,220s.
- Controle completo: Luna aprovou sem cenário adicional (15,845s, USD 0,00152252):
  /tmp/pi-recovery-faithful-oracle-UScZQY/result.json. Nenhum diff no prompt do
  test-reviewer foi necessário para este par focal. Ainda falta autoria real.
- Suporte Terra/high preservou preocupação de autoridade em vez de tratá-la como
  resolvida pela fixture (13,183s, USD 0,008852 estimado SDK):
  /tmp/pi-recovery-support-boundary-NIxs5g/result.json. Trata-se de uma instância
  real read-only do asset, não ainda do ciclo pai → suporte → task inteira.
- Ao incorporar schema real ao probe de retomada, surgiu `expected_head` indevido
  em resume. Esse campo existe no schema agregado mas é proibido na operação pelo
  coordenador. O probe passou a reutilizar também TASK_ACTION_FIELDS (extraído sem
  mudar semântica do coordenador), evitando sucesso artificial. Descrições agora
  explicitam instruction e a exclusão de expected_head em resume.
- Retomada com schema e campos por operação: status → resume válido em 8,018s:
  /tmp/pi-convergence-recoverable-task-25Dceu/result.json. Não executa consumidor.

### Resultados adicionais

- Test-author Sol/high em fixture inicialmente vazia: 36,256s, USD 0,086226
  estimado. Artefato /tmp/pi-recovery-author-oracle-F32kAD/result.json e
  sensitivity.json: rejeita produto errado e versão mais fraca; passa produto
  correto. Luna aprovou esse mesmo teste na primeira revisão (18,926s,
  USD 0,00178072), /tmp/pi-recovery-faithful-oracle-0AKCRO/result.json.
- Ciclo pai/support com dois modelos reais Terra/high e resume somente registrado:
  /tmp/pi-parent-support-eR80fW/result.json, 25,893s, USD 0,048664. Um support,
  diagnóstico preservado, encaminhamento para a mesma task.
- Controle direto: /tmp/pi-parent-support-CU5IvC/result.json, 11,147s,
  USD 0,036072; zero support e resume correto.
- Limitação importante: esse probe cria o leitor via SDK e não por pi-subagents
  nativo. O pai recebe somente dispatch/status/resume, sem leitura direta, o que
  favorece suporte. Prova capacidade de encaminhamento, não ganho causal ou
  recuperação completa. A revisão independente confirmou essa limitação.
- Pi completo fora do sandbox: 1235/1235, 413,382s,
  /tmp/pi-recovery-support-pi-native.log. Focais de coordenação: 50/50; política de
  reconciliação com suporte: 33/33. Suíte repo: 3825/3825, 422,077s,
  /tmp/pi-recovery-support-repo.log (antes do último teste de recuperação).
- Vendor oficial em /tmp/pi-recovery-vendor-0veUVo: 165 arquivos, support presente
  em runtime-defaults/agents; verificação nativa ok (Pi 0.84.4/subagents 21.2.0).
  O contador roles=11 do verificador é de delivery; suporte não integra esse catálogo.
- Pack dry-run: 654 arquivos, sem state/sessions/worktrees de consumidores.
- Custos SDK dos 15 probes com respostas deste ciclo: USD 0,37337156 estimado,
  incluindo controles inicialmente incompletos e chamadas com parâmetros inválidos;
  exclui duas execuções antigas de conflicting-fix, o A/B anterior, Codex e revisão
  independente. Não representa faturamento verificado nem economia em produto.

### Auditoria independente — ainda não concluir

38 testes focais executados pelo revisor independente; sem bypass material.
Porém a continuação ainda pode encerrar após diagnóstico sem progresso, admitindo
que a causa não foi classificada. Não chamar isso de eliminação de paradas.
Foi adicionada prova de recuperação efetivamente executada em fixture de fronteira,
sem permitir retry infinito. A pesquisa permanece
abandonada e não será usada sem autorização específica.

### Provas de fronteira posteriores

- Launcher e pi-subagents nativos: /tmp/pi-native-support-CU3Ax0/result.json,
  25,566s, exit 0. Um support Terra/high, sem herança de contexto, concluído;
  arquivos de produto inalterados e nenhum recibo de aprovação/capture fabricado.
  Os JSONLs exclusivos do pai e filho registram USD 0,0456248 + 0,0441504,
  total USD 0,0897752 estimado SDK. Total deste ciclo: USD 0,46314676,
  sem Codex, revisão independente e experimentos anteriores. Ambos em Terra;
  o filho chamou somente read, read e find.
- Teste `unchanged-stop diagnosis can resume the owning attempt with a real
  process, without approval`, em task-coordinator.test.mjs: falha de lançamento
  comprovadamente anterior ao spawn; reminder sem retomada; diagnóstico; resume
  real do coordenador com mesmo attempt/worktree; subprocesso real escreve marcador
  explícito de fixture; segunda retomada enquanto ativo é rejeitada; resultado
  terminal exit 0 e gate-state intacto. O worker inicialmente rejeitou corretamente
  o hash fictício da fixture: teste passou após usar capture/verify do runtime real.
- Limite: a decisão de responder ao diagnóstico nesse teste é controlada, não
  probabilística. Os probes de modelo comprovam a decisão separadamente; o teste
  comprova sua execução. Não é uma recuperação end-to-end da pesquisa e não prova
  que todo modelo diagnosticará qualquer parada.

### Pendências de fechamento

Adversarial e compliance independentes não encontraram findings materiais no
patch. Ambos aprovam somente as alegações delimitadas pelas provas acima.
Os últimos 63 testes focais passaram. Vendor final oficial em
/tmp/pi-recovery-final-vendor-t4Xp6u: verificador ok, support e prosa nova
materializados. Pack final: 654 arquivos, 7505045 bytes, nenhum state/sessions/
worktrees. Não há script de lint/typecheck separado no package.json.
Suíte final em sandbox prendeu subprocessos dos hooks; processos de teste
encerrados explicitamente, sem tocar runs de produto. Reexecução nativa:
/tmp/pi-recovery-support-repo-final-native.log, ainda em andamento.

### Estratégia de validação em produto autorizada

Preferir sessão nova com a versão publicada/vendorada oficialmente: ela avalia
planejamento e execução sem herdar a longa cadeia de correções e contexto da
tentativa abandonada. Preservar logs e worktrees antigos, sem exclusão nem reset.
Uma recuperação da tentativa antiga isolaria melhor compatibilidade de retomada,
mas não mede custo de um plano novo e não é o experimento escolhido pelo operador.
Após suítes/revisões, publicar a correção e iniciar somente uma nova run; monitorar
até entrega ou bloqueio real. Registrar freeze, autores/revisores, preocupações
perdidas, lançamentos, no-ops, tokens/custo e intervenções. Comparação é descritiva:
planos probabilísticos diferentes não permitem atribuir toda diferença ao patch.

- Revisar se o diagnóstico candidato apenas adia parada sem resolver a causa;
  não declarar autonomia resolvida com base apenas em strings/unit tests.
- Suítes completas, diff check, dry-run de distribuição e relatório de custos.
- Executar a nova pesquisa autorizada somente depois de publicação/vendor oficial.
  Sucesso nessa amostra não implica convergência universal.
