# Guia do operador — Harness OpenCode

Documento **humano** (pt-br, linguagem de produto).  
Nomes de skills, agents e arquivos ficam em inglês (como no disco).

**Onde vive**

| No monorepo (fonte) | No projeto (vendored) |
|---|---|
| `core/opencode/docs/OPERATOR-GUIDE.md` | `.opencode/docs/OPERATOR-GUIDE.md` |

Atualiza com o harness (`updating-harness`). Depois de update: **reinicie a sessão** OpenCode.

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

## 2. Dois primaries: `plan` vs `build` (Tab)

| | **`plan`** | **`build`** |
|---|---|---|
| Para quê | Explorar, decidir, escrever o “o quê” | Entregar (implementar, PR) |
| Escreve código? | Não | Não (só **despacha** quem escreve) |
| Triagem / cerimônia | Não | Sim, no 1º pedido da sessão |
| Artefato | `## Build Spec` **no chat** | Spec + plano em disco + PR |
| Quando | “Vamos pensar nisso”, tradeoffs, ACs | “Implementa”, hotfix, feature |

**Handoff:** no `plan`, quando o Build Spec estiver pronto → **Tab** para `build` e peça implementar o spec da sessão.

Trocar de agent **não** libera implementação sozinha.

---

## 3. Checklist do início de sessão

1. Projeto tem harness? → `.opencode/.harness-version` existe.  
   - Não tem → skill **`updating-harness`** (install).  
2. Primary certo: explorar = `plan` · entregar = `build`.  
3. Em `build`, o **primeiro** pedido roda **`triaging-requests`** sozinho — não force “implementa já” sem triagem.  
4. Providers autenticados no OpenCode (OpenAI / xAI / Ollama Cloud — o que o routing usar).  
5. Depois de **mudar modelos** ou **atualizar harness** → **reiniciar a sessão**.  
6. Git: branch (nunca commit em `main`); stage seletivo.

---

## 4. Como o trabalho é classificado

| Modo | Quando (produto) | O que roda |
|---|---|---|
| **Sem cerimônia** | Pergunta, leitura, chat | Resposta direta |
| **QUICK** | Hotfix óbvio, 1–2 arquivos, **nada sensível** | Inline / 1 mão + gates baratos |
| **LIGHT** | Feature pequena, escopo claro | Spec → plano → loop leve → dual final |
| **FULL** | Multi-arquivo, risco, ou path sensível | Loop completo + dual + demo + trilhos de ship |

**Só sobe de modo, nunca rebaixa** pedido sensível com “faz rápido”.

**Paths que forçam FULL** (allowlist no `AGENTS.md`): auth, payment, billing, SQL, migrations, `.env*`, e `package.json` quando mexe em deps.

---

## 5. Fluxo de entrega (LIGHT / FULL)

```
triaging-requests
    │
    ├─ lifecycle (install/update harness) ──► updating-harness ──► restart
    ├─ sem código ──► responde
    ├─ QUICK ──► implementa + commit barato
    └─ LIGHT / FULL
            │
            ▼
      brainstorming  ── HARD-GATE: você aprova a spec ──►
            │
            ▼
      planner (plano JSON) ── validate-plan ── plan-reviewer dual ── HARD-GATE
            │
            ▼
      por task: test-author → executor → compliance
               → adversary (se ativo) → security (se sensível)
               → sniper (se preciso) → gates / regate
            │
            ▼
      dual final → demo (interativo) → harvester → shipper (PR)
```

**Interativo:** você aprova spec/plano/demo.  
**Headless** (cron / “rode sozinho”): multi-agente no lugar das perguntas; **PR draft only**.

---

## 6. Papéis (agents) — mapa mental

| Em português | Agent no disco | Tipo |
|---|---|---|
| Maestro da sessão | `build` | coordenador |
| Descoberta conversacional | `plan` | primary read-only |
| Arquiteto do plano | `planner` | olho |
| Revisor de plano | `plan-reviewer-family-1` (+ family-2) | olho dual |
| Implementador | `executor-low` / `medium` / `high` | **mão** |
| Autor do teste travado | `test-author` | mão |
| Fiscal de critérios | `compliance` | olho |
| Advogado do diabo | `adversary-family-1` (+ family-2) | olho dual |
| Corretor cirúrgico | `sniper-*` | mão |
| Segurança | `security` | olho |
| Colheita de aprendizado | `harvester` | mão (docs) |
| Git / PR | `shipper` | mão (bash) |

**Mãos** = escrevem código/testes (modelos mais baratos).  
**Olhos** = leem e julgam (modelos mais fortes).  
**Spawn** (`*-spawn`): gêmeos `mode: primary` só para CLI `opencode run` — ver `.opencode/docs/SPAWN-PATTERN.md`.

---

## 7. Skills — o que existe e quando chamar

O harness **não** carrega todas as skills o tempo todo. O `build` carrega sob demanda.  
Se você **não pedir**, algumas nunca aparecem (ex.: mudar modelo).

### Entrada e entrega (use o tempo todo)

| Skill | Quando | O que faz |
|---|---|---|
| **`triaging-requests`** | Automática no 1º pedido `build` | Classifica QUICK/LIGHT/FULL |
| **`brainstorming`** | LIGHT/FULL (e no `plan`) | Spec de produto + hard-gate |
| **`creating-plans`** | Só dentro do `planner` | Plano JSON |
| **`orchestrating-delivery`** | LIGHT/FULL após spec | Orquestra o loop inteiro |

### Configuração e manutenção (peça explicitamente)

| Skill | Quando pedir (exemplos) | O que faz |
|---|---|---|
| **`updating-harness`** | “Atualiza o harness”, “instala OC harness” | Vendor `.opencode/` da release |
| **`configuring-model-routing`** | “Troca os modelos pro Grok”, “routing Ollama” | Reescreve routing + agents + AGENTS §8 |
| **`committing-changes`** | Commit avulso fora do ship full | Commit seletivo |
| **`releasing-versions`** | Release versionada do **seu** produto | CHANGELOG + tag (se o projeto usa o fluxo) |
| **`creating-issues`** | “Abre issue harness-ready” | Issue no formato do pipeline |

### Memória e melhoria (geralmente no harvest)

| Skill | Quando | O que faz |
|---|---|---|
| **`recording-findings`** | Harvest | Consolida achados em `findings.md` |
| **`distilling-learnings`** | Harvest | Leva o que é durável pra `MEMORY.md` / AGENTS nested |
| **`proposing-improvements`** | Harvest | Só **propõe** em `kaizen.md` (nunca aplica sozinho) |
| **`surveying-codebase`** | Projeto legado sem memória | Cold-start de MEMORY |
| **`importing-claude-memory`** | Migrou de Claude Code | One-shot `~/.claude/.../memory` → `MEMORY.md` |
| **`authoring-rules`** | Nova lei de pasta | Nested AGENTS / regras |
| **`canonical-critical-classes`** | Interno (adversary/compliance) | Taxonomia de falhas — ammunition, não ação |

### Como “acordar” uma skill de config

No `build`, diga o objetivo em produto, por exemplo:

- “Quero **trocar os modelos** porque a OpenAI está travada — usa a skill de routing.”  
- “**Atualiza o harness** OpenCode neste repo.”  
- “**Abre uma issue** harness-ready pra X.”

Não precisa decorar o nome; o triaging/build carrega a skill certa se o pedido for claro.  
Para routing, o nome canônico é **`configuring-model-routing`**.

---

## 8. Mudar modelos (detalhe)

**Skill:** `configuring-model-routing`

1. Roda em `build` (interativo).  
2. Mostra o mapa atual (quem é olho / mão).  
3. Presets **dual-safe** (dois providers):
   - `openai-ollama-default` — default shippado  
   - `xai-ollama-dual` — olhos Grok + family-2/hands Ollama  
4. Aplica em **todos** os pontos:  
   `harness.routing.json` · frontmatter de **todos** os agents · `AGENTS.md` §8 · `opencode.json`  
5. **Reinicia a sessão.**

**Regras duras (não são “dica”):**

- Dual exige **providers diferentes** (não existe preset “tudo Grok”).  
- Aplicar Grok no **source** do monorepo do harness exige flag explícita (CI bloqueia).  
- Preferir aplicar no **projeto** (`.opencode/`).

Engine determinístico:  
`.opencode/skills/configuring-model-routing/references/apply-routing.mjs`

---

## 9. Atualizar o harness no projeto

**Skill:** `updating-harness`  
Só **interativo** e pedido **explícito** (não mistura com feature).

```bash
# última release
gh release view --repo orobsonn/claude-harness --json tagName -q .tagName

npx -y "github:orobsonn/claude-harness#<tag>" init --target opencode
```

- Detecta install vs update por `.opencode/.harness-version`.  
- **Não** use `@latest` do npm (pode vendorar shell errado/stale).  
- Commita `.opencode/` (cron/cloud só enxerga o repo).  
- **Reinicia a sessão.**  
- Headless: a skill **recusa** (não mexe no harness sozinha).

---

## 10. Paths de runtime (o que é efêmero)

| Conceito | Path |
|---|---|
| Plano da feature | `.opencode/plans/<sessionID>-<feature_id>/` |
| Plano JSON | `.../execution-plan.json` |
| Spec | `.../spec.md` |
| Estado dos portões | `.opencode/plans/.state/<session>/gate-state.json` |
| Prova da mão (hand-record) | `.opencode/plans/.state/hand-records/<feature>/<session>/<task>.json` |
| Achados da run | `findings.md` na raiz (some no harvest) |
| Memória durável | `MEMORY.md` |
| Melhorias do harness (outbox) | `kaizen.md` |
| Versão vendored | `.opencode/.harness-version` |
| Routing | `.opencode/harness.routing.json` |

Plans / hand-records / findings são **efêmeros** (apagados no harvest).  
Auditoria que fica = **git**.

---

## 11. Portões (plugins) — o que o operador sente

Você não configura plugin a plugin no dia a dia. Eles **barram** atalhos:

| Sintoma | Causa comum | O que fazer |
|---|---|---|
| “Planner negado” / cerimônia | Spec ainda não passou brainstorm + ataque | Completar brainstorm; não pular pro plano |
| Executor bloqueado após review do plano | **REVISE** no dual de plano (`plan_verdict`) | Corrigir o plano; dual **both** sozinho **não** libera se foi REVISE |
| Push / PR bloqueado: captura | Falta hand-record DONE + `capture-verified` numa task terminada | A mão precisa terminar de verdade; prosa “pronto” não conta |
| Push bloqueado: task do plano sem evidência | **Uma writing task do plano nunca foi despachada** (nem hand-record, nem captura) — feature ia subir pela metade | Despachar a mão de cada task que falta antes de entregar. Não bloqueia `DONE_WITH_CONCERNS` (shippable) nem se o plano não puder ser lido (fail-open) |
| Push bloqueado: regate | Correção grave (sniper-high) sem re-auditoria | Rodar adversary de regate + `regate-passed` |
| Push FULL bloqueado: final / demo | Falta review final (ou demo no interativo) | Completar dual final; no interativo, demo quando pedido |
| Harvester bloqueado | `findings.md` ausente | Garantir que o loop gravou findings antes do harvest |
| Comportamento “meio velho” | Update/routing sem restart | Reiniciar sessão OpenCode |

**Dual de olho:** family-1 obrigatória; family-2 opcional e fail-open (se o 2º provider cair, segue com aviso — não inventa dual completo).

**Por que um olho falhou (forense):** quando um review/eye falha, o gate-state registra a causa **classificada** em `last_provider_diagnostic` (e conta em `review_failure_counts`) — `rate_limited`, `credit`, `unauthenticated`, `timeout`, `upstream_5xx` (5xx do provider), `provider_error` (desconhecido) ou `gate_blocked` (um portão **interno** do harness barrou, não é falha de provider). Assim dá pra distinguir “o xAI/Ollama caiu” de “bati num gate meu” sem caçar no log. O diagnóstico é sanitizado (sem segredos).

---

## 12. Interativo vs headless

| | Interativo | Headless |
|---|---|---|
| Quem decide produto | Você | Multi-agente + risco no PR |
| Spec / plano / demo | Você no loop | Automático / validado vs ACs |
| Entrega | Merge com seu OK | **PR draft, nunca merge** |
| Update harness | `updating-harness` ok | Negado |
| Sinais típicos OC | Sessão normal | “autônomo”, cron VPS, env de observability |

---

## 13. Ferramentas nativas que o maestro usa

| Tool | Função |
|---|---|
| `classify` | Grava modo + feature no gate-state (fim do triage) |
| `validate-plan` | Valida o JSON do plano |
| `mark` | Carimbos privilegiados (hand-finished, capture-verified, dual, regate, final-review…) — **não** use Bash pra isso |
| `ceremony-next` | Próximo passo allowlisted após denial de cerimônia |
| `verify` | Roda teste pinado da task (hand ativa) |
| `complexity-scorer` | Banda low/medium/high de um path |

---

## 14. Boas práticas (operador)

1. **Uma intenção por sessão** quando possível (feature vs “só atualizar harness”).  
2. **Decisões de produto** no brainstorm — não deixe o modelo escolher sozinho o “o quê”.  
3. **Tab `plan`** quando ainda não sabe o desenho; **`build`** quando quer entrega.  
4. Se OpenAI falhar: skill **`configuring-model-routing`** → preset dual com outro provider (ex. Grok + Ollama).  
5. Depois de update ou routing: **restart**.  
6. Leia denials de portão como **mensagem de produto** (“falta prova da mão”), não como “bug aleatório” — a menos que o smoke diga o contrário.  
7. **Nunca** peça pra afrouxar dual / capture / regate “só pra passar” — isso é o valor do harness.

---

## 15. Onde aprofundar (no projeto vendored)

| Arquivo | Conteúdo |
|---|---|
| `AGENTS.md` (raiz, bloco harness) | Entry policy, routing, paths, security |
| `.opencode/docs/OPERATOR-GUIDE.md` | **Este guia** |
| `.opencode/docs/SPAWN-PATTERN.md` | Por que existem `*-spawn` |
| `.opencode/skills/*/SKILL.md` | Contrato de cada skill |
| `.opencode/harness.routing.json` | Modelos atuais |
| `.opencode/agents/*.md` | Prompt e permissões de cada papel |

No monorepo do harness (desenvolvedores do framework):  
`docs/opencode-implementation-playbook.md` é **engenharia de batches**, não onboarding de operador.

---

## 16. Glossário rápido

| Termo | Significado |
|---|---|
| **Cerimônia** | Passos obrigatórios antes de executar (spec, plano, dual…) |
| **Dual** | Dois olhos de famílias de modelo diferentes no mesmo julgamento |
| **Hand-record** | Arquivo-prova de que a mão terminou (não é prosa) |
| **Capture-verified** | Carimbo de que a captura real foi conferida pro ship |
| **Regate** | Re-auditoria obrigatória após correção grave |
| **Harvest** | Colheita de aprendizado + limpeza de buffers da run |
| **Kaizen** | Outbox de melhoria do **harness** (humano decide) |
| **Vendor** | Cópia versionada do harness em `.opencode/` |

---

*Última orientação de produto: se algo neste guia divergir do `harness.routing.json` ou do `AGENTS.md` vendored, **prevalece o que está no projeto** (e reinicie a sessão se acabou de atualizar).*
