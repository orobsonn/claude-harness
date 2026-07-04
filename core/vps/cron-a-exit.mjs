/**
 * @description SCAFFOLD STUB — task-6 (cron-a-graceful-exit). Throws until the executor hand
 * implements the real graceful-exit state machine pinned by cron-a-exit.test.mjs.
 *
 * cronAExit is the graceful-exit handler chained AFTER `claude -p` inside the tmux session
 * task-5 spawns (`... ; cron-a-exit <issue> <worktree> <bodyfile> <envfile>`). It fires on the
 * session's OWN termination (success or not) and is exit-handler LOGIC only:
 *   - PR exists on harness/<issue>            -> harness:in-progress -> harness:done
 *   - no PR + a recorded deliberate blocking
 *     finding                                 -> harness:blocked (+ blocking `gh issue comment`)
 *   - no PR, no blocking record, attempt
 *     counter < retryCeilingK                 -> harness:ready (re-queue)
 *   - no PR, no blocking record, attempt
 *     counter >= retryCeilingK                -> harness:blocked (retry ceiling)
 * It is READ-ONLY on the attempt counter (never calls counter.increment — dispatch owns that),
 * except it calls counter.reset() on the done path. It always releases the run-lock and always
 * unlinks bodyFile + envFile (which carry the issue body + scoped secrets) so neither
 * accumulates on the box, on every exit path.
 *
 * @param {number} issueNumber - The issue this session was dispatched for.
 * @param {string} worktree - Absolute path to the per-run worktree (harness/<issueNumber>).
 * @param {string} bodyFile - Absolute path to the issue-body file written by dispatch; unlinked
 *   on every exit path.
 * @param {string} envFile - Absolute path to the scoped-env file written by dispatch; unlinked
 *   on every exit path (carries scoped secrets — must never accumulate on disk).
 * @param {object} opts - Injected seams.
 * @param {(args: string[]) => unknown} opts.gh - Records/executes a `gh` argv
 *   (e.g. `["issue","edit","42","--remove-label","harness:in-progress","--add-label","harness:done"]`
 *   or `["issue","comment","42","--body","<finding>"]`).
 * @param {{ release: (opts: { stateDir: string, acquireTs: number }) => void }} opts.runLock -
 *   The run-lock seam; release() is called exactly once, on every exit path, with
 *   { stateDir, acquireTs }.
 * @param {{
 *   read: (issueNumber: number, opts: { stateDir: string }) => number,
 *   reset: (issueNumber: number, opts: { stateDir: string }) => void,
 *   increment: (issueNumber: number, opts: { stateDir: string }) => void
 * }} opts.counter - Per-issue attempt-counter seam (mirrors cron-state.mjs). cronAExit reads it
 *   to compare against retryCeilingK and calls reset() on the done path; it must NEVER call
 *   increment() on any exit path.
 * @param {(issueNumber: number) => boolean} opts.prExists - Whether a PR was opened on
 *   harness/<issueNumber> for this run.
 * @param {(issueNumber: number) => (string|null|false|undefined)} opts.blockingFinding - Falsy
 *   if the run recorded no deliberate blocking stop; otherwise the finding message to post via
 *   `gh issue comment`.
 * @param {string} opts.stateDir - Shared cron state dir (counter files, run-lock holder file).
 * @param {number} opts.acquireTs - acquire_ts of the run-lock holder this session registered
 *   under (ownership guard passed through to runLock.release).
 * @param {number} [opts.retryCeilingK] - Retry ceiling K (default 2); at/above K with no PR and
 *   no blocking record, the issue is relabeled harness:blocked instead of harness:ready.
 * @returns {void}
 */
export function cronAExit(issueNumber, worktree, bodyFile, envFile, opts) {
  throw new Error("cronAExit: not implemented (task-6 scaffold stub)");
}
