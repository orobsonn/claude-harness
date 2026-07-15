# Criando Issues

Universal — sem `paths:`, carrega em toda conversa.

> Esta rule é o **padrão** (o quê/porquê). Para criar issue(s) **ativamente** — passo a passo,
> aplicando sizing, critério de aceite verificável e roadmap — use a skill **`creating-issues`**, o
> procedimento que aplica este padrão. Fonte única: a skill lê esta rule, não a duplica.

## Conventions

### Issue form e submissão nativa
- A estrutura canônica é o issue form `.github/ISSUE_TEMPLATE/harness-task.yml`
- No OpenCode, submeter somente por `.opencode/skills/creating-issues/references/submit-issue.mjs`: ele replica os campos do form, valida repo/schema/enums/label e envia o body por stdin com argv fixo
- Nunca montar `gh issue create` em string de shell nem interpolar título ou corpo em comando

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
- **Depois de criar o roadmap**, rode `node core/vps/chain-validate.mjs --config <project.json>` para checar **ciclos** e **dependências inexistentes** (`#N` de issue que não existe) — o runtime não detecta esses erros de autoria, só o lint
- Mantenha `#N` apontando para números de issue REAIS e abertos/merjados; um typo (`#9999`) deixa a dependente encalhada esperando um PR que nunca virá

## Gotchas

- **`gh issue create` direto**: contorna a validação nativa e pode criar issue sem `[harness]`, `harness:ready` ou estrutura
- **Corpo escrito à mão**: pode divergir do form; use o JSON validado e o submitter da skill
- **Label `harness:ready` ausente**: issue visível no GitHub mas invisível para a routine autônoma — entregável perdido
- **Slug vago no título**: `[harness] fix` ou `[harness] melhoria` não identificam o escopo; usar `[harness] <feature-id>` curto e descritivo (kebab-case, max ~40 chars)
- **Bloco `harness-deps` quebrado**: se o operador apagar/corromper a cerca ` ```harness-deps `, o parser não vê dependência e a issue roda IMEDIATAMENTE (sem gate) — possível race de ordem. Manter a cerca intacta; editar só os `#N` dentro dela
- **Ciclo de dependência** (`#A` depende de `#B` e `#B` de `#A`): ambas ficam `harness:queued` pra sempre, sem nó morto pra notificar. Só o `chain-validate.mjs` pega — rode-o após montar o roadmap
- **Issue grande demais "porque é do mesmo tema"**: coesão de tema ≠ coesão de entrega. Juntar 3 sub-features numa issue faz o retry, a entrega e o raio de explosão do merge virarem tudo-ou-nada — a 3ª sub-feature emperrada bloqueia as 2 boas e o gate revisa um diff grande de uma vez. Separe por ENTREGA (o que merjа/reverte sozinho), não por tema
