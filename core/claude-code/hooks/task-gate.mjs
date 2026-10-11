/**
 * @description PreToolUse(*) hook — parallel task rails, in two modes.
 *
 * LANE mode (`CLAUDE_HARNESS_TASK_RUN` present — set only by the host task launcher): every tool
 * call revalidates the lane binding (grant, claim, seeded state, parent plan/spec and approval)
 * and applies the lane policy from `lib/task-lane-contract.mjs`. FAIL-CLOSED: a malformed env, an
 * identity mismatch or an unreadable binding denies everything. The existing gates (entry-gate,
 * plan-write-gate) keep running beside this one inside the lane worktree.
 *
 * PARENT mode (no env): `tasks.mjs` may only run as a single pure command
 * (`node .claude/hooks/tasks.mjs <action> [--json '<json>' | --json-file <path>]`) so its identity
 * is the host session env, never a command prefix. Once the session's task registry admits any
 * task: hands, classify and spec edits are denied (work happens in lanes); planner and
 * plan-reviewer run only as a deliberate append-only scope correction over a host-owned snapshot of
 * the admitted plan (lib/task-plan-recovery.mjs), and delivery (`git push`, `gh pr create|merge`,
 * Agent(shipper)) requires every plan task integrated with a host receipt in current HEAD
 * ancestry. Without a registry the parent is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bareRole, isSafeSessionId } from "./lib/gate-lib.mjs";
import { isDeliveryCommand } from "./entry-gate.mjs";
import { hashTaskReceipt } from "../../shared/lib/task-contract.mjs";
import { readTaskRunBinding } from "./lib/task-admission.mjs";
import { readAllIntegratedTaskEvidence } from "./lib/task-receipts.mjs";
import { planRecoveryBlock, preserveTaskPlanForPlanner } from "./lib/task-plan-recovery.mjs";
import {
  HAND_ROLES,
  LANE_ROLES,
  isDiscardCommand,
  laneBashDenyReason,
  laneDispatchRoutes,
  laneFrozenPaths,
  laneTaskScope,
  laneWriteDenyReason,
  parseTaskDispatchMarker,
  pathInScope,
  routeAllows,
} from "./lib/task-lane-contract.mjs";
import { ACCEPT_GIT_CONTROL_ENV, TASK_RUN_ENV, gateStateFile, isVolatileHarnessPath, planFile, specFile, taskRegistryPath } from "./lib/task-paths.mjs";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const TASKS_CLI = /^\s*node\s+(?:\.\/)?\.claude\/hooks\/tasks\.mjs\s+(?:dispatch|status|wait|integrate|resume|abandon-resume)(?:\s+--json\s+'[^']*'|\s+--json-file\s+[A-Za-z0-9_./-]+)?\s*$/;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const deny = (reason) => ({ deny: true, reason });
const allow = () => ({ deny: false });

/** Parse the host env; anything but `{cwd, sessionId}` with an absolute cwd is malformed. */
export function parseTaskRunEnv(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "cwd,sessionId" ||
        typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || !isSafeSessionId(value.sessionId)) return null;
    return value;
  } catch {
    return null;
  }
}

function relativeInside(root, file) {
  if (typeof file !== "string" || !file) return null;
  const absolute = path.resolve(root, file);
  let probe = absolute;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  let real;
  try {
    real = path.join(fs.realpathSync(probe), path.relative(probe, absolute));
  } catch {
    return null;
  }
  const relative = path.relative(root, real);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Product delta that a test-author repair or a discard command would destroy. */
export function uncommittedProductPaths(root, task) {
  const frozen = laneFrozenPaths(task);
  const scopes = laneTaskScope(task);
  return [...new Set([
    ...git(root, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--cached", "HEAD", "--").split("\0"),
    ...git(root, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--").split("\0"),
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter((file) => file && !isVolatileHarnessPath(file) && !pathInScope(file, frozen) && pathInScope(file, scopes)))];
}

function repairPreservation(root, task, command) {
  if (/^\s*git\s+restore\s+--staged\s+--\s+[A-Za-z0-9_./ -]+\s*$/.test(command ?? "")) return null;
  let dirty;
  try {
    dirty = uncommittedProductPaths(root, task);
  } catch {
    return "Cannot inspect the task delta before a fixture repair or discard; restore readable Git state and retry.";
  }
  if (!dirty.length) return null;
  const restore = String(command ?? "").match(/^\s*git\s+(?:restore|checkout)\s+--\s+([A-Za-z0-9_./ -]+)\s*$/);
  if (restore) {
    const targets = restore[1].trim().split(/\s+/).map((file) => path.posix.normalize(file).replace(/\/$/, ""));
    if (targets.every((target) => target !== "." && !target.startsWith("../") &&
        dirty.every((file) => file !== target && !file.startsWith(`${target}/`)))) return null;
  }
  return `Preserve the existing task implementation before a fixture repair or discard: ${JSON.stringify(dirty)}. Make a selective checkpoint commit of these authorized product paths first (it is not capture or review approval), then repair the locked test, re-run fidelity and freeze only the tests.`;
}

/** Lane-mode decision for one PreToolUse payload. */
export function decideLane(payload, env, { readBinding = readTaskRunBinding, hookCwd = process.cwd() } = {}) {
  let root;
  try {
    root = fs.realpathSync(env.cwd);
    if (fs.realpathSync(hookCwd) !== root) return deny("[task-run] hook cwd differs from the admitted task worktree");
  } catch {
    return deny("[task-run] task worktree is unavailable");
  }
  if (payload.session_id !== env.sessionId) return deny("[task-run] session differs from the admitted task session");
  const binding = readBinding(root, env.sessionId);
  if (!binding?.ok) return deny(binding?.reason ?? "[task-run] validated task binding required");
  const { task, plan, grant } = binding;
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const isSubagent = Object.hasOwn(payload, "agent_id");
  const identity = { featureId: grant.feature_id, taskId: grant.task_id, parentRoot: binding.parentRoot };

  if (tool === "Agent" || tool === "Task") {
    if (isSubagent) return deny("[task-run] subagents do not dispatch further agents in a task lane");
    const role = bareRole(input.subagent_type);
    if (!LANE_ROLES.includes(role)) return deny(`[task-run] ${String(input.subagent_type)} is outside task implementation; allowed roles: ${LANE_ROLES.join(", ")}`);
    if (input.run_in_background === true) return deny("[task-run] dispatch in the foreground (no run_in_background); the host reads each result in order");
    const marker = parseTaskDispatchMarker(input.prompt);
    if (!marker.ok) return deny(`[task-run] ${marker.reason}; first line: [HARNESS_TASK_CONTEXT]{"task_id":"${grant.task_id}"}[/HARNESS_TASK_CONTEXT]`);
    if (marker.taskId !== grant.task_id) return deny("[task-run] dispatch must name this lane's own task");
    if (marker.finalReview) return deny("[task-run] the final review belongs to the global parent");
    if (marker.fidelity && role !== "compliance") return deny("[task-run] [HARNESS_TASK_FIDELITY] is the compliance fidelity review marker");
    let routes;
    try {
      routes = laneDispatchRoutes(plan, task);
    } catch (error) {
      return deny(`[task-run] ${error.message}`);
    }
    if (!routeAllows(routes, role, input.model)) {
      return deny(`[task-run] use the literal route from contract.dispatch_routes for ${role} (subagent_type and model), got model ${JSON.stringify(input.model)}`);
    }
    if (role === "test-author") {
      const reason = repairPreservation(root, task, "");
      if (reason) return deny(`[task-run] ${reason}`);
    }
    if ((role === "executor" || role === "executor-high") && laneFrozenPaths(task).length > 0) {
      const fidelity = readLaneGateState(root, env.sessionId).fidelity_pass;
      const own = `${grant.feature_id}/${grant.task_id}`;
      if (!Array.isArray(fidelity) || !fidelity.some((entry) => String(entry).split("@")[0] === own)) {
        return deny(`[task-run] the executor needs this task's fidelity first: test-author → RED → compliance [HARNESS_TASK_FIDELITY] pass → freeze commit → mark.mjs fidelity-pass --feature-id ${grant.feature_id} --task-id ${grant.task_id}`);
      }
    }
    return allow();
  }

  if (tool === "Bash") {
    const command = String(input.command ?? "");
    if (input.run_in_background === true) return deny("[task-run] run lane commands in the foreground; a background job is unobserved");
    const reason = laneBashDenyReason(command, identity);
    if (reason) return deny(`[task-run] ${reason}`);
    if (isDiscardCommand(command)) {
      const preserve = repairPreservation(root, task, command);
      if (preserve) return deny(`[task-run] ${preserve}`);
    }
    return allow();
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path;
    const inRun = typeof target === "string" && target.length > 0 && relativeInside(grant.run_dir, path.resolve(root, target)) !== null;
    if (!isSubagent && inRun) return allow();
    if (isSubagent && inRun) return deny("[task-run] the run buffers belong to the lane orchestrator");
    const relative = relativeInside(root, target);
    const reason = laneWriteDenyReason(relative, {
      role: isSubagent ? bareRole(payload.agent_type) : null,
      task,
      exists: relative !== null && fs.existsSync(path.join(root, relative)),
    });
    return reason ? deny(`[task-run] ${reason}`) : allow();
  }
  return allow();
}

function readLaneGateState(root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(gateStateFile(root, sessionId), "utf8"));
  } catch {
    return {};
  }
}

function readRegistry(root, sessionId) {
  const file = taskRegistryPath(root, sessionId);
  if (!fs.existsSync(file)) return null;
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!registry || registry.version !== 1 || registry.parent_session_id !== sessionId || !registry.tasks) {
    throw new Error("task registry identity mismatch");
  }
  return registry;
}

function isAncestor(root, ancestor, descendant) {
  try {
    git(root, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

/** Every plan task integrated with a consistent host receipt in current HEAD ancestry. */
export function integrationBlockers(root, registry) {
  const blockers = [];
  if (registry.correction_barrier) blockers.push(`correction of ${registry.correction_barrier.task_id} is still open`);
  if (registry.integration_intent) blockers.push(`integration of ${registry.integration_intent.task_id} is still journaled`);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planFile(root, registry.feature_id), "utf8"));
  } catch {
    return [...blockers, "the admitted plan is unreadable"];
  }
  for (const task of plan.tasks ?? []) {
    const entry = registry.tasks[task.id];
    const receipt = entry?.integration;
    if (!entry || entry.status !== "integrated" || !receipt) {
      blockers.push(`${task.id} is ${entry ? entry.status : "not dispatched"}`);
      continue;
    }
    if (receipt.written_by !== "host-task-integration" || receipt.task_id !== task.id ||
        receipt.attempt_id !== entry.attempt_id || receipt.feature_id !== registry.feature_id ||
        receipt.plan_sha256 !== registry.plan_sha256 || receipt.spec_sha256 !== registry.spec_sha256 ||
        !entry.result || hashTaskReceipt(entry.result) !== receipt.result_sha256 ||
        entry.result.child_head !== receipt.child_head || !isAncestor(root, receipt.integrated_head, "HEAD")) {
      blockers.push(`${task.id} has no valid integration receipt in HEAD ancestry`);
    }
  }
  if (blockers.length) return blockers;
  // The same full evidence check the delivery receipts use: inspection + integration receipts,
  // reconciliation proofs, two-parent merges, changed paths and frozen blobs, all against HEAD.
  const evidence = readAllIntegratedTaskEvidence({
    projectRoot: root, sessionId: registry.parent_session_id, featureId: registry.feature_id,
    headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), tasks: plan.tasks,
  });
  return evidence.ok ? [] : [evidence.reason];
}

/** Parent-mode decision for one PreToolUse payload. */
export function decideParent(payload, { root = process.cwd() } = {}) {
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const command = tool === "Bash" ? String(input.command ?? "") : "";
  if (tool === "Bash" && command.includes(ACCEPT_GIT_CONTROL_ENV)) {
    return deny(`[harness-tasks] ${ACCEPT_GIT_CONTROL_ENV} is the operator's acknowledgement of a Git config/hooks change; only the operator sets it, from their own terminal (\`! <command>\`)`);
  }
  // The registry, journals and receipts are host-owned: the parent reads them through the CLI.
  if (tool === "Bash" && /task-runs\/|task-admission|task-ledger/.test(command) && !TASKS_CLI.test(command)) {
    return deny("[harness-tasks] task state (task-runs/, admissions, ledgers) is host-owned; read it with `node .claude/hooks/tasks.mjs status --json '{}'`");
  }
  if (tool === "Bash" && /\btasks\.mjs\b/.test(command) && !TASKS_CLI.test(command)) {
    return deny("[harness-tasks] run the task CLI alone, exactly `node .claude/hooks/tasks.mjs <action> --json '<json>'` (or --json-file <path>): no env prefix, cd, chaining or redirection — its identity is this session");
  }
  const sessionId = payload.session_id;
  if (!isSafeSessionId(sessionId)) return allow();
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return allow();
  }
  let registry;
  try {
    registry = readRegistry(realRoot, sessionId);
  } catch (error) {
    const restricted = tool === "Agent" || (tool === "Bash" && (isDeliveryCommand(command) || /\bclassify\.mjs\b/.test(command)));
    return restricted ? deny(`[harness-tasks] task registry cannot be read safely (${error.message}); repair it before delivery or new work`) : allow();
  }
  if (!registry || Object.keys(registry.tasks).length === 0) return allow();
  const isSubagent = Object.hasOwn(payload, "agent_id");
  if ((tool === "Agent" || tool === "Task") && !isSubagent) {
    const role = bareRole(input.subagent_type);
    if (HAND_ROLES.includes(role)) {
      return deny(`[harness-tasks] admitted tasks run their hands inside their lanes; correct a task with \`tasks.mjs resume\` instead of dispatching ${role} here`);
    }
    if (role === "planner" || role === "plan-reviewer") {
      // Deliberate scope correction (task-plan-recovery.mjs): snapshot the admitted plan and its
      // APPROVE before the planner or a re-review can replace them; the planner must read the
      // admitted copy and may only append scope.
      let recovery;
      try {
        recovery = preserveTaskPlanForPlanner({ projectRoot: realRoot, sessionId, featureId: registry.feature_id });
      } catch (error) {
        return deny(`[harness-tasks] ${error instanceof Error ? error.message : String(error)}`);
      }
      if (role === "planner" && recovery) {
        const block = planRecoveryBlock(recovery);
        if (!String(input.prompt ?? "").includes(block)) {
          return deny(`[harness-tasks] tasks are admitted: a planner dispatch is only an append-only scope correction of the existing plan. Put this block verbatim in the planner prompt, with the exact scope_paths/allowed_writes (and, only if the new path needs its own proof, the minimum new locked_tests) to append; then get a fresh plan-reviewer APPROVE and resume the same task.\n${block}`);
        }
      }
      return allow();
    }
    if (role === "shipper") {
      const blockers = integrationBlockers(realRoot, registry);
      if (blockers.length) return deny(`[harness-tasks] delivery requires every task integrated with a host receipt: ${blockers.join("; ")}`);
    }
    return allow();
  }
  if (tool === "Bash") {
    if (/\bclassify\.mjs\b/.test(command)) return deny("[harness-tasks] classification is fixed after task admission");
    if (isDeliveryCommand(command)) {
      const blockers = integrationBlockers(realRoot, registry);
      if (blockers.length) return deny(`[harness-tasks] delivery requires every task integrated with a host receipt: ${blockers.join("; ")}`);
    }
    return allow();
  }
  if (WRITE_TOOLS.has(tool)) {
    const target = path.resolve(realRoot, String(input.file_path ?? input.notebook_path ?? ""));
    const runs = path.dirname(taskRegistryPath(realRoot, sessionId));
    if (target === runs || target.startsWith(runs + path.sep)) return deny("[harness-tasks] task state is host-owned; never edit task-runs/ directly");
    if (target === specFile(realRoot, registry.feature_id)) return deny("[harness-tasks] the spec is frozen after task admission");
    if (target === planFile(realRoot, registry.feature_id) && !(isSubagent && bareRole(payload.agent_type) === "planner")) {
      return deny("[harness-tasks] after task admission only a dispatched planner corrects the plan (append-only scope correction)");
    }
  }
  return allow();
}

/** Full decision: lane mode when the host env is present, parent mode otherwise. */
export function decide(payload, { env = process.env, ...deps } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Object.hasOwn(env, TASK_RUN_ENV) ? deny("[task-run] unreadable hook payload") : allow();
  }
  if (Object.hasOwn(env, TASK_RUN_ENV)) {
    const parsed = parseTaskRunEnv(env[TASK_RUN_ENV]);
    if (!parsed) return deny(`[task-run] malformed ${TASK_RUN_ENV}; every tool call is denied`);
    try {
      return decideLane(payload, parsed, deps);
    } catch (error) {
      return deny(`[task-run] lane gate error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return decideParent(payload, deps);
  } catch (error) {
    // Fail closed only where the parent gate protects something: delivery, classification and
    // subagent dispatch. Ordinary reads and edits stay usable while the operator repairs state.
    const tool = payload.tool_name;
    let command = null;
    try { command = tool === "Bash" ? String(payload.tool_input?.command ?? "") : ""; } catch { /* unreadable: restricted */ }
    const restricted = tool === "Agent" || tool === "Task" ||
      (tool === "Bash" && (command === null || isDeliveryCommand(command) || /\bclassify\.mjs\b/.test(command)));
    return restricted ? deny(`[harness-tasks] task gate error (${error instanceof Error ? error.message : String(error)}); repair the task state before delivery or new work`) : allow();
  }
}

export function processInput(raw, deps = {}) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  const verdict = decide(payload, deps);
  if (!verdict.deny) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
  });
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectCli()) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let output = null;
  try {
    output = processInput(raw);
  } catch {
    output = Object.hasOwn(process.env, TASK_RUN_ENV)
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[task-run] lane gate failed" } })
      : null;
  }
  if (output) process.stdout.write(`${output}\n`);
  process.exit(0);
}
