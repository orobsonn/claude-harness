/** @description Locate one prior feature run and adopt its durable state into a new OpenCode session. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { parseAbsolutionEntry } from "../../shared/lib/absolution.mjs";
import { gateStatePath, plansRoot } from "../../shared/lib/path-helpers.mjs";
import { withGateStateLock } from "./gate-state.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { semanticPlanHash } from "./plan-hash.mjs";

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalPlanSessionId(plansPath, featureId, state, sessionId) {
  const ownPlan = path.join(plansPath, `${sessionId}-${featureId}`, "execution-plan.json");
  if (fs.existsSync(ownPlan)) return sessionId;
  return isSafeSessionId(state?.resumed_from_session_id) ? state.resumed_from_session_id : sessionId;
}

function verifiedTaskIds(state, featureId, taskIds, key) {
  if (!Array.isArray(state?.[key])) return new Set();
  const found = new Set();
  for (const entry of state[key]) {
    const parsed = parseAbsolutionEntry(entry);
    if (!parsed || !parsed.prefix.startsWith(`${featureId}/`)) continue;
    const taskId = parsed.prefix.slice(featureId.length + 1);
    if (isSafeTaskId(taskId) && taskIds.has(taskId)) found.add(taskId);
  }
  return found;
}

function countVerifiedTasks(state, featureId, taskIds, key) {
  return verifiedTaskIds(state, featureId, taskIds, key).size;
}

function verifiedEntries(state, featureId, plan) {
  const taskIds = new Set(plan.tasks.map((task) => task?.id).filter(isSafeTaskId));
  if (!Array.isArray(state?.capture_verified)) return [];
  return [...new Set(state.capture_verified.filter((entry) => {
    const parsed = parseAbsolutionEntry(entry);
    if (!parsed || !parsed.prefix.startsWith(`${featureId}/`)) return false;
    const taskId = parsed.prefix.slice(featureId.length + 1);
    return isSafeTaskId(taskId) && taskIds.has(taskId);
  }))];
}

function isTerminalState(state) {
  // final_review_done is the final host-stamped engineering phase. Reopening it
  // would repeatedly revive an already delivered feature when no delivery_status
  // writer exists.
  return state?.delivery_status === "delivered" || state?.final_review_done === true;
}

/** @description Validate one session state against its canonical, content-bound plan. */
function readResumeCandidate(projectRoot, plansPath, featureId, sessionId) {
  const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!statePath.ok) return null;
  const state = readJson(statePath.path);
  if (!state || state.feature_id !== featureId || state.session_id !== sessionId || isTerminalState(state)) return null;
  if (state.planner_active_attempt != null) return null;
  const planSessionId = canonicalPlanSessionId(plansPath, featureId, state, sessionId);
  const planPath = path.join(plansPath, `${planSessionId}-${featureId}`, "execution-plan.json");
  const plan = readJson(planPath);
  if (!plan || plan.feature_id !== featureId || !Array.isArray(plan.tasks)) return null;
  const stateStat = fs.statSync(statePath.path);
  const planStat = fs.statSync(planPath);
  if (state.planner_status !== "usable") {
    if (state.planner_status === "running") return null;
    if (planSessionId !== sessionId || plan.kind !== "stub" || plan.tasks.length !== 0) return null;
    return { sessionId, planSessionId, planPath, statePath: statePath.path, plan, state, mtimeMs: stateStat.mtimeMs, planMtimeMs: planStat.mtimeMs, approved: false, captured: 0, fidelity: 0 };
  }
  const binding = state.planner_plan_binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.session_id !== sessionId || binding.feature_id !== featureId ||
      typeof binding.snapshot_path !== "string" || typeof binding.snapshot_file_hash !== "string" || typeof binding.snapshot_hash !== "string" ||
      typeof binding.file_hash !== "string" || typeof binding.semantic_hash !== "string") return null;
  const expectedRelative = `.opencode/plans/.state/${sessionId}/bound-plans/${binding.snapshot_file_hash}.json`;
  if (binding.snapshot_path !== expectedRelative || !/^[0-9a-f]{64}$/.test(binding.snapshot_file_hash)) return null;
  const snapshot = path.resolve(projectRoot, binding.snapshot_path);
  if (!snapshot.startsWith(path.resolve(projectRoot) + path.sep)) return null;
  const snapshotRaw = fs.readFileSync(snapshot);
  const canonicalRaw = fs.readFileSync(planPath);
  const snapshotPlan = readJson(snapshot);
  const fileHash = crypto.createHash("sha256").update(canonicalRaw).digest("hex");
  if (!snapshotPlan || !snapshotRaw.equals(canonicalRaw) || fileHash !== binding.snapshot_file_hash || fileHash !== binding.file_hash ||
      semanticPlanHash(plan) !== binding.snapshot_hash || semanticPlanHash(plan) !== binding.semantic_hash ||
      !validatePlan(plan, { expect: "full", expectedModelStrategy: binding.expected_model_strategy }).ok) return null;
  const taskIds = new Set(plan.tasks.map((task) => task?.id).filter(isSafeTaskId));
  const approved = state.plan_review_verdict === "APPROVE" && state.planner_active_attempt == null;
  const captureTaskIds = verifiedTaskIds(state, featureId, taskIds, "capture_verified");
  return {
    sessionId,
    planSessionId,
    planPath,
    statePath: statePath.path,
    plan,
    state,
    mtimeMs: stateStat.mtimeMs,
    planMtimeMs: planStat.mtimeMs,
    planIdentity: `${binding.snapshot_file_hash}:${binding.snapshot_hash}`,
    approved,
    captured: captureTaskIds.size,
    fidelity: countVerifiedTasks(state, featureId, taskIds, "fidelity_pass"),
    captureTaskIds,
  };
}

function dominatesCaptureProgress(left, right) {
  for (const taskId of right.captureTaskIds) {
    if (!left.captureTaskIds.has(taskId)) return false;
  }
  return true;
}

/** @description Find the most advanced resumable state within one unambiguous approved plan identity. */
export function findFeatureResume(projectRoot, featureId) {
  if (typeof projectRoot !== "string" || !isSafeFeatureId(featureId)) return null;
  const root = plansRoot({ projectRoot, runtime: "opencode" });
  if (!root.ok) return null;
  try {
    const stateRoot = path.join(root.path, ".state");
    const candidates = fs.readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeSessionId(entry.name))
      .map((entry) => {
        try {
          return readResumeCandidate(projectRoot, root.path, featureId, entry.name);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const approved = candidates.filter((candidate) => candidate.approved);
    if (approved.length > 0) {
      const identities = new Set(approved.map((candidate) => candidate.planIdentity));
      if (identities.size !== 1) return null;
      const dominant = approved.filter((candidate) => approved.every((other) => dominatesCaptureProgress(candidate, other)));
      if (dominant.length === 0) return null;
      return dominant.sort((a, b) => b.captured - a.captured || b.fidelity - a.fidelity || b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))[0] ?? null;
    }
    return candidates.sort((a, b) => b.planMtimeMs - a.planMtimeMs || b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))[0] ?? null;
  } catch {
    return null;
  }
}

/** @description Copy prior workflow state and its bound snapshot for a new session without rewriting the plan. */
export function adoptFeatureResume(projectRoot, targetSessionId, resume, requestedMode) {
  if (!isSafeSessionId(targetSessionId) || !resume?.state || !resume?.planPath) return { ok: false, reason: "invalid resume identity" };
  const target = gateStatePath({ projectRoot, runtime: "opencode", sessionId: targetSessionId });
  if (!target.ok) return { ok: false, reason: target.reason };
  try {
    const source = resume.state;
    const binding = source.planner_plan_binding;
    const ranks = { "no-ceremony": 0, QUICK: 1, LIGHT: 2, FULL: 3 };
    const sourceMode = typeof source.mode === "string" ? source.mode : "";
    const mode = (ranks[requestedMode] ?? -1) > (ranks[sourceMode] ?? -1) ? requestedMode : sourceMode;
    const adopted = {
      ...source,
      session_id: targetSessionId,
      resumed_from_session_id: isSafeSessionId(resume.planSessionId) ? resume.planSessionId : resume.sessionId,
      resume_state_source_session_id: resume.sessionId,
      capture_verified: verifiedEntries(source, source.feature_id, resume.plan),
      fidelity_pass: [],
      hand_finished: [],
      regate_pending: [],
      regate_passed: [],
      planner_active_attempt: null,
      mode,
      peak_mode: mode,
      session_status: "active",
      session_completed_at: null,
      session_reopened_at: new Date().toISOString(),
    };
    if (binding && typeof binding === "object" && typeof binding.snapshot_file_hash === "string" && typeof binding.snapshot_path === "string") {
      const sourceSnapshot = path.resolve(projectRoot, binding.snapshot_path);
      const targetRelative = `.opencode/plans/.state/${targetSessionId}/bound-plans/${binding.snapshot_file_hash}.json`;
      const targetSnapshot = path.resolve(projectRoot, targetRelative);
      if (!sourceSnapshot.startsWith(path.resolve(projectRoot) + path.sep) || !fs.existsSync(sourceSnapshot)) {
        return { ok: false, reason: "source planner snapshot missing" };
      }
      fs.mkdirSync(path.dirname(targetSnapshot), { recursive: true });
      if (fs.existsSync(targetSnapshot)) {
        if (!fs.readFileSync(sourceSnapshot).equals(fs.readFileSync(targetSnapshot))) {
          return { ok: false, reason: "target planner snapshot conflicts" };
        }
      } else {
        fs.copyFileSync(sourceSnapshot, targetSnapshot, fs.constants.COPYFILE_EXCL);
      }
      adopted.planner_plan_binding = { ...binding, session_id: targetSessionId, snapshot_path: targetRelative };
    }
    const persisted = withGateStateLock(target.path, (current) => {
      const bootstrapKeys = new Set([
        "operator_session_model",
        "autonomy_directive",
        "autonomy_continuation",
        "session_reopened_at",
        "session_status",
      ]);
      if (Object.keys(current).some((key) => !bootstrapKeys.has(key))) {
        const currentBinding = current.planner_plan_binding;
        const adoptedBinding = adopted.planner_plan_binding;
        if (
          current.session_id === targetSessionId &&
          current.feature_id === adopted.feature_id &&
          current.resumed_from_session_id === adopted.resumed_from_session_id &&
          current.resume_state_source_session_id === adopted.resume_state_source_session_id &&
          ((currentBinding == null && adoptedBinding == null) ||
            (currentBinding && adoptedBinding &&
              currentBinding.snapshot_file_hash === adoptedBinding.snapshot_file_hash &&
              currentBinding.snapshot_path === adoptedBinding.snapshot_path))
        ) return current;
        return { ok: false, reason: "target session already has harness state" };
      }
      // The host creates these session-local facts before classify. They are not delivery state.
      return { ...adopted, ...current, session_id: targetSessionId, session_status: "active" };
    });
    if (!persisted.ok) return { ok: false, reason: persisted.reason };
    return { ok: true, statePath: target.path, planPath: resume.planPath, sourceSessionId: resume.sessionId, planSessionId: resume.planSessionId ?? resume.sessionId };
  } catch {
    return { ok: false, reason: "feature resume adoption failed" };
  }
}

export default { findFeatureResume, adoptFeatureResume };
