/**
 * @description Deliberate plan-scope correction for admitted parallel tasks (port of Pi's
 * core/pi/lib/task-plan-recovery.mjs, which itself adapts Claude Code's serial "fold the path into
 * the plan deliberately" flow to hash-bound grants).
 *
 * When a task needs a file outside its scope, the global parent waits for running lanes, sends the
 * planner ONLY the append-only correction (scope_paths/allowed_writes grow; the minimum new
 * locked_tests may be appended), gets a fresh plan-reviewer APPROVE and resumes the SAME attempt.
 * Grants, claims and integration receipts keep the admission plan hash forever: a host-owned
 * snapshot of the admitted plan (with its original APPROVE) proves that origin, and the corrected
 * task's contract hash marks which evidence must be revalidated.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { isSafeFeatureId, isSafeSessionId } from "../../../shared/lib/feature-id.mjs";
import { acquireLock, releaseLock } from "../../../shared/lib/file-lock.mjs";
import { hashTaskReceipt, stableTaskJson } from "../../../shared/lib/task-contract.mjs";
import { readTaskProcess, writeTaskJson } from "../../../shared/lib/task-process.mjs";
import { validateExecutionPlan } from "../../skills/creating-plans/references/validate-plan.mjs";
import { planFile, planReviewEvidenceFile, taskRegistryPath } from "./task-paths.mjs";

export const PLAN_RECOVERY_MARKER = "[HARNESS_PLAN_RECOVERY]";
export const ADMITTED_PLAN_FILE = "admitted-execution-plan.json";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readText(file) {
  if (fs.realpathSync(file) !== path.resolve(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 16 * 1024 * 1024) {
    throw new Error("task plan recovery requires a bounded canonical regular file");
  }
  return fs.readFileSync(file, "utf8");
}
const read = (file) => JSON.parse(readText(file));

function identity(root, session, feature) {
  if (!isSafeSessionId(session) || !isSafeFeatureId(feature) || fs.realpathSync(root) !== path.resolve(root)) {
    throw new Error("exact task plan recovery identity required");
  }
}

/** A host-recorded plan-reviewer APPROVE (task-plan-review.mjs shape) bound to exact hashes. */
export function approvalValid(approval, session, feature, planHash, specHash) {
  return approval?.version === 1 && approval.written_by === "host-subagent-completion" &&
    approval.parent_session_id === session && approval.feature_id === feature && approval.role === "plan-reviewer" &&
    approval.status === "completed" && approval.verdict === "APPROVE" &&
    typeof approval.dispatch_call_id === "string" && approval.dispatch_call_id.length > 0 &&
    typeof approval.agent_id === "string" && approval.agent_id.length > 0 &&
    approval.plan_sha256 === planHash && approval.spec_sha256 === specHash;
}

function currentApproval(root, session) {
  try { return read(planReviewEvidenceFile(root, session)); } catch { return null; }
}

/** Scope and corrective proof can grow; admitted contracts and evidence cannot disappear or be rewritten. */
export function validateTaskScopeRecovery(before, after) {
  const valid = validateExecutionPlan(after);
  if (!valid.ok) throw new Error(`invalid corrected plan: ${valid.errors.map((e) => `[${e.path}] ${e.message}`).join("; ")}`);
  const withoutTasks = ({ tasks, ...rest }) => rest;
  if (stableTaskJson(withoutTasks(before)) !== stableTaskJson(withoutTasks(after)) || before.tasks.length !== after.tasks.length) {
    throw new Error("scope recovery must preserve the approved feature contract and task set");
  }
  const changed = [];
  for (const previous of before.tasks) {
    const current = after.tasks.find((task) => task.id === previous.id);
    if (!current) throw new Error("scope recovery must preserve task IDs");
    const contract = ({ scope_paths, allowed_writes, locked_tests, ...rest }) => rest;
    if (stableTaskJson(contract(previous)) !== stableTaskJson(contract(current))) {
      throw new Error(`scope recovery must preserve task ${previous.id} behavior, frozen tests and dependencies`);
    }
    for (const key of ["scope_paths", "allowed_writes", "locked_tests"]) {
      const admitted = previous[key] ?? [];
      const corrected = current[key] ?? [];
      if (corrected.length < admitted.length || admitted.some((item, index) => stableTaskJson(item) !== stableTaskJson(corrected[index]))) {
        throw new Error(`scope recovery may only append ${key} for ${previous.id}`);
      }
    }
    if (stableTaskJson(previous) !== stableTaskJson(current)) changed.push(previous.id);
  }
  return changed;
}

/**
 * Before the planner runs, retain the admission contract so old successful tasks stay provable.
 * Idempotent: a cancelled planner can never replace the baseline. Returns the paginable reading
 * copy, or undefined when no task was admitted in this session.
 */
export function preserveTaskPlanForPlanner({ projectRoot, sessionId, featureId }, dependencies = {}) {
  identity(projectRoot, sessionId, featureId);
  const registryFile = taskRegistryPath(projectRoot, sessionId);
  if (!fs.existsSync(registryFile)) return undefined;
  const lock = acquireLock(registryFile, { timeoutMs: 5 });
  if (!lock.ok) throw new Error("task coordinator busy before plan correction");
  try {
    const registry = read(registryFile);
    if (registry.parent_session_id !== sessionId || registry.feature_id !== featureId || registry.version !== 1) {
      throw new Error("task registry identity mismatch before plan correction");
    }
    if (Object.keys(registry.tasks ?? {}).length === 0) return undefined;
    for (const task of Object.values(registry.tasks)) {
      if ((task.launches ?? []).some((launch) => !(dependencies.readProcess ?? readTaskProcess)(launch).terminal)) {
        throw new Error("wait for active task processes before correcting the plan scope (tasks.mjs wait)");
      }
    }
    if (!registry.plan_snapshot) {
      const text = readText(planFile(projectRoot, featureId));
      const approval = currentApproval(projectRoot, sessionId);
      if (hash(text) !== registry.plan_sha256 || !approvalValid(approval, sessionId, featureId, registry.plan_sha256, registry.spec_sha256)) {
        throw new Error("preserve the admitted plan before the planner changes its scope (the current plan or its APPROVE is no longer the admitted one)");
      }
      registry.plan_snapshot = { written_by: "host-task-plan-snapshot", text, approval };
      registry.revision = (registry.revision ?? 0) + 1;
      writeTaskJson(registryFile, registry);
    }
    const snapshot = registry.plan_snapshot;
    if (snapshot.written_by !== "host-task-plan-snapshot" || typeof snapshot.text !== "string" || hash(snapshot.text) !== registry.plan_sha256 ||
        !approvalValid(snapshot.approval, sessionId, featureId, registry.plan_sha256, registry.spec_sha256)) {
      throw new Error("original admitted plan snapshot is invalid");
    }
    // The escaped text in index.json is one huge line; give the planner a paginable projection.
    // The hash-bound snapshot stays the authority.
    const readablePath = path.join(path.dirname(registryFile), ADMITTED_PLAN_FILE);
    writeTaskJson(readablePath, JSON.parse(snapshot.text));
    return { path: readablePath, plan_sha256: registry.plan_sha256 };
  } finally {
    releaseLock(registryFile, lock.token);
  }
}

/** The exact block a planner dispatch must carry after task admission. */
export function planRecoveryBlock(recovery) {
  return `${PLAN_RECOVERY_MARKER}\n${JSON.stringify(recovery)}\n` +
    "Read this paginable copy of the original admitted plan before editing. Restore from its exact values, never from session logs or a remembered summary. " +
    "Preserve every task contract, existing locked test, validation command and dependency. Only scope_paths and allowed_writes may grow, plus the minimum new " +
    "locked_tests needed to prove the authorized correction; append those without rewriting or reordering admitted entries. The copy is a reading aid, not " +
    "approval. The corrected plan still needs a fresh plan-reviewer APPROVE.\n[/HARNESS_PLAN_RECOVERY]";
}

/**
 * Current reviewed scope supersedes admission scope; the original grant itself stays immutable.
 * @returns {{ plan, planHash, originalPlan, affectedTasks: string[], approval }}
 */
export function readTaskPlanAuthority({ projectRoot, sessionId, featureId, planSha256, specSha256, originCallId }) {
  identity(projectRoot, sessionId, featureId);
  const text = readText(planFile(projectRoot, featureId));
  const currentHash = hash(text);
  const approval = currentApproval(projectRoot, sessionId);
  if (!approvalValid(approval, sessionId, featureId, currentHash, specSha256)) {
    throw new Error("current host-confirmed plan-reviewer APPROVE required");
  }
  const plan = JSON.parse(text);
  // Re-reviewing identical bytes replaces the current approval, not the task's admission origin:
  // the same hash under a current APPROVE changes no contract, with or without a snapshot.
  if (currentHash === planSha256) return { plan, planHash: currentHash, originalPlan: plan, affectedTasks: [], approval };
  let registry;
  try { registry = read(taskRegistryPath(projectRoot, sessionId)); } catch { registry = null; }
  const snapshot = registry?.plan_snapshot;
  if (registry?.parent_session_id !== sessionId || registry.feature_id !== featureId ||
      registry.plan_sha256 !== planSha256 || registry.spec_sha256 !== specSha256 ||
      snapshot?.written_by !== "host-task-plan-snapshot" || typeof snapshot.text !== "string" || hash(snapshot.text) !== planSha256 ||
      !approvalValid(snapshot.approval, sessionId, featureId, planSha256, specSha256) ||
      (originCallId && snapshot.approval.dispatch_call_id !== originCallId)) {
    throw new Error("corrected scope requires the original host-owned admission snapshot");
  }
  const originalPlan = JSON.parse(snapshot.text);
  const affectedTasks = validateTaskScopeRecovery(originalPlan, plan);
  return { plan, planHash: currentHash, originalPlan, affectedTasks, approval };
}

export function recoveredTaskContractHash(authority, taskId) {
  return authority.affectedTasks.includes(taskId)
    ? hashTaskReceipt(authority.plan.tasks.find((task) => task.id === taskId))
    : null;
}
