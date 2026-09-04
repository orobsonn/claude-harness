# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself**. **Never auto-applied.**

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below -->

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
