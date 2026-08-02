# Hand spawn pattern (P2) — OC port

**Chosen pattern:** one `mode: all` agent per hand role.

## Why

OpenCode 1.18.8 rejects only `mode: subagent` for `opencode run`; `mode: all` works for both
CLI and in-session Task dispatch. The CLI `--model` option overrides the frontmatter model, while
the Task tool has no model override. A shared agent therefore keeps `model:` as the in-session
source of truth, and the adapter passes the same model explicitly on the CLI path.

## Shared files

`executor-{low,medium,high}.md`, `sniper-{low,medium,high}.md`, and `test-author.md` each serve both
the in-session loop (`task(subagent_type: ...)`) and CLI cheap-hand execution (`opencode run`).

Every shared hand agent MUST have:

- `mode: all`
- `tools.task: false` (hands must not nest task)
- `model:` matching its role/tier in `harness.routing.json`
- `steps: 80` (native fuse forces a terminal text response instead of an unbounded tool loop)
- the hand's `permission:` lockdown

## Rules

1. Use the exact hand role for both paths, for example `executor-high`.
2. The CLI adapter reads the model from that vendored agent and passes `--model <model>`.
3. In-session dispatch reads the same agent's `model:` because Task has no model override.
4. Eyes (`plan-reviewer*`, `adversary*`, `compliance`, `security`, `planner`) are subagent-only — not CLI-spawned as hands.

T7 implements the spawn adapter + capture oracle against these shared hand agents.
