---
name: harness-survey
description: Use when mapping an unfamiliar codebase, runtime, or harness surface before changing it.
---

# harness-survey

Trace real entry points, contracts, ownership, tests, and deployment paths.

- Start from executable entry points and follow imports, data flow, and effects.
- Return a compact source map with confidence, evidence, and unknowns.
- Identify critical boundaries: permissions, secrets, network, persistence, release.
- Do not infer architecture from filenames alone or silently fill gaps from memory.

Apply `.pi/harness/skills/harness-delivery/references/delivery-contract.md` to turn
unknowns into a plan and `.pi/harness/skills/harness-rules/references/governance-contract.md` to flag risks.
