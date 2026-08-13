# OpenCode — aprendizados de engenharia

> **Período documentado:** 12 de julho–13 de agosto de 2026  
> **Grande reboot:** auditoria em 26 de julho; consolidação em 2 de agosto de 2026  
> **Incidente resume/todo:** 9–13 de agosto de 2026  
> **Registrado em:** 13 de agosto de 2026  
> **Escopo:** mudanças futuras em `core/opencode` e nas partes compartilhadas que alterem seu fluxo  
> **Natureza:** registro de aprendizado e apoio à decisão; não é uma nova especificação do runtime

Este é um documento vivo. Quando um mecanismo estrutural do OpenCode for introduzido, simplificado ou
removido, registre aqui a intenção, a evidência e o resultado. A finalidade é permitir que uma proposta
futura descubra rapidamente se já tentamos a mesma ideia com outro nome.

## Como usar este registro

Antes de desenhar uma melhoria estrutural do OpenCode:

1. procure no catálogo pelo mecanismo, pela intenção e por sinônimos;
2. compare a nova proposta com o modo de falha registrado, não apenas com o nome da solução; e
3. se ainda fizer sentido implementar, registre depois o resultado real — inclusive quando funcionar.

Isso é um hábito de revisão, não um gate do runtime. Não crie hook, marker ou checklist bloqueante
para provar que este arquivo foi lido.

## Por que este documento existe

O OpenCode funcionou bem enquanto usava o mesmo modelo mental do Claude Code: um plano legível,
agentes com responsabilidades claras, instruções fortes e poucos gates determinísticos em fronteiras
críticas.

Em agosto de 2026 tentamos melhorar duas experiências legítimas:

1. retomar, em outra sessão, um plano já aprovado após uma interrupção; e
2. projetar o progresso das tarefas no todo nativo da interface.

As correções foram implementadas issue por issue. Cada uma parecia razoável isoladamente, mas o
conjunto criou uma segunda máquina de orquestração exclusiva do OpenCode. O sistema passou a decidir
por estado, bindings, snapshots, receipts, markers e recovery aquilo que o Claude Code resolvia com
um artefato estável e instruções.

O aprendizado não é que todas as issues eram ruins nem que determinismo é ruim. O erro foi aceitar
várias soluções locais sem reavaliar o comportamento acumulado do sistema.

## Primeiro precedente: o grande reboot de paridade

O incidente de resume/todo não foi o primeiro. Entre 26 de julho e 2 de agosto de 2026, o OpenCode
precisou de um reboot estrutural pelo mesmo padrão de acúmulo.

### O estado que exigiu o reboot

A [auditoria de 26 de julho](https://github.com/orobsonn/claude-harness/pull/489) mapeou **617 regras
de bloqueio em 18 superfícies**. O OpenCode tinha criado uma muralha anti-forgery, múltiplos gates de
dispatch e recuperação, enquanto o Claude Code continuava operando com uma cadeia menor.

O [PRD de poda de 28 de julho](https://github.com/orobsonn/claude-harness/pull/586) mediu o delta:

| Dimensão | Claude Code | OpenCode antes do reboot |
|---|---:|---:|
| Agentes | 9 | 30 |
| Rails sem testes | 228 KB | 475 KB |
| Módulos dual/loop/adversary exclusivos | 0 | 90 KB |

A prosa do OpenCode não era maior que a do Claude Code. O delta estava quase todo em mecanismo:
dual enforcement, loop engine, accounting, nudges, seals, recovery e autoridade duplicada.

### O reboot

Em 2 de agosto, o [PR #608 — “reconstrói harness OpenCode por fatos”](https://github.com/orobsonn/claude-harness/pull/608)
consolidou a poda:

- 207 arquivos alterados;
- 11.911 linhas adicionadas, principalmente testes e fechamento da nova estrutura;
- 14.741 linhas removidas;
- motores legados de contagem, coordenação e autoridade retirados;
- plugins, imports, vendoring e captura revalidados no runtime real.

O reboot chegou na v0.53.0 e devolveu ao OpenCode um fluxo utilizável. Ele também deixou uma lição que
não foi preservada de forma curta o bastante: **paridade comportamental era o alvo; determinismo não
era o objetivo em si**.

### Por que esse precedente importa

Menos de duas semanas depois, o incidente de resume/todo recriou o mesmo formato em uma área diferente:
mais uma autoridade de plano, mais uma lifecycle, mais recovery e mais estados intermediários. O segundo
incidente não foi uma surpresa técnica; foi uma falha de memória institucional.

Antes de qualquer mecanismo OpenCode-only, consulte também:

- [`docs/OC-CC-PARITY-REPORT.md`](./OC-CC-PARITY-REPORT.md) — auditoria detalhada da primeira muralha;
- [`docs/prd/oc-parity-pruning.md`](./prd/oc-parity-pruning.md) — regras e medições da primeira poda;
- o catálogo histórico deste documento — para reconhecer ideias aposentadas mesmo quando reaparecem
  com outro nome.

## Segundo incidente: resume e todo, de forma factual

### Intenção original

- Preservar um plano aprovado quando uma sessão caísse.
- Reaproveitar trabalho já comprovado em vez de recomeçar.
- Mostrar o andamento no todo da interface.

### O que acumulamos

- caminhos de plano vinculados à sessão;
- binding e snapshot próprios do planner;
- receipt persistido do veredito de revisão;
- descoberta, seleção e adoção de sessões anteriores;
- markers de plano injetados no prompt;
- recovery específico para planner e resume;
- projeção e sincronização determinística do todo;
- regras adicionais de retry e continuidade para reparar os estados acima.

Esses mecanismos passaram a representar os mesmos fatos em lugares diferentes. “Qual é o plano?”
podia ser respondido pelo arquivo canônico, snapshot, binding, estado da sessão ou marker do prompt.
“O plano foi aprovado?” tinha resposta no histórico conversacional e em um receipt separado. Quando
duas respostas divergiam, o harness tentava reparar a si próprio e criava outro estado intermediário.

### Sintomas observados em runs reais

- plano aprovado sendo revisado novamente;
- planner recriando do zero um plano que deveria apenas ser retomado;
- sessão retomada escolhendo um stub mais novo em vez do plano completo;
- snapshot e arquivo canônico divergindo;
- loop planner → reviewer → planner;
- automação forçando continuidade depois de uma resposta normal do modelo;
- tarefa implementada, mas sem caminho consistente para atualizar o todo;
- paradas com mensagens de status em vez da próxima ação útil;
- uma correção de recovery exigindo outra correção no próprio recovery.

### Correção adotada

Em 13 de agosto, o fluxo foi trazido de volta à paridade conceitual com o Claude Code:

- plano estável por feature: `.opencode/plans/<feature_id>/execution-plan.json`;
- o arquivo do plano voltou a ser a fonte de verdade;
- retomada explícita relê esse plano, sem descobrir ou adotar sessões;
- classificação registra triagem, não cria uma lifecycle paralela do planner;
- o dispatch congela apenas o hash e o escopo necessários para proteger a mão em voo;
- aprovação, sequência e retomada voltaram à coordenação por prosa;
- autoria do plano, schema, escopo e captura continuaram determinísticos;
- projeção automática do todo deixou de ser tratada como verdade de execução.

Mudanças principais: [PR #789](https://github.com/orobsonn/claude-harness/pull/789),
[PR #791](https://github.com/orobsonn/claude-harness/pull/791) e
[PR #793](https://github.com/orobsonn/claude-harness/pull/793), consolidadas na
[v0.55.68](https://github.com/orobsonn/claude-harness/releases/tag/v0.55.68).

A sequência de runs OpenCode reais encontrou dois defeitos que a suíte hermética não havia exposto:

1. Na v0.55.66, o planner real usou `apply_patch`, mas o gate autenticava somente `Write`/`Edit`.
   O [PR #791](https://github.com/orobsonn/claude-harness/pull/791) passou a autenticar a tool real
   pelo mesmo caminho oficial, sem abrir escrita de produto ao planner.
2. Na v0.55.67, a retomada já chamou **zero planners** e **zero plan-reviewers**, mas a fidelidade
   classificou a ausência esperada do novo arquivo de produção antes do executor como import
   quebrado. O [PR #793](https://github.com/orobsonn/claude-harness/pull/793) explicitou o
   expected-red estreito sem relaxar import errado, fixture ou dependência ausente.

Na validação final da v0.55.68, uma nova sessão retomou exatamente o mesmo plano e hash, chamou
**zero planners** e **zero plan-reviewers**, passou pela fidelidade, executou a tarefa, obteve 2/2
testes verdes e gravou `capture_verified`.

Aprendizado adicional: teste com uma shape inventada de tool não comprova o envelope usado pelo host,
e teste de prosa não comprova a decisão tomada pelo modelo numa run. A run viva não é cerimônia final;
ela descobre diferenças que o teste não consegue representar.

## Catálogo de ideias já tentadas

Este catálogo não diz que uma técnica nunca poderá voltar. Ele exige que uma proposta futura mostre
o que mudou desde a tentativa anterior e por que o mesmo modo de falha não se repetirá.

| Ideia | Histórico | Intenção legítima | O que aconteceu | Decisão atual |
|---|---|---|---|---|
| Muralha de forma de comando / anti-forgery | Criada em julho; removida por [#497](https://github.com/orobsonn/claude-harness/pull/497) e [#501](https://github.com/orobsonn/claude-harness/pull/501), 27/07 | Impedir bypass por Bash | Bloqueou comandos legítimos do próprio harness e exigiu um command-resolver para reparar seus denies | Manter denylist estreita para comandos destrutivos; segredos, autoria e publicação ficam nas fronteiras semânticas próprias |
| Dual enforcement e segundo olho obrigatório | Introduzido na primeira portabilidade, 12/07; simplificado por [#594](https://github.com/orobsonn/claude-harness/pull/594), [#595](https://github.com/orobsonn/claude-harness/pull/595), [#597](https://github.com/orobsonn/claude-harness/pull/597), [#598](https://github.com/orobsonn/claude-harness/pull/598) e [#599](https://github.com/orobsonn/claude-harness/pull/599); consolidado em [#608](https://github.com/orobsonn/claude-harness/pull/608), 02/08 | Aumentar confiança da revisão | Criou ~90 KB de motores dual/loop, mais agentes, accounting e convergência própria | Avaliador principal; segundo olho somente quando houver valor explícito |
| Contadores, caps e stop states em vários loops | Acumulados entre [#407](https://github.com/orobsonn/claude-harness/pull/407), 19/07, e [#550](https://github.com/orobsonn/claude-harness/pull/550)–[#570](https://github.com/orobsonn/claude-harness/pull/570), 28/07; podados no ciclo até [#608](https://github.com/orobsonn/claude-harness/pull/608) | Limitar custo e evitar repetição | Cada loop interpretava o teto de forma diferente e alguns congelavam toda a entrega | Não criar controlador genérico; limites pertencem ao loop ou motor externo que realmente possui o custo |
| Seal, receipt ou binding paralelo para provar estado conversacional | Ceremony binding em [#347](https://github.com/orobsonn/claude-harness/pull/347), 15/07; validação HMAC do seal removida por [#512](https://github.com/orobsonn/claude-harness/pull/512), 27/07; sidecars restantes podados no ciclo até [#608](https://github.com/orobsonn/claude-harness/pull/608); receipt reapareceu em [#762](https://github.com/orobsonn/claude-harness/pull/762), 12/08 | Tornar decisões do modelo verificáveis | Duplicou a autoridade do estado e quebrou após restart, divergência ou mudança de processo | Remover quando não protege uma fronteira externa; não confundir persistência com prova confiável |
| Recovery que muta o estado para satisfazer outro gate | Planner recovery em [#346](https://github.com/orobsonn/claude-harness/pull/346), 14/07; simplificado no primeiro reboot; recriado para resume em agosto e removido por [#789](https://github.com/orobsonn/claude-harness/pull/789), 13/08 | Fazer a run se autocorrigir | O recovery ganhou seus próprios erros, retries e estados impossíveis | Se houver próxima ação local, a LLM deve executá-la; escalar só bloqueio externo real. Código de recovery fica restrito a falha objetiva do host |
| Plano por sessão + snapshot/binding/verdict | Auto-binding por sessão em [#410](https://github.com/orobsonn/claude-harness/pull/410), 19/07; resume/todo expandiu a arquitetura a partir de [#640](https://github.com/orobsonn/claude-harness/pull/640), 09/08, até [#780](https://github.com/orobsonn/claude-harness/pull/780); removido por [#789](https://github.com/orobsonn/claude-harness/pull/789), 13/08 | Retomar plano aprovado com integridade | Seleção errada, re-review, replan, divergência canônico/snapshot e cadeia de adoção | Plano estável por feature; dispatch congela apenas hash e escopo da mão em voo |
| Marker de plano no prompt como autoridade | Integrado ao binding de plano em julho/agosto; removido por [#789](https://github.com/orobsonn/claude-harness/pull/789), 13/08 | Vincular cada hand ao plano correto | Marker truncado, duplicado ou stale virou mais uma fonte de verdade e negou dispatch legítimo | Path estável e validação estrutural do plano |
| Projeção determinística do todo | Começou em [#640](https://github.com/orobsonn/claude-harness/pull/640), 09/08; reforçada por [#706](https://github.com/orobsonn/claude-harness/pull/706), 10/08; removida por [#789](https://github.com/orobsonn/claude-harness/pull/789) | Mostrar progresso fiel na UI | Duplicou conclusão canônica, perdeu sincronização e acoplou UX à execução | Todo é best-effort; captura/linhagem é a evidência durável |
| Controlador que injeta “continue” após o modelo responder | Introduzido por [#613](https://github.com/orobsonn/claude-harness/pull/613), 03/08; removido por [#718](https://github.com/orobsonn/claude-harness/pull/718), 11/08 | Evitar paradas prematuras | Sobrescreveu stops legítimos, produziu status turns e forçou continuidade sem contexto | Fornecer contexto e próxima ação, sem compelir resposta |

Ao aposentar uma ideia estrutural nova, adicione uma linha. Não crie um gate para obrigar a leitura
deste documento; a memória deve orientar o design, não virar outra cerimônia de runtime.

## Princípio central: comportamento por prosa, invariantes por código

“80% prosa / 20% determinismo” é uma heurística, não uma métrica de linhas ou arquivos.

Use prosa para aquilo que exige julgamento e coordenação:

- qual ação vem depois;
- quando uma revisão está suficiente;
- como reagir a um achado de engenharia dentro do escopo;
- quando retomar um plano existente;
- como reportar progresso e riscos;
- quando uma hipótese rara não merece ampliar o trabalho atual.

Use código para invariantes pequenas, objetivas e de alto impacto:

- somente o autor oficial pode escrever o plano;
- o plano precisa ter schema válido;
- uma mão não pode ampliar o escopo congelado durante o dispatch;
- captura precisa ter identidade e linhagem comprováveis;
- segredos não podem ser lidos por caminhos proibidos;
- entrega não pode incluir cargo alheio ou ignorar os gates definidos.

Este documento **não autoriza remover controles de segurança**. Ele orienta a não transformar
coordenação e julgamento em uma segunda state machine.

## Claude Code é baseline, não dogma

Antes de criar algo exclusivo do OpenCode, observe como o mesmo caso funciona no Claude Code.
Comece copiando o comportamento, não necessariamente a implementação.

Uma divergência OpenCode-only é justificável quando:

1. existe uma diferença concreta da plataforma;
2. há falha reproduzível ou risco plausível de alto impacto;
3. o Claude Code não oferece um comportamento que possa ser portado; e
4. a solução codifica somente a menor invariante ausente.

Não copie cegamente uma limitação do Claude Code. Da mesma forma, não construa uma arquitetura só
porque o OpenCode expõe mais hooks, metadata ou armazenamento.

## As três perguntas antes de criar um mecanismo OpenCode-only

Toda proposta deve responder, de forma curta e verificável:

1. **Qual falha real ela corrige?** Cite run, log, teste ou diferença documentada do host.
2. **Por que prosa ou o comportamento do Claude Code não bastam?** Nomeie a invariante que seria
   perigoso deixar para interpretação.
3. **Qual é o menor código que protege essa invariante?** Um gate não deve virar dono do fluxo.

Se uma dessas respostas não existe, a mudança ainda não está pronta para implementação.

Exceção: contenções evidentes de segredo, isolamento, autoria, integridade ou publicação não precisam
esperar um incidente vivo. Ainda assim, devem ser pequenas e ter testes negativos.

## Uma autoridade por fato

O mesmo fato operacional não deve ter duas fontes de verdade.

- O plano vive no arquivo estável da feature.
- O escopo da mão em voo vive no dispatch record congelado.
- A execução comprovada vive nos registros de captura e linhagem.
- O todo da interface é uma projeção best-effort, não certificado de conclusão.
- O histórico conversacional conduz a sequência; não precisa de um receipt paralelo apenas para
  obrigar o modelo a repetir a conversa.

Se uma melhoria exige reconciliar duas autoridades para o mesmo fato, pare e simplifique a fonte de
verdade antes de adicionar recovery.

O caminho estável por feature aceita uma limitação deliberada: duas entregas concorrentes com o mesmo
`feature_id` no mesmo checkout não são suportadas. Use worktrees separados. Não crie locks, generations
ou uma FSM preventiva sem uma necessidade real observada.

## Regra de parada da revisão adversarial

A revisão inicial pode ser ampla. Uma re-review não é uma nova caça a riscos de n-ésima ordem.

Depois de uma revisão, o próximo passe deve verificar:

- se os findings anteriores foram resolvidos;
- o delta criado para resolvê-los; e
- consequências diretas desse delta.

Um novo finding só reabre o trabalho quando apresenta um caminho concreto para quebrar acceptance
criteria, contrato, segurança, privacidade, integridade ou uma operação irreversível do fluxo esperado.

- Risco raro, mas de alto impacto e com caminho plausível: continua material.
- Hipótese sem reprodução, sem caminho concreto ou dependente de várias coincidências: registre como
  risco aberto; não a transforme automaticamente em requisito.
- “Procure mais erros”, “e depois?” repetido e fortalecimento não exigido de testes não são objetivos
  válidos de uma re-review.

A finalidade do adversarial é encontrar blockers materiais, não provar que nenhum risco concebível
existe.

## Sinais de que estamos recriando um monstro

Interrompa o desenho e reavalie o sistema inteiro quando aparecerem dois ou mais destes sinais:

- o mesmo fato está persistido em mais de um artefato;
- um mecanismo precisa de recovery para reparar seu próprio estado;
- uma correção precisa de stub, binding, snapshot, receipt, marker e retry para funcionar;
- a sequência normal depende de reconciliar sessão, prompt e filesystem;
- uma melhoria de UX passa a bloquear entrega;
- o modelo chega à ação correta, mas um gate manda voltar etapas;
- os testes unitários passam enquanto runs reais param ou entram em loop;
- cada novo edge case adiciona outro status ou transição;
- explicar o mecanismo exige explicar primeiro as correções anteriores;
- a proposta resolve “todo risco tecnicamente possível”, não o risco proporcional ao produto.

FSM, snapshots, parsers, counters e locks não são proibidos por nome. Eles exigem evidência mais forte
porque têm alto custo de interação e manutenção.

## Como validar mudanças futuras

Validação proporcional acontece em camadas:

1. **Durante a implementação:** testes focados, incluindo negativos para o gate alterado.
2. **No marco:** suíte completa e revisão adversarial do comportamento acumulado.
3. **Após mudança estrutural do OpenCode:** run real em processo novo, com logs brutos.
4. **Após a release:** vendorizar no projeto-alvo, reiniciar o OpenCode e repetir o caminho crítico.

Uma run positiva comprova o caminho principal, não toda a segurança. Os testes negativos continuam
responsáveis pelas invariantes. Em contrapartida, milhares de testes herméticos não substituem uma run
real quando a mudança altera routing, hooks, identidade de agente, compaction ou sequência entre tools.

Na run real, confira fatos observáveis, não apenas a resposta final:

- agentes despachados;
- quantidade de planner/reviewer;
- path e hash do plano;
- tools realmente usadas pelo agente;
- stamps de fidelidade e captura;
- testes executados;
- ausência de loops, status turns e replanejamento não solicitado.

## Checklist para uma melhoria futura

Antes de aprovar:

- [ ] Existe evidência do problema ou uma fronteira crítica de segurança claramente identificada?
- [ ] O comportamento equivalente no Claude Code foi observado?
- [ ] Está claro quem é a única autoridade para cada fato?
- [ ] A parte de julgamento pode permanecer em prosa?
- [ ] O determinismo proposto protege uma invariante objetiva?
- [ ] O gate falha de maneira acionável e não cria uma lifecycle própria?
- [ ] O adversarial separou blocker material de hipótese rara?
- [ ] Há teste negativo da invariante e plano de run OpenCode real?
- [ ] O desenho continua compreensível sem conhecer o histórico das issues anteriores?
- [ ] Se removermos a melhoria, o pipeline básico continua íntegro?

## Decisão que deve sobreviver a este incidente

Melhorar o harness não significa codificar toda decisão possível. O objetivo é aumentar a capacidade
do modelo de terminar trabalho correto com contexto suficiente, enquanto poucos rails determinísticos
protegem aquilo que não pode depender de julgamento.

Quando uma melhoria do OpenCode começar a disputar autoridade com o próprio plano, com o modelo ou
com o runtime, a resposta padrão é simplificar primeiro — e só então decidir se ainda falta código.
