/**
 * @description VPS cron harness — the reaper (task-8). ONE shared cron for the WHOLE VPS (not
 * per project): a single invocation enumerates the Cron-A worktrees across EVERY project and
 * reaps each independently. Per-entry isolation is intentional: a single failing worktree must
 * never abort the shared cron for every other project.
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
 *   - MISSING/CORRUPT holder -> treated as alive (conservative) when the lock directory age is
 *     unknown or within the registration grace window; only treated as a reapable orphan when the
 *     lock directory age is known to be past the registration grace. The worktree and its branch are
 *     pruned only in the orphan case, and no run-lock can be released because the acquire_ts is
 *     unknown.
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
 *       dispatch charges attempts. The lock release is INDEPENDENT of `prExists` — a dead holder
 *       with a PR still has its stale lock released and its worktree/branch cleaned up.
 *   (c) Cleanup — a worktree whose holder is DEAD has its working tree removed via
 *       `opts.gitWorktreeRemove(worktreePath)` and its orphan branch pruned via
 *       `opts.gitBranchDelete(worktree.branch)`. A worktree whose holder is ALIVE (including one
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
 *   holder: { pid: number, acquire_ts: number, tmux_session_id?: string } | null,
 *   sessionStartedAt: number,
 *   lockDirAgeSeconds?: number,
 * }>} opts.listWorktrees - Enumerates every Cron-A worktree across every project in one call.
 * @param {(sessionId: string) => boolean} opts.tmuxHasSession
 * @param {(pid: number) => void} opts.kill - throws (e.g. ESRCH) when the pid is dead.
 * @param {() => number} opts.now - clock, returns epoch seconds.
 * @param {number} [opts.livenessCeilingHours] - default 2.
 * @param {number} [opts.registrationGraceSeconds] - default 120.
 * @param {number} [opts.retryCeilingK] - default 2.
 * @param {(issueNumber: number) => boolean} opts.prExists
 * @param {(issueNumber: number) => string[]} [opts.issueLabels] - returns the current labels for an issue;
 *   used to recognize harness:in-review so the reaper never mistakes it for an orphan.
 * @param {(args: string[]) => { ok: boolean }} opts.gh
 * @param {{ release: (opts: { stateDir: string, acquireTs: number }) => void }} opts.runLock
 * @param {{ read: (issueNumber: number, opts: { stateDir: string }) => number }} opts.counter -
 *   READ-ONLY seam; the reaper never calls an increment/write method on it.
 * @param {(worktreePath: string, projectRoot: string) => void} opts.gitWorktreeRemove
 * @param {(sessionId: string) => void} opts.tmuxKillSession
 * @param {(branch: string, projectRoot: string) => void} [opts.gitBranchDelete] - best-effort prune the orphan
 *   harness/<n> branch after removing a dead holder's worktree. Default: `git -C <projectRoot> branch -D <branch>`
 *   with failures swallowed.
 * @returns {void}
 */
import { spawnSync } from "node:child_process";

const DEFAULT_LIVENESS_CEILING_HOURS = 2;
const DEFAULT_REGISTRATION_GRACE_SECONDS = 120;
const DEFAULT_RETRY_CEILING_K = 2;
const SECONDS_PER_HOUR = 3600;
const LABEL_IN_PROGRESS = "harness:in-progress";
const LABEL_IN_REVIEW = "harness:in-review";
const LABEL_READY = "harness:ready";
const LABEL_BLOCKED = "harness:blocked";

/**
 * @description Best-effort default for pruning an orphan harness/<n> branch. Runs in the
 * target project's repo so the branch name is resolved against the correct repository — the reaper
 * is a shared cron and branch names collide across projects. Errors are swallowed.
 */
function defaultGitBranchDelete(branch, projectRoot) {
  try {
    spawnSync("git", ["-C", projectRoot, "branch", "-D", branch], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // best-effort branch prune
  }
}

/**
 * @description Best-effort default for removing a dead holder's worktree. Runs in the target
 * project's repo for the same cross-project safety as defaultGitBranchDelete. Errors are swallowed.
 */
function defaultGitWorktreeRemove(worktreePath, projectRoot) {
  try {
    spawnSync("git", ["-C", projectRoot, "worktree", "remove", worktreePath], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // best-effort worktree remove
  }
}

/**
 * @description Decides holder liveness with the SAME two-branch rule as run-lock.mjs's acquire()
 * — the reaper never drifts from it. REGISTERED (tmux_session_id present) -> alive iff
 * `tmuxHasSession(id)` alone, launcher pid never consulted. NOT-YET-REGISTERED -> alive iff
 * `kill(pid)` does not throw AND still within the registration grace window. A null/undefined
 * holder is treated as alive (conservative) when its lock directory age is unknown or within the
 * registration grace window; only treated as a reapable orphan (alive=false, holderMissing=true)
 * when the lock directory age is known to be past the grace window.
 * @returns {{ alive: boolean, registered: boolean, holderMissing?: boolean } | null}
 */
function judgeLiveness(holder, opts, lockDirAgeSeconds) {
  if (holder == null) {
    const pastGrace = lockDirAgeSeconds != null && lockDirAgeSeconds >= opts.registrationGraceSeconds;
    return { alive: !pastGrace, registered: false, holderMissing: pastGrace };
  }
  const registered = "tmux_session_id" in holder;
  if (registered) {
    return { alive: Boolean(opts.tmuxHasSession(holder.tmux_session_id)), registered: true };
  }
  let pidAlive = true;
  try {
    opts.kill(holder.pid);
  } catch {
    pidAlive = false;
  }
  const withinGrace = opts.now() - holder.acquire_ts < opts.registrationGraceSeconds;
  return { alive: pidAlive && withinGrace, registered: false };
}

/**
 * @description Crash-recovery path for a worktree whose holder is DEAD: relabels the issue
 * `harness:in-progress` -> `harness:ready` (attempt counter under the retry ceiling) or ->
 * `harness:blocked` (at/over the ceiling) via `opts.gh`, but ONLY when the issue has no
 * open/merged harness PR. The stale run-lock is released regardless of whether a PR exists.
 * `opts.counter` is READ-ONLY — the reaper never increments; only dispatch charges attempts.
 * @returns {boolean} false when the gh relabel failed — the caller must leave the worktree and
 *   lock intact so the next cycle can retry.
 */
function crashRecover(worktree, holder, opts) {
  // in-review issues are owned by the review phase's reconciliation — never relabel,
  // never release the lock, never remove the worktree. The existing !prExists guard
  // already protects the normal case (in-review has a PR), but an explicit skip
  // prevents the edge case where the label lingers after a PR is closed/deleted.
  const labels = opts.issueLabels ? opts.issueLabels(worktree.issueNumber) : [];
  if (labels.includes(LABEL_IN_REVIEW)) return false;

  if (!opts.prExists(worktree.issueNumber)) {
    const count = opts.counter.read(worktree.issueNumber, { stateDir: worktree.stateDir });
    const label = count < opts.retryCeilingK ? LABEL_READY : LABEL_BLOCKED;
    const result = opts.gh([
      "issue",
      "edit",
      String(worktree.issueNumber),
      "--remove-label",
      LABEL_IN_PROGRESS,
      "--add-label",
      label,
    ]);
    if (!result || !result.ok) return false;
  }
  opts.runLock.release({ stateDir: worktree.stateDir, acquireTs: holder.acquire_ts });
  return true;
}

/**
 * @description Per-worktree reaping. Three independent behaviors, never conflated:
 *   - a REGISTERED holder still ALIVE but past the wall-clock ceiling -> watchdog-kill the tmux
 *     session and stop (cleanup/relabel wait for a later cycle that observes the session dead);
 *   - any holder ALIVE and (unregistered, or within the ceiling) -> leave it alone;
 *   - a DEAD holder -> crash-recover (relabel when no PR; release lock always) and remove the
 *     worktree + orphan branch.
 */
function reapWorktree(worktree, opts) {
  const liveness = judgeLiveness(worktree.holder, opts, worktree.lockDirAgeSeconds);
  if (liveness === null) return null;

  if (liveness.alive) {
    if (liveness.registered) {
      const ageSeconds = opts.now() - (worktree.sessionStartedAt ?? worktree.holder.acquire_ts);
      if (ageSeconds >= opts.livenessCeilingHours * SECONDS_PER_HOUR) {
        opts.tmuxKillSession(worktree.holder.tmux_session_id);
        return actionOf(worktree, "watchdog-killed");
      }
    }
    return null;
  }

  if (liveness.holderMissing) {
    opts.gitWorktreeRemove(worktree.worktreePath, worktree.projectRoot);
    opts.gitBranchDelete(worktree.branch, worktree.projectRoot);
    return actionOf(worktree, "orphan-cleaned");
  }

  const relabelOk = crashRecover(worktree, worktree.holder, opts);
  if (!relabelOk) return null;

  opts.gitWorktreeRemove(worktree.worktreePath, worktree.projectRoot);
  opts.gitBranchDelete(worktree.branch, worktree.projectRoot);
  return actionOf(worktree, "crash-recovered");
}

/**
 * @description Additive per-worktree action descriptor the composition root translates into a
 * notification. Carries the entry's OWN project (the reaper is a shared cron over many projects, so
 * the `<project>` prefix must come from the worktree, never a single fleet value).
 * @param {{ project: string, issueNumber: number }} worktree
 * @param {"watchdog-killed"|"crash-recovered"|"orphan-cleaned"} action
 * @returns {{ project: string, issueNumber: number, action: string }}
 */
function actionOf(worktree, action) {
  return { project: worktree.project, issueNumber: worktree.issueNumber, action };
}

export function reaper(opts) {
  const {
    listWorktrees,
    livenessCeilingHours = DEFAULT_LIVENESS_CEILING_HOURS,
    registrationGraceSeconds = DEFAULT_REGISTRATION_GRACE_SECONDS,
    retryCeilingK = DEFAULT_RETRY_CEILING_K,
    gitBranchDelete = defaultGitBranchDelete,
    gitWorktreeRemove = defaultGitWorktreeRemove,
  } = opts;

  const resolved = {
    ...opts,
    livenessCeilingHours,
    registrationGraceSeconds,
    retryCeilingK,
    gitBranchDelete,
    gitWorktreeRemove,
  };

  const actions = [];
  for (const worktree of listWorktrees()) {
    try {
      const action = reapWorktree(worktree, resolved);
      if (action) actions.push(action);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`reaper: failed to process ${worktree.project} ${worktree.worktreePath}: ${message}`);
    }
  }
  return actions;
}
