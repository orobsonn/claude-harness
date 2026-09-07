/** @description Exact call-keyed writing-hand scope records with no shared live registry. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executionPlanPath, gateStatePath } from "../shared/lib/path-helpers.mjs";
import { isSafeFeatureId, isSafeTaskId } from "../shared/lib/feature-id.mjs";
import { acquireLock, releaseLock } from "./gate-state.mjs";
import { validatePlan } from "../shared/lib/validate-plan.mjs";
import { snapshotWorktreeBaseline } from "./worktree-baseline.mjs";
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
  const required = [record.parent_session_id, record.dispatch_call_id, record.feature_id, record.task_id, record.role, record.plan_hash, record.claimed_at];
  if (!required.every((value) => typeof value === "string" && value.length > 0)) return false;
  if (!safeSegment(record.parent_session_id) || !isSafeFeatureId(record.feature_id) || !isSafeTaskId(record.task_id) || !writingHand(record.role)) return false;
  if (!/^[0-9a-f]{64}$/.test(record.plan_hash)) return false;
  if (record.child_session_id !== null && !safeSegment(record.child_session_id)) return false;
  const claimedAt = Date.parse(record.claimed_at);
  if (!Number.isFinite(claimedAt) || new Date(claimedAt).toISOString() !== record.claimed_at) return false;
  return canonicalStringList(projectRoot, record.scope_paths, true) &&
    canonicalStringList(projectRoot, record.allowed_writes, false) &&
    (record.frozen_paths === undefined || canonicalStringList(projectRoot, record.frozen_paths, false));
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

/** @description Read and structurally validate one exact task from the feature-stable plan. */
export function readCanonicalTask(projectRoot, featureId, taskId) {
  if (!isSafeFeatureId(featureId) || !isSafeTaskId(taskId)) return { ok: false, reason: "canonical feature or task identity invalid" };
  const resolved = executionPlanPath({ projectRoot, runtime: "opencode", featureId });
  if (!resolved.ok) return resolved;
  let bytes;
  let plan;
  try {
    bytes = fs.readFileSync(resolved.path);
    plan = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: error && typeof error === "object" && error.code === "ENOENT" ? "stable plan missing" : "stable plan unreadable" };
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.feature_id !== featureId) return { ok: false, reason: "stable plan feature mismatch" };
  let validation;
  try {
    validation = validatePlan(plan, { expect: "full", expectedModelStrategy: plan.model_strategy });
  } catch {
    return { ok: false, reason: "stable plan validation failed internally" };
  }
  if (!validation?.ok) return { ok: false, reason: `stable plan invalid: ${(validation?.errors ?? []).join("; ")}` };
  const matches = (Array.isArray(plan.tasks) ? plan.tasks : []).filter((task) => task && task.id === taskId);
  if (matches.length !== 1) return { ok: false, reason: "canonical task id missing or ambiguous in stable plan" };
  const planHash = crypto.createHash("sha256").update(bytes).digest("hex");
  return { ok: true, featureId, taskId, task: matches[0], planHash, planPath: resolved.path };
}

/** @description Derive one writing hand's scope from the validated stable plan. */
export function canonicalDispatchFromPlan(projectRoot, featureId, taskId, role) {
  if (!writingHand(role)) return { ok: false, reason: "role is not a writing hand" };
  const bound = readCanonicalTask(projectRoot, featureId, taskId);
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
  const frozenPaths = [];
  for (const lockedTest of Array.isArray(bound.task.locked_tests) ? bound.task.locked_tests : []) {
    const candidates = [lockedTest?.path, ...(Array.isArray(lockedTest?.fixture_paths) ? lockedTest.fixture_paths : [])];
    for (const item of candidates) {
      const normalized = normalizeProjectPath(projectRoot, item);
      if (!normalized.ok) return normalized;
      if (!frozenPaths.includes(normalized.path)) frozenPaths.push(normalized.path);
    }
  }
  if (isTestAuthorRole(role)) {
    if (frozenPaths.length === 0) return { ok: false, reason: "test-author requires canonical locked test paths" };
    return { ok: true, featureId: bound.featureId, taskId: bound.taskId, scopePaths: frozenPaths, allowedWrites: [], frozenPaths: [], planHash: bound.planHash };
  }
  return { ok: true, featureId: bound.featureId, taskId: bound.taskId, scopePaths, allowedWrites, frozenPaths, planHash: bound.planHash };
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
    left.plan_hash === right.plan_hash && JSON.stringify(left.scope_paths) === JSON.stringify(right.scope_paths) &&
    JSON.stringify(left.allowed_writes) === JSON.stringify(right.allowed_writes) &&
    JSON.stringify(left.frozen_paths ?? []) === JSON.stringify(right.frozen_paths ?? []);
}

function claimResolvedDispatch(projectRoot, { sessionId, callId, role, taskId, now = Date.now(), lockOptions } = {}, resolveCanonical) {
  if (![sessionId, callId, role, taskId].every((value) => typeof value === "string" && value)) return { ok: false, reason: "runtime session, call, role, and task required" };
  if (!safeSegment(sessionId) || !isSafeTaskId(taskId) || !writingHand(role)) return { ok: false, reason: "runtime session, task, or writing role invalid" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const lifecycleTarget = canonicalTarget(
    realRoot,
    path.join(realRoot, ".opencode", "plans", ".state", ".session-lifecycle", sessionId),
    "dispatch lifecycle lock path escapes project root",
  );
  if (!lifecycleTarget.ok) return lifecycleTarget;
  const lifecycle = acquireLock(lifecycleTarget.path, lockOptions);
  if (!lifecycle.ok) return lifecycle;
  try {
    const canonical = resolveCanonical(realRoot);
    if (!canonical.ok) return canonical;
    const worktreeBaseline = snapshotWorktreeBaseline(realRoot);
    const record = {
      parent_session_id: sessionId, dispatch_call_id: callId, child_session_id: null,
      feature_id: canonical.featureId, task_id: canonical.taskId, role,
      scope_paths: canonical.scopePaths, allowed_writes: canonical.allowedWrites,
      frozen_paths: canonical.frozenPaths ?? [],
      plan_hash: canonical.planHash, claimed_at: new Date(now).toISOString(),
      ...(worktreeBaseline?.entries?.length ? { worktree_baseline: worktreeBaseline } : {}),
    };
    const resolved = dispatchRecordPath(realRoot, sessionId, callId);
    if (!resolved.ok) return resolved;
    const written = mutateExactRecord(resolved.path, (current) => {
      if (current.ok && !validDispatchRecord(realRoot, current.value)) return { ok: false, conflict: true, reason: "same dispatch call record schema conflict" };
      if (current.ok && sameDispatch(current.value, record)) return { record: current.value };
      if (current.ok) return { ok: false, conflict: true, reason: "same dispatch call replay conflicts with canonical scope" };
      if (!current.absent) return current;
      return { record };
    });
    return written.ok
      ? { ok: true, claim: written.record, ...(typeof canonical.reviewedSha === "string" ? { reviewedSha: canonical.reviewedSha } : {}) }
      : written;
  } finally {
    releaseLock(lifecycleTarget.path, lifecycle.token);
  }
}

/** @description Atomically create one immutable canonical scope record for this exact Task call. */
export function claimActiveDispatch(projectRoot, { sessionId, callId, role, taskId, now = Date.now(), lockOptions } = {}) {
  return claimResolvedDispatch(projectRoot, { sessionId, callId, role, taskId, now, lockOptions }, (realRoot) => {
    const loaded = loadCanonicalState(realRoot, sessionId);
    if (!loaded.ok) return loaded;
    if (loaded.state.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };
    if (loaded.state.classified !== true || !["LIGHT", "FULL"].includes(loaded.state.mode)) return { ok: false, reason: "classified LIGHT or FULL required" };
    if (!isSafeFeatureId(loaded.state.feature_id)) return { ok: false, reason: "gate-state feature identity invalid" };
    return canonicalDispatchFromPlan(realRoot, loaded.state.feature_id, taskId, role);
  });
}

function exactFixScopePath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value !== value.trim()) return false;
  if (value === "." || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:\//.test(value) || value.endsWith("/") || value.endsWith("\\") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

/** @description Parse the host-frozen fix-mode authority envelope without consulting model prose. */
export function resolveFixModeScopeAuthority(env = process.env) {
  if (env?.HARNESS_FIX_MODE !== "1") return { enabled: false, ok: true };
  let parsed;
  try { parsed = JSON.parse(env?.HARNESS_FIX_SCOPE_JSON ?? ""); } catch { return { enabled: true, ok: false, reason: "fix-mode scope envelope malformed" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) return { enabled: true, ok: false, reason: "fix-mode scope envelope invalid" };
  if (typeof parsed.reviewed_sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.reviewed_sha)) return { enabled: true, ok: false, reason: "fix-mode reviewed sha invalid" };
  if (!Array.isArray(parsed.scope_paths) || parsed.scope_paths.length === 0 || parsed.scope_paths.length > 100) return { enabled: true, ok: false, reason: "fix-mode exact scope missing or oversized" };
  const seen = new Set();
  for (const item of parsed.scope_paths) {
    if (!exactFixScopePath(item) || seen.has(item)) return { enabled: true, ok: false, reason: "fix-mode exact scope invalid" };
    seen.add(item);
  }
  return { enabled: true, ok: true, reviewedSha: parsed.reviewed_sha, scopePaths: [...parsed.scope_paths] };
}

/** @description Claim planner scope normally or the host-frozen reviewed scope in fix mode. */
export function claimDispatchForRuntime(projectRoot, args = {}, { env = process.env, isAncestorFn } = {}) {
  const authority = resolveFixModeScopeAuthority(env);
  if (!authority.enabled) return claimActiveDispatch(projectRoot, args);
  if (!authority.ok) return authority;
  const { sessionId, callId, role, taskId, featureId, now = Date.now(), lockOptions } = args;
  if (!isSniperRole(role)) return { ok: false, reason: "fix-mode dispatch requires sniper role" };
  if (!isSafeFeatureId(featureId)) return { ok: false, reason: "fix-mode feature invalid" };
  return claimResolvedDispatch(projectRoot, { sessionId, callId, role, taskId, now, lockOptions }, (realRoot) => {
    const loaded = loadCanonicalState(realRoot, sessionId);
    if (!loaded.ok) return loaded;
    const state = loaded.state;
    if (state.session_id !== sessionId || state.feature_id !== featureId) return { ok: false, reason: "fix-mode gate-state identity mismatch" };
    if (state.classified !== true || !["LIGHT", "FULL"].includes(state.mode)) return { ok: false, reason: "fix-mode classified LIGHT or FULL required" };
    let ancestor = null;
    try { ancestor = typeof isAncestorFn === "function" ? isAncestorFn(authority.reviewedSha) : null; } catch { ancestor = null; }
    if (ancestor !== true) return { ok: false, reason: "fix-mode reviewed sha is not an ancestor of HEAD" };
    const scopePaths = [];
    for (const item of authority.scopePaths) {
      const normalized = normalizeProjectPath(realRoot, item);
      if (!normalized.ok || normalized.path !== item) return { ok: false, reason: normalized.reason ?? "fix-mode scope is not canonical" };
      const absolute = path.join(realRoot, item);
      try {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: "fix-mode scope must name exact files" };
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") return { ok: false, reason: "fix-mode scope unreadable" };
      }
      scopePaths.push(item);
    }
    const planHash = crypto.createHash("sha256").update(JSON.stringify({
      authority: "fix-mode-v1", session_id: sessionId, feature_id: featureId,
      task_id: taskId, role, reviewed_sha: authority.reviewedSha, scope_paths: scopePaths,
    })).digest("hex");
    return { ok: true, featureId, taskId, scopePaths, allowedWrites: [], planHash, reviewedSha: authority.reviewedSha };
  });
}

function scanBoundChild(projectRoot, childSessionId, excludedPath = "") {
  if (!safeSegment(childSessionId)) return { ok: false, conflict: true, reason: "child session identity invalid" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
  const root = path.join(realRoot, ".opencode", "plans", ".state");
  let match = null;
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
        if (file === excludedPath) continue;
        const found = readJson(file);
        if (!found.ok) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        if (!validDispatchRecord(realRoot, found.value)) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        const expectedName = `${crypto.createHash("sha256").update(found.value.dispatch_call_id).digest("hex")}.json`;
        if (entry !== expectedName || found.value.parent_session_id !== session.name) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        if (found.value.child_session_id !== childSessionId) continue;
        if (match) return { ok: false, conflict: true, reason: "multiple durable dispatch records bind the same child session" };
        match = { record: found.value, path: file, parentSessionId: found.value.parent_session_id, callId: found.value.dispatch_call_id };
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "bound child dispatch record absent" };
    return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
  }
  return match ? { ok: true, ...match } : { ok: false, absent: true, reason: "bound child dispatch record absent" };
}

/** @description Recover exactly one host-bound parent call for a child session; zero is absent and many conflict. */
export function readBoundDispatchForChild(projectRoot, childSessionId) {
  return scanBoundChild(projectRoot, childSessionId);
}

function childBoundElsewhere(projectRoot, childSessionId, wantedPath) {
  const found = scanBoundChild(projectRoot, childSessionId, wantedPath);
  if (found.ok) return { ok: true, bound: true };
  if (found.absent) return { ok: true, bound: false };
  return found;
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

export default { bindChildSession, canonicalDispatchFromPlan, claimActiveDispatch, claimDispatchForRuntime, dispatchRecordPath, normalizeProjectPath, readBoundDispatchForChild, readCanonicalTask, readDispatchRecord, removeDispatchRecord, resolveFixModeScopeAuthority };
