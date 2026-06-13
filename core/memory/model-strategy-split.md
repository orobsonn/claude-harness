---
name: model-strategy-split
description: hand_tiers (Ollama write-roles) vs eye roles (always Claude) in model_strategy — shape detection, CLAUDE_ALIASES, ALLOWED_MS_KEYS, back-compat
metadata:
  type: project
---

**Why:** Cheap Ollama models handle code-writing roles (executor, sniper) while review/orchestration
roles ("eyes") stay on Claude. The validator must accept BOTH shapes — new plans use `hand_tiers`,
vendored/legacy plans use the single `tiers` key — without silently accepting half-configured plans.

**How to apply:**

- **Shape detection:** presence of `hand_tiers` key = new split shape. `tiers` key only = legacy
  shape (all-Claude). BOTH present = REJECT with a clear error. NEITHER present = REJECT.
- `CLAUDE_ALIASES = [haiku, sonnet, opus]` — any value not in this set is treated as an Ollama
  model id. This is the canonical allowlist; add new Claude models here first. (Fable 5 was retired.)
- `ALLOWED_MS_KEYS` — explicit allowlist of valid top-level `model_strategy` keys (e.g. `hand_tiers`,
  `tiers`, `version`). An unknown key (e.g. a misspelled `eye_tiers`) = REJECT. Silently-ignored
  config is the worst kind of misconfiguration.
- **Eye roles can NEVER resolve to an Ollama model.** This invariant is tested with a table-driven
  test covering all 7 eye roles; a frozen test that covers only 1 role is a hole (adversary finding
  from this run — the rail must pin the full invariant, not a happy-path example).
- `complexity ?? severity` fallback resolves WITHIN `hand_tiers` only. It never cross-resolves to an
  eye-role alias. When `hand_tiers.high` is the target, executor falls back to Claude (v1 behavior;
  v2 will unlock the high tier).
- `executor` and `sniper` are forbidden as fixed keys in `model_strategy` (they resolve via
  `hand_tiers`). Having them as fixed keys would bypass the tier routing logic.
