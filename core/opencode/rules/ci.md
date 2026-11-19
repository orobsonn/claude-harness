---
paths:
  - ".github/workflows/**"
  - ".github/actions/**"
---

# CI enxuto (GitHub Actions)

Carrega ao editar workflows e actions em `.github/`. Define o padrao de CI barato: o PR e a porta, cada minuto cobrado tem que pagar por si. Organizacao no plano Free tem **2.000 minutos/mes** pra todos os repos privados juntos — uma suite de 11 min rodando duas vezes por PR estoura a cota em dias.

## Conventions

### O PR e a porta
- A suite que o PR validou **nao roda de novo** no push da `main`. O merge ja foi gateado
- No push da `main` roda so o que e barato ou necessario: release (release-please), deploy, trava de segredos
- Workflow de teste dispara em `pull_request` (nunca `pull_request_target`), com `branches: [main]`

### No PR, so os testes afetados
- Vitest: `npx vitest run --changed origin/${{ github.base_ref }} --passWithNoTests`. Jest: `npx jest --changedSince=origin/${{ github.base_ref }} --passWithNoTests`
- Checkout com `fetch-depth: 0` — sem historico, `origin/<base>` nao existe e o `--changed` nao tem contra o que comparar
- Arquivo lido fora do grafo de imports (migrations, `wrangler.jsonc`, fixtures lidas por `fs`, schemas JSON) entra em `forceRerunTriggers` do Vitest — mudou, roda tudo
- Runner sem modo "afetados" (`node --test`): suite completa no PR so se for curta (< ~3 min); senao, filtrar por pasta via script

### Suite completa — uma vez, fora do caminho do PR
- Workflow proprio (ex.: `ci-completo.yml`) com tres gatilhos: `schedule` noturno, `workflow_dispatch` e label `ci-completo` no PR
- O noturno so roda se houve commit nas ultimas 24 h — guarda no **inicio** do job, antes de instalar dependencia
- Antes de release, a ultima suite completa tem que estar verde (ver `releases.md`)

### Job caro em workflow proprio
- Imagem Docker, e2e (Playwright), container, build pesado: cada um no seu workflow, com `paths:` so da pasta dele (e do proprio arquivo do workflow)
- Nunca pendurar job caro no workflow de unit — ele herda os gatilhos do unit e roda a cada PR

### Runner caro so quando necessario
- Multiplicador de cobranca: `ubuntu-latest` 1x, `windows-latest` **2x**, `macos-latest` **10x**
- Windows/macOS so com `paths:` restrito ao codigo especifico da plataforma, ou no noturno — nunca em todo PR

### Configuracao basica em todo workflow/job
- `concurrency` no topo: `group: ${{ github.workflow }}-${{ github.ref }}` + `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` — push novo no PR cancela o run velho
- `timeout-minutes` em todo job (default do GitHub e 360 min — job travado queima 6 h)
- Cache de dependencias: `actions/setup-node` com `cache: npm` (ou pnpm/yarn) + `npm ci`
- `permissions` minimas no topo (`contents: read`); job que precisa de mais declara so o que usa

### Actions de terceiro
- Action fora de `actions/*` e `github/*` so fixada por SHA completo: `uses: dono/action@<sha-40> # v1.2.3`. Tag e mutavel — quem controla a action troca o codigo sob a mesma tag
- Preferir filtro nativo (`paths:`, `if:`) a action de terceiro que faz a mesma coisa (ex.: `dorny/paths-filter`)
- Dependabot com `package-ecosystem: github-actions` mantem os SHAs atualizados

### Varredura de segredos
- gitleaks (ou o scanner que o projeto ja usa) como **step** dentro de um job de governanca que ja existe — nao criar job so pra isso: todo job paga no minimo 1 minuto cheio
- Rodar o binario/imagem do gitleaks com versao fixada, nao a `gitleaks/gitleaks-action` (exige licenca paga em conta de organizacao)

### Orcamento — medir minutos por repo
- Estimativa: `execucoes/mes × minutos por job (arredondado pra cima) × multiplicador do runner`, somado por job
- Medicao real: Settings da organizacao → Billing → Usage, filtrado por repo (ou `gh api /organizations/<org>/settings/billing/usage`)
- Ao criar ou mudar workflow, informar o custo estimado em minutos/mes. Org Free = 2.000 min/mes no total — um repo sozinho nao deveria passar de algumas centenas

## Patterns

- **Workflow de PR (testes afetados + trava de segredos no mesmo job)**:
  ```yaml
  name: CI
  on:
    pull_request:
      branches: [main]
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  permissions:
    contents: read
  jobs:
    test:
      runs-on: ubuntu-latest
      timeout-minutes: 15
      steps:
        - uses: actions/checkout@v4
          with:
            fetch-depth: 0
        - uses: actions/setup-node@v4
          with:
            node-version: "22"
            cache: npm
        - run: npm ci
        - run: npx vitest run --changed origin/${{ github.base_ref }} --passWithNoTests
        - name: Varredura de segredos (so commits do PR)
          run: |
            docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/repo" -w /repo ghcr.io/gitleaks/gitleaks:v8.24.0 \
              git --redact --log-opts="origin/${{ github.base_ref }}..HEAD"
  ```

- **Suite completa (noturno com guarda + manual + label)**:
  ```yaml
  name: CI completo
  on:
    schedule:
      - cron: "0 6 * * *"
    workflow_dispatch:
    pull_request:
      types: [labeled, synchronize]
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  permissions:
    contents: read
  jobs:
    full:
      if: github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ci-completo')
      runs-on: ubuntu-latest
      timeout-minutes: 30
      steps:
        - uses: actions/checkout@v4
        - name: Pula se nao houve commit nas ultimas 24 h
          id: guard
          if: github.event_name == 'schedule'
          run: |
            if [ -z "$(git log -1 --since='24 hours ago' --format=%H)" ]; then
              echo "skip=true" >> "$GITHUB_OUTPUT"
            fi
        - uses: actions/setup-node@v4
          if: steps.guard.outputs.skip != 'true'
          with:
            node-version: "22"
            cache: npm
        - run: npm ci
          if: steps.guard.outputs.skip != 'true'
        - run: npx vitest run
          if: steps.guard.outputs.skip != 'true'
  ```

- **`forceRerunTriggers` mantendo os defaults do Vitest**:
  ```typescript
  // vitest.config.ts
  export default defineConfig({
    test: {
      forceRerunTriggers: [
        "**/package.json/**",
        "**/{vitest,vite}.config.*/**",
        "**/migrations/**",
        "**/wrangler.jsonc",
        "**/test/fixtures/**",
      ],
    },
  });
  ```

- **Job caro com `paths:` proprio**:
  ```yaml
  name: Docker
  on:
    pull_request:
      paths:
        - "Dockerfile"
        - "docker/**"
        - ".github/workflows/docker.yml"
  ```

## Gotchas

- **Suite repetida no push da `main`**: no caso que motivou esta rule, 28% dos minutos eram a mesma suite rodando de novo depois de passar no PR. O PR e a porta
- **Workflow com `paths:` como required check**: se o filtro pula o workflow, o check fica "Expected — Waiting" pra sempre e trava o merge. Required check so em workflow que roda em todo PR
- **`forceRerunTriggers` customizado sem os defaults**: o valor substitui a lista padrao — mudar `package.json` deixa de rodar tudo. Sempre repetir `package.json` e `vitest.config`
- **`--changed` com checkout raso**: `fetch-depth` default e 1 — `origin/<base>` nao existe e o Vitest erra ou roda nada. `fetch-depth: 0`
- **`--changed` sem `--passWithNoTests`**: PR que so mexe em doc nao acha teste afetado e sai com erro
- **`cancel-in-progress: true` incondicional**: na `main` cancela deploy/release no meio. Condicionar a `pull_request`
- **Job sem `timeout-minutes`**: teste travado aguardando rede queima ate 360 min antes do GitHub matar
- **Job separado so pra lint/scan de 20 s**: cobrado como 1 minuto cheio. Juntar como step em job existente
- **`windows-latest`/`macos-latest` em todo PR**: 2x e 10x o custo. Restringir com `paths:` ou mover pro noturno
- **Build Docker a cada mudanca**: workflow proprio com `paths:` + cache de camadas (`cache-from: type=gha`)
- **Action de terceiro por tag (`@v3`)**: tag pode ser reapontada pra codigo malicioso com acesso ao `GITHUB_TOKEN` e aos segredos do job. SHA completo
- **Noturno sem guarda de commit**: roda 30 vezes por mes mesmo em repo parado. Guarda no inicio do job
- **Dependabot abrindo 1 PR por pacote**: cada PR dispara o CI. Agrupar (`groups:`) e cadencia semanal
