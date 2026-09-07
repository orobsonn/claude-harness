---
paths:
  - "e2e/**/*.ts"
  - "tests/e2e/**/*.ts"
  - "tests/pages/**/*.ts"
  - "**/*.e2e.spec.ts"
  - "playwright.config.*"
---

# Testing — E2E (Playwright)

Carrega em arquivos E2E e config do Playwright. Stack default: **Playwright** com Page Object pattern em projeto medio/grande.

## Conventions

### Estrutura
- Specs em `e2e/<feature>.spec.ts` ou `tests/e2e/<feature>.spec.ts`
- Page Objects em `tests/pages/<page>.page.ts` — encapsula seletores e acoes da pagina
- Fixtures de dados em `tests/fixtures/<dominio>.ts`
- Auth state em `tests/.auth/<role>.json` (gitignored) — gerado por setup global

### Naming
- Specs: `<feature>.spec.ts` (login.spec.ts, checkout.spec.ts, dashboard.spec.ts)
- Page Object: `<page>.page.ts` (login.page.ts) — classe `<Page>Page`
- `test("usuario faz X esperando Y")` — frase em pt-br comecando com sujeito

### Cobertura — focada em jornadas
- 1 spec por user journey relevante (signup, checkout, dashboard load, criar/editar/deletar recurso principal)
- NAO duplicar testes unit em E2E — E2E e caro, focar em integracao real
- Smoke tests em CI (5-10 jornadas criticas), suite completa em deploy/nightly

### Selectors — ordem de preferencia
1. **`getByRole`** — `getByRole("button", { name: /entrar/i })`. Acessivel + robusto
2. **`getByLabel`** — `getByLabel(/email/i)`. Para forms
3. **`getByText`** — `getByText(/bem-vindo/i)`. Para conteudo
4. **`getByTestId`** — `getByTestId("user-avatar")`. Quando os anteriores nao servem
5. **CSS** — apenas como ultimo recurso. `data-testid` e proibido em produto, ok em test attribute

### Page Object Pattern
- Construtor recebe `Page` do Playwright
- Metodos sao **acoes do usuario** (`login(email, pwd)`, `addToCart(productId)`), nao operacoes tecnicas (`clickButton`)
- Properties **publicas** so pra locators reutilizaveis (`get errorMessage()`)
- Esperas implicitas dentro do Page Object — spec nao chama `waitFor` direto

### Setup / teardown
- `test.beforeEach` pra navegar pra pagina inicial e fazer auth
- Auth via `storageState` carregado de fixture gerado em setup global (mais rapido que login real em cada spec)
- Dados criados durante o teste devem ser limpos em `afterEach` ou via DB efemero

### CI
- Playwright em workflow separado (paralelo ao unit), runs on `pull_request`
- Use `retries: 2` em CI (flaky reduce); `retries: 0` em dev
- Trace + screenshot em failure: `use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }`

## Patterns

- **Page Object**:
  ```typescript
  // tests/pages/login.page.ts
  /** @description Page Object da tela de login. */
  import type { Page, Locator } from "@playwright/test";

  export class LoginPage {
    readonly emailInput: Locator;
    readonly passwordInput: Locator;
    readonly submitButton: Locator;
    readonly errorAlert: Locator;

    constructor(private readonly page: Page) {
      this.emailInput = page.getByLabel(/email/i);
      this.passwordInput = page.getByLabel(/senha/i);
      this.submitButton = page.getByRole("button", { name: /entrar/i });
      this.errorAlert = page.getByRole("alert");
    }

    async goto(): Promise<void> {
      await this.page.goto("/login");
    }

    async login(email: string, password: string): Promise<void> {
      await this.emailInput.fill(email);
      await this.passwordInput.fill(password);
      await this.submitButton.click();
    }
  }
  ```

- **Spec usando Page Object**:
  ```typescript
  // tests/e2e/login.spec.ts
  /** @description E2E do fluxo de login. */
  import { test, expect } from "@playwright/test";
  import { LoginPage } from "../pages/login.page";

  test.describe("Login", () => {
    test("usuario com credenciais validas chega no dashboard", async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();

      await login.login("user@example.com", "senha-valida");

      await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    });

    test("erro visivel quando senha invalida", async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();

      await login.login("user@example.com", "senha-errada");

      await expect(login.errorAlert).toContainText(/credenciais invalidas/i);
    });
  });
  ```

- **Auth setup global**:
  ```typescript
  // tests/auth.setup.ts
  /** @description Faz login uma vez e salva storageState. */
  import { test as setup } from "@playwright/test";

  setup("authenticate", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL!);
    await page.getByLabel(/senha/i).fill(process.env.E2E_PASSWORD!);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL("/dashboard");
    await page.context().storageState({ path: "tests/.auth/user.json" });
  });
  ```
  E em `playwright.config.ts`:
  ```typescript
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", use: { storageState: "tests/.auth/user.json" }, dependencies: ["setup"] },
  ];
  ```

- **Esperar response especifica**:
  ```typescript
  test("dashboard carrega dados do user", async ({ page }) => {
    const responsePromise = page.waitForResponse(/\/api\/user/);
    await page.goto("/dashboard");
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });
  ```

## Gotchas

- **Selector CSS (`.btn-primary`)**: quebra em redesign. Usar `getByRole`/`getByLabel`
- **`page.locator(".x").first()`**: quando ha multiplos matches, sinaliza selector ruim. Refinar
- **Esperar com `setTimeout`**: `await page.waitForTimeout(2000)` flaky. Usar `expect(...).toBeVisible({ timeout: 10000 })` ou `waitForResponse`
- **Login real em cada spec**: lento (~3s/spec × N). Usar `storageState` global
- **Test que escreve em DB compartilhado**: 2 runs paralelos colidem. DB efemero ou prefix de dados por test (`order-${test.info().title}`)
- **`data-testid` no codigo de prod**: poluicao do markup. Manter so em components quando absolutamente necessario
- **Trace ligado em todas runs**: ocupa disco. `'retain-on-failure'` ou `'on-first-retry'`
- **Test sem timeout customizado em operacao lenta**: timeout default (30s) pode estourar. Aumentar localmente: `test("...", async ({ page }) => { ... }, { timeout: 60000 })`
- **`page.click()` antes do elemento existir**: Playwright auto-espera, mas selector dinamico que muda durante load pode falhar. Sempre afirmar visibilidade antes de interagir em casos suspeitos
- **`expect.poll`**: util pra condicao que nao tem evento, evita custom loop com sleep
