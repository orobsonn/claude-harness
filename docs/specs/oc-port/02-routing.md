# 02 — Model routing

**Phase:** 1  
**Depends on:** 00, 01  
**Implements:** default routing table, schema, dual-eye posts, user reconfiguration skill  
**Out of scope:** agent body text (04), merge algorithm details (07), spawn (06)

---

## 1. Operator default (locked)

**Motor family:** xAI Grok (subscription)  
**Evaluator family:** OpenAI (subscription)  
**No Ollama** in default map.

| Role | Model slug | Effort / notes |
|---|---|---|
| build (orchestrator) | `xai/grok-4.3` | 1M context; session default |
| planner | `xai/grok-4.5` | critical generation |
| plan-reviewer | `xai/grok-4.5` | **always dual** + `openai/gpt-5.5` |
| adversary | `xai/grok-4.5` | **always dual** + `openai/gpt-5.5` |
| compliance | `openai/gpt-5.5` | evaluator |
| security | `openai/gpt-5.5` | evaluator |
| executor low / sniper low | `xai/grok-build-0.1` | hand |
| executor medium / sniper medium | `xai/grok-4.3` | hand |
| executor high / sniper high | `xai/grok-4.5` | hand |
| test-author | `xai/grok-build-0.1` | hand |
| harvester / shipper | `xai/grok-build-0.1` | mechanical |

### Why 4.3 for build, not 4.5

Grok 4.5 is stronger but **500k** context. Orchestration of long FULL loops benefits from **1M** (`grok-4.3` / 4.20 family). Reserve 4.5 for critical judgment/generation posts.

### Dual-eye posts (always)

Mirrors Claude harness: strong primary eye + cross-family at **key posts only**:

- `plan-reviewer`  
- `adversary` (spec / per-task / final as invoked)

Not required by default on every compliance call (cost control). Security may dual later via routing flag.

Mechanism: **two `task` dispatches** (probe-proven), then SHARED merge (policy B). See 07.

---

## 2. `harness.routing.json` (schema sketch)

**Canonical schema path:** `core/shared/schemas/harness-routing.schema.json`  
**Default instance path:** `core/opencode/harness.routing.json`


```json
{
  "$schema": "../../shared/schemas/harness-routing.schema.json",
  "version": 1,
  "roles": {
    "build": { "model": "xai/grok-4.3" },
    "planner": { "model": "xai/grok-4.5" },
    "plan-reviewer": {
      "model": "xai/grok-4.5",
      "dual": [{ "model": "openai/gpt-5.5", "label": "openai" }]
    },
    "adversary": {
      "model": "xai/grok-4.5",
      "dual": [{ "model": "openai/gpt-5.5", "label": "openai" }]
    },
    "compliance": { "model": "openai/gpt-5.5" },
    "security": { "model": "openai/gpt-5.5" },
    "executor": {
      "tiers": {
        "low": { "model": "xai/grok-build-0.1" },
        "medium": { "model": "xai/grok-4.3" },
        "high": { "model": "xai/grok-4.5" }
      }
    },
    "sniper": {
      "tiers": {
        "low": { "model": "xai/grok-build-0.1" },
        "medium": { "model": "xai/grok-4.3" },
        "high": { "model": "xai/grok-4.5" }
      }
    },
    "test-author": { "model": "xai/grok-build-0.1" },
    "harvester": { "model": "xai/grok-build-0.1" },
    "shipper": { "model": "xai/grok-build-0.1" }
  },
  "constraints": {
    "crossFamilyRoles": ["plan-reviewer", "adversary"],
    "requireDualOn": ["plan-reviewer", "adversary"]
  },
  "modelCapabilities": {
    "xai/grok-build-0.1": { "supportsReasoningEffort": false },
    "xai/grok-4.3": { "supportsReasoningEffort": true },
    "xai/grok-4.5": { "supportsReasoningEffort": true },
    "openai/gpt-5.5": { "supportsReasoningEffort": true }
  }
}
```

### Validation rules (shared pure)

- Every role in the fixed role set has a model  
- `requireDualOn` roles have non-empty `dual`  
- `crossFamilyRoles`: primary model provider ≠ dual model provider (parse `provider` from `provider/model`)  
- Unknown keys rejected  
- `supportsReasoningEffort: false` → plugins must NOT set `reasoningEffort` for that model (probe: build returns 400)

---

## 3. How routing applies at runtime (OC)

1. Agent frontmatter `model:` generated or maintained from table (T1 may start with committed frontmatter matching table).  
2. Optional plugin `chat.params`: set effort only if `supportsReasoningEffort`.  
3. CLI `--variant` exists on `opencode run` but **task tool has no model/variant field** (probe) — role model comes from agent definition.  
4. Dual = second agent file OR same role with distinct agent name (`adversary-openai`) dispatched by orchestrator.

---

## 4. User reconfiguration skill

**Name:** `configuring-model-routing`  
**Mode:** interactive primary (asks operator)  
**Does:**

1. Load current `harness.routing.json`  
2. Offer family presets or per-role edits (product language)  
3. Run shared validate  
4. Rewrite routing file + regenerate agent frontmatter / opencode model fields  
5. Never auto-commit secrets  

**Does not:** invent new roles; disable dual on requireDualOn without explicit operator override warning.

---

## 5. Catalog evidence (OC 1.17.18 `opencode models xai`)

Coding-relevant xAI models observed:

- `xai/grok-build-0.1` — tool call, cheaper, **no reasoningEffort**  
- `xai/grok-4.3` — 1M context, tool call  
- `xai/grok-4.5` — 500k context, tool call  
- `xai/grok-4.20-*` — available; multi-agent variant **toolcall false** — do not use as hand  

OpenAI: requires provider auth; slug `openai/gpt-5.5` used by current OC harness frontmatter.

---

## 6. DoD (T1)

- [ ] `core/opencode/harness.routing.json` committed with operator default  
- [ ] Shared validator + tests for schema/constraints/effort flags  
- [ ] Documented generation path to agent frontmatter (script or manual checklist v1)  
- [ ] IMPLEMENTATION-TRACK T1 done  

---

## 7. References

- ADR-001 no Ollama default  
- ADR-003 dual always plan-reviewer + adversary  
- inventory/probe-results (effort, task schema, dual task)  
