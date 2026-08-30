---
name: releasing-versions
description: Release versionada. Se o projeto tem release-please configurado, o fluxo E release-please — commits convencionais na main, a action abre sozinha o PR de release, e mergear esse PR gera tag + GitHub Release. Sem release-please, cai no fallback manual de PR de release. Use quando ha mudancas em main prontas pra virar versao.
---

# Release

Esta skill tem **dois regimes**, e o regime e **detectado, nunca assumido**:

- **Regime release-please** — o projeto tem release-please configurado. A action e a dona do CHANGELOG, da versao e da tag. Voce so escreve commits convencionais.
- **Regime manual (fallback)** — o projeto NAO tem release-please. Vale o fluxo de PR de release descrito no fim deste arquivo.

A rule que governa isso e `~/.claude/rules/releases.md`, secao "Release-please (fonte primaria quando configurado)". Em caso de divergencia, a rule ganha.

## 0. Detectar o regime (SEMPRE o primeiro passo)

```bash
ROOT=$(git rev-parse --show-toplevel) || exit 1
RP=""
[ -f "$ROOT/release-please-config.json" ] && RP="config"
[ -z "$RP" ] && [ -f "$ROOT/.release-please-manifest.json" ] && RP="manifest"
[ -z "$RP" ] && grep -rq "release-please-action" "$ROOT/.github/workflows/" 2>/dev/null && RP="workflow"
echo "${RP:-manual}"
```

- Saida `config` / `manifest` / `workflow` → **REGIME RELEASE-PLEASE** → seguir as secoes 1 a 4. O fallback manual **nao se aplica**; nem leia.
- Saida `manual` → **REGIME MANUAL** → pular direto pro fallback no fim do arquivo.

Duas coisas nao negociaveis nesse passo:

- **Checar as TRES formas.** Da pra configurar release-please so por input de workflow, sem arquivo de config na raiz. Uma deteccao presa ao arquivo de raiz le esse projeto como "manual", escreve no `CHANGELOG.md` o que a action vai reescrever, e isso e conflito garantido (`rules/releases.md`).
- **Ancorar na raiz do repo.** Os tres testes sao relativos ao diretorio; rodar de um subdiretorio da falso `manual`. Por isso `ROOT=$(git rev-parse --show-toplevel)`.

---

## 1. Regime release-please — este e o fluxo

### 1.1 Divisao de trabalho

| Voce faz | A action faz |
| --- | --- |
| Escreve commits em **Conventional Commits** (`feat:`, `fix:`, `feat!:` …) | Deriva a versao a partir dos commits desde a ultima tag |
| Manda esses commits pra `main` **via PR** | Escreve o `CHANGELOG.md` inteiro |
| Revisa e mergeia o PR que a action abre | Bumpa a `version` do `package.json` |
| Decide (opcional) forcar uma versao com `Release-As:` | Atualiza os `extra-files` — inclusive o badge do README pelo marcador `x-release-please-version` |
| | Abre / atualiza o PR `chore(main): release X.Y.Z` |
| | No merge desse PR: cria a **tag** e a **GitHub Release** |

**O que a action NAO faz neste repo:** publicar no npm. O workflow `release-please.yml` roda so a `release-please-action`; nao ha workflow de publish. Mergear o PR do bot produz **a tag e a GitHub Release, e nada alem disso** — quem consome por `npx` continua recebendo a versao anterior ate alguem publicar. Se o projeto precisa de npm, isso e uma decisao de operador fora desta skill.

### 1.2 Anatomia do fluxo

```
commits convencionais na main
        ↓
a action abre "chore(main): release X.Y.Z"
        ↓
merge desse PR
        ↓
tag + GitHub Release, automaticamente (e so isso — sem publish)
```

### 1.3 O que NUNCA fazer neste regime

- NUNCA editar `CHANGELOG.md` a mao — a action reescreve e o conflito e garantido <!-- release-please:prohibition -->
- NUNCA rodar `npm version` nem bumpar `package.json` a mao <!-- release-please:prohibition -->
- NUNCA trocar o badge do README a mao — o marcador `x-release-please-version` faz isso <!-- release-please:prohibition -->
- NUNCA `git tag` nem `gh release create` a mao — a action cria os dois no merge <!-- release-please:prohibition -->
- NUNCA mover a secao `## [Unreleased]` — release-please nem usa essa secao <!-- release-please:prohibition -->
- NUNCA commitar release direto na `main` — tudo vai por PR, inclusive o commit que carrega `Release-As:`. O unico commit que aterrissa sem PR humano e o da propria action.

### 1.4 Inspecionar o estado (read-only)

```bash
gh pr list --search 'author:app/github-actions "chore(main): release"'
gh release view --json tagName,publishedAt
cat "$ROOT/.release-please-manifest.json"
```

---

## 2. Forcar uma versao — `Release-As: X.Y.Z`

O unico jeito de mandar na versao e um rodape `Release-As:` no **corpo do commit** que aterrissa na `main`:

```
chore: release 1.0.0

Release-As: 1.0.0
```

**Gotcha do squash.** Num repo que so permite squash merge, a action le o rodape do **commit de squash** que aterrissa na `main`. Um `Release-As:` que existe so no commit da branch e descartado pelo squash e ignorado. Receita:

```bash
git checkout -b chore/release-as-1.0.0
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
git push -u origin chore/release-as-1.0.0
gh pr create --title "chore: release 1.0.0" --body "Release-As: 1.0.0"
```

Na hora de mergear, garantir que o **body do squash commit** contem a linha `Release-As: 1.0.0`. Nunca commitar isso direto na `main`.

### 2.1 Por que um `feat!` em 0.55.71 da 0.56.0 e nao 1.0.0

Derivado do `release-please-config.json` deste repo:

| config | valor | efeito enquanto a versao e `< 1.0.0` |
| --- | --- | --- |
| `bump-minor-pre-major` | `true` | breaking change (`feat!`, `BREAKING CHANGE:`) bumpa **minor**, nao major → `0.55.71` + `feat!` = **`0.56.0`**, nao `1.0.0` |
| `bump-patch-for-minor-pre-major` | `false` | `feat:` continua bumpando **minor** (`0.55.71` → `0.56.0`); `fix:` bumpa patch (`0.55.71` → `0.55.72`) |

Conclusao explicita: **pre-1.0 nao existe caminho automatico pra `1.0.0`.** Nenhum commit, por mais breaking que seja, leva ate la. A unica forma e `Release-As: 1.0.0`.

### 2.2 Bump major: confirmar DUAS vezes

- `Release-As: 1.0.0` (ou qualquer major) exige confirmar com o operador **duas vezes** — pergunta explicita, resposta explicita, duas vezes, antes de escrever o rodape.

---

## 3. Release travado: PR do `github-actions[bot]` sem CI

### Sintoma

O PR `chore(main): release X.Y.Z` e autorado pelo `github-actions[bot]`, o CI aparece em `action_required` ou com **zero jobs**, e o entry-gate nega o merge com:

```
No CI checks are reported; merge is denied.
```

### Por que

Um PR aberto com o `GITHUB_TOKEN` padrao **nao dispara** workflows `on: pull_request` — e a protecao anti-recursao do GitHub, incondicional e nao desligavel por toggle. Quando existe run mas ele depende de aprovacao, ele fica em `action_required` sem materializar job nenhum. Nos dois casos o gate nega, e nos dois casos **o gate esta certo**: rollup vazio → `state: "missing"`; `ACTION_REQUIRED` → classificado como **red**.

### Diagnostico

```bash
gh pr view <N> --json statusCheckRollup      # exatamente o que o entry-gate le
gh run list --branch release-please--branches--main --json status,conclusion,databaseId
```

### Desbloqueio — fazer o CI existir

As duas formas de falha sao observaveis diferentes e tem saidas diferentes:

**A) Existe run, parado em `action_required`** → aprovar o run:
- GitHub UI: aba **Actions** → o run pendente → **Approve and run**; ou
- `gh api -X POST repos/{owner}/{repo}/actions/runs/{run_id}/approve`

**B) Nao existe run nenhum** (o caso do `GITHUB_TOKEN`) → nao ha o que aprovar. Saidas:
1. **Um humano fecha e reabre o PR** (`gh pr close <N> && gh pr reopen <N>`, ou pelos botoes) — o evento `reopened` fica atribuido a uma pessoa e o `on: pull_request` dispara. Esta e a saida que sempre existe e nao encosta no gate.
2. Dar um PAT a `release-please-action` via `token:`, pra o PR ter autoria humana — **decisao de operador, fora desta skill**.
3. Acrescentar ao workflow de CI um trigger que cubra a branch de release — **decisao de operador, fora desta skill**.

Sobre o toggle **Settings → Actions → General** ("Allow GitHub Actions to create and approve pull requests" e a politica de aprovacao de runs): ele governa se a Actions pode criar/aprovar PR e como runs pendentes sao aprovados. Ele **nao** faz um `on: pull_request` disparar pra PR autorado pelo `GITHUB_TOKEN` — nao adianta procurar a cura so ali.

### Nunca contornar o gate

- NUNCA contornar o entry-gate: nada de `gh pr merge --admin`, nada de desligar o gate, nada de mergear "porque o CI nao existe". Rollup vazio negando merge **e o gate funcionando** — a saida e fazer o CI existir, nunca fazer o gate calar.

O ramo FAIL-SOFT do fallback manual (mais abaixo) vale **so** naquele fallback, num projeto que nao tem workflow de CI nenhum. Sob release-please, saida vazia significa run esperando aprovacao ou run que nunca nasceu — fail-closed, sempre.

---

## 4. Reportar

- A versao que a action vai publicar (do titulo do PR do bot ou do `.release-please-manifest.json`).
- A URL do PR `chore(main): release X.Y.Z`.
- Que o merge produz tag + GitHub Release, e nada alem disso.
- Que **deploy continua desacoplado** — release publica versao, deploy promove em prod, decisoes separadas (`/deploy`).

PARAR aqui. Merge e deploy sao decisoes explicitas do operador.

---
<!-- release-please:fallback-start -->

## Fallback manual — SO para projetos SEM release-please

> **PARE.** Se o passo 0 detectou release-please configurado por qualquer uma das tres
> formas, esta secao inteira NAO se aplica — volte pra secao 1. Este fallback existe
> porque esta skill e vendorizada em projetos SEM release-please, e pra eles o fluxo
> manual de PR de release e o fluxo legitimo (`rules/releases.md`: "o restante desta
> rule ... e o fallback para projetos SEM release-please configurado").

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

- Se `$LAST_MSG` casa com `^chore: release v[0-9]+\.[0-9]+\.[0-9]+( \(#[0-9]+\))?$` E nao existe tag pra essa versao → **MODO FINISH**
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

Se `$PR_NUMBER` vier vazio, o commit nao carrega `(#N)` — parar e perguntar. A deteccao de modo aceita o sufixo como opcional, entao este caso e alcancavel; e `gh pr checks ""` nao reclama do argumento vazio: cai no PR do branch atual (sai 1 com `no pull requests found for branch <nome>`), degradando o gate silenciosamente pro ramo FAIL-SOFT abaixo — ou gateando no PR errado.

Avaliar o conteudo de `$STATES` em quatro ramos — contra o STATE, nao o exit code:

- **Saida vazia** (`$STATES` em branco): repo nao tem CI workflow → **FAIL-SOFT** (warn, nao bloqueia). Avisar usuario que nenhum CI workflow esta configurado, mas prosseguir. Este FAIL-SOFT vale SO aqui, neste fallback manual de projeto sem nenhum workflow de CI — sob release-please, saida vazia significa run esperando aprovacao (ou run que nunca nasceu) e o comportamento e fail-closed (secao 3).
- **Contem `FAILURE`, `ERROR`, `CANCELLED` ou `TIMED_OUT`**: CI esta **red** → **refuse** the release — nao criar tag. Parar e reportar checks que falharam. Reverter via `git revert -m 1 <merge-sha>` + PR de revert (ou botao "Revert" no GitHub via `gh pr view <N> --web`).
- **Apenas `SUCCESS`, `SKIPPED`, `NEUTRAL` ou `PENDING` resolvidos**: CI esta verde → prosseguir.
- **Qualquer outro estado** (`ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED`, `EXPECTED` — todos valores reais dos enums `CheckConclusionState` / `CheckStatusState` / `StatusState` do GitHub): **NAO e verde** → parar e perguntar. `ACTION_REQUIRED`, `STARTUP_FAILURE` e `STALE` sao conclusoes de nao-sucesso; os demais dizem que o run ainda nao concluiu. Nunca ler "nenhum dos quatro tokens vermelhos esta presente" como verde.

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

## Regras do fallback manual

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
<!-- release-please:fallback-end -->
