# Security

Universal — sem `paths:`, carrega em toda conversa.

## Conventions

### Secrets
- NUNCA hardcodar secret em `.ts`/`.tsx`/`.json` versionado
- Secret de runtime fica em variavel de ambiente — `env.<NOME>` em Cloudflare Workers, `process.env.<NOME>` em Node
- `.dev.vars`, `.env*`, `.env.local`, `.local.*` SEMPRE no `.gitignore`
- Cada secret novo: adicionar placeholder em `.dev.vars.example` ou `.env.example` (sem valor real)
- `wrangler.{toml,jsonc}` `vars` e PUBLICO (vai pro bundle) — apenas URL base, flags, IDs publicos. Secret real via `wrangler secret put`

### Erros (sem leak)
- NUNCA propagar `error.message`/`error.stack` cru pra response do client — sempre wrapper de erro sanitizado
- Body de erro de servico externo: truncar antes de logar (max ~500 chars) — corpo grande pode vazar JWT, cookies, tokens
- Mensagem pro cliente: generica ("Falha ao processar pedido"). Detalhe so em log interno

### Input externo
- Toda entrada externa (HTTP body, query, headers, webhook) validada antes do handler usar
- Preferir Zod (ou Yup) com schema + `.parse()` na borda
- Constraints realistas: `limit` com `max`, IDs com regex, datas com formato. Default seguro
- NUNCA confiar em headers de "identidade" sem validar (`X-User-Id` sem JWT = qualquer um se passa por qualquer um)

### Auth
- Authentication = "quem voce e": valida JWT signature + expiracao, nao so presenca de header
- Authorization = "o que voce pode fazer": checar role/permission no handler — nao confiar so em "esta autenticado"
- Cloudflare Access na frente: Worker confia no header `cf-access-jwt-assertion` apenas se o dominio so aceita trafego via Access
- OAuth `redirect_uri` em allowlist explicita — sem wildcard em TLD alheio

### Logs
- NUNCA logar: API key, Authorization header, JWT, password, .dev.vars, request body inteiro, query string com token
- Em prod: `error.message` apenas — NUNCA `error.stack` (vaza paths internos do bundle)
- Logs estruturados (JSON) facilitam redacao de campos sensiveis em pipeline de log

### Injection
- SQL/NoSQL: queries parametrizadas, nunca string concat (`db.query("SELECT ... WHERE id = ?", [id])`)
- Path traversal: `../` rejeitado em paths recebidos do usuario; usar `path.basename()` ou regex de allowlist
- Shell: subprocesso sempre com array de argumentos (`spawn("git", ["log", branch])`), nunca string concatenada com input do usuario
- Prototype pollution: `Object.create(null)` ou `Object.freeze` em config dinamica de fonte externa
- HTML injection / XSS: nunca interpolar input do usuario em HTML cru. React escapa por default; APIs que injetam HTML sem escapar exigem sanitizador (DOMPurify)

### Network
- CORS restritivo: allowlist de origins, nao `*` em endpoint com credenciais
- Rate limiting onde aplicavel (Cloudflare Rate Limiter binding, middleware)
- Timeout em chamada externa: `fetch` sem timeout = DoS interno se upstream travar
- Body size limit explicito em endpoint que recebe upload

### Dependencias
- `npm audit --omit=dev --audit-level=moderate` no CI — falha se vulnerabilidade moderate+ em deps de prod
- Dep nova: validar fonte (npm registry mainstream), autor, ultima release, downloads
- Pacote pre-1.0 (`0.x`): minor pode ser breaking — pin em `~0.x.y` ou bloquear no Dependabot
- Update major: nunca automatico — sempre PR manual com regression test

## Patterns

- **Wrapper de erro sanitizado**:
  ```typescript
  // src/utils/errors.ts
  /** @description Sanitiza erro pra response sem vazar stack. */
  export function sanitizeError(error: unknown): { message: string } {
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return { message };
  }

  // uso no handler
  try { ... } catch (error) {
    console.error(JSON.stringify({ op: "fetchUser", id, message: error instanceof Error ? error.message : String(error) }));
    return Response.json({ error: sanitizeError(error) }, { status: 500 });
  }
  ```

- **Validacao Zod na borda**:
  ```typescript
  const InputSchema = z.object({
    email: z.string().email(),
    age: z.number().int().min(0).max(120),
  });

  const input = InputSchema.parse(await request.json()); // throws se invalido
  ```

- **Truncar body de erro upstream**:
  ```typescript
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(`Upstream ${res.status}`, res.status, body.slice(0, 500));
  }
  ```

## Gotchas

- **Secret em `vars` do `wrangler.{toml,jsonc}`**: `vars` e publico (entra no bundle). Sempre `wrangler secret put`
- **`error.message` em response**: pode conter path interno, query SQL, nome de campo de DB. Sanitizar
- **Header `X-User-Id` sem validar**: qualquer cliente seta. Nunca confiar — usar JWT/sessao
- **CORS `*` com `credentials: include`**: navegador rejeita, mas dev as vezes ignora. Allowlist explicita
- **HTML cru com input do usuario**: XSS imediato. Escapar ou sanitizar com DOMPurify antes de injetar
- **`fetch` sem timeout**: upstream travado paralisa o Worker. Usar `AbortSignal.timeout(ms)`
- **`.env` commitado**: CI deve ter check (`git ls-files | grep -E '\.env'`). Validar localmente antes de push
- **Token de API com permissoes amplas em `.dev.vars`**: TTL curto (1-2h pra setup), revogar apos uso
