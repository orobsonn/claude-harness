---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "app/**/*.ts"
  - "app/**/*.tsx"
  - "worker/**/*.ts"
---

# Observability

Carrega quando ha codigo em `src/`, `app/` ou `worker/`. Foca em log, metrics, tracing — sem leak de secret.

## Conventions

### Log estruturado
- Em prod: log JSON 1 linha (`console.log(JSON.stringify({...}))`) — facilita parse e redacao
- Em dev: livre escolha (string legivel ok)
- Campos canonicos por log:
  - `op` — nome da operacao (`fetchUser`, `processOrder`)
  - `level` — `error` / `warn` / `info` / `debug`
  - Identificadores relevantes (`userId`, `requestId`, `orderId`)
  - `error.message` (NUNCA `error.stack` em prod)
  - `durationMs` em operacoes que medem tempo

### Niveis
- `console.error` — erro bloqueante (operacao falhou)
- `console.warn` — degradacao recuperavel (retry, fallback usado)
- `console.log` / `console.info` — evento esperado (start, success). Em prod, considerar metric em vez de log
- `console.debug` — detalhe interno. Desligar em prod via flag

### Erro — captura e re-throw
- Catch loga COM contexto (op, ids, status) e re-throws ou retorna erro estruturado
- NUNCA engolir erro silenciosamente (`try { ... } catch {}` vazio = bug invisivel)
- Erro com `cause` (Error chain): logar `error.message` + `error.cause` (apenas a mensagem, nao stack)

### Proibido em log
- API key, Authorization header, Bearer token, JWT
- Password (mesmo hash) — risco de log retention vazar
- `.dev.vars` / `.env*` inteiro — `console.log(env)` vaza secrets. Logar so chaves: `Object.keys(env)`
- Request body / query string com token (`?api_key=...`) — sanitizar antes
- Response body completa de servico externo — pode conter dados sensiveis
- Stack trace em prod — vaza paths internos do bundle

### Metrics e tracing
- Operacao critica: medir `durationMs` com `performance.now()` ou `Date.now()`
- Cloudflare Workers: usar `ctx.waitUntil()` pra envio assincrono de metric (nao bloqueia response)
- Tracing distribuido: propagar `traceparent` header se servico externo suporta W3C Trace Context

### Console em frontend (browser)
- `console.log` em prod do frontend e visivel pelo usuario (DevTools). Cuidado com info sensivel
- Erro nao tratado: `window.onerror` / `unhandledrejection` — capturar + reportar (Sentry, Cloudflare Workers Analytics)
- Em React: `ErrorBoundary` em rota raiz captura erros de render

## Patterns

- **Try/catch com log e re-throw**:
  ```typescript
  try {
    return await fetchUser(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ op: "fetchUser", id, level: "error", message }));
    throw error;
  }
  ```

- **Logar entrada e saida de operacao critica**:
  ```typescript
  async function processOrder(order: Order): Promise<Order> {
    const t0 = Date.now();
    console.log(JSON.stringify({ op: "processOrder", orderId: order.id, level: "info", phase: "start" }));
    try {
      const result = await doProcess(order);
      console.log(JSON.stringify({
        op: "processOrder", orderId: order.id, level: "info",
        phase: "success", durationMs: Date.now() - t0,
      }));
      return result;
    } catch (error) {
      console.error(JSON.stringify({
        op: "processOrder", orderId: order.id, level: "error",
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - t0,
      }));
      throw error;
    }
  }
  ```

- **Helper de log estruturado** (extrair se duplicar 3+ vezes):
  ```typescript
  // src/utils/log.ts
  /** @description Helpers de log estruturado JSON. */
  type Level = "error" | "warn" | "info" | "debug";

  export function log(level: Level, op: string, fields: Record<string, unknown> = {}): void {
    const entry = { level, op, ts: new Date().toISOString(), ...fields };
    if (level === "error") console.error(JSON.stringify(entry));
    else if (level === "warn") console.warn(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
  }
  ```

- **Sanitizar headers antes de logar**:
  ```typescript
  function safeHeaders(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of req.headers.entries()) {
      if (/auth|cookie|token|key/i.test(k)) out[k] = "<redacted>";
      else out[k] = v;
    }
    return out;
  }
  ```

## Gotchas

- **`console.log(error)`**: imprime stack completo em alguns runtimes. Sempre extrair `.message` antes
- **`console.log(env)`**: vaza todos os secrets em `wrangler tail`. Logar apenas `Object.keys(env)` se precisar debugar
- **`JSON.stringify(error)`**: `Error` tem propriedades nao-enumeraveis — sai como `{}`. Usar `error.message`
- **Try/catch vazio**: erro silenciado vira bug invisivel. Sempre logar ou re-throw
- **Log dentro de loop**: 10k iteracoes = 10k linhas de log = quota do Workers Analytics. Logar so na borda do loop ou usar metric agregada
- **Stack em prod**: `error.stack` vaza paths internos do bundle (`/workspace/src/...`). Em prod logar so `error.message`
- **`wrangler tail` em prod com trafego real**: expoe logs ao vivo — controle de acesso e por login Cloudflare. Nao deixar aberto sem necessidade
- **Frontend: `console.log` esquecido**: usuario ve. ESLint `no-console` em prod build (whitelist `error`/`warn` se necessario)
