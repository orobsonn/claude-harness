# Code Quality

Universal — sem `paths:`, carrega em toda conversa.

## Conventions

### Atomicidade
- 1 funcao = 1 responsabilidade. Nome com "and" ou "AndThen" = sinal de quebrar em duas
- Funcao com mais de ~40 linhas exige justificativa (loop complexo, parser); default e refatorar
- Arquivo com mais de ~300 linhas exige justificativa; default e quebrar por dominio

### Reuso (DRY com limite)
- Codigo duplicado em 2 lugares: tolerado
- Duplicado em 3+ lugares: extrair pra util/hook/lib
- NAO criar abstracao "preventiva" pra futuro hipotetico — 3 linhas iguais > abstracao prematura
- Antes de criar helper novo: `grep -r <conceito> src/` pra ver se ja existe

### Naming
- Variaveis e funcoes: camelCase (`fetchUser`, `parsedDate`)
- Tipos, classes, componentes: PascalCase (`UserProfile`, `PipelineError`)
- Constantes module-level: SCREAMING_SNAKE_CASE (`MAX_RETRIES`, `API_BASE_URL`)
- Arquivos de codigo: kebab-case (`fetch-user.ts`, `parse-date.ts`)
- Componentes React: PascalCase no arquivo (`UserCard.tsx`) — coincide com o export
- Booleans: prefixo `is/has/should/can` (`isLoading`, `hasError`, `shouldRetry`, `canEdit`)
- Handlers: prefixo `on/handle` (`onSubmit`, `handleClick`)
- Async functions: NAO prefixar com `async` no nome — o tipo de retorno ja indica
- Nome do arquivo BATE com o export principal (`fetchUser.ts` exporta `fetchUser`)

### Estrutura (facilita glob/grep)
- 1 export principal por arquivo nao-trivial. Re-exports em `index.ts` ok pra agrupar
- Pastas semanticas pelo papel:
  - `src/lib/<dominio>.ts` — logica reutilizavel (sem side-effects)
  - `src/utils/<funcao>.ts` — helpers puros (1 funcao por arquivo se nao-trivial)
  - `src/types/<dominio>.ts` — types/interfaces compartilhados
  - `src/hooks/use<Nome>.ts` — hooks React (em projeto frontend)
  - `src/components/<Nome>/` — componentes React (em projeto frontend)
- `index.ts` APENAS pra re-exportar de uma pasta — nunca como entry de logica
- **Proibido**: `helpers.ts`, `utils.ts`, `misc.ts`, `common.ts` genericos. Nominar pelo dominio
- Evitar barrel exports profundos (`index.ts` que reexporta `index.ts` que reexporta) — quebra grep

### Comentarios (default zero)
- Codigo bem nomeado dispensa comentario
- So comentar o **PORQUE** (constraint escondido, workaround, decisao surpreendente)
- NUNCA comentar o **QUE** — `// incrementa contador` e ruido
- Nada de comentarios "ja foi removido" ou "ver issue #N" — git/PR sao a fonte
- JSDoc `/** @description ... */` obrigatorio em arquivo `.ts`/`.tsx` novo (verificavel via script no CI)
- Funcoes exportadas com logica nao-trivial: JSDoc com `@param` e `@returns`

### Tipagem (TypeScript)
- `strict: true` no `tsconfig.json` — sempre
- Evitar `any` — usar `unknown` na borda e refinar com narrowing
- Preferir `type` pra objetos planos e `interface` pra contratos extensiveis
- Nao usar `enum` numerico (preferir `const objeto as const` ou `string union`)
- Generics sempre que a funcao opera sobre tipo arbitrario — nao perder informacao com `unknown[]`

### Imports
- Imports relativos pra dentro do mesmo modulo (`./utils`, `../types`)
- Path alias (`@/`) para imports cross-module — configurar `tsconfig.paths` + `vite-tsconfig-paths` ou equivalente
- Ordenar: builtins → externos → aliases → relativos. ESLint `import/order` cuida
- Sem import circular — sinaliza acoplamento ruim

## Patterns

- **Util puro testavel**:
  ```typescript
  // src/utils/format-currency.ts
  /** @description Formata numero como BRL com 2 casas. */
  export function formatCurrency(value: number): string {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }
  ```
  Nome do arquivo = nome da funcao. 1 export. Testavel via `format-currency.spec.ts`.

- **Quebrar funcao gigante**:
  ```typescript
  // RUIM — faz validacao + calculo + persistencia + notificacao
  async function processOrder(order) { /* 80 linhas */ }

  // BOM — cada passo e unidade testavel
  async function processOrder(order: Order): Promise<Order> {
    const validated = validateOrder(order);
    const total = calculateTotal(validated);
    const saved = await persistOrder(validated, total);
    await notifyCustomer(saved);
    return saved;
  }
  ```

- **Narrowing em vez de `any`**:
  ```typescript
  function handle(input: unknown) {
    if (typeof input !== "object" || input === null) throw new Error("invalid");
    if (!("email" in input)) throw new Error("missing email");
    // input agora e { email: unknown }
  }
  ```

## Gotchas

- **`utils.ts` generico**: arquivo lixeira. Sempre nominar pelo dominio (`format-currency.ts`, `parse-date.ts`)
- **Re-exports em cascata**: `index.ts` que reexporta `index.ts` que reexporta — perde grep e cria ciclos. Manter um nivel
- **Abstracao de 1 uso**: se `formatX` so e chamado de 1 lugar, manter inline. Extrair so com 2+ usos efetivos
- **Nomes vagos**: `data`, `info`, `temp`, `result`, `value` — sempre nominar pelo conteudo (`user`, `parsedDate`, `cachedReply`)
- **`as` casting cego**: `value as Foo` mente pro compilador. Usar narrowing ou validar com Zod
- **Default export**: dificulta refactor (renomes silenciosos) e grep. Preferir named export
- **Numero magico**: `if (count > 5)` — extrair pra constante nomeada (`const MAX_RETRIES = 5`)
