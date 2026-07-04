/**
 * @description Scaffold stub for the real `listWorktrees()` producer that reaper.mjs consumes.
 * Enumerates Cron-A worktrees across every configured project by running
 * `git worktree list --porcelain` per project (via the injected `runGitWorktreeList` seam) and
 * reading each run-lock holder (via the injected `readHolder` seam). NOT YET IMPLEMENTED — this
 * is the RED scaffold; glue-2 fills in the real body against list-worktrees.test.mjs.
 *
 * Expected opts shape:
 *   {
 *     projects: Array<{ project: string, projectRoot: string, stateDir: string }>,
 *     runGitWorktreeList: (projectRoot: string) => string,  // raw `git worktree list --porcelain` stdout
 *     readHolder: (opts: { stateDir: string }) => ({ pid: number, acquire_ts: number, tmux_session_id?: string } | null),
 *     lockDirAgeSeconds?: (opts: { stateDir: string }) => number,
 *     now?: () => number,
 *   }
 *
 * Returned entry shape (one per harness/<n> worktree — the primary/main worktree is excluded):
 *   {
 *     project: string,
 *     projectRoot: string,
 *     worktreePath: string,
 *     branch: string,          // `harness/<n>`
 *     issueNumber: number,     // `<n>`
 *     stateDir: string,
 *     holder: { pid: number, acquire_ts: number, tmux_session_id?: string } | null,
 *     sessionStartedAt?: number,
 *     lockDirAgeSeconds?: number,
 *   }
 * @param {object} opts
 * @returns {Array<object>}
 */
export function listWorktrees(opts) {
  throw new Error("listWorktrees: not yet implemented (RED scaffold)");
}
