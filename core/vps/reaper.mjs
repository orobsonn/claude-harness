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
 *   (d) Completed sweep — a worktree whose run-lock was RELEASED NORMALLY (holder null AND no
 *       readable lock directory age, i.e. `lockDirAgeSeconds == null` covering both null and the
 *       undefined production shape) is the only state (a)-(c) misclassify as "alive (conservative)".
 *       This branch is entered ONLY by the explicit `holder == null && lockDirAgeSeconds == null`
 *       check at the call site — NEVER routed via the liveness verdict, which returns the identical
 *       {alive:true,registered:false} shape for a live UNREGISTERED holder still inside the
 *       registration grace (a run mid-dispatch). Own-session guard first (never prune while the
 *       run's own `harness-<project>-<issue>` tmux session is alive), then four tri-state probes
 *       (issueClosed, prMerged, branchMerged, inspectWorktree) — any null, evaluated BEFORE the
 *       safe-signal disjunction, skips the prune entirely (fail-closed under uncertainty). Safe
 *       removal (workPreserved && concluded && !prOpen) force-removes the worktree and prunes the
 *       orphan branch, returning 'completed-cleaned'; unsafe removal records the unmerged commits
 *       on the descriptor BEFORE a non-force removal and KEEPS the branch. issueClosed NEVER
 *       authorizes a branch deletion; prOpen===false is load-bearing (cron-a-dispatch's resume probe
 *       reads the LOCAL ref, so deleting the branch of a still-open PR orphans its commits).
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
 * @param {(issueNumber: number, project: string) => boolean} opts.prExists
 * @param {(issueNumber: number) => string[]} [opts.issueLabels] - returns the current labels for an issue;
 *   used to recognize harness:in-review so the reaper never mistakes it for an orphan.
 * @param {(args: string[], project: string) => { ok: boolean }} opts.gh
 * @param {{ release: (opts: { stateDir: string, acquireTs: number }) => void }} opts.runLock
 * @param {{ read: (issueNumber: number, opts: { stateDir: string }) => number }} opts.counter -
 *   READ-ONLY seam; the reaper never calls an increment/write method on it.
 * @param {(worktreePath: string, projectRoot: string) => void} opts.gitWorktreeRemove
 * @param {(sessionId: string) => void} opts.tmuxKillSession
 * @param {(branch: string, projectRoot: string) => void} [opts.gitBranchDelete] - best-effort prune the orphan
 *   harness/<n> branch after removing a dead holder's worktree. Default: `git -C <projectRoot> branch -D <branch>`
 *   with failures swallowed.
 * @param {(issueNumber: number, project: string) => boolean | null} [opts.issueClosed] - completed-sweep tri-state probe (true/false/null).
 *   null = unknown -> the sweep fails closed (skip the prune). Required only for the completed sweep (behavior d);
 *   absent seams throw inside the per-worktree try/catch and the worktree is left alone (never-prune).
 * @param {(issueNumber: number, project: string) => boolean | null} [opts.prMerged] - completed-sweep tri-state probe. The load-bearing
 *   merged signal under squash-merge (the merged branch is NOT an ancestor of main, so branchMerged is false for
 *   legitimately merged work). prMerged===true alone satisfies both workPreserved and concluded.
 * @param {(branch: string, projectRoot: string) => boolean | null} [opts.branchMerged] - completed-sweep tri-state
 *   probe (git merge-base --is-ancestor mapped to true/false/null where null = exit 128 / unknown).
 * @param {(worktree: object) => { unmergedCommits: string[], dirtyPaths: string[] } | null} [opts.inspectWorktree] -
 *   completed-sweep tri-state probe. unmergedCommits.length===0 satisfies workPreserved (work provably preserved).
 * @param {(issueNumber: number, project: string) => boolean} [opts.prOpen] - completed-sweep open-PR gate. prOpen===false is REQUIRED
 *   for a safe (force + branch-delete) removal; a still-open PR falls to the keep-branch path so
 *   cron-a-dispatch's local-ref resume probe does not orphan the PR's commits on re-dispatch.
 * @param {() => Array<{ metaPath: string, meta: object }>} [opts.listObsRuns] - zero-arg producer of pre-read
 *   obs-<issue>.json runs to sweep for orphan topic closes (decoupled from the per-worktree holder-liveness
 *   scan). Each entry is { metaPath, meta } where meta is the already-parsed obs-<issue>.json. The composition
 *   root wires the real readdir+readMeta enumeration; reaper.mjs never touches fs directly.
 * @param {() => Array<string>} [opts.liveWorktreePaths] - zero-arg producer of the live worktree paths. A run
 *   whose meta.worktreePath is present here is LIVE — its topic is never closed by the orphan sweep.
 *   Decoupled from listWorktrees so the orphan sweep composes with the holder-liveness scan without
 *   conflating the two.
 * @param {(input: { threadId: number|string }, opts: object) => Promise<{ ok: boolean }>} [opts.closeForumTopic] -
 *   token-bound (upstream) forum-topic close seam. Fire-and-forget by the sweep: the returned promise is
 *   collected into topicCloses so the composition root can await it before the process exits.
 * @param {(metaPath: string, partial: object) => void} [opts.updateMeta] - obs-outbox updateMeta; the SOLE writer
 *   of status:'closed' for an orphan run (never a bespoke JSON rewrite).
 * @returns {Array<object>} the per-worktree action descriptors. The array also carries a
 *   `topicCloses` property (Array<Promise>) — the orphan topic-close promises the composition root
 *   awaits before exit. Attached as a property so the array return contract stays byte-stable.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const DEFAULT_LIVENESS_CEILING_HOURS = 2;
const DEFAULT_REGISTRATION_GRACE_SECONDS = 120;
const DEFAULT_RETRY_CEILING_K = 2;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_HARD_CAP_DAYS = 30;
const DEFAULT_MAX_DELETIONS = 3;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

/**
 * @description Injectable clock seam returning epoch SECONDS — matches run-cron-review.mjs's
 * `Math.floor(Date.now()/1000)`. Stamped as `closedAt` on the optimistic close so the retention
 * sweep can measure age; NEVER raw Date.now() milliseconds (a ms value passes Number.isFinite and
 * breaks the age gate). Default is the real clock; reaper() threads `opts.now` through, tests inject
 * a fixed value.
 */
const defaultNow = () => Math.floor(Date.now() / 1000);
const LABEL_IN_PROGRESS = "harness:in-progress";
const LABEL_IN_REVIEW = "harness:in-review";
const LABEL_READY = "harness:ready";
const LABEL_BLOCKED = "harness:blocked";

/**
 * @description Canonicalizes a worktree path via realpathSync so a symlink in worktreeRoot cannot
 * make a LIVE run's meta.worktreePath (a join() string) differ from the git-worktree-list path
 * (realpath-canonicalized) and get its topic closed by the orphan sweep. A missing path (the orphan
 * side, or a test's /fake/... path that does not exist on disk) falls back to the raw string —
 * preserving the frozen test's path-based seam contract byte-for-byte.
 * @param {string} p
 * @returns {string}
 */
function normalizeWorktreePath(p) {
  if (typeof p !== "string" || !p) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @description Best-effort default for pruning an orphan harness/<n> branch. Runs in the
 * target project's repo so the branch name is resolved against the correct repository — the reaper
 * is a shared cron and branch names collide across projects. Errors are swallowed.
 */
function defaultGitBranchDelete(branch, projectRoot) {
  try {
    spawnSync("git", ["-C", projectRoot, "branch", "-D", "--", branch], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // best-effort branch prune
  }
}

/**
 * @description Best-effort default for removing a dead holder's worktree. Runs in the target
 * project's repo for the same cross-project safety as defaultGitBranchDelete. Errors are swallowed.
 */
function defaultGitWorktreeRemove(worktreePath, projectRoot, opts) {
  try {
    const argv = ["-C", projectRoot, "worktree", "remove"];
    if (opts && opts.force) argv.push("--force");
    argv.push("--", worktreePath);
    spawnSync("git", argv, { encoding: "utf8", stdio: "pipe" });
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

  if (!opts.prExists(worktree.issueNumber, worktree.project)) {
    const count = opts.counter.read(worktree.issueNumber, { stateDir: worktree.stateDir });
    const label = count < opts.retryCeilingK ? LABEL_READY : LABEL_BLOCKED;
    const result = opts.gh(
      [
        "issue",
        "edit",
        String(worktree.issueNumber),
        "--remove-label",
        LABEL_IN_PROGRESS,
        "--add-label",
        label,
      ],
      worktree.project
    );
    if (!result || !result.ok) return false;
  }
  opts.runLock.release({ stateDir: worktree.stateDir, acquireTs: holder.acquire_ts });
  return true;
}

/**
 * @description Completed sweep (behavior d) for a worktree whose run-lock was released NORMALLY
 *   (holder null, no readable lock age). Guards in order:
 *   (1) entry is the caller's explicit `holder == null && lockDirAgeSeconds == null` check — this
 *       function is never reached via the liveness verdict;
 *   (2) own-session guard — never prune while the run's own `harness-<project>-<issue>` tmux session
 *       is alive (a null holder plus a live own session is treated as live);
 *   (3) four tri-state probes (issueClosed, prMerged, branchMerged, inspectWorktree) — ANY null,
 *       evaluated BEFORE the safe-signal disjunction, skips the prune entirely (fail-closed under
 *       uncertainty);
 *   (4) workPreserved = prMerged===true OR branchMerged===true OR inspectWorktree.unmergedCommits
 *       .length===0 (issueClosed NEVER authorizes a branch deletion);
 *   (5) concluded = issueClosed===true OR prMerged===true;
 *   (6) prOpen===false required for a safe removal.
 *   Safe removal (workPreserved && concluded && !prOpen) records the dirty/untracked inventory then
 *   `gitWorktreeRemove(path, root, { force: true })` + `gitBranchDelete(branch, root)`, returning
 *   'completed-cleaned'. Unsafe removal records the unmerged commits on the descriptor BEFORE a
 *   non-force `gitWorktreeRemove(path, root)` and KEEPS the branch (deletion of a worktree whose
 *   branch has unmerged work, or whose PR is still open, would orphan commits). Consumes only
 *   injected seams; the only IO is the structured console.warn record written to the cron log BEFORE
 *   each destructive git call (the #ac-1.1/#ac-1.3 obligation) — no fs, no network.
 * @returns {{ project: string, issueNumber: number, action: string } | null} the action descriptor,
 *   or null when the prune is skipped (live own session, or a null probe failing closed).
 */
function reapCompletedWorktree(worktree, opts) {
  const ownSession = `harness-${worktree.project}-${worktree.issueNumber}`;
  if (opts.tmuxHasSession(ownSession)) return null;

  const issueClosedResult = opts.issueClosed(worktree.issueNumber, worktree.project);
  const prMergedResult = opts.prMerged(worktree.issueNumber, worktree.project);
  const branchMergedResult = opts.branchMerged(worktree.branch, worktree.projectRoot);
  const inspection = opts.inspectWorktree(worktree);

  // Fail closed under uncertainty: a null from ANY probe short-circuits BEFORE the safe-signal
  // disjunction — prMerged===true alone must NOT authorize a prune when branchMerged is unknown.
  if (
    issueClosedResult == null ||
    prMergedResult == null ||
    branchMergedResult == null ||
    inspection == null
  ) {
    return null;
  }

  // Fail closed on a malformed inspection: a non-null but partial inspection (e.g. `{}` or
  // `{ unmergedCommits: null }`) must NOT coerce to length===0 (workPreserved===true) — that would
  // force-remove the worktree and `git branch -D` a branch that may hold unpushed local-only commits.
  if (!Array.isArray(inspection.unmergedCommits) || !Array.isArray(inspection.dirtyPaths)) {
    return null;
  }

  const unmergedCommits = inspection.unmergedCommits;
  const dirtyPaths = inspection.dirtyPaths;
  const workPreserved =
    prMergedResult === true || branchMergedResult === true || unmergedCommits.length === 0;
  const concluded = issueClosedResult === true || prMergedResult === true;
  const prOpenResult = opts.prOpen(worktree.issueNumber, worktree.project);

  if (workPreserved && concluded && prOpenResult === false) {
    // Safe removal: the work is preserved AND the run is concluded AND no PR is still open. Record
    // the dirty/untracked inventory on the descriptor, then force-remove (a dirty/untracked
    // worktree refuses a plain `git worktree remove`) and prune the orphan branch.
    // why #ac-1.1: record the discarded working-tree inventory BEFORE the destructive force-remove
    // so uncommitted work never disappears silently — the mitigation that justifies an unattended
    // destructive cron. Structured single-line JSON on stderr (the cron log), nothing beyond these
    // fields.
    console.warn(
      JSON.stringify({
        op: "reaper.completed-cleaned",
        project: worktree.project,
        issue: worktree.issueNumber,
        worktreePath: worktree.worktreePath,
        dirtyPaths,
      })
    );
    opts.gitWorktreeRemove(worktree.worktreePath, worktree.projectRoot, { force: true });
    opts.gitBranchDelete(worktree.branch, worktree.projectRoot);
    return { ...actionOf(worktree, "completed-cleaned"), dirtyPaths };
  }

  // Unsafe removal: the work is not provably preserved, or the run is not concluded, or a PR is
  // still open. Record the unmerged commits on the descriptor BEFORE the non-force removal so the
  // work is never lost silently, then remove WITHOUT force (a dirty worktree is deliberately left
  // intact by `git worktree remove`) and KEEP the branch for the next attempt.
  // why #ac-1.3: record the unmerged commits BEFORE the destructive removal so unmerged work never
  // disappears silently — the mitigation that justifies an unattended destructive cron. Structured
  // single-line JSON on stderr (the cron log), nothing beyond these fields.
  const descriptor = { ...actionOf(worktree, "keep-branch"), unmergedCommits };
  console.warn(
    JSON.stringify({
      op: "reaper.keep-branch",
      project: worktree.project,
      issue: worktree.issueNumber,
      worktreePath: worktree.worktreePath,
      unmergedCommits,
    })
  );
  opts.gitWorktreeRemove(worktree.worktreePath, worktree.projectRoot);
  return descriptor;
}

/**
 * @description Per-worktree reaping. Four independent behaviors, never conflated:
 *   - a RELEASED-LOCK worktree (holder null AND no readable lock age) -> completed sweep (behavior d);
 *   - a REGISTERED holder still ALIVE but past the wall-clock ceiling -> watchdog-kill the tmux
 *     session and stop (cleanup/relabel wait for a later cycle that observes the session dead);
 *   - any other holder ALIVE and (unregistered, or within the ceiling) -> leave it alone;
 *   - a DEAD holder -> crash-recover (relabel when no PR; release lock always) and remove the
 *     worktree + orphan branch.
 */
function reapWorktree(worktree, opts) {
  // Behavior (d) — completed sweep. Entered ONLY by the explicit released-lock check at the call
  // site, NEVER via the liveness verdict: judgeLiveness returns the identical {alive:true,
  // registered:false} shape for this null-holder case AND for a live UNREGISTERED holder inside the
  // registration grace (a run mid-dispatch). Loose `== null` covers the undefined production shape
  // (listWorktreesSeam never wires lockDirAgeSeconds), so a strict === null guard would pass every
  // null-fixture yet be permanently dead in production.
  if (worktree.holder == null && worktree.lockDirAgeSeconds == null) {
    return reapCompletedWorktree(worktree, opts);
  }

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
 * @param {"watchdog-killed"|"crash-recovered"|"orphan-cleaned"|"completed-cleaned"|"keep-branch"} action
 * @returns {{ project: string, issueNumber: number, action: string }}
 */
function actionOf(worktree, action) {
  return { project: worktree.project, issueNumber: worktree.issueNumber, action };
}

/**
 * @description Orphan forum-topic sweep (task-9). Decoupled from the per-worktree holder-liveness
 * scan above: reads pre-enumerated obs-<issue>.json runs and closes the topic for any run whose
 * worktree is NO LONGER a live worktree (meta status 'active' AND worktreePath absent from the live
 * worktree list). No double-close: a run already 'closed' is skipped. A live run (worktree present)
 * is NEVER closed. The closeForumTopic token is bound upstream (composition root); the sweep calls
 * it fire-and-forget and collects the returned promise into topicCloses so mainReaper can await it
 * before exit. status:'closed' is written via the CANONICAL obs-outbox updateMeta seam — never a
 * bespoke JSON rewrite. Fail-open: a close/update failure never blocks the sweep.
 * @param {object} opts - resolved opts (spread ...opts like the existing seams).
 * @returns {Array<Promise>} close promises for mainReaper to await.
 */
function sweepOrphanTopics(opts) {
  const { listObsRuns, liveWorktreePaths, closeForumTopic, updateMeta, prOpen, now = defaultNow } = opts;
  const topicCloses = [];
  if (
    typeof listObsRuns !== "function" ||
    typeof liveWorktreePaths !== "function" ||
    typeof closeForumTopic !== "function" ||
    typeof updateMeta !== "function"
  ) {
    return topicCloses;
  }

  let livePaths;
  try {
    // realpath-canonicalize each live path so a symlink in worktreeRoot cannot make a LIVE run's
    // meta.worktreePath (a join() string) differ from the git-worktree-list path and get its topic
    // closed. A missing path (the orphan side, or a test's /fake/... path) falls back to the raw
    // string — preserving the frozen test's path-based seam contract byte-for-byte.
    livePaths = new Set((liveWorktreePaths() ?? []).map(normalizeWorktreePath));
  } catch {
    return topicCloses;
  }
  let runs;
  try {
    runs = listObsRuns();
  } catch {
    return topicCloses;
  }

  for (const run of runs) {
    try {
      const meta = run && run.meta;
      if (!meta) continue;
      if (meta.status === "closed") continue; // no double-close
      if (meta.threadId == null) continue; // no forum topic was created — nothing to close
      // A run whose own `harness-<project>-<issue>` tmux session is alive is LIVE, even if its worktree is
      // not yet in `git worktree list` (setupObservability creates the meta BEFORE `git worktree add`).
      // Closing it here would strand a live run's topic and, after the retention window, delete it.
      const ownSession = `harness-${meta.project}-${meta.issueNumber}`;
      if (typeof opts.tmuxHasSession === "function" && opts.tmuxHasSession(ownSession)) continue;
      if (livePaths.has(normalizeWorktreePath(meta.worktreePath))) continue; // a live run's topic is never closed
      // Open-PR gate (#ac-1.2): a run whose PR is still OPEN is mid-review — its topic must NEVER be
      // swept. Only a NOT-open PR (merged-but-close-missed OR abandoned) proceeds to close (#ac-1.6).
      // When prOpen is not wired the gate is skipped (production always wires it via the composition
      // root's makeDefaultPrOpen — see run-reaper.mjs); the sweep then falls back to its pre-feature
      // close semantics rather than crash.
      if (typeof prOpen === "function" && prOpen(meta.issueNumber, meta.project)) continue;
      // H6: capture the PRIOR status BEFORE the optimistic close so a failed close reverts to the
      // run's actual prior state (e.g. 'awaiting-review'), never the hardcoded literal 'active'.
      const priorStatus = meta.status;
      const closePromise = closeForumTopic({ threadId: meta.threadId });
      if (closePromise && typeof closePromise.then === "function") {
        topicCloses.push(closePromise);
      }
      // Optimistic 'closed' (synchronous). The fire-and-forget sweep cannot await the close ack the
      // way cron-a-exit's async notifyExit does, so we mirror its ok-gate by REVERTING to the
      // captured priorStatus when the ack is missing/failed: a transient 429/timeout leaves the run
      // back where it was for the next cycle to retry instead of a permanent on-disk 'closed'
      // orphan. The frozen orphan-sweep test pins the synchronous 'closed' write (its close fake
      // resolves {ok:true} -> no revert). closedAt is stamped in epoch SECONDS via the injected now()
      // seam so the retention sweep can measure age; on revert it is cleared to null so no fossil
      // survives a failed close (a lingering closedAt on a non-closed run would either delete a live
      // topic or skew retention). status:'closed' is preserved alongside closedAt — the test asserts
      // partial.status==='closed'.
      updateMeta(run.metaPath, { status: "closed", closedAt: now() });
      if (closePromise && typeof closePromise.then === "function") {
        closePromise
          .then((r) => {
            if (!r || !r.ok) updateMeta(run.metaPath, { status: priorStatus, closedAt: null });
          })
          .catch(() => {
            updateMeta(run.metaPath, { status: priorStatus, closedAt: null });
          });
      }
    } catch {
      // fail-open: one orphan's close failure never blocks the rest of the sweep
    }
  }
  return topicCloses;
}

/**
 * @description Captures the immutable identity tuple used for CAS compare-and-swap and for re-read
 * divergence checks before every irreversible step. Only primitive fields: a reference field would
 * make the CAS permanently false and silently disable deletion forever.
 * @param {object} meta
 * @returns {{ status: *, closedAt: *, threadId: *, chatId: * }}
 */
function captureIdentity(meta) {
  return {
    status: meta.status,
    closedAt: meta.closedAt,
    threadId: meta.threadId,
    chatId: meta.chatId,
  };
}

/**
 * @description Strict compare of the captured identity against a freshly re-read meta. Any divergence
 * aborts the current irreversible step. String() normalization is intentionally NOT used: a concurrent
 * writer that changes a number to its string representation is still a mutation we must treat as a
 * divergence and fail closed on.
 * @param {object|null} fresh
 * @param {{ status: *, closedAt: *, threadId: *, chatId: * }} identity
 * @returns {boolean}
 */
function identityMatches(fresh, identity) {
  return (
    fresh != null &&
    fresh.status === identity.status &&
    fresh.closedAt === identity.closedAt &&
    fresh.threadId === identity.threadId &&
    fresh.chatId === identity.chatId
  );
}

/**
 * @description True only when every event classified as critical by the injected predicate already has
 * its positional index recorded in meta.criticalSent. Unconditional: no retention cap relaxes this.
 * @param {object[]} events
 * @param {Set<number>} criticalSent
 * @param {(event: object) => boolean} isCriticalEvent
 * @returns {boolean}
 */
function allCriticalsAcked(events, criticalSent, isCriticalEvent) {
  for (let i = 0; i < events.length; i++) {
    if (isCriticalEvent(events[i]) && !criticalSent.has(i)) return false;
  }
  return true;
}

/**
 * @description Fail-closed deletability gate for one candidate. All conditions must hold; any missing
 * or uncertain signal skips the candidate. The cosmetic outbox-drain gate (cursor >= events.length) is
 * relaxed ONLY when the run is older than the hard cap.
 * @param {{ meta: object, events: object[] }} candidate
 * @param {object} opts
 * @param {Set<string>} blocklist
 * @returns {boolean}
 */
function isDeletable(candidate, opts, blocklist) {
  const { meta } = candidate;
  const { resolvedChatId, retentionDays, hardCapDays, now, prOpen } = opts;

  if (meta.status !== "closed") return false;
  if (!Number.isFinite(meta.closedAt)) return false;

  const age = now() - meta.closedAt;
  // An irreversible delete must never widen its own window. A destructuring default only guards
  // `undefined`; Number(null) and Number("") are both 0, which would silently mean "no retention".
  if (retentionDays == null || retentionDays === "") return false;
  const retentionSeconds = Number(retentionDays) * SECONDS_PER_DAY;
  if (!Number.isFinite(retentionSeconds) || retentionSeconds <= 0) return false;
  if (age <= retentionSeconds) return false;

  if (!("chatId" in meta) || String(meta.chatId) !== String(resolvedChatId)) return false;
  if (meta.threadId == null) return false;
  if (blocklist.has(String(meta.threadId))) return false;

  if (typeof prOpen !== "function") return false;
  try {
    if (prOpen(meta.issueNumber, meta.project) === true) return false;
  } catch {
    return false;
  }

  const criticalSent = new Set(Array.isArray(meta.criticalSent) ? meta.criticalSent : []);
  if (!allCriticalsAcked(candidate.events, criticalSent, opts.isCriticalEvent)) return false;

  // A hard cap we cannot trust must never relax the drain gate — same Number(null)===0 trap.
  const hardCapValid = hardCapDays != null && hardCapDays !== "" && Number.isFinite(Number(hardCapDays)) && Number(hardCapDays) > 0;
  const pastHardCap = hardCapValid && age > Number(hardCapDays) * SECONDS_PER_DAY;
  const cursor = typeof meta.cursor === "number" ? meta.cursor : 0;
  if (cursor < candidate.events.length && !pastHardCap) return false;

  return true;
}

/**
 * @description Idempotent per-chatId tally helper. Mutates the shared tally object so the caller can
 * read it after awaiting the returned promises.
 * @param {Record<string, {attempted:number, deleted:number}>} tally
 * @param {string} chatIdKey
 * @param {"attempted"|"deleted"} field
 */
function incrementTally(tally, chatIdKey, field) {
  if (!tally[chatIdKey]) tally[chatIdKey] = { attempted: 0, deleted: 0 };
  tally[chatIdKey][field] += 1;
}

/**
 * @description Performs the destructive delete + CAS-stamp + ordered unlink chain for a single
 * eligible candidate. Wrapped in a promise so the sweep can return immediately and the caller can
 * await completion. Every irreversible step is preceded by an identity re-read (or a CAS that itself
 * re-reads). Fail-open: any error aborts only this candidate.
 * @param {{ metaPath: string, meta: object }} candidate
 * @param {{ status: *, closedAt: *, threadId: *, chatId: * }} identity
 * @param {boolean} hasTopicDeletedAt
 * @param {object} opts
 * @param {Record<string, {attempted:number, deleted:number}>} tally
 * @returns {Promise<void>}
 */
async function deleteCandidate(candidate, identity, hasTopicDeletedAt, opts, tally) {
  const { metaPath } = candidate;
  const { deleteForumTopic, updateMetaIfUnchanged, readMeta, unlinkRunFiles, now } = opts;
  const chatIdKey = String(identity.chatId);
  let deleteFailedTransient = false;

  try {
    if (!hasTopicDeletedAt) {
      const freshBeforeDelete = readMeta(metaPath);
      if (!identityMatches(freshBeforeDelete, identity)) return;
    }

    let deleteResult;
    if (!hasTopicDeletedAt) {
      try {
        deleteResult = await deleteForumTopic({ threadId: identity.threadId });
      } catch {
        deleteFailedTransient = true;
        return;
      }
      if (!deleteResult.ok && deleteResult.reason !== "thread-not-found") {
        deleteFailedTransient = true;
        return;
      }
    }

    const casExpected = captureIdentity(identity);
    const casPartial = { topicDeletedAt: now() };
    let casOk;
    try {
      casOk = updateMetaIfUnchanged(metaPath, casExpected, casPartial);
    } catch {
      casOk = false;
    }
    if (!casOk) return;

    // `deleted` measures "retention is progressing" — an API delete, an already-gone topic,
    // or a resumed CAS-stamped run all indicate the Telegram side is gone and local unlink can proceed.
    incrementTally(tally, chatIdKey, "deleted");

    const freshBeforeEventsUnlink = readMeta(metaPath);
    if (!identityMatches(freshBeforeEventsUnlink, identity)) return;
    try {
      if (!unlinkRunFiles(metaPath, { what: "events" })) return;
    } catch {
      return;
    }

    const freshBeforeMetaUnlink = readMeta(metaPath);
    if (!identityMatches(freshBeforeMetaUnlink, identity)) return;
    try {
      unlinkRunFiles(metaPath, { what: "meta" });
    } catch {
      return;
    }
  } catch {
    // any unexpected error before deleteForumTopic (e.g. readMeta throw) leaves deleteFailedTransient
    // false and therefore does NOT count toward attempted.
  } finally {
    if (deleteFailedTransient) incrementTally(tally, chatIdKey, "attempted");
  }
}

/**
 * @description Retention sweep: DELETES (irreversibly) the forum topic of a run closed for longer than
 * the retention window, then unlinks the run's records. Every IO is an injected seam; every uncertainty
 * fails closed (skip the candidate).
 *
 * Candidates arrive as { metaPath, meta, events } where events were pre-read by the composition root.
 * The sweep itself never reads the events log. A candidate is deletable only when status==='closed',
 * closedAt is finite and past retentionDays, chatId matches resolvedChatId, threadId is not in the
 * shared blocklist, prOpen(issue)!==true, every critical event index is in meta.criticalSent, and
 * either the cosmetic cursor has reached events.length OR the run is past the hardCapDays. The identity
 * tuple (status, closedAt, threadId, chatId) is re-read and re-compared before deleteForumTopic and
 * before each unlink; the same tuple is the CAS expected when stamping topicDeletedAt.
 *
 * No-op guard: if any retention seam is not a function the sweep returns empty immediately, calling
 * nothing. This keeps frozen reaper.test.mjs / run-crons.test.mjs green when reaper() is invoked without
 * the retention seams.
 *
 * @param {object} opts
 * @param {() => Array<{ metaPath: string, meta: object, events: object[] }>} opts.listStaleRuns
 * @param {(input: { threadId: number|string }) => Promise<{ ok: boolean, reason?: string }>} opts.deleteForumTopic
 * @param {(metaPath: string, expected: object, partial: object) => boolean} opts.updateMetaIfUnchanged
 * @param {(metaPath: string) => object|null} opts.readMeta
 * @param {(metaPath: string, { what: 'events' | 'meta' }) => boolean} opts.unlinkRunFiles
 * @param {(issueNumber: number, project: string) => boolean} opts.prOpen
 * @param {(event: object) => boolean} opts.isCriticalEvent
 * @param {() => number} [opts.now] - epoch seconds
 * @param {number|string} opts.resolvedChatId
 * @param {Array<number|string>} opts.sharedThreadIds
 * @param {number} [opts.retentionDays=7]
 * @param {number} [opts.hardCapDays=30]
 * @param {number} [opts.maxDeletions=3] - caps Telegram `deleteForumTopic` calls per cycle; resumed
 *   candidates (already stamped with `topicDeletedAt`) only perform local unlinks and are NOT counted.
 * @returns {{ retentionDeletes: Array<Promise>, retentionTally: Record<string, {attempted:number, deleted:number}> }}
 */
export function sweepStaleClosedTopics(opts) {
  const {
    listStaleRuns,
    deleteForumTopic,
    updateMetaIfUnchanged,
    readMeta,
    unlinkRunFiles,
    prOpen,
    isCriticalEvent,
    now = defaultNow,
    resolvedChatId,
    sharedThreadIds,
    retentionDays = DEFAULT_RETENTION_DAYS,
    hardCapDays = DEFAULT_HARD_CAP_DAYS,
    maxDeletions = DEFAULT_MAX_DELETIONS,
  } = opts;

  const resolvedOpts = {
    ...opts,
    now,
    retentionDays,
    hardCapDays,
    maxDeletions,
  };

  const result = { retentionDeletes: [], retentionTally: {} };

  if (
    typeof listStaleRuns !== "function" ||
    typeof deleteForumTopic !== "function" ||
    typeof updateMetaIfUnchanged !== "function" ||
    typeof readMeta !== "function" ||
    typeof unlinkRunFiles !== "function" ||
    typeof isCriticalEvent !== "function"
  ) {
    return result;
  }

  const blocklist = Array.isArray(sharedThreadIds) ? new Set(sharedThreadIds.map(String)) : new Set();

  let candidates;
  try {
    candidates = listStaleRuns() ?? [];
  } catch {
    return result;
  }

  let attemptedDeletions = 0;

  for (const candidate of candidates) {
    try {
      if (!candidate || typeof candidate.metaPath !== "string") continue;
      const meta = candidate.meta;
      if (!meta || typeof meta !== "object") continue;
      if (!Array.isArray(candidate.events)) continue;
      const events = candidate.events;

      if (!isDeletable({ meta, events }, resolvedOpts, blocklist)) continue;

      const identity = captureIdentity(meta);
      const hasTopicDeletedAt = meta.topicDeletedAt != null;
      if (!hasTopicDeletedAt) {
        if (attemptedDeletions >= maxDeletions) continue;
        attemptedDeletions += 1;
      }

      result.retentionDeletes.push(
        deleteCandidate(candidate, identity, hasTopicDeletedAt, resolvedOpts, result.retentionTally)
      );
    } catch {
      // fail-open: one malformed candidate never aborts the sweep
    }
  }

  return result;
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

  // Composes with the worktree scan above WITHOUT closing a live run's topic. The orphan close
  // promises are attached to the returned actions array as a `topicCloses` property so the existing
  // array return contract stays byte-stable (reaper.test.mjs / notify-wiring.test.mjs assert
  // Array.isArray and actions[0]) while the composition root can still await them before exit.
  actions.topicCloses = sweepOrphanTopics(resolved);

  // Retention sweep: deletes forum topics of runs that have been closed past the retention window and
  // unlinks their obs records. Wired outside the per-worktree try/catch so a missing seam no-ops
  // instead of throwing. The returned promises and tally are attached to the actions array just like
  // topicCloses, keeping the array return contract byte-stable.
  const { retentionDeletes, retentionTally } = sweepStaleClosedTopics(resolved);
  actions.retentionDeletes = retentionDeletes;
  actions.retentionTally = retentionTally;

  return actions;
}
