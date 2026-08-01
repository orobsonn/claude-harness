/** @description Strict session-owned recovery reads and retention cleanup for OpenCode gate state. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../../shared/lib/feature-id.mjs";
import { matchesAbsolution } from "../../../shared/lib/absolution.mjs";
import { gateStatePath, planDir, sharedContextPath } from "../../../shared/lib/path-helpers.mjs";
import { validatePlan } from "../../../shared/lib/validate-plan.mjs";
import { semanticPlanHash } from "../../lib/planner-artifact.mjs";
import { acquireLock, releaseLock, writeGateStateAtomic } from "../../lib/gate-state.mjs";
import { readDualStatus } from "../../../shared/lib/gate-state-shape.mjs";

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REINJECT_BYTES = 8 * 1024;
const MAX_LIST_ITEMS = 50;
const RECOVERY_OPEN = "<HARNESS_RECOVERY_JSON>\n";
const RECOVERY_CLOSE = "\n</HARNESS_RECOVERY_JSON>";

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function lifecycleBasePath(projectRoot, sessionId) {
  return path.join(projectRoot, ".opencode", "plans", ".state", ".session-lifecycle", sessionId);
}

function lifecycleRecordPath(projectRoot, sessionId) {
  return `${lifecycleBasePath(projectRoot, sessionId)}.json`;
}

function writeLifecycleRecord(projectRoot, sessionId, value) {
  const target = lifecycleRecordPath(projectRoot, sessionId);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    return false;
  }
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
    if (!inside(root, resolved)) return { ok: false, reason: "path escaped project root" };
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return { ok: false, reason: "symbolic link rejected" };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return { ok: false, reason: "invalid file shape" };
    if (fs.realpathSync(resolved) !== resolved) return { ok: false, reason: "non-canonical file path" };
    const raw = fs.readFileSync(resolved, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "JSON object required" };
    return { ok: true, value, raw, path: resolved };
  } catch {
    return { ok: false, reason: "missing or unreadable file" };
  }
}

function parsePending(value, featureId, taskIds) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "regate_pending must be an array" };
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, reason: "invalid pending re-gate" };
    const slash = item.indexOf("/");
    const feature = slash > 0 ? item.slice(0, slash) : "";
    const task = slash > 0 ? item.slice(slash + 1) : "";
    if (feature !== featureId || !isSafeTaskId(task) || !taskIds.has(task)) {
      return { ok: false, reason: "pending re-gate identity mismatch" };
    }
    if (!result.includes(item)) result.push(item);
  }
  return { ok: true, value: result };
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

function currentPlan(projectRoot, sessionId, featureId, state) {
  const pd = planDir({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!pd.ok) return pd;
  const canonicalPath = path.join(pd.path, "execution-plan.json");
  const canonical = readSafeJson(projectRoot, canonicalPath);
  if (!canonical.ok || (canonical.value.session_id && canonical.value.session_id !== sessionId) || canonical.value.feature_id !== featureId) {
    return { ok: false, reason: "canonical plan identity mismatch" };
  }

  const binding = state.planner_plan_binding;
  const canonicalRelativePath = `.opencode/plans/${sessionId}-${featureId}/execution-plan.json`;
  if (binding == null) return { ok: true, plan: canonical.value, canonicalPath, canonicalRelativePath };
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      binding.session_id !== sessionId || binding.feature_id !== featureId ||
      typeof binding.snapshot_path !== "string" || typeof binding.snapshot_hash !== "string") {
    return { ok: false, reason: "planner snapshot identity mismatch" };
  }
  const expectedSnapshotPath = `.opencode/plans/.state/${sessionId}/bound-plans/${binding.snapshot_hash}.json`;
  if (!/^[0-9a-f]{64}$/.test(binding.snapshot_hash) || binding.snapshot_path !== expectedSnapshotPath ||
      binding.snapshot_path.includes("\\") || path.isAbsolute(binding.snapshot_path)) {
    return { ok: false, reason: "planner snapshot path is not canonical repo-relative form" };
  }
  const snapshotRoot = path.join(projectRoot, ".opencode", "plans", ".state", sessionId, "bound-plans");
  const snapshotPath = path.resolve(projectRoot, binding.snapshot_path);
  if (!inside(snapshotRoot, snapshotPath)) return { ok: false, reason: "planner snapshot escaped session" };
  const snapshot = readSafeJson(projectRoot, snapshotPath);
  if (!snapshot.ok || snapshot.value.feature_id !== featureId ||
      semanticPlanHash(snapshot.value) !== binding.snapshot_hash ||
      semanticPlanHash(canonical.value) !== binding.snapshot_hash ||
      (typeof binding.semantic_hash === "string" && binding.semantic_hash !== binding.snapshot_hash)) {
    return { ok: false, reason: "planner snapshot integrity mismatch" };
  }
  return { ok: true, plan: snapshot.value, canonicalPath, canonicalRelativePath };
}

/** @description Derive bounded recovery context only from the envelope session's validated state and plan. */
export function buildSessionRecovery(projectRoot, sessionId, options = {}) {
  if (!projectRoot || !isSafeSessionId(sessionId)) return { ok: false, reason: "invalid session identity" };
  const stateResult = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!stateResult.ok) return stateResult;
  const loaded = readSafeJson(projectRoot, stateResult.path);
  if (!loaded.ok || loaded.value.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };
  const state = loaded.value;
  const featureId = state.feature_id;
  const mode = state.mode;
  if (!isSafeFeatureId(featureId) || !["no-ceremony", "QUICK", "LIGHT", "FULL"].includes(mode)) {
    return { ok: false, reason: "invalid recovery identity" };
  }
  const resolvedPlan = currentPlan(projectRoot, sessionId, featureId, state);
  if (!resolvedPlan.ok) return resolvedPlan;
  const tasks = Array.isArray(resolvedPlan.plan.tasks) ? resolvedPlan.plan.tasks : null;
  if (!tasks || tasks.some((task) => !task || typeof task !== "object" || !isSafeTaskId(task.id))) {
    return { ok: false, reason: "invalid plan tasks" };
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const pending = parsePending(state.regate_pending, featureId, taskIds);
  if (!pending.ok || state.regate_passed !== undefined && !Array.isArray(state.regate_passed) ||
      state.capture_verified !== undefined && !Array.isArray(state.capture_verified)) {
    return { ok: false, reason: pending.reason ?? "invalid absolution markers" };
  }
  const isAncestor = typeof options.isAncestor === "function" ? options.isAncestor : () => false;
  const unmatched = pending.value.filter((item) => !matchesAbsolution(item, state.regate_passed, isAncestor));
  const completed = tasks.filter((task) => matchesAbsolution(`${featureId}/${task.id}`, state.capture_verified, isAncestor)).length;
  const shared = sharedContextPath({ projectRoot, runtime: "opencode", sessionId, featureId });
  if (!shared.ok) return shared;
  const context = encodeRecoveryPayload({
    schema: "harness.compaction-recovery.v1",
    mode,
    feature_id: featureId,
    canonical_plan_path: resolvedPlan.canonicalRelativePath,
    progress: { capture_verified: completed, total_tasks: tasks.length },
    shared_context_path: `.opencode/plans/${sessionId}-${featureId}/shared_context.md`,
    unmatched_regates: unmatched.slice(0, MAX_LIST_ITEMS),
  });
  if (!context) return { ok: false, reason: "recovery payload byte budget too small" };
  return { ok: true, context, statePath: loaded.path };
}

function hasOwnedChildIndex(projectRoot, sessionId) {
  const childRoot = path.join(projectRoot, ".opencode", "plans", ".state", "active-dispatch-children");
  try {
    for (const entry of fs.readdirSync(childRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const loaded = readSafeJson(projectRoot, path.join(childRoot, entry.name), 64 * 1024);
      if (loaded.ok && loaded.value.parentSessionId === sessionId) return true;
    }
  } catch { /* absent index */ }
  return false;
}

/** @description Whether current or persisted legacy review state blocks terminal retention. */
export function isPendingReviewState(state) {
  return readDualStatus(state) === "pending";
}

function terminalDeliveryProof(projectRoot, sessionId, state, _eventType, isAncestor) {
  if (state.session_id !== sessionId || Object.keys(state.dispatch_records ?? {}).length > 0) return false;
  if (hasOwnedChildIndex(projectRoot, sessionId)) return false;
  if (state.planner_status !== "usable" || state.planner_binding_error != null ||
      state.classified === false || isPendingReviewState(state)) return false;
  const featureId = state.feature_id;
  if (!isSafeFeatureId(featureId)) return false;
  const resolved = currentPlan(projectRoot, sessionId, featureId, state);
  if (!resolved.ok || !validatePlan(resolved.plan, { expect: "full" }).ok || !Array.isArray(resolved.plan.tasks)) return false;
  if (!Array.isArray(state.hand_finished) || !Array.isArray(state.capture_verified)) return false;
  const taskIds = new Set();
  for (const task of resolved.plan.tasks) {
    if (!task || typeof task !== "object" || !isSafeTaskId(task.id)) return false;
    taskIds.add(task.id);
    if (!state.hand_finished.includes(`${featureId}/${task.id}`)) return false;
    if (!matchesAbsolution(`${featureId}/${task.id}`, state.capture_verified, isAncestor)) return false;
  }
  const pending = parsePending(state.regate_pending, featureId, taskIds);
  return pending.ok && pending.value.every((item) => matchesAbsolution(item, state.regate_passed, isAncestor));
}

/** @description Stamp a retention clock only from an official terminal event plus delivery proof. */
export function recordSessionCompletion(projectRoot, sessionId, options = {}) {
  const eventType = options.eventType;
  const now = options.now ?? Date.now();
  const isAncestor = typeof options.isAncestor === "function" ? options.isAncestor : () => false;
  if (!isSafeSessionId(sessionId) || !["session.idle", "session.updated", "session.deleted"].includes(eventType) || !Number.isFinite(now)) {
    return { ok: false, recorded: false, reason: "official session event identity required" };
  }
  const lifecyclePath = lifecycleBasePath(projectRoot, sessionId);
  const lifecycle = acquireLock(lifecyclePath, options.lockOptions);
  if (!lifecycle.ok) return { ok: false, recorded: false, reason: lifecycle.reason };
  try {
    const stateResult = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
    if (!stateResult.ok) return { ok: false, recorded: false, reason: stateResult.reason };
    const initial = readSafeJson(projectRoot, stateResult.path);
    const lifecycleRecord = readSafeJson(projectRoot, lifecycleRecordPath(projectRoot, sessionId), 64 * 1024);
    const mayReopenMissing = eventType === "session.updated" && lifecycleRecord.ok &&
      lifecycleRecord.value.session_id === sessionId && lifecycleRecord.value.status === "cleaned";
    if (!initial.ok && !mayReopenMissing) return { ok: true, recorded: false };

    const acquired = acquireLock(stateResult.path, options.lockOptions);
    if (!acquired.ok) return { ok: false, recorded: false, reason: acquired.reason };
    try {
      const loaded = readSafeJson(projectRoot, stateResult.path);
      if (!loaded.ok) {
        if (!mayReopenMissing) return { ok: true, recorded: false };
        const reopened = { session_id: sessionId, session_status: "active", session_reopened_at: new Date(now).toISOString() };
        if (!writeGateStateAtomic(stateResult.path, reopened)) return { ok: false, recorded: false, reason: "reopened session persistence failed" };
        try { fs.rmSync(lifecycleRecordPath(projectRoot, sessionId), { force: true }); } catch { /* consumed record may be retried */ }
        return { ok: true, recorded: false, reopened: true };
      }
      if (eventType === "session.updated") {
        const next = { ...loaded.value };
        delete next.session_status;
        delete next.session_completed_at;
        next.session_status = "active";
        next.session_reopened_at = new Date(now).toISOString();
        const temporary = `${stateResult.path}.${crypto.randomUUID()}.reopen`;
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, stateResult.path);
        return { ok: true, recorded: false, reopened: true };
      }
      const terminal = terminalDeliveryProof(projectRoot, sessionId, loaded.value, eventType, isAncestor);
      if (!terminal) return { ok: true, recorded: false };
      if (loaded.value.session_status === "completed" && Number.isFinite(Date.parse(loaded.value.session_completed_at))) {
        return { ok: true, recorded: false };
      }
      const next = { ...loaded.value, session_status: "completed", session_completed_at: new Date(now).toISOString() };
      const temporary = `${stateResult.path}.${crypto.randomUUID()}.completion`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, stateResult.path);
      return { ok: true, recorded: true };
    } finally {
      releaseLock(stateResult.path, acquired.token);
    }
  } catch {
    return { ok: false, recorded: false, reason: "completion timestamp persistence failed" };
  } finally {
    releaseLock(lifecyclePath, lifecycle.token);
  }
}

function claimOwnedChildIndexes(projectRoot, sessionId) {
  const root = path.join(projectRoot, ".opencode", "plans", ".state", "active-dispatch-children");
  const claimed = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const target = path.join(root, entry.name);
      const before = readSafeJson(projectRoot, target, 64 * 1024);
      if (!before.ok) continue;
      const binding = before.value;
      const expectedName = typeof binding.childSessionId === "string"
        ? `${crypto.createHash("sha256").update(binding.childSessionId).digest("hex")}.json`
        : "";
      if (binding.parentSessionId !== sessionId || !isSafeSessionId(binding.childSessionId) ||
          typeof binding.callId !== "string" || binding.callId.length === 0 ||
          typeof binding.token !== "string" || binding.token.length === 0 || entry.name !== expectedName) continue;
      const tombstone = `${target}.${crypto.randomUUID()}.retained`;
      try {
        fs.renameSync(target, tombstone);
        const loaded = readSafeJson(projectRoot, tombstone, 64 * 1024);
        if (loaded.ok && loaded.raw === before.raw && loaded.value.parentSessionId === sessionId) {
          claimed.push({ target, tombstone });
        } else if (!fs.existsSync(target)) {
          fs.renameSync(tombstone, target);
        }
      } catch { /* retain on uncertainty */ }
    }
  } catch { /* absent index */ }
  return claimed;
}

function restoreClaims(claims) {
  for (const claim of claims) {
    try {
      if (!fs.existsSync(claim.target)) fs.renameSync(claim.tombstone, claim.target);
    } catch { /* a failed restore remains an inert tombstone */ }
  }
}

/** @description Remove only an expired completed session marker under its ownership lock. */
export function cleanupRetainedCompletedSession(projectRoot, sessionId, options = {}) {
  const retentionMs = options.retentionMs;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(retentionMs) || retentionMs < 0 || !Number.isFinite(now) || !isSafeSessionId(sessionId)) {
    return { ok: false, cleaned: false, reason: "explicit retention policy required" };
  }
  const stateResult = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
  if (!stateResult.ok) return { ok: false, cleaned: false, reason: stateResult.reason };
  const eligible = (loaded) => {
    if (!loaded.ok || loaded.value.session_id !== sessionId) return false;
    const completedAt = Date.parse(loaded.value.session_completed_at);
    return loaded.value.session_status === "completed" && Number.isFinite(completedAt) && now - completedAt >= retentionMs;
  };
  const lifecyclePath = lifecycleBasePath(projectRoot, sessionId);
  const lifecycle = acquireLock(lifecyclePath, options.lockOptions);
  if (!lifecycle.ok) return { ok: false, cleaned: false, reason: lifecycle.reason };
  if (!eligible(readSafeJson(projectRoot, stateResult.path))) {
    releaseLock(lifecyclePath, lifecycle.token);
    return { ok: true, cleaned: false };
  }
  const acquired = acquireLock(stateResult.path, options.lockOptions);
  if (!acquired.ok) {
    releaseLock(lifecyclePath, lifecycle.token);
    return { ok: false, cleaned: false, reason: acquired.reason };
  }
  let tombstone = null;
  let tombstoneStatePath = null;
  let childClaims = [];
  let handRecordClaim = null;
  const sessionDir = path.dirname(stateResult.path);
  try {
    const loaded = readSafeJson(projectRoot, stateResult.path);
    if (!eligible(loaded) || Object.keys(loaded.value.dispatch_records ?? {}).length > 0) {
      return { ok: true, cleaned: false };
    }
    childClaims = claimOwnedChildIndexes(projectRoot, sessionId);
    if (isSafeFeatureId(loaded.value.feature_id)) {
      const records = path.join(projectRoot, ".opencode", "plans", ".state", "hand-records", loaded.value.feature_id, sessionId);
      if (fs.existsSync(records)) {
        const recordsTombstone = `${records}.${crypto.randomUUID()}.retained`;
        fs.renameSync(records, recordsTombstone);
        handRecordClaim = { target: records, tombstone: recordsTombstone };
      }
    }
    if (typeof options.beforeSessionRename === "function") options.beforeSessionRename();
    tombstone = `${sessionDir}.${crypto.randomUUID()}.retained`;
    fs.renameSync(sessionDir, tombstone);
    tombstoneStatePath = path.join(tombstone, "gate-state.json");
    if (!writeLifecycleRecord(projectRoot, sessionId, {
      session_id: sessionId,
      status: "cleaned",
      cleaned_at: new Date(now).toISOString(),
    })) throw new Error("lifecycle cleanup record failed");
  } catch {
    if (tombstone && !fs.existsSync(sessionDir)) {
      try {
        fs.renameSync(tombstone, sessionDir);
        tombstone = null;
        tombstoneStatePath = null;
      } catch { /* fail closed with claimed session tombstone retained */ }
    }
    restoreClaims(childClaims);
    if (handRecordClaim) restoreClaims([handRecordClaim]);
    return { ok: false, cleaned: false, reason: "completed session cleanup failed" };
  } finally {
    releaseLock(tombstoneStatePath ?? stateResult.path, acquired.token);
    releaseLock(lifecyclePath, lifecycle.token);
  }
  for (const claim of childClaims) {
    try { fs.rmSync(claim.tombstone, { force: true }); } catch { /* tombstone is inert */ }
  }
  if (handRecordClaim) {
    try { fs.rmSync(handRecordClaim.tombstone, { recursive: true, force: true }); } catch { /* tombstone is inert */ }
  }
  try { fs.rmSync(tombstone, { recursive: true, force: true }); } catch { /* tombstone is inert */ }
  return { ok: true, cleaned: true };
}

/** @description Opportunistically clean every safe retained session directory under this project root. */
export function sweepRetainedSessions(projectRoot, options = {}) {
  const stateRoot = path.join(projectRoot, ".opencode", "plans", ".state");
  let cleaned = 0;
  try {
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
      const result = cleanupRetainedCompletedSession(projectRoot, entry.name, options);
      if (result.cleaned) cleaned += 1;
    }
    return { ok: true, cleaned };
  } catch {
    return { ok: true, cleaned };
  }
}

export default { buildSessionRecovery, cleanupRetainedCompletedSession, encodeRecoveryPayload, recordSessionCompletion, resolveSessionProjectRoot, sweepRetainedSessions };
