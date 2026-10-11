/**
 * @description Claude Code layout for parallel task lanes. Every path is derived from an explicit
 * project root (never process.cwd() implicitly) so the same helpers serve the global parent, a lane
 * worktree and the host coordinator. Pure: no I/O.
 *
 * Parent (global) state:  <root>/.claude/plans/.state/<parentSession>/task-runs/
 *   index.json (+ .lock)          registry
 *   worktrees/task-<N>-<slug>/    lane worktrees
 *   jobs/<attemptId>/<runId>/     job.json, process.json, events.jsonl, stderr.log, result.json
 * Lane (worktree) state:   <worktree>/.claude/plans/.state/
 *   task-admission/<attemptId>.json (+ .claim)   immutable grant and its claim
 *   <laneSession>/gate-state.json, triage.json  seeded lane state (task_run binding)
 *   <laneSession>/task-ledger.jsonl             host-owned hook ledger
 */
import path from "node:path";

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
