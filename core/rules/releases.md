---
paths:
  - "CHANGELOG.md"
  - "package.json"
---

# Releases

Carrega ao editar `CHANGELOG.md` ou `package.json`. Define padrao de versionamento, CHANGELOG, tag, GitHub Release e fluxo de deploy seguro.

## Conventions

### Versionamento (semver)
- Versao inicial `v0.0.1`
- Cada release autorizado incrementa **patch** por default (`0.0.1` → `0.0.2`)
- Bump de **minor** (`0.0.x` → `0.1.0`) quando consolida feature significativa
- Bump de **major** (`0.x.x` → `1.0.0`) so quando API publica estabiliza ou rompe contrato
- Pre-1.0 (`0.x.y`): minor pode quebrar contrato — comunicar no CHANGELOG

### CHANGELOG
- Arquivo `CHANGELOG.md` na raiz do projeto, formato **Keep a Changelog**
- Sempre presente: secao `## [Unreleased]` no topo com 4 subsecoes vazias
- Subsecoes em ordem fixa: `### Added`, `### Changed`, `### Fixed`, `### Removed`
- Ao bumpar versao: `[Unreleased]` vira `[X.Y.Z] - YYYY-MM-DD`, e novo `[Unreleased]` vazio aparece no topo
- Versoes ordenadas mais nova no topo
- Texto curto, focado em **impacto pro usuario** — nao detalhe interno

### Commits que entram no CHANGELOG
- `feat:` → `### Added`
- `fix:` → `### Fixed`
- `refactor:` / `perf:` → `### Changed` (so se afeta usuario)
- `chore:` / `test:` / `docs:` / `style:` → geralmente NAO entram (mudanca interna invisivel)
- Breaking change → `### Changed` com prefixo `BREAKING:` na linha

### Tags e GitHub Release
- Toda tag DEVE virar Release no GitHub — tag sozinha nao aparece como "Latest" na sidebar
- Titulo da release: so o numero (`v0.0.2`). Sem subtitulo — notes do CHANGELOG explicam
- `--latest` obrigatorio no `gh release create`
- `package.json` `version` SEMPRE alinhada com a ultima release

### `package.json`
- `version` em sync com a tag mais recente
- Bump via `npm version <X.Y.Z> --no-git-tag-version` (cria tag separado depois)
- Em monorepo pnpm com workspaces `private: true`, so o `package.json` raiz tem versao real — workspaces ficam em `0.0.0` permanente

### Release vai via PR — nunca commit direto em main
- Branch dedicada `chore/release-X.Y.Z`
- Commit unico `chore: release vX.Y.Z` na branch (bump do `package.json` + move `[Unreleased]` → `[X.Y.Z]`)
- PR com titulo `chore: release vX.Y.Z` e body contendo o extrato do CHANGELOG dessa versao
- Apos merge (squash): pull main, criar tag local apontando pro commit de release, push tag, `gh release create --latest`
- **Auditoria preservada** — qualquer release e reproduzivel pelo PR

### Deploy (Cloudflare Workers — padrao do stack)
- **2 modos** — skill `/deploy` pergunta sempre, nao decide sozinha:
  - **Direto** (`wrangler deploy`): ~5s, sobe 100% direto. Recomendado pra MVP/staging/projetos sem usuario real ainda. Sem preview, sem smoke entre etapas
  - **Versionado** (`wrangler versions upload` → smoke preview → `versions deploy @100%` → smoke prod): ~30s a mais. Recomendado pra prod com usuario real. `versions upload` gera URL `<version-id>-<worker>.<subdomain>.workers.dev` sem roteamento publico — bate `/health` antes de promover
- **Default sugerido pela skill** baseado em sinais do `<projeto>/.claude/CLAUDE.md` (tem dominio custom em prod? menciona usuarios reais?). Sempre confirma com usuario
- Rollback rapido (vale pros 2 modos — Cloudflare versiona internamente todo deploy): `wrangler rollback [version-id-anterior]` — segundos, sem rebuild
- Outras plataformas (Vercel, Pages): seguir convencao equivalente do `<projeto>/.claude/CLAUDE.md`

### Smoke test pos-deploy
- **Modo versionado**: smoke contra preview URL ANTES de promover, e contra prod APOS promover. Falha de smoke = parar e investigar
- **Modo direto**: smoke pos-deploy opcional (se projeto tem `/health`). Sem preview, sem smoke entre etapas — o "smoke" e o usuario reportando bug
- Worker idealmente expoe `/health` retornando 200 + JSON com `ok: true` + check do binding principal (D1, KV) — barato e habilita versionado quando virar produto serio
- Promover versao quebrada e o pior cenario possivel — peso do smoke escala com numero de usuarios

### CI green — release prerequisite
- **Postura aditiva**: CI verde (testes passando, gates verdes) e um prerequisito de release — **mandatory para new projetos, advisory (recomendado) para existing**
- Esta regra nao quebra fluxos de release em andamento; novos projetos entram com a pratica desde o inicio
- **No-admin-token fallback**: quando nao ha token de admin configurado no repo pra branch protection, o gate de CI fica disponivel (testes rodam, pode ser verificado localmente) mas nao e enforçado automaticamente no GitHub — a responsabilidade recai no time de validar manualmente antes do merge
- Postura aditiva: projetos que ja tem CI rodan continuam (advisory). Projetos novos ou que onboardam no harness devem adicionar step de CI check no fluxo de release (CHANGELOG + package.json + git hooks validam antes do commit)

## Patterns

- **Fluxo completo de release via PR (10 passos)**:
  ```bash
  # === MODO OPEN — abre PR de release ===

  # 1. Pre-flight em main
  git fetch origin && git status                       # working tree limpo
  git log origin/main..HEAD --oneline                  # main em sync
  head -30 CHANGELOG.md                                # [Unreleased] tem entries?
  grep '"version"' package.json | head -1              # versao atual?

  # 2. Verificacoes locais
  npx tsc --noEmit && npm test

  # 3. Criar branch e bumpar
  git checkout -b chore/release-0.0.2
  npm version 0.0.2 --no-git-tag-version

  # 4. Mover entries no CHANGELOG: [Unreleased] -> [0.0.2] - YYYY-MM-DD
  #    deixar [Unreleased] vazio com Added/Changed/Fixed/Removed

  # 5. Extrair release notes pro body do PR
  awk '/^## \[0\.0\.2\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > /tmp/release-notes.md

  # 6. Commit + push branch
  git add CHANGELOG.md package.json
  git commit -m "chore: release v0.0.2"
  git push -u origin chore/release-0.0.2

  # 7. Abrir PR
  gh pr create --title "chore: release v0.0.2" --body-file /tmp/release-notes.md

  # === Aguarda merge no GitHub (squash) ===

  # === MODO FINISH — apos merge ===

  # 8. Sincronizar main + criar tag local
  git checkout main && git pull
  git tag v0.0.2

  # 9. Push tag + criar GitHub Release (promove como "Latest")
  git push origin v0.0.2
  awk '/^## \[0\.0\.2\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > /tmp/release-notes.md
  gh release create v0.0.2 --title "v0.0.2" --notes-file /tmp/release-notes.md --latest

  # 10. Deploy (opcional, decisao do usuario — ver fluxo seguro abaixo)
  ```

- **Fluxo de deploy seguro (Cloudflare Worker)**:
  ```bash
  # 1. Upload da versao sem rotear trafego
  UPLOAD_OUT=$(wrangler versions upload --message "vX.Y.Z" 2>&1)
  VERSION_ID=$(echo "$UPLOAD_OUT" | grep -oE '[a-f0-9-]{36}' | head -1)
  PREVIEW_URL=$(echo "$UPLOAD_OUT" | grep -oE 'https://[a-z0-9-]+\.workers\.dev')

  # 2. Smoke contra preview (antes de promover)
  curl -fsS "$PREVIEW_URL/health" || { echo "Smoke preview falhou — abortando"; exit 1; }

  # 3. Promover a 100%
  wrangler versions deploy "$VERSION_ID@100%" --yes

  # 4. Smoke contra prod
  curl -fsS "https://<dominio-prod>/health" || { echo "Smoke prod falhou — rollback urgente"; exit 1; }

  # 5. (Se algo deu errado) rollback rapido sem rebuild
  # wrangler rollback <version-id-anterior>
  ```

- **CHANGELOG apos bump** (estado canonico):
  ```markdown
  # Changelog

  Todas as mudancas notaveis seguem o padrao [Keep a Changelog](https://keepachangelog.com/).

  ## [Unreleased]

  ### Added
  ### Changed
  ### Fixed
  ### Removed

  ## [0.0.2] - 2026-04-22

  ### Added
  - Endpoint /api/users com paginacao por cursor

  ### Fixed
  - Login redirect loop quando session expira durante navegacao

  ## [0.0.1] - 2026-04-21

  ### Added
  - Setup inicial do projeto
  ```

- **Entry boa de CHANGELOG** (foco no impacto):
  - BOM: `Login persiste apos cold start (sessao migrada de memoria pra KV)`
  - RUIM: `feat(auth): add KV binding to wrangler.jsonc`

## Gotchas

- **Numeracao de migration colidindo com branch concorrente**: ao criar `NNNN_nome.sql`, checar `ls migrations/ | grep -E '^NNNN'` contra `origin/main` (nao so o working tree local) — PRs paralelos podem reservar o mesmo numero. Dois arquivos com o mesmo prefixo nao quebram (wrangler rastreia por nome, nao por numero), mas e smell e confunde ordem
- **`d1 migrations apply --remote` fora do fluxo de deploy**: aplicar migration em prod durante demo/validacao (antes do merge) cria drift e abre janela pra colisao de numero com outro PR que mergeia no meio. Migration em prod **so** no deploy formal; pra validar antes, usar `--local` ou aceitar a feature atras do deploy
- **`wrangler versions deploy` sem `--yes`**: o prompt interativo trava em pipe (`yes |` NAO satisfaz) — em background vira task pendurada. Sempre `wrangler versions deploy "<id>@100%" --yes`
- **Commit de release direto em `main`**: viola auditoria. Sempre via branch `chore/release-X.Y.Z` + PR (ate em time de 1, pra ter history limpa e revertable)
- **`awk` com range `/a/,/b/`**: linha do header bate com os dois padroes. Usar flag-based: `/^## \[X.Y.Z\]/{flag=1; next} /^## \[/{flag=0} flag`
- **`--latest` ausente em `gh release create`**: release aparece no historico mas nao e promovida na sidebar do repo
- **Tag criada antes do merge do PR**: tag aponta pra commit que nao virou main. Sempre tag DEPOIS do merge, em main atualizada
- **Esquecer de mover `[Unreleased]`**: se commitar bump sem mover, awk extrai vazio. Validar com `head -30 CHANGELOG.md` antes
- **CI nao roda em push direto pra main nem em tags**: validar localmente antes (`npx tsc --noEmit && npm test`). PR de release faz CI bater de novo, pega ultimo regressao
- **`npm version` sem `--no-git-tag-version`**: cria tag automatica que nao agrupa com o commit do CHANGELOG e suja a branch. Usar a flag
- **`wrangler deploy` em vez de `versions upload` + `versions deploy`**: vai pros 100% direto sem smoke. Bug em prod pra todo mundo na hora. Default seguro e versions
- **Smoke pulado "porque foi mudanca pequena"**: 100% dos disasters em prod sao "mudanca pequena". Smoke obrigatorio, sem excecao
- **Rollback via `git revert + redeploy`**: gasta minutos rebuilding. `wrangler rollback <version-id>` reverte em segundos sem rebuild
- **Squash merge ausente nas settings do repo**: merge commit em PR de release vira ruido no CHANGELOG futuro. Configurar `Allow squash merging` apenas
- **CHANGELOG inflado com chore/refactor invisivel**: usuario nao se importa. Filtrar — entries triviais ficam de fora
