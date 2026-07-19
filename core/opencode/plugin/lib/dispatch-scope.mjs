/** @description Runtime-bound writing-hand dispatch claims, scope normalization, and durable violations. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { readBoundPlanSnapshot } from "./planner-artifact.mjs";
import { withGateStateLock } from "./gate-state.mjs";
import { isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";

export const DISPATCH_LEASE_MS = 30 * 60 * 1000;
const liveClaims = new Map();
const childBindings = new Map();
const pendingChildParents = new Map();

function childBindingKey(projectRoot, childSessionId) {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* use provided root for fail-closed lookup */ }
  return `${root}\0${childSessionId}`;
}

function liveClaimKey(projectRoot, sessionId, callId) {
  return `${childBindingKey(projectRoot, sessionId)}\0${callId}`;
}

function childIndexPath(projectRoot, childSessionId) {
  const name = crypto.createHash("sha256").update(childSessionId).digest("hex");
  return path.join(projectRoot, ".opencode", "plans", ".state", "active-dispatch-children", `${name}.json`);
}

function pendingChildIndexPath(projectRoot, childSessionId) {
  const name = crypto.createHash("sha256").update(childSessionId).digest("hex");
  return path.join(projectRoot, ".opencode", "plans", ".state", "active-dispatch-pending-children", `${name}.json`);
}

function writeJsonAtomic(target, body) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(body, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

function persistChildBinding(projectRoot, binding) {
  return writeJsonAtomic(childIndexPath(projectRoot, binding.childSessionId), binding);
}

function readChildBinding(projectRoot, childSessionId) {
  try {
    const binding = JSON.parse(fs.readFileSync(childIndexPath(projectRoot, childSessionId), "utf8"));
    return binding?.childSessionId === childSessionId && typeof binding.parentSessionId === "string" && typeof binding.callId === "string" && typeof binding.token === "string"
      ? binding
      : null;
  } catch { return null; }
}

function persistPendingChildParent(projectRoot, pending) {
  const key = childBindingKey(projectRoot, pending.childSessionId);
  pendingChildParents.set(key, pending);
  return writeJsonAtomic(pendingChildIndexPath(projectRoot, pending.childSessionId), pending);
}

function readPendingChildParent(projectRoot, childSessionId) {
  const key = childBindingKey(projectRoot, childSessionId);
  const cached = pendingChildParents.get(key);
  if (cached?.childSessionId === childSessionId && typeof cached.parentSessionId === "string" && typeof cached.callId === "string") {
    return cached;
  }
  try {
    const pending = JSON.parse(fs.readFileSync(pendingChildIndexPath(projectRoot, childSessionId), "utf8"));
    if (pending?.childSessionId === childSessionId && typeof pending.parentSessionId === "string" && typeof pending.callId === "string") {
      pendingChildParents.set(key, pending);
      return pending;
    }
  } catch { /* absent */ }
  return null;
}

function clearPendingChildParent(projectRoot, childSessionId) {
  if (typeof childSessionId !== "string" || !childSessionId) return;
  pendingChildParents.delete(childBindingKey(projectRoot, childSessionId));
  try { fs.rmSync(pendingChildIndexPath(projectRoot, childSessionId), { force: true }); } catch { /* ignore */ }
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function nearestRealPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try { return fs.realpathSync(current); } catch { return null; }
}

/** @description Resolve a path beneath the real project root, rejecting traversal and symlink escape. */
export function normalizeProjectPath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    return { ok: false, reason: "scope path missing or invalid" };
  }
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.split("/").includes("..")) return { ok: false, reason: "scope path traversal rejected" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(realRoot, raw);
  if (!inside(realRoot, absolute)) return { ok: false, reason: "absolute path outside project root" };
  const existing = nearestRealPath(absolute);
  if (!existing || !inside(realRoot, existing)) return { ok: false, reason: "scope path symlink escape rejected" };
  const relative = path.relative(realRoot, absolute).split(path.sep).join("/");
  return { ok: true, path: relative || "." };
}

function roleIsWritingHand(role) {
  return isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);
}

function sameWritingHandFamily(left, right) {
  return (isExecutorRole(left) && isExecutorRole(right)) ||
    (isSniperRole(left) && isSniperRole(right)) ||
    (isTestAuthorRole(left) && isTestAuthorRole(right));
}

function statePath(projectRoot, sessionId) {
  return gateStatePath({ projectRoot, runtime: "opencode", sessionId });
}

function activeExpired(active, now) {
  return Boolean(active && typeof active.expires_at === "string" && Number.isFinite(Date.parse(active.expires_at)) && Date.parse(active.expires_at) <= now);
}

/** @description Read one exact task from the content-addressed immutable planner snapshot. */
export function readCanonicalTaskFromSnapshot(projectRoot, state, taskId) {
  if (state?.planner_status !== "usable") return { ok: false, reason: "planner_status usable required" };
  if (state?.delivery_status === "delivery-blocked") return { ok: false, reason: "delivery is blocked" };
  const binding = state?.planner_plan_binding;
  if (!binding || typeof binding !== "object") return { ok: false, reason: "bound planner snapshot required" };
  if (typeof binding.snapshot_path !== "string" || typeof binding.snapshot_hash !== "string") {
    return { ok: false, reason: "bound planner snapshot identity missing" };
  }
  if (binding.session_id !== state.session_id || binding.feature_id !== state.feature_id) {
    return { ok: false, reason: "bound planner snapshot identity mismatch" };
  }
  const expectedDir = path.resolve(projectRoot, ".opencode", "plans", ".state", String(state.session_id), "bound-plans");
  const snapshotPath = path.resolve(projectRoot, binding.snapshot_path);
  const expectedPath = path.join(expectedDir, `${binding.snapshot_hash}.json`);
  const expectedRelative = path.relative(projectRoot, expectedPath).split(path.sep).join("/");
  if (snapshotPath !== expectedPath || binding.snapshot_path !== expectedRelative) return { ok: false, reason: "bound planner snapshot path is not canonical content-addressed identity" };
  const snapshot = readBoundPlanSnapshot(snapshotPath);
  if (!snapshot.valid || snapshot.semanticHash !== binding.snapshot_hash || snapshot.plan?.feature_id !== state.feature_id) {
    return { ok: false, reason: "bound planner snapshot integrity failed" };
  }
  const tasks = Array.isArray(snapshot.plan.tasks) ? snapshot.plan.tasks : [];
  const matches = tasks.filter((task) => task && task.id === taskId);
  if (matches.length !== 1) return { ok: false, reason: "canonical task id missing or ambiguous in bound plan" };
  return { ok: true, featureId: state.feature_id, taskId, task: matches[0], snapshotHash: snapshot.semanticHash };
}

/** @description Verify the immutable planner binding and derive the canonical task scope. */
export function canonicalDispatchFromSnapshot(projectRoot, state, taskId, role) {
  if (!roleIsWritingHand(role)) return { ok: false, reason: "role is not a writing hand" };
  const bound = readCanonicalTaskFromSnapshot(projectRoot, state, taskId);
  if (!bound.ok) return bound;
  const task = bound.task;
  const rawScope = Array.isArray(task.scope_paths) ? task.scope_paths : [];
  if (rawScope.length === 0) return { ok: false, reason: "canonical task scope is empty" };
  const scopePaths = [];
  for (const item of rawScope) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!scopePaths.includes(normalized.path)) scopePaths.push(normalized.path);
  }
  const allowedWrites = [];
  const rawAllowed = Array.isArray(task.allowed_writes) ? task.allowed_writes : [];
  for (const item of rawAllowed) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!allowedWrites.includes(normalized.path)) allowedWrites.push(normalized.path);
  }
  return {
    ok: true,
    featureId: bound.featureId,
    taskId: task.id,
    scopePaths,
    allowedWrites,
    snapshotHash: bound.snapshotHash,
  };
}

/** @description Atomically claim one live writing-hand dispatch by runtime Task callID. */
export function claimActiveDispatch(projectRoot, { sessionId, callId, role, taskId, now = Date.now(), token = crypto.randomUUID() }) {
  if (![sessionId, callId, role, taskId, token].every((v) => typeof v === "string" && v.length > 0)) {
    return { ok: false, reason: "runtime session, call, role, task, and token required" };
  }
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  let claim;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    if (previous.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };
    const canonical = canonicalDispatchFromSnapshot(projectRoot, previous, taskId, role);
    if (!canonical.ok) return canonical;
    const current = previous.active_dispatch;
    if (current && typeof current === "object") {
      // Same Task callID already owns the lease.
      // OC-native: `.opencode/plugin/*.{ts,js}` is auto-globbed AND may also appear in
      // opencode.json plugin[] → two Plugin factories → two before-hooks → two tokens.
      // (Claude Code has one process-level hook registration; this path is OC-only.)
      // Idempotent on call_id, not claim_token.
      if (current.call_id === callId && current.status !== "stale") {
        claim = current;
        return previous;
      }
      return { ok: false, reason: "another writing-hand dispatch is active" };
    }
    claim = {
      session_id: sessionId,
      feature_id: canonical.featureId,
      task_id: canonical.taskId,
      role,
      scope_paths: canonical.scopePaths,
      allowed_writes: canonical.allowedWrites,
      snapshot_hash: canonical.snapshotHash,
      call_id: callId,
      claim_token: token,
      claimed_at: new Date(now).toISOString(),
      expires_at: new Date(now + DISPATCH_LEASE_MS).toISOString(),
      status: "active",
    };
    return { ...previous, active_dispatch: claim };
  });
  if (persisted.ok) {
    // Always store the authoritative disk token (idempotent re-entry may return a prior claim).
    const authoritative =
      typeof claim?.claim_token === "string" && claim.claim_token ? claim.claim_token : token;
    liveClaims.set(liveClaimKey(projectRoot, sessionId, callId), authoritative);
  }
  return persisted.ok ? { ok: true, claim } : persisted;
}

/** @description CAS cleanup: only the exact claim token and Task callID can remove authority. */
export function clearActiveDispatch(projectRoot, { sessionId, callId, token }) {
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  let cleared = false;
  let clearedChild = "";
  let clearedPendingChild = "";
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    if (!active || typeof active !== "object" || active.call_id !== callId || active.claim_token !== token) return previous;
    const next = { ...previous };
    clearedChild = typeof active.child_session_id === "string" ? active.child_session_id : "";
    clearedPendingChild = typeof active.binding_pending?.child_session_id === "string" ? active.binding_pending.child_session_id : "";
    delete next.active_dispatch;
    cleared = true;
    return next;
  });
  if (persisted.ok && cleared) {
    for (const [childId, binding] of childBindings) {
      if (binding.parentSessionId === sessionId && binding.callId === callId && binding.token === token) childBindings.delete(childId);
    }
    for (const [childId, pending] of pendingChildParents) {
      if (pending.parentSessionId === sessionId && pending.callId === callId) pendingChildParents.delete(childId);
    }
    if (clearedChild) {
      childBindings.delete(childBindingKey(projectRoot, clearedChild));
      try { fs.rmSync(childIndexPath(projectRoot, clearedChild), { force: true }); } catch { /* ignore */ }
      clearPendingChildParent(projectRoot, clearedChild);
    }
    if (clearedPendingChild && clearedPendingChild !== clearedChild) {
      clearPendingChildParent(projectRoot, clearedPendingChild);
    }
  }
  return persisted.ok ? { ok: true, cleared } : persisted;
}

function sanitizedHostId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

/** @description Preserve an unresolved background dispatch until child identity can be proven. */
export function markDispatchBindingPending(projectRoot, { sessionId, callId, token, childSessionId, jobId }) {
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  let pending;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    if (!active || active.call_id !== callId || active.claim_token !== token || active.status === "stale") {
      return { ok: false, reason: "binding_pending claim mismatch" };
    }
    const child = sanitizedHostId(childSessionId);
    const existingChild = sanitizedHostId(active.binding_pending?.child_session_id);
    if (existingChild && child && existingChild !== child) return { ok: false, reason: "binding_pending child identity conflict" };
    pending = {
      call_id: callId,
      ...(existingChild || child ? { child_session_id: existingChild || child } : {}),
      ...(sanitizedHostId(jobId) ? { job_id: sanitizedHostId(jobId) } : {}),
      recorded_at: new Date().toISOString(),
    };
    return { ...previous, active_dispatch: { ...active, status: "binding_pending", binding_pending: pending } };
  });
  if (!persisted.ok) return persisted;
  const knownChild = sanitizedHostId(pending?.child_session_id);
  if (knownChild) {
    const indexed = persistPendingChildParent(projectRoot, {
      childSessionId: knownChild,
      parentSessionId: sessionId,
      callId,
      recorded_at: pending.recorded_at,
    });
    if (!indexed) return { ok: false, reason: "durable pending child index failed" };
  }
  return { ok: true, pending };
}

/** @description Bind an official child-session event to the sole live parent dispatch claim. */
export function bindChildSession(projectRoot, { parentSessionId, childSessionId, role }) {
  if (![parentSessionId, childSessionId, role].every((value) => typeof value === "string" && value.length > 0) || parentSessionId === childSessionId || !roleIsWritingHand(role)) {
    return { ok: false, reason: "valid parent, child, and writing role required" };
  }
  const resolved = statePath(projectRoot, parentSessionId);
  if (!resolved.ok) return resolved;
  let binding;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    const token = active && liveClaims.get(liveClaimKey(projectRoot, parentSessionId, active.call_id));
    if (!active || !["active", "binding_pending"].includes(active.status) || token !== active.claim_token || !sameWritingHandFamily(role, active.role)) return { ok: false, reason: "live parent dispatch capability or role mismatch" };
    if (active.status === "binding_pending" && active.binding_pending?.child_session_id !== childSessionId) return { ok: false, reason: "pending child session identity mismatch" };
    if (active.child_session_id && active.child_session_id !== childSessionId) return { ok: false, reason: "dispatch already bound to another child session" };
    binding = { parentSessionId, childSessionId, callId: active.call_id, token, role: active.role };
    const nextActive = { ...active, status: "active", child_session_id: childSessionId };
    delete nextActive.binding_pending;
    return { ...previous, active_dispatch: nextActive };
  });
  if (!persisted.ok) return persisted;
  if (!persistChildBinding(projectRoot, binding)) return { ok: false, reason: "durable child dispatch binding failed" };
  childBindings.set(childBindingKey(projectRoot, childSessionId), binding);
  clearPendingChildParent(projectRoot, childSessionId);
  return { ok: true, binding };
}

/** @description Bind a pending child when parent identity is already known (SDK or durable pending index). */
export function reconcilePendingChildBinding(projectRoot, { parentSessionId, childSessionId }) {
  if (![parentSessionId, childSessionId].every((value) => typeof value === "string" && value.length > 0)) {
    return { ok: false, reason: "pending child reconciliation identity missing" };
  }
  const resolved = statePath(projectRoot, parentSessionId);
  if (!resolved.ok) return resolved;
  let active;
  try { active = JSON.parse(fs.readFileSync(resolved.path, "utf8")).active_dispatch; } catch { return { ok: false, reason: "parent dispatch unreadable" }; }
  if (!active || active.status !== "binding_pending" || active.binding_pending?.call_id !== active.call_id) {
    return { ok: false, reason: "matching binding_pending dispatch required" };
  }
  if (active.binding_pending?.child_session_id !== childSessionId) {
    return { ok: false, reason: "pending child session identity mismatch" };
  }
  return bindChildSession(projectRoot, { parentSessionId, childSessionId, role: active.role });
}

/**
 * @description When child id was recorded on binding_pending, verify and bind without SDK parent lookup.
 * Fail-closed unless durable pending index + live claim + gate-state child id all agree.
 */
export function reconcilePendingChildBindingByChild(projectRoot, childSessionId) {
  if (typeof childSessionId !== "string" || !childSessionId) {
    return { ok: false, reason: "pending child identity missing" };
  }
  const pending = readPendingChildParent(projectRoot, childSessionId);
  if (!pending) return { ok: false, reason: "no durable pending child index" };
  if (pending.childSessionId !== childSessionId) {
    return { ok: false, reason: "pending child index identity mismatch" };
  }
  return reconcilePendingChildBinding(projectRoot, {
    parentSessionId: pending.parentSessionId,
    childSessionId,
  });
}

/** @description Return only a process-bound child mapping that still matches parent authority. */
export function getChildSessionBinding(projectRoot, childSessionId, expectedParentId) {
  const binding = childBindings.get(childBindingKey(projectRoot, childSessionId)) ?? readChildBinding(projectRoot, childSessionId);
  if (!binding || binding.parentSessionId !== expectedParentId) return { ok: false, reason: "child session is not bound to this parent dispatch" };
  try {
    const resolved = statePath(projectRoot, binding.parentSessionId);
    if (!resolved.ok) return resolved;
    const active = JSON.parse(fs.readFileSync(resolved.path, "utf8")).active_dispatch;
    if (!active || active.call_id !== binding.callId || active.claim_token !== binding.token || active.child_session_id !== childSessionId) {
      return { ok: false, reason: "child binding no longer matches active dispatch" };
    }
    return { ok: true, binding, active };
  } catch { return { ok: false, reason: "parent dispatch unreadable" }; }
}

/** @description Process-local lookup used only to decide whether a terminal event belongs to us. */
export function getProcessChildBinding(projectRoot, childSessionId) {
  const binding = childBindings.get(childBindingKey(projectRoot, childSessionId)) ?? readChildBinding(projectRoot, childSessionId);
  if (binding) childBindings.set(childBindingKey(projectRoot, childSessionId), binding);
  return binding ?? null;
}

/** @description Capability-bind the real CLI primary session to its parent adapter dispatch. */
export function bindAdapterSession(projectRoot, { parentSessionId, runtimeSessionId, token }) {
  if (![parentSessionId, runtimeSessionId, token].every((value) => typeof value === "string" && value.length > 0)) return { ok: false, reason: "adapter binding identity missing" };
  const resolved = statePath(projectRoot, parentSessionId);
  if (!resolved.ok) return resolved;
  let binding;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    if (!active || active.claim_token !== token || active.status !== "active") return { ok: false, reason: "adapter capability does not match active dispatch" };
    binding = { parentSessionId, childSessionId: runtimeSessionId, callId: active.call_id, token, role: active.role, adapter: true };
    return { ...previous, active_dispatch: { ...active, child_session_id: runtimeSessionId } };
  });
  if (!persisted.ok) return persisted;
  if (!persistChildBinding(projectRoot, binding)) return { ok: false, reason: "durable adapter dispatch binding failed" };
  childBindings.set(childBindingKey(projectRoot, runtimeSessionId), binding);
  return { ok: true, binding };
}

/** @description Durable fail-closed evidence when a terminal child cannot be bound safely. */
export function appendTerminalScopeDiagnostic(projectRoot, childSessionId, reason) {
  try {
    const dir = path.join(projectRoot, ".opencode", "plans", ".state");
    fs.mkdirSync(dir, { recursive: true });
    const event = {
      at: new Date().toISOString(),
      type: "hand-scope-terminal-unbound",
      child: crypto.createHash("sha256").update(String(childSessionId)).digest("hex").slice(0, 16),
      reason: String(reason).slice(0, 256),
      decision: "fail-closed",
    };
    const fd = fs.openSync(path.join(dir, "scope-terminal-events.jsonl"), "a", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { ok: true };
  } catch { return { ok: false, reason: "terminal scope diagnostic persistence failed" }; }
}

function cleanupPendingPath(projectRoot, sessionId) {
  return path.join(projectRoot, ".opencode", "plans", ".state", sessionId, "active-dispatch-cleanup-pending.json");
}

function writeCleanupPending(projectRoot, body) {
  const target = cleanupPendingPath(projectRoot, body.session_id);
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(body, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(path.dirname(target), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** @description Bounded CAS cleanup; durable pending proof keeps subsequent writes fail-closed. */
export function finishActiveDispatch(projectRoot, args, deps = {}) {
  const clearFn = deps.clearFn ?? clearActiveDispatch;
  const attempts = Number.isInteger(deps.attempts) ? Math.max(1, deps.attempts) : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = clearFn(projectRoot, args);
    if (result?.ok && result.cleared) {
      liveClaims.delete(liveClaimKey(projectRoot, args.sessionId, args.callId));
      try { fs.rmSync(cleanupPendingPath(projectRoot, args.sessionId), { force: true }); } catch { /* ignore */ }
      return { ok: true, cleared: true, attempts: attempt };
    }
    const resolved = statePath(projectRoot, args.sessionId);
    let active;
    let stateVerified = false;
    try {
      if (resolved.ok) {
        active = JSON.parse(fs.readFileSync(resolved.path, "utf8")).active_dispatch;
        stateVerified = true;
      }
    } catch { active = null; }
    if (stateVerified && (!active || active.call_id !== args.callId || active.claim_token !== args.token)) {
      liveClaims.delete(liveClaimKey(projectRoot, args.sessionId, args.callId));
      try { fs.rmSync(cleanupPendingPath(projectRoot, args.sessionId), { force: true }); } catch { /* ignore */ }
      return { ok: true, cleared: false, attempts: attempt };
    }
  }
  const persisted = writeCleanupPending(projectRoot, {
    session_id: args.sessionId,
    call_id: args.callId,
    claim_token: args.token,
    reason: "bounded cleanup retries exhausted",
    created_at: new Date().toISOString(),
  });
  return { ok: false, cleanup_pending: persisted, reason: persisted ? "active_dispatch cleanup pending" : "active_dispatch cleanup failed and pending proof could not be persisted" };
}

/** @description Retry a durable termination proof before admitting another dispatch. */
export function reconcileCleanupPending(projectRoot, sessionId) {
  try {
    const pending = JSON.parse(fs.readFileSync(cleanupPendingPath(projectRoot, sessionId), "utf8"));
    if (pending.session_id !== sessionId || typeof pending.call_id !== "string" || typeof pending.claim_token !== "string") {
      return { ok: false, reason: "invalid cleanup_pending proof" };
    }
    return finishActiveDispatch(projectRoot, { sessionId, callId: pending.call_id, token: pending.claim_token });
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, pending: false };
    return { ok: false, reason: "cleanup_pending unreadable" };
  }
}

export function hasCleanupPending(projectRoot, sessionId) {
  return fs.existsSync(cleanupPendingPath(projectRoot, sessionId));
}

/** @description Authenticated heartbeat extends only the exact live claim under lock. */
export function heartbeatActiveDispatch(projectRoot, { sessionId, callId, token, role, now = Date.now() }) {
  const runtimeToken = token || liveClaims.get(liveClaimKey(projectRoot, sessionId, callId));
  if (!runtimeToken) return { ok: false, reason: "live dispatch capability missing" };
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  let heartbeat = null;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    if (!active || active.call_id !== callId || active.claim_token !== runtimeToken || active.status === "stale" || !sameWritingHandFamily(role, active.role)) {
      return { ok: false, reason: "heartbeat claim mismatch or stale" };
    }
    if (activeExpired(active, now)) {
      return { ...previous, active_dispatch: { ...active, status: "stale", stale_at: new Date(now).toISOString() } };
    }
    heartbeat = { ...active, heartbeat_at: new Date(now).toISOString(), expires_at: new Date(now + DISPATCH_LEASE_MS).toISOString() };
    return { ...previous, active_dispatch: heartbeat };
  });
  return persisted.ok && heartbeat ? { ok: true, claim: heartbeat } : persisted.ok ? { ok: false, reason: "dispatch lease expired and is stale" } : persisted;
}

/** @description Expiration becomes stale/fail-closed; it never removes dispatch authority. */
export function reconcileExpiredDispatch(projectRoot, sessionId, now = Date.now()) {
  const resolved = statePath(projectRoot, sessionId);
  if (!resolved.ok) return resolved;
  let stale = false;
  const persisted = withGateStateLock(resolved.path, (previous) => {
    const active = previous.active_dispatch;
    if (!active || typeof active !== "object" || active.status === "stale" || !activeExpired(active, now)) return previous;
    stale = true;
    return { ...previous, active_dispatch: { ...active, status: "stale", stale_at: new Date(now).toISOString() } };
  });
  return persisted.ok ? { ok: true, stale } : persisted;
}

/** @description Append one sanitized, durable out-of-scope event in the session state directory. */
export function appendScopeEvent(projectRoot, active, { tool, paths, mode, reason }) {
  try {
    const safePaths = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string").map((p) => p.slice(0, 512)))];
    const event = {
      at: new Date().toISOString(),
      type: "hand-scope-rejection",
      session_id: active.session_id,
      feature_id: active.feature_id,
      task_id: active.task_id,
      role: active.role,
      call: crypto.createHash("sha256").update(String(active.call_id)).digest("hex").slice(0, 16),
      tool: String(tool).toLowerCase().slice(0, 32),
      paths: safePaths,
      mode,
      decision: mode === "enforce" ? "deny" : "observe",
      reason,
    };
    const dir = path.join(projectRoot, ".opencode", "plans", ".state", String(active.session_id));
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, "scope-events.jsonl"), "a", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { ok: true };
  } catch { return { ok: false, reason: "scope event persistence failed" }; }
}

export default { appendScopeEvent, appendTerminalScopeDiagnostic, bindAdapterSession, bindChildSession, canonicalDispatchFromSnapshot, claimActiveDispatch, clearActiveDispatch, finishActiveDispatch, getChildSessionBinding, getProcessChildBinding, heartbeatActiveDispatch, markDispatchBindingPending, normalizeProjectPath, readCanonicalTaskFromSnapshot, reconcileCleanupPending, reconcileExpiredDispatch, reconcilePendingChildBinding, reconcilePendingChildBindingByChild };
