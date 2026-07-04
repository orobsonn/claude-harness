/**
 * @description VPS cron harness — Cron A ENTRYPOINT (task-4), the single scheduled job. Flow:
 *   1. Acquire the per-project run-lock ATOMICALLY as the FIRST action, before any `gh` query —
 *      no TOCTOU window where two fires could both query the issue tracker unlocked. If a live
 *      lock is already held (acquire returns acquired:false), skip the project cleanly: no `gh`,
 *      no release (the lock is not ours), no dispatch.
 *   2. Ensure the `harness:blocked` label exists (idempotent `gh label create harness:blocked
 *      --force`) before selecting any issue.
 *   3. Query open `harness:ready` issues, EXCLUDING any also carrying `harness:in-progress` or
 *      `harness:blocked`, and pick the OLDEST eligible one (gh returns oldest-first).
 *   4. No eligible issue -> release the lock and exit WITHOUT calling dispatch (a fire with no
 *      work is a no-op: no relabel, no dispatch, no worktree, no session).
 *   5. Otherwise relabel the picked issue `harness:ready` -> `harness:in-progress` BEFORE any
 *      worktree/session creation, then invoke cron-a-dispatch (task-5), handing it the chosen
 *      issue and the ALREADY-HELD run-lock handle acquire() returned — dispatch never re-acquires,
 *      it only does its phase-2 register().
 *
 * All seams (runLock, gh, dispatch) are injected so the frozen oracle
 * (cron-a-select.test.mjs) runs hermetic — no real git/gh/tmux/process is spawned from here.
 *
 * @param {object} opts
 * @param {string} opts.project
 * @param {string} opts.stateDir
 * @param {object} opts.runLock - { acquire(opts)->{acquired,acquireTs?}, release({stateDir,acquireTs}) }
 * @param {(args: string[]) => any} opts.gh - the `gh` CLI seam
 * @param {(issue: object, lock: object) => any} opts.dispatch - cron-a-dispatch (task-5) seam
 * @param {number} [opts.pid] - caller pid recorded on acquire (default process.pid)
 * @param {() => number} [opts.now] - epoch-seconds clock for acquire (default real)
 * @param {(pid: number) => void} [opts.kill] - liveness probe for acquire (default process.kill)
 * @param {(id: string) => boolean} [opts.tmuxHasSession] - tmux liveness probe for acquire
 * @returns {{ ok: boolean, dispatched?: boolean, issue?: { number: number, labels: string[] } }}
 */
export function cronASelect(opts) {
  const {
    project,
    stateDir,
    runLock,
    gh,
    dispatch,
    pid = process.pid,
    now = () => Math.floor(Date.now() / 1000),
    kill = process.kill,
    tmuxHasSession,
  } = opts;

  // 1) Lock FIRST — before any `gh`, so two concurrent fires can never both query the tracker.
  const lock = runLock.acquire({ stateDir, pid, now, kill, tmuxHasSession });
  if (!lock.acquired) {
    // A live lock is already held elsewhere — skip this project, do not touch gh, do not release
    // (the lock is not ours to release).
    return { ok: true, dispatched: false };
  }

  let dispatched = false;
  try {
    // 2) Ensure the harness:blocked label exists (idempotent) before selecting any issue.
    gh(["label", "create", "harness:blocked", "--force"]);

    // 3) Query open harness:ready issues, then exclude any also carrying harness:in-progress or
    //    harness:blocked — defense-in-depth layer 2 against double-run. gh returns label objects
    //    under --json; tolerate string-shaped labels from tests/fakes as well.
    const issues = gh([
      "issue",
      "list",
      "--label",
      "harness:ready",
      "--state",
      "open",
      "--json",
      // `body` is REQUIRED: cron-a-dispatch writes issue.body to the prompt file it feeds `claude -p`.
      // Without it dispatch writes `undefined` and every real spawn fails on the body write (the unit
      // tests inject a body via fakes, so this only surfaced on the first live run).
      "number,labels,createdAt,body",
    ]);
    const hasLabel = (issue, name) =>
      (issue.labels ?? []).some((label) => (label.name ?? label) === name);
    const eligible = issues
      .filter(
        (issue) =>
          !hasLabel(issue, "harness:in-progress") &&
          !hasLabel(issue, "harness:blocked")
      )
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (ta !== tb) return ta - tb;
        return (a.number ?? 0) - (b.number ?? 0);
      });

    if (eligible.length === 0) {
      // 4) No work this fire — release the held lock and exit without dispatch or relabel.
      runLock.release({ stateDir, acquireTs: lock.acquireTs });
      return { ok: true, dispatched: false };
    }

    const picked = eligible[0];

    // 5) Relabel harness:ready -> harness:in-progress BEFORE any worktree/session is created, so an
    //    interrupted spawn never leaves a parallel fire free to re-pick the same issue. If the relabel
    //    fails, release the lock and leave the issue harness:ready for a clean retry.
    const relabel = gh([
      "issue",
      "edit",
      String(picked.number),
      "--remove-label",
      "harness:ready",
      "--add-label",
      "harness:in-progress",
    ]);
    if (!relabel || relabel.ok !== true) {
      runLock.release({ stateDir, acquireTs: lock.acquireTs });
      return { ok: false, dispatched: false };
    }

    // Hand dispatch the SAME already-held lock handle acquire() returned — dispatch never
    // re-acquires; it only does its phase-2 register() of the tmux session name onto this holder.
    // Mark the handoff committed BEFORE the call: if dispatch throws AFTER spawning/registering,
    // the catch must NOT release — the lock now belongs to the live session; dispatch/register plus
    // the run-lock reclaim own the partial-state cleanup.
    dispatched = true;
    dispatch(picked, lock);

    return { ok: true, dispatched: true, issue: picked };
  } catch (error) {
    // On any error BEFORE a successful dispatch handoff, release the run-lock so the project does
    // not stall until the registration grace reclaims it.
    if (!dispatched) {
      runLock.release({ stateDir, acquireTs: lock.acquireTs });
    }
    throw error;
  }
}