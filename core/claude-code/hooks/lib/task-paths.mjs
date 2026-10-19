/**
 * @description Claude Code layout for parallel task lanes. Every path is derived from an explicit
 * project root (never process.cwd() implicitly) so the same helpers serve the global parent, a lane
 * worktree and the host coordinator. Pure: no I/O.
 *
 * Parent (global) state:  <root>/.claude/plans/.state/<parentSession>/task-runs/
 *   index.json (+ .lock)          registry
 *   jobs/<attemptId>/<runId>/     job.json, process.json, events.jsonl, stderr.log, result.json
 * Lane roots, OUTSIDE the repository:
 *   $CLAUDE_HARNESS_TASK_WORKTREES_DIR | $XDG_STATE_HOME/claude-harness/task-worktrees (default
 *   ~/.local/state/…) / <repo>-<hash8>/<parentSession>/task-<N>-<slug>/{worktree,run}
 *   Claude Code treats every path under a `.claude/` directory as a sensitive file and refuses
 *   headless writes there (spike §11), so a lane worktree can never live inside `.claude/`; and
 *   `run/` (the lane's own buffers: diary, notes) sits beside the worktree, outside Git.
 * Lane (worktree) state:   <worktree>/.claude/plans/.state/
 *   task-admission/<attemptId>.json (+ .claim)   immutable grant and its claim
 *   <laneSession>/gate-state.json, triage.json  seeded lane state (task_run binding)
 *   <laneSession>/task-ledger.jsonl             host-owned hook ledger
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/; // same rule as gate-lib isSafeSessionId

export const TASK_RUN_ENV = "CLAUDE_HARNESS_TASK_RUN";
export const MAX_PARALLEL_TASKS = 3;
export const PARALLEL_LIMIT_ENV = "CLAUDE_HARNESS_MAX_PARALLEL_TASKS";
export const TASK_TIMEOUT_ENV = "CLAUDE_HARNESS_TASK_TIMEOUT_MS";
export const DEFAULT_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const WAIT_MAX_SECONDS = 540;
export const SHARED_CONTEXT_MAX_BYTES = 8192;

export const stateRoot = (root) => path.join(root, ".claude", "plans", ".state");
export const sessionStateDir = (root, sessionId) => path.join(stateRoot(root), sessionId);
export const gateStateFile = (root, sessionId) => path.join(sessionStateDir(root, sessionId), "gate-state.json");
export const triageFile = (root, sessionId) => path.join(sessionStateDir(root, sessionId), "triage.json");
export const planReviewEvidenceFile = (root, sessionId) => path.join(sessionStateDir(root, sessionId), "plan-review-evidence.json");
export const planReviewInputsDir = (root, sessionId) => path.join(sessionStateDir(root, sessionId), "plan-review-inputs");
export const taskRunsDir = (root, sessionId) => path.join(sessionStateDir(root, sessionId), "task-runs");
export const taskRegistryPath = (root, sessionId) => path.join(taskRunsDir(root, sessionId), "index.json");
export const taskAdmissionPath = (worktree, attemptId) => path.join(stateRoot(worktree), "task-admission", `${attemptId}.json`);
export const laneLedgerFile = (worktree, laneSession) => path.join(sessionStateDir(worktree, laneSession), "task-ledger.jsonl");
export const TASK_WORKTREES_ENV = "CLAUDE_HARNESS_TASK_WORKTREES_DIR";
/** Operator acknowledgement (own terminal only) of a shared Git config/hooks change during a run. */
export const ACCEPT_GIT_CONTROL_ENV = "CLAUDE_HARNESS_ACCEPT_GIT_CONTROL_CHANGE";

/** Base directory for lane roots (host env or XDG state), always absolute and outside any repo. */
export function laneRootsBase(env = process.env) {
  const configured = env[TASK_WORKTREES_ENV];
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) throw new Error(`${TASK_WORKTREES_ENV} must be an absolute path`);
    return configured;
  }
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), ".local", "state");
  return path.join(state, "claude-harness", "task-worktrees");
}

/** Lane root for one task attempt: <base>/<repo>-<hash8(root)>/<session>/<name>. */
export function laneRoot(root, sessionId, name, env = process.env) {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const repo = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "repo";
  return path.join(laneRootsBase(env), `${repo}-${digest}`, sessionId, name);
}

export const featureDir = (root, featureId) => path.join(root, ".claude", "plans", featureId);
export const planFile = (root, featureId) => path.join(featureDir(root, featureId), "execution-plan.json");
export const specFile = (root, featureId) => path.join(featureDir(root, featureId), "spec.md");
export const featureRunDir = (root, featureId) => path.join(featureDir(root, featureId), "run");
export const sharedContextFile = (root, featureId) => path.join(featureRunDir(root, featureId), "shared_context.md");

/**
 * Harness paths that never count as product changes: the gitignored plan/state tree, copied
 * dependencies and the version-check cache. Everything else (including committed `.claude/` harness
 * files) is real content.
 */
export function isVolatileHarnessPath(name) {
  return name.startsWith(".claude/plans/") ||
    name.startsWith("node_modules/") ||
    /^\.claude\/\.harness-version-check-cache(?:\.tmp)?$/.test(name);
}

/**
 * Host-side env limits: an operator env may LOWER the parallel limit, never raise it, and may set
 * a task deadline between 1 ms and 24 h (default 2 h). Invalid values fail closed to the defaults.
 */
export function hostTaskLimits(env = process.env) {
  const requested = Number(env[PARALLEL_LIMIT_ENV]);
  const maxParallel = Number.isInteger(requested) && requested >= 1 && requested <= MAX_PARALLEL_TASKS
    ? requested
    : MAX_PARALLEL_TASKS;
  const timeout = Number(env[TASK_TIMEOUT_ENV]);
  const timeoutMs = Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TASK_TIMEOUT_MS
    ? timeout
    : DEFAULT_TASK_TIMEOUT_MS;
  return { maxParallel, timeoutMs };
}

/** The host-set lane binding env: exactly {cwd, sessionId}, an absolute cwd and a safe session id; null otherwise. */
export function parseTaskRunEnv(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "cwd,sessionId" ||
        typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || typeof value.sessionId !== "string" || !SAFE_SESSION_ID.test(value.sessionId)) return null;
    return value;
  } catch {
    return null;
  }
}
