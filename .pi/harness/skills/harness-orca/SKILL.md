---
name: harness-orca
description: Use when an operator asks to connect the delivery harness to Orca automation.
---

# harness-orca

Do not claim that the Claude-specific Orca adapter runs Codex.

- Explain that automatic orchestration stays unsupported until an Orca Codex-agent contract and smoke test exist.
- A portable local diagnostic may inspect configuration; it does not grant scheduling authority.
- Prefer a local Codex goal or an externally-owned scheduler with explicit ownership.
- Keep automation credentials and remote control outside agent prompts and memory.

Use `.pi/harness/skills/harness-rules/references/governance-contract.md` for the
honest-residual policy and `.pi/harness/skills/harness-delivery/references/delivery-contract.md` for bounded execution.
