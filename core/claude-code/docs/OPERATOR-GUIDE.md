# Guia do operador — Harness Claude Code

Documento **humano** (pt-br, linguagem de produto).
Nomes de skills, agents, hooks e arquivos ficam em inglês (como no disco).

**Onde vive**

| No monorepo (fonte) | No projeto (vendored) |
|---|---|
| `core/claude-code/docs/OPERATOR-GUIDE.md` | `.claude/docs/OPERATOR-GUIDE.md` |

Atualiza com o harness (`updating-harness`). Depois de update: **reinicie a sessão** do Claude Code.

**Não é** o README do repo (visão geral do framework, mistura Claude Code + OpenCode + VPS). **Este** guia cobre **só o shell Claude Code**, do ponto de vista de quem opera.

---

## 1. Em uma frase

O harness Claude Code é um **sistema de entrega** dentro de uma sessão do Claude Code:

- Você pede em linguagem de produto.
- A sessão **tria** (`triaging-requests`) e, se for entrega, **orquestra** (`orchestrating-delivery`).
- **Mãos** baratas implementam; **olhos** fortes revisam.
- **Hooks** (portões) **negam** chamadas de ferramenta quando falta cerimônia ou prova.
- O resultado esperado é **PR** — em headless, **draft, nunca merge automático**.

**Não existe agent `plan` nem Tab.** O Claude Code é **uma sessão só**: na primeira interação roda `triaging-requests` antes de qualquer coisa, e ele decide a rota. Onde o guia do OpenCode diz "peça no `plan`", aqui você **invoca a skill dentro da mesma sessão** (ex.: `/grill`).

---

## 2. Antes da entrega — a fase de pré-implementação

Conceitualmente a entrega é o **fim** da cadeia. A cadeia inteira é:

```
ideia  →  grill  →  PRD (docs/prd/<slug>.md)  →  creating-issues  →  motor (triage → entrega → PR)
```

### 2.1 `grill` — a ideia vira PRD

Você chega com uma ideia que só existe na sua cabeça. `grill` te **entrevista** — uma pergunta por vez, sempre enquadrada em consequência de produto ("se ele fechar a aba no meio, prefere perder o lead ou salvar o parcial?") — até virar um **PRD escrito** em `docs/prd/<slug>.md`.

| Seção do PRD | Pra que serve |
|---|---|
| `## Requisitos` | numerados e **verificáveis** — viram os critérios de aceite das issues |
| `## Decisões travadas` | o que **você** decidiu, com o porquê |
| `## Suposições do modelo` | o que o **modelo** deduziu sozinho — fica separado de propósito, pra ser **atacável** |
| `## Em aberto` | o que não fechou — é daqui que uma próxima sessão retoma |
| `## Fora de escopo` · `## Riscos conhecidos` | limite e riscos carregados adiante |

Regras que importam pra você:

- **Você invoca** (`/grill`); nunca entra sozinho. Não é o portão de entrada da sessão — quem manda na primeira ação é `triaging-requests`.
- **Só local/interativo.** Numa sessão automática ele **recusa** — entrevista sem alguém do outro lado não existe.
- **O PRD não é decisão travada.** Ele entra na pipeline depois como **texto de issue comum**, atacável pelo `planner`, `plan-reviewer`, `adversary` e `compliance`. Isso é proposital: uma conversa não revisada não pode virar constraint inquestionável.
- **A sessão do grill para na criação da issue.** Construir é sessão nova, entrando pelo caminho normal.
- No Claude Code o grill roda no loop principal (**sem sandbox de permissão**) — o que segura o escopo é a regra de "para na issue" mais você olhando.

### 2.2 PRD → `creating-issues`

Cada requisito numerado do PRD vira um critério de aceite `#ac-N.M` da issue — e é desses critérios que saem os **testes travados** da pipeline. Por isso um requisito vago ("funciona bem", "é rápido") faz o motor inteiro mirar no alvo errado.

Duas travas úteis:

- **`## Em aberto` bloqueia a fatia dependente.** A issue que depende de uma pergunta em aberto **não é criada** nessa leva — fica parada no PRD, e você é avisado do que ficou de fora.
- **PRD não autoriza issue maior.** Um PRD que rende N fatias vira N issues pequenas; "é tudo o mesmo tema" é coesão de tema, não de entrega.

### 2.3 `CONTEXT.md` — o vocabulário compartilhado

Na **raiz do projeto** (não dentro de `.claude/`), uma tabela `| termo | significado |`: o que cada termo do seu negócio **significa**, nunca qual arquivo implementa.

| Quem | Faz o quê |
|---|---|
| `surveying-codebase` | **semeia** (uma vez, em projeto que já existe) |
| `harvester` | **mantém — só adiciona**; nunca redefine, renomeia ou remove |
| `planner`, `executor`, `grill`, `proposing-deepening`, `creating-issues` | **leem literalmente** e usam os mesmos termos |

Por que "só adiciona": uma definição reescrita sozinha às 3 da manhã por uma run autônoma envenena todo agente que a lê depois. Se o `harvester` acha que um termo está errado, ele **propõe** em `.claude/kaizen.md` e deixa o arquivo intacto — mudar significado é decisão sua.

`CONTEXT.md` é **commitado** (viaja no PR junto com `.claude/memory/`) — nunca segredo nem dado pessoal ali.

### 2.4 `proposing-deepening` — reforma de código que já existe

Projeto legado que ficou difícil de mexer. A skill **varre e propõe**, no máximo **5 candidatos** ranqueados, em `docs/architecture/deepening-candidates.md`. Ela **não refatora nada** e **não abre issue**.

Cada candidato te dá **dois campos que você consegue julgar**, antes de qualquer detalhe técnico:

1. **o que fica mais fácil e pra quem**
2. **o que custa e o que quebra** — incluindo o custo honesto de **não fazer nada** (se a resposta honesta é "conviver com isso tá ok", ela diz isso)

Travas:

- **Só local/interativo** — recusa em sessão automática.
- Sem **oráculo independente** (teste de consumidor existente, fixture gravada do sistema rodando, contrato externo) o candidato vai pra `## Bloqueados` e **não é proposto**. Teste escrito lendo o código que se vai reescrever não vale — ele fica verde por construção e canoniza o bug atual.
- Sem **sequência de fatias** (interface nova ao lado da antiga → migra chamadores em lotes ≤ ~400 linhas → apaga a antiga) também não é proposto.
- Todo candidato carrega **rota FULL-equivalente** — o risco aqui é raio de explosão, não domínio sensível.
- **A issue derivada nasce sem `harness:ready`** → é inerte pro motor autônomo. Reforma às cegas de código que funciona **nunca** merja sozinha; ela é entregue localmente, com você olhando.
- No Claude Code roda no loop principal (**sem sandbox**) — a proteção real é a regra local-only acima.

### 2.5 As regras que moldam o código

`rules/architecture.md` (profundidade de módulo) e `rules/code-quality.md` (superfície de teste) mudaram o padrão do que o motor escreve:

- **Módulo profundo, não raso** — muito comportamento escondido atrás de uma interface pequena. Dezenas de arquivinhos que só repassam a chamada é exatamente a forma que um agente de IA produz por default e a mais cara de navegar depois.
- **Teste na porta, não na mobília** — o teste se prende à interface **pública** do módulo, nunca a função interna. No nosso pipeline o teste é **congelado** (imutável pro executor): teste mal ancorado não gera fricção, emperra a entrega inteira.

Efeito prático pra você: dá pra **revisar a porta e delegar o miolo**.

---

## 3. Checklist do início de sessão

1. Projeto tem harness? → `.claude/.harness-version` existe.
   - Não tem → skill **`updating-harness`** (ela detecta install vs update).
   - Atrás da última release → `updating-harness` e **reinicie a sessão**.
2. O **primeiro** pedido da sessão roda **`triaging-requests`** sozinho — não force "implementa já" sem triagem.
3. Ideia ainda sem forma? → `/grill` **antes** de pedir entrega.
4. Projeto legado sem memória? → `surveying-codebase` (semeia `.claude/memory/` + `CONTEXT.md`).
5. Uma intenção por sessão: uma feature classificada **trava a sessão naquela feature**.
6. Depois de atualizar o harness → **reiniciar a sessão**.
7. Git: branch (nunca commit em `main`); stage seletivo.

---

## 4. Como o trabalho é classificado

| Modo | Quando (produto) | O que roda |
|---|---|---|
| **Sem cerimônia** | Pergunta, leitura, chat, revisão de documento | Resposta direta |
| **QUICK · fix** | Hotfix óbvio, 1–2 arquivos, **nada sensível** | Inline + trilhos baratos + `committing-changes` |
| **QUICK · craft** | Artefato visual novo e autocontido (página, quiz, landing) | Skill artesã (`quiz` / `copy` / `blog-post`) ou build inline + trilhos baratos |
| **LIGHT** | Feature pequena, escopo claro | `orchestrating-delivery` em LIGHT |
| **FULL** | Multi-arquivo, severidade alta, ou domínio sensível | `orchestrating-delivery` em FULL |

**Só sobe de modo, nunca rebaixa.** "rápido" é tom, não autorização pra pular segurança. "caprichada", "com cuidado" sempre sobem.

**Paths que forçam FULL** (allowlist no `CLAUDE.md` vendored): `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (ao mexer em deps).

Julgamento na entrada (triagem). **Determinismo no plano**: quando o `planner` define os `scope_paths`, um check de glob força FULL se bater na lista.

**QUICK-craft tem dois trilhos determinísticos antes do commit** (não tem planner ali): (1) os gates baratos do projeto — `tsc --noEmit`, lint, build; (2) o glob de path sensível sobre os arquivos tocados — **qualquer batida aborta a via rápida e sobe pra LIGHT**. Captura de lead no padrão que já vem embutido na skill artesã continua QUICK; endpoint novo/custom é integração nova → LIGHT (que roda o agente `security`).

---

## 5. Fluxo de entrega (LIGHT / FULL)

```
triaging-requests
    │
    ├─ sem código ──► responde
    ├─ QUICK ──► implementa / skill artesã + gates baratos + commit
    └─ LIGHT / FULL
            │
            ▼
      brainstorm  ── HARD-GATE: você aprova a spec ──►
      (superpowers:brainstorming se o plugin estiver instalado, senão inline)
            │
            ▼
      planner (Opus, plano JSON) ── plan-reviewer ── HARD-GATE: você aprova o plano
            │
            ▼
      por task: test-author (teste travado) → executor → compliance
               → adversary (se ativo) → security (se sensível)
               → sniper (se preciso) → gates / regate
            │
            ▼
      dual final (adversary + compliance + security) → demo → harvester → shipper (PR)
```

**Interativo:** você aprova spec, plano e demo. O laço entre esses portões é autônomo.
**Headless:** validação multi-agente no lugar das perguntas; **PR draft, nunca merge**.

> **`brainstorming` não é vendored no Claude Code.** A sessão usa `superpowers:brainstorming` **se o plugin do marketplace estiver instalado**; se não estiver, brainstorma inline com você. De qualquer forma o `planner` só é liberado depois do carimbo de brainstorm — o portão não depende do plugin.

---

## 6. Papéis (agents) — mapa mental

| Em português | Agent no disco | Tipo |
|---|---|---|
| Maestro da sessão | o loop principal (`orchestrating-delivery`) | coordenador |
| Arquiteto do plano | `planner` (sempre Opus) | olho |
| Revisor de plano | `plan-reviewer` | olho |
| Implementador | `executor` | **mão** |
| Autor do teste travado | `test-author` | mão (mas sempre Claude) |
| Fiscal de critérios | `compliance` | olho |
| Advogado do diabo | `adversary` | olho |
| Corretor cirúrgico | `sniper` | mão |
| Segurança | `security` | olho |
| Colheita de aprendizado | `harvester` | mão (docs/memória) |
| Git / PR | `shipper` | mão (bash) |

**Mãos** escrevem código/teste; **olhos** leem e julgam. Nenhum olho roda fora do Claude — isso é constraint dura.

**Modelos:** a tabela de roteamento é fixa e mora no `orchestrating-delivery` (não há skill de routing no Claude Code — isso é do OpenCode). Em linhas gerais: orquestrador **sonnet** (é quem consome mais token — é aí que está a economia), `planner` / `plan-reviewer` / `security` / adversary de fronteira **opus**, `compliance` / `test-author` / `harvester` / `shipper` **sonnet**, adversary por task **flexiona** (opus quando a task é grave ou toca path sensível, senão sonnet). Você pode sobrepor o modelo da sessão com `/model`.

**Mãos baratas (Ollama):** `executor` e `sniper` rodam num modelo Ollama fora da subscription, via `spawn-hand` — **capacidade local**. Numa routine de nuvem (`$CLAUDE_CODE_REMOTE` setado) não há mão Ollama: `executor` e `sniper` são despachados como Agents Claude normais. O `test-author` **sempre** é Agent Claude, nos dois modos.

---

## 7. Skills — o que existe e quando chamar

O harness **não** carrega todas as skills o tempo todo — elas entram sob demanda. Se você **não pedir**, algumas nunca aparecem.

### Pré-implementação (antes de qualquer entrega)

| Skill | Quando | O que faz |
|---|---|---|
| **`grill`** | Ideia grande ainda sem forma, sem spec escrita | Te entrevista até virar PRD em `docs/prd/<slug>.md`, depois chama `creating-issues`. Local-only |
| **`proposing-deepening`** | Projeto que já existe e ficou difícil de mexer | Varre e traz ≤5 candidatos a reforma em `docs/architecture/deepening-candidates.md`. Não mexe em nada. Local-only |
| **`creating-issues`** | Transformar PRD, candidato ou conversa em trabalho | Issue(s) no formato do pipeline, com dependências e lint do DAG |
| **`surveying-codebase`** | Projeto legado entrando no harness com memória vazia | Semeia `.claude/memory/` + `CONTEXT.md` |

### Entrada e entrega (roda o tempo todo)

| Skill | Quando | O que faz |
|---|---|---|
| **`triaging-requests`** | Automática, 1ª interação da sessão | Classifica sem cerimônia / QUICK / LIGHT / FULL |
| **`orchestrating-delivery`** | LIGHT/FULL após a spec | Conduz o laço inteiro (spec → plano → tasks → dual final → demo → harvest) |
| **`creating-plans`** | **Interno ao `planner`** | Como o plano JSON é decomposto — você nunca chama direto |
| **`committing-changes`** | Commit avulso fora do ship completo | Commit semântico seletivo |

### Configuração e manutenção (peça explicitamente)

| Skill | Quando pedir | O que faz |
|---|---|---|
| **`updating-harness`** | "Atualiza o harness", "instala o harness aqui" | Vendora `.claude/` da última release |
| **`initializing-projects`** | Primeira adoção num projeto | Onboarding completo (labels, settings, issue form) |
| **`releasing-versions`** | Release versionada do **seu** produto | PR de release → tag → GitHub Release |
| **`authoring-rules`** | Nova lei de pasta/área | Cria/edita rule em `.claude/rules/` |

### Memória e melhoria (geralmente no harvest)

| Skill | Quando | O que faz |
|---|---|---|
| **`recording-findings`** | Harvest | Consolida achados em `findings.md` (efêmero) |
| **`distilling-learnings`** | Harvest | Roteia o durável por raio de explosão: `.claude/memory/`, `CLAUDE.md` de pasta, ou kaizen |
| **`proposing-improvements`** | Harvest | Só **propõe** em `.claude/kaizen.md` — nunca aplica sozinho |
| **`measuring-cost`** | Fim da entrega | Custo equivalente da sessão + tendência semanal |
| **`canonical-critical-classes`** | Interno (adversary/compliance) | Taxonomia de falhas — munição, não ação |
| **`reviewing-pull-requests`** | Só máquina (cron de review) | Olhos frescos sobre o diff do PR |

### Como "acordar" uma skill

Diga o objetivo em linguagem de produto — a triagem carrega a skill certa se o pedido for claro:

- "Tenho uma ideia grande e nada escrito — **me entrevista** sobre ela." → `grill`
- "Esse código tá difícil de mexer, **onde vale reformar**?" → `proposing-deepening`
- "**Atualiza o harness** neste repo." → `updating-harness`
- "**Abre uma issue** harness-ready pra X." → `creating-issues`

---

## 8. Atualizar o harness no projeto

**Skill:** `updating-harness`. Pedido **explícito** e em sessão interativa — não misture com feature.

```bash
# última release
gh release view --repo orobsonn/claude-harness --json tagName -q .tagName

npx --yes --package=github:orobsonn/claude-harness#<tag> claude-harness init --target claude
```

- Detecta install vs update pela presença do instalador vendored / `.claude/.harness-version`.
- **Não** use `@latest` do npm (ele atrasa e pode vendorar shell errado/stale).
- Idempotente: `agents/`, `skills/`, `rules/`, `hooks/` são sobrescritos; **`.claude/memory/`, `.claude/kaizen.md`, `settings.json` e o seu conteúdo no `CLAUDE.md` nunca são clobbados**.
- Ao final roda um **portão de integridade**: se algum hook vendored importar um módulo que não foi espelhado, ele sai com FATAL em vez de entregar um hook que quebra no load. Se isso acontecer, **pare e reporte** — não commite um shell quebrado.
- **Commite `.claude/`** (cron/cloud só enxerga o repo). O commit é seu — a skill não commita sozinha.
- **Reinicie a sessão.**

---

## 9. Paths de runtime (o que é efêmero)

| Conceito | Path |
|---|---|
| Plano da feature | `.claude/plans/<feature_id>/` |
| Plano JSON | `.claude/plans/<feature_id>/execution-plan.json` |
| Spec | `.claude/plans/<feature_id>/spec.md` |
| Contexto curado da run | `.claude/plans/<feature_id>/shared_context.md` |
| Estado dos portões | `.claude/plans/.state/<session_id>/gate-state.json` |
| Registro da triagem | `.claude/plans/.state/<session_id>/triage.json` |
| Prova da mão (run-record) | `.claude/plans/.state/hand-records/<feature_id>/<role>/<task_id>.json` |
| Achados da run | `findings.md` na raiz (some no harvest) |
| Memória durável | `.claude/memory/` (índice em `MEMORY.md`) |
| **Glossário do domínio** | **`CONTEXT.md` na raiz do projeto** (commitado) |
| Melhorias do harness (outbox) | `.claude/kaizen.md` |
| PRD do `grill` | `docs/prd/<slug>.md` |
| Candidatos a reforma | `docs/architecture/deepening-candidates.md` |
| Versão vendored | `.claude/.harness-version` |
| Onde os hooks se registram | `.claude/settings.json` |

`plans/`, hand-records e `findings.md` são **efêmeros** (apagados no harvest; dirs de sessão velhos passam por GC). Auditoria que fica = **git**.

`.claude/memory/`, `.claude/kaizen.md` e `CONTEXT.md` são **commitados** — e por isso **nunca** recebem segredo, credencial ou dado pessoal.

---

## 10. Portões (hooks) — o que o operador sente

No Claude Code os trilhos são **hooks**: scripts em `.claude/hooks/`, registrados em `.claude/settings.json`, que rodam antes/depois de uma chamada de ferramenta e podem **NEGAR** a chamada. Você não configura hook a hook no dia a dia — eles barram atalho.

| Hook | Onde engata | O que trava |
|---|---|---|
| `entry-gate.mjs` | antes de `Agent` e `Bash` | dispatch de agente de entrega e comandos de entrega (push / PR) sem cerimônia ou sem prova |
| `plan-write-gate.mjs` | antes de `Write`/`Edit` | o loop principal escrever o `execution-plan.json` — só o `planner` despachado pode |
| `stamp-triage.mjs` | depois de `Bash` | carimba triagem e marcadores no estado (é o que faz `classify.mjs`/`mark.mjs` valerem) |
| `codex-eye-nudge.mjs` | depois de `Agent` | dispara a **segunda família** depois que um olho Claude retorna |
| `agent-idle-nudge.mjs` | depois de `Agent` | agente que ficou mudo sem entregar o relatório final |
| `obs-eye-append.mjs` · `obs-plan-write.mjs` | depois de `Agent` / `Write` | observabilidade (checkpoints da run) |
| `reinject-state.mjs` | início de sessão / após compactação | reinjeta modo, feature e plano pra sessão retomar sem perder o fio |
| `version-check.mjs` | início de sessão | avisa quando o harness vendored está atrás da release |

**Sintomas que você vai ver:**

| Sintoma | Causa comum | O que fazer |
|---|---|---|
| "Planner negado" | Falta o carimbo de brainstorm **ou** o adversário ainda não atacou a spec | Completar a spec e o ataque; não pular pro plano |
| Qualquer agente de entrega negado | Ainda não houve triagem (`triage.json` com LIGHT/FULL) | Deixar a triagem rodar antes de despachar |
| Escrita do plano negada | O loop principal tentou escrever o plano inline | Só o `planner` (Opus) escreve o plano — despachar |
| Push / PR bloqueado: **captura** | Task com mão terminada sem captura independente verificada | A mão precisa terminar de verdade; prosa "pronto" não conta |
| Push / PR bloqueado: **regate** | Correção grave (`sniper` HIGH) sem re-auditoria | Rodar o olho forte de regate e carimbar `regate-passed` |
| "gate-state corrompido" | O arquivo de estado tem dado inválido | Reparar ou apagar o `gate-state.json` e re-carimbar o regate pendente |
| Comportamento "meio velho" | Update sem restart | Reiniciar a sessão do Claude Code |

**Leia um deny como mensagem de produto** ("falta prova da mão"), não como bug aleatório. É exatamente o valor do harness.

**Contrato dos hooks:** todos são **fail-open** — erro de infra sai 0 e não trava nada. A negação só acontece no ramo deliberado de decisão (a exceção é estado corrompido, que **fecha** de propósito — coagir silenciosamente um estado inválido reabriria a porta que o portão existe pra segurar).

**A obrigação de regate sobrevive à compactação.** Um `regate-pending` sem `regate-passed` correspondente é **bloqueio de entrega**; mesmo que a conversa seja compactada, o estado é relido do disco e continua valendo.

---

## 11. Segunda família de olhos (opcional)

Módulo **`codex-adversary`**: todo checkpoint que roda um olho de julgamento crítico (`adversary` na spec / por task / dual final, `plan-reviewer`, `security`) pode rodar em **duas famílias de modelo** — Claude e GPT via CLI `codex` — porque cada uma enxerga a falha que os vieses da outra não veem.

- **Chave global:** variável de ambiente `HARNESS_CODEX_ADVERSARY` (em `settings.local.json` → `env` pra opt-in por máquina, ou em `settings.json` → `env` pro repo inteiro). Vem **desligada** no baseline shippado.
- **Quem dispara:** o hook `codex-eye-nudge` (depois do `Agent`), automaticamente, quando um olho Claude elegível retorna — não depende do orquestrador lembrar.
- **Fail-open sempre:** módulo ausente, chave desligada ou `codex` inalcançável → o checkpoint roda **só Claude**, exatamente como sem o módulo. A segunda família nunca é dependência dura.
- A segunda família é sempre **read-only** e de nível Claude — um **olho**, nunca uma mão barata.
- No `security`, o veredito SECURE|UNSAFE continua **autoritativo do Claude**: achado que só o codex viu só escala o portão depois de passar pela refutação Claude.

Headless **não** desliga isso sozinho — um `codex` autenticado por assinatura roda em sessão headless sem chave de API.

---

## 12. Interativo vs headless

| | Interativo (você no laço) | Headless (routine automática) |
|---|---|---|
| Entrada | `triaging-requests` + seu veto | classifica sozinho, sem veto |
| Spec / brainstorm | você explora | subagentes de exploração com lentes distintas → spec sintetizada, depois atacada pelo `adversary` |
| Aprovar spec | hard-gate humano | validação multi-agente, segue |
| Aprovar plano | hard-gate humano | `plan-reviewer` aprova, segue |
| Demo | você testa a saída | gerada e validada automaticamente contra os critérios de aceite |
| Exceção crítica | pergunta pra você | registra como risco aberto no PR; não trava |
| Entrega | merge com o seu OK | **PR draft, nunca merge** |
| `grill` / `proposing-deepening` | disponíveis | **recusam** (precisam de alguém do outro lado) |

**Como o modo é detectado:** headless quando a sessão é routine de nuvem (`$CLAUDE_CODE_REMOTE` setado / `claude-code-on-the-web`) **ou** o prompt gatilho manda rodar autonomamente. As skills de pré-implementação usam um sinal mais amplo (`$CLAUDE_CODE_REMOTE`, `$HARNESS_NOTIFY_PROJECT`, `$HARNESS_OBSERVABILITY_RUN_PATH`) porque o dispatcher da VPS **desliga** `$CLAUDE_CODE_REMOTE` de propósito — a run fica "headless-local" pra manter as mãos baratas ligadas, e uma skill que olhasse só aquela variável começaria uma entrevista dentro de uma frota autônoma.

**Regras de ouro do headless:** nunca perguntar nem entrar em plan mode; portão humano vira validação multi-agente (nunca "aprova cego"); o portão humano real é a **revisão do PR**; conhecimento durável (`.claude/memory/`, `.claude/kaizen.md`, `CONTEXT.md`) é **commitado no PR** — se não for, evapora a cada run.

---

## 13. Comandos privilegiados (o que carimba estado)

No Claude Code não há tool custom — os carimbos são **CLIs em `.claude/hooks/`**, e o hook `stamp-triage` é quem transforma a saída deles em estado. Nunca escreva esses arquivos de estado à mão.

| Comando | Função |
|---|---|
| `node .claude/hooks/classify.mjs --mode <LIGHT\|FULL> --feature-id <id>` | Grava modo + feature na triagem (fim do triage) |
| `mark.mjs brainstorm-done --feature-id <id>` | Libera o `planner` (junto com o ataque do adversary) |
| `mark.mjs plan-reviewed --feature-id <id> --verdict APPROVE\|REVISE` | Veredito do revisor de plano |
| `mark.mjs hand-finished` / `capture-verified` (`--feature-id` + `--task-id`) | O trilho de prova da mão — o que destrava push/PR |
| `mark.mjs regate-pending` / `regate-passed` (`--feature-id` + `--task-id`) | Re-auditoria obrigatória depois de correção grave |
| `mark.mjs fidelity-pass --feature-id <id> --task-id <id>` | Teste travado conferido antes de congelar |
| `mark.mjs final-review-done --feature-id <id>` | Dual final concluído |
| `mark.mjs spec-adversaried --feature-id <id> --verdict SHIP\|BLOCK --findings <n>` | Checkpoint do ataque à spec (observabilidade) |

Todos moram em `.claude/hooks/` (`node .claude/hooks/mark.mjs …`). Cada marcador é validado antes de virar estado — carimbo forjado por `echo` não passa.

---

## 14. Boas práticas (operador)

1. **Ideia grande começa no `/grill`**, não em "implementa". Requisito vago vira teste travado vago vira entrega errada.
2. **Uma intenção por sessão** — feature é uma coisa, "só atualizar o harness" é outra. A sessão trava na feature classificada.
3. **Decisões de produto são suas**; engenharia se resolve dentro do sistema. Se te perguntarem sobre classe ou arquitetura, o enquadramento está errado.
4. **`## Suposições do modelo` existe pra ser atacada.** Leia essa seção do PRD com má vontade — é ali que uma dedução errada vira requisito.
5. **Reforma de arquitetura é entrega local, nunca automática.** Issue de `proposing-deepening` sem `harness:ready` é de propósito.
6. **Leia deny de portão como mensagem de produto**, não como bug — a menos que o smoke diga o contrário.
7. **Nunca** peça pra afrouxar captura, regate ou dual "só pra passar".
8. Depois de update do harness: **restart**.
9. Antes de entregar: confira `.claude/.harness-version` contra a última release.

---

## 15. Onde aprofundar (no projeto vendored)

| Arquivo | Conteúdo |
|---|---|
| `.claude/CLAUDE.md` | Entry policy: triagem, dois modos, paths sensíveis, memória, cross-family |
| `.claude/docs/OPERATOR-GUIDE.md` | **Este guia** |
| `.claude/CLAUDE-HARNESS-MEMORY-MODEL.md` | Como memória e kaizen são armazenados |
| `.claude/skills/*/SKILL.md` | Contrato de cada skill |
| `.claude/agents/*.md` | Prompt e ferramentas de cada papel |
| `.claude/rules/*.md` | As leis (git, security, code-quality, architecture, testing, releases) |
| `.claude/settings.json` | Permissões e onde cada hook se registra |
| `.claude/hooks/*.mjs` | Os trilhos determinísticos |
| `CONTEXT.md` (raiz) | O glossário do seu domínio |

No monorepo do harness (quem desenvolve o framework): o `README.md` é a visão geral do sistema e `docs/` é o estudo de engenharia — nenhum dos dois é onboarding de operador.

---

## 16. Glossário rápido

| Termo | Significado |
|---|---|
| **Cerimônia** | Passos obrigatórios antes de executar (spec, ataque, plano, dual…) |
| **Hard-gate** | Ponto onde **você** decide (spec, plano, demo). Em headless vira validação multi-agente |
| **Hook** | Script que roda antes/depois de uma ferramenta e pode **negar** a chamada |
| **Mão / olho** | Quem escreve código (barato) / quem julga (forte, sempre Claude) |
| **Teste travado** | Teste congelado antes da implementação; o executor não pode alterá-lo |
| **Run-record** | Arquivo-prova de que a mão terminou — não é prosa |
| **Capture-verified** | Carimbo de que a captura real foi conferida pro ship |
| **Regate** | Re-auditoria obrigatória após correção grave |
| **Harvest** | Colheita de aprendizado + limpeza dos buffers da run |
| **Kaizen** | Outbox de melhoria do **harness** — humano decide, nunca auto-aplica |
| **PRD** | O documento que sai do `grill` (`docs/prd/<slug>.md`) |
| **`CONTEXT.md`** | Glossário do domínio na raiz — vocabulário compartilhado, mantido só-adiciona |
| **Candidato a aprofundamento** | Proposta de reforma do `proposing-deepening` — dedução do modelo, nunca decisão travada |
| **Vendor** | Cópia versionada do harness em `.claude/` |
| **Segunda família** | Olho opcional de outra família de modelo (`codex-adversary`), fail-open |

---

*Última orientação de produto: se algo neste guia divergir do `.claude/CLAUDE.md` ou das skills vendored no projeto, **prevalece o que está no projeto** (e reinicie a sessão do Claude Code se você acabou de atualizar).*
