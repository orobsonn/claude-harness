---
name: releasing-versions
description: Pipeline de release versionado via PR — abre PR chore/release-X.Y.Z (bump + CHANGELOG), aguarda merge, e ai cria tag + GitHub Release. Use quando voce tem mudancas merged em main prontas pra virar versao.
---

# Release

Cria release versionada via PR seguindo `~/.claude/rules/releases.md`. Tem 2 modos:

- **OPEN** — abre PR `chore: release vX.Y.Z` (default quando nao ha PR pendente)
- **FINISH** — apos merge do PR, cria tag + GitHub Release (detectado automaticamente)

## Pre-requisitos

- Estar em repo git com `origin` apontando pra GitHub
- `CHANGELOG.md` existe na raiz e tem `## [Unreleased]` preenchido (no MODO OPEN)
- `package.json` existe na raiz com `version`
- `gh` CLI autenticado
- Settings do repo: "Allow squash merging" ligado (e os outros desligados)

## Input do usuario

- **Tipo de bump** (no MODO OPEN) — patch (default), minor, major
- **Deploy apos release** — NAO acoplado por default. Apos `gh release create`, o usuario decide se invoca `/deploy`

## Detectar modo

```bash
# Pull main pra ter visao atualizada
git checkout main && git fetch origin && git pull --ff-only
LAST_MSG=$(git log -1 --format=%s)
```

- Se `$LAST_MSG` casa com `^chore: release v[0-9]+\.[0-9]+\.[0-9]+$` E nao existe tag pra essa versao → **MODO FINISH**
- Se ha branch local ou PR aberto `chore/release-*` → reportar estado e perguntar (provavel meio caminho)
- Caso contrario → **MODO OPEN**

---

## MODO OPEN — abrir PR de release

### 1. Pre-flight em main
```bash
git status                          # working tree limpo
git log origin/main..HEAD --oneline # main em sync (vazio = ok)
```
Se nao estiver limpo / sync, parar e pedir pra resolver.

### 2. Validar `[Unreleased]` no CHANGELOG
```bash
head -30 CHANGELOG.md
```
Se `[Unreleased]` esta vazia (so subsecoes vazias), parar — nada pra release-ar. Se ha entries, mostrar pro usuario confirmar antes de prosseguir.

### 3. Calcular nova versao
- Ler `version` do `package.json`
- Aplicar bump (patch default): `0.0.1` → `0.0.2`, `0.0.5` → `0.0.6`
- Minor: `0.0.x` → `0.1.0`
- Major: `0.x.x` → `1.0.0` — confirmar com usuario DUAS vezes
- Confirmar a versao final com usuario

### 4. Verificacoes locais
Rodar o que `<projeto>/.claude/CLAUDE.md` define. Detectar o tipo de projeto:
- Se `package.json` existe: rodar `npx tsc --noEmit && npm test`
- Se apenas `VERSION` file e sem `package.json` (ex.: este harness com `node --test`): rodar `node --test` ou o comando de teste declarado no projeto
```bash
# Exemplo: detectar tipo e rodar verificacao apropriada
if [ -f package.json ]; then
  npx tsc --noEmit && npm test
else
  node --test          # ou outro comando do projeto
fi
```
Se falhar, parar — nao release.

### 5. Criar branch dedicada
```bash
git checkout -b chore/release-X.Y.Z
```

### 6. Bump da versao (sem criar tag)
```bash
npm version X.Y.Z --no-git-tag-version   # projetos com package.json
```
- **Sem `package.json`** (ex.: este harness usa um arquivo `VERSION`): editar o arquivo de versao direto (`VERSION` → `X.Y.Z`).
- **Versao hardcoded visivel**: atualizar TODO ponto que repete a versao — em especial o badge do README (`grep -n 'version-[0-9]' README.md` → trocar pra `version-X.Y.Z`). Senao a tag sobe mas o badge fica pra tras (gotcha real, v0.11.0).

### 7. Mover entries no CHANGELOG
Editar `CHANGELOG.md`:
- `## [Unreleased]` vira `## [X.Y.Z] - YYYY-MM-DD`
- Inserir novo `## [Unreleased]` no topo com 4 subsecoes vazias (Added/Changed/Fixed/Removed)

### 8. Extrair release notes (pro body do PR e pra release notes depois)
```bash
awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > /tmp/release-notes-X.Y.Z.md
```
Validar que o arquivo tem conteudo (nao vazio).

### 9. Commit + push branch
```bash
git add CHANGELOG.md package.json VERSION README.md   # os que existirem / foram tocados no passo 6
git commit -m "chore: release vX.Y.Z"
git push -u origin chore/release-X.Y.Z
```

### 10. Abrir PR
```bash
gh pr create --title "chore: release vX.Y.Z" --body-file /tmp/release-notes-X.Y.Z.md
```

### 11. Reportar
- URL do PR
- Versao a ser release-ada
- Instrucao: "Mergeia no GitHub (squash) e invoca /release de novo pra fechar (tag + GitHub Release)"

PARAR aqui. Nao tentar mergear pelo CLI sem autorizacao explicita do usuario.

---

## MODO FINISH — fechar release apos merge

### 1. Confirmar que esta no commit certo
```bash
LAST_MSG=$(git log -1 --format=%s)
# Esperado: "chore: release vX.Y.Z (#N)"  — squash adiciona "(#N)"
echo "$LAST_MSG"
```
Extrair versao do final do commit message. Se nao bater, parar e perguntar.

### 2. Verificar CI verde via PR checks
Extrair PR number do commit message (sufixo `(#N)`) e validar CI — usar parsing de STATE explicito, nunca so o exit code (exit 1 e ambiguo: falha E "sem checks" retornam 1):
```bash
PR_NUMBER=$(echo "$LAST_MSG" | sed -nE 's/.*\(#([0-9]+)\).*/\1/p')  # ex.: "chore: release v0.13.0 (#41)" → 41
STATES=$(gh pr checks "$PR_NUMBER" --json state -q '.[].state' 2>/dev/null)
```
Avaliar o conteudo de `$STATES` em tres ramos — contra o STATE, nao o exit code:

- **Saida vazia** (`$STATES` em branco): repo nao tem CI workflow → **FAIL-SOFT** (warn, nao bloqueia). Avisar usuario que nenhum CI workflow esta configurado, mas prosseguir.
- **Contem `FAILURE`, `ERROR`, `CANCELLED` ou `TIMED_OUT`**: CI esta **red** → **refuse** the release — nao criar tag. Parar e reportar checks que falharam. Reverter via `git revert -m 1 <merge-sha>` + PR de revert (ou botao "Revert" no GitHub via `gh pr view <N> --web`).
- **Apenas `SUCCESS`, `SKIPPED`, `NEUTRAL` ou `PENDING` resolvidos**: CI esta verde → prosseguir.

Se falhar por Red CI, parar e reportar.

### 3. Confirmar que tag ainda nao existe
```bash
git tag -l "vX.Y.Z"
```
Se existir, parar — release ja foi feita.

### 4. Criar tag local
```bash
git tag vX.Y.Z
```

### 5. Extrair release notes
```bash
awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > /tmp/release-notes-X.Y.Z.md
```
Validar conteudo.

### 6. Push tag
```bash
git push origin vX.Y.Z
```

### 7. Criar GitHub Release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes-X.Y.Z.md --latest
```

### 8. Reportar
- Nova versao publicada
- URL da GitHub Release
- Hash da tag
- Pergunta: "Quer fazer deploy agora? (`/deploy`) Default seguro: `versions upload` → smoke → promote 100% → smoke prod"

PARAR aqui. Deploy e decisao explicita.

---

## Regras

- NUNCA commit de release direto em `main` — sempre via PR `chore/release-X.Y.Z`
- NUNCA criar tag antes do merge do PR — tag apontaria pra commit fora da main
- NUNCA esquecer `--latest` no `gh release create`
- NUNCA force push tag (deletar tag remota antes via `git push origin :refs/tags/vX.Y.Z` exige confirmacao explicita)
- NUNCA acoplar deploy ao release sem confirmacao — release publica versao, deploy promove em prod, sao decisoes separadas
- Se algum passo falhar (tsc, test, push, PR), parar e reportar — release parcial e pior que sem release
- Se `[Unreleased]` esta vazio no MODO OPEN, parar — nao tem o que release-ar
- Bump major (`0.x.x` → `1.0.0`): **sempre** confirmar com usuario duas vezes

## Por que via PR (e nao commit direto)

- **Auditoria**: PR fica como registro permanente — quem aprovou, quando, o que mudou
- **CI bate de novo**: se houver workflow `on: pull_request`, ele roda no PR de release, pega regressao introduzida desde o ultimo release
- **Reversao limpa**: PR pode ser revertido via `git revert -m 1 <merge-sha>` + PR de revert (ou botao "Revert" no GitHub via `gh pr view <N> --web`) se a release der ruim — commit direto so via `git revert + force-push`
- **Sem custo extra**: ja temos `gh` CLI, abrir PR e merge sao 2 comandos
- **Coerencia**: o resto do projeto e via PR, release segue mesma disciplina

## Por que deploy nao e acoplado

- Release = publicar versao identificavel (tag + notes)
- Deploy = promover bits pra prod
- As 2 acoes podem acontecer em momentos diferentes (release agora, deploy depois de gate de homologacao)
- Forcar acoplamento esconde o passo critico de smoke test do `/deploy`
