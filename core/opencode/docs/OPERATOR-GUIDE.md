# Guia do operador — Harness OpenCode

Documento **humano** (pt-br, linguagem de produto).  
Nomes de skills, agents e arquivos ficam em inglês (como no disco).

**Onde vive**

| No monorepo (fonte) | No projeto (vendored) |
|---|---|
| `core/opencode/docs/OPERATOR-GUIDE.md` | `.opencode/docs/OPERATOR-GUIDE.md` |

Atualiza com o harness (`/updating-harness`) — a lane já abre PR e mergeia na main. Depois: **reinicie a sessão** OpenCode.

**Não é** o README do repo (mistura Claude Code + VPS). **Este** guia cobre **só o shell OpenCode**.

---

## 1. Em uma frase

O harness OpenCode é um **sistema de entrega** dentro do OpenCode:

- Você pede em linguagem de produto.
- O agent **`build`** tria e orquestra.
- **Mãos** baratas implementam; **olhos** fortes revisam.
- **Plugins** (portões) bloqueiam atalhos perigosos (push sem prova, plano REVISE, etc.).
- O resultado esperado é **PR** — em headless, **draft, nunca merge automático**.

---

## 2. Três primaries: `plan`, `build` e `harness-config`

| | **`plan`** | **`build`** | **`harness-config`** |
|---|---|---|---|
| Para quê | Explorar, decidir, escrever o “o quê” | Entregar (implementar, PR) | Administrar o próprio harness |
| Escreve código? | Não | Não (só **despacha** quem escreve) | Não (só o engine sancionado escreve) |
| Triagem / cerimônia | Não | Sim, no 1º pedido da sessão | Não — lifecycle não tem cerimônia |
| Artefato | `## Build Spec` **no chat** | Spec + plano em disco + PR | `.opencode/` atualizado ou routing novo |
| Quando | “Vamos pensar nisso”, tradeoffs, ACs | “Implementa”, hotfix, feature | `/updating-harness`, `/configuring-model-routing` |

`plan` e `build` alternam com **Tab**. No `harness-config` você entra digitando um dos dois comandos (eles trocam o agent da sessão), ele roda **uma** operação e para — volte pro `build` com **Tab**.

**Handoff:** no `plan`, quando o Build Spec estiver pronto → **Tab** para `build` e peça implementar o spec da sessão.

Trocar de agent **não** libera implementação sozinha.

---

## 3. A fase pré-implementação — da ideia à issue

Antes de qualquer entrega existe uma fase que é **sua**: transformar ideia em pedido escrito.

```
ideia → oc-grill (entrevista, no plan) → PRD em docs/prd/<slug>.md → oc-creating-issues → motor
```

| Passo | O que acontece |
|---|---|
| **`oc-grill`** | Te entrevista **uma pergunta por vez**, sempre em consequência de produto, até a ideia virar um **PRD** escrito. Só **local** (recusa em sessão automática) |
| **PRD** | `docs/prd/<slug>.md`. Separa o que **você decidiu** do que o **modelo deduziu** (`## Suposições do modelo`) — dedução continua atacável, não vira lei |
| **`oc-creating-issues`** | Cada **requisito** do PRD vira **critério de aceite** (`#ac-N.M`) da issue — e critério de aceite vira o teste travado do motor |
| **motor** | Só entra aqui o que já está escrito e verificável |

Três coisas que mudam o resultado:

- **Requisito vago = motor mirando errado.** O requisito tem que afirmar um efeito observável (“retorna X”, “grava Y”, “mostra Z”), nunca “funciona bem”.
- **`## Em aberto` segura a fatia dependente.** Pergunta sem resposta é decisão que o motor autônomo inventaria às 3h da manhã — a fatia que depende dela **fica fora do lote** de issues e volta no próximo `oc-grill`.
- **O PRD não é decisão travada.** Ele entra no pipeline como texto de issue: planner, `plan-reviewer-*` e `adversary-*` podem contestar tudo.

**`oc-proposing-deepening`** é a variante para projeto legado: em vez de ideia nova, varre o código e propõe reforma (ver §8).

---

## 4. Checklist do início de sessão

1. Projeto tem harness? → `.opencode/.harness-version` existe.  
   - Não tem → digite **`/updating-harness`** (install).  
2. Primary certo: explorar = `plan` · entregar = `build`.  
3. Em `build`, o **primeiro** pedido roda **`oc-triaging-requests`** sozinho — não force “implementa já” sem triagem.  
4. Providers autenticados no OpenCode (OpenAI / xAI / Ollama Cloud — o que o routing usar).  
5. Depois de **mudar modelos** ou **atualizar harness** → **reiniciar a sessão**.  
6. Git: branch (nunca commit em `main`); stage seletivo.

---

## 5. Como o trabalho é classificado

| Modo | Quando (produto) | O que roda |
|---|---|---|
| **Sem cerimônia** | Pergunta, leitura, chat | Resposta direta |
| **QUICK** | Hotfix óbvio, 1–2 arquivos, **nada sensível** | Inline / 1 mão + gates baratos |
| **LIGHT** | Feature pequena, escopo claro | Spec → plano → loop leve → review final |
| **FULL** | Multi-arquivo, risco, ou path sensível | Loop completo + review final + demo + trilhos de ship |

**Só sobe de modo, nunca rebaixa** pedido sensível com “faz rápido”.

Leitura/chat (sem cerimônia) **não prende** feature; troca de feature no meio de LIGHT/FULL continua negada — use sessão nova só se já estiver em entrega.

**Paths que forçam FULL** (allowlist no `AGENTS.md`): auth, payment, billing, SQL, migrations, `.env*`, e `package.json` quando mexe em deps.

---

## 6. Fluxo de entrega (LIGHT / FULL)

```
oc-triaging-requests
    │
    ├─ lifecycle ──► /updating-harness ou /configuring-model-routing (agente harness-config)
    ├─ sem código ──► responde
    ├─ QUICK ──► implementa + commit barato
    └─ LIGHT / FULL
            │
            ▼
      oc-brainstorming  ── HARD-GATE: você aprova a spec ──►
            │
            ▼
      planner (plano JSON) ── validate-plan ── plan-reviewer ── HARD-GATE
            │
            ▼
      por task: test-author → executor → compliance
               → adversary (se ativo) → security (se sensível)
               → sniper (se preciso) → gates / regate
            │
            ▼
      review final → demo (interativo) → harvester → shipper (PR)
```

**Interativo:** você aprova spec/plano/demo.  
**Headless** (cron / “rode sozinho”): multi-agente no lugar das perguntas; **PR draft only**.

**No harvest, o vocabulário do projeto é atualizado.** O `harvester` mantém o `CONTEXT.md` da raiz — o glossário do domínio compartilhado entre você, o código e os agentes. É **durável e committado** (vai no PR da entrega), e a manutenção é **só-adição**: ele acrescenta termo que já apareceu no código merjado e **nunca** redefine nem remove um termo existente — mudança de significado vira proposta no `kaizen.md` pra você decidir. Quem semeia o arquivo pela primeira vez é o `oc-surveying-codebase`; planner, executor e as skills de pré-implementação leem os termos **literalmente**.

**Como o motor escreve o código.** O harness carrega regras de **profundidade de módulo** (“módulo fundo, interface pequena”) e de **superfície de teste** (“teste na porta, não na mobília”). O efeito prático pra você: o código sai com pouca coisa exposta e a complexidade escondida atrás disso, e os testes se prendem a essa porta — que é o que permite você revisar a interface e delegar o miolo.

---

## 7. Papéis (agents) — mapa mental

| Em português | Agent no disco | Tipo |
|---|---|---|
| Maestro da sessão | `build` | coordenador |
| Descoberta conversacional | `plan` | primary read-only |
| Arquiteto do plano | `planner` | olho |
| Revisor de plano | `plan-reviewer` (+ optional family-2 when secondEyeModel) | olho |
| Implementador | `executor-low` / `medium` / `high` | **mão** |
| Autor do teste travado | `test-author` | mão |
| Fiscal de critérios | `compliance` | olho |
| Advogado do diabo | `adversary` (+ optional family-2 when secondEyeModel) | olho |
| Corretor cirúrgico | `sniper-*` | mão |
| Segurança | `security` | olho |
| Colheita de aprendizado | `harvester` | mão (docs) |
| Git / PR | `shipper` | mão (bash) |

**Mãos** = escrevem código/testes (modelos mais baratos).  
**Olhos** = leem e julgam (modelos mais fortes).  
**Spawn CLI:** usa os mesmos agentes `mode: all`; o adapter fixa o modelo do tier via `--model` — ver `.opencode/docs/SPAWN-PATTERN.md`.

---

## 8. Skills — o que existe e quando chamar

O harness **não** carrega todas as skills o tempo todo. O `build` carrega sob demanda.  
Se você **não pedir**, algumas nunca aparecem (ex.: mudar modelo).

### Entrada e entrega (use o tempo todo)

| Skill | Quando | O que faz |
|---|---|---|
| **`oc-grill`** | Ideia grande ainda sem forma, **antes** de qualquer entrega (peça no `plan`; só local) | Te entrevista até virar um PRD em `docs/prd/<slug>.md` e depois vira issue |
| **`oc-proposing-deepening`** | Projeto que já existe e ficou difícil de mexer (peça no `plan`; só local) | Varre o código e traz no máximo 5 candidatos a reforma em `docs/architecture/deepening-candidates.md` — não mexe em nada, você escolhe |
| **`oc-triaging-requests`** | Automática no 1º pedido `build` | Classifica QUICK/LIGHT/FULL |
| **`oc-brainstorming`** | LIGHT/FULL (e no `plan`) | Spec de produto + hard-gate |
| **`oc-creating-plans`** | Só dentro do `planner` | Plano JSON |
| **`oc-orchestrating-delivery`** | LIGHT/FULL após spec | Orquestra o loop inteiro |

Duas notas sobre as duas primeiras (ambas rodam no `plan`, onde o shell é negado — por construção elas **não editam código nem abrem issue**):

- **Reforma é entrega local.** A issue que sai de um candidato do `oc-proposing-deepening` **nunca é `harness:ready`** — reestruturar código que já funciona não merja sozinho às 3h da manhã; você entrega localmente, olhando o resultado.
- **Nem PRD nem candidato é decisão travada** — os dois entram no motor como texto atacável.

### Configuração e manutenção (peça explicitamente)

As duas de lifecycle são **comandos** — não peça em prosa (o `build` recusa e te manda digitar o comando):

| Comando | Quando | O que faz |
|---|---|---|
| **`/updating-harness`** | Instalar, atualizar ou sincronizar o harness | Vendor `.opencode/` da release + PR mergeado na main (lane `harness-config`) |
| **`/configuring-model-routing`** | Trocar os modelos dos papéis | Reescreve routing + agents + AGENTS §8 + PR mergeado na main (lane `harness-config`) |

As demais continuam sendo skills que o `build` carrega quando o pedido é claro:

| Skill | Quando pedir (exemplos) | O que faz |
|---|---|---|
| **`oc-committing-changes`** | Commit avulso fora do ship full | Commit seletivo |
| **`oc-releasing-versions`** | Release versionada do **seu** produto | CHANGELOG + tag (se o projeto usa o fluxo) |
| **`oc-creating-issues`** | “Abre issue harness-ready” | Issue no formato do pipeline |

### Memória e melhoria (geralmente no harvest)

| Skill | Quando | O que faz |
|---|---|---|
| **`oc-recording-findings`** | Harvest | Consolida achados em `findings.md` |
| **`oc-distilling-learnings`** | Harvest | Leva o que é durável pra `MEMORY.md` / AGENTS nested |
| **`oc-proposing-improvements`** | Harvest | Só **propõe** em `kaizen.md` (nunca aplica sozinho) |
| **`oc-surveying-codebase`** | Projeto legado sem memória | Cold-start de MEMORY **e semeia o `CONTEXT.md`** (glossário do domínio) |
| **`oc-importing-claude-memory`** | Migrou de Claude Code | One-shot `~/.claude/.../memory` → `MEMORY.md` |
| **`oc-authoring-rules`** | Nova lei de pasta | Nested AGENTS / regras |
| **`oc-canonical-critical-classes`** | Interno (adversary/compliance) | Taxonomia de falhas — ammunition, não ação |

### Como “acordar” uma skill de config

**Lifecycle do harness: digite o comando.** Pedir em prosa no `build` não funciona — o triage recusa e te devolve o comando:

- **`/updating-harness`** — instalar, atualizar ou sincronizar o harness.  
- **`/configuring-model-routing`** — trocar os modelos dos papéis.

**As outras: diga o objetivo em produto** no `build` — não precisa decorar o nome, ele carrega a skill certa se o pedido for claro:

- “**Abre uma issue** harness-ready pra X.”  
- “**Commita** só esses arquivos.”

---

## 9. Mudar modelos (detalhe)

**Comando:** `/configuring-model-routing`

1. Roda no `harness-config` (interativo) — o comando troca o agent da sessão.  
2. Mostra o mapa atual (quem é olho / mão).  
3. Presets **dual-safe** (dois providers):
   - `openai-ollama-default` — default shippado (mãos Luna → Terra)
   - `xai-ollama-dual` — olhos Grok + second eye opt-in/hands Ollama  
4. Aplica em **todos** os pontos:  
   `harness.routing.json` · frontmatter de **todos** os agents · `AGENTS.md` §8 · `opencode.json`  
5. **Ship automático:** abre PR, espera checks, squash-merge na `main` (mesma sessão — não precisa abrir outra).  
6. **Reinicia a sessão.**

**Regras duras (não são “dica”):**

- Dual exige **providers diferentes** (não existe preset “tudo Grok”).  
- Aplicar Grok num slot obrigatório do **source** do monorepo do harness exige flag explícita (CI bloqueia). O segundo olho (`secondEyeModel`) é **opt-in** (ausente por padrão); quando ligado, o stub `*-family-2` usa o modelo configurado.  
- Preferir aplicar no **projeto** (`.opencode/`).

Engine determinístico:  
`.opencode/skills/configuring-model-routing/references/apply-routing.mjs`

---

## 10. Atualizar o harness no projeto

**Comando:** `/updating-harness` (roda no `harness-config`)  
Só **interativo** e pedido **explícito** (não mistura com feature).

```bash
# última release
gh release view --repo orobsonn/claude-harness --json tagName -q .tagName

npx --yes --package=github:orobsonn/claude-harness#<tag> claude-harness init --target opencode
```

- Detecta install vs update por `.opencode/.harness-version`.  
- **Não** use `@latest` do npm (pode vendorar shell errado/stale).  
- **Ship automático:** PR + squash-merge na `main` na mesma sessão (cron/cloud só enxerga o repo commitado).  
- **Reinicia a sessão.**  
- Headless: a skill **recusa** (não mexe no harness sozinha).

---

## 11. Paths de runtime (o que é efêmero)

| Conceito | Path |
|---|---|
| Plano da feature | `.opencode/plans/<sessionID>-<feature_id>/` |
| Plano JSON | `.../execution-plan.json` |
| Spec | `.../spec.md` |
| Estado dos portões | `.opencode/plans/.state/<session>/gate-state.json` |
| Prova da mão (hand-record) | `.opencode/plans/.state/hand-records/<feature>/<session>/<task>.json` |
| Achados da run | `findings.md` na raiz (some no harvest) |
| Memória durável | `MEMORY.md` |
| Glossário do domínio (durável, **committado**) | `CONTEXT.md` na raiz |
| PRD da fase pré-implementação | `docs/prd/<slug>.md` |
| Candidatos a reforma | `docs/architecture/deepening-candidates.md` |
| Melhorias do harness (outbox) | `kaizen.md` |
| Versão vendored | `.opencode/.harness-version` |
| Routing | `.opencode/harness.routing.json` |

Plans / hand-records / findings são **efêmeros** (apagados no harvest).  
`CONTEXT.md` **não** é efêmero: é committado e sobe no PR da entrega.  
Auditoria que fica = **git**.

---

## 12. Portões (plugins) — o que o operador sente

Você não configura plugin a plugin no dia a dia. Eles **barram** atalhos:

| Sintoma | Causa comum | O que fazer |
|---|---|---|
| “Planner negado” / cerimônia | Spec ainda não passou brainstorm + ataque | Completar brainstorm; não pular pro plano |
| Executor bloqueado após review do plano | **REVISE** no review do plano (`plan_verdict`) | Corrigir o plano; o segundo olho opcional não substitui o **APPROVE** principal |
| Push / PR bloqueado: captura | Falta hand-record DONE + `capture-verified` numa task terminada | A mão precisa terminar de verdade; prosa “pronto” não conta |
| Push bloqueado: task do plano sem evidência | **Uma writing task do plano nunca foi despachada** (nem hand-record, nem captura) — feature ia subir pela metade | Despachar a mão de cada task que falta antes de entregar. Não bloqueia `DONE_WITH_CONCERNS` (shippable) nem se o plano não puder ser lido (fail-open) |
| Push bloqueado: regate | Correção grave (sniper-high) sem re-auditoria | Rodar adversary de regate + `regate-passed` |
| Push FULL bloqueado: final / demo | Falta review final (ou demo no interativo) | Completar review final; no interativo, demo quando pedido |
| Comportamento “meio velho” | Update/routing sem restart | Reiniciar sessão OpenCode |

**Avaliador único** por padrão. Segundo olho (`secondEyeModel`) é opt-in e fail-open (se o 2º provider cair, segue com aviso — não finge que o segundo olho rodou).

**Por que um olho falhou (forense):** quando um review/eye falha, o gate-state registra a causa **classificada** em `last_provider_diagnostic` (e conta em `review_failure_counts`) — `rate_limited`, `credit`, `unauthenticated`, `timeout`, `upstream_5xx` (5xx do provider), `provider_error` (desconhecido) ou `gate_blocked` (um portão **interno** do harness barrou, não é falha de provider). Assim dá pra distinguir “o xAI/Ollama caiu” de “bati num gate meu” sem caçar no log. O diagnóstico é sanitizado (sem segredos).

---

## 13. Interativo vs headless

| | Interativo | Headless |
|---|---|---|
| Quem decide produto | Você | Multi-agente + risco no PR |
| Spec / plano / demo | Você no loop | Automático / validado vs ACs |
| Entrega | Merge com seu OK | **PR draft, nunca merge** |
| Update harness | `/updating-harness` ok | Negado |
| Sinais típicos OC | Sessão normal | “autônomo”, cron VPS, env de observability |

---

## 14. Ferramentas nativas que o maestro usa

| Tool | Função |
|---|---|
| `classify` | Grava modo + feature no gate-state (fim do triage) |
| `validate-plan` | Valida o JSON do plano |
| `mark` | Carimbos privilegiados (hand-finished, capture-verified, regate, final-review…) — **não** use Bash pra isso |
| `verify` | Roda teste pinado da task (hand ativa) |
| `complexity-scorer` | Banda low/medium/high de um path |

Quando o planner estiver bloqueado por cerimônia, complete somente o fato ausente para a feature classificada: `brainstormed` ausente → execute o brainstorming e chame a ação nativa `mark`; `adversary_fired` ausente → despache o adversary primário e chame a ação nativa `mark`. O planner libera quando encontra os dois booleans crus e a feature correspondente no gate-state; isso não prova proveniência on-disk. O caminho oficial continua sendo a tool nativa, e edição direta é proibida por convenção/permissões.

---

## 15. Boas práticas (operador)

1. **Uma intenção por sessão** quando possível (feature vs “só atualizar harness”).  
2. **Decisões de produto** no brainstorm — não deixe o modelo escolher sozinho o “o quê”.  
3. **Tab `plan`** quando ainda não sabe o desenho; **`build`** quando quer entrega.  
4. Se OpenAI falhar: skill **`oc-configuring-model-routing`** → configure outro provider ou um segundo olho opcional.
5. Depois de update ou routing: **restart**.  
6. Leia denials de portão como **mensagem de produto** (“falta prova da mão”), não como “bug aleatório” — a menos que o smoke diga o contrário.  
7. **Nunca** peça pra afrouxar review / capture / regate “só pra passar” — isso é o valor do harness.

---

## 16. Onde aprofundar (no projeto vendored)

| Arquivo | Conteúdo |
|---|---|
| `AGENTS.md` (raiz, bloco harness) | Entry policy, routing, paths, security |
| `.opencode/docs/OPERATOR-GUIDE.md` | **Este guia** |
| `.opencode/docs/SPAWN-PATTERN.md` | Como a mesma mão serve Task e CLI |
| `.opencode/skills/*/SKILL.md` | Contrato de cada skill |
| `.opencode/harness.routing.json` | Modelos atuais |
| `.opencode/agents/*.md` | Prompt e permissões de cada papel |

---

## 17. Glossário rápido

| Termo | Significado |
|---|---|
| **Cerimônia** | Passos obrigatórios antes de executar (spec, plano, dual…) |
| **Dual** | Dois olhos de famílias de modelo diferentes no mesmo julgamento |
| **Hand-record** | Arquivo-prova de que a mão terminou (não é prosa) |
| **Capture-verified** | Carimbo de que a captura real foi conferida pro ship |
| **Regate** | Re-auditoria obrigatória após correção grave |
| **CONTEXT.md** | Glossário do domínio na raiz — vocabulário comum entre você, o código e os agentes. Committado; `oc-surveying-codebase` semeia, o `harvester` só **acrescenta** termo (nunca redefine nem remove) |
| **PRD** | O que sai do `oc-grill`: problema, requisitos verificáveis e o que ficou em aberto |
| **Harvest** | Colheita de aprendizado + limpeza de buffers da run |
| **Kaizen** | Outbox de melhoria do **harness** (humano decide) |
| **Vendor** | Cópia versionada do harness em `.opencode/` |

---

*Última orientação de produto: se algo neste guia divergir do `harness.routing.json` ou do `AGENTS.md` vendored, **prevalece o que está no projeto** (e reinicie a sessão se acabou de atualizar).*
