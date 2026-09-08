# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself**. **Never auto-applied.**

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below -->

### Pi: identificar testes dependentes antes de fechar o escopo

- **Evidência:** na issue 222 de Victor, a suíte final encontrou uma assertion de `uploadVideo(i)` num teste de orientação sem ownership, após Tasks 1/2 implementarem `uploadVideo(i, selectedFile)`. Foi necessária uma Task 3 de reconciliação; os recibos anteriores permaneceram válidos.
- **Mudança autorizada:** orientação focal em planner/plan-reviewer para procurar usos/imports/literais alterados, inspecionar os testes existentes dependentes e atribuir sua atualização mínima antes do freeze. Sem mudança de gate ou expansão de escopo congelado.
- **Validação:** planner Pi real incluiu produto, teste novo e teste dependente numa task; review completo aprovou; controle sem ownership foi reprovado com correção precisa. Cinquenta testes focais passaram. Evidência, custos e limites em `docs/pi-task-pipeline/late-plan-reconciliation.md`.
- **Limite:** a regra de prosa não garante descoberta completa nem dispensa a suíte final; observar recorrência em tarefas reais antes de ampliar o mecanismo.

### Pi: enviar baseline e diffs no primeiro brief de revisão

- **Evidência:** na run legada Pi v2.5.0 de Victor/issue 222, Task 2, o compliance `502f5c55-de94-44a` bloqueou às 14:55:20 UTC de 2026-09-08 por falta de baseline/diffs para comprovar testes intocados e edição somente textual. O novo compliance `0a4f5872-f3c4-4d3` aprovou às 14:57:01 após complemento de contexto; não houve edição entre os dois. Os olhos têm `read/grep/find/ls`, sem shell, e não conseguem reconstruir `git diff` pela leitura dos arquivos atuais.
- **Resultado esperado:** a primeira revisão recebe os dados necessários para avaliar os requisitos de preservação, sem novo despacho somente para obter baseline/diff.
- **Menor experimento:** tornar explícito no primeiro brief do pai local o cwd, paths canônicos de plano/spec, fase, base/HEAD observados, status incluindo untracked, diff focal e resultado dos comandos com arquivos e exit status. Antes do freeze, usar a base do test-author; freeze/impl SHA só se aplicam nas fases posteriores. Alinhar `harness-task-runtime`, `harness-runtime`, `harness-delivery` e as instruções de leitura do test-reviewer/compliance. Não exigir transcript completo nem uma nova camada de orquestração.
- **Custo observado:** a janela entre BLOCKED e aprovação durou 100,4 s; cinco respostas do pai registraram US$ 5,23715, e a criança adicional US$ 0,0710312. Essas coletas continuam necessárias antes do primeiro brief; o total da janela não mede uma economia integral garantida. O primeiro revisor levou 113,1 s e o segundo 39,1 s.
- **Risco/limite:** um checklist universal pode exigir freeze antes da fase que o cria ou despejar contexto desnecessário. Escopo e evidência devem variar por fase. Se o prompt não bastar, avaliar uma coleta compacta na ferramenta existente; o snapshot de revisão atual não é um recibo de execução de testes.
- **Promoção:** implementada por autorização do operador e validada em run focal Pi/Orca: primeira fidelidade e primeiro compliance aprovados sem complemento; controle com teste congelado alterado corretamente reprovado apesar de GREEN. Três filhos nativos, sem retry/resume; pai e olhos somaram US$ 0,3912642. Relatório e limites em `docs/pi-task-pipeline/review-brief-evaluation.md`. Confirmar o efeito em tarefas subsequentes; o patch v2.6.1 tratou separadamente ordem commit/revisores e diagnóstico de captura.

### Pi: limite de turns do planner encerra cerimônia válida

- **Evidência:** a run real da issue #17 no Pi encerrou/re-despachou planner e adversary ao atingir `16` turns, embora ainda estivesse coletando evidência; o runtime e `dispatch-rail.mjs` impõem o mesmo teto.
- **Resultado esperado:** olhos e planner têm tempo para concluir um gate; uma mão só é despachada após os recibos e plano canônico atuais, sem reuso de sessão.
- **Menor experimento:** revisar adversarialmente o teto e testar uma configuração sem limite artificial por dispatch, mantendo timeout HTTP de 15 min, orçamento do provedor e todos os gates de identidade/escopo.
- **Custo/risco:** mais consumo e possível loop de agente; mitigar com timeout finito, limites do provedor e proibição de `resume`/background.
- **Promoção:** somente após teste de configuração/rail e uma cerimônia FULL observável sem abortar por `max turns`.

### Pi: ordem explícita do recibo de fidelidade

- **Evidência:** na cerimônia FULL real da issue #17, o pai chamou `capture-verified` antes de `fidelity`; o rail recusou o `fidelity` porque o recibo produtor já tinha sido consumido. Um novo despacho somente para reemitir a mesma evidência resolveu sem burlar o gate.
- **Resultado esperado:** depois de compliance aprovar o vermelho executável, o pai usa o mesmo recibo na ordem `fidelity` → `capture-verified`, sem despacho redundante e sem relaxar a exigência de identidade do produtor.
- **Menor experimento:** tornar a ordem explícita no prompt do orquestrador e cobri-la no teste do prompt; rodar a próxima cerimônia FULL e confirmar que a primeira tarefa chega à mão executora com um único recibo de teste.
- **Custo/risco:** uma instrução a mais pode virar burocracia se ela duplicar estado; limitar à sequência já exigida pelos rails, sem criar novo marcador ou regra de negócio.
- **Promoção:** somente após a execução real registrar a sequência sem rebind e a suíte do runtime permanecer verde.

### Pi: adversário pós-implementação não pode depender de draft já selada

- **Evidência:** na run FULL real da issue #17, o dispatch `Attack fulfillment diff` foi negado por `current canonical spec draft required` depois de a spec estar em `adversary-reviewed`; por isso o runtime não criou a sessão filha do adversário de código.
- **Resultado esperado:** o adversário de spec exige uma draft atual; o adversário que revisa a implementação só roda após a spec selada, sem reabrir ou afrouxar o gate inicial.
- **Menor experimento:** condicionar a checagem da draft ao estado `draft`, cobrir ambos os dispatches e executar outra cerimônia FULL até o adversário pós-implementação concluir numa sessão filha.
- **Custo/risco:** estado inválido não deve liberar delivery; os gates de cerimônia, plano, fidelidade, escopo e re-gate continuam sendo a autoridade.
- **Promoção:** somente após a sessão limpa registrar adversary final concluído e os reviewers finais liberarem a task.

### Pi: execução autônoma não pode pedir decisão não bloqueante

- **Evidência:** na prova limpa da issue #17, depois do adversário de spec concluir, o orquestrador interrompeu a run para perguntar a política de e-mail, apesar do pedido explícito de entrega autônoma. O prompt ainda dizia literalmente “quando exigir decisão, pare e peça direção”.
- **Resultado esperado:** em execução autônoma, a ambiguidade não bloqueante é resolvida pelo menor caminho defensável, seguro e reversível; a suposição e o risco ficam na spec e no PR draft, sem espera humana.
- **Menor experimento:** trocar a instrução contraditória por essa regra e manter o bloqueio honesto para autorização, segredo, efeito externo irreversível, migração/dados, legal/compliance, finanças, segurança ou ausência de caminho seguro; cobrir a redação no teste do prompt e reprovar a issue #17 em sessão limpa.
- **Custo/risco:** o modelo pode inventar produto se a exceção ficar ampla; limitar aos critérios explícitos, sem ampliar escopo, com olhos revisando a escolha e sem novo estado de workflow.
- **Promoção:** somente após uma run autônoma atravessar uma ambiguidade não bloqueante sem perguntar e entregar draft PR com a suposição rastreável.
