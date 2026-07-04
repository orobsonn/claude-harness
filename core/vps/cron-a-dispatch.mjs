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
 * @param {{ number: number, body: string }} issue - The picked issue.
 * @param {object} opts - Injected seams: project, projectRoot, worktreeRoot, stateDir,
 *   lock.acquireTs, spawn, runLock.{register,release}, buildScopedEnv, gh, counter.increment.
 * @returns {{ ok: boolean, sessionName?: string, worktreePath?: string }}
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
  "pipeline. IMPORTANT: you are ALREADY checked out on the correct per-run branch " +
  "(harness/<issue-number>) — commit and open your draft PR ON THIS BRANCH; do NOT create a new " +
  "feat/fix/docs branch (the cron tracks your PR by this branch). Add 'Closes #<issue>' to the PR " +
  "body. Open a draft PR when done; never merge or deploy.";

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
 * @param {object} args
 * @param {object} args.runLock - The run-lock seam (release).
 * @param {string} args.stateDir
 * @param {number} args.acquireTs - acquire_ts of the held holder (ownership guard).
 * @param {object} args.gh - The gh seam.
 * @param {number} args.issueNumber
 * @returns {void}
 */
function recoverSpawnFailure({ runLock, stateDir, acquireTs, gh, issueNumber }) {
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
}

/** @description recoverSpawnFailure wrapped to return the { ok: false } result shape. */
function recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber }) {
  recoverSpawnFailure({ runLock, stateDir, acquireTs, gh, issueNumber });
  return { ok: false };
}

/**
 * @description Dispatch the picked issue to a detached autonomous tmux session. See the module
 * header for the full spawn composition and lock/counter contract.
 * @returns {{ ok: boolean, sessionName?: string, worktreePath?: string }}
 */
export function dispatch(issue, opts) {
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
  } = opts;
  const issueNumber = issue.number;
  const branch = `harness/${issueNumber}`;
  const worktreePath = join(worktreeRoot, `harness-${project}-${issueNumber}`);
  const sessionName = `harness-${project}-${issueNumber}`;
  const acquireTs = lock.acquireTs;

  // Scoped child env: headless-local (no CLAUDE_CODE_REMOTE) so the cheap Ollama hands stay
  // reachable. Kept inside the failure-recovery path so an unreadable .dev.vars or missing stateDir
  // does not strand the issue in harness:in-progress.
  let scopedEnv;
  try {
    scopedEnv = buildScopedEnv(project, { stateDir, projectRoot });
  } catch {
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber });
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
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber });
  }

  // 1) Per-run worktree on a project-distinct branch (never the primary tree).
  try {
    spawn("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: projectRoot, env });
  } catch {
    // Prune any leaked harness/<issue> branch/worktree from a prior interrupted run so the retry
    // ceiling can eventually fire instead of looping forever on `git worktree add -b harness/<n>`.
    try {
      spawn("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot, env });
    } catch {
      // best-effort: worktree may not exist if the failure was branch collision
    }
    try {
      spawn("git", ["branch", "-D", branch], { cwd: projectRoot, env });
    } catch {
      // best-effort: branch may not exist if the failure was worktree collision
    }
    try {
      rmSync(envFile);
    } catch {
      // best-effort cleanup of the short-lived env-file
    }
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber });
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
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber });
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
    return recoverSpawnFailureAndReturn({ runLock, stateDir, acquireTs, gh, issueNumber });
  }

  // 4) Second lock phase + attempt charge — only AFTER a successful spawn. dispatch never
  //    re-acquires; it registers the owning session name onto the holder cron-a-select handed it.
  runLock.register(sessionName, { stateDir, acquireTs });
  counter.increment(issueNumber, { stateDir });

  return { ok: true, sessionName, worktreePath };
}
