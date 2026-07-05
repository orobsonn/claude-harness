# Criando Issues

Universal — sem `paths:`, carrega em toda conversa.

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

- **`gh issue create` sem o form**: issue criada fora do padrão — sem `[harness]`, sem `harness:ready`, sem estrutura — o planner perde a spec e a routine ignora
- **Corpo escrito à mão**: duplica esforço e diverge da estrutura que o planner espera; qualquer campo faltando causa ambiguidade na geração do plano
- **Label `harness:ready` ausente**: issue visível no GitHub mas invisível para a routine autônoma — entregável perdido
- **Slug vago no título**: `[harness] fix` ou `[harness] melhoria` não identificam o escopo; usar `[harness] <feature-id>` curto e descritivo (kebab-case, max ~40 chars)
- **Bloco `harness-deps` quebrado**: se o operador apagar/corromper a cerca ` ```harness-deps `, o parser não vê dependência e a issue roda IMEDIATAMENTE (sem gate) — possível race de ordem. Manter a cerca intacta; editar só os `#N` dentro dela
- **Ciclo de dependência** (`#A` depende de `#B` e `#B` de `#A`): ambas ficam `harness:queued` pra sempre, sem nó morto pra notificar. Só o `chain-validate.mjs` pega — rode-o após montar o roadmap
