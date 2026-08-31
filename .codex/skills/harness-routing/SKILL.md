---
name: harness-routing
description: Use when selecting models, reasoning effort, or cost controls for a delivery task.
---

# harness-routing

Resolve the role and complexity before every delegated task:

```sh
node .codex/model-routing.mjs --role <role> --complexity <tier>
```

- Pass emitted model, reasoning effort, sandbox, scope, and expected evidence to native dispatch.
- Luna/low: narrow mechanical inventory; Terra/medium: focused execution and tests.
- Sol/high: planning, review, security, adversarial, or hard implementation.
- xhigh requires sensitive ambiguity or a prior failed gate; unknown work never routes down.

See `.codex/skills/harness-delivery/references/delivery-contract.md` for dispatch
boundaries and `.codex/skills/harness-rules/references/governance-contract.md` for safety.
