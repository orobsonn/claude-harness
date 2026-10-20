/** Adapt Claude Code's deliberate plan-scope correction to Pi's existing task grants. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import { hashTaskReceipt, stableTaskJson, taskRegistryPath } from "./task-contract.mjs";
import { acquireLock, releaseLock } from "./pi-gate-state.mjs";
import { readTaskProcess, writeTaskJson } from "./task-process.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readText = (file) => {
  if (fs.realpathSync(file) !== path.resolve(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 16 * 1024 * 1024)
    throw new Error("task plan recovery requires a bounded canonical regular file");
  return fs.readFileSync(file, "utf8");
};
const read = (file) => JSON.parse(readText(file));
const planFile = (root, feature) => path.join(root, ".pi/harness/plans", feature, "execution-plan.json");
const stateFile = (root, session) => path.join(root, ".pi/harness/state", session, "gate-state.json");

function identity(root, session, feature) {
  if (!isSafeSessionId(session) || !isSafeFeatureId(feature) || fs.realpathSync(root) !== path.resolve(root))
    throw new Error("exact task plan recovery identity required");
}

function approvalValid(approval, session, feature, planHash, specHash) {
  return approval?.written_by === "host-subagent-completion" && approval.parent_session_id === session &&
    approval.feature_id === feature && approval.role === "harness-plan-reviewer" &&
    approval.status === "completed" && approval.verdict === "APPROVE" &&
    typeof approval.dispatch_call_id === "string" && approval.dispatch_call_id &&
    typeof approval.child_session_id === "string" && approval.child_session_id &&
    typeof approval.agent_id === "string" && approval.agent_id &&
    approval.plan_sha256 === planHash && approval.spec_sha256 === specHash;
}

function preservesJudgments(before, after) {
  if (stableTaskJson(before) === stableTaskJson(after)) return true;
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  return object(after) && (before === undefined || object(before)) &&
    Object.entries(before ?? {}).every(([key, value]) => Object.hasOwn(after, key) &&
      stableTaskJson(value) === stableTaskJson(after[key]));
}

/** Scope, corrective proof and reviewed clarifications can grow; admitted evidence stays intact. */
export function validateTaskScopeRecovery(before, after) {
  const valid = validatePlan(after, { expect: "full", expectedModelStrategy: before.model_strategy });
  if (!valid.ok) throw new Error(`invalid corrected plan: ${valid.errors.join("; ")}`);
  const withoutTasks = ({ tasks, ...rest }) => rest;
  if (stableTaskJson(withoutTasks(before)) !== stableTaskJson(withoutTasks(after)) || before.tasks.length !== after.tasks.length)
    throw new Error("scope recovery must preserve the approved feature contract and task set");
  const changed = [];
  for (const previous of before.tasks) {
    const current = after.tasks.find((task) => task.id === previous.id);
    if (!current) throw new Error("scope recovery must preserve task IDs");
    const contract = ({ scope_paths, allowed_writes, locked_tests, resolved_judgments,
      resolved_judgments_model_resolved, ...rest }) => rest;
    if (stableTaskJson(contract(previous)) !== stableTaskJson(contract(current)))
      throw new Error(`scope recovery must preserve task ${previous.id} behavior, frozen tests and dependencies`);
    if (!preservesJudgments(previous.resolved_judgments, current.resolved_judgments))
      throw new Error(`scope recovery must preserve task ${previous.id} admitted judgments`);
    for (const key of ["scope_paths", "allowed_writes", "locked_tests", "resolved_judgments_model_resolved"]) {
      const admitted = previous[key] ?? [];
      const corrected = current[key] ?? [];
      if (corrected.length < admitted.length || admitted.some((item, index) =>
        stableTaskJson(item) !== stableTaskJson(corrected[index])))
        throw new Error(`scope recovery may only append ${key} for ${previous.id}`);
    }
    if (stableTaskJson(previous) !== stableTaskJson(current)) changed.push(previous.id);
  }
  return changed;
}

/** Before the existing planner runs, retain the admission contract so old successful tasks stay provable. */
export function preserveTaskPlanForPlanner({ projectRoot, sessionId, featureId }, dependencies = {}) {
  identity(projectRoot, sessionId, featureId);
  const registryFile = taskRegistryPath(projectRoot, sessionId);
  if (!fs.existsSync(registryFile)) return;
  const lock = acquireLock(registryFile, { timeoutMs: 5 });
  if (!lock.ok) throw new Error("task coordinator busy before plan correction");
  try {
    const registry = read(registryFile);
    if (registry.parent_session_id !== sessionId || registry.feature_id !== featureId || registry.version !== 1)
      throw new Error("task registry identity mismatch before plan correction");
    for (const task of Object.values(registry.tasks)) {
      if (task.launches.some((launch) => !(dependencies.readProcess ?? readTaskProcess)(launch).terminal))
        throw new Error("wait for active task processes before correcting the plan scope");
    }
    if (!registry.plan_snapshot) {
      const text = readText(planFile(projectRoot, featureId));
      const state = read(stateFile(projectRoot, sessionId));
      if (hash(text) !== registry.plan_sha256 || !approvalValid(state.plan_review_evidence, sessionId, featureId, registry.plan_sha256, registry.spec_sha256))
        throw new Error("preserve the admitted plan before the planner changes its scope");
      registry.plan_snapshot = { written_by: "host-task-plan-snapshot", text, approval: state.plan_review_evidence };
      registry.revision = (registry.revision ?? 0) + 1;
      writeTaskJson(registryFile, registry);
    }
    const snapshot = registry.plan_snapshot;
    if (snapshot.written_by !== "host-task-plan-snapshot" || typeof snapshot.text !== "string" ||
        hash(snapshot.text) !== registry.plan_sha256 ||
        !approvalValid(snapshot.approval, sessionId, featureId, registry.plan_sha256, registry.spec_sha256))
      throw new Error("original admitted plan snapshot is invalid");
    // The escaped text in index.json can exceed Pi read's per-line limit. Give
    // the planner a paginable projection; the hash-bound snapshot remains authority.
    const readablePath = path.join(path.dirname(registryFile), "admitted-execution-plan.json");
    writeTaskJson(readablePath, JSON.parse(snapshot.text));
    return { path: readablePath, plan_sha256: registry.plan_sha256 };
  } finally { releaseLock(registryFile, lock.token); }
}

/** Current reviewed scope supersedes admission scope; the original grant itself remains immutable. */
export function readTaskPlanAuthority({ projectRoot, sessionId, featureId, planSha256, specSha256, originCallId }) {
  identity(projectRoot, sessionId, featureId);
  const text = readText(planFile(projectRoot, featureId));
  const currentHash = hash(text);
  const state = read(stateFile(projectRoot, sessionId));
  if (state.session_id !== sessionId || state.feature_id !== featureId ||
      !approvalValid(state.plan_review_evidence, sessionId, featureId, currentHash, specSha256))
    throw new Error("current host-confirmed plan-reviewer APPROVE required");
  const plan = JSON.parse(text);
  // Re-reviewing identical bytes replaces the current approval, not the task's
  // admission origin. When those calls differ, prove the old origin with the
  // same host-owned snapshot used for scope recovery instead of rejecting it.
  if (currentHash === planSha256 &&
      (!originCallId || originCallId === state.plan_review_evidence.dispatch_call_id)) {
    return { plan, planHash: currentHash, originalPlan: plan, affectedTasks: [], approval: state.plan_review_evidence };
  }
  const registry = read(taskRegistryPath(projectRoot, sessionId));
  const snapshot = registry.plan_snapshot;
  if (registry.parent_session_id !== sessionId || registry.feature_id !== featureId ||
      registry.plan_sha256 !== planSha256 || registry.spec_sha256 !== specSha256 ||
      snapshot?.written_by !== "host-task-plan-snapshot" || typeof snapshot.text !== "string" ||
      hash(snapshot.text) !== planSha256 ||
      !approvalValid(snapshot.approval, sessionId, featureId, planSha256, specSha256) ||
      originCallId && snapshot.approval.dispatch_call_id !== originCallId)
    throw new Error("corrected scope requires the original host-owned admission snapshot");
  const originalPlan = JSON.parse(snapshot.text);
  // Identical bytes cannot add or remove a task obligation. Keep the same
  // validation behavior as the original exact-plan path, including old plans.
  if (currentHash === planSha256)
    return { plan, planHash: currentHash, originalPlan, affectedTasks: [], approval: state.plan_review_evidence };
  const affectedTasks = validateTaskScopeRecovery(originalPlan, plan);
  return { plan, planHash: currentHash, originalPlan, affectedTasks, approval: state.plan_review_evidence };
}

/** Read-only resume proof; an interrupted scope correction need not be approved yet. */
export function readTaskPlanAdmission({ projectRoot, sessionId, featureId, specSha256 }) {
  identity(projectRoot, sessionId, featureId);
  const registry = read(taskRegistryPath(projectRoot, sessionId));
  if (registry.version !== 1 || registry.parent_session_id !== sessionId || registry.feature_id !== featureId ||
      registry.spec_sha256 !== specSha256 || !/^[a-f0-9]{64}$/.test(registry.plan_sha256 ?? ""))
    throw new Error("task admission identity mismatch");
  const currentText = readText(planFile(projectRoot, featureId));
  const snapshot = registry.plan_snapshot;
  if (snapshot && (snapshot.written_by !== "host-task-plan-snapshot" || typeof snapshot.text !== "string"))
    throw new Error("original admitted plan snapshot is invalid");
  const text = snapshot ? snapshot.text : currentText;
  const approval = snapshot ? snapshot.approval : read(stateFile(projectRoot, sessionId)).plan_review_evidence;
  if (hash(text) !== registry.plan_sha256 ||
      !approvalValid(approval, sessionId, featureId, registry.plan_sha256, specSha256))
    throw new Error("host-confirmed original task admission required");
  const originalPlan = JSON.parse(text);
  const plan = JSON.parse(currentText);
  const affectedTasks = validateTaskScopeRecovery(originalPlan, plan);
  // This only proves historical admission. Dispatch/integration continue to
  // require readTaskPlanAuthority's APPROVE for the current canonical bytes.
  return { originalPlan, plan, affectedTasks };
}

export function recoveredTaskContractHash(authority, taskId) {
  return authority.affectedTasks.includes(taskId)
    ? hashTaskReceipt(authority.plan.tasks.find((task) => task.id === taskId)) : null;
}
