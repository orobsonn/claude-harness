# Aceitação e demonstração comportamental

O objetivo é validar a experiência fechada de uma única sessão operacional,
sem avaliar a implementação. As verificações de segurança são automáticas e
não acrescentam confirmações intermediárias à conversa.

## Critérios executáveis

1. **Given** um projeto registrado com issues elegíveis, **when** o operador
   pergunta qual issue implementar, **then** uma recomendação é persistida e
   nenhum delivery, worktree ou terminal é criado.
2. **Given** a recomendação apresentada, **when** o operador diz “inicialize
   essa”, **then** somente a issue vinculada àquela recomendação é iniciada;
   sem autorização explícita no turno, nenhum recurso é criado.
3. **Given** uma admissão já processada ou uma resposta Orca perdida, **when** o
   mesmo comando é repetido, **then** os marcadores existentes são reconciliados
   e não surge outro pai, worktree ou delivery; isso inclui recibo de
   recomendação, geração de resume e resposta de criação de terminal rasgados.
4. **Given** uma admissão autorizada, **when** o terminal é criado, **then** seu
   comando começa pelo launcher `.pi/harness/pi-harness.mjs` do consumer e não
   pelo `pi` global.
5. **Given** o evento real `session.started`, **when** o início é confirmado,
   **then** projeto, issue, delivery, sessão, worktree e terminal aparecem no
   mesmo vínculo.
6. **Given** uma automação existente e inativa, **when** ela é ativada, **then**
   um único selector canônico é localizado e vinculado automaticamente, somente
   esse produtor muda de estado, a autorização vem do turno atual e nenhuma
   operação de criação de scheduler existe; zero ou vários candidatos são
   recusados, e uma automação de revisão do mesmo repositório não é confundida
   com produtora de entregas.
7. **Given** a mesma automação já ativa, **when** a ativação é repetida, **then**
   o resultado é `already-active`, com pós-condição verificada e sem mutação.
8. **Given** `session.stopped` sem resultado comprovado, **when** o portfólio é
   consultado, **then** a entrega aparece interrompida e nenhum novo recurso é
   criado; com a sessão geral aberta, o observador a desperta uma única vez, e
   a retomada autorizada usa a mesma sessão e worktree.
9. **Given** decisões em sessões ou revisões distintas, **when** o operador
   responde uma delas, **then** somente a combinação exata de delivery, sessão,
   geração, decisão e revisão recebe a mensagem.
10. **Given** uma resposta enfileirada, **when** a campainha é aceita e depois o
    pai a consome/aplica, **then** `sent`, `received` e `applied` são estados
    distintos, e `applied` exige evidência.
11. **Given** estado persistido e eventos, **when** o agente geral reinicia,
    **then** execuções, decisões e resultados são reconstruídos sem transcript.
12. **Given** um evento comprovado de PR draft, **when** o resultado é exibido,
    **then** ele aparece como disponível e nenhuma chamada de merge é feita.
13. **Given** um consumer sem protocolo/capabilities exigidos, **when** ele é
    consultado, **then** é recusado com diagnóstico antes de mutação e não é
    atualizado automaticamente.
14. **Given** dois projetos, **when** um portfólio é consultado por alias,
    **then** nenhuma entrega, decisão ou contexto do outro projeto aparece.
15. **Given** uma entrega existente, **when** o agente geral é desabilitado,
    **then** seu estado e recursos são preservados, mutações pelo control plane
    são recusadas e o launcher vendorizado continua disponível para operação direta.
16. **Given** um pai global já ativo antes do control plane, **when** Orca, o
    lock, PID/start token, sessão e `gate-state` concordam e o operador pede
    acompanhamento, **then** a run é vinculada de modo durável e idempotente,
    sem novo pai/worktree/terminal; sua saída é observada, enquanto resume e
    decisões são recusados por ausência de bridge retroativo.
17. **Given** uma run externa cujo pai aparenta ociosidade, **when** existe um
    `child-identity` válido de planner/reviewer, um task worker canônico com
    processo vivo, ou muda apenas o spinner,
    **then** ela continua `running` e o modelo não é despertado; somente uma
    mudança semântica sem filho ativo pode gerar `session.attention-needed`.

O oráculo offline desses comportamentos é executado por:

```bash
node --test core/control-plane/*.test.mjs core/control-plane/extensions/*.test.mjs core/pi/extensions/harness-control-plane.test.mjs
```

## Limite da evidência offline

O oráculo prova schemas, isolamento, concorrência, idempotência e comandos
externos por seams determinísticos. Ele não afirma que uma instalação Orca
específica está pareada, que um consumer real já recebeu esta versão do vendor
ou que um provedor de inferência está disponível. Essas três pós-condições
pertencem ao piloto autorizado abaixo.

O piloto exige uma única decisão inicial do operador: nome e caminho absoluto
de um consumer que não seja este repositório-fonte. Se ele ainda não anunciar o
protocolo compatível, vendor/update e a posterior execução com inferência são
autorizações separadas. Nenhuma delas inclui cron, merge ou deploy.

## Roteiro de demonstração para o operador

Use um consumer de piloto explicitamente autorizado e sem produtor autônomo
ativo. A atualização/vendor desse consumer é uma etapa separada e explícita.

1. Cadastre-o informando somente nome e caminho absoluto; confirme que GitHub e
   Orca foram descobertos sem pedir IDs internos.
2. Abra `harness-control-plane` e diga: “No projeto piloto, qual issue vamos
   implementar agora?”. Observe uma única recomendação curta e confirme no Orca
   que nenhum worktree foi criado.
3. Diga: “Pode inicializar essa”. A confirmação deve trazer a issue e a sessão
   real; no Orca deve existir exatamente um worktree e um terminal visível.
4. Repita “Pode inicializar essa”. O agente deve informar o mesmo vínculo; a
   contagem de worktrees e terminais não muda.
5. Durante a execução, peça “Como está meu portfólio?”. O agente deve resumir o
   estado sem transcript nem detalhes internos de gates.
6. Faça o pai abrir uma decisão de teste. Responda na conversa geral. O agente
   informa primeiro envio/recebimento e só confirma aplicação depois da
   evidência do pai.
7. Encerre o terminal do pai sem publicar resultado. O agente deve apresentar
   interrupção, consequência e retomada recomendada; não deve criar outro pai.
8. Autorize a retomada. Confirme no Orca a mesma worktree e, na resposta, a
   mesma sessão com geração nova.
9. Quando surgir um PR draft, o agente apresenta o link como resultado
   disponível e não faz merge.
10. Desabilite o agente geral. Confirme que a entrega e o terminal permanecem e
   que o consumer ainda pode ser operado diretamente pelo launcher vendorizado.

Ativação real de cron, merge e deploy estão deliberadamente fora deste roteiro.
