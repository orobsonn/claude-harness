/** @description Canonical plan fingerprints plus disk reconciliation for planner attempt bindings. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gateStatePath, planDir } from "../../shared/lib/path-helpers.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { withGateStateLock } from "./gate-state.mjs";
import { semanticPlanHash } from "./plan-hash.mjs";
import { bindPlannerArtifact, reconcilePlannerLease } from "./planner-state.mjs";
import { resolvePlannerFallbackConfig } from "./planner-fallback-config.mjs";

export { semanticPlanHash };

/** @description Read and fingerprint the one canonical plan artifact for a session/feature. */
export function readPlannerArtifact(projectRoot, sessionId, featureId) {
  const pd = planDir({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!pd.ok) return { exists: false, valid: false, fingerprint: "missing" };
  const planPath = path.join(pd.path, "execution-plan.json");
  try {
    const raw = fs.readFileSync(planPath);
    const stat = fs.statSync(planPath);
    const fileHash = crypto.createHash("sha256").update(raw).digest("hex");
    const fingerprint = `${fileHash}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const plan = JSON.parse(raw.toString("utf8"));
    const validation = validatePlan(plan, { expect: "full" });
    return {
      exists: true,
      valid: validation.ok && Array.isArray(plan.tasks) && plan.tasks.length >= 1,
      errors: validation.errors,
      plan,
      semanticHash: semanticPlanHash(plan),
      fileHash,
      fingerprint,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      path: planPath,
    };
  } catch {
    return { exists: fs.existsSync(planPath), valid: false, fingerprint: "unreadable" };
  }
}

/**
 * @description Persist the planner's returned plan as the canonical artifact.
 * The plugin is the sole author: the plan never round-trips through the orchestrator's
 * output tokens, so it cannot be paraphrased, truncated, or silently dropped.
 * Refuses (without touching the existing file) on any precondition failure — a stale
 * or wrong-feature result must never destroy a good canonical plan.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string} featureId
 * @param {unknown} plan
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function writeCanonicalPlan(projectRoot, sessionId, featureId, plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, reason: "returned plan is not an object" };
  }
  if (!featureId) return { ok: false, reason: "session has no feature_id to bind the plan to" };
  if (plan.feature_id !== featureId) {
    return { ok: false, reason: "returned plan feature_id does not match the session feature" };
  }
  const validation = validatePlan(plan, { expect: "full" });
  if (!validation.ok || !Array.isArray(plan.tasks) || plan.tasks.length < 1) {
    const detail = Array.isArray(validation.errors) ? validation.errors.slice(0, 3).join("; ") : "";
    return { ok: false, reason: `returned plan failed structural validation${detail ? `: ${detail}` : ""}` };
  }
  const pd = planDir({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!pd.ok) return { ok: false, reason: pd.reason ?? "canonical plan directory unresolved" };
  const planPath = path.join(pd.path, "execution-plan.json");
  const temp = `${planPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(pd.path, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fs.renameSync(temp, planPath);
    return { ok: true, path: planPath };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* temp cleanup is best-effort; the canonical file was never replaced */
    }
    return { ok: false, reason: "canonical plan write failed" };
  }
}

/** @description Persist a content-addressed immutable-by-construction plan snapshot for dispatch prompts. */
export function writeBoundPlanSnapshot(projectRoot, sessionId, artifact) {
  try {
    if (!artifact?.valid || typeof artifact.semanticHash !== "string") return { ok: false, reason: "invalid snapshot source" };
    const dir = path.join(projectRoot, ".opencode", "plans", ".state", sessionId, "bound-plans");
    const snapshotPath = path.join(dir, `${artifact.semanticHash}.json`);
    const content = `${JSON.stringify(artifact.plan, null, 2)}\n`;
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(snapshotPath)) {
      const temp = `${snapshotPath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o444 });
      fs.renameSync(temp, snapshotPath);
      fs.chmodSync(snapshotPath, 0o444);
    }
    const snapshot = readBoundPlanSnapshot(snapshotPath);
    if (!snapshot.valid || snapshot.semanticHash !== artifact.semanticHash) {
      return { ok: false, reason: "content-addressed snapshot hash mismatch" };
    }
    return {
      ok: true,
      snapshot,
      relativePath: path.relative(projectRoot, snapshotPath),
    };
  } catch {
    return { ok: false, reason: "content-addressed snapshot write failed" };
  }
}

/** @description Read and validate a content-addressed bound plan snapshot. */
export function readBoundPlanSnapshot(snapshotPath) {
  try {
    const raw = fs.readFileSync(snapshotPath);
    const plan = JSON.parse(raw.toString("utf8"));
    const validation = validatePlan(plan, { expect: "full" });
    return {
      valid: validation.ok && Array.isArray(plan.tasks) && plan.tasks.length >= 1,
      plan,
      semanticHash: semanticPlanHash(plan),
      fileHash: crypto.createHash("sha256").update(raw).digest("hex"),
      path: snapshotPath,
    };
  } catch {
    return { valid: false };
  }
}

/** @description Reconcile expired claims and bind/verify a canonical plan under the gate-state lock. */
export function reconcilePlannerStateFromDisk(projectRoot, sessionId, now = Date.now(), options = {}) {
  const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!statePath.ok) return { ok: false, reason: statePath.reason };
  const fallback = resolvePlannerFallbackConfig(projectRoot);
  let snapshot = null;
  const persisted = withGateStateLock(statePath.path, (previous) => {
    let state = reconcilePlannerLease(previous, {
      now,
      hasFallback: fallback.available,
      fallbackDiagnostic: fallback.diagnostic,
    }).state;
    const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
    let newlyBound = false;
    if (state.planner_status === "plan_pending_write") {
      snapshot = readPlannerArtifact(projectRoot, sessionId, featureId);
      const bound = bindPlannerArtifact(state, { artifact: snapshot, sessionId, featureId });
      if (bound.ok) {
        state = bound.state;
        newlyBound = true;
      }
    }
    if (newlyBound && state.planner_status === "usable" && state.planner_plan_binding) {
      const artifact = snapshot;
      const binding = state.planner_plan_binding;
      if (
        !artifact.valid ||
        artifact.plan?.feature_id !== featureId ||
        binding.session_id !== sessionId ||
        binding.feature_id !== featureId ||
        artifact.semanticHash !== binding.semantic_hash ||
        artifact.fileHash !== binding.file_hash ||
        artifact.fingerprint !== binding.fingerprint
      ) {
        state = {
          ...state,
          planner_status: "plan_invalid",
          planner_retry_outcome: "not_applicable",
          delivery_status: "delivery-blocked",
          planner_binding_error: "canonical plan changed after attempt binding",
        };
      }
    }
    if (newlyBound && snapshot && state.planner_status === "usable") {
      if (typeof options.beforeConfirm === "function") options.beforeConfirm();
      const confirmed = readPlannerArtifact(projectRoot, sessionId, featureId);
      if (!confirmed.valid || confirmed.fingerprint !== snapshot.fingerprint) {
        state = {
          ...state,
          planner_status: "plan_invalid",
          planner_retry_outcome: "not_applicable",
          delivery_status: "delivery-blocked",
          planner_binding_error: "canonical plan changed during gate decision",
        };
      }
      snapshot = confirmed;
    }
    if (newlyBound && state.planner_status === "usable") {
      const written = writeBoundPlanSnapshot(projectRoot, sessionId, snapshot);
      if (!written.ok) {
        state = {
          ...state,
          planner_status: "plan_invalid",
          delivery_status: "delivery-blocked",
          planner_binding_error: written.reason,
        };
      } else {
        state = {
          ...state,
          planner_plan_binding: {
            ...state.planner_plan_binding,
            snapshot_path: written.relativePath,
            snapshot_hash: written.snapshot.semanticHash,
          },
        };
        snapshot = written.snapshot;
      }
    } else if (state.planner_status === "usable" && state.planner_plan_binding?.snapshot_path) {
      const snapshotPath = path.resolve(projectRoot, state.planner_plan_binding.snapshot_path);
      const expectedRoot = path.resolve(projectRoot, ".opencode", "plans", ".state", sessionId, "bound-plans");
      if (!snapshotPath.startsWith(`${expectedRoot}${path.sep}`)) {
        state = { ...state, planner_status: "plan_invalid", delivery_status: "delivery-blocked", planner_binding_error: "snapshot path escaped state root" };
      } else {
        snapshot = readBoundPlanSnapshot(snapshotPath);
        if (
          !snapshot.valid ||
          snapshot.plan?.feature_id !== featureId ||
          snapshot.semanticHash !== state.planner_plan_binding.snapshot_hash ||
          snapshot.semanticHash !== state.planner_plan_binding.semantic_hash
        ) {
          state = { ...state, planner_status: "plan_invalid", delivery_status: "delivery-blocked", planner_binding_error: "bound snapshot integrity failed" };
        }
      }
    }
    return state;
  });
  return persisted.ok ? { ...persisted, artifact: snapshot } : persisted;
}

export default {
  readBoundPlanSnapshot,
  readPlannerArtifact,
  reconcilePlannerStateFromDisk,
  semanticPlanHash,
  writeBoundPlanSnapshot,
  writeCanonicalPlan,
};
