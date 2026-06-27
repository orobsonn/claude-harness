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

## Gotchas

- **`gh issue create` sem o form**: issue criada fora do padrão — sem `[harness]`, sem `harness:ready`, sem estrutura — o planner perde a spec e a routine ignora
- **Corpo escrito à mão**: duplica esforço e diverge da estrutura que o planner espera; qualquer campo faltando causa ambiguidade na geração do plano
- **Label `harness:ready` ausente**: issue visível no GitHub mas invisível para a routine autônoma — entregável perdido
- **Slug vago no título**: `[harness] fix` ou `[harness] melhoria` não identificam o escopo; usar `[harness] <feature-id>` curto e descritivo (kebab-case, max ~40 chars)
