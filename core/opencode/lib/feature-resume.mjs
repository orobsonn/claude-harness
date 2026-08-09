/** @description Locate one prior feature run and adopt its durable state into a new OpenCode session. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";
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

/** @description Find the most recently updated prior run for a feature. Never throws. */
export function findFeatureResume(projectRoot, featureId) {
  if (typeof projectRoot !== "string" || !isSafeFeatureId(featureId)) return null;
  const root = plansRoot({ projectRoot, runtime: "opencode" });
  if (!root.ok) return null;
  try {
    const suffix = `-${featureId}`;
    const candidates = fs.readdirSync(root.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
      .map((entry) => {
        const sessionId = entry.name.slice(0, -suffix.length);
        const planPath = path.join(root.path, entry.name, "execution-plan.json");
        const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
        if (!isSafeSessionId(sessionId) || !statePath.ok) return null;
        const plan = readJson(planPath);
        const state = readJson(statePath.path);
        if (!plan || !state || plan.feature_id !== featureId || state.feature_id !== featureId || state.session_id !== sessionId) return null;
        if (!Array.isArray(plan.tasks) || (plan.kind === "stub" && plan.tasks.length !== 0)) return null;
        if (state.planner_status === "usable") {
          const binding = state.planner_plan_binding;
          if (!binding || typeof binding !== "object" || typeof binding.snapshot_path !== "string" || typeof binding.snapshot_file_hash !== "string") return null;
          const snapshot = path.resolve(projectRoot, binding.snapshot_path);
          if (!snapshot.startsWith(path.resolve(projectRoot) + path.sep)) return null;
          const snapshotRaw = fs.readFileSync(snapshot);
          const canonicalRaw = fs.readFileSync(planPath);
          const snapshotPlan = readJson(snapshot);
          if (!snapshotPlan || crypto.createHash("sha256").update(snapshotRaw).digest("hex") !== binding.snapshot_file_hash ||
              !snapshotRaw.equals(canonicalRaw) || semanticPlanHash(plan) !== binding.snapshot_hash ||
              !validatePlan(plan, { expect: "full", expectedModelStrategy: binding.expected_model_strategy }).ok) return null;
        }
        const mtimeMs = Math.max(fs.statSync(planPath).mtimeMs, fs.statSync(statePath.path).mtimeMs);
        return { sessionId, planPath, statePath: statePath.path, plan, state, mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
    return candidates[0] ?? null;
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
      resumed_from_session_id: resume.sessionId,
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
        return { ok: false, reason: "target session already has harness state" };
      }
      // The host creates these session-local facts before classify. They are not delivery state.
      return { ...adopted, ...current, session_id: targetSessionId, session_status: "active" };
    });
    if (!persisted.ok) return { ok: false, reason: persisted.reason };
    return { ok: true, statePath: target.path, planPath: resume.planPath, sourceSessionId: resume.sessionId };
  } catch {
    return { ok: false, reason: "feature resume adoption failed" };
  }
}

export default { findFeatureResume, adoptFeatureResume };
