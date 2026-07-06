/**
 * @description VPS cron harness — Cron A dispatch phase (task-5). Runs AFTER cron-a-select
 * (task-4) has picked + relabeled an issue `harness:in-progress` and acquired the run-lock
 * (acquire() recorded pid + acquire_ts; no tmux_session_id yet). dispatch is the SECOND phase
 * of the lock dance: it never re-acquires — it spawns the detached session and then calls
 * runLock.register() to attach the owning session name onto the already-held holder.
 *
 * Spawn composition (pinned by cron-a-dispatch.test.mjs):
 *   - `git worktree add <path> -b harness/<issue>` creates a per-run working tree on a
 *     project-distinct branch, never the project's primary tree.
 *   - `claude -p --permission-mode auto` runs INSIDE a detached `tmux new-session -d -s <name>
 *     -c <worktree> <sessionCommand>` — there is NO separate foreground `claude` spawn (a
 *     detached tmux session has no stdin to feed, and spawnSync ignores stdin anyway).
 *   - The issue body is written to a file and redirected into claude's stdin from WITHIN the
 *     session command string (`< '<bodyfile>'`), never interpolated into any argv or command
 *     string — so shell metacharacters in the body can never be interpreted.
 *   - The scoped child env is written to a 0600 env-file in stateDir and sourced deterministically
 *     at the start of the session command (`set -a; . '<envfile>'; set +a;`). The spawn also still
 *     receives the scoped env via `spawnOpts.env` (defense-in-depth). This guarantees the session
 *     sees OLLAMA_HAND_TOKEN and never sees CLAUDE_CODE_REMOTE, even when a tmux server already
 *     exists and a spawned-process env would otherwise be ignored by the session.
 *   - The autonomous trigger prompt is a FIXED harness string (no user input, no
 *     metacharacters): it is safe to inline, and is fed into claude's stdin alongside the body
 *     via a `{ printf ...; cat < <bodyfile>; }` preamble so `claude -p` reads trigger + body as
 *     its prompt while the body file stays byte-identical to the issue body.
 *   - The graceful-exit handler is composed AFTER the `claude -p` invocation
 *     (`...; cron-a-exit <issue> <worktree> <bodyfile> <envfile>`) so task-6's logic fires on
 *     the session's OWN termination — including a successful run that opened a PR, which
 *     nothing else invokes.
 *
 * Env: the scoped child env (from scoped-env) is handed to the tmux spawn and inherited by the
 * session, AND sourced inside the session command. CLAUDE_CODE_REMOTE is never set
 * (headless-local: the cheap Ollama hands stay reachable); OLLAMA_HAND_TOKEN is preserved so
 * spawn-hand can resolve the hand token. dispatch never invokes any deploy command.
 *
 * Attempt counter: incremented ONLY after a successful spawn + run-lock registration — a
 * spawn failure that re-queues harness:ready does NOT consume a retry attempt (single owner).
 *
 * Spawn-failure path (AC1.12): if `git worktree add`, env/body-file write, or the tmux spawn
 * fails before the session is registered, dispatch releases the held run-lock AND relabels the
 * issue harness:in-progress -> harness:ready, so neither the lock nor the issue is stranded with
 * no release owner. A leaked `harness/<issue>` branch/worktree from a prior interrupted run is
 * best-effort pruned during worktree-add failure recovery so the retry ceiling can eventually
 * fire instead of looping forever.
 *
 * Resume mode (HR-1/#ac-4.2): a `branchExists(branch)` seam probes whether harness/<issue> already
 * exists (e.g. a prior run already opened a PR on it). When it does, `git worktree add` attaches
 * the EXISTING branch (no `-b`), and the failure-recovery path never runs `git branch -D` against
 * it — deleting an already-existing branch would destroy a delivered PR. When it does not exist,
 * the fresh `-b` path is unchanged, including the branch-D prune on failure. In production, when
 * `opts.branchExists` is not injected, it defaults to a real `git rev-parse --verify --quiet
 * refs/heads/<branch>` probe against `projectRoot`.
 *
 * @param {{ number: number, body: string }} issue - The picked issue.
 * @param {object} opts - Injected seams: project, projectRoot, worktreeRoot, stateDir,
 *   lock.acquireTs, spawn, runLock.{register,release}, buildScopedEnv, gh, counter.increment,
 *   branchExists (optional; defaults to a real git probe in production).
 * @returns {{ ok: boolean, sessionName?: string, worktreePath?: string }}
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * @description Absolute path to the graceful-exit handler. The session command invokes it with the
 * node binary and this absolute path — NOT a bare `cron-a-exit` command, which is not on PATH and
 * would fail command-not-found, leaving the run orphaned (issue in-progress, lock held, files
 * uncleaned) for the reaper to recover instead of the intended graceful exit.
 */
const CRON_A_EXIT_PATH = join(dirname(fileURLToPath(import.meta.url)), "cron-a-exit.mjs");

/**
 * @description Fixed autonomous-trigger prefix prepended to the issue body on claude's stdin.
 * Headless-local autonomy is declared HERE (never via $CLAUDE_CODE_REMOTE, which would disable
 * the cheap Ollama hands). No single quotes and no `<` so it is safe to inline inside the
 * single-quoted printf argument within the composed session command.
 */
const TRIGGER_PROMPT =
  "You are an autonomous VPS cron harness session running headless-local. " +
  "Work the issue delivered below to completion without asking questions or waiting for " +
  "operator input. Follow the vendored .claude/ entry policy and orchestrating-delivery " +
  "pipeline. Open a draft PR when done; never merge or deploy.";

/**
 * @description Wraps a string in single quotes for safe use in a POSIX shell word, escaping
 * embedded single quotes as `'`\''`.
 * @param {string} s
 * @returns {string}
 */
function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * @description Composes the session command string handed to `tmux new-session`. The env-file is
 * sourced first so the session deterministically receives the scoped env (and explicitly unsets
 * CLAUDE_CODE_REMOTE). The trigger prompt is inlined (a fixed harness string, never user input)
 * and piped into claude's stdin ahead of the body file's redirect, so `claude -p` reads trigger +
 * body as its prompt while the body file stays byte-identical to the issue body. The graceful-exit
 * handler is chained AFTER the `claude -p` invocation so it fires on the session's own
 * termination, and is handed the body + env file paths so task-6 can unlink them.
 * @param {object} parts
 * @param {string} parts.envFile - Absolute path to the scoped env file (single-quoted for sourcing).
 * @param {string} parts.bodyFile - Absolute path to the written body file (single-quoted in the redirect).
 * @param {number} parts.issueNumber
 * @param {string} parts.worktreePath - Absolute path to the per-run worktree.
 * @returns {string}
 */
function composeSessionCommand({ envFile, bodyFile, issueNumber, worktreePath }) {
  return (
    `set -a; . ${shellQuoteSingle(envFile)}; set +a; ` +
    `{ printf '%s\\n\\n' '${TRIGGER_PROMPT}'; cat < ${shellQuoteSingle(bodyFile)}; } | ` +
    `claude -p --permission-mode auto; ` +
    `node ${shellQuoteSingle(CRON_A_EXIT_PATH)} ${issueNumber} ${worktreePath} ${bodyFile} ${envFile}`
  );
}

/**
 * @description Pre-registration spawn-failure recovery (AC1.12): release the held run-lock and
 * relabel the issue harness:in-progress -> harness:ready so neither is stranded with no release
 * owner. No retry attempt is consumed (the counter is charged only after a successful spawn +
 * registration). Best-effort: any error here is swallowed so the failure path never masks the
 * original spawn failure or leaves the lock held.
 *
 *   Observability cleanup (task-4): when a forum topic was already created for this run, prefer
 *   closing it via the token-bound closeForumTopic seam handed down by the composition root. If the
 *   seam is unavailable or the close fails, mark the meta status:'orphan' via obs.updateMeta — the
 *   SOLE writer of status (never a bespoke JSON write) — so the reaper (task-9) can sweep the orphan.
 *   Fail-open: every step is guarded so an observability hiccup never masks the original spawn failure.
 * @param {object} args
 * @param {object} args.runLock - The run-lock seam (release).
 * @param {string} args.stateDir
 * @param {number} args.acquireTs - acquire_ts of the held holder (ownership guard).
 * @param {object} args.gh - The gh seam.
 * @param {number} args.issueNumber
 * @param {{ obs?: object, metaPath?: string, threadId?: number|string|null }} [args.obsContext]
 *   Observability context from the pre-spawn setup; when a topic was created (threadId != null) the
 *   seam is closed or the meta is marked 'orphan'.
 * @param {Function} [args.closeForumTopic] - Token-bound seam `({threadId}) => Promise<{ok}>`.
 * @returns {Promise<void>}
 */
async function recoverSpawnFailure({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic }) {
  try {
    runLock.release({ stateDir, acquireTs });
  } catch {
    // best-effort: never leave the failure path throwing past the release
  }
  try {
    gh([
      "issue",
      "edit",
      String(issueNumber),
      "--remove-label",
      "harness:in-progress",
      "--add-label",
      "harness:ready",
    ]);
  } catch {
    // best-effort: the lock release is the critical observable; a gh hiccup must not strand it
  }

  // Observability cleanup (task-4): when a forum topic was already created for this run, prefer
  // closing it via the token-bound seam. If the seam is unavailable or the close fails, mark the
  // meta status 'orphan' so the reaper (task-9) can sweep it. Fail-open: every step is guarded so an
  // observability hiccup never masks the original spawn failure.
  let metaPath = null;
  let obs = null;
  let threadId = null;
  if (obsContext) {
    metaPath = obsContext.metaPath ?? null;
    obs = obsContext.obs ?? null;
    threadId = obsContext.threadId ?? null;
  }
  if (metaPath && obs && typeof obs.readMeta === "function" && existsSync(metaPath)) {
    try {
      const meta = obs.readMeta(metaPath);
      if (meta && meta.threadId != null) threadId = meta.threadId;
    } catch {
      // fail-open: keep the context threadId if the on-disk read fails
    }
  }
  let status = "orphan";
  if (typeof closeForumTopic === "function" && threadId != null) {
    try {
      const closeResult = await closeForumTopic({ threadId });
      status = closeResult && closeResult.ok ? "closed" : "orphan";
    } catch {
      // fall through: status stays 'orphan'
    }
  }
  if (metaPath && obs && typeof obs.updateMeta === "function") {
    try {
      obs.updateMeta(metaPath, { status });
    } catch {
      // best-effort: a status write failure must never mask the original spawn failure
    }
  }
}

/** @description recoverSpawnFailure wrapped to return the { ok: false } result shape. */
async function recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic }) {
  await recoverSpawnFailure({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  return { ok: false };
}

/**
 * @description Real branch-existence probe used in production when dispatch is not handed an
 * injected `branchExists` seam (tests always inject one, so this path is never exercised by the
 * test suite). `git rev-parse --verify --quiet refs/heads/<branch>` exits 0 iff the local branch
 * exists; any non-zero exit or spawn error is treated as "does not exist" so a probe hiccup falls
 * back to the safe fresh-branch path rather than silently resuming into an unknown branch. `env`
 * is the SAME scoped env used for the `git worktree add` spawn, so the probe resolves `git`
 * identically — an inherited-PATH/scoped-PATH mismatch could otherwise false-negative the probe
 * into the fresh `-b` path for a branch that actually exists, and the fresh-branch failure
 * recovery would then `git branch -D` a PR-carrying branch.
 * @param {string} branch
 * @param {{ cwd: string, env: object }} args
 * @returns {boolean}
 */
function defaultBranchExists(branch, { cwd, env }) {
  try {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, env });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * @description Maximum total length (Unicode code points) of a Telegram forum-topic NAME. Telegram
 * itself caps the name; the TITLE is truncated so the TOTAL name (prefix + ' · ' + title) fits.
 */
const TOPIC_NAME_MAX_CODE_POINTS = 128;

/**
 * @description Builds the run-identity forum-topic name: `#<issue> · <title>` when a title exists,
 * else `#<issue>`. The `#<issue>` prefix is ALWAYS present (the name is NEVER the bare title —
 * matches #ac-5.2 and the locked demo thread 707). The TITLE is truncated so the TOTAL name is
 * <=128 code points (prefix counted); the name is PLAIN TEXT — never HTML-escaped (Telegram does not
 * parse_mode the topic name). The final <=128 safety truncation is applied inside createForumTopic.
 * @param {number} issueNumber
 * @param {string} [title]
 * @returns {string}
 */
function buildTopicName(issueNumber, title) {
  const prefix = `#${issueNumber}`;
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) return prefix;
  const sep = " · ";
  const prefixLen = Array.from(prefix).length;
  const sepLen = Array.from(sep).length;
  const titleBudget = TOPIC_NAME_MAX_CODE_POINTS - prefixLen - sepLen;
  const titlePoints = Array.from(trimmed);
  const truncatedTitle =
    titlePoints.length > titleBudget && titleBudget > 0
      ? titlePoints.slice(0, titleBudget).join("")
      : titlePoints.join("");
  return `${prefix}${sep}${truncatedTitle}`;
}

/**
 * @description Pre-spawn observability setup (task-4). Creates (or idempotently reuses) the per-run
 * outbox meta `obs-<issue>.json`, creates the run's Telegram forum topic when no open threadId is
 * already persisted (persisting message_thread_id via obs.updateMeta — never a bespoke JSON write),
 * and appends the opening border checkpoint `{type:'picked'}` to the outbox append-if-absent so the
 * run's opening anchor reaches its topic through the exactly-once drain (replacing the legacy direct
 * 'picked' sendNotification). Fail-open: any error is swallowed so observability never blocks a
 * dispatch — a null metaPath means the run proceeds without HARNESS_OBSERVABILITY_RUN_PATH.
 *
 * Idempotent per issue#: when obs-<issue>.json already exists with a non-closed threadId it is reused
 * AS-IS — no second createForumTopic, no duplicate 'picked'. On createForumTopic failure the meta is
 * marked status:'fallback' (threadId null) and 'picked' is STILL appended so events route to the
 * shared topic with a #<issue> identity prefix (never muted).
 * @param {object} args
 * @param {object} args.obs - { createRun, appendEvent, updateMeta, readEvents, readMeta } mirroring
 *   obs-outbox.mjs's real exports EXACTLY (token-less; dispatch never sees a token).
 * @param {Function} [args.createForumTopic] - Token-bound seam `({name}) => Promise<{ok,threadId?}|null>`,
 *   resolved by the composition root; dispatch never resolves the token.
 * @param {number} args.issueNumber
 * @param {string} [args.title]
 * @param {string} args.project
 * @param {string} args.worktreePath
 * @param {string} args.stateDir
 * @returns {Promise<{ metaPath: string|null, threadId: number|string|null, obs: object }>}
 */
async function setupObservability({ obs, createForumTopic, issueNumber, title, project, worktreePath, stateDir }) {
  const metaPath = obs.createRun({ issueNumber, project, worktreePath }, stateDir);
  if (!metaPath) return { metaPath: null, threadId: null };
  const meta = (obs.readMeta(metaPath) || {});
  const CLOSED = "closed";
  let threadId = meta.threadId ?? null;
  const hasOpenThread = threadId != null && meta.status !== CLOSED;
  if (!hasOpenThread && typeof createForumTopic === "function") {
    const name = buildTopicName(issueNumber, title);
    let result = null;
    try {
      result = await createForumTopic({ name });
    } catch {
      // fail-open: a throwing token-bound seam must never block the dispatch
      result = null;
    }
    if (result && result.ok && result.threadId != null) {
      threadId = result.threadId;
      try {
        // Reset status to 'active' on a successful topic creation: a reused run whose meta was
        // previously 'fallback'/'orphan' (a requeue retry) must not keep routing to the shared
        // topic nor be sweepable by the reaper — the dedicated topic now exists. The failure path
        // below still writes status 'fallback' (unchanged).
        obs.updateMeta(metaPath, { threadId, status: "active" });
      } catch {
        // best-effort: threadId persist failure routes to the shared topic instead
        threadId = null;
      }
    } else {
      try {
        obs.updateMeta(metaPath, { status: "fallback" });
      } catch {
        // best-effort: status write failure never blocks the dispatch
      }
      threadId = null;
    }
  }
  // Opening border checkpoint (#ac-2.3) — append-if-absent so an idempotent requeue never duplicates.
  try {
    const events = obs.readEvents(metaPath) || [];
    if (!events.some((e) => e && e.type === "picked")) {
      obs.appendEvent(metaPath, { type: "picked" });
    }
  } catch {
    // best-effort: a dropped opening anchor is bounded by the next drain — never block the dispatch
  }
  return { metaPath, threadId, obs };
}

/**
 * @description Dispatch the picked issue to a detached autonomous tmux session. See the module
 * header for the full spawn composition and lock/counter contract.
 *
 * Observability (task-4): when an `obs` seam group is injected, the per-run outbox meta + Telegram
 * forum topic are created and the opening `picked` checkpoint is appended BEFORE the tmux spawn, and
 * `HARNESS_OBSERVABILITY_RUN_PATH` (the absolute obs-<issue>.json path) is exported into the scoped
 * env-file alongside the existing HARNESS_NOTIFY_* (non-secret only — never the token). The
 * createForumTopic/closeForumTopic seams are TOKEN-BOUND and handed down already resolved by the
 * composition root; dispatch never resolves the token from the session env-file. dispatch is async so
 * it can await the createForumTopic round-trip before the spawn; a call WITHOUT an `obs` seam stays
 * fully synchronous (no await reached), so legacy callers that do not `await dispatch(...)` are
 * byte-identically unaffected.
 * @returns {{ ok: boolean, sessionName?: string, worktreePath?: string } | Promise<{ ok: boolean, sessionName?: string, worktreePath?: string }>}
 */
export async function dispatch(issue, opts) {
  const {
    project,
    projectRoot,
    worktreeRoot,
    stateDir,
    lock,
    spawn,
    runLock,
    gh,
    counter,
    buildScopedEnv,
    notify,
    branchExists,
    obs,
    createForumTopic,
    closeForumTopic,
  } = opts;
  const issueNumber = issue.number;
  const branch = `harness/${issueNumber}`;
  const worktreePath = join(worktreeRoot, `harness-${project}-${issueNumber}`);
  const sessionName = `harness-${project}-${issueNumber}`;
  const acquireTs = lock.acquireTs;
  // Note: `env` (the scoped env used for the worktree-add spawn) is referenced here via closure
  // but is only read when probeBranchExists is actually invoked below, AFTER `env` is built —
  // so git resolves identically for the probe and the worktree-add spawn.
  const probeBranchExists = branchExists ?? ((b) => defaultBranchExists(b, { cwd: projectRoot, env }));

  // Pre-spawn observability setup (task-4): createRun + createForumTopic + append 'picked' all
  // complete BEFORE the tmux spawn. Fail-open — observability never blocks a dispatch; a null
  // metaPath means no HARNESS_OBSERVABILITY_RUN_PATH is threaded (legacy behavior). The threadId
  // captured here is handed to recoverSpawnFailure so a pre-registration spawn failure that already
  // created a topic either closes it via the token-bound seam or marks the run 'orphan'.
  let obsContext = null;
  if (obs && typeof obs.createRun === "function") {
    try {
      obsContext = await setupObservability({
        obs,
        createForumTopic,
        issueNumber,
        title: issue.title,
        project,
        worktreePath,
        stateDir,
      });
    } catch {
      // fail-open: observability setup must never strand the issue in harness:in-progress
      obsContext = null;
    }
  }
  const obsMetaPath = obsContext ? obsContext.metaPath : null;
  const obsThreadId = obsContext ? obsContext.threadId : null;
  // closeForumTopic is handed down token-bound by the composition root; dispatch wires it into the
  // recover path for the close-on-spawn-failure cleanup — see recoverSpawnFailure.

  // Scoped child env: headless-local (no CLAUDE_CODE_REMOTE) so the cheap Ollama hands stay
  // reachable. Kept inside the failure-recovery path so an unreadable .dev.vars or missing stateDir
  // does not strand the issue in harness:in-progress.
  let scopedEnv;
  try {
    scopedEnv = buildScopedEnv(project, { stateDir, projectRoot });
  } catch {
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  }
  const env = { ...scopedEnv };
  delete env.CLAUDE_CODE_REMOTE;

  // Non-secret notify coordinates threaded into the detached session so the chained cron-a-exit
  // (which runs in the same shell after `claude -p`, having sourced this env-file with `set -a`)
  // can notify session-done/blocked/failed. Only chatId/threadId/project — NEVER the Telegram
  // token (cron-a-exit reads that from ~/.claude/.dev.vars at runtime). Guarded on notify presence
  // so a project without notify writes a byte-identical env-file.
  // The project name is always threaded (non-secret) so cron-a-exit knows which project's prefix to
  // use even when the chat/thread come from ~/.claude/.dev.vars rather than config.notify.
  env.HARNESS_NOTIFY_PROJECT = project;
  if (notify && notify.chatId != null && notify.chatId !== "") {
    env.HARNESS_NOTIFY_CHATID = String(notify.chatId);
    if (notify.threadId != null) env.HARNESS_NOTIFY_THREADID = String(notify.threadId);
  }
  // HARNESS_OBSERVABILITY_RUN_PATH: the absolute obs-<issue>.json meta path, threaded NON-SECRET
  // alongside HARNESS_NOTIFY_* so the detached session + chained cron-a-exit + the drain can locate
  // the run's outbox. NEVER the token. Only set when observability is wired (obsMetaPath non-null) —
  // a project without observability writes a byte-identical env-file.
  if (obsMetaPath) {
    env.HARNESS_OBSERVABILITY_RUN_PATH = obsMetaPath;
  }

  // Write the scoped env to a 0600 env-file. Sourced by the session command so the variables reach
  // the tmux session even when a server already exists (spawn env is ignored in that case).
  let envFile;
  try {
    envFile = join(stateDir, `issue-${issueNumber}-env-${randomUUID()}.env`);
    const envBody =
      "unset CLAUDE_CODE_REMOTE\n" +
      Object.entries(env)
        .map(([k, v]) => `${k}=${shellQuoteSingle(v)}`)
        .join("\n");
    writeFileSync(envFile, envBody, { encoding: "utf8", mode: 0o600 });
  } catch {
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  }

  // 1) Per-run worktree on a project-distinct branch (never the primary tree). When branch/<issue>
  //    already exists (resume/repair of a run whose branch may already carry an open PR), attach
  //    the EXISTING branch (no -b) instead of creating a fresh one, so repair never orphans the PR.
  const branchAlreadyExisted = probeBranchExists(branch);
  const branchWasFreshlyCreated = !branchAlreadyExisted;
  try {
    if (branchAlreadyExisted) {
      spawn("git", ["worktree", "add", worktreePath, branch], { cwd: projectRoot, env });
    } else {
      spawn("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: projectRoot, env });
    }
  } catch {
    // Prune any leaked worktree from a prior interrupted run so the retry ceiling can eventually
    // fire instead of looping forever on `git worktree add`.
    try {
      spawn("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot, env });
    } catch {
      // best-effort: worktree may not exist if the failure was branch collision
    }
    // Only prune the branch itself when THIS dispatch would have freshly created it — an
    // already-existing branch may carry an open PR, and deleting it would destroy delivered work.
    if (branchWasFreshlyCreated) {
      try {
        spawn("git", ["branch", "-D", branch], { cwd: projectRoot, env });
      } catch {
        // best-effort: branch may not exist if the failure was worktree collision
      }
    }
    try {
      rmSync(envFile);
    } catch {
      // best-effort cleanup of the short-lived env-file
    }
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  }

  // 1b) git worktree only checks out TRACKED files. When `.claude` is gitignored (e.g. the harness
  //      source repo), the vendored harness — skills, agents, entry policy, hooks, settings — is
  //      ABSENT from the worktree, so the spawned `claude -p` runs with NO pipeline (no
  //      triaging-requests, no orchestrating-delivery, no planner/adversary/plan-reviewer/cheap
  //      hands). Copy it in from projectRoot when the worktree lacks it, so the session actually runs
  //      the harness. Best-effort: a project without .claude simply has nothing to copy, and a copy
  //      hiccup must never fail the dispatch.
  try {
    const claudeSrc = join(projectRoot, ".claude");
    const claudeDst = join(worktreePath, ".claude");
    if (existsSync(claudeSrc) && !existsSync(claudeDst)) {
      spawn("cp", ["-a", claudeSrc, claudeDst], { cwd: projectRoot, env });
    }
  } catch {
    // best-effort — the reaper/next cycle bound the blast radius if the harness copy fails
  }

  // 2) Write the issue body to a file (byte-identical) — delivered via stdin redirect, never
  //    interpolated into any argv or command string.
  let bodyFile;
  try {
    bodyFile = join(stateDir, `issue-${issueNumber}-body-${randomUUID()}.txt`);
    writeFileSync(bodyFile, issue.body, { encoding: "utf8", mode: 0o600 });
  } catch {
    // git succeeded but the body write failed: drop the worktree so the next cycle can retry.
    try {
      spawn("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot, env });
    } catch {
      // best-effort: a lingering worktree is bounded by layer-3 uniqueness; do not mask the failure
    }
    try {
      rmSync(envFile);
    } catch {
      // best-effort cleanup
    }
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  }

  // 3) Spawn the detached tmux session running claude -p + the chained graceful-exit handler.
  const sessionCommand = composeSessionCommand({ envFile, bodyFile, issueNumber, worktreePath });
  try {
    spawn(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", worktreePath, sessionCommand],
      { cwd: projectRoot, env }
    );
  } catch {
    // git succeeded but tmux failed: best-effort drop the stray worktree/files so the next
    // cycle's `git worktree add -b harness/<issue>` does not collide on the path (defense-in-depth
    // layer 3), then release + relabel.
    try {
      spawn("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot, env });
    } catch {
      // best-effort: a lingering worktree is bounded by layer-3 uniqueness; do not mask the failure
    }
    try {
      rmSync(envFile);
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(bodyFile);
    } catch {
      // best-effort cleanup
    }
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber, obsContext, closeForumTopic });
  }

  // 4) Second lock phase + attempt charge — only AFTER a successful spawn. dispatch never
  //    re-acquires; it registers the owning session name onto the holder cron-a-select handed it.
  runLock.register(sessionName, { stateDir, acquireTs });
  counter.increment(issueNumber, { stateDir });

  return { ok: true, sessionName, worktreePath };
}
