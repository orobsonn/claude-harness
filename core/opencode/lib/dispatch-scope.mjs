/** @description Exact call-keyed writing-hand scope records with no shared live registry. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gateStatePath } from "../../shared/lib/path-helpers.mjs";
import { isSafeFeatureId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { acquireLock, releaseLock } from "./gate-state.mjs";
import { readBoundPlanSnapshot } from "./planner-artifact.mjs";
import { isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function canonicalTarget(realRoot, candidate, reason) {
  const existing = nearestExistingPath(candidate);
  if (!existing) return { ok: false, reason };
  let realExisting;
  try { realExisting = fs.realpathSync(existing); } catch { return { ok: false, reason }; }
  if (!inside(realRoot, realExisting)) return { ok: false, reason };
  const canonical = path.resolve(realExisting, path.relative(existing, candidate));
  if (!inside(realRoot, canonical)) return { ok: false, reason };
  return { ok: true, path: canonical };
}

/** @description Resolve a path beneath the real project root, rejecting traversal and symlink escape. */
export function normalizeProjectPath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return { ok: false, reason: "scope path missing or invalid" };
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.split("/").includes("..")) return { ok: false, reason: "scope path traversal rejected" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const lexicalRoot = path.resolve(projectRoot);
  let absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(realRoot, raw);
  if (path.isAbsolute(raw)) {
    try { absolute = fs.realpathSync(absolute); } catch {
      try { absolute = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { /* checked below */ }
    }
  }
  if (!inside(realRoot, absolute) && inside(lexicalRoot, absolute)) absolute = path.resolve(realRoot, path.relative(lexicalRoot, absolute));
  if (!inside(realRoot, absolute)) return { ok: false, reason: "absolute path outside project root" };
  const canonical = canonicalTarget(realRoot, absolute, "scope path symlink escape rejected");
  if (!canonical.ok) return canonical;
  const relative = path.relative(realRoot, canonical.path).split(path.sep).join("/");
  return { ok: true, path: relative || "." };
}

function writingHand(role) {
  return isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);
}

function sameWritingHandFamily(left, right) {
  return (isExecutorRole(left) && isExecutorRole(right)) ||
    (isSniperRole(left) && isSniperRole(right)) ||
    (isTestAuthorRole(left) && isTestAuthorRole(right));
}

function safeSegment(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !value.includes("..");
}

function statePath(projectRoot, sessionId) {
  return gateStatePath({ projectRoot, runtime: "opencode", sessionId });
}

/** @description Return the one independent durable file assigned to a parent Task call. */
export function dispatchRecordPath(projectRoot, parentSessionId, dispatchCallId) {
  if (!safeSegment(parentSessionId) || typeof dispatchCallId !== "string" || !dispatchCallId) return { ok: false, reason: "exact parent session and dispatch call required" };
  const digest = crypto.createHash("sha256").update(dispatchCallId).digest("hex");
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const target = path.join(realRoot, ".opencode", "plans", ".state", parentSessionId, "dispatch-records", `${digest}.json`);
  return canonicalTarget(realRoot, target, "dispatch record path escapes project root");
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false, reason: "dispatch record invalid" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "dispatch record absent" };
    return { ok: false, reason: "dispatch record unreadable" };
  }
}

function writeJsonAtomic(target, body) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

function canonicalStringList(projectRoot, value, requireNonempty) {
  if (!Array.isArray(value) || (requireNonempty && value.length === 0)) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item) return false;
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok || normalized.path !== item || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function validDispatchRecord(projectRoot, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const required = [record.parent_session_id, record.dispatch_call_id, record.feature_id, record.task_id, record.role, record.snapshot_hash, record.claimed_at];
  if (!required.every((value) => typeof value === "string" && value.length > 0)) return false;
  if (!safeSegment(record.parent_session_id) || !isSafeFeatureId(record.feature_id) || !isSafeTaskId(record.task_id) || !writingHand(record.role)) return false;
  if (!/^[0-9a-f]{64}$/.test(record.snapshot_hash)) return false;
  if (record.child_session_id !== null && !safeSegment(record.child_session_id)) return false;
  const claimedAt = Date.parse(record.claimed_at);
  if (!Number.isFinite(claimedAt) || new Date(claimedAt).toISOString() !== record.claimed_at) return false;
  return canonicalStringList(projectRoot, record.scope_paths, true) && canonicalStringList(projectRoot, record.allowed_writes, false);
}

function mutateExactRecord(recordPath, fn) {
  const acquired = acquireLock(recordPath);
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  try {
    const current = readJson(recordPath);
    const next = fn(current);
    if (next?.ok === false) return next;
    if (next?.remove) {
      try { fs.rmSync(recordPath, { force: true }); return { ok: true, removed: true }; } catch { return { ok: false, reason: "dispatch record removal failed" }; }
    }
    if (!next || typeof next !== "object" || !next.record) return { ok: false, reason: "dispatch record mutation invalid" };
    return writeJsonAtomic(recordPath, next.record) ? { ok: true, record: next.record } : { ok: false, reason: "dispatch record write failed" };
  } finally {
    releaseLock(recordPath, acquired.token);
  }
}

/** @description Read one exact record; never scans or borrows a sibling. */
export function readDispatchRecord(projectRoot, { parentSessionId, callId }) {
  const resolved = dispatchRecordPath(projectRoot, parentSessionId, callId);
  if (!resolved.ok) return resolved;
  const loaded = readJson(resolved.path);
  if (!loaded.ok) return loaded.absent ? loaded : { ...loaded, conflict: true };
  const record = loaded.value;
  if (!validDispatchRecord(projectRoot, record)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
  if (record.parent_session_id !== parentSessionId || record.dispatch_call_id !== callId) return { ok: false, conflict: true, reason: "dispatch record identity conflict" };
  return { ok: true, record, path: resolved.path };
}

/** @description Read one exact task from the content-addressed immutable planner snapshot. */
export function readCanonicalTaskFromSnapshot(projectRoot, state, taskId) {
  if (state?.planner_status !== "usable") return { ok: false, reason: "planner_status usable required" };
  const binding = state?.planner_plan_binding;
  if (!binding || typeof binding !== "object") return { ok: false, reason: "bound planner snapshot required" };
  if (typeof binding.snapshot_path !== "string" || typeof binding.snapshot_hash !== "string" || typeof binding.snapshot_file_hash !== "string") return { ok: false, reason: "bound planner snapshot identity missing" };
  if (binding.session_id !== state.session_id || binding.feature_id !== state.feature_id) return { ok: false, reason: "bound planner snapshot identity mismatch" };
  const expectedDir = path.resolve(projectRoot, ".opencode", "plans", ".state", String(state.session_id), "bound-plans");
  const snapshotPath = path.resolve(projectRoot, binding.snapshot_path);
  const expectedPath = path.join(expectedDir, `${binding.snapshot_file_hash}.json`);
  const expectedRelative = path.relative(projectRoot, expectedPath).split(path.sep).join("/");
  if (snapshotPath !== expectedPath || binding.snapshot_path !== expectedRelative) return { ok: false, reason: "bound planner snapshot path is not canonical content-addressed identity" };
  const snapshot = readBoundPlanSnapshot(snapshotPath);
  if (!snapshot.valid || snapshot.semanticHash !== binding.snapshot_hash || snapshot.fileHash !== binding.snapshot_file_hash || snapshot.plan?.feature_id !== state.feature_id) return { ok: false, reason: "bound planner snapshot integrity failed" };
  const matches = (Array.isArray(snapshot.plan.tasks) ? snapshot.plan.tasks : []).filter((task) => task && task.id === taskId);
  if (matches.length !== 1) return { ok: false, reason: "canonical task id missing or ambiguous in bound plan" };
  return { ok: true, featureId: state.feature_id, taskId, task: matches[0], snapshotHash: snapshot.semanticHash };
}

/** @description Verify the immutable planner binding and derive the canonical task scope. */
export function canonicalDispatchFromSnapshot(projectRoot, state, taskId, role) {
  if (!writingHand(role)) return { ok: false, reason: "role is not a writing hand" };
  const bound = readCanonicalTaskFromSnapshot(projectRoot, state, taskId);
  if (!bound.ok) return bound;
  const scopePaths = [];
  for (const item of Array.isArray(bound.task.scope_paths) ? bound.task.scope_paths : []) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!scopePaths.includes(normalized.path)) scopePaths.push(normalized.path);
  }
  if (scopePaths.length === 0) return { ok: false, reason: "canonical task scope is empty" };
  const allowedWrites = [];
  for (const item of Array.isArray(bound.task.allowed_writes) ? bound.task.allowed_writes : []) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!allowedWrites.includes(normalized.path)) allowedWrites.push(normalized.path);
  }
  return { ok: true, featureId: bound.featureId, taskId: bound.taskId, scopePaths, allowedWrites, snapshotHash: bound.snapshotHash };
}

function loadCanonicalState(projectRoot, sessionId) {
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  const loaded = readJson(resolved.path);
  if (!loaded.ok) return { ok: false, reason: loaded.absent ? "gate-state missing" : "gate-state unreadable" };
  return { ok: true, state: loaded.value };
}

function sameDispatch(left, right) {
  return left.parent_session_id === right.parent_session_id &&
    left.dispatch_call_id === right.dispatch_call_id &&
    left.feature_id === right.feature_id && left.task_id === right.task_id && left.role === right.role &&
    left.snapshot_hash === right.snapshot_hash && JSON.stringify(left.scope_paths) === JSON.stringify(right.scope_paths) &&
    JSON.stringify(left.allowed_writes) === JSON.stringify(right.allowed_writes);
}

/** @description Atomically create one immutable canonical scope record for this exact Task call. */
export function claimActiveDispatch(projectRoot, { sessionId, callId, role, taskId, now = Date.now() }) {
  if (![sessionId, callId, role, taskId].every((value) => typeof value === "string" && value)) return { ok: false, reason: "runtime session, call, role, and task required" };
  const loaded = loadCanonicalState(projectRoot, sessionId);
  if (!loaded.ok) return loaded;
  if (loaded.state.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };
  const canonical = canonicalDispatchFromSnapshot(projectRoot, loaded.state, taskId, role);
  if (!canonical.ok) return canonical;
  const record = {
    parent_session_id: sessionId, dispatch_call_id: callId, child_session_id: null,
    feature_id: canonical.featureId, task_id: canonical.taskId, role,
    scope_paths: canonical.scopePaths, allowed_writes: canonical.allowedWrites,
    snapshot_hash: canonical.snapshotHash, claimed_at: new Date(now).toISOString(),
  };
  const resolved = dispatchRecordPath(projectRoot, sessionId, callId);
  if (!resolved.ok) return resolved;
  const written = mutateExactRecord(resolved.path, (current) => {
    if (current.ok && !validDispatchRecord(projectRoot, current.value)) return { ok: false, conflict: true, reason: "same dispatch call record schema conflict" };
    if (current.ok && sameDispatch(current.value, record)) return { record: current.value };
    if (current.ok) return { ok: false, conflict: true, reason: "same dispatch call replay conflicts with canonical scope" };
    if (!current.absent) return current;
    return { record };
  });
  return written.ok ? { ok: true, claim: written.record } : written;
}

function childBoundElsewhere(projectRoot, childSessionId, wantedPath) {
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
  const root = path.join(realRoot, ".opencode", "plans", ".state");
  try {
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (session.isSymbolicLink()) return { ok: false, reason: "dispatch sibling scan failed" };
      if (!session.isDirectory()) continue;
      const records = path.join(root, session.name, "dispatch-records");
      let entries;
      try { entries = fs.readdirSync(records); } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") continue;
        return { ok: false, reason: "dispatch sibling scan failed" };
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        let file;
        try { file = fs.realpathSync(path.join(records, entry)); } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
        if (!inside(realRoot, file)) return { ok: false, reason: "dispatch sibling scan failed" };
        if (file === wantedPath) continue;
        const found = readJson(file);
        if (!found.ok) return { ok: false, reason: "dispatch sibling scan failed" };
        if (!validDispatchRecord(realRoot, found.value)) return { ok: false, reason: "dispatch sibling scan failed" };
        const expectedName = `${crypto.createHash("sha256").update(found.value.dispatch_call_id).digest("hex")}.json`;
        if (entry !== expectedName || found.value.parent_session_id !== session.name) return { ok: false, reason: "dispatch sibling scan failed" };
        if (found.value.child_session_id === childSessionId) return { ok: true, bound: true };
      }
    }
  } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
  return { ok: true, bound: false };
}

function childLockTarget(projectRoot, childSessionId) {
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const digest = crypto.createHash("sha256").update(childSessionId).digest("hex");
  return canonicalTarget(realRoot, path.join(realRoot, ".opencode", "plans", ".state", ".dispatch-child-locks", digest), "dispatch child lock path escapes project root");
}

/** @description Bind a child only to the explicitly named parent call; sibling records are never candidates. */
export function bindChildSession(projectRoot, { parentSessionId, childSessionId, role, callId }) {
  if (![parentSessionId, childSessionId, role, callId].every((value) => typeof value === "string" && value) || parentSessionId === childSessionId || !writingHand(role)) return { ok: false, reason: "exact parent, child, call, and writing role required" };
  const resolved = dispatchRecordPath(projectRoot, parentSessionId, callId);
  if (!resolved.ok) return resolved;
  const childTarget = childLockTarget(projectRoot, childSessionId);
  if (!childTarget.ok) return childTarget;
  const acquired = acquireLock(childTarget.path);
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  try {
    const sibling = childBoundElsewhere(projectRoot, childSessionId, resolved.path);
    if (!sibling.ok) return sibling;
    if (sibling.bound) return { ok: false, reason: "child session already bound to another dispatch" };
    const updated = mutateExactRecord(resolved.path, (current) => {
      if (!current.ok) return current;
      const record = current.value;
      if (!validDispatchRecord(projectRoot, record)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
      if (record.parent_session_id !== parentSessionId || record.dispatch_call_id !== callId || !sameWritingHandFamily(role, record.role)) return { ok: false, reason: "exact dispatch role or identity mismatch" };
      if (record.child_session_id != null && record.child_session_id !== childSessionId) return { ok: false, reason: "dispatch already bound to another child session" };
      if (record.child_session_id === childSessionId) return { record };
      return { record: { ...record, child_session_id: childSessionId } };
    });
    return updated.ok ? { ok: true, binding: { parentSessionId, childSessionId, callId, role } } : updated;
  } finally {
    releaseLock(childTarget.path, acquired.token);
  }
}

/** @description Remove only the exact parent-call record after its Task boundary terminates. */
export function removeDispatchRecord(projectRoot, { sessionId, callId }) {
  const resolved = dispatchRecordPath(projectRoot, sessionId, callId);
  if (!resolved.ok) return resolved;
  const removed = mutateExactRecord(resolved.path, (current) => {
    if (current.absent) return { remove: true };
    if (!current.ok) return current;
    if (!validDispatchRecord(projectRoot, current.value)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
    if (current.value.parent_session_id !== sessionId || current.value.dispatch_call_id !== callId) return { ok: false, reason: "exact dispatch record identity conflict" };
    return { remove: true };
  });
  return removed.ok ? { ok: true, removed: Boolean(removed.removed) } : removed;
}

export default { bindChildSession, canonicalDispatchFromSnapshot, claimActiveDispatch, dispatchRecordPath, normalizeProjectPath, readCanonicalTaskFromSnapshot, readDispatchRecord, removeDispatchRecord };
