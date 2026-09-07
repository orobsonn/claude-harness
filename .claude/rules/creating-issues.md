# Criando Issues

Universal — sem `paths:`, carrega em toda conversa.

> Esta rule é o **padrão** (o quê/porquê). Para criar issue(s) **ativamente** — passo a passo,
> aplicando sizing, critério de aceite verificável e roadmap — use a skill **`creating-issues`**, o
> procedimento que aplica este padrão. Fonte única: a skill lê esta rule, não a duplica.

## Conventions

### Issue form — sempre que disponível
- Ao criar issues no GitHub: SEMPRE usar o issue form do repo `.github/ISSUE_TEMPLATE/harness-task.yml` — nunca `gh issue create` com corpo escrito à mão
- O CLI `gh issue create` ignora issue forms silenciosamente — sem o form, a issue fica fora do radar do planner autônomo
- Antes de criar qualquer issue: checar `.github/ISSUE_TEMPLATE/` e reusar o form quando presente

### Tarefa routine-ready (harness)
- Título obrigatório: `[harness] <slug>` — sem esse prefixo o filtro da routine não identifica a issue
- Label obrigatória: `harness:ready` — sem ela a issue não entra na fila autônoma
- Preencher todos os campos do form:
  - `#uj-N` — user journeys (quem se beneficia e de que forma)
  - `#ac-N.M` — critérios de aceite verificáveis (Given/When/Then ou equivalente)
  - `scope` — paths afetados (arquivos e pastas)
  - `sensitive` — `não`, `auth/sessão`, `pagamento/billing`, `dados/PII`, `segredos` ou `SQL/migração`
  - `priority` — `P0`, `P1` ou `P2`
  - `size` — `S` / `M` / `L`
- Esses campos viram a spec, os `locked_tests` e o `scope_paths` do plano de execução

### Tamanho da issue (granularidade de ENTREGA) — default pequeno
- Default: **1 issue = 1 coisa que pode ir pro ar e ser desfeita sozinha**, ≤ ~400 linhas de diff (o mesmo teto de PR pequeno da rule de git)
- Teste prático, sem julgamento técnico: **se você consegue nomear duas coisas que poderiam merjar separadas, são duas issues**
- Por que pequeno é o default NESTE motor autônomo (as três propriedades que importam são por-issue, não por-tarefa):
  - **retry é por issue inteira** (ceiling K): juntar 3 coisas e a 3ª emperrar bloqueia a issue toda — as 2 que já estavam certas nunca sobem
  - **entrega é tudo-ou-nada por issue**: meio trabalho certo numa issue que falha = zero entregue
  - **o merge é por PR inteiro e automático**: diff maior = mais chance de passar batido no gate de revisão + mais coisa irreversível na main de uma vez, sem humano olhando antes
- **Juntar numa issue só é a EXCEÇÃO** e exige motivo — só quando as partes são **inseparáveis** (uma não sobe sem quebrar a main) **E** o total cabe em ~400 linhas **E** têm o mesmo perfil de risco. Coesão de TEMA não é coesão de ENTREGA
- **Sempre separar** quando: cruza área sensível (auth/pagamento/segredo/SQL — isola pra só ela pegar o modo FULL), passa de ~400 linhas, mistura assuntos sem relação, ou uma parte tem valor próprio
- O pipeline já pica a issue em micro-tarefas verificadas por dentro (o planner decompõe em tarefas atômicas) — isso cobre a QUALIDADE da construção, **não** o retry/entrega/raio-de-explosão. Não junte contando com isso

### PRD como fonte (handoff da skill `grill`)
- A issue pode nascer da conversa OU de um **PRD em `docs/prd/<slug>.md`** escrito pela skill `grill`. Com PRD, o mapeamento é fixo:
  - `## Requisitos` → critérios de aceite `#ac-N.M` — já foram escritos para serem observáveis e verificáveis; carregue-os em substância, não reinvente nem afrouxe. Preserve a numeração (requisito `N` → `#ac-N.M`) para cada critério voltar a um requisito, e cite o PRD de origem no corpo
  - `## Quem se beneficia` → user journeys `#uj-N`
  - `## Problema` → contexto/resumo do corpo; `## Fora de escopo` → os não-objetivos explícitos, no `scope`
  - `## Riscos conhecidos` → informa `sensitive` e `priority`
  - `## Decisões travadas` → corpo da issue, como restrições que a implementação deve respeitar
  - `## Suposições do modelo` → corpo da issue, em bloco **rotulado como suposição**
- **Decisão e suposição são dois blocos separados, nunca um.** Decisão travada é do operador e o `adversary` a DEFENDE; suposição é dedução do modelo e o `adversary` precisa continuar LIVRE PARA ATACÁ-LA. Fundir as duas categorias lava um palpite em restrição inquestionável — é a falha que este handoff existe para evitar
- **`## Em aberto` bloqueia a criação de qualquer fatia que dependa dele** — pergunta não resolvida é uma decisão que o motor autônomo inventaria sozinho e merjaria. Default: deixar a fatia FORA do lote (ela fica estacionada no `## Em aberto` do PRD, de onde a próxima sessão de `grill` retoma). Só com autorização explícita do operador crie um registro de acompanhamento **sem nenhuma label `harness:*`** — o seletor só pega `harness:ready`, então issue sem label é inerte; isso exige contornar o form (que estampa `harness:ready` sempre). `harness:queued` e `harness:blocked` são do motor — nunca aplicar à mão
- **PRD não autoriza issue maior**: um PRD que gera N fatias vira N issues sob a mesma regra de tamanho acima

### Candidato a aprofundamento como fonte (handoff da skill `proposing-deepening`)
- A issue também pode nascer de um **candidato a aprofundamento** em `docs/architecture/deepening-candidates.md`, escrito pela skill `proposing-deepening`. O mapeamento é fixo:
  - `o que fica mais fácil e pra quem` → user journeys `#uj-N`
  - `sintoma` + `não fazer nada` → contexto/resumo do corpo
  - `fatias` → **uma issue por fatia** (cada uma ≤ ~400 linhas, merjável sozinha), ordenadas com `harness-deps`
  - `oráculo independente` → critérios de aceite `#ac-N.M` — o oráculo É a verificação
  - `rota: FULL-equivalente` → `size` + nota de revisão cuidadosa/segurança, mesmo com `sensível: não`
- **Todo campo do candidato entra como SUPOSIÇÃO do modelo, nunca como decisão travada.** Um candidato é 100% dedução do modelo — o mesmo modelo leu o código e julgou o código. A única decisão travada disponível é o "sim, vale reformar isso" do operador, que é decisão de FAZER, não de COMO
- **Issue derivada de candidato é criada SEM `harness:ready` — é entrega LOCAL, com o operador olhando o resultado.** Reestruturar código que já funciona no escuro não pode merjar sozinho às 3h da manhã. O seletor só pega `harness:ready` aberta, então a issue sem label é inerte e nunca é despachada; isso exige contornar o form (que estampa a label sempre). Não invente label nova; `harness:queued` e `harness:blocked` continuam sendo do motor
- **Por que a rota escala**: o eixo de risco de uma reforma é **raio de explosão**, não sensibilidade de domínio — a allowlist de path sensível não enxerga uma reestruturação grande de código comum que funciona. Sem essa escalada, o caso de maior raio de explosão cairia na cerimônia mais barata

### Defeito desarmado parqueado como fonte (handoff do `orchestrating-delivery`)
- Um achado classificado `unarmed` e parqueado numa entrega (rule `unarmed-defects`) sai do run como issue — e **a issue é o único terminal do parque**: `findings.md` e `shared_context.md` são buffers apagados no harvest
- O corpo carrega obrigatoriamente **dois dados**, sem os quais não existe parque:
  - **Precondição do gatilho** — a coincidência que o gatilho exige, com a razão citada de a escala pretendida não a produzir e a **fonte citada** dessa escala pretendida (spec/PRD/decisão travada — nunca inferida de seeds ou fixtures)
  - **Observável de rearme** — o número ou estado concreto que rearma o defeito, **verificado falso** no momento do parqueamento, com o comando/consulta que checou
- Junto deles vão a severidade honesta (inalterada pelo parqueamento), o status da tentativa de reprodução (`reproduced` / `not-reproduced` / `traced` / `not-attempted`) e quem aceitou o parqueamento
- **Issue de defeito parqueado é criada SEM `harness:ready`** — mesma rota inerte do candidato a aprofundamento, por um motivo mais afiado: o seletor só pega `harness:ready` aberta, então uma issue de parque com label vira a próxima entrega autônoma e desparqueia o defeito em horas. Um parque espera o observável de rearme, nunca a fila
- **Issue sem observável de rearme não é parque** — é "depois eu vejo" com número. Recusar a criação e devolver o achado para correção

### Achado de run de entrega como fonte (handoff do `harvester`)
- Uma run autônoma que descobre um defeito adjacente durante a entrega **registra o achado como issue** — o `findings.md` e o `shared_context.md` são buffers que o próprio harvester apaga no fim, então achado que só mora neles é achado deletado. O registro tem valor: no caso real, a issue automática citava `meta-publish.ts:721`, a linha certa, enquanto a issue escrita à mão citava `:425`, desatualizada
- **Issue de achado de run é criada SEM `harness:ready`** — terceira rota inerte, ao lado do candidato a aprofundamento e do defeito parqueado, pelo mesmo motivo: o seletor só pega `harness:ready` aberta, então uma issue com label vira a próxima entrega autônoma e o motor passa a gerar o próprio trabalho futuro e a colocá-lo na própria fila. O que o achado precisa é da decisão do operador, não da fila. Não invente label nova; `harness:queued` e `harness:blocked` continuam sendo do motor
- **A trava é mecânica, não de prompt**: o `entry-gate` NEGA `gh issue create`/`gh issue edit` (e `gh api .../labels`) que anexe qualquer label `harness:*` quando quem chama é um **subagente** (o `harvester` sempre é) **ou** uma sessão de routine (headless-local/cron) — os dois sinais, porque o dispatch vivo do Orca não seta nenhuma variável de ambiente: a autonomia dele viaja no prompt, então só o marcador de routine teria deixado o incidente passar. Instrução em prompt é exatamente o mecanismo que falhou aqui — a run leu "crie toda issue com `harness:ready`" e obedeceu
- **Antes de criar, busque issue aberta equivalente** — `gh issue list --state open --limit 50 --search "<basename do arquivo>" --json number,title,url,labels`, com o comando visível no rastro da run. A chave é **arquivo + sintoma**, nunca número de linha: o mesmo defeito muda de linha entre uma run e outra (`:721` vs `:425` era o MESMO defeito). Achou: **comente o dado novo na issue existente** — não feche, não reescreva o corpo. Não achou: crie, sem label
- **Diga no resumo que a issue nasceu sem label.** Issue inerte que ninguém sabe que existe é achado deletado com passos extras — o operador é quem aplica `harness:ready` à mão quando decidir que aquilo vira entrega

### Glossário do projeto (`CONTEXT.md`)
- Se existir `CONTEXT.md` na raiz do projeto, usar os termos dele **literalmente** no título e no corpo da issue — o mesmo vocabulário que o planner e o executor leem. Não inventar vocabulário paralelo; não criar nem editar o arquivo (`surveying-codebase` semeia, o `harvester` mantém)

### Roadmap encadeado (issues com dependência/ordem)
- Um **roadmap** é um conjunto de issues criadas TODAS com `harness:ready` (o form já aplica) — a ordem NÃO vem da ordem de criação, vem das **dependências declaradas**
- Uma issue que precisa que outra(s) tenha(m) **merjado antes** declara isso no bloco fechado `harness-deps` do corpo (campo "Dependências" do form), um `#N` por linha:
  ```harness-deps
  #12
  #13
  ```
- O motor gateia sozinho: o seletor **adia** (`harness:ready → harness:queued`) qualquer issue cujas dependências ainda não têm **PR merjado na main**, e o review cron a **libera** (`harness:queued → harness:ready`) assim que TODAS merjаram. Uma issue sem dependências roda normalmente
- Garantia de ordem = gate (dependente espera as deps merjarem) + serialização do run-lock por-projeto (uma issue por vez). Não há execução paralela racing das mesmas issues
- Se uma dependência morre (`harness:blocked`), a dependente é encalhada (`harness:blocked`) e o operador é notificado — a corrente abaixo de um nó morto não fica parada em silêncio
- **Depois de criar o roadmap**, confira **à mão** que não há **ciclo** (`#A` → `#B` → `#A`) e que todo `#N` citado **existe** — não há lint automático do grafo, e o runtime não detecta esses erros de autoria
- Mantenha `#N` apontando para números de issue REAIS e abertos/merjados; um typo (`#9999`) deixa a dependente encalhada esperando um PR que nunca virá

## Gotchas

- **`gh issue create` sem o form**: issue criada fora do padrão — sem `[harness]`, sem `harness:ready`, sem estrutura — o planner perde a spec e a routine ignora
- **Corpo escrito à mão**: duplica esforço e diverge da estrutura que o planner espera; qualquer campo faltando causa ambiguidade na geração do plano
- **Label `harness:ready` ausente**: issue visível no GitHub mas invisível para a routine autônoma — entregável perdido. Exceções deliberadas: candidato a aprofundamento, defeito parqueado e achado de run de entrega — as três rotas inertes, que esperam decisão do operador
- **Slug vago no título**: `[harness] fix` ou `[harness] melhoria` não identificam o escopo; usar `[harness] <feature-id>` curto e descritivo (kebab-case, max ~40 chars)
- **Bloco `harness-deps` quebrado**: se o operador apagar/corromper a cerca ` ```harness-deps `, o parser não vê dependência e a issue roda IMEDIATAMENTE (sem gate) — possível race de ordem. Manter a cerca intacta; editar só os `#N` dentro dela
- **Ciclo de dependência** (`#A` depende de `#B` e `#B` de `#A`): ambas ficam `harness:queued` pra sempre, sem nó morto pra notificar. Nada detecta isso automaticamente — confira o grafo à mão depois de montar o roadmap
- **Suposição do modelo virando "decisão travada"**: se as `## Suposições do modelo` do PRD entram no corpo misturadas com as `## Decisões travadas`, o adversário passa a DEFENDER um palpite em vez de atacá-lo — o erro atravessa o pipeline inteiro sem ninguém autorizado a contestá-lo. Dois blocos, cada um com seu rótulo
- **Issue criada com pergunta do `## Em aberto` ainda aberta**: a issue entra `harness:ready`, o motor roda sozinho e INVENTA a decisão que faltava — e ela merjа. Segure a fatia fora do lote até a pergunta fechar
- **Candidato a aprofundamento virando issue `harness:ready`**: a reforma entra na fila autônoma, o motor reestrutura código que funcionava e o PR merjа sozinho — com o eixo de risco (raio de explosão) invisível pra allowlist de path sensível. Reforma é entrega local, sem label, sempre
- **Candidato a aprofundamento entrando como "decisão travada"**: o candidato é dedução do modelo de ponta a ponta; se ele vira decisão, o adversário passa a DEFENDER a proposta de reforma em vez de atacá-la. Tudo dele é suposição
- **PRD inteiro virando uma issue só**: "é tudo um PRD só" é o mesmo erro de coesão de tema abaixo, com outro nome. N fatias = N issues
- **Issue grande demais "porque é do mesmo tema"**: coesão de tema ≠ coesão de entrega. Juntar 3 sub-features numa issue faz o retry, a entrega e o raio de explosão do merge virarem tudo-ou-nada — a 3ª sub-feature emperrada bloqueia as 2 boas e o gate revisa um diff grande de uma vez. Separe por ENTREGA (o que merjа/reverte sozinho), não por tema
- **Issue de defeito parqueado criada com `harness:ready`**: o motor pega a issue, entrega o conserto sozinho e desparqueia o defeito em horas — o parque some sem ninguém decidir. Parque é registro inerte, sem label, sempre
- **Parque sem observável de rearme**: vira exatamente o "depois eu vejo" que a rule de defeito desarmado existe para impedir — este repo já carregou 68 erros de tipo e um `npm ci` quebrado assim. Sem número vigiável, não crie a issue: mande corrigir
- **Parque registrado só no `findings.md`/`shared_context.md`**: os dois são buffers do run e o harvester apaga ambos no fim. Achado parqueado sem issue é achado deletado
- **Achado de run de entrega criado com `harness:ready`**: o motor coloca o próprio trabalho futuro na própria fila e o tick seguinte entrega um item de backlog que nenhum humano decidiu que devia existir — foi o incidente #808 (issue #401 do `oraculo-app`). Achado de run é registro inerte, sem label, sempre; quem aplica label é o operador
- **Achado de run registrado sem busca prévia**: a segunda run redescobre o mesmo defeito e abre a segunda issue sobre ele, com número de linha diferente — o backlog vira N cópias do mesmo defeito e nenhuma delas tem o histórico completo. Buscar por arquivo + sintoma e comentar na existente
- **Dedup feito "de cabeça", sem comando no rastro**: dedup que ninguém consegue auditar não conta. O `gh issue list --search` tem que aparecer no transcript da run
