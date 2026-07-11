---
paths:
  - "src/**/*.spec.ts"
  - "src/**/*.spec.tsx"
  - "src/**/*.test.ts"
  - "src/**/*.test.tsx"
  - "test/**/*.ts"
  - "test/**/*.tsx"
  - "tests/unit/**/*.ts"
  - "tests/unit/**/*.tsx"
  - "vitest.config.*"
---

# Testing — Unit / Integration

Carrega em arquivos de teste unit/integration e config de Vitest. Stack default: **Vitest** + Testing Library (em projeto frontend) + `@cloudflare/vitest-pool-workers` (em Worker).

## Conventions

### Stack
- Vitest pra unit + integration (isolado, fast, watch mode bom)
- Testing Library (React/DOM) pra components — testa comportamento, nao implementacao
- `@cloudflare/vitest-pool-workers` pra Workers (roda no isolate Cloudflare)
- TypeScript strict tambem nos testes

### Estrutura
- **Co-localizado** (preferido): `src/utils/format-currency.ts` ↔ `src/utils/format-currency.spec.ts`
- **Espelhado**: `test/utils/format-currency.spec.ts` quando projeto separa estritamente
- 1 arquivo de teste por unidade testavel
- 1 `describe` por unidade, 1 `it` por comportamento

### Naming
- Arquivos: `<unidade>.spec.ts` (preferido) ou `<unidade>.test.ts`
- `it("descreve comportamento esperado")` — frase comecando com verbo
  - BOM: `it("retorna BRL formatado quando valor positivo")`
  - RUIM: `it("test 1")`, `it("works")`, `it("formatCurrency")`
- `describe("<NomeDaUnidade>")` agrupa testes da mesma unidade

### Pattern AAA (Arrange / Act / Assert)
- **Arrange**: setup de input, mocks, fixtures
- **Act**: 1 acao (chamada de funcao, render, click)
- **Assert**: 1+ asserts focados no comportamento esperado
- Linhas em branco separando as 3 secoes

### Mocks — so nas bordas
- Mockar: `fetch`, IO de DB, clock (`vi.useFakeTimers()`), `crypto.randomUUID`, APIs do navegador
- NAO mockar: logica interna do proprio modulo, types, classes do projeto
- Preferir injecao de dependencia em vez de mock global quando possivel
- Mockar fetch via `vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, init))` — o body de um Response e single-use (ReadableStream consumido uma unica vez); a mesma instancia entrega um body ja consumido na 2a chamada, entao construa o body fresco dentro do closure (string re-materializavel ou `JSON.stringify(...)`), nunca uma instancia pre-construida — restaurar com `vi.restoreAllMocks()` no `beforeEach`

### Cobertura — pragmatica
- Testar: logica de negocio, parsers, validators, agregadores, hooks com side-effect, error handling
- Nao testar: getters/setters triviais, types-only, wrapper de 1 linha sobre lib externa
- Coverage threshold opcional (60-80%) — meta e qualidade, nao numero

### Fixtures
- Dados reusados entre testes: `test/fixtures/<dominio>.ts` exportando objetos const
- Factory functions pra dados complexos: `makeUser(overrides?: Partial<User>)`
- Evitar JSON enorme inline em test — extrair pra fixture

### Fixtures em testes @cloudflare/vitest-pool-workers (sem node:fs)

Testes que rodam no `@cloudflare/vitest-pool-workers` executam dentro do isolate Cloudflare, que **não tem filesystem**. Nesses testes é **proibido** ler fixtures com `node:fs` — `readFileSync`, `readFile` ou qualquer API de filesystem falham no isolate. Em vez disso, carregue o fixture via import **build-time** `?raw`:

```ts
import payloadText from "./fixtures/payload.xml?raw";
```

`?raw` devolve uma **string** com o texto bruto do arquivo (equivalente a `readFileSync(caminho, "utf8")`) — **não** é um objeto parseado. Se o teste precisa do objeto, aplique `JSON.parse(payloadText)` (para JSON) ou o parser apropriado; para conteúdo não-JSON (XML, HTML, texto), use a string diretamente. Imports JSON (`import data from "./fixtures/data.json"`) também são resolvidos no build e já devolvem o objeto parseado — use quando o fixture é JSON puro.

**Carve-out — onde `node:fs` é legítimo:** a proibição vale **apenas** para testes `@cloudflare/vitest-pool-workers`. Suítes `node:test` rodam no Node, com filesystem disponível, e usam `node:fs` normalmente. Exemplos concretos que continuam legítimos: os testes em `core/__tests__/` (node:test, leem arquivos do repo) e o passo 6 (§6) do agente `test-author`, que prescreve `readFileSync`/`resolve` para resolução de path relativo ao módulo.

### JSDoc obrigatorio
- Todo `.spec.ts` / `.test.ts` novo com `/** @description ... */` na linha 1 (CI verifica)

## Patterns

- **Unit puro AAA**:
  ```typescript
  // src/utils/format-currency.spec.ts
  /** @description Testes de formatCurrency. */
  import { describe, it, expect } from "vitest";
  import { formatCurrency } from "./format-currency";

  describe("formatCurrency", () => {
    it("retorna BRL formatado quando valor positivo", () => {
      const value = 1234.56;

      const result = formatCurrency(value);

      expect(result).toBe("R$ 1.234,56");
    });

    it("retorna zero formatado quando valor e 0", () => {
      expect(formatCurrency(0)).toBe("R$ 0,00");
    });
  });
  ```

- **Mock de fetch no client HTTP**:
  ```typescript
  import { vi, describe, it, expect, beforeEach } from "vitest";
  import { fetchUser } from "./fetch-user";

  describe("fetchUser", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("retorna user quando upstream responde 200", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ id: "1", name: "Ada" }), { status: 200 }),
      );

      const user = await fetchUser("1");
      expect(user.name).toBe("Ada");
    });

    it("lanca erro quando upstream responde 500", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
      await expect(fetchUser("1")).rejects.toThrow();
    });
  });
  ```

- **Component test (Testing Library)**:
  ```typescript
  import { render, screen } from "@testing-library/react";
  import userEvent from "@testing-library/user-event";
  import { LoginForm } from "./LoginForm";

  it("submete email valido", async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
    await userEvent.click(screen.getByRole("button", { name: /entrar/i }));

    expect(onSubmit).toHaveBeenCalledWith({ email: "user@example.com" });
  });
  ```

- **Fixture com factory**:
  ```typescript
  // test/fixtures/user.ts
  /** @description Factory de User pra testes. */
  import type { User } from "@/types/user";

  export function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: "user-1",
      email: "test@example.com",
      role: "member",
      createdAt: new Date("2026-01-01"),
      ...overrides,
    };
  }
  ```

- **Fake timers pra logica baseada em tempo**:
  ```typescript
  it("expira sessao apos TTL", () => {
    vi.useFakeTimers();
    const session = createSession({ ttlMs: 5000 });
    vi.advanceTimersByTime(5001);
    expect(session.isValid()).toBe(false);
    vi.useRealTimers();
  });
  ```

## Gotchas

- **`mockResolvedValue(new Response(...))` em mock de fetch**: nunca. O body de um Response e single-use (ReadableStream lido uma unica vez); a mesma instancia entrega um body ja consumido na 2a chamada. O caso mais agudo e no `vitest-pool-workers`, que reproduz com `Cannot perform I/O on behalf of a different request`. Use `mockImplementation(async () => new Response(body, init))` com o body construido fresco dentro do closure (string ou `JSON.stringify(...)`)
- **Mock que vaza entre testes**: `vi.spyOn` sem `restoreAllMocks` em `beforeEach` polui outros testes
- **Testar implementacao em vez de comportamento**: `expect(component.state.foo).toBe(...)` quebra em refactor. Testar API publica / o que o usuario ve
- **`waitFor` sem condicao**: `waitFor(() => true)` nao espera nada. Sempre afirmar condicao concreta
- **`fetch` sem mock em test unit**: bate em rede real, lento e flaky. Sempre `vi.spyOn(globalThis, "fetch")`
- **Snapshot test sem revisao**: dev faz `--update` cego, snapshot vira lixo. Snapshot so pra output estruturalmente estavel
- **Test com sleep fixo**: `setTimeout(2000)` flaky em CI lento. Usar `waitFor` ou fake timers
- **Test paralelo com estado compartilhado**: 2 specs escrevendo no mesmo DB local em paralelo = flaky. Usar pool isolado ou DB efemero por spec
- **Coverage como meta**: 90% com testes ruins < 60% com testes bons. Foco em qualidade
- **`JSON.stringify(error)`**: `Error` tem propriedades nao-enumeraveis — sai como `{}`. Usar `error.message` em assert
