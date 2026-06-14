---
name: model-strategy-split
description: hand_tiers (Ollama write-roles) vs eye roles (always Claude) in model_strategy — shape detection, CLAUDE_ALIASES, ALLOWED_MS_KEYS, legacy tiers removed
metadata:
  type: project
---

**Why:** Cheap Ollama models handle code-writing roles (executor, sniper) while review/orchestration
roles ("eyes") stay on Claude. `hand_tiers` is the ONLY valid shape — the legacy Claude-only `tiers`
key was removed because it let executor/sniper silently resolve to expensive Claude, defeating the
cheap-hands default. A Claude hand is still reachable by putting a Claude alias in a `hand_tiers` tier.

**How to apply:**

- **Shape detection:** `hand_tiers` key is REQUIRED. The legacy `tiers` key is REJECTED with a clear
  error ("removed — use hand_tiers"). Missing `hand_tiers` = REJECT. `hand_tiers` values are free
  model ids (an Ollama id, or a Claude alias as an explicit escape) — not enum-constrained.
- `CLAUDE_ALIASES = [haiku, sonnet, opus]` — used only to validate the 7 fixed eye roles (each must
  be a Claude alias). This is the canonical allowlist; add new Claude models here first. (Fable 5 was retired.)
- `ALLOWED_MS_KEYS` — explicit allowlist of valid top-level `model_strategy` keys (`hand_tiers` + the
  7 fixed eye roles). `tiers` is NO LONGER allowed. An unknown key (e.g. a misspelled `eye_tiers`) =
  REJECT. Silently-ignored config is the worst kind of misconfiguration.
- **Eye roles can NEVER resolve to an Ollama model.** This invariant is tested with a table-driven
  test covering all 7 eye roles; a frozen test that covers only 1 role is a hole (adversary finding
  from this run — the rail must pin the full invariant, not a happy-path example).
- `complexity ?? severity` fallback resolves WITHIN `hand_tiers` only. It never cross-resolves to an
  eye-role alias.
- `executor` and `sniper` are forbidden as fixed keys in `model_strategy` (they resolve via
  `hand_tiers`). Having them as fixed keys would bypass the tier routing logic.
