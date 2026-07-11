# Hand spawn pattern (P2) — OC port

**Chosen pattern:** `mode-primary-spawn-agents` (resolved_judgment `hand_spawn_pattern`).

## Why

Probe P2 (OC 1.17.18): `opencode run --agent X` requires agent `mode: primary`.  
If X is `mode: subagent`, OpenCode falls back to the default primary — wrong model and wrong prompt.

## Twin files

| In-session loop (`task` tool) | CLI cheap-hand (`opencode run`) |
|---|---|
| `executor-low.md` `mode: subagent` | `executor-low-spawn.md` `mode: primary` |
| `executor-medium.md` | `executor-medium-spawn.md` |
| `executor-high.md` | `executor-high-spawn.md` |
| `sniper-low.md` | `sniper-low-spawn.md` |
| `sniper-medium.md` | `sniper-medium-spawn.md` |
| `sniper-high.md` | `sniper-high-spawn.md` |
| `test-author.md` | `test-author-spawn.md` |

Every `*-spawn.md` MUST have:

- `mode: primary`
- `tools.task: false` (hands must not nest task)
- same `model` as the subagent twin (from `harness.routing.json`)
- same body / role contract as the twin

## Rules

1. **Never** call `opencode run --agent executor-high` (or any subagent-only hand).
2. Always use the `*-spawn` name for CLI spawn (T7 adapter).
3. In-session loop continues to use exact subagent names via `task(subagent_type: ...)`.
4. Eyes (`plan-reviewer*`, `adversary*`, `compliance`, `security`, `planner`) are subagent-only — not CLI-spawned as hands.

T7 implements the spawn adapter + capture oracle against these primary agents.
