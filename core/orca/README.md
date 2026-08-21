# `core/orca/` — entrega autônoma multi-projeto sobre o Orca

Este diretório é o **substituto do motor de cron da VPS** (`core/vps/`, em aposentadoria — ver
`core/vps/DEPRECATED.md`). Ele contém tudo que sobrou depois de descobrir que quase nada era
necessário:

| Arquivo | Papel |
|---|---|
| `select-and-dispatch.mjs` | o selector: escolhe a issue, trava, despacha pro Orca |
| `project.example.json` | o formato de config — **um JSON por projeto** |
| `review-prompt.md` | o prompt da automação de review+merge — **template versionado**, ver abaixo |
| `select-and-dispatch.test.mjs` | oráculo congelado (seams injetados, zero CLI real) |

## O desenho: duas camadas, não dois motores

```
cron do usuário `orca`  ──▶  select-and-dispatch.mjs  ──▶  orca worktree create
   (1 linha por projeto)        (escolhe + trava)              │
                                                               ▼
                                          agente (claude) num worktree do Orca
                                                               │
                                                               ▼
                                          lê o .claude/ VENDORADO do repo
                                          → o pipeline vendorado É a pipeline
```

O agente lançado num worktree do Orca lê o `.claude/` do próprio repositório. Isso significa que a
pipeline de entrega (entry-policy, `triaging`, `orchestrating-delivery`, gates, hooks) já está lá —
**o selector não precisa de despachante próprio**. Era exatamente essa duplicação que o
`core/vps/` era: um segundo motor de orquestração reimplementando o que o `.claude/` do repo já faz.

Orca **despacha**; o harness do repo **executa**. As runs ficam visíveis do desktop e do celular,
que é o que o antigo `notify-telegram.mjs` existia para simular.

## O JSON de projeto

Um arquivo por projeto, tipicamente em `~/.config/claude-harness/projects/<slug>.json`:

```json
{
  "project": "oraculo-app",
  "ghRepo": "orobsonn/oraculo-app",
  "orcaRepoId": "repo_abc123",
  "baseBranch": "main",
  "agent": "claude",
  "globalMaxWorking": 4,
  "titleIncludes": null,
  "prompt": "Rode em MODO AUTÔNOMO (headless). ..."
}
```

| Campo | Obrigatório | Nota |
|---|---|---|
| `project` | sim | slug, só para log |
| `ghRepo` | sim | `owner/repo` — passado como `--repo` pro `gh` |
| `orcaRepoId` | sim | id do repo no Orca (`orca repo ls --json`) |
| `clonePath` | **sim** | caminho do clone que o Orca usa de base — ver "A base tem que ser remota" |
| `baseBranch` | não (`main`) | **nome** do branch base; o selector despacha em `origin/<baseBranch>` |
| `agent` | não (`claude`) | agente do Orca |
| `globalMaxWorking` | sim | **teto GLOBAL** — ver abaixo |
| `titleIncludes` | não (`null`) | filtro de título, case-insensitive — o **modo canário** |
| `prompt` | não | gatilho entregue ao agente |

`globalMaxWorking` é uma propriedade **da máquina, não do projeto**: o selector conta os worktrees
`working` de *toda* a VPS via `orca worktree ps --json`, então todos os JSONs precisam carregar o
**mesmo** valor. Validado em **4 agentes Claude simultâneos numa VPS de 2 vCPU / 8 GB**.

## Cron

Uma linha por projeto, no crontab do usuário `orca` (**nunca root**):

```cron
*/20 * * * * /usr/bin/node /home/orca/.claude/harness-core/core/orca/select-and-dispatch.mjs --config /home/orca/.config/claude-harness/projects/oraculo-app.json >> /home/orca/.local/state/claude-harness/oraculo-app.log 2>&1
```

Paralelizar por projeto é literalmente: mais um JSON, mais uma linha.

## As duas armadilhas que o motor antigo tinha (e que este não repete)

**1. Ordenar por `createdAt` sem nenhum outro filtro.** O `cron-a-select.mjs` pegava a issue
`harness:ready` aberta mais antiga, sem filtro de título ou escopo. Num backlog real, a mais antiga
era uma tarefa de *hard delete de PII de 5 meses atrás* — a primeira coisa que o motor escolheria.
Isso torna **modo canário impossível**: você não consegue abrir a pipeline só para uma tarefa
pequena e observável. Aqui, `titleIncludes` é o botão explícito: com `"[canary]"`, só issues cujo
título contém `[canary]` são candidatas, e a ordenação oldest-first opera **dentro** desse recorte.

**2. Ancorar a dependência num nome de branch.** O `chain-release.mjs:dependencyMerged` só
considerava uma dependência satisfeita se existisse um PR *merjado cuja head fosse literalmente*
`harness/<N>`. Issues entregues por PR normal — a maioria — nunca satisfaziam isso, e as dependentes
ficavam `harness:queued` para sempre (4 de 14 issues de um projeto estavam mortas assim). Pior: o
`chain-validate.mjs` **não detecta essa classe de falha** — ele só pega ciclo e referência dangling,
que são propriedades do *grafo*, não do *gate*. Aqui a pergunta é a que realmente importa: **a issue
da dependência está CLOSED?** — o estado que significa "entregue", independente de como foi entregue.

Estado de dependência ilegível é **fail-closed**: um soluço do `gh` nunca libera uma issue gated.

## Ordem que é carga estrutural

O flip `harness:ready` → `harness:in-progress` acontece **antes de existir qualquer worktree**. Se o
`orca worktree create` falhar, o selector devolve a issue à fila. Se *essa* devolução também falhar,
ele grita `STUCK: #N` no log — é o único estado que exige reparo humano, e ele nunca é silencioso.

## A base tem que ser remota (`clonePath` existe por isso)

`--base-branch main` **parece** certo e é silenciosamente errado. O Orca resolve esse nome contra o
**clone** de onde ele cria worktrees — e esse clone busca do remoto mas **nunca avança o branch
local**. Medido em produção:

```
main local do clone: 74da7e1   ← parado onde ele foi clonado
origin/main:         5e60d14   ← atualizado, fetch de minutos atrás
```

Toda run nasceu de `74da7e1` e conflitou com tudo que merjou desde então. O sintoma aparece **horas
depois**, no merge, como conflito em arquivo que a run nem tocou — e lê como bug do harness, não da
base. Pior: uma base velha o bastante pode ser *anterior* a uma decisão de projeto (foi o caso com a
adoção do release-please), e aí o agente toma a decisão certa **para a base errada**.

Por isso o selector faz, antes de pegar a trava:

```bash
git -C "$clonePath" fetch origin "$baseBranch" --quiet   # falhou → pula o tick
orca worktree create ... --base-branch "origin/$baseBranch"
```

**O `fetch` sozinho não resolve** — o branch local continua parado. A base precisa ser pedida pelo
nome **remoto**. E `clonePath` é obrigatório de propósito: com default, o bug volta calado.

## Revisão de PR + merge condicional

**O prompt é versionado aqui** (`review-prompt.md`) — substitua `<OWNER/REPO>` e `<BASE>` e instale
como prompt da automação. Ele nasceu artesanal em cada VPS, e o passo que faltava em todas era o
STEP 3.5 (abaixo): ninguém descobre que ele é necessário antes de perder uma noite de PRs.

**O motor não é código deste repo.** É uma **automação agendada do Orca**. Ela só merja quando:

- o veredito próprio da revisão é *merjar*;
- **nenhum** achado ARMADO de severidade alta;
- CI concluído em `SUCCESS`;
- sem conflito;
- e o merge passa `--match-head-commit <sha>` — obrigatório.

> **Consequência do `entry-gate.mjs`:** o comando de merge **não pode** passar `-R`/`--repo`.
> O gate (`core/shared/lib/merge-check-gate.mjs`, chamado pelo hook `entry-gate.mjs`) lê o rollup de
> checks do PR antes de permitir `gh pr merge` e **recusa alvo ambíguo**; `--repo`/`-R` e `--auto`
> resolvem para "ambíguo" por construção (um leitor escopado a um repositório não deve inspecionar um
> e merjar outro). A automação precisa rodar **dentro do checkout do repo alvo** e passar só o número
> do PR. Isso é feature, não obstáculo: mantém o gate de CI inescapável.

### STEP 3.5 — quem concilia os arquivos de anotação é o revisor

Duas runs paralelas partem da mesma base e **ambas acrescentam linha** nos mesmos arquivos de
anotação do harness: `.claude/memory/MEMORY.md`, `.claude/kaizen.md` e o `CLAUDE.md` da pasta tocada.
Isso conflita **sempre** — é consequência do desenho, não azar de timing. E o efeito em cascata é o
que dói:

```
conflito em kaizen.md  →  GitHub não computa o merge commit  →  checks de pull_request nunca rodam
                       →  revisão recusa (sem CI verde)      →  entrega para por bookkeeping
```

Recusar é o comportamento certo do gate. O erro é deixar o conflito de pé: os dois lados só
**acrescentam item em lista**, então a resolução correta é sempre **união** — e quem integra é quem
concilia. Daí o STEP 3.5 do `review-prompt.md`: se o PR está em conflito, o revisor faz
`git merge origin/<BASE>` no checkout, resolve por união **somente** dentro da allowlist
(`MEMORY.md`, `kaizen.md`, qualquer `CLAUDE.md`), lê o resultado, empurra, e só então merja.
Conflito **fora** dessa lista aborta o merge e vai para `harness:needs-human` — código de produto
nunca é conciliado por um agente.

Duas armadilhas que o passo precisa carregar por escrito:

- **`merge=union` no `.gitattributes` não resolve isso sozinho.** O GitHub não honra `.gitattributes`
  do usuário no merge server-side — nem driver custom, nem o `union`, que é built-in (o Kubernetes
  removeu o deles justamente por isso). Ele funciona no `git` **local**, que é exatamente onde o
  revisor roda — por isso a conciliação é do revisor, e não uma configuração do repositório.
- **O `--match-head-commit` fica velho.** O SHA registrado no STEP 1 não vale mais depois do push do
  próprio revisor, e o guard recusaria justamente o merge que ele acabou de destravar. Re-registrar
  o head SHA depois do push faz parte do passo.

## Credencial escopada por projeto

Nunca um `.bashrc` global com o token de todo cliente — foi assim que o motor antigo rodou como root
com 6 tokens Cloudflare de clientes diferentes em texto plano, herdados por todo `claude -p`.
O padrão agora é carregar sob demanda:

```bash
# ~/.bashrc do usuário `orca` — define a FUNÇÃO, não carrega nada.
cf() { set -a; . "$HOME/.config/$1/cloudflare.env"; set +a; }   # chmod 600 em cada arquivo
```

Um shell não-interativo (o que o cron e o agente herdam) fica **sem token nenhum** até alguém pedir
explicitamente por projeto.

## Denylist: a porta de produção

A denylist vendorada precisa bloquear produção. Com `Bash(npm run:*)` aprovado e um script
`"deploy": "wrangler deploy"` no `package.json`, existe caminho **aprovado** para produção sem passar
por PR. As entradas estão em `core/claude-code/settings.json` (`permissions.deny`) e
`core/shared/lib/dangerous-bash-denylist.mjs`, e cobrem `wrangler deploy`, `wrangler versions`,
`wrangler secret`, `wrangler r2` e `wrangler d1 execute --remote`, mais as formas `npm/pnpm/bun/yarn
run deploy` que dão a volta pelo script.

Isso é **defesa em profundidade por string-match, não sandbox** — um script com nome arbitrário
(`npm run ship`) continua chegando no `wrangler`. O fechamento real é a credencial escopada acima: o
agente simplesmente não tem token de produção no ambiente.
