---
name: authoring-rules
description: Meta-skill para criar e editar rules do Claude Code (.claude/rules/*.md). Use quando for criar uma nova rule no projeto, adicionar pattern/gotcha/convention a uma rule existente, ou revisar rules.
---

# Rules — gerenciar rules do projeto

Padroniza criacao e edicao de rules em `<projeto>/.claude/rules/`. Cada rule organiza conhecimento em 3 categorias canonicas.

## Quando usar

- Criar nova rule num projeto (lib/area que ainda nao tem)
- Adicionar Convention/Pattern/Gotcha a rule existente
- Revisar/editar rules
- Decidir se algo deve ser rule, CLAUDE.md, ou conversa pontual

## Estrutura obrigatoria de uma rule

```markdown
---
paths:
  - "src/area/**/*.ts"
---

# Titulo da Rule

## Conventions
- Instrucao acionavel direta (1 linha)

## Patterns
- **Nome do pattern**: Descricao curta
  ```typescript
  // exemplo de codigo curto e canonico
  ```

## Gotchas
- **Nome curto**: Explicacao concisa do problema e como evitar
```

### Regras de cada secao

| Secao | Obrigatoria | Formato | Conteudo |
|-------|-------------|---------|----------|
| `## Conventions` | Sim | `- Instrucao direta` | Como escrever codigo nessa area. Imperativo, 1 linha por item |
| `## Patterns` | Se houver | `- **Nome**: ...` + codigo | Solucao reusavel com snippet. Adicionar so se aparece em 2+ lugares |
| `## Gotchas` | Se houver | `- **Nome**: ...` | Armadilha que ja causou problema. Descreve o que NAO fazer e o que fazer |

Outras secoes especificas de dominio sao permitidas, mas as 3 acima sao o padrao base.

## Frontmatter `paths:`

Define quando a rule carrega — somente ao tocar arquivos que batem com os globs.

```yaml
# BOM — especifico
paths:
  - "src/components/**/*.tsx"
  - "src/pages/**/*.tsx"

# RUIM — generico demais (poluiria todo contexto)
paths:
  - "**/*"
```

**Regras:**
- `paths:` obrigatorio, **exceto** rules verdadeiramente globais (code-quality, security, git — vivem em `~/.claude/rules/`)
- Rule sem `paths:` carrega em TODA conversa — use so quando faz sentido
- Usar `**/*.ts` pra subpastas inteiras
- Listar arquivos especificos quando a rule se aplica a poucos

## Rule global (em `~/.claude/`) vs Rule de projeto (em `<projeto>/.claude/`)

| Tipo | Onde | Quando |
|---|---|---|
| **Global** (`~/.claude/rules/`) | Universal — vale pra qualquer projeto | code-quality, security, git, observability, testing, releases |
| **Projeto** (`<projeto>/.claude/rules/`) | Especifico do stack/dominio do projeto | workers, components, hooks, mcp-tools, libs, schemas |

**Regra de ouro pra criar rule de projeto**:
- A regra e nao-obvia do codigo? (sim → rule)
- Se eu ler o codigo, ja entendo? (sim → nao precisa de rule)
- E uma instrucao acionavel? (nao → talvez seja explicacao em CLAUDE.md ou JSDoc)

## Princiios de escrita

1. **Conciso** — 1 linha por bullet. Se precisa de paragrafo, esta detalhado demais
2. **Acionavel** — "Usar X" em vez de "X e uma boa pratica". Imperativo
3. **Sem duplicacao** — verificar `~/.claude/rules/` (globais) e CLAUDE.md antes de adicionar. Referenciar em vez de repetir
4. **Pt-BR sem acento** — consistencia com outras rules
5. **Gotchas com nome** — `**Nome**: Explicacao`
6. **Patterns com codigo** — snippet curto mostrando uso correto
7. **Tamanho alvo** — 80-150 linhas. Acima de 200, considerar quebrar em duas

## Fluxo: criar nova rule

1. Identificar escopo (area/dominio do codigo)
2. Definir `paths:` especificos no frontmatter (ou nao, se for global)
3. Criar arquivo em `<projeto>/.claude/rules/<nome>.md` (ou `~/.claude/rules/` se global)
4. Adicionar secoes Conventions/Patterns/Gotchas conforme necessario
5. Validar checklist abaixo

## Fluxo: adicionar item a rule existente

1. Classificar: e Convention, Pattern ou Gotcha?
2. Abrir a rule do dominio correto
3. Adicionar na secao correspondente, seguindo o formato
4. Verificar que nao duplica algo ja existente

## Checklist — nova rule

- [ ] Tem frontmatter com `paths:` especificos? (ou e global justificadamente)
- [ ] Titulo `#` descreve o escopo?
- [ ] Tem secao Conventions com pelo menos 3 items?
- [ ] Patterns/Gotchas adicionadas onde fazem sentido (sem inflar)
- [ ] Nenhum conteudo duplicado com rule global ou outra rule do projeto?
- [ ] Conteudo conciso (target 80-150 linhas)?
- [ ] Pt-BR sem acento, sem emoji?

## Checklist — adicionar item

- [ ] Classificado corretamente (Convention / Pattern / Gotcha)?
- [ ] Na rule do dominio certo?
- [ ] Formato correto da secao (bullet, **Nome** quando aplicavel)?
- [ ] Nao duplica item existente?

## Quando NAO criar rule

- A info ja esta obvia no codigo (`grep` mostra) → nao precisa de rule
- E config de tooling (ESLint, Prettier, tsconfig) → nao precisa de rule, e enforced por tool
- E uma decisao pontual de uma feature → vai em PR/issue/commit, nao em rule
- E uma metrica/dashboard URL → vai em CLAUDE.md "Recursos"
