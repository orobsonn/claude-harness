/** @description Same-session compaction context for OpenCode's stable feature plan. */

import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import { executionPlanPath, gateStatePath } from "../../shared/lib/path-helpers.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";

export const MAX_REINJECT_BYTES = 8 * 1024;
const RECOVERY_OPEN = "<HARNESS_RECOVERY_JSON>\n";
const RECOVERY_CLOSE = "\n</HARNESS_RECOVERY_JSON>";

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** @description Resolve one project root and reject directory/worktree disagreement. */
export function resolveSessionProjectRoot(directory, worktree) {
  try {
    const directoryRoot = typeof directory === "string" && directory ? fs.realpathSync(directory) : null;
    const worktreeRoot = typeof worktree === "string" && worktree ? fs.realpathSync(worktree) : null;
    if (worktreeRoot && directoryRoot && !inside(worktreeRoot, directoryRoot)) return null;
    return worktreeRoot ?? directoryRoot;
  } catch {
    return null;
  }
}

function readSafeJson(projectRoot, file, maxBytes = 1024 * 1024) {
  try {
    const root = fs.realpathSync(projectRoot);
    const resolved = path.resolve(file);
    if (!inside(root, resolved)) return null;
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return null;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || fs.realpathSync(resolved) !== resolved) return null;
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  for (let length = Math.max(0, maxBytes); length >= 0; length -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch { /* back up to a complete UTF-8 code point */ }
  }
  return "";
}

/** @description Encode canonical JSON inside fixed delimiters with a hard UTF-8 byte ceiling. */
export function encodeRecoveryPayload(payload, maxBytes = MAX_REINJECT_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes <= Buffer.byteLength(RECOVERY_OPEN + RECOVERY_CLOSE)) return null;
  const wrap = (value) => `${RECOVERY_OPEN}${JSON.stringify(value)}${RECOVERY_CLOSE}`;
  const direct = wrap(payload);
  if (Buffer.byteLength(direct, "utf8") <= maxBytes) return direct;
  const shell = { schema: "harness.compaction-recovery.v1", truncated: true, truncated_json_prefix: "" };
  const source = JSON.stringify(payload);
  let low = 0;
  let high = Math.min(Buffer.byteLength(source, "utf8"), maxBytes);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    shell.truncated_json_prefix = utf8Prefix(source, middle);
    if (Buffer.byteLength(wrap(shell), "utf8") <= maxBytes) low = middle + 1;
    else high = middle - 1;
  }
  shell.truncated_json_prefix = utf8Prefix(source, Math.max(0, high));
  const encoded = wrap(shell);
  return Buffer.byteLength(encoded, "utf8") <= maxBytes ? encoded : null;
}

/** @description Reinject facts from this session only; never infer a phase or adopt another run. */
export function buildSessionRecovery(projectRoot, sessionId) {
  if (!projectRoot || !isSafeSessionId(sessionId)) return { ok: false, reason: "invalid session identity" };
  const stateResult = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!stateResult.ok) return stateResult;
  const state = readSafeJson(projectRoot, stateResult.path);
  if (!state || state.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };

  const featureId = state.feature_id;
  const mode = state.mode;
  if (!isSafeFeatureId(featureId) || !["no-ceremony", "QUICK", "LIGHT", "FULL"].includes(mode)) {
    return { ok: false, reason: "invalid recovery identity" };
  }

  const planResult = executionPlanPath({ projectRoot, runtime: "opencode", featureId });
  if (!planResult.ok) return planResult;
  const plan = readSafeJson(projectRoot, planResult.path);
  const validated = plan ? validatePlan(plan, { expect: "full" }) : { ok: false };
  const matchingPlan = validated.ok && plan.feature_id === featureId && String(plan.mode).toUpperCase() === mode;
  const totalTasks = matchingPlan && Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const canonicalRelativePath = path.relative(projectRoot, planResult.path);
  const context = encodeRecoveryPayload({
    schema: "harness.compaction-recovery.v1",
    mode,
    feature_id: featureId,
    canonical_plan_path: canonicalRelativePath,
    plan_available: matchingPlan,
    total_tasks: totalTasks,
  });
  if (!context) return { ok: false, reason: "recovery payload byte budget too small" };
  return { ok: true, context, statePath: stateResult.path };
}

export default { buildSessionRecovery, encodeRecoveryPayload, resolveSessionProjectRoot };
