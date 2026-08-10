---
name: oc-configuring-model-routing
description: "Interactive skill to reconfigure harness.routing.json via dual-safe presets or custom slots. Deterministic apply rewrites routing + all agent frontmatter models + AGENTS.md §8 + opencode.json model/small_model. Validates before any write. Never disables dual without explicit operator override. Never invents roles or commits secrets."
license: MIT
compatibility: opencode
metadata:
  phase: config
  gate: soft
---

# Configuring-Model-Routing

**This skill reconfigures model routing. It does not implement features.**

Runs interactively inside the `harness-config` lane (primary), which the operator reaches by typing `/configuring-model-routing` — operator messages in **pt-br product-language**; file content in English.

Announce at start (pt-br): "Vamos ajustar quais modelos cada papel do harness usa."

**No ceremony.** Reconfiguring routing is a harness-lifecycle op, not a product delivery — it never runs in `build`: `oc-triaging-requests` Step 0 refuses a prose request and tells the operator to type the command (no `classify`, no `oc-brainstorming`, no planner/adversary). The engine below is the safety net.

**Apply via the native tool — never `node -e`, never hand-edit the touchpoints.**  
The `configure-routing` tool wraps the sanctioned engine in-process with validation, staged-write, and rollback across every touchpoint. Hand-editing routing with `sed`/`perl` skips all of that and risks leaving touchpoints out of sync — bash can technically reach the files, but use the tool anyway.

- `configure-routing({ action: "inspect" })` → presets + touchpoints + current routing (read-only). Use for step 1.
- `configure-routing({ action: "apply", preset })` or `({ action: "apply", slots })` → validate + staged-write + rollback across all touchpoints.

Engine internals live in `skills/configuring-model-routing/references/apply-routing.mjs` (`listPresets`, `buildRoutingFromSlots`, `routingFromPreset`, `applyRoutingToDisk`, `listRoutingTouchpoints`) — the tool is the only invocation surface; do not import them from bash.

---

## Mapa canônico de touchpoints (tudo que precisa atualizar)

| # | Touchpoint | O que muda |
|---|---|---|
| 1 | `harness.routing.json` | `roles.*` (model + optional reasoningEffort), `constraints`, `modelCapabilities` |
| 2 | `agents/*.md` frontmatter `model:` + `reasoningEffort:` | **Todos** os agents com `model:` — catálogo em `AGENT_ROUTE_RESOLVERS` |
| 3 | `AGENTS.md` §8 | Tabela "Model routing (operator default)" |
| 4 | `opencode.json` / `opencode.json.example` | `model` (= build) + `small_model` (= compliance/security) quando presentes |

### Agents ↔ papel de routing

| Agent file(s) | Routing path |
|---|---|
| `build.md`, `plan.md`, `harness-config.md` | `roles.build` (model + optional reasoningEffort) |
| `planner.md` | `roles.planner` |
| `plan-reviewer.md` | `roles.plan-reviewer` (+ optional `secondEyeModel`) |
| `adversary.md` | `roles.adversary` (+ optional `secondEyeModel`) |
| `compliance.md`, `security.md`, `harvester.md`, `shipper.md` | respectivos `roles.*` |
| `executor-{low,medium,high}.md` | `executor.tiers.*` |
| `sniper-{low,medium,high}.md` | `sniper.tiers.*` |
| `test-author.md` | `roles.test-author` |
| `discussion-adversary.md` | sem `model:` (herda host) — **não** reescrever |

`listRoutingTouchpoints()` no módulo devolve a lista estável pra o operador.

---

## Does

1. Load current routing + options via `configure-routing({ action: "inspect" })`.
2. Elicit: preset dual-safe **or** custom slots (product language first).
3. **When the operator brings a custom model slug, confirm it exists first:** run `opencode models` (optionally `opencode models <provider>`) and check the slug is in the list. Catch the typo (`gpt-5.6-tera`) here, in product language, before applying. This is the primary check — the model is capable, use it. (Auth state is the operator's responsibility; do not try to verify logins.)
4. Apply via `configure-routing({ action: "apply", preset })` (primary) or `({ action: "apply", slots })` (escape hatch). The tool validates, stages, and rolls back on mid-fail; on `ok:false` it wrote nothing — explain the reason in pt-br and re-ask. **Backstop:** the tool independently re-checks every routing model against `opencode models` and rejects an unknown slug before writing — the deterministic net for when this skill isn't loaded (headless/cloud, compaction). Fail-open if the binary can't be listed.
5. **Ship to main** (default, same session) — follow `skills/lifecycle-ship-to-main.md`.
6. Report PR URL + what changed; demand **session restart**.

## Does not

- Force a second eye on by default — `secondEyeModel` is opt-in and fail-open.
- Confuse runtime `primary_only` with a config toggle.
- Invent roles or touch hand auth tokens.
- Leave the operator to open a second session just to commit/PR (ship is the default close-out).
- Write invalid config (zero partial write on validate fail).

---

## Procedure

### 1. Show current map

`configure-routing({ action: "inspect" })` returns the current routing + presets + touchpoints. Short table in pt-br:

| Papel (produto) | Modelo atual |
|---|---|
| Orquestrador / build | … |
| Planejador | … |
| Revisor de plano (avaliador único) | … |
| Adversário (avaliador único) | … |
| Compliance / security | … |
| Mãos low/medium/high | … |
| Test-author / harvester / shipper | … |

Highlight: avaliador único por padrão; `secondEyeModel` é opt-in fail-open (outro provider).

### 2. Elicit (one question at a time)

**Q1 — Onde aplicar?**
- Projeto vendored (`.opencode/`). Esta lane entrega somente a configuração do projeto atual; mudar
  os defaults do source do harness segue o fluxo normal de desenvolvimento do core.

**Q2 — Preset ou custom?**

Presets válidos (`listPresets()`):

| id | Label pt-br |
|---|---|
| `openai-ollama-default` | Olhos OpenAI (terra produz · sol verifica · luna suporta) + mãos Luna → Terra (default shippado) |
| `xai-ollama-dual` | Olhos Grok (xAI) + second eye/hands Ollama |

O preset `openai-ollama-default` **deriva de `CANONICAL_DEFAULT_ROUTING`** (fonte única) — é deep-equal ao `harness.routing.json` shippado por drift-guard test. Aplicá-lo nunca reintroduz layout stale.

Se OpenAI estiver indisponível: preferir `xai-ollama-dual` **no projeto** (não no core sem atualizar testes CI).

**Custom slots** (escape hatch de baixo nível — o caminho primário é linguagem natural → preset). Chave desconhecida/typo é **rejeitada** (falha alto, nunca grava routing degradado).

Valores de modelo (primaryEye, supportEye, testAuthor, hands.*, roles.*) aceitam **slug** (`openai/gpt-5.5`) **ou** rota `{ "model": "…", "reasoningEffort": "high" }`. Effort é opcional; o engine valida contra `modelCapabilities[model].supportsReasoningEffort` e grava/limpa `reasoningEffort:` no frontmatter do agent (OpenCode passa pro provider).

1. `primaryEye` — default de build, planner, plan-reviewer, adversary, test-author  
2. `secondaryEye` — **slug-only** (sem effort): optional `secondEyeModel` nos review roles (**outro provider**, fail-open)  
3. `supportEye` — default de compliance, security, harvester, shipper (default = primaryEye)  
4. `hands` low/medium/high — slug ou rota (default Luna → Terra ladder)
5. `testAuthor` — slug ou rota (default = primaryEye)
6. `roles` — overlay por papel (`build`, `planner`, `plan-reviewer`, `adversary`, `compliance`, `security`, `test-author`, `harvester`, `shipper`, ou `executor`/`sniper` com tiers). Ganha do default grosso; preserva `secondEyeModel` se já setado.  
7. `routing` — escape hatch total: documento `harness.routing.json` completo (exclusivo — não misturar com os outros slots, salvo `supportsReasoningEffort`)
8. `supportsReasoningEffort` — mapa opcional provider→boolean pra preencher capabilities
9. Auth: “você já autenticou provider X no OpenCode?”

Exemplo maleável (build Grok · julgamento GPT high · support misto · hands com effort):

```
configure-routing({ action: "apply", slots: '{"primaryEye":"xai/grok-4.5","supportEye":"xai/grok-4.5","testAuthor":"xai/grok-4.5","roles":{"planner":{"model":"openai/gpt-5.5","reasoningEffort":"high"},"plan-reviewer":{"model":"openai/gpt-5.5","reasoningEffort":"high"},"adversary":{"model":"openai/gpt-5.5","reasoningEffort":"high"},"harvester":{"model":"openai/gpt-5.6-luna","reasoningEffort":"medium"},"shipper":{"model":"openai/gpt-5.6-luna","reasoningEffort":"medium"}},"hands":{"low":{"model":"openai/gpt-5.6-luna","reasoningEffort":"low"},"medium":{"model":"openai/gpt-5.6-luna","reasoningEffort":"medium"},"high":{"model":"openai/gpt-5.6-terra","reasoningEffort":"medium"}},"supportsReasoningEffort":{"xai":true}}' })
```

**Aviso de produto (sempre se eye forte → modelo fraco):**  
olhos de plan-review / adversary / security em modelo barato enfraquecem o safety net — confirmar override explícito.

### 3. Apply (via the tool)

Immediately before applying, capture the lifecycle baseline. It allows dirty product work but
rejects a pre-existing edit to a vendor-owned harness file, which cannot safely be separated later:

```bash
node .opencode/tools/lifecycle-ship.mjs snapshot configuring-model-routing
```

Preset (primary form):

```
configure-routing({ action: "apply", preset: "openai-ollama-default" })
```

Custom slots (escape hatch — `slots` is a JSON string):

```
configure-routing({ action: "apply", slots: '{"primaryEye":"openai/gpt-5.6-sol","secondaryEye":"ollama-cloud/kimi-k2.7-code","supportEye":"openai/gpt-5.6-luna"}' })
```

On `ok:false` → **no net change** (validate fail writes nothing; mid-write failure rolls back). Explain the reason in pt-br and re-ask — do not fall back to `node`/`sed`.  
On `ok:true` → list `changed` + `warnings`.

**Hard gates (enforced by the engine, not prose):**
- Same-provider dual → reject  
- Weak **support** eye (compliance/security/harvester/shipper não openai/xai) → reject unless the operator confirms → pass `confirm_weak_eyes: true`  
- Weak **judgment** eye (plan-reviewer/adversary não openai/xai) → reject unless the operator confirms → pass `confirm_weak_judgment_eyes: true` (degrades the harness safety net; surface the warning first)  
- `targetRoot` = cwd sempre; `opencode.json` só sob cwd/ocRoot (nunca `../`)  
- AGENTS.md presente mas §8 ilegível → reject (não deixa routing/agents divergirem do doc)

### 4. Ship to main (default, same session)

**Do not stop at "commit when you want".** After `ok:true` with dirty harness paths, follow
`skills/lifecycle-ship-to-main.md` end-to-end. Its helper resumes an already-created lifecycle-only
commit after a restart or makes one from the fixed ownership set, then the same session pushes, opens
the PR, and squash-merges it. A clean worktree alone is never a reason to skip the procedure. Use
only the commands listed in `lifecycle-ship-to-main.md`.

Never stage secrets.

### 5. Close

- Resumo pt-br do que mudou (papéis) + URL do PR mergeado.
- **Obrigatório:** reiniciar a sessão OpenCode (agents carregam no boot).

---

## Constraints (schema / 02-routing)

- `version: 2`; every required role present.
- Review roles default to single evaluator `{ model }`. Optional `secondEyeModel` is fail-open (other provider when set).
- Legacy `families` shape still validates when fully formed (adapter / old projects).
- Every model needs `modelCapabilities[model].supportsReasoningEffort` boolean.
- Models with `supportsReasoningEffort: false` must not receive reasoningEffort from plugins.

---

## Smoke after apply

```bash
node --test core/opencode/skills/configuring-model-routing/references/apply-routing.test.mjs
node --test core/opencode/tools/configure-routing-core.test.mjs
node --test core/shared/lib/routing-validate.test.mjs
# if core source changed defaults without grok:
node --test core/opencode/model-routing.test.mjs
```
