# Usage — instalar/atualizar o harness e ligar a entrega autônoma

Guia prático. Para o desenho e as decisões, ver `design.md`, `cloud-routines.md`, `audit.md`.

> **ADE oficial: [Orca](https://onorca.dev)** — download em **https://onorca.dev**, releases em
> **https://github.com/stablyai/orca/releases**. É o ambiente oficial para rodar e observar entregas
> autônomas (desktop e celular). Instalação headless na VPS:
> [`orca-headless-vps-playbook.md`](orca-headless-vps-playbook.md).

## Os dois repositórios

- **Fonte (este repo):** `https://github.com/orobsonn/claude-harness` — o núcleo distribuível vive em `core/`.
- **Projeto vendorado:** cada projeto recebe uma cópia do `core/` no seu `.claude/` (committed), porque cloud routines só enxergam o `.claude/` do repo, nunca o `~/.claude`.

`core/` → `.claude/` é feito pelo instalador `vendor-core.mjs`.

---

## 1. Instalar o harness num projeto (primeira vez)

Bootstrap (você ainda não tem o script no projeto): clone a fonte uma vez e rode o instalador apontando para ela.

```bash
git clone --depth 1 https://github.com/orobsonn/claude-harness.git /tmp/claude-harness
node /tmp/claude-harness/core/skills/initializing-projects/references/vendor-core.mjs \
  --source https://github.com/orobsonn/claude-harness.git --target /caminho/do/projeto
```

`--source` aceita a **URL git** (clona sozinho) ou um **caminho local** com `core/`. O que ele faz (idempotente):

- **sobrescreve** (framework): `.claude/agents/`, `.claude/skills/`, `.claude/rules/`, `CLAUDE-HARNESS-MEMORY-MODEL.md`
- **semeia se ausente** (nunca clobbera): `.claude/memory/MEMORY.md`, `.claude/kaizen.md`
- **merge por marcador**: `.claude/CLAUDE.md` (preserva conteúdo do projeto fora dos marcadores)
- **non-clobber**: `.claude/settings.json` (se já existe, grava `settings.harness.json` pra você mesclar)
- **escreve**: `.claude/.gitignore`, `.claude/.harness-version`, `.github/ISSUE_TEMPLATE/harness-task.yml`

Depois:

```bash
# criar os labels do harness (idempotente)
gh label create "harness:ready"       -c 0E8A16 -d "Pronta para a pipeline autônoma" || true
gh label create "harness:in-progress" -c FBCA04 -d "Routine processando" || true
gh label create "harness:done"        -c 5319E7 -d "PR aberto pela routine" || true

# commitar o .claude/ na main (cloud routine clona a default branch)
git add .claude .github/ISSUE_TEMPLATE/harness-task.yml
git commit -m "chore: instala Claude Harness"
git push origin main
```

**Pré-requisitos pra a pipeline funcionar de verdade no projeto:**
- o `.claude/` precisa estar na **branch que a routine clona** (a default — normalmente `main`);
- o projeto precisa de **runner de teste** (vitest/jest) — senão o gate (`locked_tests`) fica vazio;
- **se o projeto usa release-please:** ligue **Settings → Actions → General → "Allow GitHub Actions
  to create and approve pull requests"** (na API de permissões do repo é
  `can_approve_pull_request_reviews: true`). **Sintoma quando falta:** a action roda, **cria o
  branch e a commit** de release, e **falha na abertura do PR** — com um erro que **não parece de
  permissão**: o branch `release-please--branches--main` já existe e a commit já está lá, então a
  falha lê como bug do release-please, e o operador vai procurar defeito na action em vez de na
  configuração do repo. Ligue **antes** do primeiro release: é um clique que custa uma run inteira
  quando falta.

> **O toggle não faz o CI aparecer** — são dois sintomas vizinhos, parecidos e de causas diferentes.
> (a) O primeiro PR `chore(main): release X.Y.Z` autorado pelo `github-actions[bot]` fica com o CI
> em `action_required` e **zero jobs** até alguém aprovar o workflow run; enquanto o rollup está
> vazio o `entry-gate` **corretamente** nega o merge
> (`[entry-gate] Blocked: No CI checks are reported; merge is denied.`). (b) Um PR aberto com o
> `GITHUB_TOKEN` padrão **não dispara** `on: pull_request` de jeito nenhum — proteção anti-recursão
> do GitHub, incondicional — e **o toggle acima não cura esse caso**. Diagnóstico e as saídas de
> cada um (aprovar o run; ou reabrir o PR por um humano) estão na skill
> [`releasing-versions` §3](../core/claude-code/skills/releasing-versions/SKILL.md) — ela é a
> referência; este checklist só garante o toggle ligado antes do primeiro release. Em nenhum dos
> dois casos a saída é contornar o gate.

---

## 2. Atualizar o harness num projeto já instalado

O `vendor-core.mjs` já está vendorado no projeto. Rode-o apontando para a URL:

```bash
node .claude/skills/initializing-projects/references/vendor-core.mjs \
  --source https://github.com/orobsonn/claude-harness.git --target .
```

Atualiza os arquivos do framework para a versão atual da fonte **sem destruir** a memória (`.claude/memory/`), o `kaizen.md`, o conteúdo do projeto no `CLAUDE.md` (fora dos marcadores) nem o `settings.json`. A versão fica em `.claude/.harness-version`.

---

## 3. Padrão de issues (harness-ready)

A pipeline transforma a issue em spec → plano → testes. Para issue **nova**, use o form **"Harness Task"** (`.github/ISSUE_TEMPLATE/harness-task.yml`) — ele captura resumo, user journeys, **critérios de aceite testáveis** (viram os `locked_tests`), escopo, decisões resolvidas, domínio sensível, prioridade e tamanho, e **auto-aplica o label `harness:ready`**.

- Só issues `harness:ready` entram no radar da routine.
- Não marque `harness:ready` em tarefas **sensíveis críticas** (auth/pagamento/segredos) ou **arquiteturais grandes** sem alinhar — autônomo nelas é risco alto, mesmo com PR draft.
- Issues antigas (sem o form) podem ser retrofitadas no formato + tag `harness:ready`.

---

## 4. Alternativa: routine na nuvem (claude.ai/code)

Uma alternativa à VPS (seção 6), com limites de volume bem menores. A routine roda na nuvem, autônoma. **Routine não dispara por issue** (triggers de GitHub só cobrem PR/Release) — o padrão é **agendada + poll** das issues `harness:ready`.

Passos em `claude.ai/code/routines` → **New routine**:
1. **Repositório:** selecione o projeto (precisa ter o harness na `main`). Uma routine pode ter vários repos — mas roda **uma sessão independente por repo**, com o **mesmo prompt** e clonando a default branch.
2. **Branch:** default (`main`) — onde o harness está.
3. **Setup script:** `npm install` (pra o vitest existir no gate).
4. **Trigger:** Schedule (ex.: diário).
5. **Prompt (poll de issues):**

```
Rode em MODO AUTÔNOMO (headless).

Seleção:
1. gh issue list --state open --label "harness:ready" --json number,title,body,createdAt
2. Descarte as com label "harness:done" ou que já têm PR aberto (gh pr list).
3. Leia prioridade/tamanho do corpo (campos do form). Ordene: P0>P1>P2, empate→menor tamanho (S<M<L), empate→mais antiga.
4. Pegue a PRIMEIRA. Marque "harness:in-progress" e remova "harness:ready".

Execução:
5. Siga a entry-policy (.claude/CLAUDE.md): triaging → orchestrating-delivery headless.
   Os campos do form (UJs/ACs/escopo/decisões/sensível) SÃO a spec.
6. Abra PR DRAFT (Closes #N) + commite .claude/memory/ e .claude/kaizen.md.
7. Troque "harness:in-progress" por "harness:done".

NUNCA AskUserQuestion/plan-mode. Se não der pra escopar com segurança, comente, devolva "harness:ready" e pule. 1 issue por run.
```

6. **Run now** para testar; depois deixe no schedule.

### Caps
Research preview tem limites de runs (por routine/conta). Não conte com volume alto.

---

## 5. Validar um run

Não há link automático PR→sessão nem notificação de falha. Valide assim:

- **Transcript** em `claude.ai/code/routines` (clica no run) — persiste; mostra triaging→orchestrating→gates→PR. "Verde" = rodou sem erro de infra, **não** = tarefa OK; abra e leia.
- **No git** (independe da UI): o PR é **draft**? Tem `.claude/memory/` commitado (harvester rodou)? Os `__tests__` foram autorados (TDD)? O corpo do PR traz spec/plano/demo/riscos?
- Pipeline real (vs implementação direta) = PR com **memória + kaizen + testes + review**, não só o código.

---

## 6. Entrega autônoma na VPS — Orca despacha, o harness do repo executa

O modo headless de verdade deste operador não é a cloud routine: é uma VPS com o
**[Orca](https://onorca.dev)** rodando headless (`orca serve` sob systemd, pareado por Tailscale).

```
cron do usuário `orca`  ──▶  core/orca/select-and-dispatch.mjs  ──▶  orca worktree create
   (1 linha por projeto)          (escolhe a issue + trava)                │
                                                                          ▼
                                                     agente (claude) num worktree do Orca
                                                                          │
                                                                          ▼
                                                     lê o .claude/ VENDORADO do repo
```

**São duas camadas, não dois motores.** O agente lançado num worktree do Orca lê o `.claude/` do
próprio repositório, então a pipeline de entrega já está lá — o selector não precisa de despachante
próprio. Ligar tudo:

```bash
npx @orobsonn/claude-harness setup-orca   # na VPS, como o usuário do Orca — nunca root
                                          # (alias: setup-vps — mesmo wizard, nome antigo)
```

O wizard escreve `~/.config/claude-harness/projects/<slug>.json` e uma linha de cron cercada. Formato
dos campos, teto de concorrência e as armadilhas evitadas: [`core/orca/README.md`](../core/orca/README.md).

**Ligar tudo de ponta a ponta, incluindo a revisão:** a skill
[`connecting-orca`](../core/claude-code/skills/connecting-orca/SKILL.md) faz o caminho completo —
diagnóstico, pareamento, repo, fila de implementação, automação de review e uma issue canária
entregue. **E se uma sessão de agente concluir que "não tem acesso à VPS", quase sempre não é isso:**
são três barreiras cujas mensagens enganam. Diagnóstico determinístico:

```bash
# num projeto com o harness vendorado (sempre disponível)
node .claude/skills/connecting-orca/references/orca-doctor.mjs --ssh-host <alias> --environment <nome>

# em qualquer máquina, sem vendorar nada — precisa da release que traz o comando;
# numa versão anterior o npx responde usage + exit 1
npx @orobsonn/claude-harness orca-doctor --ssh-host <alias>
```

Barreiras, causas e correções: [playbook §8](orca-headless-vps-playbook.md#8-operando-a-vps-a-partir-de-uma-sessão-de-agente).

**Comece em modo canário.** O campo `titleIncludes` (ex.: `"[canary]"`) restringe as candidatas por
título. Sem ele, a issue escolhida é simplesmente a `harness:ready` aberta **mais antiga** — num
backlog real isso costuma ser uma tarefa de anos atrás, não a que você quer observar primeiro.

**Dependências entre issues** continuam declaradas no bloco ```` ```harness-deps ```` do corpo da
issue. Uma dependência conta como satisfeita quando a **issue da dependência está CLOSED** — o estado
que significa "entregue", independente de como foi entregue. Estado ilegível é fail-closed.

## 7. Revisão de PR + merge condicional (automação do Orca)

**Não é código deste repo** — é uma automação **agendada no Orca**. Ela só merja quando: o veredito
próprio da revisão é *merjar*, **nenhum** achado ARMADO de severidade alta, CI concluído em
`SUCCESS`, e sem conflito — com `--match-head-commit` obrigatório.

O hook `entry-gate.mjs` do harness continua valendo e é o que torna esse gate inescapável: ele lê o
rollup de checks do PR antes de permitir `gh pr merge` e **recusa alvo ambíguo**. Consequência
prática: o comando de merge da automação **não pode** passar `-R`/`--repo` (nem `--auto`), **nem
carregar pipe (`|`) ou redirecionamento (`>`) depois do `gh pr merge`, no mesmo comando** —
qualquer um deles responde `[entry-gate] Blocked: PR target is ambiguous; merge is denied.`. Rode
dentro do checkout do repo alvo, passando só o número do PR; se precisar da saída, rode o merge
sozinho e leia depois. Isso é **feature, não obstáculo** — e **deve continuar assim**. Mecanismo e
as saídas medidas:
[`core/orca/README.md` § Revisão de PR + merge condicional](../core/orca/README.md#revisão-de-pr--merge-condicional).

> **O motor de cron da VPS foi aposentado.** As antigas seções sobre `cron-review`,
> `HARNESS_REVIEW_ENABLED`, `autoMergeEnabled` e o auto-update blue/green do motor descreviam
> `core/vps/`, que não é mais o caminho — ver [`docs/vps-retirement.md`](vps-retirement.md)
> para os motivos medidos e para o procedimento de verificação antes de remover o diretório. Não há
> mais "motor" separado para auto-atualizar: o pipeline é o `.claude/` vendorado no repo, atualizado
> por PR como qualquer outro código.

---

## Modelo do orquestrador

Setar **Sonnet** como modelo da sessão (`/model` no Claude Code, ou o modelo padrão da routine). O orquestrador é o maior consumidor de tokens do harness — é onde está a economia real. Os modelos superiores (Opus, Fable) são chamados **só nos pontos certos**, automaticamente, pelos sub-agentes: `planner` (Opus), `plan-reviewer` e `adversary` do gate final (Fable), `security`/`adversary` por-task (Opus). A tabela autoritativa está em `core/skills/orchestrating-delivery/SKILL.md`.

Isso só é seguro porque as decisões críticas do orquestrador estão em **trilhos determinísticos** (hook de entrada + guard `<PLANNER-ONLY>` forçam o dispatch do `planner`; override de path sensível é check de glob; routing de modelo é tabela fixa) — o modelo barato coordena, não julga arquitetura.

## Modos

- **Local (interativo):** operador no loop; gates humanos reais (aprovar spec/plano, demo).
- **Headless (cloud routine):** sem humano; gates viram validação multi-agente; entrega = **PR draft, nunca merge**; o gate humano real é a **revisão do PR**. Ativado por ser cloud (`$CLAUDE_CODE_REMOTE`) ou pelo prompt "rode autônomo".

## Add-ons opcionais
`modules/rtk/` (economia de token, hook fail-open) e `modules/mv/` (Mind Vault, por-usuário) — opt-in, nunca dependência do core.

## Medidor de custo (ccusage)
O harvester reporta o custo da entrega (equivalente-API, por modelo) + tendência semanal de consumo, via a skill `measuring-cost`. Ela depende do **ccusage** — https://ccusage.com. Não precisa instalar: o script roda `npx -y ccusage@latest` (baixa sob demanda). Para runs repetidos mais rápidos, opcionalmente `npm i -g ccusage`. Sem rede (cloud headless), o medidor degrada para "indisponível". O número semanal é consumo real relativo (todos os projetos), **não % da subscription**.
