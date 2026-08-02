/** @description Canonical plan fingerprints plus disk reconciliation for planner attempt bindings. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gateStatePath, planDir } from "../../shared/lib/path-helpers.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { isCompleteExpectedModelStrategy } from "../../shared/lib/model-strategy-projection.mjs";
import { withGateStateLock } from "./gate-state.mjs";
import { semanticPlanHash } from "./plan-hash.mjs";

export { semanticPlanHash };

/** @description Read and fingerprint the one canonical plan artifact for a session/feature. */
export function readPlannerArtifact(projectRoot, sessionId, featureId, options = {}) {
  const pd = planDir({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!pd.ok) return { exists: false, valid: false, fingerprint: "missing" };
  const planPath = path.join(pd.path, "execution-plan.json");
  try {
    const raw = fs.readFileSync(planPath);
    const stat = fs.statSync(planPath);
    const fileHash = crypto.createHash("sha256").update(raw).digest("hex");
    const fingerprint = `${fileHash}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let plan;
    try {
      plan = JSON.parse(raw.toString("utf8"));
    } catch {
      return { exists: true, valid: false, fingerprint, fileHash, mtimeMs: stat.mtimeMs, size: stat.size, path: planPath };
    }
    let validation;
    try {
      validation = (options.validatePlanFn ?? validatePlan)(plan, { expect: "full" });
    } catch {
      return {
        exists: true, valid: false, validationError: "validator_internal", plan, raw,
        semanticHash: semanticPlanHash(plan), fileHash, fingerprint, mtimeMs: stat.mtimeMs, size: stat.size, path: planPath,
      };
    }
    if (!validation || typeof validation.ok !== "boolean" || !Array.isArray(validation.errors)) {
      return {
        exists: true, valid: false, validationError: "validator_internal", plan, raw,
        semanticHash: semanticPlanHash(plan), fileHash, fingerprint, mtimeMs: stat.mtimeMs, size: stat.size, path: planPath,
      };
    }
    return {
      exists: true,
      valid: validation.ok && Array.isArray(plan.tasks) && plan.tasks.length >= 1,
      errors: validation.errors,
      plan,
      raw,
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
 * @description Validate and serialize the exact bytes that will be bound and promoted.
 * The prepared buffer is intentionally shared by the immutable snapshot and canonical path:
 * equal semantic JSON is not enough to prove that both authority artifacts are identical.
 */
export function prepareCanonicalPlan(projectRoot, sessionId, featureId, plan, options = {}) {
  if (options.requireExpectedModelStrategy !== false && !isCompleteExpectedModelStrategy(options.expectedModelStrategy)) {
    return { ok: false, reason: "canonical planner persistence requires a complete expected model strategy" };
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, reason: "returned plan is not an object" };
  }
  if (!featureId) return { ok: false, reason: "session has no feature_id to bind the plan to" };
  if (plan.feature_id !== featureId) {
    return { ok: false, reason: "returned plan feature_id does not match the session feature" };
  }
  const validation = validatePlan(plan, options.requireExpectedModelStrategy !== false
    ? { expect: "full", expectedModelStrategy: options.expectedModelStrategy }
    : { expect: "full" });
  if (!validation.ok || !Array.isArray(plan.tasks) || plan.tasks.length < 1) {
    const detail = Array.isArray(validation.errors) ? validation.errors.slice(0, 3).join("; ") : "";
    return { ok: false, reason: `returned plan failed structural validation${detail ? `: ${detail}` : ""}` };
  }
  const pd = planDir({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!pd.ok) return { ok: false, reason: pd.reason ?? "canonical plan directory unresolved" };
  const raw = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return {
    ok: true,
    plan,
    raw,
    semanticHash: semanticPlanHash(plan),
    fileHash: crypto.createHash("sha256").update(raw).digest("hex"),
    authoritative: options.requireExpectedModelStrategy !== false,
    path: path.join(pd.path, "execution-plan.json"),
  };
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
 * @param {{ expectedModelStrategy?: unknown }} [options]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function writeCanonicalPlan(projectRoot, sessionId, featureId, plan, options = {}) {
  const prepared = options.prepared ?? prepareCanonicalPlan(projectRoot, sessionId, featureId, plan, options);
  if (!prepared.ok) return prepared;
  return writePreparedCanonicalPlan(prepared);
}

/** @description Atomically promote previously validated canonical bytes. */
export function writePreparedCanonicalPlan(prepared) {
  const planPath = prepared.path;
  const temp = `${planPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(temp, prepared.raw);
    fs.renameSync(temp, planPath);
    return { ok: true, path: planPath, fileHash: prepared.fileHash };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* temp cleanup is best-effort; the canonical file was never replaced */
    }
    return { ok: false, reason: "canonical plan write failed" };
  }
}

/** @description Reject semantic-only equality: persistence authority is the exact staged buffer. */
export function preparedPlanMatchesArtifacts(prepared, artifact, snapshot) {
  return Boolean(
    prepared?.authoritative === true &&
    typeof prepared.fileHash === "string" &&
    artifact?.valid && snapshot?.valid &&
    artifact.semanticHash === prepared.semanticHash &&
    snapshot.semanticHash === prepared.semanticHash &&
    artifact.fileHash === prepared.fileHash &&
    snapshot.fileHash === prepared.fileHash,
  );
}

/** @description Persist a content-addressed immutable-by-construction plan snapshot for dispatch prompts. */
export function writeBoundPlanSnapshot(projectRoot, sessionId, artifact) {
  let temp = "";
  try {
    if (!artifact?.valid || typeof artifact.semanticHash !== "string") return { ok: false, reason: "invalid snapshot source" };
    const dir = path.join(projectRoot, ".opencode", "plans", ".state", sessionId, "bound-plans");
    const content = Buffer.isBuffer(artifact.raw)
      ? artifact.raw
      : Buffer.from(`${JSON.stringify(artifact.plan, null, 2)}\n`, "utf8");
    const expectedFileHash = crypto.createHash("sha256").update(content).digest("hex");
    const snapshotPath = path.join(dir, `${expectedFileHash}.json`);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(snapshotPath)) {
      temp = `${snapshotPath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o444 });
      fs.renameSync(temp, snapshotPath);
      temp = "";
      fs.chmodSync(snapshotPath, 0o444);
    }
    const snapshot = readBoundPlanSnapshot(snapshotPath);
    if (!snapshot.valid || snapshot.semanticHash !== artifact.semanticHash || snapshot.fileHash !== expectedFileHash) {
      return { ok: false, reason: "content-addressed snapshot hash mismatch" };
    }
    return {
      ok: true,
      snapshot,
      relativePath: path.relative(projectRoot, snapshotPath),
    };
  } catch {
    if (temp) {
      try { fs.rmSync(temp, { force: true }); } catch { /* cleanup is best-effort */ }
    }
    return { ok: false, reason: "content-addressed snapshot write failed" };
  }
}

/** @description Read and validate a content-addressed bound plan snapshot. */
export function readBoundPlanSnapshot(snapshotPath, options = {}) {
  try {
    const raw = fs.readFileSync(snapshotPath);
    const fileHash = crypto.createHash("sha256").update(raw).digest("hex");
    let plan;
    try {
      plan = JSON.parse(raw.toString("utf8"));
    } catch {
      return { valid: false, fileHash, path: snapshotPath };
    }
    let validation;
    try {
      validation = (options.validatePlanFn ?? validatePlan)(plan, { expect: "full" });
    } catch {
      return { valid: false, validationError: "validator_internal", plan, semanticHash: semanticPlanHash(plan), fileHash, path: snapshotPath };
    }
    if (!validation || typeof validation.ok !== "boolean" || !Array.isArray(validation.errors)) {
      return { valid: false, validationError: "validator_internal", plan, semanticHash: semanticPlanHash(plan), fileHash, path: snapshotPath };
    }
    return {
      valid: validation.ok && Array.isArray(plan.tasks) && plan.tasks.length >= 1,
      plan,
      semanticHash: semanticPlanHash(plan),
      fileHash,
      path: snapshotPath,
    };
  } catch {
    return { valid: false };
  }
}

/** @description Bind and verify the canonical plan under the gate-state lock. */
export function reconcilePlannerStateFromDisk(projectRoot, sessionId, _now = Date.now(), options = {}) {
  const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!statePath.ok) return { ok: false, reason: statePath.reason };
  let snapshot = null;
  let validatorFailed = false;
  const persisted = withGateStateLock(statePath.path, (previous) => {
    let state = previous;
    const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
    // Verification only: an unbound canonical plan is inert. Planner-recovery performs the
    // write-and-bind transaction; downstream readers must never adopt pending disk bytes.
    if (state.planner_status === "usable") {
      const binding = state.planner_plan_binding;
      const expectedRelativePath = typeof binding?.snapshot_file_hash === "string"
        ? `.opencode/plans/.state/${sessionId}/bound-plans/${binding.snapshot_file_hash}.json`
        : "";
      if (
        !binding || typeof binding !== "object" || Array.isArray(binding) ||
        typeof binding.snapshot_hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(binding.snapshot_hash) ||
        typeof binding.snapshot_file_hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(binding.snapshot_file_hash) ||
        typeof binding.snapshot_path !== "string" ||
        binding.snapshot_path !== expectedRelativePath
      ) {
        state = { ...state, planner_status: "plan_invalid", planner_binding_error: "snapshot path is not canonical byte-addressed identity" };
      } else {
        const snapshotPath = path.resolve(projectRoot, expectedRelativePath);
        snapshot = readBoundPlanSnapshot(snapshotPath, options);
        const canonical = readPlannerArtifact(projectRoot, sessionId, featureId, options);
        if (
          !snapshot.plan ||
          !canonical.plan ||
          snapshot.plan?.feature_id !== featureId ||
          snapshot.semanticHash !== binding.snapshot_hash ||
          snapshot.fileHash !== binding.snapshot_file_hash ||
          snapshot.semanticHash !== binding.semantic_hash ||
          canonical.semanticHash !== binding.semantic_hash ||
          canonical.fileHash !== binding.file_hash ||
          canonical.fileHash !== binding.snapshot_file_hash ||
          canonical.fingerprint !== binding.fingerprint
        ) {
          state = { ...state, planner_status: "plan_invalid", planner_binding_error: "bound snapshot integrity failed" };
        } else if (snapshot.validationError === "validator_internal" || canonical.validationError === "validator_internal") {
          validatorFailed = true;
        } else if (!snapshot.valid || !canonical.valid) {
          state = { ...state, planner_status: "plan_invalid", planner_binding_error: "bound snapshot plan validation failed" };
        }
      }
    }
    return state;
  });
  return persisted.ok ? { ...persisted, artifact: snapshot, validatorFailed } : persisted;
}

export default {
  readBoundPlanSnapshot,
  readPlannerArtifact,
  reconcilePlannerStateFromDisk,
  semanticPlanHash,
  prepareCanonicalPlan,
  preparedPlanMatchesArtifacts,
  writeBoundPlanSnapshot,
  writeCanonicalPlan,
  writePreparedCanonicalPlan,
};
