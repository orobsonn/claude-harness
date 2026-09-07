---
name: harness-orca
description: Use when an operator asks to connect the delivery harness to Orca automation.
---

# harness-orca

In Pi, use `harness-task-pipeline`. Start the global Pi Harness parent in its
Orca workspace. `harness_tasks` creates child worktrees at the exact approved Git
base and runs each task parent in its own Orca terminal. The harness owns the
plan, task dependencies, TDD, reviews, receipts and integration. Do not recreate
that workflow as Orca Run/Task/Dispatch objects or launch task writers manually.
Use the returned worktree and terminal handles to observe runs; only a terminal
receipt with `surface: "visible"` confirms UI visibility. A background receipt
must be reported as such. Keep task context selective through `task_contexts`
and curate verified `context_return` facts into the global memory explicitly.

The following limitation applies to Codex, not the Pi task backend:
Do not claim that the Claude-specific Orca adapter runs Codex.

- Explain that automatic orchestration stays unsupported until an Orca Codex-agent contract and smoke test exist.
- A portable local diagnostic may inspect configuration; it does not grant scheduling authority.
- Prefer a local Codex goal or an externally-owned scheduler with explicit ownership.
- Keep automation credentials and remote control outside agent prompts and memory.

Use `.codex/skills/harness-rules/references/governance-contract.md` for the
honest-residual policy and `.codex/skills/harness-delivery/references/delivery-contract.md` for bounded execution.
