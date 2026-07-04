/**
 * @description The real `listWorktrees()` producer that reaper.mjs consumes. A single call sweeps
 * EVERY configured project (the reaper is one shared cron for the whole VPS): for each project it
 * runs `git worktree list --porcelain` (via the injected `runGitWorktreeList` seam), parses the
 * blank-line-separated porcelain blocks, and keeps ONLY the blocks whose branch is
 * `refs/heads/harness/<n>` — i.e. matches ^harness/(\d+)$. The primary/main worktree (which carries
 * a non-harness branch, typically `main`) and any other non-harness branch are excluded. For each
 * surviving harness worktree it reads the run-lock holder via the injected `readHolder` seam and
 * builds one entry. A project whose porcelain output has only the primary worktree contributes no
 * entries and never throws — an empty/primary-only project is the normal idle state.
 *
 * Both `runGitWorktreeList` and `readHolder` are injected so callers (and tests) can fake git/fs;
 * listWorktrees itself performs no IO.
 *
 * opts shape:
 *   {
 *     projects: Array<{ project: string, projectRoot: string, stateDir: string }>,
 *     runGitWorktreeList: (projectRoot: string) => string,  // raw `git worktree list --porcelain` stdout
 *     readHolder: (opts: { stateDir: string }) => ({ pid: number, acquire_ts: number, tmux_session_id?: string } | null),
 *     lockDirAgeSeconds?: (opts: { stateDir: string }) => number,  // optional; forwarded verbatim onto entries
 *   }
 *
 * Returned entry shape (one per harness/<n> worktree — the primary/main worktree is excluded):
 *   {
 *     project: string,
 *     projectRoot: string,
 *     worktreePath: string,
 *     branch: string,          // `harness/<n>`
 *     issueNumber: number,     // `<n>` as a number
 *     stateDir: string,
 *     holder: { pid: number, acquire_ts: number, tmux_session_id?: string } | null,
 *     lockDirAgeSeconds?: number,  // present only when a lockDirAgeSeconds seam supplies it
 *   }
 * @param {object} opts
 * @returns {Array<object>}
 */
const HARNESS_BRANCH_RE = /^harness\/(\d+)$/;
const REFS_HEADS_PREFIX = "refs/heads/";

/**
 * @description Parses `git worktree list --porcelain` stdout into one record per non-empty block.
 * Each block is blank-line-separated; a block's `worktree <path>` and `branch refs/heads/<name>`
 * lines are extracted. Blocks without both fields (e.g. a detached worktree with no branch line)
 * are dropped — they can never be a harness/<n> worktree.
 * @param {string} stdout
 * @returns {Array<{ worktreePath: string, branchRef: string }>}
 */
function parsePorcelain(stdout) {
  if (!stdout) return [];
  const blocks = stdout.split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let worktreePath = null;
    let branchRef = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        branchRef = line.slice("branch ".length).trim();
      }
    }
    if (worktreePath && branchRef) {
      out.push({ worktreePath, branchRef });
    }
  }
  return out;
}

/**
 * @description Strips the `refs/heads/` prefix from a porcelain branch field, returning the short
 * branch name. A bare branch name (no prefix) is returned unchanged.
 */
function shortBranch(branchRef) {
  return branchRef.startsWith(REFS_HEADS_PREFIX) ? branchRef.slice(REFS_HEADS_PREFIX.length) : branchRef;
}

export function listWorktrees(opts) {
  const { projects, runGitWorktreeList, readHolder, lockDirAgeSeconds } = opts;
  const entries = [];
  for (const project of projects) {
    let stdout;
    try {
      stdout = runGitWorktreeList(project.projectRoot);
    } catch {
      // A project whose git invocation fails is treated as idle for this sweep — the shared cron
      // must never abort every other project because one projectRoot is unreadable.
      continue;
    }
    for (const { worktreePath, branchRef } of parsePorcelain(stdout)) {
      const branch = shortBranch(branchRef);
      const match = HARNESS_BRANCH_RE.exec(branch);
      if (!match) continue; // excludes the primary/main worktree and any non-harness branch
      const issueNumber = Number(match[1]);
      const stateDir = project.stateDir;
      const entry = {
        project: project.project,
        projectRoot: project.projectRoot,
        worktreePath,
        branch,
        issueNumber,
        stateDir,
        holder: null,
      };
      // Per-entry fail-soft: a corrupt lock / invalid JSON / fs error for ONE worktree must never
      // abort the whole shared sweep. The reaper tolerates a null holder; the entry is kept (so a
      // genuinely dead worktree stays visible) and the error path is never leaked.
      try {
        entry.holder = readHolder({ stateDir });
      } catch {
        entry.holder = null;
      }
      if (lockDirAgeSeconds) {
        try {
          entry.lockDirAgeSeconds = lockDirAgeSeconds({ stateDir });
        } catch {
          entry.lockDirAgeSeconds = null;
        }
      }
      entries.push(entry);
    }
  }
  return entries;
}