# Phase 2 — parallel task lanes (global parent protocol)

Parallel lanes are the default delivery: load this file when the approved plan carries
`"execution": {"parallel": true}` (a serial plan states its `serial_reason`). Each task runs in its own
**lane**: a git worktree on branch `harness/task-<id>-<attempt>` plus one top-level `claude` session (a
`-p` stream-json run locally; an interactive TUI in its Orca terminal) that runs Phase 2 steps 1a–6 for
that task alone (`references/task-runtime.md` is the lane's
prompt). The host, not the lane, decides when a task is ready: it inspects the lane's native event
stream, the hook ledger and Git, and merges with `--no-ff`. You coordinate. You never implement here,
and you never read a lane's transcript.

## Preconditions (the CLI refuses otherwise, with the exact reason)

- Triage is LIGHT or FULL for this session, and you are on a feature branch with a clean tree.
- The plan passed `validate-plan.mjs` with `execution.parallel` (disjoint scopes for independent
  tasks, `depends_on` everywhere, the claude hand ladder).
- A foreground `Agent(plan-reviewer)` returned exactly one JSON block `{"verdict":"APPROVE",…}` on the
  current plan and spec. The hook records this as host evidence; a `mark.mjs plan-reviewed` echo does
  not count.
- The vendored `.claude/` harness is committed, because each lane runs the copy in its worktree.

Once a task is admitted, spec and classification are frozen, and the plan changes only through the
append-only scope correction in step 7. Hands (`test-author`, `executor*`, `sniper*`) are dispatched
only inside lanes.

## The commands

Run each command **alone**: no env prefix, `cd`, chaining or redirection. Its identity is this
session.

```bash
node .claude/hooks/tasks.mjs dispatch --json '{"task_ids":["task-1","task-2"],"task_contexts":[{"task_id":"task-1","content":"<≤2 KiB curated brief>"}]}'
node .claude/hooks/tasks.mjs wait --json '{"compact":true}'        # Bash timeout: 600000
node .claude/hooks/tasks.mjs status --json '{"task_id":"task-1"}'
node .claude/hooks/tasks.mjs integrate --json '{"task_id":"task-1","attempt_id":"<attempt>","expected_head":"<child_head>"}'
node .claude/hooks/tasks.mjs resume --json '{"task_id":"task-1","attempt_id":"<attempt>","instruction":"<what to fix>"}'
```

When the JSON contains a single quote, use `--json-file .claude/plans/<feature>/run/<name>.json`.

1. **Dispatch** at most 3 tasks per batch (a host env can lower this). All tasks in a batch share
   one base, and each task's `depends_on` must already be integrated. Redispatching a task returns
   its existing handle. `task_contexts` is optional, curated by you, untrusted by the lane, and
   immutable once admitted.
2. **Wait** with `wait`, never with repeated `status`. It blocks on the host for up to 540 s and
   returns `wait: settled|changed|timeout|aborted`. Neither interrupting `wait` nor ending your
   session stops a lane. After you consume a task's `context_return`, use `"compact": true`.
3. **Read the result** in `status`. `ready` carries `child_head` and, outside `compact`, the lane
   diary as `context_return`; curate that into your own `shared_context.md` by hand. `blocked` carries
   `reason` and `diagnostics` (review findings, the lane's report, the launch failure, a dirty tree).
   Fix through `resume` on the same task and attempt, with a concrete `instruction`.
4. **Integrate** each ready task with its exact `attempt_id` and `expected_head`. The host
   re-inspects, refuses conflicts before touching your branch (then `resume` resolves them in the
   lane), keeps frozen tests intact and writes the integration receipt. Then dispatch its dependents.
5. **Corrections after integration**: `resume` an integrated task opens a correction barrier. New
   dispatches and other tasks wait and delivery is blocked. A final review or demo you ran before the
   correction no longer counts: run them again on the corrected aggregate HEAD (the host does not
   track them; it only blocks delivery while the barrier is open). Reintegrate it. A dependent that is not yet integrated is reconciled by the host (it merges the
   corrected aggregate into the lane, or opens the conflict for the lane's sniper). An integrated
   dependent is reconciled when you `resume` it. To refresh an integrated task on the current
   aggregate, `resume` with `"reconcile_head":"<current HEAD>"` and an instruction. If a correction
   ends with no product delta, `abandon-resume` with `"no_product_obligation":true`, the unchanged
   `expected_head` and a reason; this restores the previous receipt.
6. **Global gates** (Phase 3+) run on the aggregate HEAD after every task is integrated: the
   final dual/triad review, the CI suite and the demo. `git push`, `gh pr create|merge` and
   `Agent(shipper)` are refused until every plan task has a valid integration receipt in HEAD
   ancestry and no correction is open.

7. **Scope correction** (a task needs a file outside its `scope_paths`): fold the path into the plan
   deliberately, as in serial delivery; never widen scope in a brief. Wait until no lane runs, then
   dispatch the planner. The gate snapshots the admitted plan and its APPROVE, and denies the
   dispatch with an exact `[HARNESS_PLAN_RECOVERY]` block: copy that block verbatim into the planner
   prompt, plus only the paths to append. The planner may only append to `scope_paths` and
   `allowed_writes` and, when the new path needs its own proof, the minimum new `locked_tests`.
   Existing entries, task IDs, dependencies, behavior and the spec never change. Then a fresh
   `Agent(plan-reviewer)` APPROVE, then `resume` the **same** task and attempt with an instruction
   naming the new path. Grants and receipts keep the admission plan; unaffected tasks keep their
   evidence. An already integrated task whose scope grew loses its evidence until you `resume` and
   reintegrate it. A real behavior change still needs a new session.

**Orca.** When this session runs inside an Orca workspace, every lane is an Orca child worktree of it
and runs as an interactive Claude Code TUI in its own Orca terminal (`status` shows `orca` with the
worktree and terminal handle). `wait` blocks on Orca's native terminal wait. If a
launch reports `warning` (terminal not confirmed visible), reveal that existing handle; never dispatch
again to get a new one. A registry pinned to an Orca workspace launches work only from inside that
workspace.

Nothing is cleaned up automatically. The registry and job logs under
`.claude/plans/.state/<session>/task-runs/`, and the lane worktrees and branches (outside the repo, in
`~/.local/state/claude-harness/task-worktrees/` or `$CLAUDE_HARNESS_TASK_WORKTREES_DIR`), are kept for
audit and resume.

## When lanes cannot run

Lanes need a local `claude` CLI that can start top-level sessions and Git worktrees outside the
repository. Where that is not available (no `claude` on PATH, a restricted or cloud host), the
lane fails and `status` reports the launch failure in its diagnostics; nothing falls back on its own. Re-plan with
`"execution": {"parallel": false, "serial_reason": "<why lanes cannot run here>"}` and deliver
serially (Phase 2 serial).

## Host configuration (operator env, never set per command)

| Env | Effect |
|---|---|
| `CLAUDE_HARNESS_MAX_PARALLEL_TASKS` | 1–3; lowers the parallel limit |
| `CLAUDE_HARNESS_TASK_TIMEOUT_MS` | lane deadline, 1 ms–24 h (default 2 h) |
| `CLAUDE_HARNESS_LANE_MODEL` | lane orchestrator model: `haiku`/`sonnet`/`opus` (default `sonnet`) |
| `CLAUDE_HARNESS_CLAUDE_BIN` | absolute path of the `claude` CLI (default: `claude` on `PATH`) |
