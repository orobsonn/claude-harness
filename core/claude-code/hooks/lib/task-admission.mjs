/**
 * @description Admission and authority rails for one Claude Code task lane (port of Pi's
 * task-run.mjs admission). A lane is admitted from an immutable grant written by the host
 * coordinator into the lane worktree; admission creates a `wx` claim and the seeded lane state
 * (gate-state with `task_run`, triage) — never any pipeline evidence. Every lane tool call
 * revalidates the same binding through `readTaskRunBinding`.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../../shared/lib/feature-id.mjs";
import { TASK_PIPELINE_VERSION, hashTaskReceipt, stableTaskJson } from "../../../shared/lib/task-contract.mjs";
import { validateTaskContextHandoff } from "../../../shared/lib/task-context.mjs";
import { validateExecutionPlan } from "../../skills/creating-plans/references/validate-plan.mjs";
import { readPlanApproval } from "../task-plan-review.mjs";
import { laneDispatchRoutes, laneFrozenPaths, laneTaskScope } from "./task-lane-contract.mjs";
import {
  gateStateFile,
  isVolatileHarnessPath,
  laneLedgerFile,
  planFile,
  sessionStateDir,
  specFile,
  taskAdmissionPath,
  taskRegistryPath,
  triageFile,
} from "./task-paths.mjs";

const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const fail = (reason) => ({ ok: false, reason: `[task-run] ${reason}` });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Read a bounded regular file through canonical, symlink-free directory ancestry. */
export function readArtifact(file, ownerRoot = path.dirname(file)) {
  const absolute = path.resolve(file);
  const root = fs.realpathSync(ownerRoot);
  if (!inside(root, absolute)) throw new Error("artifact path escapes its owner root");
  let cursor = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("artifact symlink rejected");
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES || fs.realpathSync(absolute) !== absolute) {
    throw new Error("artifact must be a bounded regular file");
  }
  return fs.readFileSync(absolute, "utf8");
}

/** Plan + spec of a feature under a root, with their exact sha256. */
export function planAndSpec(root, featureId) {
  const planPath = planFile(root, featureId);
  const specPath = specFile(root, featureId);
  const planText = readArtifact(planPath, root);
  const specText = readArtifact(specPath, root);
  return { planPath, specPath, planText, specText, planSha256: sha256(planText), specSha256: sha256(specText), plan: JSON.parse(planText) };
}

/** A parallel-eligible canonical plan, or throws with the validator's own reasons. */
export function requireParallelPlan(plan, featureId) {
  const valid = validateExecutionPlan(plan);
  if (!valid.ok) throw new Error(`invalid canonical plan: ${valid.errors.map((e) => `[${e.path}] ${e.message}`).join("; ")}`);
  if (plan.feature_id !== featureId) throw new Error("plan feature_id does not match the parent feature");
  if (plan.execution?.parallel !== true) {
    throw new Error('the approved plan does not opt into parallel tasks; it needs "execution": {"parallel": true} (re-plan and re-review)');
  }
  return plan;
}

/** Host-owned parent authority: classified LIGHT/FULL parent, no task_run, current plan APPROVE. */
export function readParentAuthority({ root, sessionId }) {
  if (!isSafeSessionId(sessionId)) throw new Error("safe parent session required");
  const triage = JSON.parse(readArtifact(triageFile(root, sessionId), root));
  if (triage.session_id !== sessionId || !["LIGHT", "FULL"].includes(triage.mode) || !isSafeFeatureId(triage.feature_id)) {
    throw new Error("a LIGHT/FULL classified global parent is required (run triaging-requests first)");
  }
  let state = {};
  try { state = JSON.parse(readArtifact(gateStateFile(root, sessionId), root)); } catch { state = {}; }
  if (state.task_run) throw new Error("a task lane cannot coordinate tasks");
  if (state.feature_id !== undefined && state.feature_id !== triage.feature_id) throw new Error("parent gate-state feature mismatch");
  const approval = readPlanApproval({ root, sessionId, featureId: triage.feature_id });
  if (!approval.ok) throw new Error(approval.reason);
  return { triage, state, featureId: triage.feature_id, mode: triage.mode, approval: approval.evidence };
}

function validateDependencyReceipt(receipt, expected, grant) {
  return receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
    receipt.version === TASK_PIPELINE_VERSION && receipt.written_by === "host-task-integration" &&
    receipt.parent_session_id === grant.parent_session_id && receipt.feature_id === grant.feature_id &&
    receipt.task_id === expected.task_id && receipt.parent_root === grant.parent_root &&
    receipt.plan_sha256 === grant.plan_sha256 && receipt.spec_sha256 === grant.spec_sha256 &&
    receipt.child_head === expected.child_head && receipt.integrated_head === expected.integrated_head &&
    HEX_40.test(receipt.base_sha ?? "") && HEX_40.test(receipt.child_head ?? "") &&
    HEX_40.test(receipt.integrated_head ?? "") && HEX_64.test(receipt.result_sha256 ?? "") &&
    isSafeSessionId(receipt.session_id) && isSafeSessionId(receipt.attempt_id) &&
    typeof receipt.worktree === "string" && receipt.worktree.length > 0;
}

function validateDependencies({ task, grant, parentRoot, allowHistoricalDeps = false }) {
  const dependencies = Array.isArray(grant.dependencies) ? grant.dependencies : null;
  if (!dependencies) throw new Error("dependency receipts array required");
  const expectedIds = [...task.depends_on].sort();
  const actualIds = dependencies.map((entry) => entry?.task_id).sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index]) || new Set(actualIds).size !== actualIds.length) {
    throw new Error("dependency receipts must exactly match task depends_on");
  }
  if (dependencies.length === 0) return;
  const registry = JSON.parse(readArtifact(taskRegistryPath(parentRoot, grant.parent_session_id), parentRoot));
  if (registry.version !== TASK_PIPELINE_VERSION || registry.parent_session_id !== grant.parent_session_id ||
      registry.feature_id !== grant.feature_id || registry.plan_sha256 !== grant.plan_sha256 || registry.spec_sha256 !== grant.spec_sha256) {
    throw new Error("parent task registry identity mismatch");
  }
  for (const dependency of dependencies) {
    if (!dependency || !isSafeTaskId(dependency.task_id) || !HEX_40.test(dependency.child_head ?? "") ||
        !HEX_40.test(dependency.integrated_head ?? "") || !HEX_64.test(dependency.receipt_sha256 ?? "") ||
        !validateDependencyReceipt(dependency.receipt, dependency, grant) ||
        hashTaskReceipt(dependency.receipt) !== dependency.receipt_sha256) {
      throw new Error(`invalid integration receipt for dependency ${String(dependency?.task_id ?? "")}`);
    }
    const current = registry.tasks?.[dependency.task_id];
    const integrations = [current?.integration, ...(allowHistoricalDeps && Array.isArray(current?.integration_history) ? current.integration_history : [])]
      .filter(Boolean);
    const matchingIntegration = integrations.some((receipt) =>
      hashTaskReceipt(receipt) === dependency.receipt_sha256 && stableTaskJson(receipt) === stableTaskJson(dependency.receipt));
    const results = [current?.result, ...(allowHistoricalDeps ? Object.values(current?.result_history ?? {}) : [])].filter(Boolean);
    const matchingResult = results.some((result) => hashTaskReceipt(result) === dependency.receipt.result_sha256);
    if (current?.status !== "integrated" || !matchingIntegration || !matchingResult) {
      throw new Error(`dependency ${dependency.task_id} is not integrated in the current parent registry`);
    }
    git(parentRoot, "merge-base", "--is-ancestor", dependency.child_head, dependency.integrated_head);
    git(parentRoot, "merge-base", "--is-ancestor", dependency.integrated_head, grant.base_sha);
  }
}

/** Validate an immutable grant against the lane artifacts and current parent-owned evidence. */
export function inspectGrant(grantPath, cwd, { allowHistoricalDeps = false } = {}) {
  const root = fs.realpathSync(cwd);
  const absoluteGrant = path.resolve(grantPath);
  const raw = readArtifact(absoluteGrant, root);
  const grant = JSON.parse(raw);
  if (grant.version !== TASK_PIPELINE_VERSION || grant.kind !== "task-run") throw new Error("unsupported task grant");
  if (!isSafeSessionId(grant.parent_session_id) || !isSafeSessionId(grant.attempt_id) ||
      !isSafeTaskId(grant.task_id) || !isSafeFeatureId(grant.feature_id)) {
    throw new Error("exact parent, attempt, feature and task required");
  }
  if (grant.cwd !== root || absoluteGrant !== taskAdmissionPath(root, grant.attempt_id)) throw new Error("grant worktree/path mismatch");
  if (!HEX_40.test(grant.base_sha ?? "") || !HEX_64.test(grant.plan_sha256 ?? "") || !HEX_64.test(grant.spec_sha256 ?? "")) {
    throw new Error("exact artifact hashes required");
  }
  if (!["LIGHT", "FULL"].includes(grant.mode)) throw new Error("grant mode must be LIGHT or FULL");
  const parentRoot = fs.realpathSync(grant.parent_root);
  if (grant.parent_root !== parentRoot || parentRoot === root) throw new Error("canonical parent_root required");
  if (grant.origin?.kind !== "parent-approved-plan" || typeof grant.origin.plan_review_call_id !== "string" || !grant.origin.plan_review_call_id) {
    throw new Error("host-owned parent plan approval required");
  }
  if (grant.context_handoff !== undefined) {
    const context = validateTaskContextHandoff(grant.context_handoff, { parentSessionId: grant.parent_session_id, taskId: grant.task_id });
    if (!context.ok) throw new Error(context.reason);
  }
  const artifacts = planAndSpec(root, grant.feature_id);
  if (artifacts.planSha256 !== grant.plan_sha256 || artifacts.specSha256 !== grant.spec_sha256) throw new Error("plan/spec hash mismatch");
  const plan = requireParallelPlan(artifacts.plan, grant.feature_id);
  const task = plan.tasks.find((candidate) => candidate.id === grant.task_id);
  if (!task) throw new Error("task missing from canonical plan");
  laneTaskScope(task);
  const parentArtifacts = planAndSpec(parentRoot, grant.feature_id);
  if (parentArtifacts.planSha256 !== grant.plan_sha256 || parentArtifacts.specSha256 !== grant.spec_sha256) {
    throw new Error("parent canonical plan/spec changed after grant");
  }
  const parent = readParentAuthority({ root: parentRoot, sessionId: grant.parent_session_id });
  if (parent.featureId !== grant.feature_id) throw new Error("current parent feature does not match grant");
  validateDependencies({ task, grant, parentRoot, allowHistoricalDeps });
  const branch = git(root, "branch", "--show-current");
  if (typeof grant.branch !== "string" || branch !== grant.branch || /^(main|master)$/.test(branch)) throw new Error("exact task feature branch required");
  git(root, "merge-base", "--is-ancestor", grant.base_sha, "HEAD");
  return {
    grant,
    root,
    parentRoot,
    plan,
    task,
    planPath: artifacts.planPath,
    specPath: artifacts.specPath,
    grantPath: absoluteGrant,
    grantSha: sha256(raw),
  };
}

function seededState(admission) {
  const gateState = `${JSON.stringify({
    session_id: admission.sessionId,
    feature_id: admission.grant.feature_id,
    task_pipeline_version: TASK_PIPELINE_VERSION,
    classification_source: "delegated-task",
    task_run: admission.binding,
  }, null, 2)}\n`;
  const triage = `${JSON.stringify({
    session_id: admission.sessionId,
    mode: admission.grant.mode,
    feature_id: admission.grant.feature_id,
    source: "delegated-task",
  }, null, 2)}\n`;
  return { gateState, triage, claim: JSON.stringify({ session_id: admission.sessionId, grant_sha256: admission.grantSha }) };
}

/** Read-only fresh-admission preflight. It validates every grant/input invariant but writes nothing. */
export function inspectTaskAdmission(grantPath, { cwd, sessionId }) {
  try {
    if (!isSafeSessionId(sessionId)) return fail("safe local session required");
    const info = inspectGrant(grantPath, cwd);
    if (git(info.root, "rev-parse", "HEAD") !== info.grant.base_sha) return fail("initial base mismatch");
    const pending = [
      ...git(info.root, "diff", "--name-only", "-z", "HEAD", "--").split("\0"),
      ...git(info.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter((entry) => entry && !isVolatileHarnessPath(entry));
    if (pending.length) return fail(`initial product worktree is dirty: ${JSON.stringify(pending.slice(0, 20))}`);
    if (fs.existsSync(sessionStateDir(info.root, sessionId))) return fail("local session state already exists");
    if (fs.existsSync(`${info.grantPath}.claim`)) return fail("task attempt already claimed");
    const binding = {
      grant_path: info.grantPath,
      grant_sha256: info.grantSha,
      parent_session_id: info.grant.parent_session_id,
      attempt_id: info.grant.attempt_id,
      task_id: info.grant.task_id,
    };
    return { ok: true, ...info, sessionId, binding };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Bind a fresh lane session to its grant without manufacturing pipeline evidence. */
export function admitTaskRun(grantPath, { cwd, sessionId }) {
  let admission;
  let seeds;
  let claimCreated = false;
  let claimIdentity;
  const created = [];
  try {
    admission = inspectTaskAdmission(grantPath, { cwd, sessionId });
    if (!admission.ok) return admission;
    seeds = seededState(admission);
    const claimFile = `${admission.grantPath}.claim`;
    const claimFd = fs.openSync(claimFile, "wx", 0o600);
    claimCreated = true;
    try {
      claimIdentity = fs.fstatSync(claimFd);
      fs.writeFileSync(claimFd, seeds.claim);
    } finally {
      fs.closeSync(claimFd);
    }
    fs.mkdirSync(sessionStateDir(admission.root, sessionId), { recursive: true });
    for (const [file, text] of [[gateStateFile(admission.root, sessionId), seeds.gateState], [triageFile(admission.root, sessionId), seeds.triage]]) {
      fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      created.push([file, text]);
    }
    return admission;
  } catch (error) {
    // No model can run inside admission. Roll back only bytes created by this exact call;
    // divergent state is preserved for explicit recovery instead of being guessed away.
    try {
      for (const [file, text] of created) {
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) fs.unlinkSync(file);
      }
      if (created.length) {
        try { fs.rmdirSync(sessionStateDir(admission.root, sessionId)); } catch { /* preserve non-empty */ }
      }
      if (claimCreated && admission?.grantPath && claimIdentity) {
        const claimFile = `${admission.grantPath}.claim`;
        const current = fs.lstatSync(claimFile);
        if (current.isFile() && current.dev === claimIdentity.dev && current.ino === claimIdentity.ino &&
            seeds.claim.startsWith(fs.readFileSync(claimFile, "utf8"))) {
          fs.unlinkSync(claimFile);
        }
      }
    } catch { /* preserve the original admission failure */ }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Remove only a just-created, still-pristine admission after the host proves the spawn failed. */
export function rollbackTaskAdmission(admission) {
  try {
    if (!admission?.ok || !isSafeSessionId(admission.sessionId) || typeof admission.grantPath !== "string") return false;
    const seeds = seededState(admission);
    const stateDir = sessionStateDir(admission.root, admission.sessionId);
    const claimFile = `${admission.grantPath}.claim`;
    if (fs.readFileSync(claimFile, "utf8") !== seeds.claim ||
        fs.readFileSync(gateStateFile(admission.root, admission.sessionId), "utf8") !== seeds.gateState ||
        fs.readFileSync(triageFile(admission.root, admission.sessionId), "utf8") !== seeds.triage) return false;
    if (fs.readdirSync(stateDir).some((name) => !["gate-state.json", "triage.json"].includes(name))) return false;
    if (fs.existsSync(laneLedgerFile(admission.root, admission.sessionId))) return false;
    fs.unlinkSync(gateStateFile(admission.root, admission.sessionId));
    fs.unlinkSync(triageFile(admission.root, admission.sessionId));
    fs.rmdirSync(stateDir);
    fs.unlinkSync(claimFile);
    return true;
  } catch {
    return false;
  }
}

/** Revalidate the admitted attempt at every authority boundary. */
export function readTaskRunBinding(cwd, sessionId) {
  try {
    if (!isSafeSessionId(sessionId)) return fail("safe local session required");
    const root = fs.realpathSync(cwd);
    const stateFile = gateStateFile(root, sessionId);
    if (!fs.existsSync(stateFile)) return { ok: false, absent: true, reason: "[task-run] task-run state absent" };
    const state = JSON.parse(readArtifact(stateFile, root));
    if (!state.task_run) return { ok: false, absent: true, reason: "[task-run] ordinary session" };
    if (state.session_id !== sessionId || state.task_pipeline_version !== TASK_PIPELINE_VERSION ||
        state.classification_source !== "delegated-task") return fail("local session mismatch");
    const info = inspectGrant(state.task_run.grant_path, root, { allowHistoricalDeps: true });
    if (info.grantSha !== state.task_run.grant_sha256) return fail("grant changed");
    const claim = JSON.parse(readArtifact(`${info.grantPath}.claim`, root));
    if (claim.session_id !== sessionId || claim.grant_sha256 !== info.grantSha) return fail("attempt claim mismatch");
    if (state.feature_id !== info.grant.feature_id || state.task_run.task_id !== info.grant.task_id ||
        state.task_run.attempt_id !== info.grant.attempt_id || state.task_run.parent_session_id !== info.grant.parent_session_id ||
        state.task_run.grant_path !== info.grantPath) {
      return fail("state/grant identity mismatch");
    }
    const triage = JSON.parse(readArtifact(triageFile(root, sessionId), root));
    if (triage.session_id !== sessionId || triage.feature_id !== info.grant.feature_id || triage.mode !== info.grant.mode) {
      return fail("lane triage changed");
    }
    return { ok: true, ...info, sessionId, binding: state.task_run };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** The lane system prompt: the stable task runtime plus the one assigned contract. */
export function taskRunPrompt(taskRuntime, admission, { resumed = false } = {}) {
  if (typeof taskRuntime !== "string" || !taskRuntime.trim()) throw new Error("stable task runtime prompt required");
  const contract = {
    feature_id: admission.grant.feature_id,
    mode: admission.grant.mode,
    task: admission.task,
    frozen_paths: laneFrozenPaths(admission.task),
    dependencies: admission.grant.dependencies.map(({ task_id, child_head, integrated_head }) => ({ task_id, child_head, integrated_head })),
    plan_sha256: admission.grant.plan_sha256,
    spec_sha256: admission.grant.spec_sha256,
    plan_path: path.relative(admission.root, admission.planPath),
    spec_path: path.relative(admission.root, admission.specPath),
    base_sha: admission.grant.base_sha,
    branch: admission.grant.branch,
    binding: admission.binding,
    dispatch_routes: laneDispatchRoutes(admission.plan, admission.task),
    ...(admission.grant.context_handoff === undefined ? {} : { context_handoff: admission.grant.context_handoff }),
  };
  return `${taskRuntime.trim()}\n\n[HARNESS_TASK_RUN]\n${JSON.stringify({ resumed: resumed === true, contract }, null, 2)}\n[/HARNESS_TASK_RUN]`;
}
