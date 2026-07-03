/**
 * @description VPS cron harness — Cron A dispatch phase (task-5). SCAFFOLD STUB — reset after a
 * frozen-test correction (the prior test modeled unreal spawn plumbing: a separate foreground
 * `claude` spawn fed via `stdin`, and a fake tmux returning `{sessionId}` for dispatch to
 * register). The corrected contract now pinned in cron-a-dispatch.test.mjs is:
 *   - `claude -p` runs INSIDE a detached `tmux new-session -d` shell command string — there is
 *     NO separate `claude` child process.
 *   - the issue body is written to a file and redirected into that command's stdin
 *     (`< <bodyfile>`), never interpolated into any argv or command string.
 *   - dispatch itself GENERATES a deterministic, project-scoped tmux session NAME (e.g.
 *     `harness-<project>-<issue>`) and passes it to both `tmux -s <name>` and
 *     `runLock.register(<name>, opts)` — real `tmux` returns no session id to consume.
 * Not implemented yet — throws until the executor builds the real spawn composition against
 * the corrected suite.
 * @param {{ number: number, body: string }} issue - The picked issue.
 * @param {object} opts - Injected seams: project/projectRoot/worktreeRoot/stateDir, the
 *   already-held lock's acquireTs, spawn, runLock.{register,release}, buildScopedEnv, gh,
 *   counter.{increment,read}. See cron-a-dispatch.test.mjs for the exact shape.
 * @returns {void}
 */
export function dispatch(issue, opts) {
  throw new Error("not implemented");
}
