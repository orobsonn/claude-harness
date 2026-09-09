# Uso — Pi no dia a dia, Codex na validação final

Guia prático do fluxo atual. Para as decisões e fronteiras técnicas, veja
[`design.md`](design.md). Os detalhes de cada shell ficam nos respectivos guias
de operador.

> **ADE oficial: [Orca](https://onorca.dev)** — download em **https://onorca.dev**, releases em
> **https://github.com/stablyai/orca/releases**. É o ambiente oficial para rodar e observar entregas
> autônomas (desktop e celular). Instalação headless na VPS:
> [`orca-headless-vps-playbook.md`](orca-headless-vps-playbook.md).

## Como o harness é usado hoje

- **Pi é o ambiente principal de criação e entrega:** ideia, spec, plano, tarefas,
  TDD, implementação, integração, revisão e shipping.
- **Codex é a validação local final:** revisão do conjunto integrado, reprodução
  de defeitos, debugging e validação no browser quando essa superfície estiver
  disponível no ambiente local.
- **Claude Code e OpenCode continuam suportados:** são shells completos do mesmo
  contrato, mas não representam o fluxo diário principal deste guia.

Não existe troca automática Pi → Codex. O handoff é o estado real do projeto:
branch, HEAD, diff, spec, plano, testes e recibos. Uma alegação textual de outro
agente nunca substitui esses artefatos.

## Antes de instalar: fonte não é projeto consumidor

Este repositório é a **fonte** do harness; a implementação vive em `core/`. Não
rode `init` contra a própria raiz. O [PR #927](https://github.com/orobsonn/claude-harness/pull/927)
adicionou uma trava explícita contra auto-vendor.

O vendor é usado somente dentro de um **projeto consumidor**. Sem `--target`, a
instalação atual leva Pi, Codex, Claude Code e OpenCode na mesma release. Um alvo
explícito limita a operação deliberadamente a um runtime.

## Fluxo diário: construir no Pi, validar no Codex

1. No Pi, explore a ideia e feche as decisões de produto.
2. Deixe o harness produzir e revisar spec, plano e testes.
3. Despache as tasks; independentes podem executar em paralelo, dependentes
   aguardam a integração dos recibos.
4. Integre somente o SHA esperado e rode a validação agregada.
5. Abra o mesmo projeto no Codex e peça uma revisão read-only do HEAD final.
6. Use as ferramentas locais do Codex para reproduzir o fluxo real, inclusive no
   browser quando disponível.
7. Achado material volta para correção e nova validação antes de PR, merge ou release.

Prompt-base para a etapa Codex:

```text
Valide o HEAD atual contra a spec e os critérios de aceite. Revise diff e testes,
execute as verificações afetadas e reproduza o fluxo principal no browser quando
essa superfície estiver disponível. Procure falhas de integração, estado, console,
rede, segurança e experiência. Não altere nada: entregue achados reproduzíveis,
severidade e evidência.
```

Browser/computer use é uma capacidade do ambiente Codex, não uma garantia do
vendor nem uma integração automática com o Pi.

## Fonte e projetos consumidores

- **Fonte (este repo):** `https://github.com/orobsonn/claude-harness` — os runtimes distribuíveis vivem em `core/`.
- **Projeto consumidor:** recebe os runtimes selecionados e seus manifestos de ownership. Configuração e memória pertencentes ao projeto são preservadas.

O instalador `vendor-core.mjs` faz a cópia versionada. O diretório de destino depende do runtime: Pi, Codex, Claude Code ou OpenCode.

---

## 1. Instalar o harness num projeto consumidor

O canal de distribuição é a tag do GitHub. Rode dentro do produto, nunca dentro deste repositório-fonte:

```bash
cd /caminho/do/projeto
npx -y "github:orobsonn/claude-harness#v2.6.8" init
```

Sem `--target`, o padrão atual instala os quatro runtimes. Para limitar deliberadamente:

```bash
npx -y "github:orobsonn/claude-harness#v2.6.8" init --target pi
npx -y "github:orobsonn/claude-harness#v2.6.8" init --target codex
```

O que o vendor faz de forma idempotente:

- substitui somente arquivos registrados como pertencentes ao framework;
- preserva configuração explícita, memória e conteúdo do projeto;
- recusa um diretório estrangeiro sem manifesto de ownership;
- grava o marcador de versão de cada runtime instalado;
- instala o template de issue do harness quando ausente.

Depois:

```bash
# criar os labels do harness (idempotente)
gh label create "harness:ready"       -c 0E8A16 -d "Pronta para a pipeline autônoma" || true
gh label create "harness:in-progress" -c FBCA04 -d "Routine processando" || true
gh label create "harness:done"        -c 5319E7 -d "PR aberto pela routine" || true

# revise e commite somente os runtimes que o projeto adotou
git status --short
git commit -m "chore: instala delivery harness"
git push origin main
```

**Pré-requisitos para a pipeline funcionar de verdade no projeto:**
- o runtime precisa estar na branch/worktree realmente executada;
- o projeto precisa de runner de teste — sem teste observável não existe prova de entrega;
- o Pi usa a autenticação do usuário do host em `~/.pi/agent/auth.json`;
- o Codex usa o sandbox e a política de aprovação da sessão como fronteira de segurança;
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

## 2. Atualizar um projeto consumidor

Use a skill de lifecycle do runtime ou a release fixada:

```bash
npx --yes --package=github:orobsonn/claude-harness#v2.6.8 claude-harness init
```

O update preserva escolhas explícitas do operador, memória e arquivos fora do ownership do framework. Reinicie a sessão para carregar novas definições de agentes, hooks, plugins e skills. Nunca rode essa atualização na raiz do repositório-fonte.

---

## 3. Padrão de issues (harness-ready)

A pipeline transforma a issue em spec → plano → testes. Para issue **nova**, use o form **"Harness Task"** (`.github/ISSUE_TEMPLATE/harness-task.yml`) — ele captura resumo, user journeys, **critérios de aceite testáveis** (viram os `locked_tests`), escopo, decisões resolvidas, domínio sensível, prioridade e tamanho, e **auto-aplica o label `harness:ready`**.

- Só issues `harness:ready` entram no radar da routine.
- Não marque `harness:ready` em tarefas **sensíveis críticas** (auth/pagamento/segredos) ou **arquiteturais grandes** sem alinhar — autônomo nelas é risco alto, mesmo com PR draft.
- Issues antigas (sem o form) podem ser retrofitadas no formato + tag `harness:ready`.

---

## 4. Alternativa Claude Code: routine na nuvem

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
                                                     runtime configurado num worktree do Orca
                                                                          │
                                                                          ▼
                                                     lê o harness VENDORADO do repo
```

**São duas camadas, não dois motores.** O agente lançado num worktree do Orca lê o runtime do
próprio repositório, então a pipeline de entrega já está lá — o selector não precisa de despachante
próprio. No fluxo atual, o terminal pode lançar o Pi Harness; Claude Code continua suportado. Ligar tudo:

```bash
npx -y "github:orobsonn/claude-harness#v2.6.8" setup-orca
                                          # na VPS, como o usuário do Orca — nunca root
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
npx -y "github:orobsonn/claude-harness#v2.6.8" orca-doctor --ssh-host <alias>
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

## Modelos

Não existe mais uma tabela única Claude para todo o projeto. Cada runtime tem sua rota autoritativa:

- Pi: `core/pi/README.md` e o rail de dispatch do runtime;
- Codex: `core/codex/harness.routing.json`;
- OpenCode: `core/opencode/harness.routing.json`;
- Claude Code: contrato do `orchestrating-delivery` daquele shell.

O princípio comum continua: modelos menores absorvem volume mecânico; modelos fortes ficam em planejamento, revisão, segurança e fronteiras de decisão. O rail valida a rota concreta antes do dispatch onde o runtime oferece essa superfície.

## Modos

- **Pi local/TUI:** fluxo diário principal, com operador acompanhando decisões e execução.
- **Pi headless:** mesma cerimônia e mesmos gates, executada pelo launcher em modo JSON/prompt.
- **Codex local:** validação final e debugging sobre o HEAD integrado; também pode executar delivery quando escolhido.
- **Claude Code/OpenCode:** modos próprios documentados nos respectivos guias.

## Add-ons opcionais
`modules/rtk/` (economia de token, hook fail-open) e `modules/mv/` (Mind Vault, por-usuário) — opt-in, nunca dependência do core.

## Medidor de custo (ccusage)
O harvester reporta o custo da entrega (equivalente-API, por modelo) + tendência semanal de consumo, via a skill `measuring-cost`. Ela depende do **ccusage** — https://ccusage.com. Não precisa instalar: o script roda `npx -y ccusage@latest` (baixa sob demanda). Para runs repetidos mais rápidos, opcionalmente `npm i -g ccusage`. Sem rede (cloud headless), o medidor degrada para "indisponível". O número semanal é consumo real relativo (todos os projetos), **não % da subscription**.
