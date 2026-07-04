/**
 * @description VPS cron harness — the reaper (task-8). ONE shared cron for the WHOLE VPS (not
 * per project): a single invocation enumerates the Cron-A worktrees across EVERY project and
 * reaps each independently. This is the CLI's exit-handler-shaped scaffold (throws by design —
 * see below); the executor fills in the real body against the pinned contract in
 * reaper.test.mjs.
 *
 * Per worktree, liveness is decided by the SAME two-branch rule as run-lock.mjs's acquire()
 * (see run-lock.mjs header) — the reaper never re-implements or drifts from that rule:
 *   - REGISTERED holder (holder.tmux_session_id present) -> alive iff
 *     `opts.tmuxHasSession(holder.tmux_session_id)`. The recorded launcher pid is NEVER
 *     consulted once registered — a live tmux session with a dead launcher pid (the expected
 *     steady state: the launcher is an ephemeral process that exits right after spawning the
 *     detached session) is ALIVE, full stop.
 *   - NOT-YET-REGISTERED holder -> alive iff `opts.kill(holder.pid)` does not throw AND
 *     `opts.now() - holder.acquire_ts < opts.registrationGraceSeconds` — an initializing holder
 *     inside its acquire->register window is never mistaken for dead.
 *
 * Three independent behaviors per worktree (never conflated):
 *   (a) Liveness watchdog — a REGISTERED holder whose tmux session is still ALIVE but whose
 *       session has run past the wall-clock ceiling (`opts.now() - <session start> >=
 *       opts.livenessCeilingHours * 3600`, default 2h) is a hung run: kill the session via
 *       `opts.tmuxKillSession(holder.tmux_session_id)`. Nothing else fires this cycle — the
 *       worktree is only cleaned up and the issue only relabeled on a LATER cycle once the
 *       session has actually exited (dead), same as any other crashed run.
 *   (b) Crash recovery — a worktree whose holder is DEAD (by the rule above) and whose issue has
 *       no open/merged harness PR (`opts.prExists(issueNumber)` false) is relabeled
 *       `harness:in-progress` -> `harness:ready` (attempt counter < retryCeilingK, default 2) or
 *       -> `harness:blocked` (counter >= retryCeilingK), via `opts.gh([...])`, and the stale
 *       run-lock is released via `opts.runLock.release({ stateDir, acquireTs: holder.acquire_ts
 *       })`. `opts.counter` is READ-ONLY here (`counter.read`) — the reaper NEVER increments; only
 *       dispatch charges attempts.
 *   (c) Cleanup — a worktree whose holder is DEAD has its working tree removed via
 *       `opts.gitWorktreeRemove(worktreePath)`. A worktree whose holder is ALIVE (including one
 *       merely over the watchdog ceiling, until a later cycle observes it dead) is NEVER removed.
 *
 * @param {object} opts
 * @param {() => Array<{
 *   project: string,
 *   projectRoot: string,
 *   worktreePath: string,
 *   branch: string,
 *   issueNumber: number,
 *   stateDir: string,
 *   holder: { pid: number, acquire_ts: number, tmux_session_id?: string },
 *   sessionStartedAt: number,
 * }>} opts.listWorktrees - Enumerates every Cron-A worktree across every project in one call.
 * @param {(sessionId: string) => boolean} opts.tmuxHasSession
 * @param {(pid: number) => void} opts.kill - throws (e.g. ESRCH) when the pid is dead.
 * @param {() => number} opts.now - clock, returns epoch seconds.
 * @param {number} [opts.livenessCeilingHours] - default 2.
 * @param {number} [opts.registrationGraceSeconds] - default 120.
 * @param {number} [opts.retryCeilingK] - default 2.
 * @param {(issueNumber: number) => boolean} opts.prExists
 * @param {(args: string[]) => { ok: boolean }} opts.gh
 * @param {{ release: (opts: { stateDir: string, acquireTs: number }) => void }} opts.runLock
 * @param {{ read: (issueNumber: number, opts: { stateDir: string }) => number }} opts.counter -
 *   READ-ONLY seam; the reaper never calls an increment/write method on it.
 * @param {(worktreePath: string) => void} opts.gitWorktreeRemove
 * @param {(sessionId: string) => void} opts.tmuxKillSession
 * @returns {void}
 */
export function reaper(_opts) {
  throw new Error("reaper: not implemented (task-8-reaper scaffold — RED by design)");
}
