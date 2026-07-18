---
name: configuring-model-routing
description: "Interactive skill to reconfigure harness.routing.json via dual-safe presets or custom slots. Deterministic apply rewrites routing + all agent frontmatter models + AGENTS.md §8 + opencode.json model/small_model. Validates before any write. Never disables dual without explicit operator override. Never invents roles or commits secrets."
license: MIT
compatibility: opencode
metadata:
  phase: config
  gate: soft
---

# Configuring-Model-Routing

**This skill reconfigures model routing. It does not implement features.**

Runs interactively inside `build` (primary) — operator messages in **pt-br product-language**; file content in English.

Announce at start (pt-br): "Vamos ajustar quais modelos cada papel do harness usa."

**Apply engine (do not reimplement by hand):**  
`skills/configuring-model-routing/references/apply-routing.mjs`  
— `listPresets`, `buildRoutingFromSlots`, `routingFromPreset`, `applyRoutingToDisk`, `listRoutingTouchpoints`.

---

## Mapa canônico de touchpoints (tudo que precisa atualizar)

| # | Touchpoint | O que muda |
|---|---|---|
| 1 | `harness.routing.json` | `roles.*`, `constraints`, `modelCapabilities` |
| 2 | `agents/*.md` frontmatter `model:` | **Todos** os agents com `model:` — catálogo em `AGENT_MODEL_RESOLVERS` |
| 3 | `AGENTS.md` §8 | Tabela "Model routing (operator default)" |
| 4 | `opencode.json` / `opencode.json.example` | `model` (= build) + `small_model` (= compliance/security) quando presentes |
| 5 | `planner-fallback.md` | Só se `roles.planner.fallback` existir |

### Agents ↔ papel de routing

| Agent file(s) | Routing path |
|---|---|
| `build.md`, `plan.md` | `roles.build.model` |
| `planner.md` | `roles.planner.model` |
| `planner-fallback.md` | `roles.planner.fallback.model` (opcional) |
| `plan-reviewer.md`, `plan-reviewer-family-1.md` | `plan-reviewer.families.family-1` |
| `plan-reviewer-family-2.md`, `plan-reviewer-openai.md` | `plan-reviewer.families.family-2` |
| `adversary.md`, `adversary-family-1.md` | `adversary.families.family-1` |
| `adversary-family-2.md`, `adversary-openai.md` | `adversary.families.family-2` |
| `compliance.md`, `security.md`, `harvester.md`, `shipper.md` | respectivos `roles.*.model` |
| `executor-{low,medium,high}.md` + `*-spawn` | `executor.tiers.*` |
| `sniper-{low,medium,high}.md` + `*-spawn` | `sniper.tiers.*` |
| `test-author.md` + `test-author-spawn.md` | `roles.test-author.model` |
| `discussion-adversary.md` | sem `model:` (herda host) — **não** reescrever |

`listRoutingTouchpoints()` no módulo devolve a lista estável pra o operador.

---

## Does

1. Load current routing (`core/opencode/` source **or** project `.opencode/` vendored).
2. Elicit: preset dual-safe **or** custom slots (product language first).
3. Build config via `buildRoutingFromSlots` / `routingFromPreset` — **must** `validateRouting` ok.
4. Apply **only** via `applyRoutingToDisk` (validate + stage-in-memory + staged writes with rollback on mid-fail).
5. Report changed files; demand **session restart**.

## Does not

- Offer single-provider “all Grok / all Ollama” presets — **invalid** under dual cross-family constraint (`family-1` provider ≠ `family-2` provider).
- Confuse runtime `primary_only` with a config toggle.
- Disable `requireDualOn` without explicit operator override + warning.
- Invent roles, touch hand auth tokens, or auto-commit.
- Write invalid config (zero partial write on validate fail).

---

## Procedure

### 1. Show current map

Load `harness.routing.json`. Short table in pt-br:

| Papel (produto) | Modelo atual |
|---|---|
| Orquestrador / build | … |
| Planejador | … |
| Revisor de plano (família 1 + 2) | … |
| Adversário (família 1 + 2) | … |
| Compliance / security | … |
| Mãos low/medium/high | … |
| Test-author / harvester / shipper | … |

Highlight: dual exige **dois providers**.

### 2. Elicit (one question at a time)

**Q1 — Onde aplicar?**
- Projeto vendored (`.opencode/`) — recomendado pra teste
- Source do harness (`core/opencode/`) — só se for mudar o default shippado (CI banne `xai/`/`grok` em surfaces committed)

**Q2 — Preset ou custom?**

Presets válidos (`listPresets()`):

| id | Label pt-br |
|---|---|
| `openai-ollama-default` | Olhos OpenAI + hands Ollama (default shippado) |
| `xai-ollama-dual` | Olhos Grok (xAI) + family-2/hands Ollama |

Se OpenAI estiver indisponível: preferir `xai-ollama-dual` **no projeto** (não no core sem atualizar testes CI).

**Custom slots** (se não preset):
1. `primaryEye` — build, planner, plan-reviewer-f1, adversary-f1  
2. `secondaryEye` — plan-reviewer-f2, adversary-f2 (**outro provider**)  
3. `supportEye` — compliance, security, harvester, shipper (default = primaryEye)  
4. Hands low/medium/high (default Ollama ladder)  
5. Auth: “você já autenticou provider X no OpenCode?”

**Aviso de produto (sempre se eye forte → modelo fraco):**  
olhos de plan-review / adversary / security em modelo barato enfraquecem o safety net — confirmar override explícito.

### 3. Validate (before write)

```js
import {
  routingFromPreset,
  buildRoutingFromSlots,
  applyRoutingToDisk,
  listRoutingTouchpoints,
} from "./references/apply-routing.mjs";

// preset:
const built = routingFromPreset("xai-ollama-dual");
// ou custom:
// const built = buildRoutingFromSlots({ primaryEye, secondaryEye, supportEye, hands });

if (!built.ok) { /* explain pt-br, re-ask — do not write */ }
```

### 4. Apply

```js
const result = applyRoutingToDisk({
  targetRoot: "<project root or core/opencode path>",
  routing: built.routing,
  updateOpencodeJson: true,
  // forceCoreGrok: true,   // only if applying xAI/Grok to harness source (CI bans by default)
  // confirmWeakEyes: true, // required if supportEye is not openai/* or xai/*
});
```

On `ok:false` → **no net change** (validate fail writes nothing; mid-write failure rolls back files already written in this apply).  
On `ok:true` → list `changed` + `warnings`.

**Hard gates (not prose-only):**
- Same-provider dual → reject  
- `supportEye` fraco (não openai/xai) → reject unless `confirmWeakEyes:true`  
- xAI/Grok no **source** `core/opencode` → reject unless `forceCoreGrok:true`  
- `opencode.json` só sob `targetRoot` / ocRoot (nunca `../`)  
- AGENTS.md presente mas §8 ilegível → reject (não deixa routing/agents divergirem do doc)

### 5. Close

- Resumo pt-br do que mudou (papéis, não slugs só).
- **Obrigatório:** reiniciar a sessão OpenCode (agents carregam no boot).
- Se aplicou em source do harness: lembrar CI `model-routing.test.mjs` banne xAI/Grok em surfaces committed.
- Não commitar secrets. Commit só se o operador pedir.

---

## Constraints (schema / 02-routing)

- `version: 2`; every required role present.
- Dual posts: `family-1` required + `family-2` optional fail-open; **providers must differ**.
- `requireDualOn` / `crossFamilyRoles` = plan-reviewer + adversary.
- Every model needs `modelCapabilities[model].supportsReasoningEffort` boolean.
- Models with `supportsReasoningEffort: false` must not receive reasoningEffort from plugins.

---

## Smoke after apply

```bash
node --test core/opencode/skills/configuring-model-routing/references/apply-routing.test.mjs
node --test core/shared/lib/routing-validate.test.mjs
# if core source changed defaults without grok:
node --test core/opencode/model-routing.test.mjs
```
