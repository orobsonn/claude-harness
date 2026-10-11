# Phase 2 — parallel task lanes (global parent protocol)

Load this file when the approved plan carries `"execution": {"parallel": true}`. Each task runs in its
own **lane**: a git worktree on branch `harness/task-<id>-<attempt>` plus one top-level `claude -p`
session that runs Phase 2 steps 1a–6 for that task alone (`references/task-runtime.md` is the lane's
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

Once a task is admitted, spec, plan and classification are frozen: the plan cannot change and the
planner and plan-reviewer can no longer be dispatched. Hands (`test-author`, `executor*`, `sniper*`)
are dispatched only inside lanes.

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
   dispatches and other tasks wait, delivery is blocked and final review and demo are invalidated.
   Reintegrate it. A dependent that is not yet integrated is reconciled by the host (it merges the
   corrected aggregate into the lane, or opens the conflict for the lane's sniper). An integrated
   dependent is reconciled when you `resume` it. To refresh an integrated task on the current
   aggregate, `resume` with `"reconcile_head":"<current HEAD>"` and an instruction. If a correction
   ends with no product delta, `abandon-resume` with `"no_product_obligation":true`, the unchanged
   `expected_head` and a reason; this restores the previous receipt.
6. **Global gates** (Phase 3+) run on the aggregate HEAD after every task is integrated: the
   final dual/triad review, the CI suite and the demo. `git push`, `gh pr create|merge` and
   `Agent(shipper)` are refused until every plan task has a valid integration receipt in HEAD
   ancestry and no correction is open.

Nothing is cleaned up automatically: worktrees, branches and job logs under
`.claude/plans/.state/<session>/task-runs/` are kept for audit and resume.

## Host configuration (operator env, never set per command)

| Env | Effect |
|---|---|
| `CLAUDE_HARNESS_MAX_PARALLEL_TASKS` | 1–3; lowers the parallel limit |
| `CLAUDE_HARNESS_TASK_TIMEOUT_MS` | lane deadline, 1 ms–24 h (default 2 h) |
| `CLAUDE_HARNESS_LANE_MODEL` | lane orchestrator model: `haiku`/`sonnet`/`opus` (default `sonnet`) |
| `CLAUDE_HARNESS_CLAUDE_BIN` | absolute path of the `claude` CLI (default: `claude` on `PATH`) |
