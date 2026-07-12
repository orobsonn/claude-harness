---
name: configuring-model-routing
description: "Interactive skill to reconfigure harness.routing.json (model family presets or per-role edits). Validates with shared routing validator, rewrites routing + agent frontmatter models. Never disables dual on requireDualOn without explicit operator override warning. Never invents roles or commits secrets."
license: MIT
compatibility: opencode
metadata:
  phase: config
  gate: soft
---

# Configuring-Model-Routing

**This skill reconfigures model routing. It does not implement features.**

Runs interactively inside `build` (primary) — asks the operator in **pt-br product-language**, applies changes in English file content.

Announce at start (pt-br): "Vamos ajustar quais modelos cada papel do harness usa."

---

## Does

1. Load current `harness.routing.json` (project `.opencode/` or `core/opencode/` source).
2. Offer family presets or per-role edits (product language — "quem revisa o plano", not model slugs first).
3. Run shared validate (`core/shared/lib/routing-validate.mjs` or project copy).
4. On valid config: rewrite routing file + regenerate agent frontmatter `model:` fields to match.
5. Never auto-commit secrets. Never invent new roles.

## Does not

- Disable dual on `requireDualOn` roles without an **explicit operator override warning** (pt-br: dual cross-family is the safety net on plan review and attack review).
- Change plugin/gate behavior.
- Touch hand auth tokens.

---

## Procedure

### 1. Show current map

Summarize roles → models in a short table (pt-br labels). Highlight dual posts.

### 2. Elicit change

Ask one question at a time:

- Preset (e.g. keep Grok+OpenAI default) vs per-role edit?
- Which role?
- New model slug (must be a real OC provider/model the operator can auth)?

### 3. Validate

Run shared `validateRouting` on the proposed JSON. On failure, explain in product language and re-ask — do not write invalid config.

### 4. Apply

- Write `harness.routing.json`.
- Update matching agent frontmatter `model:` (including `*-openai` dual eyes and `*-spawn` twins).
- Confirm dual still present on plan-reviewer + adversary unless operator overrode with warning.

### 5. Close

Report what changed (pt-br). Suggest the operator re-open the session so agents reload.

---

## Constraints (from 02-routing)

- Every fixed role has a model.
- `requireDualOn` roles have non-empty `dual` (unless explicit override).
- `crossFamilyRoles`: primary provider ≠ dual provider.
- `supportsReasoningEffort: false` models must not receive reasoningEffort from plugins.
